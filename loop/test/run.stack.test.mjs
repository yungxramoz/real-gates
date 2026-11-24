// The runner, end to end, with a fake claude and a fake gh over a real git sandbox.
// The stack through the runner: a project's blocks give the sessions their words, and a stack that
// cannot do so stops the run before any work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { happyItem, smokeStep } from './helpers/sandbox.mjs';
import { box } from './helpers/scenario.mjs';

const WEB_NOT_DEPLOYED = ['forge/github', 'toolchain/pnpm-vitest', 'product/web-ui', 'hosting/none'];

test('a work type that is accepted where no block has words for stops the run in the preflight', async () => {
  const sb = box({ stack: WEB_NOT_DEPLOYED, backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'screen', ui: true }] } });
  fs.rmSync(path.join(sb.root, 'loop', 'stack', 'product', 'web-ui', 'prompts', 'accept-drive.local.md'));
  sb.queue(smokeStep(), happyItem('U1', { ui: true }));
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /work type "ui" is accepted on the merged develop, but no block of the stack has a prompts\/accept-drive\.local\.md \(or accept-drive\.md\) for it, which loop\/prompts\/accept\.md includes/);
  assert.equal(sb.calls().length, 0);
  // a backlog that has no screen does not need those words
  const none = box({ stack: WEB_NOT_DEPLOYED });
  fs.rmSync(path.join(none.root, 'loop', 'stack', 'product', 'web-ui', 'prompts', 'accept-drive.local.md'));
  none.queue(smokeStep(), { text: 'no result' });
  const ok = await none.run(['--once', '--max-iterations', '2']);
  assert.doesNotMatch(ok.stderr, /is accepted on the merged/);
});

const LOCAL_APP = ['forge/github', 'toolchain/vite-plus', 'framework/react-vite', 'framework/fastify', 'product/web-ui', 'product/http-api', 'database/sqlite', 'hosting/none'];

test('a local full-stack app built from blocks alone runs through the loop: an endpoint is reviewed as one and accepted on the base', async () => {
  const sb = box({ stack: LOCAL_APP, backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'an endpoint', type: 'api' }] } });
  const scores = { contract: 8, errors: 8, robustness: 9, security: 8 };
  sb.queue(smokeStep(), happyItem('A1')[0], { structured: { verdict: 'approve', blocking: [], scores, summary: 'fine' } }, { structured: { pass: true, failures: [], summary: 'good' } }, { structured: { markdown: '# M1\n', screenshots: [] } });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'accept', 'packet']);
  assert.equal(sb.state().items.A1.status, 'done');
  assert.deepEqual(sb.state().packed, ['M1']);
  // the run says once, before it starts, that part of this stack is not proven yet
  assert.match(r.stdout + r.stderr, /the stack uses blocks no project has run on yet \(toolchain\/vite-plus, framework\/react-vite, framework\/fastify, product\/http-api, database\/sqlite\): the gates and words they bring are tested, not proven/);
  const [, build, review, accept, packet] = sb.calls().map((c) => c.task);
  assert.match(build, /`pnpm check` \(the gate wiring check, then format, lint and types with `vp check`/);
  assert.match(build, /A new or changed endpoint \(work type `api`\) gets at least one end-to-end test/);
  assert.match(build, /A change to the database schema is a new file in `migrations\/`/);
  assert.match(review, /under\s+exactly these keys: `contract`, `errors`, `robustness`, `security`/);
  assert.match(review, /\*\*Use it like a client\*\* \(items of work type `api`\)/);
  assert.match(accept, /Nothing is deployed for this project: you test the merged `develop` itself/);
  assert.match(accept, /3\. Call \*\*every endpoint\*\* this milestone enables on that local address/);
  assert.match(accept, /4\. Score every endpoint on the rubric/);
  assert.match(packet, /save a transcript of its main example/);
  for (const task of [build, review, accept, packet]) assert.doesNotMatch(task, /Playwright|Dev URL|Supabase|Vercel|\{\{/);
  const schema = JSON.parse(sb.calls()[2].args[sb.calls()[2].args.indexOf('--json-schema') + 1]);
  assert.deepEqual(Object.keys(schema.properties.scores.properties), Object.keys(scores));
  // an endpoint reviewed without one of its scores is not approved
  const short = box({ stack: LOCAL_APP, backlog: { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'an endpoint', type: 'api' }] } });
  short.queue(smokeStep(), happyItem('A1')[0], { structured: { verdict: 'approve', blocking: [], scores: { contract: 8, errors: 8, robustness: 4 }, summary: 'fine' } }, { sleepMs: 1, text: 'stop here' });
  await short.run(['--once', '--max-iterations', '3']);
  assert.match(short.state().items.A1.lastReview.blocking.map((b) => b.issue).join('|'), /robustness scored 4 < 7\|the item was reviewed without a score for: security/);
});

