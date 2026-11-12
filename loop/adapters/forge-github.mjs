// Forge adapter: GitHub, through the `gh` CLI. Pull requests, CI results and the merge.
//
// The forge interface (what the engine calls; another forge implements the same functions):
//   name, guardPack
//   preflightProblems(ctx)            -> [sentence]              login and branch protection
//   prView(ctx, pr)                   -> { number, state: 'OPEN' | 'MERGED' | 'CLOSED',
//                                          baseRefName, headRefName, headRefOid, mergeCommit: { oid } }
//   waitForPrCi(ctx, pr)              -> { ok: true, sha } | { ok: false, kind: red | conflict |
//                                          closed | merged | no-ci | timeout | stopped, jobs?, file?, text? }
//   waitForCommitCi(ctx, sha)         -> { ok: true } | { ok: false, kind: red | timeout | stopped, … }
//   checkCommitCi(ctx, sha)           -> { state: ok | pending | starved | red, runId?, … }  one look, no wait
//   rerunCi(ctx, runId)
//   mergePr(ctx, s)                   -> { ok: true, sha, baseBefore } | { ok: false, kind, text }
//   postReview(ctx, pr, bodyFile)     the reviewer's verdict as a PR comment
// ctx is the runner's L: { cfg, proc, paths, log, stopRequested }.
//
// Lessons behind the CI functions (docs/LESSONS.md, WHY.md):
//   L-02  A run cancelled with no runner assigned was starved, not red: re-run it. The same holds
//         for any run that was cancelled without a failed job (a newer push in the same
//         concurrency group, a person): it has no verdict, so it is asked for again.
//   A CI that never finishes is not a pass.
//   L-01  again at merge time: the branch must still contain the base.

import fs from 'node:fs';
import path from 'node:path';

export const name = 'github';
/** The guard pack that holds this forge's rules for sessions. */
export const guardPack = 'github';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What must be true before a run: logged in, and the base branch protected at the forge. */
export function preflightProblems(ctx) {
  const { proc, cfg } = ctx;
  if (!proc.ghTry('auth', 'status').ok) return ['gh is not logged in (`gh auth login`)'];
  // Nobody reviews the loop's PRs, so GitHub itself has to refuse a push to the base. The runner's
  // after-session check only notices one once it has happened.
  if (cfg.repo && cfg.guard?.requireBranchProtection !== false && !branchProtected(ctx, cfg.base)) {
    return [`${cfg.base} has no branch protection or ruleset on GitHub. Protect it: require a pull request and the "${cfg.ciCheck}" status check, no required approvals, no direct or force pushes (docs/OWNER-ACTIONS.md). If your GitHub plan does not offer protection for this repository, set guard.requireBranchProtection to false in loop/loop.config.json and accept that a stray push is only noticed afterwards.`];
  }
  return [];
}

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

export function postReview(ctx, pr, bodyFile) {
  return ctx.proc.ghTry('pr', 'review', String(pr), '--repo', ctx.cfg.repo, '--comment', '--body-file', bodyFile);
}

export function rerunCi(ctx, runId) {
  return ctx.proc.ghTry('run', 'rerun', String(runId), '--repo', ctx.cfg.repo);
}

export function runIdFrom(url) {
  const m = String(url || '').match(/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

/** What a completed-but-not-green CI run means (L-02). Writes the failing log to the logs dir. */
export function diagnoseRun(ctx, runId, tag) {
  const jobs = ctx.proc.ghJson('api', `repos/${ctx.cfg.repo}/actions/runs/${runId}/jobs?per_page=100`)?.jobs || [];
  const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
  // Cancelled and nothing failed: no check ran to a verdict, with or without a runner. Calling
  // that red would send a fix session (or queue a FIX item) after a failure that never happened.
  const cancelled = jobs.filter((j) => j.conclusion === 'cancelled');
  if (failed.length === 0 && cancelled.length > 0) return { kind: 'starved', runId };
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
        rerunCi(ctx, runId);
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
        rerunCi(ctx, runId);
        await sleep(pollMs(ctx) * 2);
        continue;
      }
      return { ok: false, ...d };
    }
    if (Date.now() > deadline) {
      if (timeouts === 0 && lastRunId) {
        timeouts++;
        ctx.log(`base CI on ${sha.slice(0, 7)} did not finish in time — re-running once`);
        rerunCi(ctx, lastRunId);
        deadline = ciDeadline(ctx);
        continue;
      }
      return { ok: false, kind: 'timeout', text: `${ctx.cfg.ciCheck} on ${ctx.cfg.base} ${sha.slice(0, 7)} gave no verdict within ${ctx.cfg.timeouts.ciMin} min${timeouts ? ', twice' : ''}` };
    }
    await sleep(pollMs(ctx));
  }
}

/**
 * One look at `ci` on a base commit, without waiting.
 * { state: 'ok' } | { state: 'pending' | 'starved', runId } | { state: 'red', kind, jobs?, file?, text? }
 */
export function checkCommitCi(ctx, sha) {
  const runs = ctx.proc.ghTry('api', `repos/${ctx.cfg.repo}/commits/${sha}/check-runs?per_page=100`);
  let ci = null;
  try {
    ci = runs.ok ? (JSON.parse(runs.out || '{}').check_runs || []).find((c) => c.name === ctx.cfg.ciCheck) : null;
  } catch {}
  const runId = ci ? runIdFrom(ci.details_url || ci.html_url) : null;
  if (!ci || ci.status !== 'completed') return { state: 'pending', runId };
  if (ci.conclusion === 'success') return { state: 'ok' };
  if (!runId) return { state: 'red', kind: 'red', text: `${ctx.cfg.ciCheck} on ${sha} concluded ${ci.conclusion}` };
  const d = diagnoseRun(ctx, runId, `base-${sha.slice(0, 7)}`);
  return d.kind === 'starved' ? { state: 'starved', runId } : { state: 'red', ...d };
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
