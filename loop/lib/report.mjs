// .loop/REPORT.md and `--status`.

import fs from 'node:fs';

import { HELD_PHASE, readJson, TERMINAL } from './state.mjs';

const isHeld = (L, i) => L.store.st(i.id).phase === HELD_PHASE && !TERMINAL.has(L.store.st(i.id).status);

export function writeReport(L, reason, runSessions) {
  const items = L.store.allItems();
  const st = L.store.st;
  const by = (status) => items.filter((i) => st(i.id).status === status && !isHeld(L, i));
  const line = (i) => `- **${i.id}** ${i.title}${st(i.id).prs?.length ? ` — PR ${st(i.id).prs.map((p) => '#' + p).join(', ')}` : ''}${st(i.id).lastError && st(i.id).status !== 'done' ? `\n  - ${st(i.id).lastError}` : ''}`;
  const learn = Object.entries(L.store.S.learn || {}).sort((a, b) => b[1].count - a[1].count);
  const sections = [
    `# Loop report\n\n${new Date().toISOString()} — stopped because: **${reason}**\n\nSessions this run: ${runSessions} · total: ${L.store.S.iterations}`,
    `## Held — merged, not verified (${items.filter((i) => isHeld(L, i)).length})\n\n${items.filter((i) => isHeld(L, i)).map((i) => `${line(i)}\n  - hold: ${st(i.id).hold?.kind} — ${st(i.id).hold?.why}`).join('\n') || '—'}`,
    `## Done (${by('done').length})\n\n${by('done').map(line).join('\n') || '—'}`,
    `## Needs you (${by('needs_human').length + by('blocked').length})\n\n${[...by('needs_human'), ...by('blocked')].map(line).join('\n') || '—'}`,
    `## Failed (${by('failed').length})\n\n${by('failed').map(line).join('\n') || '—'}`,
    `## Not started (${by('todo').length + by('in_progress').length})\n\n${[...by('todo'), ...by('in_progress')].map((i) => line(i) + (L.store.settled(i) ? ' — _waiting on an item that did not finish; fix it, then `--reset <id>` and re-run_' : '')).join('\n') || '—'}`,
    `## What went wrong, counted\n\n${learn.map(([sig, e]) => `- \`${sig}\` × ${e.count}${e.queued.length ? ` → ${e.queued.join(', ')}` : ''}`).join('\n') || '—'}`,
    `## Open asks\n\nSee .loop/OWNER-ACTIONS.md. Milestone packets: .loop/reviews/.`,
  ];
  fs.mkdirSync(L.paths.run, { recursive: true });
  fs.writeFileSync(L.paths.report, sections.join('\n\n') + '\n');
}

export function printStatus(L) {
  const items = L.store.allItems();
  const st = L.store.st;
  const counts = {};
  for (const it of items) counts[st(it.id).status] = (counts[st(it.id).status] || 0) + 1;
  console.log(`\nloop — ${items.length} items · ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
  console.log(`sessions so far: ${L.store.S.iterations} · started ${L.store.S.startedAt}\n`);
  let m = '';
  for (const it of items) {
    if (it.milestone !== m) console.log(`\n${(m = it.milestone)}`);
    const s = st(it.id);
    const tail = isHeld(L, it) ? `  HELD (${s.hold?.kind}): ${s.hold?.why}` : s.pr ? `  (open PR #${s.pr}, phase ${s.phase})` : '';
    console.log(`  ${s.status.padEnd(12)} ${it.id.padEnd(12)} ${it.title}${s.prs?.length ? `  [PR ${s.prs.map((p) => '#' + p).join(' ')}]` : ''}${tail}`);
  }
  const cur = readJson(L.paths.status, null);
  if (cur) console.log(`\nnow: ${cur.phase} ${cur.item || ''} since ${cur.since} (pid ${cur.pid})`);
  console.log('');
}
