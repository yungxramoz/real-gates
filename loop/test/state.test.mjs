import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HELD_PHASE, backlogProblems, createState } from '../lib/state.mjs';
import { guardSignatures, recordFailure, reviewSignatures } from '../lib/learn.mjs';

const backlog = {
  milestones: ['M1', 'M2'],
  items: [
    { id: 'A', milestone: 'M1', title: 'a' },
    { id: 'B', milestone: 'M1', title: 'b', dependsOn: ['A'] },
    { id: 'C', milestone: 'M2', title: 'c' },
  ],
};
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-state-')), 'state.json');

test('fix and learn items come before milestone items', () => {
  const s = createState(file(), backlog);
  s.addExtra({ kind: 'learn', id: 'LEARN-1', milestone: 'M1', title: 'l' });
  s.addExtra({ kind: 'fix', id: 'FIX-abc', milestone: 'M1', title: 'f' });
  assert.deepEqual(s.allItems().map((i) => i.id), ['FIX-abc', 'LEARN-1', 'A', 'B', 'C']);
  assert.equal(s.pickNext().id, 'FIX-abc');
});

test('dependencies wait until done', () => {
  const s = createState(file(), backlog);
  assert.equal(s.pickNext({ item: 'B' }).none, true);
  s.st('A').status = 'done';
  assert.equal(s.pickNext({ item: 'B' }).id, 'B');
});

test('an item whose dependency failed is settled, not waiting forever', () => {
  const s = createState(file(), backlog);
  s.st('A').status = 'failed';
  assert.equal(s.settled(backlog.items[1]), true);
});

test('held item wins over --item and --only', () => {
  const s = createState(file(), backlog);
  s.st('A').phase = HELD_PHASE;
  s.st('A').status = 'in_progress';
  assert.equal(s.pickNext({ item: 'C' }).id, 'A');
  assert.equal(s.pickNext({ only: 'M2' }).id, 'A');
});

test('--only keeps fix and learn items eligible', () => {
  const s = createState(file(), backlog);
  s.addExtra({ kind: 'learn', id: 'LEARN-1', milestone: 'M1', title: 'l' });
  assert.equal(s.pickNext({ only: 'M2' }).id, 'LEARN-1');
});

test('state survives a reload, a dry run writes nothing', () => {
  const f = file();
  const s = createState(f, backlog);
  s.st('A').status = 'done';
  s.save();
  assert.equal(createState(f, backlog).st('A').status, 'done');
  const d = createState(f, backlog, { dry: true });
  d.st('C').status = 'done';
  d.save();
  assert.equal(createState(f, backlog).st('C').status, 'todo');
});

test('backlog problems are named', () => {
  assert.deepEqual(backlogProblems(backlog), []);
  const p = backlogProblems({ milestones: ['M1'], items: [{ id: 'X', milestone: 'M1', title: 'x', dependsOn: ['Y'] }, { id: 'LEARN-1', milestone: 'M1', title: 'l' }] });
  assert.ok(p.some((x) => /unknown Y/.test(x)));
  assert.ok(p.some((x) => /reserved/.test(x)));
});

test('same review finding twice queues one LEARN', () => {
  const S = {};
  assert.equal(recordFailure(S, { signature: 'review:tests', detail: 'no test for x', item: { id: 'A', milestone: 'M1' } }), null);
  const l = recordFailure(S, { signature: 'review:tests', detail: 'no test for y', item: { id: 'B', milestone: 'M1' } });
  assert.equal(l.id, 'LEARN-1');
  assert.equal(l.kind, 'learn');
  assert.match(l.scope, /A: no test for x/);
  assert.match(l.scope, /B: no test for y/);
});

