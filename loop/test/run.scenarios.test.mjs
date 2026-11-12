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
const changes = (category = 'tests') => ({ structured: { verdict: 'changes', blocking: [{ file: 'src/a.ts', issue: 'no test for the new branch', fix: 'add one', category, cause: 'Untested branch' }], summary: 'needs tests' } });
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
  assert.equal(learn[0].signature, 'review:tests:untested-branch');
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

test('after the last acceptance round the packet waits for the fix items and says they were not re-accepted', async () => {
  const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }] }, config: { maxAcceptRounds: 1 } });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ commit: sb.originGit('rev-parse', 'develop'), db: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfgFile = path.join(sb.root, 'loop', 'loop.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.deploy.devUrl = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  try {
    sb.queue(
      smokeStep(),
      happyItem('U1', { ui: true }),
      { structured: { pass: false, failures: [{ title: 'Save button does nothing', scope: 'No feedback after save.' }], summary: 'one failure' } },
      happyItem('ACC-M1-1-1', { ui: true }),
      { structured: { markdown: '# M1\n\nOne fix not re-accepted.\n', screenshots: [] } },
    );
    const r = await sb.run();
    assert.equal(r.code, 0, r.stderr);
    const st = sb.state();
    assert.equal(st.items['ACC-M1-1-1'].status, 'done');
    assert.equal(st.accept.M1.passed, false);
    assert.equal(st.accept.M1.unverified, true);
    assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'accept', 'build', 'review', 'packet'], 'the packet comes after the fix item, not before it');
    assert.match(sb.file('.loop/OWNER-ACTIONS.md'), /nothing re-tested them on the dev site/);
  } finally {
    server.close();
  }
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

const untitledItem = (branch, file) => [
  { commit: { branch, files: { [file]: 'x\n' }, message: 'fix' }, createPr: { title: 'fix' }, result: { outcome: 'ready', pr: '$PR', branch, summary: 'fixed' } },
  { structured: { verdict: 'approve', blocking: [], summary: 'fine' } },
];

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

test('a prompt that includes a fragment the profile does not have stops the run in the preflight', async () => {
  const sb = box();
  fs.rmSync(path.join(sb.root, 'loop', 'profiles', 'next-supabase-vercel', 'prompts', 'review-drive.md'));
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /loop\/prompts\/review\.md includes \{\{>review-drive\}\}, but the profile has no loop\/profiles\/next-supabase-vercel\/prompts\/review-drive\.md/);
  assert.equal(sb.calls().length, 0);
});

test('the build task carries the profile\'s own words for proving a change', async () => {
  const sb = box();
  sb.queue(smokeStep(), { text: 'no result' });
  await sb.run(['--once', '--max-iterations', '2']);
  const task = sb.file('.loop/current-task.md');
  assert.match(task, /`pnpm check` and `pnpm build` must pass/);
  assert.doesNotMatch(task, /\{\{>/);
  // the same core prompt with another profile's fragment
  const other = box();
  fs.writeFileSync(path.join(other.root, 'loop', 'profiles', 'next-supabase-vercel', 'prompts', 'build-proof.md'), '- `make check` must pass. Item {{ITEM_ID}}.\n');
  // committed on the base, as a real profile is: the runner keeps uncommitted tracked changes aside
  other.git('add', 'loop/profiles/next-supabase-vercel/prompts/build-proof.md');
  other.git('commit', '-q', '-m', 'another profile');
  other.git('push', '-q', 'origin', 'develop');
  other.queue(smokeStep(), { text: 'no result' });
  await other.run(['--once', '--max-iterations', '2']);
  assert.match(other.file('.loop/current-task.md'), /`make check` must pass\. Item A1\./);
  assert.doesNotMatch(other.file('.loop/current-task.md'), /pnpm check/);
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
