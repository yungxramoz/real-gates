// The locked core of the loop guard: the rules every project needs whatever it is built with,
// decided as a pure function. Git, the harness files and the read-only steps live here. The rules
// for one tool or service (the forge's CLI, a database, a host) live in a guard pack
// (./packs/), switched on by `guard.packs` in the profile.
//
// This file is a protected path. The loop cannot edit it, and nothing in loop/rules/ or in a pack
// can switch a rule here off: packs and project rules can only add blocks. Every rule has a block
// case and an allow case in loop/test/guard-core.test.mjs.

import path from 'node:path';

import { matchesAny } from './paths.mjs';
import { matchRules } from './rules.mjs';
import { loadPacks } from './packs/index.mjs';
import { READ_ONLY_PHASES, esc, no, ok } from './shared.mjs';

export { READ_ONLY_PHASES };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * Decide one PreToolUse event.
 * ctx: { phase, item, branch, cfg, rel(path) -> repo-relative path | null, isOnBase(rel) -> bool,
 *        projectRules: compiled rows, packs?: pack modules (default: the ones cfg.guard.packs names),
 *        cwd?: the session's working folder relative to the repository ('' at its root, null when
 *        outside it; left out means the root) }
 */
export function decide(event, ctx) {
  const tool = String(event?.tool_name || '');
  const input = event?.tool_input || {};
  // An unknown pack name throws, and the hook turns that into a block: the guard fails closed.
  const c = ctx.packs ? ctx : { ...ctx, packs: loadPacks(ctx.cfg.guard?.packs) };
  if (/^mcp__/.test(tool)) return decideMcp(tool, input, c);
  if (SHELL_TOOLS.has(tool)) return decideShell(String(input.command || ''), c);
  if (EDIT_TOOLS.has(tool)) return decideEdit(String(input.file_path || input.notebook_path || ''), c);
  return ok;
}

// ------------------------------------------------------------------------------------------- MCP
function decideMcp(tool, input, ctx) {
  const g = ctx.cfg.guard || {};
  const text = JSON.stringify(input);
  for (const ref of g.forbiddenRefs || []) if (ref && text.includes(ref)) return no('core:forbidden-ref', `project ${ref} is out of bounds, reads included.`);
  for (const pack of ctx.packs) {
    const d = pack.mcp?.(tool, input, ctx);
    if (d) return d;
  }
  const hit = matchRules(ctx.projectRules || [], 'mcp', `${tool} ${text}`, ctx.phase);
  if (hit) return no(hit.id, hit.reason);
  return ok;
}

// ----------------------------------------------------------------------------------------- shell
/**
 * The command line with the spellings that hide a command from a pattern removed: quotes, `git -C
 * <dir>` / `-c k=v` / `--git-dir=`, `gh -R <repo>` / `--repo`, `--method=PUT` / `-XPUT`.
 * The rules below match against this. They are an early warning: the runner's own checks after
 * every session (base and production unmoved, harness files unchanged) are the hard stop.
 */
