// Postgres SQL rules, used by the database guard packs (./supabase.mjs) for every `execute_sql`
// call an agent makes, and by the post-merge adapter to spot destructive migrations.
//
// In real-gates agents never write to a database: the runner applies merged migration files itself,
// after CI and review (loop/adapters/postmerge-supabase-cli.mjs). So an agent's SQL must be
// read-only. `allowWrite` exists for a future adapter that applies migrations through a session.
//
// The rules read the query with its comments removed. In the original run a rule tripped on the
// words "public. Kept" inside a SQL comment and refused a valid migration. Removing comments must
// never remove anything Postgres executes, or a comment becomes a way to smuggle a write past the
// guard. So the scanner follows Postgres' own lexer where it matters:
//   - `--` runs to the next \n or \r (both end a comment in Postgres);
//   - `/* … */` nests;
//   - nothing inside '…', E'…' (backslash escapes), "quoted identifiers" or $tag$…$tag$ starts a
//     comment at the top level. A dollar-quoted body is scanned on its own, so a comment in a
//     function body is removed but can never reach past the body's closing tag;
//   - an unterminated comment, string or dollar quote is kept as it is (Postgres rejects the whole
//     query anyway), which errs on the strict side.
// standard_conforming_strings is assumed on (the default since Postgres 9.1, and Supabase's).

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/** The query with every SQL comment replaced by one space; strings and bodies kept verbatim. */
export function stripSqlComments(sql) {
  const s = String(sql);
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '-' && next === '-') {
      let j = i + 2;
      while (j < n && s[j] !== '\n' && s[j] !== '\r') j++;
      out += ' ';
      i = j;
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (s[j] === '/' && s[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (s[j] === '*' && s[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) return out + s.slice(i);
      out += ' ';
      i = j;
      continue;
    }

    // A doubled quote ('it''s', "a""b") needs no case of its own: it scans as two adjacent
    // literals, which are copied the same way.
    if (c === "'") {
      const backslashEscapes = (s[i - 1] === 'e' || s[i - 1] === 'E') && !IDENT_CHAR.test(s[i - 2] || ' ');
      let j = i + 1;
      while (j < n && s[j] !== "'") j += backslashEscapes && s[j] === '\\' ? 2 : 1;
      if (j >= n) return out + s.slice(i);
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j === -1) return out + s.slice(i);
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === '$' && !IDENT_CHAR.test(s[i - 1] || ' ')) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(s);
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const close = s.indexOf(tag, bodyStart);
        if (close === -1) return out + s.slice(i);
        out += tag + stripSqlComments(s.slice(bodyStart, close)) + tag;
        i = close + tag.length;
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

const READ_START = /^\s*(select|with|explain|show)\b/i;
const WRITE_WORD = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment\s+on|call|do|copy|vacuum|reindex|refresh|set\s+role|reset\s+role)\b/i;
/** Same rule as the post-merge adapter: re-creating a policy, function or trigger loses no data. */
export const DESTRUCTIVE = /\bdrop\s+(?!policy\s+if\s+exists|function\s+if\s+exists|trigger\s+if\s+exists)\w|\btruncate\b|delete\s+from\s+[\w."]+\s*(;|$)|alter\s+table[^;]*\bdrop\b|alter\s+table[^;]*\balter\s+(column\s+)?[\w"]+\s+(set\s+data\s+)?type\b/i;
/** Supabase's own schemas. Nothing the app builds lives there. */
const PLATFORM_SCHEMAS = ['auth', 'storage', 'supabase_migrations', 'supabase_functions', 'realtime', 'vault', 'graphql', 'pgsodium'];

export const SQL_BLOCK_REASONS = Object.freeze({
  readOnly: 'agents only run read-only SQL. Schema changes go into a new migration file; the runner applies it after the PR merges.',
  destructive: 'destructive SQL (DROP, TRUNCATE, unbounded DELETE, dropping a column) needs the owner\'s explicit approval of the statement.',
  foreignSchema: 'writes to a schema the app does not own are forbidden.',
});

function writesForeignSchema(q, schema) {
  const qualified = [...q.matchAll(/(?<![\w$])"?([A-Za-z_][\w$]*)"?\s*\.\s*"?[A-Za-z_]/g)].map((m) => m[1].toLowerCase());
  return qualified.some((s) => PLATFORM_SCHEMAS.includes(s) || (schema && s !== schema.toLowerCase() && s !== 'pg_temp' && s !== 'extensions'));
}

/**
 * Why the guard refuses this query, or null when it may run.
 * `allowWrite`: may this session write at all (no agent phase may today).
 * `schema`: when set, the only schema a write may touch.
 */
export function sqlBlockReason(query, { allowWrite = false, schema = '' } = {}) {
  const q = stripSqlComments(String(query ?? ''));
  const readOnly = READ_START.test(q) && !WRITE_WORD.test(q);
  if (!allowWrite && !readOnly) return SQL_BLOCK_REASONS.readOnly;
  if (DESTRUCTIVE.test(q)) return SQL_BLOCK_REASONS.destructive;
  if (!readOnly && writesForeignSchema(q, schema)) return SQL_BLOCK_REASONS.foreignSchema;
  return null;
}
