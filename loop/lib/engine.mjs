// The item engine: one backlog item from build to verified-on-base, as a resumable state machine.
//
//   build → gate → ci → review → merge → landed → baseci → postmerge → done
//                                    └────────┴─────────┴──→ hold (run stops, re-verified on resume)
//
// Every transition is saved, so a crash or reboot resumes in the same phase.

import fs from 'node:fs';
import path from 'node:path';

import { HELD_PHASE, readJson, TERMINAL } from './state.mjs';
import { runClaude } from './claude.mjs';
import { landedCheck, preMergeChecks } from './gates.mjs';
import { forgeAdapter, postMergeAdapter } from '../adapters/index.mjs';
import { isCoarse, knownCauses, noteItemEnded, recordFailure, reviewFailures, REVIEW_CATEGORIES } from './learn.mjs';
import { reviewSchema } from './schemas.mjs';
import { workType, workTypeName } from './worktypes.mjs';
import { runLocalGate } from './localgate.mjs';

const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);
const NEXT_AFTER_HOLD = { landed: 'baseci', baseci: 'postmerge', postmerge: 'finish', 'outside-merge': 'rebuild' };
const RECHECKABLE = new Set(['landed', 'baseci', 'postmerge']);
/** Pull requests, CI and the merge go through the forge adapter the config names. */
const forge = (L) => forgeAdapter(L.cfg.forge?.adapter);

export function goalPrompt(L, condition) {
  return L.cfg.useGoal ? `/goal ${condition} Stop after ${L.cfg.goalMaxTurns} turns.` : condition;
}

// ------------------------------------------------------------------------------------- failures
/**
 * Count a failure by its signal. When the signal has now shown up in enough different items, a
 * retro is called early (loop/lib/learn.mjs): a named cause, a red CI job or a failing gate at
 * learnThreshold, a bare review category or a guard rule at learnCategoryThreshold.
 */
export function countFailure(L, signature, detail, item, threshold = isCoarse(signature) ? L.cfg.learnCategoryThreshold : L.cfg.learnThreshold) {
  const called = recordFailure(L.store.S, { signature, detail, item, threshold });
  if (called) L.progress(`${item?.id || '-'} · "${signature}" showed up in ${threshold} items → a retro is called`);
  if (called) L.event('retro.called', { item: item?.id || null, signature });
  L.store.save();
  return called;
}

/** Count a review verdict's blocking findings, by category and by category with its cause. */
function countReviewFailures(L, rv, item) {
  for (const f of reviewFailures(rv)) countFailure(L, f.signature, f.issues.join('; '), item);
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
  // A rule counts once per session, however often it fired: the session was told no and went
  // another way, which is the guard working. (A LEARN item's blocks never call a retro.)
  const seen = new Set();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 5 || f[1] !== item.id || seen.has(f[3])) continue;
    seen.add(f[3]);
    countFailure(L, `guard:${f[3]}`, f[4], item);
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
  // CI and the reviewer run at the same time, so one round can carry both results.
  if (fix.kind === 'multi') return head + 'Fix **all** of the following in this one round.\n\n' + fix.parts.map((p) => fixContextText(L, p).slice(head.length)).join('\n\n');
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
    RETRO_ID: item.retro || 'R-00',
    MAX_LESSONS: L.cfg.retro?.maxLessons ?? 20,
  };
  vars.LEARN = item.kind === 'learn' ? L.render('learn.md', vars) : item.kind === 'fix' && /^ACC-/.test(item.id) ? '## This is an acceptance fix\n\nFix what the evaluator found **and** the cause: add the test, check, lesson or project guard rule that would have caught it before acceptance (see `loop/prompts/learn.md` for the rungs).' : '';
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

