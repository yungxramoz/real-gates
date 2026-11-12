// CI, merge and landed-check gates. The script decides these, never an agent.
//
// Lessons behind them (docs/LESSONS.md, WHY.md):
//   L-01  CI must run on what will land: the branch must contain the current base before merge.
//   L-02  A run cancelled with no runner assigned was starved, not red: re-run it.
//   A merged PR can lie about what landed: confirm the merge commit is on the base and carries
//   exactly the reviewed change (patch-id), before anything else builds on it.
//   A CI that never finishes is not a pass.

import fs from 'node:fs';
import path from 'node:path';

import { matchesAny } from '../guard/paths.mjs';
import { isProtected } from '../guard/core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function prView(ctx, pr) {
  return ctx.proc.ghJson('pr', 'view', String(pr), '--repo', ctx.cfg.repo, '--json', 'number,state,baseRefName,headRefName,headRefOid,mergeStateStatus,statusCheckRollup,mergeCommit,url,isDraft,title');
}

/** Does GitHub protect this branch, by a classic protection rule or an active ruleset? */
export function branchProtected(ctx, branch) {
  const b = ctx.proc.ghTry('api', `repos/${ctx.cfg.repo}/branches/${branch}`);
  try {
    if (b.ok && JSON.parse(b.out).protected === true) return true;
  } catch {}
  const r = ctx.proc.ghTry('api', `repos/${ctx.cfg.repo}/rules/branches/${branch}`);
  try {
    const rules = r.ok ? JSON.parse(r.out) : [];
    return Array.isArray(rules) && rules.length > 0;
  } catch {
    return false;
  }
}

/** The AC IDs a backlog item names, in its refs, title or scope. */
export function itemAcs(item) {
  const text = [item?.title, item?.scope, ...(Array.isArray(item?.refs) ? item.refs : [])].filter((x) => typeof x === 'string').join('\n');
  return [...new Set(text.match(/(?<![\w.-])AC-\d+\.\d+(?!\.?\d)/g) || [])];
}

/**
 * The item's contract on the branch must name every AC the item names. The builder writes the
 * contract and the reviewer grades against it, so which criteria it has to hold is not the
 * builder's call: scripts/ac-trace.mjs then demands a live test for every AC a contract names.
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

export function runIdFrom(url) {
  const m = String(url || '').match(/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

/** What a completed-but-not-green CI run means (L-02). Writes the failing log to the logs dir. */
export function diagnoseRun(ctx, runId, tag) {
  const jobs = ctx.proc.ghJson('api', `repos/${ctx.cfg.repo}/actions/runs/${runId}/jobs?per_page=100`)?.jobs || [];
  const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
  const starved = jobs.filter((j) => j.conclusion === 'cancelled' && !j.runner_name);
  if (failed.length === 0 && starved.length > 0) return { kind: 'starved', runId };
  const logs = ctx.proc.ghTry('run', 'view', String(runId), '--repo', ctx.cfg.repo, '--log-failed');
  const text = (logs.out || logs.err || '').split('\n').slice(-500).join('\n');
  const file = path.join(ctx.paths.logs, `ci-${tag}-${runId}.txt`);
  fs.mkdirSync(ctx.paths.logs, { recursive: true });
  // One CI job with many steps is the norm (one job bills less), so the failed *steps* name what broke.
  const steps = failed.flatMap((j) => (j.steps || []).filter((st) => st.conclusion === 'failure').map((st) => st.name));
  const names = steps.length ? steps : failed.map((j) => j.name);
  fs.writeFileSync(file, `Failed: ${names.join(', ') || '(none reported)'}\n\n${text}`);
  return { kind: 'red', runId, file, jobs: names };
}

const pollMs = (ctx) => ctx.cfg.pollMs ?? 30_000;
const ciDeadline = (ctx) => Date.now() + ctx.cfg.timeouts.ciMin * 60_000;

/** Wait for the `ci` check on a PR's head. {ok:true, sha} | {ok:false, kind: red|conflict|closed|no-ci|timeout|stopped, …} */
export async function waitForPrCi(ctx, pr) {
  const deadline = ciDeadline(ctx);
  const started = Date.now();
  const noCiAfter = Math.min(10 * 60_000, ctx.cfg.timeouts.ciMin * 60_000);
  let reruns = 0;
  for (;;) {
    if (ctx.stopRequested()) return { ok: false, kind: 'stopped' };
    const v = prView(ctx, pr);
    if (v.state === 'MERGED') return { ok: false, kind: 'merged', text: `PR #${pr} was merged before the runner merged it` };
    if (v.state !== 'OPEN') return { ok: false, kind: 'closed', text: `PR #${pr} is ${v.state}` };
    if (v.mergeStateStatus === 'DIRTY') return { ok: false, kind: 'conflict' };
    const ci = (v.statusCheckRollup || []).find((c) => c.__typename === 'CheckRun' && c.name === ctx.cfg.ciCheck);
    if (!ci) {
      if (Date.now() - started > noCiAfter) return { ok: false, kind: 'no-ci', text: `no \`${ctx.cfg.ciCheck}\` check appeared` };
    } else if (ci.status === 'COMPLETED') {
      if (ci.conclusion === 'SUCCESS') return { ok: true, sha: v.headRefOid };
      const runId = runIdFrom(ci.detailsUrl);
      if (!runId) return { ok: false, kind: 'red', text: `${ctx.cfg.ciCheck} concluded ${ci.conclusion}` };
      const d = diagnoseRun(ctx, runId, `pr${pr}`);
      if (d.kind === 'starved' && reruns < 3) {
        reruns++;
        ctx.log(`CI run ${runId} was starved of runners (L-02) — re-running (${reruns}/3)`);
        ctx.proc.ghTry('run', 'rerun', String(runId), '--repo', ctx.cfg.repo);
        await sleep(pollMs(ctx) * 2);
        continue;
      }
      return { ok: false, ...d };
    }
    if (Date.now() > deadline) return { ok: false, kind: 'timeout', text: `CI did not finish within ${ctx.cfg.timeouts.ciMin} min` };
    await sleep(pollMs(ctx));
  }
}

