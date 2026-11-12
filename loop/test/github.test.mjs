// The CI, merge and landed-check gates against a real git sandbox and the fake gh.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeSandbox } from './helpers/sandbox.mjs';
import { createProc } from '../lib/proc.mjs';
import { coverageThresholds, landedCheck, mergePr, preMergeChecks, prView, waitForCommitCi, waitForPrCi } from '../lib/github.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));

function setup(opts) {
  const sb = makeSandbox(opts);
  boxes.push(sb);
  const ctx = { cfg: sb.cfg, proc: createProc({ root: sb.root, env: () => sb.env }), paths: { logs: path.join(sb.root, '.loop', 'logs') }, log: () => {}, stopRequested: () => false };
  return { sb, ctx };
}

/** Push a feature branch with one file and open a PR for it in the fake. */
function openPr(sb, branch, files) {
  sb.git('checkout', '-q', '-B', branch, `origin/${sb.cfg.base}`);
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(sb.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(sb.root, rel), c);
    sb.git('add', '-f', rel);
  }
  sb.git('commit', '-q', '-m', `change on ${branch}`);
  sb.git('push', '-q', '-u', 'origin', branch);
  const head = sb.git('rev-parse', 'HEAD');
  sb.git('checkout', '-q', sb.cfg.base);
  let n;
  sb.setGhState((s) => {
    n = s.nextPr++;
    s.prs[n] = { number: n, state: 'OPEN', baseRefName: sb.cfg.base, headRefName: branch, headRefOid: head, title: branch, isDraft: false, mergeCommit: null };
  });
  return { pr: n, head, branch };
}

test('green PR CI returns the head sha', async () => {
  const { sb, ctx } = setup();
  const { pr, head } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  assert.deepEqual(await waitForPrCi(ctx, pr), { ok: true, sha: head });
});

test('red PR CI writes the failing log', async () => {
  const { sb, ctx } = setup();
  sb.setGhState((s) => (s.ciQueue = ['failure']));
  const { pr } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const r = await waitForPrCi(ctx, pr);
  assert.equal(r.kind, 'red');
  assert.deepEqual(r.jobs, ['unit tests']);
  assert.match(fs.readFileSync(r.file, 'utf8'), /AssertionError/);
});

test('starved run is re-run (L-02)', async () => {
  const { sb, ctx } = setup();
  sb.setGhState((s) => (s.ciQueue = ['starved']));
  const { pr } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const r = await waitForPrCi(ctx, pr);
  assert.equal(r.ok, true);
  assert.ok(sb.ghState().calls.some((c) => c.startsWith('run rerun')));
});

test('PR CI that never finishes times out', async () => {
  const { sb, ctx } = setup();
  sb.setGhState((s) => (s.ciQueue = ['pending']));
  const { pr } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  assert.equal((await waitForPrCi(ctx, pr)).kind, 'timeout');
});

test('commit CI timeout is not ok, after one re-run', async () => {
  const { sb, ctx } = setup();
  const sha = sb.git('rev-parse', 'HEAD');
  sb.setGhState((s) => {
    s.baseCiQueue = ['pending'];
    s.rerunQueue = ['pending'];
  });
  const r = await waitForCommitCi(ctx, sha);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
  assert.match(r.text, /twice/);
  assert.equal(sb.ghState().calls.filter((c) => c.startsWith('run rerun')).length, 1);
});

test('commit CI that finishes after the re-run passes', async () => {
  const { sb, ctx } = setup();
  const sha = sb.git('rev-parse', 'HEAD');
  sb.setGhState((s) => (s.baseCiQueue = ['pending']));
  assert.deepEqual(await waitForCommitCi(ctx, sha), { ok: true });
});

test('branch behind base fails pre-merge (L-01)', async () => {
  const { sb, ctx } = setup();
  const a = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  openPr(sb, 'feat/b', { 'b.txt': 'b\n' });
  // base moves: merge feat/b first
  const s = { pr: 2, reviewedSha: prView(ctx, 2).headRefOid, branch: 'feat/b' };
  assert.equal(mergePr(ctx, s).ok, true);
  const r = preMergeChecks(ctx, { branch: a.branch });
  assert.equal(r.ok, false);
  assert.match(r.text, /L-01/);
});

test('pre-merge rejects harness edits, runtime files and a lowered coverage ratchet', async () => {
  const { sb, ctx } = setup({ files: { 'vitest.config.mts': 'export default { test: { coverage: { thresholds: { lines: 80, branches: 70 } } } }\n' } });
  openPr(sb, 'feat/a', { 'loop/run.mjs': '// edited\n', '.loop/result.json': '{}', 'vitest.config.mts': 'export default { test: { coverage: { thresholds: { lines: 79, branches: 70 } } } }\n' });
  const r = preMergeChecks(ctx, { branch: 'feat/a' });
  assert.equal(r.ok, false);
  assert.match(r.text, /loop\/run\.mjs/);
  assert.match(r.text, /\.loop\/result\.json/);
  assert.match(r.text, /lines went from 80 to 79/);
});

