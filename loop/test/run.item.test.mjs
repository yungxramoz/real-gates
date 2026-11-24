// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// An item from its first session to done: the sessions it gets, the folders they work in, and what
// a run does when a session is limited, killed or comes back with nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box, changes, fixRound, mergedFiles } from './helpers/scenario.mjs';

test('happy path merges, verifies and marks done', async () => {
  const sb = box();
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.deepEqual(sb.state().items.A1.prs, [1]);
  assert.ok(mergedFiles(sb).includes('src/A1.txt'));
  const calls = sb.calls();
  assert.deepEqual(calls.map((c) => c.phase), ['smoke', 'build', 'review', 'packet']);
  for (const c of calls) {
    assert.ok(c.args.includes('--strict-mcp-config'));
    assert.equal(c.args[c.args.indexOf('--permission-prompts') + 1], 'none');
  }
  const review = calls[2].args;
  assert.ok(review.includes('--disallowedTools') && review.includes('--json-schema'));
  assert.match(calls[1].args[calls[1].args.indexOf('-p') + 1], /^\/goal /);
  assert.ok(sb.ghState().reviews.length >= 1, 'the runner posts the review on the PR');
  assert.match(sb.file('.loop/REPORT.md'), /backlog exhausted/);
});

test('every session works in a folder of its own, and the folder goes when its item or milestone is finished', async () => {
  const sb = box();
  const [build, approve] = happyItem('A1');
  const leaves = (step, rel) => ({ ...step, writes: { [rel]: 'x' } });
  sb.queue(
    smokeStep(),
    leaves(build, '.loop/work/A1/build/pr-body.md'),
    leaves(changes(), '.loop/work/A1/review/notes.txt'),
    fixRound('A1'),
    leaves(approve, '.loop/work/A1/review/notes-2.txt'),
    leaves({ structured: { markdown: '# M1\n', screenshots: [] } }, '.loop/work/M1/packet/draft.md'),
  );
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(sb.state().items.A1.status, 'done');
  const calls = sb.calls();
  assert.deepEqual(calls.map((c) => c.phase), ['smoke', 'build', 'review', 'build', 'review', 'packet']);
  const [smoke, build1, review1, build2, review2, packet] = calls;
  // the runner made each folder before its session; a build round finds what the last one left, a review starts empty
  assert.deepEqual(smoke.work, {}, 'the permission check has no folder');
  assert.deepEqual(build1.work, { 'A1/build': [] });
  assert.deepEqual(review1.work, { 'A1/build': ['pr-body.md'], 'A1/review': [] });
  assert.deepEqual(build2.work, { 'A1/build': ['pr-body.md'], 'A1/review': ['notes.txt'] });
  assert.deepEqual(review2.work, { 'A1/build': ['pr-body.md'], 'A1/review': [] });
  // the item is done: its folders are gone before the next step starts
  assert.deepEqual(packet.work, { 'M1/packet': [] });
  // each prompt names its own folder, and no other session's
  assert.match(build1.task, /`\.loop\/work\/A1\/build\/` is yours for this item/);
  assert.match(review1.task, /`\.loop\/work\/A1\/review\/` is your working folder for this review/);
  assert.match(packet.task, /goes into `\.loop\/work\/M1\/packet\/`, your working folder/);
  assert.doesNotMatch(review1.task, /work\/A1\/build/);
  for (const c of calls) assert.doesNotMatch(c.task, /review-wt|accept-wt|\{\{/);
  // the milestone is packed: nothing is left, and what the runner keeps is untouched
  assert.deepEqual(fs.readdirSync(path.join(sb.root, '.loop', 'work')), []);
  assert.match(sb.file('.loop/reviews/M1.md'), /# M1/);
  assert.ok(fs.readdirSync(path.join(sb.root, '.loop', 'logs')).length >= 6);
});

test('an item that did not get through keeps its working folders until it is reset or skipped; a new run removes what a killed one left', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: ['A1', 'A2', 'A3'].map((id) => ({ id, milestone: 'M1', title: id, dependsOn: [] })) } });
  const [build] = happyItem('A1');
  const leaves = (step, rel) => ({ ...step, writes: { [rel]: 'x' } });
  sb.queue(smokeStep(), leaves(build, '.loop/work/A1/build/pr-body.md'), changes(), fixRound('A1'), changes(), fixRound('A1'), leaves(changes(), '.loop/work/A1/review/notes.txt'));
  const r = await sb.run(['--once']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.state().items.A1.status, 'needs_human');
  const at = (rel) => fs.existsSync(path.join(sb.root, '.loop', 'work', rel));
  assert.ok(at('A1/build/pr-body.md') && at('A1/review/notes.txt'), 'the owner can see what the sessions were doing');
  const reset = await sb.run(['--reset', 'A1']);
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(at('A1'), false);

  // a killed run: folders of a finished item, of a retro and of a skipped item are still there
  const plant = (rel) => {
    fs.mkdirSync(path.dirname(path.join(sb.root, '.loop', 'work', rel)), { recursive: true });
    fs.writeFileSync(path.join(sb.root, '.loop', 'work', rel), 'x');
  };
  for (const rel of ['A2/build/left.txt', 'A3/review/left.txt', 'R-07/retro/notes.md']) plant(rel);
  const skip = await sb.run(['--skip', 'A2']);
  assert.equal(skip.code, 0, skip.stderr);
  assert.equal(at('A2'), false);
  plant('A2/build/again.txt');
  sb.queue(smokeStep(), happyItem('A1'), { text: 'stop here' });
  const again = await sb.run(['--item', 'A1']);
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.deepEqual([at('A1'), at('A2'), at('R-07')], [false, false, false]);
  assert.ok(at('A3/review/left.txt'), 'A3 is not finished: its folder is not for the runner to remove');
});

