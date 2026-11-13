import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HELD_PHASE, backlogProblems, createState } from '../lib/state.mjs';
import { actionVerdict, applyRetro, earlyRetro, guardSignatures, harnessChanged, isCoarse, nextLearnId, noteItemEnded, recordFailure, renderImpediments, renderMinutes, retroState, reviewSignatures } from '../lib/learn.mjs';

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

test('the same failure in two different items calls a retro; one item on its own does not', () => {
  const S = {};
  const hit = (id, extra = {}) => recordFailure(S, { signature: 'review:tests:untested-branch', detail: `no test in ${id}`, item: { id, milestone: 'M1', ...extra } });
  assert.equal(hit('A'), false);
  // three more rounds on the same item are that item's own trouble, not a pattern
  for (let i = 0; i < 3; i++) assert.equal(hit('A'), false);
  assert.equal(S.retro.due, null);
  assert.equal(hit('B'), true, 'a second item makes it a pattern');
  assert.deepEqual(S.retro.due.signals, ['review:tests:untested-branch']);
  assert.equal(hit('C'), false, 'the retro is already called');
  assert.equal(S.learn['review:tests:untested-branch'].count, 6);
  assert.match(S.learn['review:tests:untested-branch'].details.at(-1), /^C: no test in C/);
});

test("a LEARN item's own failures never call a retro", () => {
  const S = {};
  const sig = 'review:security:regex-ignores-shell-syntax';
  for (const id of ['LEARN-1', 'LEARN-2', 'LEARN-3']) assert.equal(recordFailure(S, { signature: sig, item: { id, kind: 'learn' } }), false);
  assert.equal(S.learn[sig].count, 3, 'they are still counted');
  assert.deepEqual(S.learn[sig].items, []);
  assert.equal(retroState(S).due, null);
});

test('a guard rule or a bare review category is coarse: it needs more items', () => {
  assert.ok(isCoarse('guard:core:read-only') && isCoarse('review:bug'));
  assert.ok(!isCoarse('review:bug:off-by-one') && !isCoarse('ci:lint') && !isCoarse('gate:npm run check') && !isCoarse('premerge'));
  const S = {};
  const hit = (id) => recordFailure(S, { signature: 'review:bug', item: { id }, threshold: 4 });
  assert.deepEqual(['A', 'B', 'C'].map(hit), [false, false, false]);
  assert.equal(hit('D'), true);
});

const retroOut = (over = {}) => ({ summary: 'It went fine.', went_well: [], problems: [], checks: [], actions: [], impediments: [], ...over });
const cfg = { retro: { maxActions: 3, checkAfterItems: 2, maxShare: 0.2 } };

