// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// After the merge: what landed, base CI (waited for or in the background), the post-merge steps, and
// the holds an item stays in until the owner or a later run clears them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box } from './helpers/scenario.mjs';

test('post-merge unverified → held, the run stops, and a resumed run verifies and finishes', async () => {
  const sb = box({ config: { postMerge: [{ adapter: 'supabase-cli', dbUrlEnv: 'TEST_DEV_DB_URL', migrationsDir: 'supabase/migrations', holdOnUnverified: true }] }, backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'a', ui: false }, { id: 'A2', milestone: 'M1', title: 'b', ui: false }] } });
  delete sb.env.TEST_DEV_DB_URL;
  sb.queue(smokeStep(), happyItem('A1', { files: { 'supabase/migrations/20260101000000_init.sql': 'create table t (id int);\n' } }));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  let st = sb.state();
  assert.equal(st.items.A1.phase, 'hold');
  assert.equal(st.items.A1.hold.kind, 'postmerge');
  assert.equal(st.items.A2?.rounds ?? 0, 0, 'nothing else started on a schema that is not there');
  assert.match(sb.file('.loop/OWNER-ACTIONS.md'), /Set TEST_DEV_DB_URL/);
  assert.match(sb.file('.loop/REPORT.md'), /Held — merged, not verified \(1\)/);

  sb.env.TEST_DEV_DB_URL = 'postgresql://dev.example.com/postgres';
  sb.queue(smokeStep(), happyItem('A2'));
  const r2 = await sb.run();
  assert.equal(r2.code, 0, r2.stderr);
  st = sb.state();
  assert.equal(st.items.A1.status, 'done');
  assert.equal(st.items.A2.status, 'done');
  assert.deepEqual(sb.supabaseState().remote, ['20260101000000']);
});

test('base CI timeout → held, not passed', async () => {
  const sb = box();
  sb.setGhState((s) => {
    s.baseCiQueue = ['pending'];
    s.rerunQueue = ['pending'];
  });
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  const a = sb.state().items.A1;
  assert.equal(a.phase, 'hold');
  assert.equal(a.hold.kind, 'baseci');
  assert.notEqual(a.status, 'done');
});

test('base CI red → a FIX item goes first in line', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'a' }, { id: 'A2', milestone: 'M1', title: 'b' }] } });
  sb.setGhState((s) => (s.baseCiQueue = ['failure']));
  sb.queue(smokeStep(), happyItem('A1'));
  await sb.run(['--once']);
  const st = sb.state();
  assert.equal(st.items.A1.status, 'done');
  assert.match(st.extra.find((e) => e.kind === 'fix').id, /^FIX-[0-9a-f]{7}$/);
});

test('landed mismatch → held until the owner releases it', async () => {
  const sb = box();
  sb.setGhState((s) => (s.tamperMerge = true));
  sb.queue(smokeStep(), happyItem('A1'));
  await sb.run();
  let a = sb.state().items.A1;
  assert.equal(a.phase, 'hold');
  assert.equal(a.hold.kind, 'landed');
  assert.match(a.hold.why, /TAMPERED\.txt/);

  sb.queue(smokeStep());
  await sb.run(); // re-verifies, still wrong, still held
  assert.equal(sb.state().items.A1.phase, 'hold');

  const rel = await sb.run(['--release', 'A1']);
  assert.equal(rel.code, 0);
  sb.queue(smokeStep());
  await sb.run();
  a = sb.state().items.A1;
  assert.equal(a.status, 'done');
});

