// The gates that need only git: the pre-merge checks and the landed check. The script decides
// these, never an agent. They know nothing about the forge (see adapters/forge-*.mjs) and nothing
// about the stack: which files CI runs through and which numbers may only go up come from the
// profile (`gates` in loop/profile/profile.json).
//
// Lessons behind them (docs/LESSONS.md, WHY.md):
//   L-01  CI must run on what will land: the branch must contain the current base before merge.
//   A merged PR can lie about what landed: confirm the merge commit is on the base and carries
//   exactly the reviewed change (patch-id), before anything else builds on it.

import { matchesAny } from '../guard/paths.mjs';
import { isProtected } from '../guard/core.mjs';

// ------------------------------------------------------------------------------------- contract
/** The AC IDs a backlog item names, in its refs, title or scope. */
export function itemAcs(item) {
  const text = [item?.title, item?.scope, ...(Array.isArray(item?.refs) ? item.refs : [])].filter((x) => typeof x === 'string').join('\n');
  return [...new Set(text.match(/(?<![\w.-])AC-\d+\.\d+(?!\.?\d)/g) || [])];
}

/**
 * The item's contract on the branch must name every AC the item names. The builder writes the
 * contract and the reviewer grades against it, so which criteria it has to hold is not the
 * builder's call: the AC gate in CI then demands a passing test for every AC a contract names.
 */
function contractProblems(proc, cfg, branch, item) {
  const acs = itemAcs(item);
  if (!acs.length) return [];
  const file = `${(cfg.contractsDir || 'docs/contracts').replace(/\/$/, '')}/${item.id}.md`;
  const c = proc.gitTry('show', `${branch}:${file}`);
  if (!c.ok) return [`\`${file}\` is missing: write the contract first, with every acceptance criterion of this item (${acs.join(', ')}) and its proof.`];
  const missing = acs.filter((ac) => !new RegExp(`(?<![\\w.-])${ac.replace('.', '\\.')}(?!\\.?\\d)`).test(c.out));
  return missing.length ? [`\`${file}\` leaves out ${missing.join(', ')}: the contract must name every acceptance criterion of this item with its proof. Do not drop or merge criteria.`] : [];
}

// ------------------------------------------------------------------------------------- ratchets
// A ratchet is a set of numbers in a config file that may only go up (coverage thresholds, a
// minimum score). The profile describes it:
//   { name, files: [...], comments: 'js' | 'hash' | 'none',
//     within?: regex whose group 1 is the block the numbers live in (several blocks: lowest wins),
//     number: regex with group 1 = the key and group 2 = the number }
// A PR may change such a file only by raising those numbers. It may not add, remove or rename it.

