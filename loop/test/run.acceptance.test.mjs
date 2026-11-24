// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// The end of a milestone: acceptance where each kind of item runs, the fix items it queues, and the
// packet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box } from './helpers/scenario.mjs';

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

const events = (sb, type) => sb.file('.loop/events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
const WEB_NOT_DEPLOYED = ['forge/github', 'toolchain/pnpm-vitest', 'product/web-ui', 'hosting/none'];

test('a web UI that is not deployed is accepted on a build of the merged base, started locally', async () => {
  const sb = box({ stack: WEB_NOT_DEPLOYED, backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }] } });
  sb.queue(smokeStep(), happyItem('U1', { ui: true }), { structured: { pass: true, failures: [], summary: 'good' } }, { structured: { markdown: '# M1\n\nOpen it.\n', screenshots: [] } });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'accept', 'packet']);
  assert.equal(sb.state().accept.M1.passed, true);
  assert.match(sb.file('.loop/PROGRESS.md'), /acceptance round 1 on develop: \*\*pass\*\*/);
  assert.deepEqual(events(sb, 'acceptance.round').map((e) => [e.mode, e.places, e.pass]), [['local', ['local'], true]]);
  const [, , review, accept, packet] = sb.calls().map((c) => c.task);
  // the review still scores the design; acceptance starts the merged base instead of opening a site
  assert.match(review, /under\s+exactly these keys: `design_quality`, `originality`, `craft`, `functionality`/);
  assert.match(accept, /Nothing is deployed for this project: you test the merged `develop` itself, at commit `[0-9a-f]{7}`, the way step 2 says\./);
  assert.match(accept, /git worktree add \.loop\/work\/M1\/accept\/wt origin\/develop/);
  assert.match(accept, /check for a string only this commit\s+serves/);
  assert.match(accept, /3\. With Playwright against that local address, at 360 px/);
  assert.match(accept, /4\. Score every screen on the rubric/);
  assert.match(packet, /Work from the build the acceptance step left in\s+`\.loop\/work\/M1\/accept\/wt\/`/);
  assert.match(packet, /git worktree add \.loop\/work\/M1\/packet\/wt origin\/develop/);
  for (const task of [accept, packet]) assert.doesNotMatch(task, /Dev URL|preview protection|The `ui` items|\{\{/);
});

test('a milestone with a screen and a command is accepted once, each kind where it runs, and a fix item takes the rubric of the item it is about', async () => {
  const stack = ['forge/github', 'toolchain/pnpm-vitest', 'framework/next', 'product/web-ui', 'product/cli-command', 'hosting/vercel'];
  const sb = box({ stack, backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }, { id: 'C1', milestone: 'M1', title: 'command', type: 'command' }] } });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ commit: sb.originGit('rev-parse', 'develop') }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfgFile = path.join(sb.root, 'loop', 'loop.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.deploy.devUrl = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const cliScores = { help_and_errors: 8, ergonomics: 8, output: 8, robustness: 8 };
  const command = (id) => [happyItem(id)[0], { structured: { verdict: 'approve', blocking: [], scores: cliScores, summary: 'fine' } }];
  try {
    sb.queue(
      smokeStep(),
      happyItem('U1', { ui: true }),
      command('C1'),
      { structured: { pass: false, failures: [{ title: 'greet --help shows no example', scope: 'Add one.', evidence: 'x', relatedItem: 'C1' }, { title: 'Save button does nothing', scope: 'Confirm the save.', evidence: 'y' }], summary: 'two' } },
      command('ACC-M1-1-1'),
      happyItem('ACC-M1-1-2', { ui: true }),
      { structured: { pass: true, failures: [], summary: 'good' } },
      { structured: { markdown: '# M1\n', screenshots: [] } },
    );
    const r = await sb.run();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const phases = sb.calls().map((c) => c.phase);
    assert.deepEqual(phases, ['smoke', 'build', 'review', 'build', 'review', 'accept', 'build', 'review', 'build', 'review', 'accept', 'packet']);
    // one acceptance session for both kinds, each with its own words under a line that names it
    const accept = sb.calls()[5].task;
    const order = ['**The `ui` items, on the deployed dev site:**\n2. Dev URL:', '**The `command` items, on the merged `develop`:**\n2. Install what a user would get', '**The `ui` items, on the deployed dev site:**\n4. Score every screen', '**The `command` items, on the merged `develop`:**\n4. Score every command'].map((t) => accept.indexOf(t));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `the parts are there and in order: ${order.join(', ')}`);
    assert.match(accept, /serves commit `[0-9a-f]{7}`\. The `command` items are not deployed: you test them on the merged `develop` itself, at the same commit, the way their step 2 says\. Steps 2 to 4 come once for each kind of item/);
    assert.doesNotMatch(accept, /\{\{/);
    // the fix item for the command is reviewed as a command, the one nobody was named for as the milestone's first accepted type
    const types = Object.fromEntries(sb.state().extra.map((e) => [e.id, e.type]));
    assert.deepEqual(types, { 'ACC-M1-1-1': 'command', 'ACC-M1-1-2': 'ui' });
    assert.deepEqual(events(sb, 'acceptance.round').map((e) => [e.mode, e.places, e.pass]), [['site', ['site', 'local'], false], ['site', ['site', 'local'], true]]);
    assert.match(sb.file('.loop/PROGRESS.md'), /acceptance round 2 on dev and on develop: \*\*pass\*\*/);
    const packet = sb.calls()[11].task;
    assert.match(packet, /\*\*The `ui` items, on the deployed dev site:\*\*\n1\. Dev URL:/);
    assert.match(packet, /\*\*The `command` items, on the merged `develop`:\*\*\n1\. Nothing is deployed for this project\. Work from the installed package/);
  } finally {
    server.close();
  }
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
