// Every stack profile the harness ships must fit the contract the core reads (loop/profiles/README.md),
// and the CLI profile is run end to end through the scripted runner: a stack with no deployed site,
// no database and its own work type.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configProblems, deepMerge, profileNames } from '../lib/config.mjs';
import { adapterProblems } from '../adapters/index.mjs';
import { acceptMode, acceptTypeName, workType, workTypeName, workTypeProblems } from '../lib/worktypes.mjs';
import { reviewSchema } from '../lib/schemas.mjs';
import { decide } from '../guard/core.mjs';
import { repoRelative } from '../guard/paths.mjs';
import { PRESET, presetConfig } from './helpers/preset.mjs';
import { happyItem, makeSandbox, smokeStep } from './helpers/sandbox.mjs';

const LOOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(LOOP, '..');
const CLI = 'node-cli';
const instance = { repo: 'acme/app', gitAuthor: { name: 'A Person', email: 'person@example.com' }, deploy: { devUrl: 'https://dev.example.com' }, guard: { allowedDbProject: 'abcdefghijklmnopqrst' } };

describe('every shipped profile fits the contract', () => {
  const names = profileNames(REPO);
  test('the web and the CLI profile are both there', () => {
    assert.ok(names.includes('next-supabase-vercel') && names.includes(CLI), names.join(', '));
  });
  for (const name of names) {
    test(`${name}: packs, adapters, ratchets and work types are valid, and only project values are missing`, () => {
      const preset = presetConfig(name);
      assert.deepEqual(adapterProblems(preset), []);
      assert.deepEqual(workTypeProblems(preset, null), []);
      assert.deepEqual(configProblems(deepMerge(preset, instance)), []);
      assert.ok(preset.localGate.commands.length > 0, 'a profile names the commands that prove a change');
      // before /setup-loop every problem is about a value only the project can know
      for (const p of configProblems(preset)) assert.match(p, /^(repo|gitAuthor\.|deploy\.devUrl|guard\.allowedDbProject)/, p);
    });
    test(`${name}: has every fragment the core prompts include`, () => {
      const dir = path.join(LOOP, 'prompts');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\{\{>([\w-]+)\}\}/g)) {
          assert.ok(fs.existsSync(path.join(LOOP, 'profiles', name, 'prompts', `${m[1]}.md`)), `${name} lacks prompts/${m[1]}.md, which loop/prompts/${f} includes`);
        }
      }
    });
    test(`${name}: every fragment is used by a core prompt`, () => {
      const used = new Set(fs.readdirSync(path.join(LOOP, 'prompts')).flatMap((f) => [...fs.readFileSync(path.join(LOOP, 'prompts', f), 'utf8').matchAll(/\{\{>([\w-]+)\}\}/g)].map((m) => m[1])));
      for (const f of fs.readdirSync(path.join(LOOP, 'profiles', name, 'prompts'))) assert.ok(used.has(f.replace(/\.md$/, '').split('.')[0]), `${name}/prompts/${f} is included nowhere`);
    });
  }
});