export function normalizeShell(cmd) {
  return String(cmd)
    .replace(/["'`]/g, '')
    .replace(/\\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bgit((?:\s+(?:-C|-c)\s+\S+|\s+--(?:git-dir|work-tree|namespace)(?:=|\s+)\S+|\s+--no-pager|\s+-P)+)/gi, 'git')
    .replace(/(\bgh\b[^;|&]*?)\s(?:-R|--repo)(?:=|\s+)\S+/gi, '$1')
    .replace(/--method=/gi, '--method ')
    .replace(/(\s)-X(DELETE|PUT|PATCH|POST)\b/gi, '$1-X $2');
}

function decideShell(cmd, ctx) {
  const c = normalizeShell(cmd);
  const { base, production } = ctx.cfg;
  const g = ctx.cfg.guard || {};
  const branches = [base, production].filter(Boolean).map(esc).join('|');
  const onProtectedBranch = [base, production].includes(ctx.branch);

  if (/--dangerously-skip-permissions|\bbypassPermissions\b|--permission-mode\s+(bypassPermissions|dontAsk)/i.test(c)) return no('core:bypass', 'no session may bypass permissions.');
  // Packs come before the git rules: a pack names a tool, and its reason says more to the agent
  // than a generic one would.
  for (const pack of ctx.packs) {
    const d = pack.shell?.(c, ctx);
    if (d) return d;
  }
  if (/\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--mirror\b|\s--delete\b|\s-d\b|\s\+\S|\s:\S)/i.test(c)) return no('core:force-push', `no force-push, mirror or remote delete. To catch up, merge origin/${base} into your branch.`);
  if (branches && new RegExp(`\\bgit\\s+push\\b[^|;&]*?(\\s|:|/)(${branches})(\\s|$|;|&|\\|)`, 'i').test(c)) return no('core:push-base', `never push ${base} or ${production}. Push your feature branch and open a PR to ${base}.`);
  if (/\bgit\s+push\b/i.test(c) && onProtectedBranch) return no('core:push-base', `you are on ${ctx.branch}: never push it. Create a feature branch from origin/${base} first.`);
  if (/\bgit\s+commit\b/i.test(c) && onProtectedBranch) return no('core:commit-base', `you are on ${ctx.branch}: commit on a feature branch.`);
  if (/\bgit\s+config\b[^;|&]*\b(push\.|remote\.|branch\.\S+\.(merge|remote|pushRemote)|alias\.|core\.hooksPath|url\.)/i.test(c)) return no('core:git-config', 'push, remote, branch-tracking, alias and hook settings are not the loop\'s to change.');
  if (/\bgit\s+remote\s+(add|set-url|rename|remove|rm)\b/i.test(c)) return no('core:git-config', 'the remotes are not the loop\'s to change.');
  if (/\bgit\s+push\b[^;|&]*\s--(all|tags|follow-tags)\b/i.test(c)) return no('core:push-base', 'push one feature branch by name; never all branches or tags.');
  if (/\brm\s+-\w*r\w*\s+(\/(\s|$)|~\/?(\s|$)|\$HOME\/?(\s|$)|\*|\.\/?(\s|$)|\.\.(\/|\s|$)|[A-Za-z]:[\\/]?(\s|$))/i.test(c) || /Remove-Item\b[^;|&]*-Recurse[^;|&]*\s(\.|\*|[A-Za-z]:\\?|~)(\s|$)/i.test(c)) return no('core:broad-delete', 'refusing a broad recursive delete.');
  if (/\bgit\s+clean\s+-\w*f/i.test(c) || (production && new RegExp(`\\bgit\\s+reset\\s+--hard\\s+(origin/)?${esc(production)}\\b`, 'i').test(c))) return no('core:git-destroy', 'git clean -f and resetting to production are not allowed.');
  if (/\bgit\s+add\s+(-A|--all|\.)(\s|$|;|&)/i.test(c)) return no('core:add-all', 'add explicit paths. A blanket add commits runtime files (.loop/) and anything else lying in the tree.');
  for (const ref of g.forbiddenRefs || []) if (ref && c.includes(ref)) return no('core:forbidden-ref', `project ${ref} is out of bounds.`);
  if (READ_ONLY_PHASES.has(ctx.phase)) {
    if (/\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|revert|tag|am|apply|stash|restore|rm|mv|update-ref|commit-tree|checkout\s+(-b|-B|--|\.)|switch\s+-c|branch\s+-[dDmMcC])(?=\s|$|;|&|\|)/i.test(c)) return no('core:read-only', `the ${ctx.phase} step is read-only: no commits, pushes or branch changes.`);
    const outside = shellWritesOutsideLoop(cmd, ctx);
    if (outside !== null) return no('core:read-only', `the ${ctx.phase} step is read-only: redirect output only into .loop/. "${String(outside).slice(0, 80)}" is not known to be there: write the path out from the repository root (.loop/…), or use \`cd <folder> && …\` so the folder is certain.`);
    if (/\b(sed\s+-i|perl\s+-p?i|Set-Content|Add-Content|Out-File)\b/i.test(c)) return no('core:read-only', `the ${ctx.phase} step is read-only: redirect output only into .loop/.`);
  }
  // Shell writes into protected files. The pre-merge check is the hard stop; this catches the obvious ones early.
  const protectedHit = shellWritesProtected(cmd, ctx);
  if (protectedHit) return no('core:protected-path', `${protectedHit} is part of the harness or the owner's; the loop cannot change it. Reading it is fine; a runner change ships as a new file in loop/patches/.`);
  const hit = matchRules(ctx.projectRules || [], 'shell', c, ctx.phase);
  if (hit) return no(hit.id, hit.reason);
  return ok;
}

// --------------------------------------------------------------- shell writes into protected paths
//
// "Does this line write a harness file?" has two answers, and the cheap one is the default.
//
// The coarse answer needs no understanding of the line: it names a protected path somewhere, and
// it has a write verb somewhere, or a redirect whose target is protected or cannot be read. That
// refuses harmless lines too (a pull request text that says "loop/" and "rm").
//
// The exact answer cuts the line into its commands and looks at each one. It is only given for
// plain shell, read by readPlainShell below, which returns null at the first thing it does not
// know for certain: a backslash, a backtick, $( … ), $'…', a parenthesis, a comment, an unusual
// here-document. Then the coarse answer stands. Nothing is ever guessed, and the only text that is
// not looked at is the body of a here-document that plain shell hands to cat, tee, gh or git commit
// as data.

