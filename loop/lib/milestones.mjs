// Milestone acceptance on the deployed dev site, then the packet. The loop does not pause here:
// acceptance failures become ACC fix items first in line, and the packet is for the owner to read
// whenever they like.

import fs from 'node:fs';
import path from 'node:path';

import { runClaude } from './claude.mjs';
import { goalPrompt } from './engine.mjs';
import { ACCEPT_SCHEMA, PACKET_SCHEMA } from './schemas.mjs';
import { writeJson, readJson } from './state.mjs';

const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the dev site's health endpoint until it serves `sha` (and a healthy db). The acceptance
 * evaluator must test what was merged, not an older deployment. {ok} | {ok:false, why}
 */
export async function waitForDeploy(L, sha) {
  const d = L.cfg.deploy || {};
  if (!d.devUrl) return { ok: false, why: 'deploy.devUrl is not set' };
  const url = d.devUrl.replace(/\/$/, '') + (d.health || '/api/health');
  const headers = {};
  const bypass = d.bypassSecretEnv && L.envBase[d.bypassSecretEnv];
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  const deadline = Date.now() + (L.cfg.timeouts.deployMin ?? 20) * 60_000;
  let last = '';
  for (;;) {
    if (L.stopRequested()) return { ok: false, why: 'stopped' };
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      const body = await res.json().catch(() => ({}));
      last = `HTTP ${res.status}, commit ${body.commit ?? '?'}, db ${body.db ?? '?'}`;
      if (res.ok && String(body.commit || '').startsWith(sha.slice(0, 7)) && ['ok', 'stub'].includes(body.db)) return { ok: true };
    } catch (e) {
      last = String(e.message || e);
    }
    if (Date.now() > deadline) return { ok: false, why: `${url} never served ${sha.slice(0, 7)} with a healthy db (last: ${last})` };
    await sleep(L.cfg.pollMs ?? 30_000);
  }
}

async function acceptSession(L, m, round, sha) {
  const items = L.store.allItems().filter((i) => i.milestone === m);
  const prevFile = path.join(L.paths.run, `accept-${m}.json`);
  const prev = readJson(prevFile, null);
  fs.writeFileSync(L.paths.task, L.render('accept.md', {
    MILESTONE: m,
    ROUND: round,
    BASE: L.cfg.base,
    DEV_URL: L.cfg.deploy.devUrl,
    HEALTH: L.cfg.deploy.health,
    BYPASS_ENV: L.cfg.deploy.bypassSecretEnv || 'VERCEL_BYPASS',
    MIN_SCORE: L.cfg.review.minDesignScore,
    BASE_SHA_SHORT: sha.slice(0, 7),
    ITEM_TABLE: items.map((i) => `- ${i.id} · ${i.title} · ${L.store.st(i.id).status} · refs: ${(i.refs || []).join('; ')}`).join('\n'),
    PREVIOUS: prev?.failures?.length ? `## The previous round failed on these — verify each is fixed\n\n\`\`\`json\n${JSON.stringify(prev.failures, null, 2)}\n\`\`\`` : '',
  }));
  L.setStatus('accept', { id: m, title: `acceptance ${m} round ${round}` });
  const cond = `The milestone acceptance described in .loop/current-task.md is complete: every user journey of milestone ${m} was exercised on the dev URL and the structured result lists every failure (pass true only if there are none).`;
  const r = await runClaude(L.session, { prompt: goalPrompt(L, cond), phase: 'accept', item: { id: m }, timeoutMin: L.cfg.timeouts.acceptMin, model: L.cfg.reviewModel || L.cfg.model, schema: ACCEPT_SCHEMA });
  L.checkIsolation(r);
  if (r.gaveUp || !r.structured) return null;
  const res = { ...r.structured, milestone: m };
  res.failures = Array.isArray(res.failures) ? res.failures : [];
  res.pass = res.failures.length === 0;
  writeJson(prevFile, res);
  return res;
}