test('a retro becomes one LEARN item for its action items, and the count starts again', () => {
  const S = { extra: [], items: {}, iterations: 9 };
  recordFailure(S, { signature: 'ci:lint', item: { id: 'A' } });
  recordFailure(S, { signature: 'ci:lint', item: { id: 'B' } });
  const res = applyRetro(S, retroOut({
    went_well: [{ practice: 'Contracts list a proof per criterion', evidence: 'A, B merged at the first attempt', keep: true }],
    problems: [{ title: 'Lint fails in CI', evidence: 'PR 2, PR 3', cause: 'the local gate does not run lint', owner: 'practice', signal: 'ci:lint' }],
    actions: [{ title: 'Run lint before pushing', rung: 'lesson', what: 'Add a lesson row', expect: 'no ci:lint in the next five items', done_when: 'npm run lint exits 0', signal: 'ci:lint' }, { title: 'no what' }],
  }), { id: 'R-01', kind: 'early', milestone: 'M1', cfg, at: '2026-01-01T00:00:00.000Z', covers: '2 items' });
  assert.equal(res.learn.id, 'LEARN-1');
  assert.deepEqual([res.learn.kind, res.learn.retro, res.learn.milestone], ['learn', 'R-01', 'M1']);
  assert.match(res.learn.scope, /A-1 \(lesson\): Run lint before pushing/);
  assert.match(res.learn.scope, /Keep doing/);
  assert.ok(res.learn.refs.includes('.loop/retros/R-01.md'));
  assert.deepEqual(S.retro.actions.map((a) => [a.id, a.learn, a.signal, a.status, a.since]), [['A-1', 'LEARN-1', 'ci:lint', 'open', null]]);
  assert.deepEqual(S.learn['ci:lint'].items, [], 'it was on the table');
  assert.equal(S.retro.due, null);
  assert.equal(S.retro.n, 1);
  // not a pattern again until two more items hit it
  assert.equal(recordFailure(S, { signature: 'ci:lint', item: { id: 'C' } }), false);
  const minutes = renderMinutes(res.retro);
  assert.match(minutes, /# Retro R-01, called early/);
  assert.match(minutes, /## What went well: keep doing[\s\S]*Contracts list a proof per criterion/);
  assert.match(minutes, /\| A-1 Run lint before pushing \| lesson \|/);
  assert.match(minutes, /Carried out by LEARN-1/);
});

test('a retro with nothing for the repository queues nothing, except at the end of a milestone', () => {
  const early = applyRetro({ extra: [], items: {} }, retroOut(), { id: 'R-01', kind: 'early', milestone: 'M1', cfg });
  assert.equal(early.learn, null);
  const S = { extra: [], items: { 'LEARN-6': { status: 'done' } } };
  const end = applyRetro(S, retroOut(), { id: 'R-01', kind: 'milestone', milestone: 'M1', cfg });
  assert.equal(end.learn.id, 'LEARN-7', 'numbered after every LEARN item the state has seen');
  assert.match(end.learn.title, /file the minutes/);
  assert.equal(S.retro.milestones.M1, 'R-01');
});

test('an impediment is for the owner: its signal stops calling retros, and it is reported once', () => {
  const S = { extra: [], items: {} };
  const block = (id) => recordFailure(S, { signature: 'guard:core:read-only', detail: 'redirect output only into .loop/', item: { id }, threshold: 2 });
  block('A');
  assert.equal(block('B'), true);
  const imp = { title: 'The guard refuses every append', part: 'guard', evidence: '9 blocks in review', example: 'printf x >> .loop/a.txt', wanted: 'allow >> into .loop/', signal: 'guard:core:read-only' };
  const res = applyRetro(S, retroOut({ impediments: [imp, { title: 'made-up signal', part: 'runner', evidence: 'e', wanted: 'w', signal: 'nope' }] }), { id: 'R-01', kind: 'early', cfg });
  assert.deepEqual(res.impediments.map((i) => [i.id, i.signal, i.status]), [['IMP-1', 'guard:core:read-only', 'open'], ['IMP-2', null, 'open']]);
  assert.equal(res.learn, null, 'nothing to build: the loop does not work around the harness');
  assert.deepEqual(S.learn['guard:core:read-only'].muted, { by: 'IMP-1' });
  assert.equal(block('C'), false);
  assert.equal(block('D'), false);
  assert.equal(S.retro.due, null);
  const again = applyRetro(S, retroOut({ impediments: [imp] }), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual(again.impediments, []);
  assert.match(again.dropped[0], /already reported/);
  assert.match(renderImpediments(S), /\| IMP-1 \| open \| guard \| The guard refuses every append \|/);
  assert.match(renderMinutes(res.retro), /`printf x >> \.loop\/a\.txt`/);
});

test('an action item is measured, and the next retro closes, revises or retires it', () => {
  const S = { extra: [], items: {} };
  const out = (signal) => retroOut({ actions: [{ title: `stop ${signal}`, rung: 'lesson', what: 'w', expect: 'e', done_when: 'd', signal }] });
  for (const sig of ['ci:lint', 'ci:types']) for (const id of ['A', 'B']) recordFailure(S, { signature: sig, item: { id } });
  applyRetro(S, retroOut({ actions: [...out('ci:lint').actions, ...out('ci:types').actions] }), { id: 'R-01', kind: 'early', cfg });
  const [lint, types] = S.retro.actions;
  assert.equal(actionVerdict(lint, cfg), 'not merged yet');
  // before the LEARN item merged, nothing is measured
  recordFailure(S, { signature: 'ci:lint', item: { id: 'C' } });
  noteItemEnded(S, { id: 'C' }, 'done');
  assert.deepEqual([lint.hits, lint.itemsSince], [[], []]);
  noteItemEnded(S, { id: 'LEARN-1', kind: 'learn' }, 'done');
  assert.ok(lint.since && types.since);
  assert.equal(actionVerdict(lint, cfg), 'too early');
  for (const id of ['D', 'E']) {
    recordFailure(S, { signature: 'ci:types', item: { id } });
    recordFailure(S, { signature: 'ci:types', item: { id } }); // twice in one item is one hit
    noteItemEnded(S, { id }, 'done');
  }
  assert.equal(actionVerdict(lint, cfg), 'worked');
  assert.equal(actionVerdict(types, cfg), 'no effect');
  assert.deepEqual(types.hits, ['D', 'E']);
  const res = applyRetro(S, retroOut({ checks: [{ action: 'A-1', verdict: 'worked', decision: 'keep' }, { action: 'A-2', verdict: 'no_effect', decision: 'retire', note: 'a lesson cannot hold this' }, { action: 'A-9', verdict: 'worked', decision: 'keep' }] }), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual(S.retro.actions.map((a) => a.status), ['worked', 'retired']);
  assert.deepEqual(res.checks.map((c) => [c.action, c.itemsSince, c.hits]), [['A-1', 2, 0], ['A-2', 2, 2]]);
  assert.match(res.learn.scope, /A-2 "stop ci:types": take it back\. a lesson cannot hold this/);
  assert.match(renderMinutes(res.retro), /\| A-2 stop ci:types \| 2 \| 2 \| no effect \| retire \|/);
});

test('a LEARN item that does not merge drops its action items', () => {
  const S = { extra: [], items: {} };
  applyRetro(S, retroOut({ actions: [{ title: 't', rung: 'test', what: 'w', expect: 'e', done_when: 'd' }] }), { id: 'R-01', kind: 'early', cfg });
  noteItemEnded(S, { id: 'LEARN-1', kind: 'learn' }, 'needs_human');
  assert.deepEqual([S.retro.actions[0].status, S.retro.actions[0].note], ['dropped', 'LEARN-1 ended needs_human']);
});

test('a retro hands out a few action items, and a signal that keeps coming back goes to the owner', () => {
  const S = { extra: [], items: {} };
  recordFailure(S, { signature: 'ci:lint', item: { id: 'A' } });
  const act = (n, signal) => ({ title: `action ${n}`, rung: 'lesson', what: 'w', expect: 'e', done_when: 'd', signal });
  const first = applyRetro(S, retroOut({ actions: [1, 2, 3, 4].map((n) => act(n)) }), { id: 'R-01', kind: 'early', cfg });
  assert.equal(first.retro.actions.length, 3);
  assert.match(first.dropped[0], /at most 3/);
  for (const id of ['R-02', 'R-03', 'R-04']) applyRetro(S, retroOut({ actions: [act(id, 'ci:lint')] }), { id, kind: 'early', cfg });
  const last = applyRetro(S, retroOut({ actions: [act('one more', 'ci:lint')] }), { id: 'R-05', kind: 'early', cfg });
  assert.deepEqual(last.escalated, ['ci:lint']);
  assert.equal(last.learn, null);
  assert.deepEqual(S.learn['ci:lint'].muted, { by: 'owner' });
  assert.match(renderMinutes(last.retro), /## Given to the owner[\s\S]*`ci:lint`/);
});

test('an early retro waits for the open LEARN item, and stops once learning used its share', () => {
  const S = { extra: [], items: {}, iterations: 12 };
  assert.deepEqual(earlyRetro(S, cfg), { due: false });
  for (const id of ['A', 'B']) recordFailure(S, { signature: 'ci:lint', item: { id } });
  assert.deepEqual(earlyRetro(S, cfg).signals, ['ci:lint']);
  S.extra.push({ kind: 'learn', id: 'LEARN-1' });
  S.items['LEARN-1'] = { status: 'in_progress' };
  assert.match(earlyRetro(S, cfg).wait, /LEARN-1 is not finished/);
  S.items['LEARN-1'].status = 'done';
  S.retro.sessions = 3;
  assert.match(earlyRetro(S, cfg).wait, /learning has used 3 of 12 sessions/);
  S.iterations = 27; // 3 + 3 fits into a fifth of 30
  assert.ok(earlyRetro(S, cfg).signals);
});

test('after a sync from the template the reported signals count again, and the numbers settle the impediment', () => {
  const S = { extra: [], items: {}, iterations: 10 };
  assert.deepEqual(harnessChanged(S, 'aaa'), [], 'the first run only notes the version');
  for (const id of ['A', 'B']) for (const sig of ['guard:core:read-only', 'guard:core:protected-path']) recordFailure(S, { signature: sig, item: { id } });
  applyRetro(S, retroOut({ impediments: ['guard:core:read-only', 'guard:core:protected-path'].map((signal) => ({ title: signal, part: 'guard', evidence: 'e', wanted: 'w', signal })) }), { id: 'R-01', kind: 'early', cfg });
  assert.deepEqual(harnessChanged(S, 'aaa'), []);
  assert.deepEqual(harnessChanged(S, 'bbb').map((i) => i.id), ['IMP-1', 'IMP-2']);
  assert.equal(S.learn['guard:core:read-only'].muted, undefined);
  assert.deepEqual(S.retro.impediments.map((i) => i.status), ['recheck', 'recheck']);
  // too soon after the change: nothing is settled yet
  applyRetro(S, retroOut(), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual(S.retro.impediments.map((i) => i.status), ['recheck', 'recheck']);
  S.iterations = 20;
  recordFailure(S, { signature: 'guard:core:protected-path', item: { id: 'C' } });
  applyRetro(S, retroOut(), { id: 'R-03', kind: 'early', cfg });
  assert.deepEqual(S.retro.impediments.map((i) => i.status), ['closed', 'open'], 'one is gone, one is still there');
  assert.deepEqual(S.learn['guard:core:protected-path'].muted, { by: 'IMP-2' });
});

test('a retro inside the recheck window does not wipe out that the signal came back', () => {
  const S = { extra: [], items: {}, iterations: 10 };
  harnessChanged(S, 'aaa');
  for (const id of ['A', 'B']) recordFailure(S, { signature: 'guard:core:read-only', item: { id } });
  applyRetro(S, retroOut({ impediments: [{ title: 't', part: 'guard', evidence: 'e', wanted: 'w', signal: 'guard:core:read-only' }] }), { id: 'R-01', kind: 'early', cfg });
  harnessChanged(S, 'bbb');
  // it comes back on the new harness, in one item and in a LEARN item (which does not count)
  S.iterations = 12;
  recordFailure(S, { signature: 'guard:core:read-only', item: { id: 'C' } });
  recordFailure(S, { signature: 'guard:core:read-only', item: { id: 'LEARN-1', kind: 'learn' } });
  assert.deepEqual(S.retro.impediments[0].back, ['C']);
  // a milestone retro before the window ends starts the per-signal count again, and reopens it at once
  applyRetro(S, retroOut(), { id: 'R-02', kind: 'milestone', milestone: 'M1', cfg });
  assert.deepEqual(S.learn['guard:core:read-only'].items, []);
  assert.equal(S.retro.impediments[0].status, 'open');
  assert.deepEqual(S.learn['guard:core:read-only'].muted, { by: 'IMP-1' });
  S.iterations = 30;
  applyRetro(S, retroOut(), { id: 'R-03', kind: 'early', cfg });
  assert.equal(S.retro.impediments[0].status, 'open', 'still open after the window');
});

test('a second harness change before the next retro starts the recheck again', () => {
  const S = { extra: [], items: {}, iterations: 10 };
  harnessChanged(S, 'v1');
  for (const id of ['A', 'B']) recordFailure(S, { signature: 'guard:core:read-only', item: { id } });
  applyRetro(S, retroOut({ impediments: [{ title: 't', part: 'guard', evidence: 'e', wanted: 'w', signal: 'guard:core:read-only' }] }), { id: 'R-01', kind: 'early', cfg });
  harnessChanged(S, 'v2');
  S.iterations = 13;
  recordFailure(S, { signature: 'guard:core:read-only', item: { id: 'C' } }); // still there on v2
  assert.deepEqual(harnessChanged(S, 'v3').map((i) => i.id), ['IMP-1'], 'v3 is judged on its own');
  assert.deepEqual([S.retro.impediments[0].back, S.retro.impediments[0].recheckAt], [[], 13]);
  S.iterations = 16;
  applyRetro(S, retroOut(), { id: 'R-02', kind: 'early', cfg });
  assert.equal(S.retro.impediments[0].status, 'recheck', 'three sessions on v3 are too few to close it, and nothing reopens it');
  S.iterations = 20;
  applyRetro(S, retroOut(), { id: 'R-03', kind: 'early', cfg });
  assert.equal(S.retro.impediments[0].status, 'closed');
  assert.equal(S.learn['guard:core:read-only'].muted, undefined);
});

test('a state written before retros existed is read as it is', () => {
  const S = { extra: [{ kind: 'learn', id: 'LEARN-2' }], items: { 'LEARN-2': { status: 'done' } }, learn: { 'guard:core:read-only': { count: 5, sinceLearn: 0, details: ['x'], queued: ['LEARN-2'] } } };
  assert.equal(nextLearnId(S), 'LEARN-3');
  assert.equal(recordFailure(S, { signature: 'guard:core:read-only', item: { id: 'A' } }), false);
  assert.deepEqual(S.learn['guard:core:read-only'].items, ['A']);
  assert.deepEqual(retroState(S).actions, []);
});

test('signatures from a verdict and the guard log', () => {
  assert.deepEqual(reviewSignatures({ blocking: [{ category: 'tests' }, { category: 'tests' }, { category: 'made-up' }] }), ['review:tests', 'review:other']);
  const log = '2026-01-01T00:00:00Z\tA\tbuild\tcore:add-all\tadd explicit paths\tgit add -A\n2026-01-01T00:00:01Z\tB\tbuild\tcore:merge\tonly the runner merges\n';
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