// Tested against a line or a command that went through normalizeShell, so `git -C . restore` is
// `git restore` here.
const WRITE_VERB = /(\btee\b|\bcp\b|\bmv\b|\brm\b|\brmdir\b|\bunlink\b|\bshred\b|\btouch\b|\btruncate\b|\binstall\b|\bln\b|\bdd\b|\bpatch\s+-|\bchmod\b|\bchown\b|\bsed\b.*\s(-[A-Za-z]*i|--in-place)|\bperl\b.*\s-[A-Za-z]*i|\bfind\b.*\s-delete\b|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|\bgit\s+(checkout|restore|apply|am|rm|mv)\b)/i;
const REDIRECT = /(&>>?|>>?&?|>\|)\s*([^\s<>|;&]+)/g;
/** Options of gh and git commit whose value is a text, never a path. */
const MESSAGE_OPTION = /^(-m|--message|-b|--body|-t|--title|--notes)$/;
/** git run in another folder: its relative paths mean something else, as after a cd. */
const GIT_DIR = /\bgit\b[^;|&]*?\s(?:-C|--work-tree)(?:=|\s+)["']?([^\s;&|)"']+)/gi;
const CD = /(?:^|[\s;&|(])(?:cd|pushd|Set-Location|sl)\s+(?:-\S*\s+)*([^\s;&|)]+)/gi;
const FRAGMENTS = /[\s"'`;|&()<>=,]+/;
/** A redirect target that is no file: the null device. A number or "-" is a file unless it follows `>&`. */
const noFile = (t) => /^(\/dev\/null|\$null|NUL)$/i.test(t);
/** A path this cannot read: it holds a variable, a substitution or a home folder. */
const unreadable = (w) => /[$`]|^~/.test(w);
/** A here-document handed to one of these is text for it, not a script. */
const takesText = (words) => {
  const w = words.filter((x) => x.text !== '{').map((x) => x.text);
  return /^(cat|tee|gh)$/.test(w[0] || '') || (w[0] === 'git' && w.includes('commit') && !w.some((x) => x === 'apply' || x === 'am'));
};

/**
 * A line of plain shell as its commands, each with its words, the targets of its redirects and
 * what follows it (`after`: '&&', '||', ';', '|', '&', a line break or '' at the end), or
 * null when the line holds anything this does not read with certainty. Quoted words keep their
 * text. The body of a here-document is left out where it is data (see takesText); every other
 * here-document makes the line not plain.
 */
export function readPlainShell(source) {
  const s = String(source).replace(/\r\n/g, '\n');
  if (s.includes('\r')) return null;
  const commands = [];
  let cur = { words: [], targets: [], reads: 0, hereDoc: false, piped: false };
  let word = null;
  let target = null; // a redirect waits for its target: { amp }
  let pending = null; // a here-document waits for its body: { delim, literal, dash, cmd }
  let afterPipe = false;
  const wordEnd = () => {
    if (!word) return true;
    if (target) {
      if (target.input) cur.reads++;
      else if (!(target.amp && !word.quoted && /^(\d+|-)$/.test(word.text))) cur.targets.push(word.text);
      target = null;
    } else cur.words.push(word);
    word = null;
    return true;
  };
  const commandEnd = (sep) => {
    wordEnd();
    if (target) return false; // a redirect without a target
    if (sep === '|') cur.piped = true;
    if (afterPipe) cur.piped = true;
    cur.after = sep;
    if (cur.words.length || cur.targets.length) commands.push(cur);
    else if (sep === '|' || afterPipe) return false;
    afterPipe = sep === '|';
    cur = { words: [], targets: [], reads: 0, hereDoc: false, piped: false };
    return true;
  };
  const add = (text, quoted) => {
    word ||= { text: '', quoted: false };
    word.text += text;
    if (quoted) word.quoted = true;
  };
  /** A number right before a redirect is its file descriptor, not a word. */
  const dropDescriptor = () => {
    if (word && !word.quoted && /^\d+$/.test(word.text)) word = null;
    else wordEnd();
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '\\' || ch === '`' || ch === '(' || ch === ')') return null;
    if (ch === "'") {
      if (s[i - 1] === '$') return null; // $'…'
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      const text = s.slice(i + 1, end);
      if (pending && text.includes('\n')) return null;
      add(text, true);
      i = end;
    } else if (ch === '"') {
      if (s[i - 1] === '$') return null; // $"…"
      const inline = s.slice(i).match(/^"\$\(cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n/);
      if (inline) {
        // "$(cat <<'EOF' … EOF )": the usual way to hand a long text to gh or git commit. Taken as
        // text only where it is the value of a message option; anywhere else it could be a path.
        const close = s.indexOf(`\n${inline[1]}\n`, i + inline[0].length - 1);
        const tail = close < 0 ? null : s.slice(close + inline[1].length + 2).match(/^[ \t]*\)"(?=[\s;]|$)/);
        const option = word ? word.text.replace(/=$/, '') : cur.words.at(-1)?.text;
        const isValue = word ? !word.quoted && word.text.endsWith('=') : !!cur.words.length && !cur.words.at(-1).quoted;
        if (!tail || pending || target || !isValue || !MESSAGE_OPTION.test(option || '')) return null;
        add('', true);
        cur.hereDoc = true;
        i = close + inline[1].length + 1 + tail[0].length;
        continue;
      }
      const end = s.indexOf('"', i + 1);
      if (end < 0) return null;
      const text = s.slice(i + 1, end);
      if (/[\\`]|\$[('"{]/.test(text) || (pending && text.includes('\n'))) return null;
      add(text, true);
      i = end;
    } else if (ch === '$' && /[('"{]/.test(next || '')) return null;
    else if (ch === '{' || ch === '}') {
      // only as a word of its own: a group, not an expansion
      if (word || !(next === undefined || /[\s;]/.test(next))) return null;
      add(ch, false);
    } else if (ch === '#' && !word) return null;
    else if (ch === ' ' || ch === '\t') wordEnd();
    else if (ch === '\n') {
      if (!commandEnd('\n')) return null;
      if (!pending) continue;
      let at = i + 1;
      let body = '';
      let closed = false;
      while (at <= s.length) {
        const eol = s.indexOf('\n', at);
        const line = s.slice(at, eol < 0 ? s.length : eol);
        at = eol < 0 ? s.length + 1 : eol + 1;
        if ((pending.dash ? line.replace(/^\t+/, '') : line) === pending.delim) {
          closed = true;
          break;
        }
        body += `${line}\n`;
      }
      if (!closed || (!pending.literal && /[$`\\]/.test(body))) return null;
      pending = null;
      i = at - 2; // the line break that ends the closing line, or the end
    } else if (ch === ';') {
      if (next === ';' || !commandEnd(';')) return null;
    } else if (ch === '&') {
      if (next === '>') {
        wordEnd();
        i += s[i + 2] === '>' ? 2 : 1;
        if (target) return null;
        target = { amp: false };
      } else {
        if (next === '&') i++;
        if (!commandEnd(next === '&' ? '&&' : '&')) return null;
      }
    } else if (ch === '|') {
      if (next === '&') return null;
      if (next === '|') i++;
      if (!commandEnd(next === '|' ? '||' : '|')) return null;
    } else if (ch === '>') {
      dropDescriptor();
      if (target) return null;
      if (s[i + 1] === '>') i++;
      const amp = s[i + 1] === '&';
      if (amp || s[i + 1] === '|') i++;
      target = { amp };
    } else if (ch === '<') {
      if (next !== '<') {
        // reading from a file or a descriptor: what follows is no argument of the command
        dropDescriptor();
        if (target) return null;
        if (next === '&') i++;
        target = { input: true };
        continue;
      }
      if (s[i + 2] === '<' || pending || target) return null;
      dropDescriptor();
      const dash = s[i + 2] === '-';
      const rest = s.slice(i + (dash ? 3 : 2));
      const m = rest.match(/^[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))(?=[\s;|&<>]|$)/);
      if (!m) return null;
      pending = { delim: m[1] || m[2] || m[3], literal: !m[3], dash };
      cur.hereDoc = true;
      i += (dash ? 2 : 1) + m[0].length;
    } else add(ch, false);
  }
  if (!commandEnd('')) return null;
  if (pending) return null;
  // A here-document's text must not travel on: with a pipe anywhere on the line it is not plain.
  if (commands.some((c) => c.hereDoc) && commands.some((c) => c.piped || (c.hereDoc && !takesText(c.words)))) return null;
  return commands;
}