test('pre-merge allows a new runner patch and a new rule row', async () => {
  const { sb, ctx } = setup();
  openPr(sb, 'feat/a', { 'loop/patches/LEARN-1.patch': 'diff\n', 'loop/rules/project-rules.json': '{"rules":[]}\n', 'src/x.ts': 'x\n' });
  assert.deepEqual(preMergeChecks(ctx, { branch: 'feat/a' }), { ok: true });
});

test('merge refused when head moved after review', async () => {
  const { sb, ctx } = setup();
  const { pr } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const r = mergePr(ctx, { pr, reviewedSha: '0'.repeat(40), branch: 'feat/a' });
  assert.equal(r.kind, 'moved');
});

test('landed check passes for a normal squash', async () => {
  const { sb, ctx } = setup();
  const { pr, head } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const s = { pr, reviewedSha: head, branch: 'feat/a' };
  const m = mergePr(ctx, s);
  assert.equal(m.ok, true);
  assert.deepEqual(landedCheck(ctx, { baseBefore: m.baseBefore, reviewedSha: head, mergeSha: m.sha }), { ok: true, why: '' });
});

test('landed check fails when merge content differs', async () => {
  const { sb, ctx } = setup();
  sb.setGhState((s) => (s.tamperMerge = true));
  const { pr, head } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const m = mergePr(ctx, { pr, reviewedSha: head, branch: 'feat/a' });
  const r = landedCheck(ctx, { baseBefore: m.baseBefore, reviewedSha: head, mergeSha: m.sha });
  assert.equal(r.ok, false);
  assert.match(r.why, /not reviewed: TAMPERED\.txt/);
});

test('landed check fails when the merge commit is not on the base', async () => {
  const { sb, ctx } = setup();
  const { head } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const r = landedCheck(ctx, { baseBefore: sb.git('rev-parse', 'origin/develop'), reviewedSha: head, mergeSha: head });
  assert.equal(r.ok, false);
  assert.match(r.why, /is not on origin\/develop/);
});

test('coverage thresholds parse', () => {
  assert.deepEqual(coverageThresholds('thresholds: { lines: 81.5, functions: 70, autoUpdate: true }'), { lines: 81.5, functions: 70 });
  assert.deepEqual(coverageThresholds('no block'), {});
});

test('the fake claude emits init then result', () => {
  const { sb } = setup();
  sb.queue({ text: 'hello', structured: { a: 1 } });
  const r = spawnSync(process.execPath, [sb.env.LOOP_CLAUDE_BIN, '-p', 'x'], { cwd: sb.root, env: sb.env, encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].subtype, 'init');
  assert.deepEqual(lines.at(-1).structured_output, { a: 1 });
});

test('pre-merge refuses changed package.json scripts, gate scripts and configs, a non-threshold Vitest change', async () => {
  const pkg = (scripts) => JSON.stringify({ name: 'x', scripts, dependencies: {} }, null, 2) + '\n';
  const vitest = (lines, extra = '') => `export default { test: { coverage: { ${extra}thresholds: { lines: ${lines}, autoUpdate: true } } } }\n`;
  const { sb, ctx } = setup({ files: { 'package.json': pkg({ 'check:rules': 'node loop/scripts/check-rules.mjs' }), 'scripts/ac-trace.mjs': '// x\n', 'vitest.config.mts': vitest(80), 'playwright.config.ts': '// x\n' } });
  openPr(sb, 'feat/a', { 'package.json': pkg({ 'check:rules': 'node -e 0' }), 'scripts/ac-trace.mjs': '// gutted\n', 'playwright.config.ts': '// y\n', 'vitest.config.mts': vitest(90, "exclude: ['src/**'], ") });
  const r = preMergeChecks(ctx, { branch: 'feat/a' });
  assert.equal(r.ok, false);
  assert.match(r.text, /package\.json: the "scripts" changed/);
  assert.match(r.text, /scripts\/ac-trace\.mjs/);
  assert.match(r.text, /playwright\.config\.ts/);
  assert.match(r.text, /only the coverage threshold numbers may change/);
});

