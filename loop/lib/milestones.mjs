// Milestone acceptance where the product runs (the deployed dev site, the merged base itself, or
// both), then the packet. The loop does not pause here:
// acceptance failures become ACC fix items first in line, and the packet is for the owner to read
// whenever they like.

import fs from 'node:fs';
import path from 'node:path';

import { runClaude } from './claude.mjs';
import { goalPrompt, settleBaseCi } from './engine.mjs';
import { deployAdapter } from '../adapters/index.mjs';
import { acceptPlace, acceptPlan, acceptTypeName } from './worktypes.mjs';
import { ACCEPT_SCHEMA, PACKET_SCHEMA } from './schemas.mjs';
import { writeJson, readJson } from './state.mjs';
import { noteAcceptanceFailed, retroState } from './learn.mjs';
import { readOnlyRules } from './guardnotes.mjs';
import { holdRetro } from './retro.mjs';

const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);

/** The deployed site this project's acceptance runs on, behind the deploy adapter the config names. */
const deploy = (L) => deployAdapter(L.cfg.deploy?.adapter);

/** What a milestone delivers: its items without the loop's own LEARN items, which are not the product. */
const delivered = (L, m) => L.store.allItems().filter((i) => i.milestone === m && i.kind !== 'learn');

/**
 * The same items with the backlog's own first, then the ones the loop added (fix items, follow-ups).
 * How a milestone is accepted, and the type a fix item gets when its failure names no item, follow
 * from what the milestone was planned to deliver, not from which fix item happens to be queued.
 */
const planned = (L, m) => {
  const items = delivered(L, m);
  return [...items.filter((i) => !i.kind), ...items.filter((i) => i.kind)];
};

const placeWords = (L, place) => (place === 'site' ? 'on the deployed dev site' : `on the merged \`${L.cfg.base}\``);
/**
 * A plan as the cases of a prompt: one per work type, with the wording for the place it is
 * accepted at, and the line that heads its words when the prompt has more than one case.
 */
const casesOf = (L, plan) => plan.flatMap((part) => part.types.map((type) => ({ variant: part.place, types: [type], label: `**The \`${type}\` items, ${placeWords(L, part.place)}:**` })));
/**
 * The cases of a packet. A milestone that was accepted is shown the way it was accepted. One
 * that was not (none of its items is of an accepted type) is shown the way the stack's products
 * would be: every work type that is accepted somewhere, at its place.
 */
function packetCases(L, plan) {
  if (plan.length) return casesOf(L, plan);
  const types = Object.keys(L.cfg.workTypes || {}).filter((t) => L.cfg.workTypes[t]);
  const fallback = ['site', 'local'].map((place) => ({ place, types: types.filter((t) => acceptPlace(L.cfg, L.cfg.workTypes[t]) === place) })).filter((part) => part.types.length);
  return fallback.length ? casesOf(L, fallback) : [{}];
}

/** What the evaluator is told about where it tests: the site the runner checked, the merged base, or both. */
function targetNote(L, plan, sha) {
  const commit = `\`${sha.slice(0, 7)}\``;
  const at = (place) => plan.find((part) => part.place === place);
  const kinds = (part) => part.types.map((t) => `\`${t}\``).join(', ');
  const site = `The runner already checked that \`${L.cfg.deploy.devUrl}${L.cfg.deploy.health}\` serves commit ${commit}.`;
  const many = casesOf(L, plan).length > 1 ? ' Steps 2 to 4 come once for each kind of item, under a line that names it: do every one of them.' : '';
  if (at('site') && at('local')) return `${site} The ${kinds(at('local'))} items are not deployed: you test them on the merged \`${L.cfg.base}\` itself, at the same commit, the way their step 2 says.${many}`;
  if (at('site')) return site + many;
  return `Nothing is deployed for this project: you test the merged \`${L.cfg.base}\` itself, at commit ${commit}, the way step 2 says.${many}`;
}