/**
 * The words one command of plain shell could write to: null when it has no write verb, else
 * { words, xargs }. `cp [options] sources… destination` writes only its destination; any other
 * shape (an option after the first path, -t, a redirect to or from a file) is read whole.
 */
function written(c) {
  const text = normalizeShell(c.words.map((w) => w.text).join(' '));
  if (!WRITE_VERB.test(text)) return null;
  const args = c.words.slice(1).map((w) => w.text);
  const firstPath = args.findIndex((a) => !a.startsWith('-'));
  const bare = !c.reads && !c.hereDoc && c.targets.every(noFile);
  const shape = bare && !c.words[0].quoted && firstPath >= 0 && !args.slice(firstPath).some((a) => a.startsWith('-')) && !args.some((a) => /^(-[A-Za-z]*t|--target-directory)/.test(a));
  const plainCopy = shape && c.words[0].text === 'cp';
  // `cp a.json dir/` and `mv a.json dir` write dir/a.json: the name each source would get there counts too.
  const paths = args.slice(firstPath).map((a) => a.replace(/\\/g, '/'));
  const inFolder = shape && /^(cp|mv)$/.test(c.words[0].text) ? paths.slice(0, -1).map((s) => path.posix.join(paths.at(-1), path.posix.basename(s))) : [];
  return { words: [...(plainCopy ? args.slice(-1) : text.split(FRAGMENTS)), ...inFolder], xargs: /\bxargs\b/i.test(text) };
}