test('pre-merge allows raised thresholds and new dependencies', async () => {
  const vitest = (lines) => `export default { test: { coverage: { thresholds: { lines: ${lines}, autoUpdate: true } } } }\n`;
  const { sb, ctx } = setup({ files: { 'package.json': '{"scripts":{"a":"b"},"dependencies":{}}\n', 'vitest.config.mts': vitest(80) } });
  openPr(sb, 'feat/a', { 'package.json': '{"scripts":{"a":"b"},"dependencies":{"zod":"4.0.0"}}\n', 'vitest.config.mts': vitest(82.5) });
  assert.deepEqual(preMergeChecks(ctx, { branch: 'feat/a' }), { ok: true });
});

test('a commented-out higher threshold does not hide a lowered one', () => {
  assert.deepEqual(coverageThresholds('// thresholds: { lines: 100 }\nthresholds: { lines: 0 }'), { lines: 0 });
});

test('a non-ASCII file name under a protected path is still caught', async () => {
  const { sb, ctx } = setup();
  openPr(sb, 'feat/a', { '.github/workflows/é.yml': 'on: push\n' });
  const r = preMergeChecks(ctx, { branch: 'feat/a' });
  assert.equal(r.ok, false);
  assert.match(r.text, /\.github\/workflows\/é\.yml/);
});

test('landed check catches a whitespace-only change', async () => {
  const { sb, ctx } = setup();
  sb.setGhState((s) => (s.tamperWhitespace = true));
  const { pr, head } = openPr(sb, 'feat/a', { 'a.py': 'def f():\n    return 1\n' });
  const m = mergePr(ctx, { pr, reviewedSha: head, branch: 'feat/a' });
  const r = landedCheck(ctx, { baseBefore: m.baseBefore, reviewedSha: head, mergeSha: m.sha });
  assert.equal(r.ok, false);
  assert.match(r.why, /a\.py/);
});

test('merge is refused when the base moved after CI and review (L-01 at merge time)', async () => {
  const { sb, ctx } = setup();
  const a = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  const b = openPr(sb, 'feat/b', { 'b.txt': 'b\n' });
  assert.equal(mergePr(ctx, { pr: b.pr, reviewedSha: b.head, branch: 'feat/b' }).ok, true);
  const r = mergePr(ctx, { pr: a.pr, reviewedSha: a.head, branch: 'feat/a' });
  assert.equal(r.kind, 'behind');
});

test('a PR merged by someone else is reported as merged, not closed', async () => {
  const { sb, ctx } = setup();
  const { pr } = openPr(sb, 'feat/a', { 'a.txt': 'a\n' });
  sb.setGhState((s) => (s.prs[pr].state = 'MERGED'));
  assert.equal((await waitForPrCi(ctx, pr)).kind, 'merged');
});

test('pre-merge refuses a missing contract and a contract that leaves out an AC of the item', async () => {
  const { itemAcs } = await import('../lib/github.mjs');
  const item = { id: 'E1-1', title: 'Form', refs: ['AC-1.1', 'docs/REQUIREMENTS.md'], scope: 'Covers AC-1.2 and AC-1.10.' };
  assert.deepEqual(itemAcs(item), ['AC-1.2', 'AC-1.10', 'AC-1.1']);
  const { sb, ctx } = setup();
  openPr(sb, 'feat/a', { 'src/x.ts': 'x\n' });
  const none = preMergeChecks(ctx, { branch: 'feat/a' }, item);
  assert.equal(none.ok, false);
  assert.match(none.text, /docs\/contracts\/E1-1\.md` is missing/);
  // AC-1.10 in the contract must not count as AC-1.1
  openPr(sb, 'feat/b', { 'docs/contracts/E1-1.md': 'AC-1.2 by a unit test. AC-1.10 by a journey.\n' });
  const partial = preMergeChecks(ctx, { branch: 'feat/b' }, item);
  assert.equal(partial.ok, false);
  assert.match(partial.text, /leaves out AC-1\.1:/);
  openPr(sb, 'feat/c', { 'docs/contracts/E1-1.md': 'AC-1.1, AC-1.2 and AC-1.10, each with a test.\n' });
  assert.deepEqual(preMergeChecks(ctx, { branch: 'feat/c' }, item), { ok: true });
  // an item that names no AC (FIX, LEARN) is not asked for one
  assert.deepEqual(preMergeChecks(ctx, { branch: 'feat/a' }, { id: 'FIX-1', title: 'x', refs: [], scope: 'y' }), { ok: true });
});

test('branch protection is read from the branch or from a ruleset', async () => {
  const { branchProtected } = await import('../lib/github.mjs');
  const { sb, ctx } = setup();
  assert.equal(branchProtected(ctx, 'develop'), true);
  sb.setGhState((s) => (s.unprotected = ['develop']));
  assert.equal(branchProtected(ctx, 'develop'), false);
  sb.setGhState((s) => (s.rulesets = { develop: [{ type: 'pull_request' }] }));
  assert.equal(branchProtected(ctx, 'develop'), true);
});