describe('work types', () => {
  const web = PRESET;
  const cli = presetConfig(CLI);
  test('an item names its type; ui: true is the type "ui", anything else "default"', () => {
    assert.equal(workTypeName({ type: 'command' }), 'command');
    assert.equal(workTypeName({ ui: true }), 'ui');
    assert.equal(workTypeName({ ui: false }), 'default');
    assert.equal(workTypeName({}), 'default');
    assert.deepEqual(workType(web, { ui: true }), { rubric: ['design_quality', 'originality', 'craft', 'functionality'], accept: 'site' });
    assert.deepEqual(workType(cli, { type: 'command' }).rubric, ['help_and_errors', 'ergonomics', 'output', 'robustness']);
    assert.deepEqual(workType(cli, { type: 'unknown' }), { rubric: [], accept: 'none' });
  });
  test('a milestone is accepted the way its items need: on the site, on the base itself, or not at all', () => {
    assert.equal(acceptMode(web, [{ ui: false }, { ui: true }]), 'site');
    assert.equal(acceptMode(web, [{ ui: false }]), 'none');
    assert.equal(acceptMode(cli, [{}, { type: 'command' }]), 'local');
    assert.equal(acceptMode(cli, [{}]), 'none');
    assert.equal(acceptTypeName(cli, [{}, { type: 'command' }]), 'command');
    assert.equal(acceptTypeName(web, [{ ui: false }, { ui: true }]), 'ui');
    assert.equal(acceptTypeName(cli, [{}]), 'default');
  });
  test('the review schema asks for exactly the rubric of the item\'s type', () => {
    assert.deepEqual(Object.keys(reviewSchema(['help_and_errors', 'output']).properties.scores.properties), ['help_and_errors', 'output']);
    assert.equal(reviewSchema(['a']).properties.scores.additionalProperties, false);
    assert.deepEqual(reviewSchema([]).properties.scores, { type: 'object' });
  });
  test('a type the profile does not define, and a site type with nothing deployed, are named problems', () => {
    const backlog = { items: [{ id: 'A', type: 'command' }, { id: 'B', ui: true }, { id: 'C', type: 'screen' }, { id: 'D' }] };
    const p = workTypeProblems(cli, backlog);
    assert.equal(p.length, 2, p.join('|'));
    assert.match(p[0], /backlog item B: work type "ui" is not one of the profile's \(command, default\); `ui: true` means the type "ui"/);
    assert.match(p[1], /backlog item C: work type "screen" is not one of the profile's/);
    assert.deepEqual(workTypeProblems(web, { items: [{ id: 'B', ui: true }] }), []);
    const noSite = deepMerge(web, { deploy: { adapter: 'none' } });
    assert.match(workTypeProblems(noSite, { items: [{ id: 'B', ui: true }] })[0], /work type "ui" is accepted on a deployed site, but deploy\.adapter is "none"/);
    assert.match(workTypeProblems(deepMerge(web, { workTypes: { x: { rubric: ['Bad Name'], accept: 'maybe' } } }), null).join('|'), /workTypes\.x\.rubric.*workTypes\.x\.accept/);
  });
  test('the CLI profile needs no dev URL; the web profile needs one as soon as an item is a screen', () => {
    assert.ok(!configProblems(cli).some((x) => /devUrl/.test(x)));
    assert.ok(configProblems(web).some((x) => /devUrl/.test(x)));
    assert.ok(!configProblems(web, { backlog: { items: [{ ui: false }, { type: 'default' }] } }).some((x) => /devUrl/.test(x)));
  });
});

describe('guard pack: npm', () => {
  const ROOT = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
  const cfg = deepMerge(presetConfig(CLI), { repo: 'acme/app' });
  const sh = (command, phase = 'build') => decide({ tool_name: 'Bash', tool_input: { command } }, { phase, item: 'T1', branch: 'feat/x', cfg, rel: (p) => repoRelative(ROOT, p), isOnBase: () => false, projectRules: [] });
  const blocked = (d, rule) => {
    assert.equal(d.block, true, `expected a block, got ${JSON.stringify(d)}`);
    assert.equal(d.rule, rule);
  };
  const allowed = (d) => assert.equal(d.block, false, `expected allow, got ${JSON.stringify(d)}`);
  test('publishing and registry accounts are refused', () => {
    for (const c of ['npm publish', 'npm publish --access public', 'pnpm publish', 'yarn publish', 'npm unpublish app@1.0.0', 'npm dist-tag add app@1.0.0 latest', 'npm login', 'npm token create', 'cd pkg && npm publish']) blocked(sh(c), 'npm:publish');
  });
  test('a version bump is refused, reading the version is not', () => {
    for (const c of ['npm version patch', 'npm version 1.2.3', 'pnpm version minor']) blocked(sh(c), 'npm:version');
    for (const c of ['npm --version', 'npm version --help', 'node bin/cli.mjs --version', 'npm view app version']) allowed(sh(c));
  });
  test('global installs and npm link are refused, a prefix install under .loop/ is not', () => {
    for (const c of ['npm install -g app', 'npm i --global ./app-0.1.0.tgz', 'npm link', 'npm link && app --help', 'yarn global add app', 'pnpm add -g app']) blocked(sh(c), 'npm:global');
    for (const c of ['npm ci', 'npm install', 'npm install --save-dev c8', 'npm pack --pack-destination .loop/accept-M1', 'npm install --prefix .loop/accept-M1/app .loop/accept-M1/app-0.1.0.tgz', 'npm run check', 'npm run test:e2e']) allowed(sh(c));
  });
  test('the acceptance step can pack and install under .loop/ although it is read-only', () => {
    for (const c of ['git worktree add .loop/accept-wt origin/develop', 'npm pack --pack-destination ../accept-M1', 'npm install --prefix .loop/accept-M1/app .loop/accept-M1/app-0.1.0.tgz', '.loop/accept-M1/app/node_modules/.bin/app --help > .loop/reviews/M1/accept-r1/help.txt', 'git worktree remove --force .loop/accept-wt']) allowed(sh(c, 'accept'));
    blocked(sh('npm publish', 'accept'), 'npm:publish');
  });
  test('the web profile does not carry the npm rules, and the CLI profile not the database ones', () => {
    assert.deepEqual(PRESET.guard.packs, ['github', 'supabase', 'vercel']);
    assert.deepEqual(cfg.guard.packs, ['github', 'npm']);
  });
});

// ------------------------------------------------------------------------- the CLI profile, end to end
const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));
const box = (o) => {
  const sb = makeSandbox({ profile: CLI, ...o });
  boxes.push(sb);
  return sb;
};
const SCORES = { help_and_errors: 8, ergonomics: 8, output: 9, robustness: 8 };
const approve = (scores = SCORES) => ({ structured: { verdict: 'approve', blocking: [], scores, summary: 'fine' } });
const command = (id) => ({ id, milestone: 'M1', title: `${id} command`, type: 'command' });