test('third repeat does not queue a second LEARN, a further pair does', () => {
  const S = {};
  const hit = () => recordFailure(S, { signature: 'guard:core:add-all', detail: 'git add -A', item: { id: 'A' } });
  hit();
  assert.ok(hit());
  // while LEARN-1 is open, more of the same queues nothing, however many
  for (let i = 0; i < 6; i++) assert.equal(hit(), null);
  // once it has ended, a first repeat is not yet a pattern; the second is
  S.items = { 'LEARN-1': { status: 'done' } };
  assert.equal(hit(), null);
  const again = hit();
  assert.equal(again.id, 'LEARN-2');
  assert.match(again.scope, /did not stop it/);
});

test('at most three LEARN items per signature', () => {
  const S = {};
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const l = recordFailure(S, { signature: 'ci:lint', item: { id: 'A' } });
    if (!l) continue;
    ids.push(l.id);
    (S.items ||= {})[l.id] = { status: 'needs_human' }; // each one ends without stopping it
  }
  assert.deepEqual(ids, ['LEARN-1', 'LEARN-2', 'LEARN-3']);
});

test('signatures from a verdict and the guard log', () => {
  assert.deepEqual(reviewSignatures({ blocking: [{ category: 'tests' }, { category: 'tests' }, { category: 'made-up' }] }), ['review:tests', 'review:other']);
  const log = '2026-01-01T00:00:00Z\tA\tbuild\tcore:add-all\tadd explicit paths\n2026-01-01T00:00:01Z\tB\tbuild\tcore:merge\tonly the runner merges\n';
  assert.deepEqual(guardSignatures(log, 'A'), [{ signature: 'guard:core:add-all', detail: 'add explicit paths' }]);
});

test('a review finding counts by category and by category with its cause', async () => {
  const { causeKey, knownCauses, reviewFailures } = await import('../lib/learn.mjs');
  assert.equal(causeKey('  Untested Branch!! '), 'untested-branch');
  assert.equal(causeKey(undefined), '');
  const f = reviewFailures({ blocking: [{ category: 'tests', cause: 'Untested branch', issue: 'a' }, { category: 'tests', cause: 'untested-branch', issue: 'b' }, { category: 'bug', issue: 'c' }, { category: 'made-up', cause: 'x y', issue: 'd' }] });
  assert.deepEqual(f.map((x) => [x.signature, x.level, x.issues.length]), [['review:tests', 'category', 2], ['review:tests:untested-branch', 'cause', 2], ['review:bug', 'category', 1], ['review:other', 'category', 1], ['review:other:x-y', 'cause', 1]]);
  assert.deepEqual(knownCauses({ learn: { 'review:tests': { count: 9 }, 'review:tests:untested-branch': { count: 1 }, 'review:bug:off-by-one': { count: 3 }, 'guard:core:add-all': { count: 5 } } }), ['bug/off-by-one', 'tests/untested-branch']);
});

test('two findings that share only a category are not a pattern; four are', () => {
  const S = {};
  const hit = () => recordFailure(S, { signature: 'review:bug', item: { id: 'A' }, threshold: 4 });
  assert.equal(hit(), null);
  assert.equal(hit(), null);
  assert.equal(hit(), null);
  assert.equal(hit().id, 'LEARN-1');
});

test('an item whose post-merge steps wait for a fix item is not picked until that item is settled', () => {
  const store = createState(path.join(os.tmpdir(), `rg-state-${process.pid}-wait.json`), { milestones: ['M1'], items: [{ id: 'A', milestone: 'M1', title: 'a' }, { id: 'B', milestone: 'M1', title: 'b' }] }, { dry: true });
  store.S.extra.push({ kind: 'fix', id: 'FIX-1', milestone: 'M1', title: 'fix' });
  Object.assign(store.st('A'), { status: 'in_progress', phase: 'postmerge', redBase: { fix: 'FIX-1' } });
  assert.equal(store.pickNext().id, 'FIX-1');
  // with the fix item filtered out, A is waiting, not eligible
  const only = store.pickNext({ item: 'A' });
  assert.equal(only.none, true);
  assert.match(only.waiting[0], /A ← FIX-1:todo \(base is red\)/);
  store.st('FIX-1').status = 'done';
  assert.equal(store.pickNext().id, 'A');
});