async function packetSession(L, m) {
  const items = L.store.allItems().filter((i) => i.milestone === m);
  fs.mkdirSync(path.join(L.paths.reviews, m), { recursive: true });
  fs.writeFileSync(L.paths.task, L.render('packet.md', {
    MILESTONE: m,
    DEV_URL: L.cfg.deploy.devUrl,
    BYPASS_ENV: L.cfg.deploy.bypassSecretEnv || 'VERCEL_BYPASS',
    ITEM_TABLE: items.map((i) => `- ${i.id} · ${i.title} · ${L.store.st(i.id).status}${L.store.st(i.id).prs?.length ? ` · PR ${L.store.st(i.id).prs.map((p) => '#' + p).join(', ')}` : ''}`).join('\n'),
    OWNER_ACTIONS: L.ownerActionsTail(60),
    ACCEPT_JSON: JSON.stringify({ ...readJson(path.join(L.paths.run, `accept-${m}.json`), { note: 'no acceptance run (no UI items)' }), ...(L.store.S.accept[m]?.unverified ? { fixesNotReAccepted: 'These failures are from the last acceptance round. Their fix items merged through CI and review but were not re-tested on the dev site: say so in the packet.' } : {}) }, null, 2),
  }));
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
  const S = L.store.S;
  for (const m of L.backlog.milestones) {
    if (only && m !== only) continue;
    if (S.packed.includes(m)) continue;
    const inM = L.store.allItems().filter((i) => i.milestone === m);
    if (!inM.length || !inM.every((i) => L.store.settled(i)) || !inM.some((i) => L.store.st(i.id).status === 'done')) continue;
    const a = (S.accept[m] ||= { rounds: 0, passed: false });
    if (inM.some((i) => i.ui) && !a.passed && a.rounds < L.cfg.maxAcceptRounds) {
      L.proc.git('fetch', 'origin', '--prune');
      const sha = L.proc.git('rev-parse', `origin/${L.cfg.base}`);
      const dep = await waitForDeploy(L, sha);
      if (!dep.ok) {
        if (dep.why === 'stopped') return {};
        L.ownerAction(m, `The dev site does not serve the merged ${L.cfg.base} (${dep.why}). Check the deployment, then re-run the loop: acceptance for ${m} runs first.`);
        return { stop: `dev site not serving ${sha.slice(0, 7)}: ${dep.why}` };
      }
      a.rounds++;
      L.store.save();
      const res = await acceptSession(L, m, a.rounds, sha);
      if (L.stopRequested() || L.budgetExceeded()) return {};
      if (res?.pass) {
        a.passed = true;
        L.progress(`${m} · acceptance round ${a.rounds} on dev: **pass**`);
      } else {
        const failures = (res?.failures || []).slice(0, 8);
        if (!res) failures.push({ title: `Acceptance run for ${m} produced no verdict`, scope: 'Re-run the milestone acceptance; check the dev deployment and the health endpoint first.' });
        failures.forEach((f, i) =>
          L.store.addExtra({ kind: 'fix', id: `ACC-${m}-${a.rounds}-${i + 1}`, milestone: m, title: short(f.title || 'acceptance failure', 120), scope: short(`${f.scope || ''} Evidence: ${f.evidence || '-'}${f.relatedItem ? ` (related: ${f.relatedItem})` : ''}`, 1200), refs: [`.loop/accept-${m}.json`, 'DESIGN.md', 'docs/REQUIREMENTS.md', 'loop/prompts/learn.md'], ui: true, dependsOn: [] }),
        );
        for (const x of res?.owner || []) L.ownerAction(m, x);
        L.progress(`${m} · acceptance round ${a.rounds} on dev: **${failures.length} failure(s)** → fix items queued first in line`);
        L.store.save();
        // Fix first. The packet is written only once these items are settled, also after the last
        // round: a packet written before its fixes were built would describe a site that is gone.
        return {};
      }
    }
    if (inM.some((i) => i.ui) && a.rounds > 0 && !a.passed) {
      a.unverified = true;
      L.ownerAction(m, `Milestone ${m}: acceptance still found failures in its last round (${a.rounds} of ${L.cfg.maxAcceptRounds}). Their fix items (ACC-${m}-${a.rounds}-*) went through CI and review, but nothing re-tested them on the dev site. Check them yourself against .loop/accept-${m}.json before you rely on ${m}.`);
      L.progress(`${m} · packed with the last acceptance round's fixes not re-accepted on dev`);
    }
    S.packed.push(m);
    L.store.save();
    await packetSession(L, m);
  }
  return {};
}