test('a stack of proven blocks starts without the note about drafts', async () => {
  const sb = box();
  sb.queue(smokeStep(), { text: 'no result' });
  const r = await sb.run(['--once', '--max-iterations', '2']);
  assert.doesNotMatch(r.stdout + r.stderr, /no project has run on yet/);
});

test('a prompt that includes a fragment no block of the stack has words for stops the run in the preflight', async () => {
  const sb = box();
  fs.rmSync(path.join(sb.root, 'loop', 'stack', 'product', 'web-ui', 'prompts', 'review-drive.md'));
  sb.queue(smokeStep(), happyItem('A1'));
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /loop\/prompts\/review\.md includes \{\{>review-drive\}\}, but no block of the stack \(forge\/github, toolchain\/pnpm-vitest, framework\/next, product\/web-ui, database\/supabase, hosting\/vercel\) has a prompts\/review-drive\.md/);
  assert.equal(sb.calls().length, 0);
});

test('a project lists its own blocks instead of naming a profile, and a list that cannot be a stack stops the run', async () => {
  // the CLI stack without a profile: the same blocks, named by the project
  const own = box({ profile: 'node-cli', config: { profile: '' }, backlog: { milestones: ['M1'], items: [{ id: 'C1', milestone: 'M1', title: 'a command', type: 'command' }] } });
  own.queue(smokeStep(), { text: 'no result' });
  await own.run(['--once', '--max-iterations', '2']);
  assert.match(own.file('.loop/current-task.md'), /`npm run check` \(syntax, unit tests, coverage thresholds\) and `npm run test:e2e` must pass/);
  // two hosting blocks, and a block that is not there
  const two = box({ config: { stack: ['forge/github', 'toolchain/pnpm-vitest', 'product/web-ui', 'hosting/vercel', 'hosting/none'] } });
  let r = await two.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stack: hosting\/vercel and hosting\/none are both hosting blocks\. A stack has one/);
  const unknown = box({ config: { stack: ['forge/github', 'toolchain/pnpm-vitest', 'product/desktop'] } });
  r = await unknown.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stack: "product\/desktop" is not a block under loop\/stack\/ \(known: database\/sqlite, database\/supabase, /);
  assert.equal(two.calls().length + unknown.calls().length, 0);
});

test('the build task carries the stack\'s own words for proving a change', async () => {
  const sb = box();
  sb.queue(smokeStep(), { text: 'no result' });
  await sb.run(['--once', '--max-iterations', '2']);
  const task = sb.file('.loop/current-task.md');
  assert.match(task, /`pnpm check` and `pnpm build` must pass/);
  assert.doesNotMatch(task, /\{\{>/);
  // the same core prompt with another toolchain's words
  const other = box();
  fs.writeFileSync(path.join(other.root, 'loop', 'stack', 'toolchain', 'pnpm-vitest', 'prompts', 'build-proof.md'), '- `make check` must pass. Item {{ITEM_ID}}.\n');
  // committed on the base, as a real block is: the runner keeps uncommitted tracked changes aside
  other.git('add', 'loop/stack/toolchain/pnpm-vitest/prompts/build-proof.md');
  other.git('commit', '-q', '-m', 'another toolchain');
  other.git('push', '-q', 'origin', 'develop');
  other.queue(smokeStep(), { text: 'no result' });
  await other.run(['--once', '--max-iterations', '2']);
  assert.match(other.file('.loop/current-task.md'), /`make check` must pass\. Item A1\./);
  assert.doesNotMatch(other.file('.loop/current-task.md'), /pnpm check/);
});
