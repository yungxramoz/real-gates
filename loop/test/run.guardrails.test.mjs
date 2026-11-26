// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// What stops a run or keeps it honest: the preflight, session isolation, the checks after every
// session, the lock, the budget and the secrets; and the records a run leaves (ledger, events).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box, changes, fixRound } from './helpers/scenario.mjs';

test('smoke test fails when the guard log stays empty', async () => {
  const sb = box();
  sb.queue({ text: 'DONE' }); // the session never ran the planted command
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not refuse the planted command/);
  assert.equal(sb.calls().length, 1);
});

test('a session that loads a personal plugin stops the run before any work', async () => {
  const sb = box();
  sb.queue({ ...smokeStep(), initExtra: { plugins: [{ name: 'my-plugin', path: '/home/u/.claude/plugins/my-plugin' }] } });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not isolated: plugin "my-plugin"/);
});

test('dry run on a fresh config names what /setup-loop must set', async () => {
  const sb = box({ config: { repo: '', gitAuthor: { email: '' } } });
  const r = await sb.run(['--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /repo: set it to the "owner\/name" of this repository on the forge/);
  assert.match(r.stderr, /gitAuthor\.email/);
  assert.equal(sb.calls().length, 0);
});

test('a session that pushes to the base outside the runner stops the run', async () => {
  const sb = box();
  sb.queue(smokeStep(), { commit: { branch: 'develop', files: { 'sneaked.txt': 'x\n' }, message: 'direct push' } });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  assert.match(sb.file('.loop/REPORT.md'), /origin\/develop moved outside the runner/);
  assert.match(sb.file('.loop/OWNER-ACTIONS.md'), /revert anything unreviewed/);
  assert.notEqual(sb.state().items.A1.status, 'done');
});

test('a session that rewrites the session settings stops the run', async () => {
  const sb = box();
  sb.queue(smokeStep(), { writes: { '.loop/claude-settings.json': '{}' } });
  await sb.run();
  assert.match(sb.file('.loop/REPORT.md'), /changed the guard snapshot or the session settings/);
});

test('owner commands refuse while a loop holds the lock', async () => {
  const sb = box();
  fs.mkdirSync(path.join(sb.root, '.loop'), { recursive: true });
  fs.writeFileSync(path.join(sb.root, '.loop', 'lock'), JSON.stringify({ pid: process.pid, since: 'now' }));
  const r = await sb.run(['--skip', 'A1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /A loop is running/);
});

test('an unprotected base branch stops the run in the preflight, unless the config opts out', async () => {
  const sb = box();
  sb.setGhState((s) => (s.unprotected = ['develop']));
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /develop has no branch protection or ruleset/);
  assert.equal(sb.calls().length, 0, 'no session starts');
  const dry = await sb.run(['--dry-run']);
  assert.equal(dry.code, 0, 'a dry run only warns');
  assert.match(dry.stdout, /no branch protection/);

  const off = box({ config: { guard: { requireBranchProtection: false } } });
  off.setGhState((s) => (s.unprotected = ['develop']));
  off.queue(smokeStep(), happyItem('A1'));
  assert.equal((await off.run()).code, 0);
  assert.equal(off.state().items.A1.status, 'done');
});

test('every session is in the ledger with its cost, and a run dollar cap stops the run', async () => {
  const sb = box();
  sb.queue(smokeStep(), happyItem('A1'));
  assert.equal((await sb.run()).code, 0);
  const rows = sb.file('.loop/ledger.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.phase), ['smoke', 'build', 'review', 'packet']);
  assert.ok(rows.every((r) => r.costUsd === 0.01 && r.ok === true && r.durationMs >= 0));
  assert.equal(sb.state().cost.totalUsd, 0.04);
  assert.equal(sb.state().cost.byItem.A1, 0.02);
  assert.match(sb.file('.loop/REPORT.md'), /cost so far: ~\$0\.04/);

  const capped = box({ backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'one' }, { id: 'A2', milestone: 'M1', title: 'two' }] }, config: { budgets: { maxUsdPerRun: 0.03 }, milestonePackets: false } });
  capped.queue(smokeStep(), happyItem('A1'), happyItem('A2'));
  await capped.run();
  assert.equal(capped.state().items.A1.status, 'done');
  assert.notEqual(capped.state().items.A2?.status, 'done');
  assert.match(capped.file('.loop/REPORT.md'), /budget reached \(sessions, hours or dollars\)/);
});

test('a session that reported no cost is unknown in the ledger, never $0, and the run cap counts it at the session cap', async () => {
  const sb = box();
  const [build, review] = happyItem('A1');
  sb.queue(smokeStep(), { ...build, cost: null }, review);
  assert.equal((await sb.run()).code, 0);
  const rows = sb.file('.loop/ledger.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.phase, r.costUsd]), [['smoke', 0.01], ['build', null], ['review', 0.01], ['packet', 0.01]]);
  assert.equal(sb.state().cost.totalUsd, 0.03);
  assert.equal(sb.state().cost.unknownSessions, 1);
  assert.match(sb.file('.loop/REPORT.md'), /cost so far: ~\$0\.03 \+ 1 session\(s\) of unknown cost/);

  // with a cap of $30 and sessions capped at $25, one session of unknown cost may have spent $25
  const capped = box({ backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'one' }, { id: 'A2', milestone: 'M1', title: 'two' }] }, config: { budgets: { maxUsdPerRun: 30, maxUsdPerSession: 25 }, milestonePackets: false } });
  const [b1, r1] = happyItem('A1');
  capped.queue(smokeStep(), { ...b1, cost: null }, { ...r1, cost: null }, happyItem('A2'));
  await capped.run();
  assert.equal(capped.state().items.A1.status, 'done');
  assert.notEqual(capped.state().items.A2?.status, 'done');
  assert.match(capped.file('.loop/REPORT.md'), /budget reached/);
});

