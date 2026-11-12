// Milestone acceptance on the deployed dev site, then the packet. The loop does not pause here:
// acceptance failures become ACC fix items first in line, and the packet is for the owner to read
// whenever they like.

import fs from 'node:fs';
import path from 'node:path';

import { runClaude } from './claude.mjs';
import { goalPrompt, settleBaseCi } from './engine.mjs';
import { deployAdapter } from '../adapters/index.mjs';
import { acceptMode, acceptTypeName } from './worktypes.mjs';
import { ACCEPT_SCHEMA, PACKET_SCHEMA } from './schemas.mjs';
import { writeJson, readJson } from './state.mjs';

const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);

/** The deployed site this project's acceptance runs on, behind the deploy adapter the config names. */
const deploy = (L) => deployAdapter(L.cfg.deploy?.adapter);

async function acceptSession(L, m, round, sha, mode) {
  const items = L.store.allItems().filter((i) => i.milestone === m);
  const prevFile = path.join(L.paths.run, `accept-${m}.json`);
  const prev = readJson(prevFile, null);
  fs.writeFileSync(L.paths.task, L.render('accept.md', {
    MILESTONE: m,
    ROUND: round,
    BASE: L.cfg.base,
    DEV_URL: L.cfg.deploy.devUrl || '(none)',
    TARGET_NOTE: mode === 'site' ? `The runner already checked that \`${L.cfg.deploy.devUrl}${L.cfg.deploy.health}\` serves commit \`${sha.slice(0, 7)}\`.` : `Nothing is deployed for this project: you test the merged \`${L.cfg.base}\` itself, at commit \`${sha.slice(0, 7)}\`, the way step 2 says.`,
    BYPASS_ENV: L.cfg.deploy.bypassSecretEnv || '(none)',
    BYPASS_HEADER: L.cfg.deploy.bypassHeader || '(none)',
    MIN_SCORE: L.cfg.review.minDesignScore,
    BASE_SHA_SHORT: sha.slice(0, 7),
    ITEM_TABLE: items.map((i) => `- ${i.id} · ${i.title} · ${L.store.st(i.id).status} · refs: ${(i.refs || []).join('; ')}`).join('\n'),
    PREVIOUS: prev?.failures?.length ? `## The previous round failed on these — verify each is fixed\n\n\`\`\`json\n${JSON.stringify(prev.failures, null, 2)}\n\`\`\`` : '',
  }, { variant: mode }));
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

async function packetSession(L, m, mode) {
  const items = L.store.allItems().filter((i) => i.milestone === m);
  fs.mkdirSync(path.join(L.paths.reviews, m), { recursive: true });
  fs.writeFileSync(L.paths.task, L.render('packet.md', {
    MILESTONE: m,
    DEV_URL: L.cfg.deploy.devUrl || '(none)',
    BYPASS_ENV: L.cfg.deploy.bypassSecretEnv || '(none)',
    BYPASS_HEADER: L.cfg.deploy.bypassHeader || '(none)',
    ITEM_TABLE: items.map((i) => `- ${i.id} · ${i.title} · ${L.store.st(i.id).status}${L.store.st(i.id).prs?.length ? ` · PR ${L.store.st(i.id).prs.map((p) => '#' + p).join(', ')}` : ''}`).join('\n'),
    OWNER_ACTIONS: L.ownerActionsTail(60),
    ACCEPT_JSON: JSON.stringify({ ...readJson(path.join(L.paths.run, `accept-${m}.json`), { note: 'no acceptance run (no item of an accepted work type)' }), ...(L.store.S.accept[m]?.unverified ? { fixesNotReAccepted: 'These failures are from the last acceptance round. Their fix items merged through CI and review but were not re-tested: say so in the packet.' } : {}) }, null, 2),
  }, { variant: mode }));
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
  if (!L.cfg.milestonePackets || L.args.dry) return {};
  if (L.baseCiGaveUp) return {}; // a merge has no base CI verdict: nothing is accepted or packed on it
  const S = L.store.S;
  for (const m of L.backlog.milestones) {
    if (only && m !== only) continue;
    if (S.packed.includes(m)) continue;
    const inM = L.store.allItems().filter((i) => i.milestone === m);
    if (!inM.length || !inM.every((i) => L.store.settled(i)) || !inM.some((i) => L.store.st(i.id).status === 'done')) continue;
    // A milestone is not judged while a merge in it still waits for its base CI verdict.
    const settled = await settleBaseCi(L, { wait: true });
    if (settled.stop) return { stop: settled.stop };
    if (settled.queued || L.stopRequested()) return {};
    const a = (S.accept[m] ||= { rounds: 0, passed: false });
    // How this milestone is accepted follows from its items' work types: on the deployed site,
    // on the merged base itself, or not at all.
    const mode = acceptMode(L.cfg, inM);
    const where = mode === 'site' ? 'on dev' : `on ${L.cfg.base}`;
    if (mode !== 'none' && !a.passed && a.rounds < L.cfg.maxAcceptRounds) {
      L.proc.git('fetch', 'origin', '--prune');
      const sha = L.proc.git('rev-parse', `origin/${L.cfg.base}`);
      if (mode === 'site') {
        const dep = await deploy(L).waitUntilServing(L, sha);
        if (!dep.ok) {
          if (dep.why === 'stopped') return {};
          L.ownerAction(m, `The dev site does not serve the merged ${L.cfg.base} (${dep.why}). Check the deployment, then re-run the loop: acceptance for ${m} runs first.`);
          return { stop: `dev site not serving ${sha.slice(0, 7)}: ${dep.why}` };
        }
      }
      a.rounds++;
      L.store.save();
      const res = await acceptSession(L, m, a.rounds, sha, mode);
      if (L.stopRequested() || L.budgetExceeded()) return {};
      if (res?.pass) {
        a.passed = true;
        L.progress(`${m} · acceptance round ${a.rounds} ${where}: **pass**`);
      } else {
        const failures = (res?.failures || []).slice(0, 8);
        if (!res) failures.push({ title: `Acceptance run for ${m} produced no verdict`, scope: mode === 'site' ? 'Re-run the milestone acceptance; check the dev deployment and the health endpoint first.' : 'Re-run the milestone acceptance; check that the merged base installs and starts first.' });
        failures.forEach((f, i) =>
          L.store.addExtra({ kind: 'fix', id: `ACC-${m}-${a.rounds}-${i + 1}`, milestone: m, title: short(f.title || 'acceptance failure', 120), scope: short(`${f.scope || ''} Evidence: ${f.evidence || '-'}${f.relatedItem ? ` (related: ${f.relatedItem})` : ''}`, 1200), refs: [`.loop/accept-${m}.json`, 'docs/REQUIREMENTS.md', 'loop/prompts/learn.md'], type: acceptTypeName(L.cfg, inM), dependsOn: [] }),
        );
        for (const x of res?.owner || []) L.ownerAction(m, x);
        L.progress(`${m} · acceptance round ${a.rounds} ${where}: **${failures.length} failure(s)** → fix items queued first in line`);
        L.store.save();
        // Fix first. The packet is written only once these items are settled, also after the last
        // round: a packet written before its fixes were built would describe a site that is gone.
        return {};
      }
    }
    if (mode !== 'none' && a.rounds > 0 && !a.passed) {
      a.unverified = true;
      L.ownerAction(m, `Milestone ${m}: acceptance still found failures in its last round (${a.rounds} of ${L.cfg.maxAcceptRounds}). Their fix items (ACC-${m}-${a.rounds}-*) went through CI and review, but nothing re-tested them ${mode === 'site' ? 'on the dev site' : where}. Check them yourself against .loop/accept-${m}.json before you rely on ${m}.`);
      L.progress(`${m} · packed with the last acceptance round's fixes not re-accepted ${where}`);
    }
    S.packed.push(m);
    L.store.save();
    await packetSession(L, m, mode);
  }
  return {};
}
