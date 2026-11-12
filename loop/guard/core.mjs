// The locked core of the loop guard: the rules every project needs whatever it is built with,
// decided as a pure function. Git, the harness files and the read-only steps live here. The rules
// for one tool or service (the forge's CLI, a database, a host) live in a guard pack
// (./packs/), switched on by `guard.packs` in the profile.
//
// This file is a protected path. The loop cannot edit it, and nothing in loop/rules/ or in a pack
// can switch a rule here off: packs and project rules can only add blocks. Every rule has a block
// case and an allow case in loop/test/guard-core.test.mjs.

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
 *        projectRules: compiled rows, packs?: pack modules (default: the ones cfg.guard.packs names) }
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
    if (/(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null|\$null|NUL\b|\/tmp\/|\$TMPDIR|\$env:TEMP|%TEMP%|\.loop\/|\S*[\\/]\.loop[\\/])\S/i.test(c) || /\b(sed\s+-i|perl\s+-p?i|Set-Content|Add-Content|Out-File)\b/i.test(c)) return no('core:read-only', `the ${ctx.phase} step is read-only: redirect output only into .loop/.`);
  }
  // Shell writes into protected files. The pre-merge check is the hard stop; this catches the obvious ones early.
  const protectedHit = protectedPathMentioned(c, ctx);
  if (protectedHit && /(>|\btee\b|\bsed\s+-i|\bperl\s+-p?i|\bcp\b|\bmv\b|\brm\b|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|\bgit\s+(checkout|restore|apply|rm)\b)/i.test(c)) {
    return no('core:protected-path', `${protectedHit} is part of the harness or the owner's; the loop cannot change it.`);
  }
  const hit = matchRules(ctx.projectRules || [], 'shell', c, ctx.phase);
  if (hit) return no(hit.id, hit.reason);
  return ok;
}

function protectedPathMentioned(c, ctx) {
  const words = c.split(/[\s"'`;|&()<>]+/).filter(Boolean);
  for (const w of words) {
    const rel = ctx.rel(w);
    if (rel && isProtected(rel, ctx)) return rel;
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