/**
 * Does a shell line write into a protected path? Returns the path, or null. A line that only
 * names such a path (cat, grep, running the runner's tests with 2>&1) reads it and passes.
 *
 * What counts, when the line names a protected path at all:
 *  - a redirect whose target is protected, or cannot be read here (a variable, a substitution, ~);
 *  - a cd into a protected folder, or into one that cannot be read here, together with any
 *    redirect to a file or any write verb: relative paths then mean something else;
 *  - a write verb. In plain shell (readPlainShell) only with a protected or unreadable path in the
 *    same command, and for `cp sources… destination` only by its destination. In anything else,
 *    anywhere on the line.
 * Not looked at: what a program does with a path it is handed (`node -e`, a script). An early
 * warning: the runner's own checks after every session are the hard stop.
 */
export function shellWritesProtected(cmd, ctx) {
  // A folder counts when what is inside it is protected: `loop` as much as `loop/run.mjs`.
  // A backslash is a path separator to some tools and an escape to the shell (lo\op is loop):
  // both readings count.
  const protectedWord = (w) => readAs(w) || (String(w || '').includes('\\') ? readAs(String(w).replace(/\\/g, '')) : null);
  const readAs = (w) => {
    const word = String(w || '')
      .replace(/[(){}]/g, '')
      .replace(/[;,&|]+$/, '')
      .replace(/^(?:\.\.?[\\/])+/, '') // `../loop/run.mjs` after a cd may be the repository's own
      .replace(/^\/([A-Za-z])\//, '$1:/'); // /c/Users/… is C:/Users/… in Git Bash
    const rel = word ? ctx.rel(word) : null;
    if (!rel) return null;
    if (isProtected(rel, ctx)) return rel;
    // a patch names its files a/… and b/…
    if (/^[ab]\//.test(rel) && isProtected(rel.slice(2), ctx)) return rel.slice(2);
    // inside a protected folder but let through by name (a new patch, .env.example): not a folder
    if (matchesAny(rel, ctx.cfg.guard?.protectedPaths || []) || /^\.loop(\/|$)/.test(rel)) return null;
    return isProtected(`${rel.replace(/\/$/, '')}/x`, ctx) ? rel : null;
  };
  const anyProtected = (text) => String(text).split(FRAGMENTS).map(protectedWord).find(Boolean) || null;
  const redirectsIn = (text) => [...String(text).matchAll(REDIRECT)].filter((m) => !(m[1].endsWith('&') && /^(\d+|-)$/.test(m[2]))).map((m) => m[2]).filter((t) => !/^\(/.test(t) && !noFile(t));

  const plain = readPlainShell(cmd);
  // What the line says, as one text without quote marks: all of it, or for plain shell what is
  // left once the here-document bodies that are data are gone.
  const said = plain ? plain.map((c) => [...c.words.map((w) => w.text), ...c.targets.map((t) => `> ${t}`)].join(' ')).join(' ; ') : String(cmd).replace(/\\\r?\n/g, '').replace(/["'`]/g, ''); // lo"op"/run.mjs is loop/run.mjs, and so is lo\⏎op/run.mjs
  const flat = normalizeShell(said); // `git -C dir restore` is `git restore` here
  const targets = plain ? plain.flatMap((c) => [...c.targets.filter((t) => !noFile(t)), ...c.words.filter((w) => w.quoted).flatMap((w) => redirectsIn(w.text))]) : redirectsIn(flat);
  const anyVerb = WRITE_VERB.test(flat);

  // A relative path means a file in the folder the command runs in: after `cd .loop`,
  // `state.json` is .loop/state.json and `guard/loop/guard.mjs` is the guard itself. So every
  // path a redirect or a write verb could touch is also read from each folder the line could be
  // in: the session's own, and every cd on the line, from each folder before it. Too many folders
  // rather than too few; a read (`cd .loop && cat state.json`) is not looked at.
  if (targets.length || anyVerb) {
    const folders = new Set(ctx.cwd ? [ctx.cwd] : []);
    for (const cd of flat.matchAll(CD)) {
      const to = cd[1].replace(/[)}]+$/, '');
      if (unreadable(to)) continue;
      if (isRelative(to)) for (const f of ['', ...folders]) folders.add(cleanPath(path.posix.join(f, to)));
      else if (ctx.rel(to.replace(/^\/([A-Za-z])\//, '$1:/'))) folders.add(ctx.rel(to.replace(/^\/([A-Za-z])\//, '$1:/')));
    }
    const words = [...targets, ...(plain ? plain.flatMap((c) => written(c)?.words || []) : anyVerb ? said.split(FRAGMENTS) : [])].filter((w) => w && isRelative(w));
    for (const f of folders) {
      if (!f || f === '.' || f.startsWith('..')) continue;
      for (const w of words) {
        const rel = cleanPath(path.posix.join(f, w));
        if (!rel.startsWith('..') && isProtected(rel, ctx)) return rel;
      }
    }
  }

  // also the name a copied or moved file gets in the folder it goes to (written, above)
  const mentioned = anyProtected(said) || anyProtected(flat) || (plain ? plain.flatMap((c) => written(c)?.words || []).map(protectedWord).find(Boolean) : null) || null;
  if (!mentioned) return null;

  for (const t of targets) {
    if (unreadable(t)) return mentioned;
    const hit = protectedWord(t) || protectedWord(t.replace(/\\/g, ''));
    if (hit) return hit;
  }
  for (const cd of [...flat.matchAll(CD), ...said.matchAll(GIT_DIR)]) {
    const into = unreadable(cd[1]) ? mentioned : protectedWord(cd[1]);
    if (into && (targets.length || anyVerb)) return into;
  }
  if (!plain) return anyVerb ? mentioned : null;

  for (const c of plain) {
    const w = written(c);
    if (!w) continue;
    if (w.xargs) return mentioned;
    for (const word of w.words) {
      if (unreadable(word)) return mentioned;
      const hit = protectedWord(word);
      if (hit) return hit;
    }
  }
  return null;
}

// ------------------------------------------------------- shell writes in a read-only step
//
// A read-only step (review, acceptance, the packet, a retro) keeps its evidence under .loop/ and
// writes nowhere else. The question "where does this line write?" gets the same two answers as the
// one about protected paths further down.
//
// The exact answer is for plain shell (readPlainShell): each redirect has a target, and the
// target is judged where it will land. The folder a relative target is written in is known from
// the session's working folder and from every `cd` on the line; where that is not certain (a cd
// that may fail, one inside an `if`), the target must be allowed in every folder it could mean.
// A `>` inside quotes or inside a here-document handed to cat is text, as long as nothing on the
// line could run that text as shell.
//
// The coarse answer, for every other line, reads each `>` anywhere as a redirect and allows only
// a target that is spelled out as the null device, a temp folder or a path through .loop/.
//
// Not looked at: what a program does itself (`node -e`, a script, `cp`). The runner checks after
// every read-only session that no tracked file changed.

/** Commands that print or search the text they are given and never run it as shell. */
const READS_TEXT = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'jq', 'test', '[', 'cd', 'ls', 'diff', 'node', 'gh', 'git']);
/**
 * git and gh run text in many places (`git submodule foreach '<shell>'`, `git bisect run`,
 * `rebase --exec`, an alias, a pager set on the line; `gh alias`, `gh extension`, `gh config`).
 * They count as readers only in these subcommands, which print or search.
 */
const GIT_READS = new Set(['log', 'show', 'diff', 'grep', 'status', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'cat-file', 'blame', 'merge-base', 'describe', 'shortlog', 'fetch', 'show-ref', 'for-each-ref', 'diff-tree']);
const GIT_VALUE_OPTION = /^(-C|--git-dir|--work-tree|--namespace)$/;
const GIT_RUNS = /^(-c|--config-env|--exec-path|-O|--open-files-in-pager|--ext-diff|--exec|-x)/;
const GH_READS = new Set(['pr', 'issue', 'run', 'api', 'repo', 'release', 'search', 'workflow', 'status']);
const GH_VALUE_OPTION = /^(-R|--repo|--hostname)$/;
/** The subcommand of `git …` or `gh …`: the first word that is no option and no option's value. */
const subcommand = (words, takesValue) => {
  for (let i = 1; i < words.length; i++) {
    if (takesValue.test(words[i])) i++;
    else if (!words[i].startsWith('-')) return words[i];
  }
  return null;
};
/** After one of these the working folder is anyone's guess. */
const MOVES = new Set(['source', '.', 'eval', 'builtin', 'command', 'trap', 'alias', 'shopt', 'enable']);
/** A word that changes the working folder, in bash or PowerShell, wherever it stands in a command. */
const CHANGES_FOLDER = /^(cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)$/i;
/** Words that run the command after them: \`sudo tee f\` writes f as much as \`tee f\` does. */
const RUNS_NEXT = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'stdbuf', 'timeout', 'xargs']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** tee where a command starts in a line without its quote marks, alone or behind one of the words above. */
const TEE_RUN = new RegExp(String.raw`(?:^|[|;&(]\s*)(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:${[...RUNS_NEXT].join('|')})\b[^|;&]*?\s)?tee\s+((?:[^\s|;&<>]+\s*)+)`, 'gi');
const TEMP_DIR = /^(\/tmp\/|\$TMPDIR\b|\$env:TEMP\b|%TEMP%)/i;
const cleanPath = (t) => path.posix.normalize(String(t).replace(/\\/g, '/'));
/** Spelled out as a place a read-only step may write, wherever the line runs. */
const namesLoop = (t) => noFile(t) || TEMP_DIR.test(t) || /(^|\/)\.loop\//.test(cleanPath(t));
const isRelative = (t) => !/^([\\/]|[A-Za-z]:)/.test(t) && !unreadable(t);

/**
 * Does a shell line in a read-only step write outside .loop/? Returns the target, or null.
 * ctx.cwd: the session's working folder, relative to the repository ('' at its root, null when
 * it is outside or unknown).
 */
export function shellWritesOutsideLoop(cmd, ctx) {
  const plain = readPlainShell(cmd);
  if (!plain) {
    const flat = normalizeShell(cmd);
    // `$(cmd 2>&1)`: the bracket that closes a substitution is not part of the target
    const targets = [...flat.matchAll(REDIRECT)].map((m) => [m[1], m[2].replace(/\)+$/, '')]).filter(([op, t]) => !(op.endsWith('&') && /^(\d+|-)$/.test(t))).map(([, t]) => t);
    for (const m of flat.matchAll(TEE_RUN)) targets.push(...m[1].trim().split(/\s+/).filter((a) => !a.startsWith('-')));
    return targets.find((t) => !namesLoop(t)) ?? null;
  }

  const lead = (c) => c.words.filter((w) => w.text !== '{' && w.text !== '}');
  const first = (c) => (lead(c)[0] && !lead(c)[0].quoted ? lead(c)[0].text : null);
  // Text is only text when no command on the line could run it: every command is one that reads.
  const textIsText = plain.every((c) => {
    const w = lead(c).map((x) => x.text);
    if (!w.length) return true;
    if (!READS_TEXT.has(first(c))) return false;
    if (w[0] === 'git') return GIT_READS.has(subcommand(w, GIT_VALUE_OPTION)) && !w.some((x) => GIT_RUNS.test(x));
    if (w[0] === 'gh') return GH_READS.has(subcommand(w, GH_VALUE_OPTION));
    return true;
  });

  // The folders the next relative path could be written in; null stands for "not known". Within
  // \`cd x && …\` the rest runs in x for certain. Once that list ends (\`;\`, a new line, \`||\`,
  // \`&\`), a cd in it may have failed or been skipped, so every folder the list passed through is
  // possible, and a target must be under .loop/ in each of them.
  const start = ctx.cwd === undefined ? '' : ctx.cwd;
  let dirs = [/\bCDPATH\b/.test(cmd) ? null : start]; // with CDPATH set, cd goes somewhere this cannot see
  let passed = new Set(dirs);
  let skippable = false; // a `||` earlier in this list: what follows it may not run at all
  const lands = (t) => namesLoop(t) || (isRelative(t) && dirs.every((d) => d !== null && /^\.loop\//.test(cleanPath(path.posix.join(d, t)))));
  for (const c of plain) {
    for (const t of c.targets) if (!lands(t)) return t;
    const words = lead(c);
    const name = first(c);
    // tee writes the files it is given, where it is the command that runs: `tee f`, `sudo tee f`.
    // As an argument (`echo tee f`, `grep tee f`) it is a word like any other.
    const run = words.slice(words.findIndex((w) => w.quoted || !ASSIGNMENT.test(w.text)));
    const tee = run[0] && !run[0].quoted && (run[0].text === 'tee' || RUNS_NEXT.has(run[0].text)) ? run.findIndex((w) => !w.quoted && w.text === 'tee') : -1;
    if (tee >= 0) for (const a of run.slice(tee + 1).filter((w) => w.quoted || !w.text.startsWith('-'))) if (!lands(a.text)) return a.text;
    if (!textIsText) {
      for (const w of words.filter((x) => x.quoted)) {
        const hit = [...w.text.matchAll(REDIRECT)].filter((m) => !(m[1].endsWith('&') && /^(\d+|-)$/.test(m[2]))).map((m) => m[2]).find((t) => !namesLoop(t));
        if (hit) return hit;
      }
    }
    // Where the next command runs.
    const runs = words.find((w) => w.quoted || !ASSIGNMENT.test(w.text)); // the command, past VAR=value words
    if (name === 'cd') {
      const args = words.slice(1).filter((w) => w.quoted || !w.text.startsWith('-')).map((w) => w.text);
      const to = args.length === 1 && !unreadable(args[0]) && args[0] !== '-' ? args[0] : null;
      const into = (d) => {
        if (to === null || d === null) return null;
        if (isRelative(to)) {
          const r = cleanPath(path.posix.join(d, to));
          return r === '.' ? '' : r.startsWith('..') ? null : r;
        }
        return ctx.rel(to.replace(/^\/([A-Za-z])\//, '$1:/')); // /c/Users/… is C:/Users/… in Git Bash
      };
      const there = dirs.map(into);
      for (const d of there) passed.add(d);
      // In a pipe the cd runs in a subshell and changes nothing for what follows. After a `||` in
      // the same list it may have been skipped (`true || cd x && …`): both folders are possible.
      if (c.after === '&&' && !c.piped) dirs = skippable ? [...new Set([...dirs, ...there])] : there;
    } else if (runs && (MOVES.has(runs.text) || runs.text.includes('$') || words.some((w) => CHANGES_FOLDER.test(w.text)))) {
      // Quoted or not: "cd" .. changes the folder as cd .. does, and so may a command that is
      // only known as a variable ($X ..). A word like these as an argument costs the certainty too.
      dirs = [null];
      passed.add(null);
    }
    if (c.after !== '&&' && c.after !== '|') {
      dirs = [...passed];
      passed = new Set(dirs);
      skippable = c.after === '||';
    }
  }
  return null;
}

// ----------------------------------------------------------------------------------------- edits
/** Protected and not one of the two harness files the loop may add to. */
export function isProtected(rel, ctx) {
  if (/^\.loop\/(guard\/|claude-settings\.json$|state\.json$)/.test(rel)) return true; // the guard snapshot, session settings and runner state
  if (/^\.loop\//.test(rel)) return false;
  if (rel === 'loop/rules/project-rules.json') return false; // add-only, enforced by check-rules in CI
  if (/^loop\/patches\/[^/]+\.patch$/.test(rel)) return ctx.isOnBase(rel); // a new patch may be written
  if (/(^|\/)\.env\.example$/.test(rel)) return false;
  return matchesAny(rel, ctx.cfg.guard?.protectedPaths || []);
}

function decideEdit(file, ctx) {
  const rel = ctx.rel(file);
  if (READ_ONLY_PHASES.has(ctx.phase) && !(rel && /^\.loop\//.test(rel))) return no('core:read-only', `the ${ctx.phase} step may only write under .loop/.`);
  if (rel === null) return ok; // outside the repository: scratch files
  if (/^loop\/patches\/[^/]+$/.test(rel) && ctx.isOnBase(rel)) return no('core:patch-frozen', `this runner patch is already on ${ctx.cfg.base} and waits for the owner. Write a new patch file instead.`);
  if (isProtected(rel, ctx)) return no('core:protected-path', `${rel} is part of the harness or the owner's; the loop cannot change it. A runner change ships as a new file in loop/patches/.`);
  const migrations = (ctx.cfg.postMerge || []).map((s) => s.migrationsDir).filter(Boolean);
  if (migrations.some((d) => rel.startsWith(d.replace(/\/$/, '') + '/')) && /\.sql$/i.test(rel) && ctx.isOnBase(rel)) {
    return no('core:frozen-migration', `this migration is already on ${ctx.cfg.base}, so it is applied or about to be. Fix forward with a new file.`);
  }
  const hit = matchRules(ctx.projectRules || [], 'path', rel, ctx.phase);
  if (hit) return no(hit.id, hit.reason);
  return ok;
}