async function acceptSession(L, m, round, sha, plan) {
  const items = delivered(L, m);
  const prevFile = path.join(L.paths.run, `accept-${m}.json`);
  const prev = readJson(prevFile, null);
  fs.writeFileSync(L.paths.task, L.render('accept.md', {
    MILESTONE: m,
    ROUND: round,
    BASE: L.cfg.base,
    DEV_URL: L.cfg.deploy.devUrl || '(none)',
    TARGET_NOTE: targetNote(L, plan, sha),
    BYPASS_ENV: L.cfg.deploy.bypassSecretEnv || '(none)',
    BYPASS_HEADER: L.cfg.deploy.bypassHeader || '(none)',
    MIN_SCORE: L.cfg.review.minDesignScore,
    BASE_SHA_SHORT: sha.slice(0, 7),
    WORK: L.work.path(m, 'accept'),
    GUARD_RULES: readOnlyRules(L.work.path(m, 'accept')),
    ITEM_TABLE: items.map((i) => `- ${i.id} · ${i.title} · ${L.store.st(i.id).status} · refs: ${(i.refs || []).join('; ')}`).join('\n'),
    PREVIOUS: prev?.failures?.length ? `## The previous round failed on these — verify each is fixed\n\n\`\`\`json\n${JSON.stringify(prev.failures, null, 2)}\n\`\`\`` : '',
  }, { cases: casesOf(L, plan) }));
  L.setStatus('accept', { id: m, title: `acceptance ${m} round ${round}` });
  const cond = `The milestone acceptance described in .loop/current-task.md is complete: every user journey of milestone ${m} was exercised the way that file says and the structured result lists every failure (pass true only if there are none).`;
  const r = await runClaude(L.session, { prompt: goalPrompt(L, cond), phase: 'accept', item: { id: m }, timeoutMin: L.cfg.timeouts.acceptMin, model: L.cfg.reviewModel || L.cfg.model, schema: ACCEPT_SCHEMA });
  L.checkIsolation(r);
  if (r.gaveUp || !r.structured) return null;
  const res = { ...r.structured, milestone: m };
  res.failures = Array.isArray(res.failures) ? res.failures : [];
  res.pass = res.failures.length === 0;
  writeJson(prevFile, res);
  return res;
}

async function packetSession(L, m, plan) {
  const items = delivered(L, m);
  const retro = retroState(L.store.S).milestones[m];
  fs.mkdirSync(path.join(L.paths.reviews, m), { recursive: true });
  fs.writeFileSync(L.paths.task, L.render('packet.md', {
    MILESTONE: m,
    BASE: L.cfg.base,
    DEV_URL: L.cfg.deploy.devUrl || '(none)',
    BYPASS_ENV: L.cfg.deploy.bypassSecretEnv || '(none)',
    BYPASS_HEADER: L.cfg.deploy.bypassHeader || '(none)',
    WORK: L.work.path(m, 'packet'),
    GUARD_RULES: readOnlyRules(L.work.path(m, 'packet')),
    ACCEPT_WORK: L.work.path(m, 'accept'), // what acceptance installed is still there for the packet
    ITEM_TABLE: items.map((i) => `- ${i.id} · ${i.title} · ${L.store.st(i.id).status}${L.store.st(i.id).prs?.length ? ` · PR ${L.store.st(i.id).prs.map((p) => '#' + p).join(', ')}` : ''}`).join('\n'),
    OWNER_ACTIONS: L.ownerActionsTail(60),
    RETRO: retro && retro !== 'none' ? `The loop's retro for this milestone is in \`.loop/retros/${retro}.md\`: what went well, what went wrong, the action items and the impediments it recorded (\`.loop/IMPEDIMENTS.md\`: defects in the harness, nothing the owner is asked to do).` : 'No retro was held for this milestone.',
    ACCEPT_JSON: JSON.stringify({ ...readJson(path.join(L.paths.run, `accept-${m}.json`), { note: 'no acceptance run (no item of an accepted work type)' }), ...(L.store.S.accept[m]?.unverified ? { fixesNotReAccepted: 'These failures are from the last acceptance round. Their fix items merged through CI and review but were not re-tested: say so in the packet.' } : {}) }, null, 2),
  }, { cases: packetCases(L, plan) }));
  L.setStatus('packet', { id: m, title: `packet ${m}` });
  const cond = `The milestone packet described in .loop/current-task.md is returned as structured output, with its screenshots taken.`;
  const r = await runClaude(L.session, { prompt: goalPrompt(L, cond), phase: 'packet', item: { id: m }, timeoutMin: L.cfg.timeouts.packetMin, model: L.cfg.model, schema: PACKET_SCHEMA });
  L.checkIsolation(r);
  const md = r.structured?.markdown || `# ${m}\n\nThe packet session returned nothing. Items:\n\n${items.map((i) => `- ${i.id} ${i.title}: ${L.store.st(i.id).status}`).join('\n')}\n`;
  fs.writeFileSync(path.join(L.paths.reviews, `${m}.md`), md);
  L.progress(`${m} · packet → .loop/reviews/${m}.md`);
  await L.notify(`loop: ${m} ready to look at`, `Open .loop/reviews/${m}.md`);
}

