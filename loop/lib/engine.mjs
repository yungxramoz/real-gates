// The item engine: one backlog item from build to verified-on-base, as a resumable state machine.
//
//   build → ci → review → merge → landed → baseci → postmerge → done
//                                    └────────┴─────────┴──→ hold (run stops, re-verified on resume)
//
// Every transition is saved, so a crash or reboot resumes in the same phase.

import fs from 'node:fs';
import path from 'node:path';

import { HELD_PHASE, readJson } from './state.mjs';
import { runClaude } from './claude.mjs';
import { landedCheck, mergePr, preMergeChecks, prView, waitForCommitCi, waitForPrCi } from './github.mjs';
import { postMergeAdapter } from '../adapters/index.mjs';
import { recordFailure, reviewSignatures, REVIEW_CATEGORIES } from './learn.mjs';
import { REVIEW_SCHEMA } from './schemas.mjs';

const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);
const NEXT_AFTER_HOLD = { landed: 'baseci', baseci: 'postmerge', postmerge: 'finish', 'outside-merge': 'rebuild' };
const RECHECKABLE = new Set(['landed', 'baseci', 'postmerge']);

export function goalPrompt(L, condition) {
  return L.cfg.useGoal ? `/goal ${condition} Stop after ${L.cfg.goalMaxTurns} turns.` : condition;
}

// ------------------------------------------------------------------------------------- failures
/** Count a failure; queue the LEARN item it produces, first in line. */
export function countFailure(L, signature, detail, item) {
  const learn = recordFailure(L.store.S, { signature, detail, item, threshold: L.cfg.learnThreshold });
  if (learn && L.store.addExtra(learn)) L.progress(`${item?.id || '-'} · "${signature}" keeps recurring → ${learn.id} queued first in line`);
  L.store.save();
}

