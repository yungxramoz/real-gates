// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// Between the push and the merge: PR CI, the local gate and the review, and the fix rounds they send
// an item back for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box, changes, fixRound } from './helpers/scenario.mjs';

test('red CI gets a fix round with the failing log', async () => {
  const sb = box();
  sb.setGhState((s) => (s.ciQueue = ['failure']));
  const [build, review] = happyItem('A1');
  sb.queue(smokeStep(), build, fixRound('A1'), review);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.match(sb.file('.loop/current-task.md') || '', /./);
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'build', 'review', 'packet']);
  assert.match(sb.file('.loop/PROGRESS.md'), /CI on PR #1: red \(unit tests\)/);
});

test("review changes three times → needs_human; one item's own rounds call no retro", async () => {
  const sb = box();
  const [build] = happyItem('A1');
  sb.queue(smokeStep(), build, changes(), fixRound('A1'), changes(), fixRound('A1'), changes());
  const r = await sb.run(['--once']);
  assert.equal(r.code, 0, r.stderr);
  const st = sb.state();
  assert.equal(st.items.A1.status, 'needs_human');
  assert.equal(st.learn['review:tests:untested-branch'].count, 3);
  assert.deepEqual(st.learn['review:tests:untested-branch'].items, ['A1']);
  assert.equal(st.retro.due, null);
  assert.equal(st.extra.filter((e) => e.kind === 'learn').length, 0);
});

test('a UI review without design scores is not an approval', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }] } });
  const [build] = happyItem('U1', { ui: true });
  sb.queue(smokeStep(), build, { structured: { verdict: 'approve', blocking: [], summary: 'looks fine' } }, { sleepMs: 1, text: 'stop here' });
  await sb.run(['--once', '--max-iterations', '3']);
  assert.equal(sb.state().items.U1.lastReview.verdict, 'changes');
});

test('the local gate runs on the pushed head: a failure gets a fix round before CI is waited for', async () => {
  const gate = "import fs from 'node:fs';\nif (!fs.existsSync('src/ok.txt')) { console.log('GATE: src/ok.txt is missing'); process.exit(1); }\nfs.writeFileSync('CLAUDE.md', '# changed by the gate\\n');\n";
  const sb = box({ config: { localGate: { commands: ['node gate.mjs'] } }, files: { 'gate.mjs': gate } });
  const [build, review] = happyItem('A1');
  sb.queue(smokeStep(), build, { commit: { branch: '$OPEN', files: { 'src/ok.txt': 'ok\n' }, message: 'fix' }, result: { item: 'A1', outcome: 'ready', pr: '$PR', summary: 'fixed' } }, review);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'build', 'review', 'packet']);
  const progress = sb.file('.loop/PROGRESS.md');
  assert.match(progress, /local gate failed on PR #1 \(node gate\.mjs\)/);
  assert.match(progress, /local gate: 1 command\(s\) passed/);
  assert.match(sb.file('.loop/logs/gate-A1-r1.txt'), /GATE: src\/ok\.txt is missing/);
  assert.equal(sb.git('status', '--porcelain', '--untracked-files=no'), '', 'what the gate commands changed is not left in the tree');
  assert.equal(sb.state().learn['gate:node gate.mjs'].count, 1);
});

test('the reviewer starts while CI runs, and an approval on the green head merges', async () => {
  const sb = box({ config: { review: { parallelWithCi: true } } });
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.match(r.stdout, /waiting for CI on PR #1, reviewing meanwhile/);
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'packet']);
});

test('red CI and review findings from the same head go into one fix round', async () => {
  const sb = box({ config: { review: { parallelWithCi: true } } });
  sb.setGhState((s) => (s.ciQueue = ['failure']));
  const [build, approve] = happyItem('A1');
  sb.queue(smokeStep(), build, changes(), fixRound('A1'), approve);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const a = sb.state().items.A1;
  assert.equal(a.status, 'done');
  assert.equal(a.rounds, 2, 'one build and one fix round, not one fix round per gate');
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'build', 'review', 'packet']);
  const progress = sb.file('.loop/PROGRESS.md');
  assert.match(progress, /CI on PR #1: red \(unit tests\)/);
  assert.match(progress, /review round 1 on PR #1: \*\*changes\*\*/);
  assert.match(progress, /review round 2 on PR #1: \*\*approve\*\*/);
});

test('an approval while CI turns red does not merge: CI gets its fix round and the review runs again', async () => {
  const sb = box({ config: { review: { parallelWithCi: true } } });
  sb.setGhState((s) => (s.ciQueue = ['failure']));
  const [build, approve] = happyItem('A1');
  sb.queue(smokeStep(), build, approve, fixRound('A1'), approve);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'build', 'review', 'packet']);
});
