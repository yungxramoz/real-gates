// Post-merge step: apply merged migration files to the dev database with the Supabase CLI, from the
// runner (never from an agent session), and verify the result.
//
// The original run applied migrations through an agent session and an MCP tool. An approval prompt
// cancelled one apply, the item was marked done anyway, and the next merge read a column that did
// not exist yet: the whole dev site answered with errors. So here:
//   - the script applies, with the CLI and the dev DB URL; no prompt can cancel it;
//   - it compares EVERY local file with the remote ledger, not just this merge's files, so an
//     earlier gap is caught too;
//   - destructive SQL is never applied automatically; it waits for the owner;
//   - anything it cannot verify holds the item and stops the run.

import { DESTRUCTIVE, stripSqlComments } from '../guard/packs/postgres-sql.mjs';

export const name = 'supabase-cli';

/** "Local | Remote | Time" table from `supabase migration list` → { local: [], remote: [] }. */
export function parseMigrationList(text) {
  const local = [];
  const remote = [];
  for (const line of String(text || '').split('\n')) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 2 || !/^\d{6,}$/.test(cols[0] || cols[1] || '')) continue;
    if (/^\d{6,}$/.test(cols[0])) local.push(cols[0]);
    if (/^\d{6,}$/.test(cols[1])) remote.push(cols[1]);
  }
  return { local, remote };
}

const versionOf = (file) => (file.split('/').pop().match(/^(\d{6,})/) || [])[1];

/** step: { migrationsDir, dbUrlEnv } from loop.config.json postMerge[]. */
export function run(ctx, { mergeSha, item, step }) {
  const { proc } = ctx;
  const dir = (step.migrationsDir || 'supabase/migrations').replace(/\/$/, '');
  const files = proc.gitTry('ls-tree', '--name-only', `${mergeSha}:${dir}`).out.split('\n').filter((f) => /\.sql$/.test(f)).map((f) => `${dir}/${f}`).sort();
  if (!files.length) return { ok: true, note: 'no migration files' };

  const url = ctx.env?.[step.dbUrlEnv];
  if (!url) {
    return { ok: false, why: `${step.dbUrlEnv} is not set, so the runner cannot reach the dev database`, ownerAction: `Set ${step.dbUrlEnv} (the dev project's connection string, Project Settings → Database) in the environment that runs the loop, then re-run it. It verifies before it moves on.` };
  }
  const list = (label) => {
    const r = proc.tool('supabase', ['migration', 'list', '--db-url', url], { timeoutMs: 5 * 60_000 });
    if (!r.ok) return { error: `supabase migration list failed${label ? ` ${label}` : ''}: ${(r.err || r.out).slice(-500)}` };
    return parseMigrationList(r.out);
  };

  const before = list('');
  if (before.error) return { ok: false, why: before.error, ownerAction: `Check that ${step.dbUrlEnv} reaches the dev database and the Supabase CLI is installed, then re-run the loop.` };
  const remote = new Set(before.remote);
  const unknownRemote = before.remote.filter((v) => !files.some((f) => versionOf(f) === v));
  if (unknownRemote.length) {
    return { ok: false, why: `the dev database has migrations the repository does not: ${unknownRemote.join(', ')}`, ownerAction: `The dev database was changed outside the loop (${unknownRemote.join(', ')}). Bring the repository and the database back in line, then re-run the loop.` };
  }
  const pending = files.filter((f) => !remote.has(versionOf(f)));
  if (!pending.length) return { ok: true, note: 'ledger already complete' };

  const destructive = pending.filter((f) => DESTRUCTIVE.test(stripSqlComments(proc.gitTry('show', `${mergeSha}:${f}`).out)));
  if (destructive.length) {
    return { ok: false, why: `destructive SQL waits for the owner: ${destructive.join(', ')}`, ownerAction: `Review ${destructive.join(', ')} (DROP, TRUNCATE, unbounded DELETE or a dropped column, merged with ${item.id}). If it is right, apply the pending migrations yourself: supabase db push --db-url "$${step.dbUrlEnv}" --include-all — then re-run the loop. It verifies the ledger before it moves on.` };
  }

  const push = proc.tool('supabase', ['db', 'push', '--db-url', url, '--include-all', '--yes'], { input: 'y\n', timeoutMs: 10 * 60_000 });
  const after = list('after the push');
  if (after.error) return { ok: false, why: after.error, ownerAction: `Check the dev database: the push of ${pending.join(', ')} could not be verified. Re-run the loop once it is reachable.` };
  const missing = pending.filter((f) => !after.remote.includes(versionOf(f)));
  if (missing.length) {
    return { ok: false, why: `not applied after the push: ${missing.join(', ')}${push.ok ? '' : ` (push: ${(push.err || push.out).slice(-300)})`}`, ownerAction: `Apply ${missing.join(', ')} to the dev database (supabase db push --db-url "$${step.dbUrlEnv}" --include-all), fix whatever stops it, then re-run the loop.` };
  }
  return { ok: true, note: `applied ${pending.join(', ')}` };
}