/** Guard blocks a session caused, read from the guard log since `offset`. */
export function countGuardBlocks(L, item, offset) {
  let text = '';
  try {
    const buf = fs.readFileSync(L.paths.guardLog);
    text = buf.subarray(offset).toString('utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length >= 5 && f[1] === item.id) countFailure(L, `guard:${f[3]}`, f[4], item);
  }
}
const guardOffset = (L) => {
  try {
    return fs.statSync(L.paths.guardLog).size;
  } catch {
    return 0;
  }
};

// ----------------------------------------------------------------------------------- sessions
function readResult(L, item) {
  const r = readJson(L.paths.result, null);
  if (!r || typeof r !== 'object') return null;
  if (r.item && r.item !== item.id) return null;
  if (!['ready', 'partial', 'blocked', 'failed'].includes(r.outcome)) return null;
  return r;
}

function fixContextText(L, fix) {
  if (!fix) return '';
  const head = '## Fix round — read this first\n\nThe PR for this item already exists. Do **not** open a new one: check out its branch, fix what is described below, re-run the local gates, push to the same branch, and return `ready` with the same PR number.\n\n';
  if (fix.kind === 'red') return head + `**CI is red** on PR #${fix.pr}. Failed jobs: ${(fix.jobs || []).join(', ') || 'see log'}. The failing log (tail) is in \`${path.relative(L.root, fix.file || '').replace(/\\/g, '/')}\`. Read it, find the root cause and fix it properly. Never weaken a test or a gate to get green.`;
  if (fix.kind === 'conflict') return head + `PR #${fix.pr} has **merge conflicts** with \`${L.cfg.base}\`. Merge \`origin/${L.cfg.base}\` into the branch (no rebase, no force-push), resolve, re-run the gates, push.`;
  if (fix.kind === 'review') return head + `The **independent reviewer requested changes** (round ${fix.round}). Fix every blocking finding; non-blocking ones only if trivial.\n\n\`\`\`json\n${JSON.stringify(fix.review, null, 2)}\n\`\`\``;
  return head + (fix.text || 'See the loop log.');
}

async function buildSession(L, item, s, fix) {
  fs.rmSync(L.paths.result, { force: true });
  const mode = fix ? 'fix' : s.partials > 0 ? 'continue' : 'build';
  const slug = item.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const { base } = L.cfg;
  const vars = {
    ITERATION: L.store.S.iterations + 1,
    ITEM_ID: item.id,
    MODE: mode,
    ROUND: s.rounds,
    ATTEMPT: s.attempts + 1,
    BASE: base,
    PRODUCTION: L.cfg.production,
    MIN_SCORE: L.cfg.review.minDesignScore,
    ITEM_JSON: JSON.stringify(item, null, 2),
    NOTES: [s.notes.length ? `## Earlier sessions on this item\n\n${s.notes.map((n) => `- ${n}`).join('\n')}` : '', s.lastError && !fix ? `## Why the last attempt failed\n\n${s.lastError}` : ''].filter(Boolean).join('\n\n'),
    FIX_CONTEXT: fixContextText(L, fix),
    PROGRESS_TAIL: L.progressTail(40),
    BRANCH_INSTRUCTION: fix
      ? `Fix mode: \`git fetch origin && git checkout ${s.branch} && git merge --ff-only origin/${s.branch}\`.`
      : `\`git fetch origin && git checkout -b <type>/${slug}-<short-topic> origin/${base}\` (type: feat, fix, chore, docs, test, design). If a branch for this item from an earlier failed attempt exists remotely and is useful, you may continue it instead, merging \`origin/${base}\` in first.`,
    PR_INSTRUCTION: fix ? `PR #${s.pr} already exists: push to it, do not open another.` : '',
  };
  vars.LEARN = item.kind === 'learn' ? L.render('learn.md', vars) : item.kind === 'fix' && /^ACC-/.test(item.id) ? '## This is an acceptance fix\n\nFix what the evaluator found **and** the cause: add the test, check, lesson or project guard rule that would have caught it before acceptance (see `loop/prompts/learn.md` for the ladder).' : '';
  fs.writeFileSync(L.paths.task, L.render('build.md', vars));
  const condition = `Complete the unattended task in .loop/current-task.md for backlog item ${item.id} (read that file fully first and follow it). The goal is met only when .loop/result.json exists with "item": "${item.id}", its outcome is one of ready, partial, blocked or failed exactly as that file defines them, an open PR against ${base} exists for ready or partial, and you have printed the file with cat as your last step.`;
  L.setStatus(`build:${mode}`, item, { round: s.rounds });
  if (L.args.dry) {
    L.log(`[dry-run] would run a build session for ${item.id}; task file written to .loop/current-task.md`);
    return { result: null, dry: true };
  }
  const off = guardOffset(L);
  const run = await runClaude(L.session, { prompt: goalPrompt(L, condition), phase: 'build', item, timeoutMin: L.cfg.timeouts.sessionMin, model: L.cfg.model });
  L.checkIsolation(run);
  countGuardBlocks(L, item, off);
  if (run.gaveUp) return { result: null, gaveUp: true };
  return { result: readResult(L, item), run };
}

function reviewBody(v) {
  const lines = [`**Loop review: ${v.verdict}**`, '', v.summary || ''];
  if (v.blocking?.length) lines.push('', '**Blocking**', ...v.blocking.map((b) => `- \`${b.file}${b.line ? `:${b.line}` : ''}\` [${b.category}] ${b.issue} → ${b.fix}`));
  if (v.non_blocking?.length) lines.push('', '**Non-blocking**', ...v.non_blocking.map((n) => `- ${n}`));
  if (v.scores && Object.keys(v.scores).length) lines.push('', `Scores: ${Object.entries(v.scores).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  return lines.join('\n');
}

async function reviewSession(L, item, s) {
  fs.writeFileSync(L.paths.task, L.render('review.md', {
    ITEM_ID: item.id,
    PR: s.pr,
    BRANCH: s.branch,
    HEAD_SHA: s.ciSha,
    BASE: L.cfg.base,
    MIN_SCORE: L.cfg.review.minDesignScore,
    CATEGORIES: REVIEW_CATEGORIES.join(', '),
    REVIEW_ROUND: s.reviewRounds + 1,
    ITEM_JSON: JSON.stringify(item, null, 2),
    NOTES: s.notes.length ? `Earlier sessions on this item:\n${s.notes.map((n) => `- ${n}`).join('\n')}` : '',
    PREVIOUS_REVIEW: s.lastReview ? `## Your previous round's findings\n\n\`\`\`json\n${JSON.stringify(s.lastReview, null, 2)}\n\`\`\`` : '',
  }));
  L.setStatus('review', item, { pr: s.pr, round: s.reviewRounds + 1 });
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    const off = guardOffset(L);
    const r = await runClaude(L.session, { prompt: 'Review the pull request described in .loop/current-task.md (read it fully first) and return your verdict as the structured output.', phase: 'review', item, timeoutMin: L.cfg.timeouts.reviewMin, model: L.cfg.reviewModel || L.cfg.model, schema: REVIEW_SCHEMA });
    L.checkIsolation(r);
    countGuardBlocks(L, item, off);
    if (r.gaveUp) return null;
    const v = r.structured;
    if (v && (v.verdict === 'approve' || v.verdict === 'changes')) {
      v.blocking = Array.isArray(v.blocking) ? v.blocking : [];
      const low = Object.entries(v.scores || {}).filter(([, n]) => typeof n === 'number' && n < L.cfg.review.minDesignScore);
      if (item.ui && low.length) {
        for (const [k, n] of low) if (!v.blocking.some((b) => String(b.issue || '').includes(k))) v.blocking.push({ file: '(design)', issue: `${k} scored ${n} < ${L.cfg.review.minDesignScore}`, fix: v.design || 'raise it to the DESIGN.md bar', category: 'design' });
      }
      if (item.ui && !Object.keys(v.scores || {}).length) v.blocking.push({ file: '(design)', issue: 'a UI item was reviewed without design scores', fix: 'score design quality, originality, craft and functionality', category: 'design' });
      if (v.blocking.length) v.verdict = 'changes';
      try {
        const body = path.join(path.dirname(L.paths.result), 'review-body.md');
        fs.writeFileSync(body, reviewBody(v));
        L.proc.ghTry('pr', 'review', String(s.pr), '--repo', L.cfg.repo, '--comment', '--body-file', body);
      } catch {}
      return v;
    }
    L.log('reviewer returned no structured verdict — retrying once');
  }
  return null;
}