describe('the CLI profile through the runner', () => {
  test('a command item is reviewed on the CLI rubric and its milestone is accepted on the base itself, with nothing deployed', async () => {
    const sb = box({ backlog: { milestones: ['M1'], items: [command('C1')] } });
    const [build] = happyItem('C1');
    const [fixBuild] = happyItem('ACC-M1-1-1');
    sb.queue(
      smokeStep(),
      build,
      approve(),
      { structured: { pass: false, failures: [{ title: 'greet --help shows no example', scope: 'Add one example to the help of greet; fixed = the example runs as written.', evidence: '.loop/reviews/M1/accept-r1/greet-help.txt' }], summary: 'one failure' } },
      fixBuild,
      approve(),
      { structured: { pass: true, failures: [], summary: 'good' } },
      { structured: { markdown: '# M1\n\nTry `app greet`.\n', screenshots: [] } },
    );
    const r = await sb.run();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const st = sb.state();
    assert.equal(st.items.C1.status, 'done');
    assert.equal(st.items['ACC-M1-1-1'].status, 'done');
    assert.equal(st.extra.find((e) => e.id === 'ACC-M1-1-1').type, 'command', 'the fix item is reviewed on the same rubric');
    assert.equal(st.accept.M1.passed, true);
    assert.deepEqual(st.packed, ['M1']);
    const calls = sb.calls();
    assert.deepEqual(calls.map((c) => c.phase), ['smoke', 'build', 'review', 'accept', 'build', 'review', 'accept', 'packet']);
    assert.match(sb.file('.loop/PROGRESS.md'), /acceptance round 1 on develop: \*\*1 failure\(s\)\*\*/);
    assert.match(sb.file('.loop/PROGRESS.md'), /acceptance round 2 on develop: \*\*pass\*\*/);

    // each step got the CLI's own words, and none of the web preset's
    const [, buildTask, reviewTask, acceptTask, , , , packetTask] = calls.map((c) => c.task);
    assert.match(buildTask, /`npm run check` \(syntax, unit tests, coverage thresholds\) and `npm run test:e2e` must pass/);
    assert.match(buildTask, /`coverage\.thresholds\.json` may change only by raising its numbers/);
    assert.match(reviewTask, /under\s+exactly these keys: `help_and_errors`, `ergonomics`, `output`, `robustness`/);
    assert.match(reviewTask, /calibrated against `docs\/CLI-CONVENTIONS\.md`/);
    assert.match(acceptTask, /Nothing is deployed for this project: you test the merged `develop` itself/);
    assert.match(acceptTask, /npm pack --pack-destination \.\.\/accept-M1/);
    assert.match(packetTask, /save a transcript of `--help`/);
    for (const task of [buildTask, reviewTask, acceptTask, packetTask]) assert.doesNotMatch(task, /Playwright|pnpm|360 px|Vercel|Supabase|\{\{/i);

    // the reviewer was asked for exactly this rubric
    const schema = JSON.parse(calls[2].args[calls[2].args.indexOf('--json-schema') + 1]);
    assert.deepEqual(Object.keys(schema.properties.scores.properties), Object.keys(SCORES));
  });

  test('a command reviewed without one of its scores, or with one below the bar, is not approved', async () => {
    const sb = box({ backlog: { milestones: ['M1'], items: [command('C1')] } });
    const [build] = happyItem('C1');
    sb.queue(smokeStep(), build, approve({ help_and_errors: 8, ergonomics: 8, output: 5 }), { sleepMs: 1, text: 'stop here' });
    await sb.run(['--once', '--max-iterations', '3']);
    const review = sb.state().items.C1.lastReview;
    assert.equal(review.verdict, 'changes');
    assert.match(review.blocking.map((b) => b.issue).join('|'), /output scored 5 < 7\|the item was reviewed without a score for: robustness/);
  });

  test('an item without a rubric is approved without scores and its milestone has no acceptance step', async () => {
    const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'L1', milestone: 'M1', title: 'a parser' }] } });
    sb.queue(smokeStep(), happyItem('L1'), { structured: { markdown: '# M1\n', screenshots: [] } });
    const r = await sb.run();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(sb.state().items.L1.status, 'done');
    assert.deepEqual(sb.calls().map((c) => c.phase), ['smoke', 'build', 'review', 'packet']);
  });

  test('a backlog written for the web preset is refused before any session starts', async () => {
    const sb = box({ backlog: { milestones: ['M1'], items: [{ id: 'U1', milestone: 'M1', title: 'a screen', ui: true }] } });
    sb.queue(smokeStep(), happyItem('U1'));
    const r = await sb.run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /backlog item U1: work type "ui" is not one of the profile's \(command, default\)/);
    assert.equal(sb.calls().length, 0);
  });

  test('the runner\'s local gate is the profile\'s command, and sessions get the npm deny rule', async () => {
    const sb = box();
    assert.deepEqual(presetConfig(CLI).localGate.commands, ['npm run check']);
    sb.queue(smokeStep(), happyItem('A1'));
    await sb.run(['--once']);
    const settings = JSON.parse(sb.file('.loop/claude-settings.json'));
    assert.ok(settings.permissions.deny.includes('Bash(npm publish:*)'));
    assert.ok(!settings.permissions.deny.some((d) => /supabase/.test(d)));
  });
});
