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
    if (l) ids.push(l.id);
  }
  assert.deepEqual(ids, ['LEARN-1', 'LEARN-2', 'LEARN-3']);
});

test('signatures from a verdict and the guard log', () => {
  assert.deepEqual(reviewSignatures({ blocking: [{ category: 'tests' }, { category: 'tests' }, { category: 'made-up' }] }), ['review:tests', 'review:other']);
  const log = '2026-01-01T00:00:00Z\tA\tbuild\tcore:add-all\tadd explicit paths\n2026-01-01T00:00:01Z\tB\tbuild\tcore:merge\tonly the runner merges\n';
  assert.deepEqual(guardSignatures(log, 'A'), [{ signature: 'guard:core:add-all', detail: 'add explicit paths' }]);
});