// --------------------------------------------------------------------------------- extra items
export function addFollowup(L, item, f) {
  const S = L.store.S;
  const count = S.extra.filter((e) => e.kind === 'followup').length;
  if (count >= L.cfg.maxFollowups || !f?.title) return;
  const id = `FUP-${count + 1}`;
  const milestone = L.backlog.milestones.includes(f.milestone) ? f.milestone : item.milestone;
  L.store.addExtra({ kind: 'followup', id, milestone, title: short(f.title, 120), scope: short(f.scope || f.title, 800), refs: [`raised by ${item.id}`], ui: true, dependsOn: [item.id] });
  L.progress(`${item.id} · follow-up ${id} queued (${milestone}): ${short(f.title, 120)}`);
}

function addFixItem(L, item, sha, dev) {
  L.store.addExtra({
    kind: 'fix',
    id: `FIX-${sha.slice(0, 7)}`,
    milestone: item.milestone,
    title: `Make ${L.cfg.base} green again after ${item.id}`,
    scope: `CI on ${L.cfg.base} failed on ${sha} after merging ${item.id}. Failed jobs: ${(dev.jobs || []).join(', ')}. Log tail: ${dev.file ? path.relative(L.root, dev.file).replace(/\\/g, '/') : dev.text}. Fix forward in a PR; never weaken a gate.`,
    refs: ['docs/LESSONS.md'],
    ui: false,
    dependsOn: [],
  });
}