test('a LEARN item is told to carry out its retro', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [] } });
  sb.queue(smokeStep(), { text: 'no result' });
  fs.mkdirSync(path.join(sb.root, '.loop'), { recursive: true });
  fs.writeFileSync(path.join(sb.root, '.loop', 'state.json'), JSON.stringify({ items: {}, extra: [{ kind: 'learn', id: 'LEARN-1', milestone: 'M1', retro: 'R-03', title: 'Retro R-03: a test per new branch', scope: 'the action items', refs: [], ui: false, dependsOn: [] }], packed: [], accept: {}, learn: {}, iterations: 0, noProgress: 0 }));
  await sb.run(['--once']);
  const task = sb.file('.loop/current-task.md');
  assert.match(task, /This is a LEARN item: carry out a retro's action items/);
  assert.match(task, /\.loop\/retros\/R-03\.md/);
  assert.match(task, /Impediments are not yours/);
});

test('a LEARN item queued before retros existed keeps the brief it was queued with', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [] } });
  sb.queue(smokeStep(), { text: 'no result' });
  fs.mkdirSync(path.join(sb.root, '.loop'), { recursive: true });
  fs.writeFileSync(path.join(sb.root, '.loop', 'state.json'), JSON.stringify({ items: {}, extra: [{ kind: 'learn', id: 'LEARN-6', milestone: 'M1', title: 'Stop "review:tests" from recurring', signature: 'review:tests', scope: 'The run hit "review:tests" 2 times. Recent cases:\n- A1: no test', refs: [], ui: false, dependsOn: [] }], packed: [], accept: {}, learn: {}, iterations: 0, noProgress: 0 }));
  await sb.run(['--once']);
  const task = sb.file('.loop/current-task.md');
  assert.match(task, /This is a LEARN item: remove the cause, not the symptom/);
  assert.match(task, /Recent cases:/);
  assert.ok(!/\.loop\/retros\//.test(task), 'it is not sent to minutes that do not exist');
});

test('usage limit sleeps and retries the same step', async () => {
  const sb = box();
  const [build, review] = happyItem('A1');
  sb.queue(smokeStep(), { mode: 'limit' }, build, review);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.match(sb.file('.loop/PROGRESS.md'), /usage limit, waiting/);
});

test('three no-merge items trip the circuit breaker', async () => {
  const items = ['A1', 'A2', 'A3', 'A4'].map((id) => ({ id, milestone: 'M1', title: id }));
  const sb = box({ backlog: { milestones: ['M1'], items } });
  sb.queue(smokeStep()); // every later session returns no result
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  const st = sb.state();
  assert.deepEqual(['A1', 'A2', 'A3'].map((id) => st.items[id].status), ['failed', 'failed', 'failed']);
  assert.equal(st.items.A4?.rounds ?? 0, 0);
  assert.match(sb.file('.loop/REPORT.md'), /circuit breaker: 3 items in a row/);
});

test('a crash mid-review resumes at review, not at build', async () => {
  const sb = box();
  const [build, review] = happyItem('A1');
  sb.queue(smokeStep(), build, { sleepMs: 20_000, text: 'never' });
  const child = spawn(process.execPath, [path.join(sb.root, 'loop', 'run.mjs')], { cwd: sb.root, env: sb.env, stdio: 'ignore' });
  for (let i = 0; i < 600 && !sb.calls().some((c) => c.phase === 'review'); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('close', r));
  assert.equal(sb.state().items.A1.phase, 'review');

  fs.writeFileSync(path.join(sb.fake, 'claude-queue.json'), JSON.stringify([smokeStep(), review]));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.equal(sb.calls().filter((c) => c.phase === 'build').length, 1);
});
