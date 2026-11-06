// The whole runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// Each test is one branch of the state machine that has to hold on an unattended run.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { happyItem, makeSandbox, smokeStep } from './helpers/sandbox.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));
const box = (o) => {
  const sb = makeSandbox(o);
  boxes.push(sb);
  return sb;
};
const changes = (category = 'tests') => ({ structured: { verdict: 'changes', blocking: [{ file: 'src/a.ts', issue: 'no test for the new branch', fix: 'add one', category }], summary: 'needs tests' } });
const fixRound = (id) => ({ commit: { branch: '$OPEN', files: { [`src/${id}-fix-${Math.random().toString(36).slice(2, 6)}.txt`]: 'fix\n' }, message: 'fix' }, result: { item: id, outcome: 'ready', pr: '$PR', summary: 'fixed' } });
const mergedFiles = (sb) => sb.originGit('ls-tree', '-r', '--name-only', 'develop').split('\n');

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

test('review changes three times → needs_human, and the repeated finding queues a LEARN item first', async () => {
  const sb = box();
  const [build] = happyItem('A1');
  sb.queue(smokeStep(), build, changes(), fixRound('A1'), changes(), fixRound('A1'), changes());
  const r = await sb.run(['--once']);
  assert.equal(r.code, 0, r.stderr);
  const st = sb.state();
  assert.equal(st.items.A1.status, 'needs_human');
  const learn = st.extra.filter((e) => e.kind === 'learn');
  assert.equal(learn.length, 1);
  assert.equal(learn[0].signature, 'review:tests');
  assert.match(sb.file('.loop/PROGRESS.md'), /keeps recurring → LEARN-1 queued first in line/);
});

test('a LEARN item gets the learning ladder in its task', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [] } });
  sb.queue(smokeStep(), { text: 'no result' });
  fs.mkdirSync(path.join(sb.root, '.loop'), { recursive: true });
  fs.writeFileSync(path.join(sb.root, '.loop', 'state.json'), JSON.stringify({ items: {}, extra: [{ kind: 'learn', id: 'LEARN-1', milestone: 'M1', title: 'Stop "review:tests" from recurring', scope: 'cases', refs: [], ui: false, dependsOn: [] }], packed: [], accept: {}, learn: {}, iterations: 0, noProgress: 0 }));
  await sb.run(['--once']);
  assert.match(sb.file('.loop/current-task.md'), /This is a LEARN item: remove the cause/);
});

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

test('acceptance failure on the dev site queues an ACC item, then the packet is written', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }] } });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ commit: sb.originGit('rev-parse', 'develop'), db: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const cfgFile = path.join(sb.root, 'loop', 'loop.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.deploy.devUrl = url;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  try {
    sb.queue(
      smokeStep(),
      happyItem('U1', { ui: true }),
      { structured: { pass: false, failures: [{ title: 'Save button does nothing', scope: 'Clicking save on /x shows no feedback; fixed = a confirmation appears.', evidence: '.loop/reviews/M1/a.png' }], summary: 'one failure' } },
      happyItem('ACC-M1-1-1', { ui: true }),
      { structured: { pass: true, failures: [], summary: 'good' } },
      { structured: { markdown: '# M1\n\nAll good.\n', screenshots: [] } },
    );
    const r = await sb.run();
    assert.equal(r.code, 0, r.stderr);
    const st = sb.state();
    assert.equal(st.items['ACC-M1-1-1'].status, 'done');
    assert.equal(st.accept.M1.passed, true);
    assert.deepEqual(st.packed, ['M1']);
    assert.match(sb.file('.loop/reviews/M1.md'), /All good/);
    assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'accept', 'build', 'review', 'accept', 'packet']);
  } finally {
    server.close();
  }
});

test('a UI review without design scores is not an approval', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }] } });
  const [build] = happyItem('U1', { ui: true });
  sb.queue(smokeStep(), build, { structured: { verdict: 'approve', blocking: [], summary: 'looks fine' } }, { sleepMs: 1, text: 'stop here' });
  await sb.run(['--once', '--max-iterations', '3']);
  assert.equal(sb.state().items.U1.lastReview.verdict, 'changes');
});

test('dry run on a fresh config names what /setup-loop must set', async () => {
  const sb = box({ config: { repo: '', gitAuthor: { email: '' } } });
  const r = await sb.run(['--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /repo: set it to the GitHub "owner\/name"/);
  assert.match(r.stderr, /gitAuthor\.email/);
  assert.equal(sb.calls().length, 0);
});