async function reviewSession(L, item, s, headSha) {
  const rubric = workType(L.cfg, item).rubric || [];
  fs.writeFileSync(L.paths.task, L.render('review.md', {
    RUBRIC: rubric.length ? rubric.map((r) => `\`${r}\``).join(', ') : '(none: this work type has no rubric, so leave `scores` out)',
    ITEM_ID: item.id,
    PR: s.pr,
    BRANCH: s.branch,
    HEAD_SHA: headSha,
    KNOWN_CAUSES: knownCauses(L.store.S).slice(0, 30).join(', ') || '(none yet)',
    BASE: L.cfg.base,
    MIN_SCORE: L.cfg.review.minDesignScore,
    CATEGORIES: REVIEW_CATEGORIES.join(', '),
    REVIEW_ROUND: s.reviewRounds + 1,
    ITEM_JSON: JSON.stringify(item, null, 2),
    // The reviewer is not briefed by the builder: no handoff notes. It only learns what it needs to
    // judge scope, marked as the builder's claim.
    NOTES: [
      s.partials > 0 ? `${s.partials} earlier slice(s) of this item are already merged into ${L.cfg.base}.` : '',
      s.isPartial ? `The builder declared this PR a **partial** slice. What it says remains (a claim to check, not a fact): ${short(s.remaining || '(nothing listed)', 800)}` : '',
      item.kind === 'learn'
        ? `This is a **LEARN item**: it carries out the action items of retro ${item.retro || '(see the item)'}. Its brief is \`.loop/retros/${item.retro || 'R-00'}.md\`, not acceptance criteria. Check against it: every action item is carried out at its rung and its proof runs; a new test fails when the mistake comes back; what a check retired is gone; the minutes in \`docs/retros/\` say word for word what the files in \`.loop/retros/\` say (a formatter may have realigned the tables, nothing else); \`docs/LESSONS.md\` stays within ${L.cfg.retro?.maxLessons ?? 20} rows and each new row states a general rule with the command that proves it. Blocking: a lesson that only teaches how to phrase work around the guard or the runner, and any change that loosens a check.`
        : '',
    ].filter(Boolean).join('\n\n'),
    PREVIOUS_REVIEW: s.lastReview ? `## Your previous round's findings\n\n\`\`\`json\n${JSON.stringify(s.lastReview, null, 2)}\n\`\`\`` : '',
  }, { variant: workTypeName(item) }));
  L.setStatus('review', item, { pr: s.pr, round: s.reviewRounds + 1 });
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    const off = guardOffset(L);
    const r = await runClaude(L.session, { prompt: 'Review the pull request described in .loop/current-task.md (read it fully first) and return your verdict as the structured output.', phase: 'review', item, timeoutMin: L.cfg.timeouts.reviewMin, model: L.cfg.reviewModel || L.cfg.model, schema: reviewSchema(rubric) });
    L.checkIsolation(r);
    countGuardBlocks(L, item, off);
    if (r.gaveUp) return null;
    const v = r.structured;
    if (v && (v.verdict === 'approve' || v.verdict === 'changes')) {
      v.blocking = Array.isArray(v.blocking) ? v.blocking : [];
      // The rubric is the work type's: every score must be there, and none below the bar.
      const scored = (k) => typeof v.scores?.[k] === 'number';
      for (const k of rubric.filter((r) => scored(r) && v.scores[r] < L.cfg.review.minDesignScore)) {
        if (!v.blocking.some((b) => String(b.issue || '').includes(k))) v.blocking.push({ file: '(rubric)', issue: `${k} scored ${v.scores[k]} < ${L.cfg.review.minDesignScore}`, fix: v.design || 'raise it to the bar the rubric describes', category: 'design' });
      }
      const unscored = rubric.filter((r) => !scored(r));
      if (unscored.length) v.blocking.push({ file: '(rubric)', issue: `the item was reviewed without a score for: ${unscored.join(', ')}`, fix: 'score every rubric dimension from 1 to 10', category: 'design' });
      if (v.blocking.length) v.verdict = 'changes';
      try {
        const body = path.join(path.dirname(L.paths.result), 'review-body.md');
        fs.writeFileSync(body, reviewBody(v));
        forge(L).postReview(L, s.pr, body);
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
  L.store.addExtra({ kind: 'followup', id, milestone, title: short(f.title, 120), scope: short(f.scope || f.title, 800), refs: [`raised by ${item.id}`], type: L.cfg.workTypes?.[f.type] ? f.type : workTypeName(item), dependsOn: [item.id] });
  L.progress(`${item.id} · follow-up ${id} queued (${milestone}): ${short(f.title, 120)}`);
  L.event('followup.queued', { item: item.id, followup: id, milestone });
}

function addFixItem(L, item, sha, dev) {
  const id = `FIX-${sha.slice(0, 7)}`;
  L.store.addExtra({
    kind: 'fix',
    id,
    milestone: item.milestone,
    title: `Make ${L.cfg.base} green again after ${item.id}`,
    scope: `CI on ${L.cfg.base} failed on ${sha} after merging ${item.id}. Failed jobs: ${(dev.jobs || []).join(', ')}. Log tail: ${dev.file ? path.relative(L.root, dev.file).replace(/\\/g, '/') : dev.text}. Fix forward in a PR; never weaken a gate.`,
    refs: ['docs/LESSONS.md'],
    ui: false,
    dependsOn: [],
  });
  return id;
}

/**
 * Base CI that was not waited for (baseCiWait: 'unless-tree-equal'). Without `wait`, one look at
 * each pending commit; with it, block until each has a verdict. Red queues the FIX item first in
 * line. No verdict is never a pass: one re-run, then the run stops with an owner action.
 * Returns { queued: number of FIX items added, stop?: reason }.
 */
export async function settleBaseCi(L, { wait = false } = {}) {
  const S = L.store.S;
  S.pendingBaseCi ||= [];
  let queued = 0;
  const { base } = L.cfg;
  // Once this run stopped for a missing verdict it does not ask again: a second wait would re-run
  // CI behind the owner's back and could clear the stop it just reported. The next run checks first.
  if (L.baseCiGaveUp) return { queued };
  for (const p of [...S.pendingBaseCi]) {
    const sha7 = p.sha.slice(0, 7);
    const drop = () => {
      S.pendingBaseCi = S.pendingBaseCi.filter((x) => x.sha !== p.sha);
      L.store.save();
    };
    const red = (dev) => {
      addFixItem(L, { id: p.item, milestone: p.milestone }, p.sha, dev);
      L.progress(`${p.item} · ${base} CI is RED on ${sha7} (checked in the background) — queued a fix item first in line`);
      L.event('base.red', { item: p.item, sha: p.sha, background: true });
      queued++;
      drop();
    };
    const noVerdict = (why) => {
      L.ownerAction(p.item, `${p.item}: CI on ${base} gave no verdict for ${sha7} (${why}). Check GitHub Actions (quota, runners, a stuck job), then re-run the loop: it checks again before anything else.`);
      L.progress(`${p.item} · ${base} CI on ${sha7} gave no verdict — the run stops`);
      L.event('base.no_verdict', { item: p.item, sha: p.sha, why });
      L.baseCiGaveUp = true;
      return { queued, stop: `${base} CI gave no verdict for ${sha7} (merged with ${p.item}): ${why}` };
    };
    if (wait) {
      L.setStatus('baseci', { id: p.item }, { sha: p.sha });
      const dev = await forge(L).waitForCommitCi(L, p.sha);
      if (dev.kind === 'stopped') return { queued };
      if (dev.ok) drop();
      else if (dev.kind === 'timeout') return noVerdict(dev.text);
      else red(dev);
      continue;
    }
    const c = forge(L).checkCommitCi(L, p.sha);
    if (c.state === 'ok') drop();
    else if (c.state === 'red') red(c);
    else {
      const late = Date.now() - p.since > L.cfg.timeouts.ciMin * 60_000;
      if (c.state === 'starved' || (late && !p.rerun && c.runId)) {
        if ((p.reruns || 0) >= 3) return noVerdict('the run was cancelled with no runner, four times');
        p.reruns = (p.reruns || 0) + 1;
        if (late) p.rerun = true;
        p.since = Date.now();
        forge(L).rerunCi(L, c.runId);
        L.store.save();
      } else if (late) return noVerdict(`no result within ${L.cfg.timeouts.ciMin} min${p.rerun ? ', also after a re-run' : ''}`);
    }
  }
  return { queued };
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
    L.event('item.finished', { item: item.id, milestone: item.milestone, status, why: why || null, buildRounds: s.rounds });
    noteItemEnded(L.store.S, item, status); // the stretch the open action items are measured over
    save();
    return status;
  };
  const outsideMergeAsk = (it, pr) =>
    `${it.id}: PR #${pr} was merged by something other than the runner, before CI and review finished. The change is on ${L.cfg.base} unreviewed. Inspect it (gh pr view ${pr}), revert it if needed, then release the item so it is rebuilt through the gates: node loop/run.mjs --release ${it.id}`;
  const hold = (kind, why, ownerAction) => {
    Object.assign(s, { phase: HELD_PHASE, hold: { kind, why, at: new Date().toISOString() }, lastError: `held (${kind}): ${why}` });
    save();
    L.ownerAction(item.id, ownerAction || `${item.id} is held (${kind}): ${why}. Fix it, then re-run the loop; it verifies again before it moves on. Where it cannot verify, release it with: node loop/run.mjs --release ${item.id}`);
    L.progress(`${item.id} · **held** (${kind}) — ${why}`);
    L.event('item.held', { item: item.id, kind, why });
    return 'held';
  };

  /** Record a verdict. {} on approve, { fix } for another round, { end } when the item is over. */
  const judgeReview = (rv) => {
    s.lastReview = rv;
    L.progress(`${item.id} · review round ${s.reviewRounds + 1} on PR #${s.pr}: **${rv.verdict}**${rv.blocking?.length ? ` (${rv.blocking.length} blocking)` : ''} — ${short(rv.summary || '', 250)}`);
    L.event('review.verdict', { item: item.id, pr: s.pr, round: s.reviewRounds + 1, verdict: rv.verdict, blocking: (rv.blocking || []).map((b) => ({ category: b.category || null, file: b.file || null })) });
    if (rv.verdict === 'approve') return {};
    L.event('check.sent_back', { item: item.id, check: 'review', pr: s.pr, round: s.reviewRounds + 1, detail: short(rv.summary || '', 300) });
    countReviewFailures(L, rv, item);
    s.reviewRounds++;
    if (s.reviewRounds > L.cfg.review.maxRounds) return { end: finish('needs_human', `review did not converge on PR #${s.pr}: ${short(JSON.stringify(rv.blocking), 600)}`) };
    return { fix: { kind: 'review', review: rv, round: s.reviewRounds, pr: s.pr } };
  };

  for (;;) {
    if (L.stopRequested()) return 'stopped';
    if (L.budgetExceeded()) return 'budget';

    if (s.phase === HELD_PHASE) {
      if (s.released) {
        delete s.redBase; // the owner vouches for the base
        L.progress(`${item.id} · released by the owner (${s.released}) from hold: ${s.hold?.kind}`);
        L.event('item.released', { item: item.id, kind: s.hold?.kind || null });
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
        L.event('build.round', { item: item.id, round: s.rounds, outcome: 'no-result', pr: s.pr || null, timedOut: !!run?.timedOut });
        if (s.attempts >= L.cfg.maxAttemptsPerItem) return finish('failed', s.lastError);
        if (s.pr && forge(L).prView(L, s.pr).state === 'OPEN') s.phase = 'ci';
        save();
        continue;
      }
      if (r.handoff) s.notes.push(`round ${s.rounds}: ${short(r.handoff, 600)}`);
      for (const a of r.owner_actions || []) L.ownerAction(item.id, a);
      L.progress(`${item.id} · build round ${s.rounds} → ${r.outcome}${r.pr ? ` PR #${r.pr}` : ''} — ${short(r.summary || '', 300)}`);
      L.event('build.round', { item: item.id, round: s.rounds, outcome: r.outcome, pr: r.pr || null });
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
        v = r.pr ? forge(L).prView(L, r.pr) : null;
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
      Object.assign(s, { pr: v.number, branch: v.headRefName, isPartial: r.outcome === 'partial', remaining: r.remaining || '', summary: r.summary || '', phase: 'gate' });
      save();
    }

    if (s.phase === 'gate') {
      L.setStatus('gate', item, { pr: s.pr });
      const g = runLocalGate(L, item, s);
      if (!g.ok) {
        s.ciFixes++;
        countFailure(L, `gate:${g.command}`, short(g.text, 300), item);
        L.progress(`${item.id} · local gate failed on PR #${s.pr} (${g.command}) — fix ${s.ciFixes}/${L.cfg.maxCiFixes}`);
        L.event('check.sent_back', { item: item.id, check: 'local-gate', pr: s.pr, round: s.ciFixes, detail: g.command });
        if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', `the local gate (${g.command}) still fails on PR #${s.pr} after ${L.cfg.maxCiFixes} fix rounds`);
        fix = { kind: 'gate', text: g.text, pr: s.pr };
        Object.assign(s, { pendingFix: fix, phase: 'build' });
        save();
        continue;
      }
      if (g.note) L.progress(`${item.id} · local gate: ${g.note}`);
      s.phase = 'ci';
      save();
    }

    if (s.phase === 'ci') {
      let view = null;
      try {
        view = forge(L).prView(L, s.pr);
      } catch {}
      const open = view?.state === 'OPEN';
      // Structural checks first: they need neither CI nor a reviewer, so a PR that fails them
      // costs neither.
      if (open) {
        const pre = preMergeChecks(L, s, item);
        if (!pre.ok) {
          s.ciFixes++;
          countFailure(L, 'premerge', short(pre.text, 300), item);
          L.progress(`${item.id} · pre-merge checks failed on PR #${s.pr} — fix ${s.ciFixes}/${L.cfg.maxCiFixes}`);
          L.event('check.sent_back', { item: item.id, check: 'pre-merge', pr: s.pr, round: s.ciFixes, detail: short(pre.text, 300) });
          if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', pre.text);
          fix = { kind: 'premerge', text: pre.text, pr: s.pr };
          Object.assign(s, { pendingFix: fix, phase: 'build' });
          save();
          continue;
        }
      }
      // The reviewer starts while CI runs (review.parallelWithCi): it is read-only and pinned to this
      // head, and the merge still needs both CI green on that commit and the approval.
      const head = open ? view.headRefOid : null;
      const parallel = !!L.cfg.review?.parallelWithCi && !!head;
      L.log(`… waiting for CI on PR #${s.pr}${parallel ? ', reviewing meanwhile' : ''}`);
      L.setStatus('ci', item, { pr: s.pr });
      const [ciR, rvR] = await Promise.allSettled([forge(L).waitForPrCi(L, s.pr), parallel ? reviewSession(L, item, s, head) : null]);
      if (ciR.status === 'rejected') throw ciR.reason;
      if (rvR.status === 'rejected') throw rvR.reason;
      const ci = ciR.value;
      if (ci.kind === 'stopped') return 'stopped';
      if (!ci.ok && ci.kind === 'merged') return hold('outside-merge', ci.text, outsideMergeAsk(item, s.pr));
      if (!ci.ok && ci.kind === 'closed') {
        Object.assign(s, { pr: null, phase: 'build', lastError: ci.text });
        save();
        continue;
      }
      // A verdict counts only for the commit CI judged. With CI red there is no such commit yet, and
      // the findings still belong to the head the fix round starts from.
      const rv = rvR.value && (!ci.ok || ci.sha === head) ? rvR.value : null;
      const fixes = [];
      if (!ci.ok) {
        s.ciFixes++;
        for (const j of ci.jobs || []) countFailure(L, `ci:${j}`, `PR #${s.pr}`, item);
        L.progress(`${item.id} · CI on PR #${s.pr}: ${ci.kind}${ci.jobs ? ` (${ci.jobs.join(', ')})` : ''} — fix ${s.ciFixes}/${L.cfg.maxCiFixes}`);
        L.event('check.sent_back', { item: item.id, check: 'ci', pr: s.pr, round: s.ciFixes, detail: ci.kind, jobs: ci.jobs || [] });
        if (s.ciFixes > L.cfg.maxCiFixes) return finish('needs_human', `CI still not green on PR #${s.pr} after ${L.cfg.maxCiFixes} fix rounds`);
        fixes.push({ ...ci, pr: s.pr });
      }
      let approved = false;
      if (rv) {
        const j = judgeReview(rv);
        if (j.end) return j.end;
        if (j.fix) fixes.push(j.fix);
        else approved = true;
      }
      if (fixes.length) {
        fix = fixes.length === 1 ? fixes[0] : { kind: 'multi', parts: fixes, pr: s.pr };
        Object.assign(s, { pendingFix: fix, phase: 'build' });
        save();
        continue;
      }
      if (approved) Object.assign(s, { ciSha: ci.sha, reviewedSha: ci.sha, phase: 'merge' });
      else Object.assign(s, { ciSha: ci.sha, phase: 'review' }); // no verdict yet: review now, on the green head
      save();
    }

    if (s.phase === 'review') {
      const rv = await reviewSession(L, item, s, s.ciSha);
      if (!rv) {
        if (L.stopRequested() || L.budgetExceeded()) return 'stopped';
        return finish('needs_human', `the reviewer gave no verdict on PR #${s.pr}`);
      }
      const j = judgeReview(rv);
      if (j.end) return j.end;
      if (j.fix) {
        fix = j.fix;
        Object.assign(s, { pendingFix: fix, phase: 'build' });
        save();
        continue;
      }
      // the reviewer reviewed s.ciSha; make sure nothing moved underneath it
      if (forge(L).prView(L, s.pr).headRefOid !== s.ciSha) {
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
      const m = forge(L).mergePr(L, s);
      if (!m.ok) {
        L.progress(`${item.id} · merge of PR #${s.pr} refused: ${m.kind} ${m.text || ''}`);
        L.event('check.sent_back', { item: item.id, check: 'merge', pr: s.pr, round: s.ciFixes + 1, detail: m.kind });
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
      L.event('item.merged', { item: item.id, pr: s.pr, sha: m.sha });
      save();
    }

    if (s.phase === 'landed') {
      L.setStatus('landed', item, { sha: s.mergeSha });
      const lc = landedCheck(L, { baseBefore: s.baseBefore, reviewedSha: s.reviewedSha, mergeSha: s.mergeSha });
      if (!lc.ok) return hold('landed', `PR #${s.pr}: ${lc.why}`, `${item.id}: what landed on ${L.cfg.base} with PR #${s.pr} (${String(s.mergeSha).slice(0, 7)}) is not what the reviewer approved (${lc.why}). Inspect it with git show ${String(s.mergeSha).slice(0, 7)}. Revert or fix it on ${L.cfg.base}, then release the item: node loop/run.mjs --release ${item.id}`);
      L.syncBase();
      s.treeEqual = !!lc.treeEqual;
      s.phase = 'baseci';
      save();
    }

    if (s.phase === 'baseci') {
      L.setStatus('baseci', item, { sha: s.mergeSha });
      const sha7 = String(s.mergeSha).slice(0, 7);
      const waitOnRed = L.cfg.postMergeOnRedBase === 'wait' && (L.cfg.postMerge || []).length > 0;
      if (L.cfg.baseCiWait === 'unless-tree-equal' && s.treeEqual && !waitOnRed) {
        // The landed check proved this commit has exactly the tree PR CI passed on. Base CI still
        // runs and still counts; the next item just does not wait for it (settleBaseCi).
        const S = L.store.S;
        S.pendingBaseCi ||= [];
        if (!S.pendingBaseCi.some((p) => p.sha === s.mergeSha)) S.pendingBaseCi.push({ sha: s.mergeSha, item: item.id, milestone: item.milestone, since: Date.now() });
        L.progress(`${item.id} · ${sha7} has the tree CI passed on; ${L.cfg.base} CI is checked in the background`);
      } else {
        const dev = await forge(L).waitForCommitCi(L, s.mergeSha);
        if (dev.kind === 'stopped') return 'stopped';
        if (!dev.ok && dev.kind === 'timeout') return hold('baseci', dev.text, `${item.id}: CI on ${L.cfg.base} never finished for ${sha7} (${dev.text}). Check GitHub Actions (quota, runners, a stuck job). Re-run the loop once CI reports; it checks again. To accept the commit without a CI verdict: node loop/run.mjs --release ${item.id}`);
        if (!dev.ok) {
          const fixId = addFixItem(L, item, s.mergeSha, dev);
          L.progress(`${item.id} · ${L.cfg.base} CI is RED after merging PR #${s.pr} — queued a fix item first in line`);
          L.event('base.red', { item: item.id, sha: s.mergeSha, fix: fixId, background: false });
          if (waitOnRed) s.redBase = { fix: fixId };
        }
      }
      s.phase = 'postmerge';
      save();
    }

    if (s.phase === 'postmerge') {
      if (L.args.dry) return 'dry';
      if (s.redBase) {
        // postMergeOnRedBase: 'wait'. The steps run once the fix item made the base green again.
        const fixStatus = L.store.st(s.redBase.fix).status;
        if (!TERMINAL.has(fixStatus)) {
          L.progress(`${item.id} · post-merge steps wait for ${s.redBase.fix}: ${L.cfg.base} is red`);
          return 'waiting';
        }
        if (fixStatus !== 'done') return hold('baseci', `${L.cfg.base} went red after this merge and ${s.redBase.fix} ended ${fixStatus}`, `${item.id}: ${L.cfg.base} is red since its merge and the fix item ${s.redBase.fix} ended ${fixStatus}, so its post-merge steps did not run. Make ${L.cfg.base} green, then release the item: node loop/run.mjs --release ${item.id}`);
        L.progress(`${item.id} · ${s.redBase.fix} is done: running the post-merge steps now`);
        s.redBase = null;
        save();
      }
      L.setStatus('postmerge', item, { sha: s.mergeSha });
      L.syncBase();
      for (const step of L.cfg.postMerge || []) {
        const res = postMergeAdapter(step.adapter).run({ ...L, env: L.envBase }, { mergeSha: s.mergeSha, item, step });
        if (!res.ok) {
          if (step.holdOnUnverified === false) {
            L.ownerAction(item.id, res.ownerAction || res.why);
            L.progress(`${item.id} · post-merge ${step.adapter} not verified (not holding, holdOnUnverified is off): ${res.why}`);
            L.event('postmerge.step', { item: item.id, adapter: step.adapter, ok: false, note: res.why });
            continue;
          }
          return hold('postmerge', `${step.adapter}: ${res.why}`, res.ownerAction);
        }
        L.progress(`${item.id} · post-merge ${step.adapter}: ${res.note || 'ok'}`);
        L.event('postmerge.step', { item: item.id, adapter: step.adapter, ok: true, note: res.note || null });
      }
      s.phase = 'finish';
      save();
    }

    if (s.phase === 'finish') {
      const wasPartial = s.isPartial;
      Object.assign(s, { pr: null, branch: null, ciSha: null, reviewedSha: null, lastReview: null, ciFixes: 0, reviewRounds: 0, pendingFix: null, hold: null, mergeSha: null, baseBefore: null, treeEqual: null, redBase: null, phase: 'build' });
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