const COMMENT_STRIPPERS = {
  js: (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1'),
  hash: (t) => t.replace(/(^|\s)#.*$/gm, '$1'),
  none: (t) => t,
};
const stripComments = (text, r) => (COMMENT_STRIPPERS[r.comments] || COMMENT_STRIPPERS.none)(String(text || ''));
const numberRe = (r) => new RegExp(r.number, 'g');

/** The ratchet's numbers in `text`, comments ignored: { key: number }. With several blocks, the lowest per key. */
export function ratchetValues(text, r) {
  const out = {};
  const body = stripComments(text, r);
  const blocks = r.within ? [...body.matchAll(new RegExp(r.within, 'g'))].map((m) => m[1] ?? m[0]) : [body];
  for (const block of blocks) for (const m of block.matchAll(numberRe(r))) out[m[1]] = Math.min(out[m[1]] ?? Infinity, Number(m[2]));
  return out;
}

/** The file with its ratchet numbers blanked: the only change a PR may make is raising them. */
const ratchetShape = (text, r) => stripComments(text, r).replace(numberRe(r), (_, key) => `${key}=N`).replace(/\s+/g, ' ').trim();

/**
 * Files CI runs through. A PR that changes them could switch a gate off and still be green, so the
 * loop may not change them. From the profile's `gates`:
 *   files          globs that may not change at all (test, lint and type configs, the repo scripts)
 *   frozenJsonKeys [{ file, key }]: one key of a JSON file that may not change (the commands CI
 *                  runs), while the rest of the file may (dependencies)
 *   ratchets       files that may change only by raising their numbers
 */
function gateProblems(proc, cfg, branch, changes) {
  const problems = [];
  const gates = cfg.gates || {};
  const show = (ref, f) => proc.gitTry('show', `${ref}:${f}`);
  const ratchetOf = (file) => (gates.ratchets || []).find((r) => (r.files || []).includes(file));
  for (const { status, files } of changes) {
    for (const file of files) {
      if (matchesAny(file, gates.files || [])) problems.push(`\`${file}\` (${status}): CI runs through it, so the loop may not change it. Ask for the change in owner_actions, or ship it as a patch in loop/patches/.`);
      const r = ratchetOf(file);
      if (r && !status.startsWith('M')) problems.push(`\`${file}\` (${status}): the ${r.name} config may not be added, removed or renamed by the loop.`);
    }
  }
  for (const { file, key } of gates.frozenJsonKeys || []) {
    const before = show(`origin/${cfg.base}`, file);
    if (!before.ok) continue;
    const after = show(branch, file);
    let a = null;
    let b = null;
    try {
      a = JSON.parse(before.out)[key] || {};
      b = after.ok ? JSON.parse(after.out)[key] || {} : null;
    } catch {
      problems.push(`${file}: not valid JSON on the branch.`);
    }
    if (a && JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${file}: the "${key}" changed. CI runs every gate through them, so the loop may not change them (the rest of the file may change).`);
  }
  for (const r of gates.ratchets || []) {
    for (const f of r.files || []) {
      const before = show(`origin/${cfg.base}`, f);
      if (!before.ok) continue;
      const after = show(branch, f);
      if (!after.ok) continue; // reported above as removed or renamed
      if (ratchetShape(before.out, r) !== ratchetShape(after.out, r)) problems.push(`${f}: only the ${r.name} threshold numbers may change, and only upwards.`);
      const a = ratchetValues(before.out, r);
      const b = ratchetValues(after.out, r);
      for (const [k, v] of Object.entries(a)) if (!(b[k] >= v)) problems.push(`${f}: ${r.name} threshold ${k} went from ${v} to ${b[k] ?? 'removed'} — the ratchet only goes up.${r.hint ? ` ${r.hint}` : ''}`);
    }
  }
  return problems;
}

// ----------------------------------------------------------------------------------- pre-merge
/** `git diff --name-status -z` → [{ status, files }], with unquoted, forward-slash paths. */
function nameStatus(proc, range) {
  const raw = proc.sh('git', ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', range], { raw: true }).out.toString('utf8');
  const parts = raw.split('\0').filter((x) => x !== '');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const n = /^[RC]/.test(status) ? 2 : 1;
    out.push({ status, files: parts.slice(i, i + n).map((f) => f.replace(/\\/g, '/')) });
    i += n;
  }
  return out;
}

/** Structural checks the reviewer should never have to catch. {ok} | {ok:false, text} */
export function preMergeChecks(ctx, s, item) {
  const { proc, cfg } = ctx;
  proc.git('fetch', 'origin', '--prune');
  const branch = `origin/${s.branch}`;
  if (!proc.gitTry('merge-base', '--is-ancestor', `origin/${cfg.base}`, branch).ok) {
    return { ok: false, text: `\`${cfg.base}\` has moved since this branch was cut. Merge \`origin/${cfg.base}\` into \`${s.branch}\` (no rebase, no force-push), resolve conflicts, re-run the local gates and push. CI must run on what will actually land (L-01).` };
  }
  const changes = nameStatus(proc, `origin/${cfg.base}...${branch}`);
  const migrationDirs = (cfg.postMerge || []).map((x) => x.migrationsDir).filter(Boolean);
  const guardCtx = { cfg, isOnBase: (rel) => proc.gitTry('cat-file', '-e', `origin/${cfg.base}:${rel}`).ok };
  const problems = gateProblems(proc, cfg, branch, changes);
  if (item) problems.push(...contractProblems(proc, cfg, branch, item));
  for (const { status, files } of changes) {
    for (const file of files) {
      if (migrationDirs.some((d) => file.startsWith(d.replace(/\/$/, '') + '/')) && /\.sql$/.test(file) && !status.startsWith('A')) problems.push(`\`${file}\` (${status}): migrations already on ${cfg.base} are frozen — revert this change and fix forward with a new file.`);
      if (/(^|\/)\.env($|\.(?!example$))/.test(file)) problems.push(`\`${file}\`: env files must never be committed.`);
      else if (/^\.loop\//.test(file)) problems.push(`\`${file}\`: loop runtime files must not be committed.`);
      else if (isProtected(file, guardCtx) || (matchesAny(file, ['loop/patches/*']) && !status.startsWith('A'))) problems.push(`\`${file}\` (${status}): part of the harness or the owner's. A runner change ships as a new file in loop/patches/.`);
    }
  }
  if (problems.length) return { ok: false, text: 'Pre-merge checks failed:\n- ' + problems.join('\n- ') };
  return { ok: true };
}

// -------------------------------------------------------------------------------------- landed
function patchId(proc, range) {
  const diff = proc.sh('git', ['diff', '--binary', ...range], { allowFail: true });
  if (!diff.ok) return null;
  if (!diff.out.trim()) return 'empty';
  const id = proc.sh('git', ['patch-id', '--stable'], { input: diff.out + '\n', allowFail: true });
  return id.ok ? id.out.split(/\s+/)[0] || null : null;
}

/**
 * Did the reviewed change land, and only it? The merge commit must be on origin/<base>, and its
 * change (mergeSha^..mergeSha) must have the same patch-id as the reviewed change
 * (merge-base(baseBefore, reviewedSha)..reviewedSha).
 */
export function landedCheck(ctx, { baseBefore, reviewedSha, mergeSha }) {
  const { proc, cfg } = ctx;
  if (!mergeSha) return { ok: false, why: 'the forge reported no merge commit' };
  proc.git('fetch', 'origin', '--prune');
  if (!proc.gitTry('merge-base', '--is-ancestor', mergeSha, `origin/${cfg.base}`).ok) return { ok: false, why: `merge commit ${mergeSha.slice(0, 7)} is not on origin/${cfg.base}` };
  const parent = proc.gitTry('rev-parse', `${mergeSha}^`);
  if (!parent.ok) return { ok: false, why: `merge commit ${mergeSha.slice(0, 7)} has no parent` };
  // The usual case: the branch contained the base (L-01) and the base did not move, so the squash
  // result must be the reviewed tree exactly, whitespace included.
  if (baseBefore && parent.out === baseBefore && proc.gitTry('merge-base', '--is-ancestor', baseBefore, reviewedSha).ok) {
    const tree = (rev) => proc.gitTry('rev-parse', `${rev}^{tree}`).out;
    if (tree(mergeSha) === tree(reviewedSha)) return { ok: true, why: '', treeEqual: true };
    const diff = proc.gitTry('diff', '--name-only', reviewedSha, mergeSha).out.split('\n').filter(Boolean);
    return { ok: false, why: `what landed differs from what was reviewed; not reviewed: ${diff.join(', ') || '(content only)'}` };
  }
  const from = proc.gitTry('merge-base', baseBefore || parent.out, reviewedSha);
  if (!from.ok) return { ok: false, why: `cannot find where ${reviewedSha.slice(0, 7)} left ${cfg.base}` };
  const merged = patchId(proc, [`${mergeSha}^`, mergeSha]);
  const reviewed = patchId(proc, [from.out, reviewedSha]);
  if (!merged || !reviewed) return { ok: false, why: 'could not compute patch-ids' };
  if (merged !== reviewed) {
    const files = (r) => proc.gitTry('diff', '--name-only', ...r).out.split('\n').filter(Boolean);
    const a = new Set(files([`${mergeSha}^`, mergeSha]));
    const b = new Set(files([from.out, reviewedSha]));
    const extra = [...a].filter((f) => !b.has(f));
    const missing = [...b].filter((f) => !a.has(f));
    return { ok: false, why: `what landed differs from what was reviewed${extra.length ? `; not reviewed: ${extra.join(', ')}` : ''}${missing.length ? `; reviewed but missing: ${missing.join(', ')}` : ''}${!extra.length && !missing.length ? '; same files, different content' : ''}` };
  }
  return { ok: true, why: '' };
}