test('a PR the session merged itself is held, stays held, and is rebuilt after release', async () => {
  const sb = box();
  const [build] = happyItem('A1');
  const clearStop = () => fs.rmSync(path.join(sb.root, '.loop', 'STOP'), { force: true }); // what the owner does
  sb.queue(smokeStep(), { ...build, ghMerge: true });
  await sb.run();
  assert.match(sb.file('.loop/PROGRESS.md'), /run stopped.*moved outside the runner/);
  assert.match(sb.file('.loop/REPORT.md'), /held \(outside-merge\): PR #1 was already merged/);
  let a = sb.state().items.A1;
  assert.equal(a.phase, 'hold');
  assert.equal(a.hold.kind, 'outside-merge');
  assert.equal(a.attempts, 0, 'an outside merge is not a failed attempt to retry');
  assert.match(sb.file('.loop/OWNER-ACTIONS.md'), /merged by something other than the runner/);
  clearStop();
  sb.queue(smokeStep());
  await sb.run(); // still held: only the owner can clear it
  assert.equal(sb.state().items.A1.phase, 'hold');
  assert.equal((await sb.run(['--release', 'A1'])).code, 0);
  clearStop();
  sb.queue(smokeStep(), happyItem('A1', { branch: 'feat/a1-again', files: { 'src/A1.txt': 'A1, rebuilt through the gates\n' } }));
  await sb.run();
  a = sb.state().items.A1;
  assert.equal(a.status, 'done', `${a.lastError}\n${sb.file('.loop/PROGRESS.md').slice(-1500)}`);
  assert.equal(a.prs.at(-1), 2);
});

const untitledItem = (branch, file) => [
  { commit: { branch, files: { [file]: 'x\n' }, message: 'fix' }, createPr: { title: 'fix' }, result: { outcome: 'ready', pr: '$PR', branch, summary: 'fixed' } },
  { structured: { verdict: 'approve', blocking: [], summary: 'fine' } },
];

test('base CI checked in the background: a red result puts the FIX item before the next item', async () => {
  const sb = box({ config: { baseCiWait: 'unless-tree-equal', milestonePackets: false }, backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'a' }, { id: 'A2', milestone: 'M1', title: 'b' }] } });
  sb.setGhState((s) => (s.baseCiQueue = ['failure']));
  sb.queue(smokeStep(), happyItem('A1'), untitledItem('fix/base', 'src/fix.txt'), happyItem('A2'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const st = sb.state();
  const fix = st.extra.find((e) => e.kind === 'fix');
  assert.match(fix.id, /^FIX-[0-9a-f]{7}$/);
  assert.deepEqual(sb.calls().map((c) => c.item), ['preflight', 'A1', 'A1', fix.id, fix.id, 'A2', 'A2']);
  assert.equal(st.items.A1.status, 'done');
  assert.equal(st.items[fix.id].status, 'done');
  assert.equal(st.items.A2.status, 'done');
  assert.deepEqual(st.pendingBaseCi, []);
  const progress = sb.file('.loop/PROGRESS.md');
  assert.match(progress, /has the tree CI passed on; develop CI is checked in the background/);
  assert.match(progress, /develop CI is RED on [0-9a-f]{7} \(checked in the background\)/);
});

test('base CI checked in the background: no verdict is not a pass, the run stops', async () => {
  const sb = box({ config: { baseCiWait: 'unless-tree-equal' } });
  sb.setGhState((s) => {
    s.baseCiQueue = ['pending'];
    s.rerunQueue = ['pending'];
  });
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const st = sb.state();
  assert.equal(st.pendingBaseCi.length, 1, 'the commit stays pending and is checked first on the next run');
  assert.deepEqual(st.packed, [], 'no milestone is packed on an unverified base');
  assert.match(sb.file('.loop/REPORT.md'), /develop CI gave no verdict for [0-9a-f]{7}/);
  assert.match(sb.file('.loop/OWNER-ACTIONS.md'), /gave no verdict/);
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review']);
});

test('postMergeOnRedBase "wait": migrations are applied only after the fix item made the base green', async () => {
  const sb = box({ config: { postMergeOnRedBase: 'wait', milestonePackets: false, postMerge: [{ adapter: 'supabase-cli', dbUrlEnv: 'TEST_DEV_DB_URL', migrationsDir: 'supabase/migrations', holdOnUnverified: true }] } });
  sb.env.TEST_DEV_DB_URL = 'postgresql://dev.example.com/postgres';
  sb.setGhState((s) => (s.baseCiQueue = ['failure']));
  sb.queue(smokeStep(), happyItem('A1', { files: { 'supabase/migrations/20260101000000_init.sql': 'create table t (id int);\n' } }), untitledItem('fix/base', 'src/fix.txt'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const st = sb.state();
  const fix = st.extra.find((e) => e.kind === 'fix');
  assert.equal(st.items[fix.id].status, 'done');
  assert.equal(st.items.A1.status, 'done');
  assert.deepEqual(sb.supabaseState().remote, ['20260101000000']);
  const progress = sb.file('.loop/PROGRESS.md');
  const waited = progress.indexOf(`A1 · post-merge steps wait for ${fix.id}`);
  const applied = progress.indexOf('post-merge supabase-cli: applied');
  assert.ok(waited > 0 && applied > waited, 'nothing was applied while the base was red');
  assert.match(progress, new RegExp(`A1 · ${fix.id} is done: running the post-merge steps now`));
});

test('base CI in the background: a run a later merge cancelled is re-run, and no FIX item is queued', async () => {
  const sb = box({ config: { baseCiWait: 'unless-tree-equal', milestonePackets: false }, backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'a' }, { id: 'A2', milestone: 'M1', title: 'b' }] } });
  sb.setGhState((s) => (s.baseCiQueue = ['cancelled']));
  sb.queue(smokeStep(), happyItem('A1'), happyItem('A2'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const st = sb.state();
  assert.equal(st.items.A1.status, 'done');
  assert.equal(st.items.A2.status, 'done');
  assert.deepEqual(st.extra.filter((e) => e.kind === 'fix'), [], 'nothing failed, so there is nothing to fix');
  assert.deepEqual(st.pendingBaseCi, []);
  assert.deepEqual(sb.calls().map((c) => c.item), ['preflight', 'A1', 'A1', 'A2', 'A2']);
  assert.ok(sb.ghState().calls.some((c) => c.startsWith('run rerun')));
});