test('agent sessions do not see the database URL; only the deployed-site steps see the bypass secret', async () => {
  const sb = box({ config: { postMerge: [{ adapter: 'supabase-cli', dbUrlEnv: 'DEV_DB_URL', migrationsDir: 'supabase/migrations', holdOnUnverified: true }] } });
  Object.assign(sb.env, { DEV_DB_URL: 'postgres://dev', VERCEL_BYPASS: 'secret', LOOP_FAKE_RECORD_ENV: 'DEV_DB_URL,VERCEL_BYPASS' });
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const sees = Object.fromEntries(sb.calls().map((c) => [c.phase, c.sees]));
  for (const phase of ['smoke', 'build', 'review']) assert.deepEqual(sees[phase], { DEV_DB_URL: false, VERCEL_BYPASS: false }, phase);
  assert.deepEqual(sees.packet, { DEV_DB_URL: false, VERCEL_BYPASS: true });
});

test('the event file says what happened in fields a program can read', async () => {
  const events = (sb) => sb.file('.loop/events.jsonl').trim().split('\n').map((l) => JSON.parse(l));

  // a red CI round, then merged: the send-back, the merge and the end are each one line
  const red = box();
  red.setGhState((s) => (s.ciQueue = ['failure']));
  const [build, review] = happyItem('A1');
  red.queue(smokeStep(), build, fixRound('A1'), review);
  assert.equal((await red.run()).code, 0);
  const ev = events(red);
  assert.ok(ev.every((e) => e.v === 1 && typeof e.type === 'string' && !Number.isNaN(Date.parse(e.at))), 'every line has v, at and type');
  assert.equal(ev[0].type, 'run.started');
  assert.equal(ev.at(-1).type, 'run.ended');
  assert.equal(ev.at(-1).reason, 'backlog exhausted');
  const back = ev.filter((e) => e.type === 'check.sent_back');
  assert.deepEqual(back.map((e) => [e.item, e.check, e.pr, e.round, e.detail, e.jobs]), [['A1', 'ci', 1, 1, 'red', ['unit tests']]]);
  assert.deepEqual(ev.filter((e) => e.type === 'build.round').map((e) => [e.round, e.outcome]), [[1, 'ready'], [2, 'ready']]);
  const merged = ev.find((e) => e.type === 'item.merged');
  assert.match(merged.sha, /^[0-9a-f]{40}$/);
  assert.equal(merged.pr, 1);
  const done = ev.find((e) => e.type === 'item.finished');
  assert.deepEqual([done.item, done.milestone, done.status, done.buildRounds], ['A1', 'M1', 'done', 2]);
  assert.ok(ev.findIndex((e) => e.type === 'item.merged') < ev.findIndex((e) => e.type === 'item.finished'));
  assert.deepEqual(ev.filter((e) => e.type === 'milestone.packed').map((e) => e.milestone), ['M1']);

  // a review that never approves: each verdict, each send-back and the outcome
  const stuck = box();
  stuck.queue(smokeStep(), happyItem('A1')[0], changes(), fixRound('A1'), changes(), fixRound('A1'), changes());
  assert.equal((await stuck.run(['--once'])).code, 0);
  const sv = events(stuck);
  const verdicts = sv.filter((e) => e.type === 'review.verdict');
  assert.deepEqual(verdicts.map((e) => [e.round, e.verdict, e.blocking[0].category]), [[1, 'changes', 'tests'], [2, 'changes', 'tests'], [3, 'changes', 'tests']]);
  assert.equal(sv.filter((e) => e.type === 'check.sent_back' && e.check === 'review').length, 3);
  assert.ok(!sv.some((e) => e.type === 'retro.called' || e.type === 'learn.queued'), 'one item on its own calls no retro');
  assert.equal(sv.find((e) => e.type === 'item.finished').status, 'needs_human');
  assert.ok(!sv.some((e) => e.type === 'item.merged'));

  // a dry run writes nothing
  const dry = box();
  await dry.run(['--dry-run']);
  assert.equal(dry.file('.loop/events.jsonl'), null);
});
