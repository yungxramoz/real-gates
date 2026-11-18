import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HELD_PHASE, backlogProblems, createState, readJson, writeJson } from '../lib/state.mjs';
import { noteHarness } from '../lib/retro.mjs';
import { actionVerdict, applyRetro, earlyRetro, guardSignatures, harnessChanged, isCoarse, isGuard, nextLearnId, noteAcceptanceFailed, noteItemEnded, recordFailure, renderImpediments, renderMinutes, retroState, reviewSignatures, sameTitle } from '../lib/learn.mjs';

const backlog = {
  milestones: ['M1', 'M2'],
  items: [
    { id: 'A', milestone: 'M1', title: 'a' },
    { id: 'B', milestone: 'M1', title: 'b', dependsOn: ['A'] },
    { id: 'C', milestone: 'M2', title: 'c' },
  ],
};
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-state-')), 'state.json');

test('a state file another process holds for a moment is written on a later try', () => {
  const target = file();
  writeJson(target, { n: 1 });
  const real = fs.renameSync;
  let calls = 0;
  const held = mock.method(fs, 'renameSync', (...args) => {
    if (++calls <= 2) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return real(...args);
  });
  try {
    writeJson(target, { n: 2 });
    assert.deepEqual([calls, readJson(target)], [3, { n: 2 }]);
    // any other failure is not waited on, and one that never lets go is reported
    held.mock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    assert.throws(() => writeJson(target, { n: 3 }), { code: 'ENOENT' });
    let tries = 0;
    held.mock.mockImplementation(() => {
      tries++;
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    assert.throws(() => writeJson(target, { n: 4 }), { code: 'EBUSY' });
    assert.equal(tries, 10);
  } finally {
    held.mock.restore();
  }
  assert.deepEqual(readJson(target), { n: 2 }, 'a write that failed leaves the file as it was');
});

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

test('a guard refusal is the guard working: counted, and never a retro, a problem to settle or an impediment', () => {
  const S = { extra: [], items: {} };
  const block = (id, rule = 'core:read-only') => recordFailure(S, { signature: `guard:${rule}`, detail: 'redirect output only into .loop/', item: { id }, threshold: 2 });
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) assert.equal(block(id), false, `${id}: a refusal never calls a retro`);
  assert.equal(block('A', 'core:add-all'), false);
  assert.equal(retroState(S).due, null);
  assert.equal(earlyRetro(S, cfg).due, false);
  assert.equal(S.learn['guard:core:read-only'].count, 8, 'the count is kept: the retro shows it as a cost');
  assert.deepEqual(S.learn['guard:core:read-only'].items, [], 'and it is not on the list of signals a retro has to settle');
  assert.ok(isGuard('guard:core:read-only') && !isGuard('review:bug') && !isGuard(undefined));
  // a retro that reports one all the same: not recorded, by part or by signal
  const res = applyRetro(S, retroOut({ impediments: [
    { title: 'The guard refuses every append', part: 'guard', broke: 'nothing', evidence: '9 blocks in review', example: 'printf x >> .loop/a.txt', wanted: 'allow it', signal: 'guard:core:read-only' },
    { title: 'A rule refuses a harmless line', part: 'other', broke: 'nothing', evidence: 'e', wanted: 'w', signal: 'guard:core:add-all' },
  ] }), { id: 'R-01', kind: 'early', cfg });
  assert.deepEqual(res.impediments, []);
  assert.deepEqual(retroState(S).impediments, []);
  assert.equal(res.dropped.length, 2);
  assert.match(res.dropped[0], /a refusal is the guard working, it is not recorded/);
  assert.equal(S.learn['guard:core:read-only'].muted, undefined);
  assert.doesNotMatch(renderImpediments(S), /IMP-/);
});

test('an impediment is recorded once: its signal stops calling retros, and meeting it again only raises its count', () => {
  const S = { extra: [], items: {} };
  const red = (id) => recordFailure(S, { signature: 'ci:e2e', detail: 'the job has no browser', item: { id }, threshold: 2 });
  red('A');
  assert.equal(red('B'), true);
  const e2e = { title: 'The e2e job starts without a browser', part: 'ci', broke: 'A and B went through two fix rounds for nothing', evidence: 'ci:e2e in A and B', example: 'Executable does not exist', wanted: 'install the browser in the job', signal: 'ci:e2e' };
  const crash = { title: 'The runner crashes on a transient git fetch network error', part: 'runner', broke: 'the run stopped for 40 minutes', evidence: 'PROGRESS.md 13:02', wanted: 'retry the fetch', signal: 'nope' };
  const res = applyRetro(S, retroOut({ impediments: [e2e, crash] }), { id: 'R-01', kind: 'early', cfg });
  assert.deepEqual(res.impediments.map((i) => [i.id, i.signal, i.status, i.seen]), [['IMP-1', 'ci:e2e', 'open', 1], ['IMP-2', null, 'open', 1]]);
  assert.equal(res.learn, null, 'nothing to build: the loop does not work around the harness');
  assert.deepEqual(S.learn['ci:e2e'].muted, { by: 'IMP-1' });
  assert.equal(red('C'), false);
  assert.equal(red('D'), false);
  assert.equal(S.retro.due, null);
  // the next retro meets all of it again: by signal, by id, and under other words for the same thing
  const again = applyRetro(S, retroOut({ impediments: [
    { ...e2e, title: 'e2e is red on every pull request', example: 'browserType.launch: Executable does not exist' },
    { title: 'something else entirely', part: 'other', broke: 'b', evidence: 'e', wanted: 'w', same_as: 'IMP-2' },
    { title: 'Runner crash when git fetch fails with a network error', part: 'runner', broke: 'b', evidence: 'e', wanted: 'w' },
  ] }), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual(again.impediments, [], 'no second entry for a known cause');
  assert.deepEqual(again.seenAgain.map((i) => [i.id, i.seen, i.lastRetro]), [['IMP-1', 2, 'R-02'], ['IMP-2', 2, 'R-02']], 'one retro counts one meeting, however often it names it');
  assert.equal(S.retro.impediments.length, 2);
  assert.equal(S.retro.impediments[0].example, 'browserType.launch: Executable does not exist', 'the newest example is kept');
  // another cause in the same part is a new entry
  const other = applyRetro(S, retroOut({ impediments: [{ title: 'The retro minutes cut off the action item text', part: 'runner', broke: 'LEARN-7 had to guess', evidence: 'e', wanted: 'w' }] }), { id: 'R-03', kind: 'early', cfg });
  assert.deepEqual(other.impediments.map((i) => i.id), ['IMP-3']);
  const page = renderImpediments(S);
  assert.match(page, /\| IMP-1 \| open \| ci \| The e2e job starts without a browser \|.*\| ci:e2e \| R-01 \| 2 \| R-02 \|/);
  assert.match(page, /This is a record, not a to-do list: nothing in the run waits for it/);
  const minutes = renderMinutes(again.retro);
  assert.match(minutes, /## Impediments\n\nDefects in the harness that broke something/);
  assert.match(minutes, /Met again, already on the list: IMP-1 \(2 times\), IMP-2 \(2 times\)\./);
  assert.match(renderMinutes(res.retro), /\| IMP-1 The e2e job starts without a browser \| ci \|.*Executable does not exist`/);
  assert.doesNotMatch(renderMinutes(res.retro), /for the owner|Met again/);
});

test('two titles name the same thing only on strong evidence: three meaningful words, and most of the shorter title', () => {
  assert.ok(sameTitle('The runner crashes on a transient git fetch network error', 'Runner crash when git fetch fails with a network error'));
  assert.ok(sameTitle('Retro minutes cut off the action item text', 'The retro minutes cut off action item text and lose characters'));
  assert.ok(sameTitle('The retro packet reports finished items as open', 'The retro packet reports finished items as open again'));
  assert.ok(!sameTitle('The retro packet reports finished items as open', 'Retro minutes lose invisible characters'));
  // the same sentence about another thing is another defect
  assert.ok(!sameTitle('The e2e job starts without a browser', 'The unit job starts without a database'));
  assert.ok(!sameTitle('The runner crashes on a failed fetch', 'The runner crashes on a full disk'));
  assert.ok(!sameTitle('', 'x') && !sameTitle('a b c', 'a b c') && !sameTitle('runner crash', 'runner crash'), 'too few words to tell');
});

test('two defects with a signal each are two causes, however alike their titles read', () => {
  const S = { extra: [], items: {} };
  for (const sig of ['ci:e2e', 'ci:unit']) for (const id of ['A', 'B']) recordFailure(S, { signature: sig, item: { id } });
  const job = (name, needs, signal) => ({ title: `The ${name} job starts without the ${needs} it needs to run the suite`, part: 'ci', broke: 'two fix rounds for nothing', evidence: `${signal} in A and B`, example: `${needs} missing`, wanted: `start the ${needs} in the job`, signal });
  assert.ok(sameTitle(job('e2e', 'browser').title, job('unit', 'database').title), 'the words alone would take them for one');
  const res = applyRetro(S, retroOut({ impediments: [job('e2e', 'browser', 'ci:e2e'), job('unit', 'database', 'ci:unit')] }), { id: 'R-01', kind: 'early', cfg });
  assert.deepEqual(res.impediments.map((i) => [i.id, i.signal, i.wanted]), [['IMP-1', 'ci:e2e', 'start the browser in the job'], ['IMP-2', 'ci:unit', 'start the database in the job']]);
  assert.deepEqual(res.seenAgain, []);
  assert.deepEqual([S.learn['ci:e2e'].muted, S.learn['ci:unit'].muted], [{ by: 'IMP-1' }, { by: 'IMP-2' }], 'both stop calling retros');
  // an entry recorded before its signal was known takes the signal when it is met again by its words
  const T = { extra: [], items: {} };
  applyRetro(T, retroOut({ impediments: [{ ...job('e2e', 'browser'), signal: undefined }] }), { id: 'R-01', kind: 'early', cfg });
  for (const id of ['A', 'B']) recordFailure(T, { signature: 'ci:e2e', item: { id } });
  const again = applyRetro(T, retroOut({ impediments: [job('e2e', 'browser', 'ci:e2e')] }), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual([again.impediments.length, T.retro.impediments[0].signal, T.retro.impediments[0].seen, T.learn['ci:e2e'].muted], [0, 'ci:e2e', 2, { by: 'IMP-1' }]);
  // and one with another signal is still another cause
  for (const id of ['A', 'B']) recordFailure(T, { signature: 'ci:unit', item: { id } });
  assert.deepEqual(applyRetro(T, retroOut({ impediments: [job('unit', 'database', 'ci:unit')] }), { id: 'R-03', kind: 'early', cfg }).impediments.map((i) => i.id), ['IMP-2']);
});

test('at a run start on a new harness the impediment page says what the state says, also when entries were only closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-harness-'));
  try {
    fs.mkdirSync(path.join(root, 'loop'), { recursive: true });
    fs.mkdirSync(path.join(root, '.loop'), { recursive: true });
    const lock = (commit) => fs.writeFileSync(path.join(root, 'loop', 'template.lock.json'), JSON.stringify({ commit }));
    const page = () => fs.readFileSync(path.join(root, '.loop', 'IMPEDIMENTS.md'), 'utf8');
    const S = { extra: [], items: {}, iterations: 12, learn: { 'guard:core:read-only': { count: 9, items: [], muted: { by: 'IMP-1' } } } };
    const r = retroState(S);
    r.harness = 'old';
    r.impediments.push({ id: 'IMP-1', retro: 'R-01', status: 'open', part: 'guard', title: 'The read-only rule refuses an append', signal: 'guard:core:read-only' }, { id: 'IMP-2', retro: 'R-01', status: 'open', part: 'guard', title: 'A relative path is not resolved', signal: null });
    const said = [];
    let saved = 0;
    const L = { root, paths: { run: path.join(root, '.loop') }, store: { S, save: () => saved++ }, progress: (l) => said.push(l) };
    fs.writeFileSync(path.join(root, '.loop', 'IMPEDIMENTS.md'), renderImpediments(S));
    assert.match(page(), /\| IMP-1 \| open \| guard \|/);
    // the only entries are for the guard: the change closes them, nothing waits, and the page is written again
    lock('new');
    noteHarness(L);
    assert.deepEqual(r.impediments.map((i) => i.status), ['closed', 'closed']);
    assert.doesNotMatch(page(), /IMP-1|IMP-2/);
    assert.match(page(), /2 closed\./);
    assert.deepEqual(said, ['the harness changed since the last run: IMP-1, IMP-2 are closed (a refusal is the guard working)']);
    assert.equal(saved, 1);
    // the same harness again: nothing is said and nothing is written
    fs.rmSync(path.join(root, '.loop', 'IMPEDIMENTS.md'));
    noteHarness(L);
    assert.equal(said.length, 1);
    assert.equal(fs.existsSync(path.join(root, '.loop', 'IMPEDIMENTS.md')), false);
    // a defect waits for the numbers, and both kinds are said in one line
    r.impediments.push({ id: 'IMP-3', retro: 'R-02', status: 'open', part: 'runner', title: 'The runner crashes when a fetch fails', signal: null }, { id: 'IMP-4', retro: 'R-02', status: 'open', part: 'guard', title: 'left by an older harness', signal: null });
    lock('newer');
    noteHarness(L);
    assert.equal(said[1], 'the harness changed since the last run: IMP-3 waits for the numbers (closed when the cause stays away, open again when it comes back); IMP-4 is closed (a refusal is the guard working)');
    assert.match(page(), /\| IMP-3 \| recheck \| runner \|/);
    assert.match(page(), /3 closed\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('after a sync from the template the numbers settle an impediment, and its signal stays quiet until it closes', () => {
  const S = { extra: [], items: {}, iterations: 10 };
  assert.deepEqual(harnessChanged(S, 'aaa'), [], 'the first run only notes the version');
  for (const id of ['A', 'B']) for (const sig of ['ci:e2e', 'ci:build']) recordFailure(S, { signature: sig, item: { id } });
  applyRetro(S, retroOut({ impediments: ['ci:e2e', 'ci:build'].map((signal) => ({ title: signal, part: 'ci', broke: 'b', evidence: 'e', wanted: 'w', signal })) }), { id: 'R-01', kind: 'early', cfg });
  assert.deepEqual(harnessChanged(S, 'aaa'), []);
  assert.deepEqual(harnessChanged(S, 'bbb').map((i) => i.id), ['IMP-1', 'IMP-2']);
  assert.deepEqual(S.learn['ci:e2e'].muted, { by: 'IMP-1' }, 'a sync does not make the signal call retros again');
  assert.deepEqual(S.retro.impediments.map((i) => i.status), ['recheck', 'recheck']);
  for (const id of ['C', 'D', 'E']) assert.equal(recordFailure(S, { signature: 'ci:e2e', item: { id: `LEARN-${id}`, kind: 'learn' } }), false);
  // too soon after the change: nothing is settled yet
  applyRetro(S, retroOut(), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual(S.retro.impediments.map((i) => i.status), ['recheck', 'recheck']);
  S.iterations = 20;
  recordFailure(S, { signature: 'ci:build', item: { id: 'C' } });
  applyRetro(S, retroOut(), { id: 'R-03', kind: 'early', cfg });
  assert.deepEqual(S.retro.impediments.map((i) => i.status), ['closed', 'open'], 'one is gone, one is still there');
  assert.deepEqual(S.learn['ci:build'].muted, { by: 'IMP-2' });
  assert.equal(S.learn['ci:e2e'].muted, undefined, 'the closed one counts again: if it ever comes back it is seen');
  assert.match(S.retro.impediments[0].note, /Not seen again since the harness changed/);
  assert.match(renderImpediments(S), /1 closed\./);
});

test('a retro inside the recheck window does not wipe out that the signal came back', () => {
  const S = { extra: [], items: {}, iterations: 10 };
  harnessChanged(S, 'aaa');
  for (const id of ['A', 'B']) recordFailure(S, { signature: 'ci:e2e', item: { id } });
  applyRetro(S, retroOut({ impediments: [{ title: 't', part: 'ci', broke: 'b', evidence: 'e', wanted: 'w', signal: 'ci:e2e' }] }), { id: 'R-01', kind: 'early', cfg });
  harnessChanged(S, 'bbb');
  // it comes back on the new harness, in one item and in a LEARN item (which does not count)
  S.iterations = 12;
  recordFailure(S, { signature: 'ci:e2e', item: { id: 'C' } });
  recordFailure(S, { signature: 'ci:e2e', item: { id: 'LEARN-1', kind: 'learn' } });
  assert.deepEqual(S.retro.impediments[0].back, ['C']);
  // a milestone retro before the window ends starts the per-signal count again, and reopens it at once
  applyRetro(S, retroOut(), { id: 'R-02', kind: 'milestone', milestone: 'M1', cfg });
  assert.deepEqual(S.learn['ci:e2e'].items, []);
  assert.equal(S.retro.impediments[0].status, 'open');
  assert.deepEqual(S.learn['ci:e2e'].muted, { by: 'IMP-1' });
  S.iterations = 30;
  applyRetro(S, retroOut(), { id: 'R-03', kind: 'early', cfg });
  assert.equal(S.retro.impediments[0].status, 'open', 'still open after the window');
});

test('a second harness change before the next retro starts the recheck again', () => {
  const S = { extra: [], items: {}, iterations: 10 };
  harnessChanged(S, 'v1');
  for (const id of ['A', 'B']) recordFailure(S, { signature: 'ci:e2e', item: { id } });
  applyRetro(S, retroOut({ impediments: [{ title: 't', part: 'ci', broke: 'b', evidence: 'e', wanted: 'w', signal: 'ci:e2e' }] }), { id: 'R-01', kind: 'early', cfg });
  harnessChanged(S, 'v2');
  S.iterations = 13;
  recordFailure(S, { signature: 'ci:e2e', item: { id: 'C' } }); // still there on v2
  assert.deepEqual(harnessChanged(S, 'v3').map((i) => i.id), ['IMP-1'], 'v3 is judged on its own');
  assert.deepEqual([S.retro.impediments[0].back, S.retro.impediments[0].recheckAt], [[], 13]);
  S.iterations = 16;
  applyRetro(S, retroOut(), { id: 'R-02', kind: 'early', cfg });
  assert.equal(S.retro.impediments[0].status, 'recheck', 'three sessions on v3 are too few to close it, and nothing reopens it');
  S.iterations = 20;
  applyRetro(S, retroOut(), { id: 'R-03', kind: 'early', cfg });
  assert.equal(S.retro.impediments[0].status, 'closed');
  assert.equal(S.learn['ci:e2e'].muted, undefined);
});

test('a sync closes the guard entries an older harness recorded, and asks nobody', () => {
  // the state of a run on a harness that still recorded refusals as impediments
  const S = { extra: [], items: {}, iterations: 40, learn: { 'guard:core:read-only': { count: 21, items: [], muted: { by: 'IMP-1' } }, 'guard:core:add-all': { count: 2, items: [], muted: { by: 'IMP-3' } } } };
  const r = retroState(S);
  r.harness = 'old';
  r.impediments.push(
    { id: 'IMP-1', retro: 'R-01', status: 'open', part: 'guard', title: 'core:read-only does not expand a variable', signal: 'guard:core:read-only' },
    { id: 'IMP-2', retro: 'R-01', status: 'open', part: 'runner', title: 'The retro packet reports finished items as open', signal: null },
    { id: 'IMP-3', retro: 'R-02', status: 'recheck', part: 'guard', title: 'core:add-all matches quoted text', signal: 'guard:core:add-all' },
    { id: 'IMP-4', retro: 'R-03', status: 'open', part: 'guard', title: 'a relative path is not resolved', signal: null },
    { id: 'IMP-5', retro: 'R-03', status: 'open', part: 'runner', title: 'The runner crashes on a transient git fetch network error', signal: null },
  );
  assert.deepEqual(harnessChanged(S, 'new').map((i) => i.id), ['IMP-2', 'IMP-5'], 'only the defects wait for the numbers');
  assert.deepEqual(r.impediments.map((i) => i.status), ['closed', 'recheck', 'closed', 'closed', 'recheck']);
  assert.match(r.impediments[0].note, /A refusal is the guard working/);
  assert.deepEqual([S.learn['guard:core:read-only'].muted, S.learn['guard:core:add-all'].muted], [undefined, undefined]);
  // an entry without a signal has no numbers: a retro that meets it again opens it, and one nobody met closes
  S.iterations = 43;
  applyRetro(S, retroOut({ impediments: [{ title: 'Runner crash when git fetch fails with a network error', part: 'runner', broke: 'the run stopped', evidence: 'e', wanted: 'w' }] }), { id: 'R-04', kind: 'early', cfg });
  assert.deepEqual([r.impediments[1].status, r.impediments[4].status, r.impediments[4].seen], ['recheck', 'open', 2]);
  S.iterations = 50;
  applyRetro(S, retroOut(), { id: 'R-05', kind: 'early', cfg });
  assert.deepEqual([r.impediments[1].status, r.impediments[4].status], ['closed', 'open']);
  assert.equal(r.impediments.length, 5, 'no entry was added along the way');
  // a closed one that turns up again is opened, not entered a second time
  const back = applyRetro(S, retroOut({ impediments: [{ title: 'The retro packet reports finished items as open again', part: 'runner', broke: 'b', evidence: 'e', wanted: 'w' }] }), { id: 'R-06', kind: 'early', cfg });
  assert.deepEqual([back.impediments.length, r.impediments[1].status, r.impediments[1].seen], [0, 'open', 2]);
});

test('an action item the retro says nothing about is judged by the numbers, and a failed acceptance keeps it open', () => {
  const S = { extra: [], items: {} };
  const act = (signal) => ({ title: `stop ${signal}`, rung: 'test', what: 'w', expect: 'e', done_when: 'd', signal });
  for (const sig of ['ci:lint', 'ci:types', 'ci:unit']) for (const id of ['A', 'B']) recordFailure(S, { signature: sig, item: { id } });
  applyRetro(S, retroOut({ actions: ['ci:lint', 'ci:types', 'ci:unit'].map(act) }), { id: 'R-01', kind: 'early', cfg });
  const [lint, types, unit] = S.retro.actions;
  noteAcceptanceFailed(S, 'M1', 1);
  assert.equal(lint.acceptFails, undefined, 'not merged yet: nothing is measured');
  noteItemEnded(S, { id: 'LEARN-1', kind: 'learn' }, 'done');
  for (const id of ['C', 'D']) {
    recordFailure(S, { signature: 'ci:types', item: { id } });
    noteItemEnded(S, { id }, 'done');
  }
  assert.deepEqual([actionVerdict(lint, cfg), actionVerdict(types, cfg), actionVerdict(unit, cfg)], ['worked', 'no effect', 'worked']);
  // the session returns a verdict for one of them only
  const res = applyRetro(S, retroOut({ checks: [{ action: 'A-3', verdict: 'worked', decision: 'retire', note: 'the job is gone' }] }), { id: 'R-02', kind: 'early', cfg });
  assert.deepEqual(res.checks.map((c) => [c.action, c.verdict, c.decision, c.status]), [['A-3', 'worked', 'retire', 'retired'], ['A-1', 'worked', 'keep', 'worked'], ['A-2', 'no_effect', 'keep', 'open']]);
  assert.match(lint.note, /By the numbers: the retro gave no verdict/);
  assert.match(types.note, /It stays open/);
  assert.match(renderMinutes(res.retro), /\| A-1 stop ci:lint \| 2 \| 0 \| worked \| keep \| By the numbers/);

  // acceptance failed since it merged: enough items and no hit is then "weak", and it is not closed
  const T = { extra: [], items: {} };
  for (const id of ['A', 'B']) recordFailure(T, { signature: 'ci:lint', item: { id } });
  applyRetro(T, retroOut({ actions: [act('ci:lint')] }), { id: 'R-01', kind: 'early', cfg });
  noteItemEnded(T, { id: 'LEARN-1', kind: 'learn' }, 'done');
  for (const id of ['C', 'D', 'E']) noteItemEnded(T, { id }, 'done');
  noteAcceptanceFailed(T, 'M2', 1);
  noteAcceptanceFailed(T, 'M2', 1);
  noteAcceptanceFailed(T, 'M2', 2);
  assert.deepEqual(T.retro.actions[0].acceptFails, ['M2 round 1', 'M2 round 2']);
  assert.equal(actionVerdict(T.retro.actions[0], cfg), 'weak');
  assert.deepEqual(applyRetro(T, retroOut(), { id: 'R-02', kind: 'milestone', milestone: 'M2', cfg }).checks, []);
  assert.equal(T.retro.actions[0].status, 'open');
});

test('a state written before retros existed is read as it is', () => {
  const S = { extra: [{ kind: 'learn', id: 'LEARN-2' }], items: { 'LEARN-2': { status: 'done' } }, learn: { 'guard:core:read-only': { count: 5, sinceLearn: 0, details: ['x'], queued: ['LEARN-2'] } } };
  assert.equal(nextLearnId(S), 'LEARN-3');
  assert.equal(recordFailure(S, { signature: 'guard:core:read-only', item: { id: 'A' } }), false);
  assert.deepEqual([S.learn['guard:core:read-only'].count, S.learn['guard:core:read-only'].items], [6, []]);
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
