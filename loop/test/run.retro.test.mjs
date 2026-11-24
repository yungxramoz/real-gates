// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// Retros: called early by a repeated failure and at the end of every milestone, with their LEARN
// item and their minutes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box, changes, fixRound } from './helpers/scenario.mjs';

const retroResult = (over = {}) => ({ structured: { summary: 'How the stretch went.', went_well: [], problems: [], checks: [], actions: [], impediments: [], ...over } });

test('the same review finding in two items calls a retro early; its action items are built first, as one LEARN item', async () => {
  const backlog = { milestones: ['M1'], items: ['A1', 'A2', 'A3'].map((id) => ({ id, milestone: 'M1', title: `item ${id}`, refs: [], scope: 's', ui: false, dependsOn: [] })) };
  const sb = box({ backlog, config: { retro: { enabled: true }, milestonePackets: false } });
  const sentBackOnce = (id) => {
    const [build, review] = happyItem(id);
    return [build, changes(), fixRound(id), review];
  };
  const retro = retroResult({
    went_well: [{ practice: 'Small pull requests', evidence: 'A1 and A2 were fixed in one round', keep: false }],
    problems: [{ title: 'New branches ship without a test', evidence: 'PR 1, PR 2', cause: 'the contract asks for no proof per branch', owner: 'practice', signal: 'review:tests:untested-branch' }],
    actions: [{ title: 'A test per new branch', rung: 'lesson', what: 'Add the lesson row.', expect: 'no review:tests:untested-branch in the next five items', done_when: 'the row is in docs/LESSONS.md', signal: 'review:tests:untested-branch' }],
  });
  // the milestone's own retro comes last; here its session returns nothing, so the run ends with it
  sb.queue(smokeStep(), sentBackOnce('A1'), sentBackOnce('A2'), retro, happyItem('LEARN-1'), happyItem('A3'), { text: 'Nothing to add.' });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const calls = sb.calls();
  assert.deepEqual(calls.map((c) => `${c.phase}:${c.item}`), ['smoke:preflight', 'build:A1', 'review:A1', 'build:A1', 'review:A1', 'build:A2', 'review:A2', 'build:A2', 'review:A2', 'retro:R-01', 'build:LEARN-1', 'review:LEARN-1', 'build:A3', 'review:A3', 'retro:R-02']);
  // the retro session is read-only, returns a structured result, and is given the numbers
  const session = calls[9];
  assert.ok(session.args.includes('--disallowedTools') && session.args.includes('--json-schema'));
  assert.match(session.task, /It was called early: `review:tests:untested-branch`/);
  assert.match(session.task, /\| `review:tests:untested-branch` \| A1, A2 \| 2 \|.*calls this retro/);
  assert.match(session.task, /\| A1 \| backlog \| done \| 2 \| review ×1 \|/);
  assert.match(sb.file('.loop/retros/data/R-01.md'), /## The numbers/);
  assert.deepEqual(fs.readdirSync(path.join(sb.root, '.loop', 'retros')).sort(), ['R-01.md', 'data'], 'only the minutes lie where they are filed from');
  assert.match(calls[10].task, /Nothing from \.loop\/retros\/data\/ is ever filed/);
  // the minutes, and the LEARN item that carries them out
  const minutes = sb.file('.loop/retros/R-01.md');
  assert.match(minutes, /# Retro R-01, called early/);
  assert.match(minutes, /\| A-1 A test per new branch \| lesson \|/);
  assert.match(minutes, /\| New branches ship without a test \|.*\| how we work \|/);
  assert.match(calls[10].task, /carry out a retro's action items/);
  assert.match(calls[10].task, /\.loop\/retros\/R-01\.md/);
  assert.match(calls[11].task, /This is a \*\*LEARN item\*\*: it carries out the action items of retro R-01/);
  const st = sb.state();
  assert.equal(st.items['LEARN-1'].status, 'done');
  // the action item is measured from the moment its LEARN item merged
  const [action] = st.retro.actions;
  assert.deepEqual([action.id, action.learn, action.status, action.signal, action.itemsSince, action.hits], ['A-1', 'LEARN-1', 'open', 'review:tests:untested-branch', ['A3'], []]);
  assert.ok(action.since);
  assert.equal(st.retro.sessions, 4, 'the early retro, the two sessions of its LEARN item, and the milestone retro');
  const ev = sb.file('.loop/events.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev.filter((e) => e.type === 'retro.called').map((e) => [e.item, e.signature]), [['A2', 'review:tests:untested-branch']]);
  const held = ev.find((e) => e.type === 'retro.held');
  assert.deepEqual([held.retro, held.kind, held.actions, held.learn, held.problems, held.wentWell], ['R-01', 'early', ['A-1'], 'LEARN-1', 1, 1]);
  assert.deepEqual(ev.filter((e) => e.type === 'learn.queued').map((e) => [e.learn, e.retro]), [['LEARN-1', 'R-01']]);
  const report = sb.file('.loop/REPORT.md');
  assert.match(report, /## Retros \(1\)\n\n- \*\*R-01\*\* called early: 1 action item\(s\) → LEARN-1/);
  assert.match(report, /- A-1 A test per new branch: 1 item\(s\) since, still happened in 0/);
});

test('every milestone ends with a retro: minutes, what to keep, a defect recorded without asking anyone, and its LEARN item before the packet', async () => {
  const sb = box({ config: { retro: { enabled: true } } });
  const retro = retroResult({
    went_well: [{ practice: 'The contract named a proof for every criterion', evidence: 'A1 merged at the first attempt', keep: true }],
    problems: [
      { title: 'The guard refused a harmless append', evidence: 'the guard log', cause: 'the read-only rule takes every append for a write outside .loop/', owner: 'harness' },
      { title: 'No licence was chosen', evidence: 'README.md', cause: 'Pick one and say which.', owner: 'owner' },
    ],
    impediments: [
      { title: 'The read-only rule refuses every append', part: 'guard', broke: 'nothing', evidence: 'nine refused calls in one session', example: 'printf x >> .loop/reviews/a.txt', wanted: 'Allow an append into .loop/.' },
      { title: 'The runner crashes when a fetch fails', part: 'runner', broke: 'the run stopped for forty minutes', evidence: 'PROGRESS.md', example: 'git fetch origin --prune: exit 128', wanted: 'Try the fetch again.' },
    ],
  });
  sb.queue(smokeStep(), happyItem('A1'), retro, happyItem('LEARN-1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const calls = sb.calls();
  assert.deepEqual(calls.map((c) => `${c.phase}:${c.item}`), ['smoke:preflight', 'build:A1', 'review:A1', 'retro:R-01', 'build:LEARN-1', 'review:LEARN-1', 'packet:M1']);
  assert.match(calls[3].task, /Milestone \*\*M1\*\* is built: this is its retro/);
  assert.match(calls[3].task, /### Merged at the first attempt, sent back by nothing\n\nA1/);
  // the retro works in a folder of its own, which is gone again when the LEARN item starts
  assert.match(calls[3].task, /notes go into\s+`\.loop\/work\/R-01\/retro\/`, your working folder/);
  assert.deepEqual(calls[3].work, { 'R-01/retro': [] });
  assert.deepEqual(calls[4].work, { 'LEARN-1/build': [] });
  const st = sb.state();
  assert.equal(st.retro.milestones.M1, 'R-01');
  assert.deepEqual(st.packed, ['M1']);
  const learn = st.extra.find((e) => e.id === 'LEARN-1');
  assert.match(learn.title, /Retro R-01: file the minutes and update the lessons/);
  assert.match(learn.scope, /Practices to write down under "Keep doing":\n- The contract named a proof for every criterion/);
  const minutes = sb.file('.loop/retros/R-01.md');
  assert.match(minutes, /# Retro R-01, after milestone M1/);
  // a refusal is the guard working: the entry for it is not recorded. The defect is, once
  assert.match(minutes, /\| IMP-1 The runner crashes when a fetch fails \| runner \|/);
  assert.doesNotMatch(minutes, /refuses every append \| guard/);
  const list = sb.file('.loop/IMPEDIMENTS.md');
  assert.match(list, /\| IMP-1 \| open \| runner \| The runner crashes when a fetch fails \|/);
  assert.doesNotMatch(list, /IMP-2|every append/);
  assert.deepEqual(st.retro.impediments.map((i) => [i.id, i.part, i.seen]), [['IMP-1', 'runner', 1]]);
  // nobody is asked about the harness: only the owner's own question is an owner action
  const asks = sb.file('.loop/OWNER-ACTIONS.md');
  assert.doesNotMatch(asks, /IMP-|Impediment|guard|fetch/i);
  assert.match(asks, /\*\*R-01\*\* — The retro found something only you can settle: No licence was chosen/);
  assert.equal(asks.split('\n').filter((l) => l.startsWith('- [ ]')).length, 1);
  // every read-only session was told the guard's rules for its step, with its own folder in them
  for (const [n, folder] of [[2, 'A1/review'], [3, 'R-01/retro'], [5, 'LEARN-1/review'], [6, 'M1/packet']]) {
    assert.match(calls[n].task, /\*\*What the guard lets this step do\.\*\*/, calls[n].phase);
    assert.ok(calls[n].task.includes(`npm test > .loop/work/${folder}/test.txt 2>&1`), `${calls[n].phase}: ${folder}`);
  }
  assert.doesNotMatch(calls[1].task, /What the guard lets this step do/, 'a build session may write: it has other rules');
  assert.match(calls[3].task, /\*\*A guard refusal is not a problem\.\*\*/);
  assert.match(calls[3].task, /### Guard refusals\n\nThe guard working\. This table is the cost only/);
  // the packet is about what the milestone delivers, and points the owner at the retro
  const packet = calls[6].task;
  assert.match(packet, /\.loop\/retros\/R-01\.md/);
  assert.match(packet, /- A1 · First item · done/);
  assert.ok(!/LEARN-1 ·/.test(packet), 'a LEARN item is not part of what the milestone delivers');
  // the guard log says what was refused
  assert.match(sb.file('.loop/logs/guard.log'), /\tpreflight\tsmoke\tcore:add-all\t[^\t]+\tgit add -A --dry-run\n/);
});

test('a milestone ends with its retro also when no packets are written', async () => {
  const sb = box({ config: { retro: { enabled: true }, milestonePackets: false } });
  sb.queue(smokeStep(), happyItem('A1'), retroResult({ went_well: [{ practice: 'One proof per criterion', evidence: 'A1 merged at the first attempt', keep: true }] }), happyItem('LEARN-1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(sb.calls().map((c) => `${c.phase}:${c.item}`), ['smoke:preflight', 'build:A1', 'review:A1', 'retro:R-01', 'build:LEARN-1', 'review:LEARN-1']);
  const st = sb.state();
  assert.equal(st.retro.milestones.M1, 'R-01');
  assert.deepEqual([st.packed, st.accept], [[], {}], 'nothing is accepted and nothing is packed');
  assert.equal(st.items['LEARN-1'].status, 'done');
  // a second run finds the milestone's retro held and starts no session for it
  sb.queue(smokeStep());
  const again = await sb.run();
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.deepEqual(sb.calls().filter((c) => c.phase === 'retro').length, 1);
});

test('a retro session that returns nothing does not hold the milestone up', async () => {
  const sb = box({ config: { retro: { enabled: true } } });
  sb.queue(smokeStep(), happyItem('A1'), { text: 'I looked around.' });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'retro', 'packet']);
  assert.equal(sb.state().retro.milestones.M1, 'none');
  assert.deepEqual(sb.state().packed, ['M1']);
  assert.match(sb.file('.loop/PROGRESS.md'), /the retro session gave no result; the milestone is packed without one/);
});