/**
 * Wait for `ci` on a commit of the base branch (after a merge). A timeout is NOT a pass: the run is
 * re-requested once, and if it still has no verdict the caller holds the item.
 */
export async function waitForCommitCi(ctx, sha) {
  let reruns = 0;
  let timeouts = 0;
  let deadline = ciDeadline(ctx);
  let lastRunId = null;
  for (;;) {
    if (ctx.stopRequested()) return { ok: false, kind: 'stopped' };
    const runs = ctx.proc.ghTry('api', `repos/${ctx.cfg.repo}/commits/${sha}/check-runs?per_page=100`);
    const ci = runs.ok ? (JSON.parse(runs.out || '{}').check_runs || []).find((c) => c.name === ctx.cfg.ciCheck) : null;
    if (ci) lastRunId = runIdFrom(ci.details_url || ci.html_url) || lastRunId;
    if (ci && ci.status === 'completed') {
      if (ci.conclusion === 'success') return { ok: true };
      const runId = runIdFrom(ci.details_url || ci.html_url);
      if (!runId) return { ok: false, kind: 'red', text: `${ctx.cfg.ciCheck} on ${sha} concluded ${ci.conclusion}` };
      const d = diagnoseRun(ctx, runId, `base-${sha.slice(0, 7)}`);
      if (d.kind === 'starved' && reruns < 3) {
        reruns++;
        ctx.proc.ghTry('run', 'rerun', String(runId), '--repo', ctx.cfg.repo);
        await sleep(pollMs(ctx) * 2);
        continue;
      }
      return { ok: false, ...d };
    }
    if (Date.now() > deadline) {
      if (timeouts === 0 && lastRunId) {
        timeouts++;
        ctx.log(`base CI on ${sha.slice(0, 7)} did not finish in time — re-running once`);
        ctx.proc.ghTry('run', 'rerun', String(lastRunId), '--repo', ctx.cfg.repo);
        deadline = ciDeadline(ctx);
        continue;
      }
      return { ok: false, kind: 'timeout', text: `${ctx.cfg.ciCheck} on ${ctx.cfg.base} ${sha.slice(0, 7)} gave no verdict within ${ctx.cfg.timeouts.ciMin} min${timeouts ? ', twice' : ''}` };
    }
    await sleep(pollMs(ctx));
  }
}