/**
 * Accept and pack every milestone whose items are all settled and at least one is done.
 * Returns { stop: reason } when the run has to stop (the dev site does not serve the merge).
 */
export async function packMilestones(L, only) {
  // `milestonePackets: false` switches off acceptance and the packet. The retro stays: it is how
  // the loop learns, and without it the signals of a milestone's last items would never be read.
  const packets = !!L.cfg.milestonePackets;
  const retros = L.cfg.retro?.enabled !== false;
  if ((!packets && !retros) || L.args.dry) return {};
  if (L.baseCiGaveUp) return {}; // a merge has no base CI verdict: nothing is accepted or packed on it
  const S = L.store.S;
  for (const m of L.backlog.milestones) {
    if (only && m !== only) continue;
    if (S.packed.includes(m)) continue;
    if (!packets && retroState(S).milestones[m]) continue; // without packets the retro is all a milestone ends with
    const inM = L.store.allItems().filter((i) => i.milestone === m);
    if (!inM.length || !inM.every((i) => L.store.settled(i)) || !inM.some((i) => L.store.st(i.id).status === 'done')) continue;
    // A milestone is not judged while a merge in it still waits for its base CI verdict.
    const settled = await settleBaseCi(L, { wait: true });
    if (settled.stop) return { stop: settled.stop };
    if (settled.queued || L.stopRequested()) return {};
    const a = packets ? (S.accept[m] ||= { rounds: 0, passed: false }) : null;
    // How this milestone is accepted follows from its items' work types: on the deployed site,
    // on the merged base itself, both (screens that are deployed and a command that is not), or
    // not at all.
    const plan = packets ? acceptPlan(L.cfg, planned(L, m)) : [];
    const onSite = plan.some((part) => part.place === 'site');
    const mode = plan[0]?.place || 'none'; // the one word the event file has always carried
    const places = plan.map((part) => part.place);
    const where = plan.map((part) => (part.place === 'site' ? 'on dev' : `on ${L.cfg.base}`)).join(' and ');
    if (plan.length && !a.passed && a.rounds < L.cfg.maxAcceptRounds) {
      L.proc.git('fetch', 'origin', '--prune');
      const sha = L.proc.git('rev-parse', `origin/${L.cfg.base}`);
      if (onSite) {
        const dep = await deploy(L).waitUntilServing(L, sha);
        if (!dep.ok) {
          if (dep.why === 'stopped') return {};
          L.ownerAction(m, `The dev site does not serve the merged ${L.cfg.base} (${dep.why}). Check the deployment, then re-run the loop: acceptance for ${m} runs first.`);
          return { stop: `dev site not serving ${sha.slice(0, 7)}: ${dep.why}` };
        }
      }
      a.rounds++;
      L.store.save();
      const res = await acceptSession(L, m, a.rounds, sha, plan);
      // A stop or a spent budget ends the run after this step, not instead of its result: a round
      // that gave a verdict is recorded first. Dropping it would leave the round counted and
      // nothing known, and the next run would pack the milestone as "not re-accepted". Only a
      // session that was cut short gives its round back.
      const ending = L.stopRequested() || L.budgetExceeded();
      if (ending && !res) {
        a.rounds--;
        L.store.save();
        return {};
      }
      if (res?.pass) {
        a.passed = true;
        L.progress(`${m} · acceptance round ${a.rounds} ${where}: **pass**`);
        L.event('acceptance.round', { milestone: m, round: a.rounds, mode, places, pass: true, failures: 0 });
        L.store.save();
        if (ending) return {};
      } else {
        const failures = (res?.failures || []).slice(0, 8);
        // what acceptance found counts against the action items being measured: no review signal names it
        if (failures.length) noteAcceptanceFailed(S, m, a.rounds);
        if (!res) failures.push({ title: `Acceptance run for ${m} produced no verdict`, scope: onSite ? 'Re-run the milestone acceptance; check the dev deployment and the health endpoint first.' : 'Re-run the milestone acceptance; check that the merged base installs and starts first.' });
        const items = planned(L, m); // before the fix items below join the milestone
        failures.forEach((f, i) =>
          L.store.addExtra({ kind: 'fix', id: `ACC-${m}-${a.rounds}-${i + 1}`, milestone: m, title: short(f.title || 'acceptance failure', 120), scope: short(`${f.scope || ''} Evidence: ${f.evidence || '-'}${f.relatedItem ? ` (related: ${f.relatedItem})` : ''}`, 1200), refs: [`.loop/accept-${m}.json`, 'docs/REQUIREMENTS.md', 'loop/prompts/learn.md'], type: acceptTypeName(L.cfg, items, f.relatedItem), dependsOn: [] }),
        );
        for (const x of res?.owner || []) L.ownerAction(m, x);
        L.progress(`${m} · acceptance round ${a.rounds} ${where}: **${failures.length} failure(s)** → fix items queued first in line`);
        L.event('acceptance.round', { milestone: m, round: a.rounds, mode, places, pass: false, failures: failures.length });
        L.store.save();
        // Fix first. The packet is written only once these items are settled, also after the last
        // round: a packet written before its fixes were built would describe a site that is gone.
        return {};
      }
    }
    // The retro, once per milestone: what the stretch taught. Its LEARN item is built before the
    // packet, so the packet can say what changed.
    const R = retroState(S);
    if (retros && !R.milestones[m]) {
      const res = await holdRetro(L, { kind: 'milestone', milestone: m });
      if (L.stopRequested() || L.budgetExceeded()) return {};
      if (!res) {
        R.milestones[m] = 'none';
        L.progress(`${m} · the retro session gave no result; the milestone ${packets ? 'is packed' : 'ends'} without one`);
        L.store.save();
      } else if (res.learn) return {};
    }
    if (!packets) continue;
    if (plan.length && a.rounds > 0 && !a.passed) {
      a.unverified = true;
      L.ownerAction(m, `Milestone ${m}: acceptance still found failures in its last round (${a.rounds} of ${L.cfg.maxAcceptRounds}). Their fix items (ACC-${m}-${a.rounds}-*) went through CI and review, but nothing re-tested them ${plan.map((part) => (part.place === 'site' ? 'on the dev site' : `on ${L.cfg.base}`)).join(' and ')}. Check them yourself against .loop/accept-${m}.json before you rely on ${m}.`);
      L.progress(`${m} · packed with the last acceptance round's fixes not re-accepted ${where}`);
    }
    S.packed.push(m);
    L.event('milestone.packed', { milestone: m, unverified: !!a.unverified });
    L.store.save();
    await packetSession(L, m, plan);
    L.work.done(m, 'accept', 'packet'); // the packet is written: the installed package and the scratch folders go
  }
  return {};
}
