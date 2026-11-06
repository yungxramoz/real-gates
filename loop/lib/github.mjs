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
  fs.writeFileSync(file, `Failed jobs: ${failed.map((j) => j.name).join(', ') || '(none reported)'}\n\n${text}`);
  return { kind: 'red', runId, file, jobs: failed.map((j) => j.name) };
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

/** Numbers in a `thresholds: { … }` block of a Vitest config, for the coverage ratchet check. */
export function coverageThresholds(text) {
  const block = String(text || '').match(/thresholds\s*:\s*\{([\s\S]*?)\}/);
  if (!block) return {};
  return Object.fromEntries([...block[1].matchAll(/(lines|functions|branches|statements)\s*:\s*(\d+(?:\.\d+)?)/g)].map((m) => [m[1], Number(m[2])]));
}

/** Structural checks the reviewer should never have to catch. {ok} | {ok:false, text} */
export function preMergeChecks(ctx, s) {
  const { proc, cfg } = ctx;
  proc.git('fetch', 'origin', '--prune');
  const branch = `origin/${s.branch}`;
  if (!proc.gitTry('merge-base', '--is-ancestor', `origin/${cfg.base}`, branch).ok) {
    return { ok: false, text: `\`${cfg.base}\` has moved since this branch was cut. Merge \`origin/${cfg.base}\` into \`${s.branch}\` (no rebase, no force-push), resolve conflicts, re-run the local gates and push. CI must run on what will actually land (L-01).` };
  }
  const changes = proc.git('diff', '--name-status', `origin/${cfg.base}...${branch}`).split('\n').filter(Boolean);
  const migrationDirs = (cfg.postMerge || []).map((x) => x.migrationsDir).filter(Boolean);
  const guardCtx = { cfg, isOnBase: (rel) => proc.gitTry('cat-file', '-e', `origin/${cfg.base}:${rel}`).ok };
  const problems = [];
  for (const line of changes) {
    const [status, ...rest] = line.split('\t');
    const files = rest.map((f) => f.replace(/\\/g, '/'));
    for (const file of files) {
      if (migrationDirs.some((d) => file.startsWith(d.replace(/\/$/, '') + '/')) && /\.sql$/.test(file) && !status.startsWith('A')) problems.push(`\`${file}\` (${status}): migrations already on ${cfg.base} are frozen — revert this change and fix forward with a new file.`);
      if (/(^|\/)\.env($|\.(?!example$))/.test(file)) problems.push(`\`${file}\`: env files must never be committed.`);
      else if (/^\.loop\//.test(file)) problems.push(`\`${file}\`: loop runtime files must not be committed.`);
      else if (isProtected(file, guardCtx) || (matchesAny(file, ['loop/patches/*']) && !status.startsWith('A'))) problems.push(`\`${file}\` (${status}): part of the harness or the owner's. A runner change ships as a new file in loop/patches/.`);
    }
  }
  // The coverage ratchet only goes up.
  for (const cfgFile of ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs']) {
    const before = proc.gitTry('show', `origin/${cfg.base}:${cfgFile}`);
    const after = proc.gitTry('show', `${branch}:${cfgFile}`);
    if (!before.ok || !after.ok) continue;
    const a = coverageThresholds(before.out);
    const b = coverageThresholds(after.out);
    for (const [k, v] of Object.entries(a)) if (!(b[k] >= v)) problems.push(`${cfgFile}: coverage threshold ${k} went from ${v} to ${b[k] ?? 'removed'} — the ratchet only goes up. Add tests instead.`);
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