const stripJsComments = (t) => String(t || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const THRESHOLD = /\b(lines|functions|branches|statements)\s*:\s*(\d+(?:\.\d+)?)/g;

/** Threshold numbers in a Vitest config, comments ignored. With several blocks, the lowest per key. */
export function coverageThresholds(text) {
  const out = {};
  for (const block of stripJsComments(text).matchAll(/thresholds\s*:\s*\{([\s\S]*?)\}/g)) {
    for (const m of block[1].matchAll(THRESHOLD)) out[m[1]] = Math.min(out[m[1]] ?? Infinity, Number(m[2]));
  }
  return out;
}

/** A Vitest config with its threshold numbers blanked: the only change a PR may make is raising them. */
const vitestShape = (text) => stripJsComments(text).replace(THRESHOLD, '$1: N').replace(/\s+/g, ' ').trim();

/**
 * Files CI runs through. A PR that changes them could switch a gate off and still be green, so the
 * loop may not change them: package.json "scripts" (dependencies may change), the repo scripts,
 * and the test, lint and type configs. The Vitest config may change only by raising thresholds.
 */
export const GATE_FILES = ['scripts/**', 'playwright.config.*', 'eslint.config.*', 'tsconfig.json', '.prettierrc*', '.prettierignore'];
const VITEST_CONFIGS = ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js'];

function gateProblems(proc, cfg, branch, changes) {
  const problems = [];
  const show = (ref, f) => proc.gitTry('show', `${ref}:${f}`);
  for (const { status, files } of changes) {
    for (const file of files) {
      if (matchesAny(file, cfg.guard?.gateFiles || GATE_FILES)) problems.push(`\`${file}\` (${status}): CI runs through it, so the loop may not change it. Ask for the change in owner_actions, or ship it as a patch in loop/patches/.`);
      if (VITEST_CONFIGS.includes(file) && !status.startsWith('M')) problems.push(`\`${file}\` (${status}): the coverage config may not be added, removed or renamed by the loop.`);
    }
  }
  const pkgBefore = show(`origin/${cfg.base}`, 'package.json');
  const pkgAfter = show(branch, 'package.json');
  if (pkgBefore.ok) {
    let a = null;
    let b = null;
    try {
      a = JSON.parse(pkgBefore.out).scripts || {};
      b = pkgAfter.ok ? JSON.parse(pkgAfter.out).scripts || {} : null;
    } catch {
      problems.push('package.json: not valid JSON on the branch.');
    }
    if (a && JSON.stringify(a) !== JSON.stringify(b)) problems.push('package.json: the "scripts" changed. CI runs every gate through them, so the loop may not change them (dependencies may change).');
  }
  for (const f of VITEST_CONFIGS) {
    const before = show(`origin/${cfg.base}`, f);
    if (!before.ok) continue;
    const after = show(branch, f);
    if (!after.ok) continue; // reported above as removed or renamed
    if (vitestShape(before.out) !== vitestShape(after.out)) problems.push(`${f}: only the coverage threshold numbers may change, and only upwards.`);
    const a = coverageThresholds(before.out);
    const b = coverageThresholds(after.out);
    for (const [k, v] of Object.entries(a)) if (!(b[k] >= v)) problems.push(`${f}: coverage threshold ${k} went from ${v} to ${b[k] ?? 'removed'} — the ratchet only goes up. Add tests instead.`);
  }
  return problems;
}

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

/** Squash-merge the reviewed head. {ok:true, sha, baseBefore} | {ok:false, kind, text} */
export function mergePr(ctx, s) {
  const { proc, cfg } = ctx;
  const v = prView(ctx, s.pr);
  if (v.state === 'MERGED') return { ok: true, sha: v.mergeCommit?.oid, baseBefore: s.baseBefore };
  if (v.state !== 'OPEN') return { ok: false, kind: 'closed', text: `PR #${s.pr} is ${v.state}` };
  if (v.baseRefName !== cfg.base) return { ok: false, kind: 'base', text: `PR #${s.pr} targets ${v.baseRefName}, not ${cfg.base}` };
  if (v.headRefOid !== s.reviewedSha) return { ok: false, kind: 'moved', text: 'the branch changed after review' };
  if (v.mergeStateStatus === 'DIRTY') return { ok: false, kind: 'conflict' };
  const ci = (v.statusCheckRollup || []).find((c) => c.__typename === 'CheckRun' && c.name === cfg.ciCheck);
  if (!ci || ci.conclusion !== 'SUCCESS') return { ok: false, kind: 'ci', text: `\`${cfg.ciCheck}\` is not green on the head commit` };
  proc.git('fetch', 'origin', '--prune');
  // L-01 again at the last moment: CI and the review saw the branch on top of this base, not an older one.
  if (!proc.gitTry('merge-base', '--is-ancestor', `origin/${cfg.base}`, `origin/${s.branch}`).ok) return { ok: false, kind: 'behind', text: `\`${cfg.base}\` moved after CI and review` };
  const baseBefore = proc.git('rev-parse', `origin/${cfg.base}`);
  s.baseBefore = baseBefore;
  const m = proc.ghTry('pr', 'merge', String(s.pr), '--repo', cfg.repo, '--squash', '--delete-branch', '--match-head-commit', s.reviewedSha);
  const after = prView(ctx, s.pr);
  if (after.state !== 'MERGED') return { ok: false, kind: 'merge-failed', text: m.err || m.out };
  return { ok: true, sha: after.mergeCommit?.oid, baseBefore };
}

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
  if (!mergeSha) return { ok: false, why: 'GitHub reported no merge commit' };
  proc.git('fetch', 'origin', '--prune');
  if (!proc.gitTry('merge-base', '--is-ancestor', mergeSha, `origin/${cfg.base}`).ok) return { ok: false, why: `merge commit ${mergeSha.slice(0, 7)} is not on origin/${cfg.base}` };
  const parent = proc.gitTry('rev-parse', `${mergeSha}^`);
  if (!parent.ok) return { ok: false, why: `merge commit ${mergeSha.slice(0, 7)} has no parent` };
  // The usual case: the branch contained the base (L-01) and the base did not move, so the squash
  // result must be the reviewed tree exactly, whitespace included.
  if (baseBefore && parent.out === baseBefore && proc.gitTry('merge-base', '--is-ancestor', baseBefore, reviewedSha).ok) {
    const tree = (rev) => proc.gitTry('rev-parse', `${rev}^{tree}`).out;
    if (tree(mergeSha) === tree(reviewedSha)) return { ok: true, why: '' };
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