// --------------------------------------------------------------------------------- the engine
export async function runItem(L, item) {
  const s = L.store.st(item.id);
  const save = () => L.store.save();
  if (s.status === 'todo') s.status = 'in_progress';
  save();
  let fix = s.pendingFix || null;

  const finish = (status, why) => {
    Object.assign(s, { status, pendingFix: null, finishedAt: new Date().toISOString() });
    if (why) s.lastError = why;
    save();
    L.progress(`${item.id} · **${status}**${why ? ` — ${why}` : ''}`);
    return status;
  };
  const outsideMergeAsk = (it, pr) =>
    `${it.id}: PR #${pr} was merged by something other than the runner, before CI and review finished. The change is on ${L.cfg.base} unreviewed. Inspect it (gh pr view ${pr}), revert it if needed, then release the item so it is rebuilt through the gates: node loop/run.mjs --release ${it.id}`;
  const hold = (kind, why, ownerAction) => {
    Object.assign(s, { phase: HELD_PHASE, hold: { kind, why, at: new Date().toISOString() }, lastError: `held (${kind}): ${why}` });
    save();
    L.ownerAction(item.id, ownerAction || `${item.id} is held (${kind}): ${why}. Fix it, then re-run the loop; it verifies again before it moves on. Where it cannot verify, release it with: node loop/run.mjs --release ${item.id}`);
    L.progress(`${item.id} · **held** (${kind}) — ${why}`);
    return 'held';
  };

  for (;;) {
    if (L.stopRequested()) return 'stopped';
    if (L.budgetExceeded()) return 'budget';

    if (s.phase === HELD_PHASE) {
      if (s.released) {
        L.progress(`${item.id} · released by the owner (${s.released}) from hold: ${s.hold?.kind}`);
        s.phase = NEXT_AFTER_HOLD[s.hold?.kind] || 'finish';
        delete s.released;
      } else if (RECHECKABLE.has(s.hold?.kind)) s.phase = s.hold.kind; // verify again
      else return 'held'; // only the owner can clear this one (--release)
      if (s.phase === 'rebuild') Object.assign(s, { phase: 'build', pr: null, branch: null, pendingFix: null, hold: null });
      save();
    }

    if (s.phase === 'build') {
      if (s.rounds >= L.cfg.maxRoundsPerItem) return finish('needs_human', `${s.rounds} build rounds without a merge — PR ${s.pr ? '#' + s.pr : 'none'} left open`);
      s.rounds++;
      save();
      const { result: r, gaveUp, dry, run } = await buildSession(L, item, s, fix);
      if (dry) return 'dry';
      if (gaveUp) return 'stopped';
      fix = null;
      s.pendingFix = null;
      if (!r) {
        s.attempts++;
        s.lastError = `The session ended without a valid .loop/result.json${run?.timedOut ? ' (it timed out)' : ''}. Log: ${run ? path.relative(L.root, run.log) : '?'}`;
        L.progress(`${item.id} · build round ${s.rounds} produced no result (attempt ${s.attempts}/${L.cfg.maxAttemptsPerItem})`);
        if (s.attempts >= L.cfg.maxAttemptsPerItem) return finish('failed', s.lastError);
        if (s.pr && prView(L, s.pr).state === 'OPEN') s.phase = 'ci';
        save();
        continue;
      }
      if (r.handoff) s.notes.push(`round ${s.rounds}: ${short(r.handoff, 600)}`);
      for (const a of r.owner_actions || []) L.ownerAction(item.id, a);
      L.progress(`${item.id} · build round ${s.rounds} → ${r.outcome}${r.pr ? ` PR #${r.pr}` : ''} — ${short(r.summary || '', 300)}`);
      for (const f of (r.followups || []).slice(0, 3)) addFollowup(L, item, f);
      if (r.outcome === 'blocked') return finish('blocked', short(r.summary || 'blocked on the owner', 400));
      if (r.outcome === 'failed') {
        s.attempts++;
        s.lastError = short(`${r.summary || ''} ${r.handoff || ''}`, 1500);
        if (s.attempts >= L.cfg.maxAttemptsPerItem) return finish('failed', s.lastError);
        save();
        continue;
      }
      // ready | partial: check the PR really is what the agent says it is
      let v = null;
      try {
        v = r.pr ? prView(L, r.pr) : null;
      } catch {}
      if (v && v.state === 'MERGED' && v.baseRefName === L.cfg.base) {
        // Merged during the build session itself: the change is on the base unreviewed. Never retry on top of it.
        Object.assign(s, { pr: v.number, branch: v.headRefName });
        return hold('outside-merge', `PR #${v.number} was already merged when the build session ended`, outsideMergeAsk(item, v.number));
      }
      if (!v || v.state !== 'OPEN' || v.baseRefName !== L.cfg.base || [L.cfg.base, L.cfg.production].includes(v.headRefName)) {
        s.attempts++;
        s.lastError = `result.json claimed ${r.outcome} with PR ${r.pr}, but no open PR from a feature branch into ${L.cfg.base} was found.`;
        L.progress(`${item.id} · ${s.lastError}`);
        if (s.attempts >= L.cfg.maxAttemptsPerItem) return finish('failed', s.lastError);
        save();
        continue;
      }
      Object.assign(s, { pr: v.number, branch: v.headRefName, isPartial: r.outcome === 'partial', remaining: r.remaining || '', summary: r.summary || '', phase: 'ci' });
      save();
    }

    if (s.phase === 'ci') {
      L.log(`… waiting for CI on PR #${s.pr}`);
      L.setStatus('ci', item, { pr: s.pr });
      const ci = await waitForPrCi(L, s.pr);
      if (ci.kind === 'stopped') return 'stopped';
      if (!ci.ok) {
        if (ci.kind === 'merged') {
          return hold('outside-merge', ci.text, outsideMergeAsk(item, s.pr));
        }
        if (ci.kind === 'closed') {
          Object.assign(s, { pr: null, phase: 'build', lastError: ci.text });
          save();
          continue;
        }
        s.ciFixes++;
        for (const j of ci.jobs || []) countFailure(L, `ci:${j}`, `PR #${s.pr}`, item);
        L.progress(`${item.id} · CI on PR #${s.pr}: ${ci.kind}${ci.jobs ? ` (${ci.jobs.join(', ')})` : ''} — fix ${s.ciFixes}/${L.cfg.maxCiFixes}`);
        if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', `CI still not green on PR #${s.pr} after ${L.cfg.maxCiFixes} fix rounds`);
        fix = { ...ci, pr: s.pr };
        Object.assign(s, { pendingFix: fix, phase: 'build' });
        save();
        continue;
      }
      const pre = preMergeChecks(L, s);
      if (!pre.ok) {
        s.ciFixes++;
        countFailure(L, 'premerge', short(pre.text, 300), item);
        L.progress(`${item.id} · pre-merge checks failed on PR #${s.pr} — fix ${s.ciFixes}/${L.cfg.maxCiFixes}`);
        if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', pre.text);
        fix = { kind: 'premerge', text: pre.text, pr: s.pr };
        Object.assign(s, { pendingFix: fix, phase: 'build' });
        save();
        continue;
      }
      Object.assign(s, { ciSha: ci.sha, phase: 'review' });
      save();
    }

    if (s.phase === 'review') {
      const rv = await reviewSession(L, item, s);
      if (!rv) {
        if (L.stopRequested() || L.budgetExceeded()) return 'stopped';
        return finish('needs_human', `the reviewer gave no verdict on PR #${s.pr}`);
      }
      s.lastReview = rv;
      L.progress(`${item.id} · review round ${s.reviewRounds + 1} on PR #${s.pr}: **${rv.verdict}**${rv.blocking?.length ? ` (${rv.blocking.length} blocking)` : ''} — ${short(rv.summary || '', 250)}`);
      if (rv.verdict !== 'approve') {
        for (const sig of reviewSignatures(rv)) countFailure(L, sig, rv.blocking.filter((b) => `review:${b.category}` === sig || sig === 'review:other').map((b) => b.issue).join('; '), item);
        s.reviewRounds++;
        if (s.reviewRounds > L.cfg.review.maxRounds) return finish('needs_human', `review did not converge on PR #${s.pr}: ${short(JSON.stringify(rv.blocking), 600)}`);
        fix = { kind: 'review', review: rv, round: s.reviewRounds, pr: s.pr };
        Object.assign(s, { pendingFix: fix, phase: 'build' });
        save();
        continue;
      }
      // the reviewer reviewed s.ciSha; make sure nothing moved underneath it
      if (prView(L, s.pr).headRefOid !== s.ciSha) {
        s.phase = 'ci';
        save();
        continue;
      }
      Object.assign(s, { reviewedSha: s.ciSha, phase: 'merge' });
      save();
    }

    if (['merge', 'landed', 'baseci', 'postmerge'].includes(s.phase) && L.stopRequested()) return 'stopped';

    if (s.phase === 'merge') {
      L.setStatus('merge', item, { pr: s.pr });
      const m = mergePr(L, s);
      if (!m.ok) {
        L.progress(`${item.id} · merge of PR #${s.pr} refused: ${m.kind} ${m.text || ''}`);
        if (m.kind === 'behind') {
          s.ciFixes++;
          if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', `could not merge PR #${s.pr}: ${L.cfg.base} kept moving`);
          fix = { kind: 'premerge', text: `\`${L.cfg.base}\` moved after CI and review. Merge \`origin/${L.cfg.base}\` into \`${s.branch}\` (no rebase, no force-push), re-run the local gates and push (L-01).`, pr: s.pr };
          Object.assign(s, { pendingFix: fix, phase: 'build' });
          save();
          continue;
        }
        if (['conflict', 'moved', 'ci'].includes(m.kind)) {
          s.ciFixes++;
          if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', `could not merge PR #${s.pr}: ${m.kind}`);
          if (m.kind === 'conflict') {
            fix = { kind: 'conflict', pr: s.pr };
            Object.assign(s, { pendingFix: fix, phase: 'build' });
          } else s.phase = 'ci';
          save();
          continue;
        }
        return finish('needs_human', `could not merge PR #${s.pr}: ${m.kind} ${m.text || ''}`);
      }
      Object.assign(s, { mergeSha: m.sha, baseBefore: m.baseBefore || s.baseBefore, phase: 'landed' });
      s.prs.push(s.pr);
      L.store.S.baseHead = m.sha; // the only way the base may move during a run
      L.progress(`${item.id} · merged PR #${s.pr} → ${L.cfg.base} ${String(m.sha).slice(0, 7)}`);
      save();
    }

    if (s.phase === 'landed') {
      L.setStatus('landed', item, { sha: s.mergeSha });
      const lc = landedCheck(L, { baseBefore: s.baseBefore, reviewedSha: s.reviewedSha, mergeSha: s.mergeSha });
      if (!lc.ok) return hold('landed', `PR #${s.pr}: ${lc.why}`, `${item.id}: what landed on ${L.cfg.base} with PR #${s.pr} (${String(s.mergeSha).slice(0, 7)}) is not what the reviewer approved (${lc.why}). Inspect it with git show ${String(s.mergeSha).slice(0, 7)}. Revert or fix it on ${L.cfg.base}, then release the item: node loop/run.mjs --release ${item.id}`);
      L.syncBase();
      s.phase = 'baseci';
      save();
    }

    if (s.phase === 'baseci') {
      L.setStatus('baseci', item, { sha: s.mergeSha });
      const dev = await waitForCommitCi(L, s.mergeSha);
      if (dev.kind === 'stopped') return 'stopped';
      if (!dev.ok && dev.kind === 'timeout') return hold('baseci', dev.text, `${item.id}: CI on ${L.cfg.base} never finished for ${String(s.mergeSha).slice(0, 7)} (${dev.text}). Check GitHub Actions (quota, runners, a stuck job). Re-run the loop once CI reports; it checks again. To accept the commit without a CI verdict: node loop/run.mjs --release ${item.id}`);
      if (!dev.ok) {
        addFixItem(L, item, s.mergeSha, dev);
        L.progress(`${item.id} · ${L.cfg.base} CI is RED after merging PR #${s.pr} — queued a fix item first in line`);
      }
      s.phase = 'postmerge';
      save();
    }

    if (s.phase === 'postmerge') {
      if (L.args.dry) return 'dry';
      L.setStatus('postmerge', item, { sha: s.mergeSha });
      L.syncBase();
      for (const step of L.cfg.postMerge || []) {
        const res = postMergeAdapter(step.adapter).run({ ...L, env: L.envBase }, { mergeSha: s.mergeSha, item, step });
        if (!res.ok) {
          if (step.holdOnUnverified === false) {
            L.ownerAction(item.id, res.ownerAction || res.why);
            L.progress(`${item.id} · post-merge ${step.adapter} not verified (not holding, holdOnUnverified is off): ${res.why}`);
            continue;
          }
          return hold('postmerge', `${step.adapter}: ${res.why}`, res.ownerAction);
        }
        L.progress(`${item.id} · post-merge ${step.adapter}: ${res.note || 'ok'}`);
      }
      s.phase = 'finish';
      save();
    }

    if (s.phase === 'finish') {
      const wasPartial = s.isPartial;
      Object.assign(s, { pr: null, branch: null, ciSha: null, reviewedSha: null, lastReview: null, ciFixes: 0, reviewRounds: 0, pendingFix: null, hold: null, mergeSha: null, baseBefore: null, phase: 'build' });
      if (wasPartial) {
        s.partials++;
        s.notes.push(`merged slice: ${short(s.summary, 300)} — remaining: ${short(s.remaining, 800)}`);
        if (s.partials >= L.cfg.maxPartialsPerItem) return finish('needs_human', `still partial after ${s.partials} merged slices — remaining: ${short(s.remaining, 400)}`);
        s.status = 'todo';
        save();
        return 'partial';
      }
      return finish('done');
    }
  }
}
