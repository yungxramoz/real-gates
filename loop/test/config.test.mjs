import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, configProblems, deepMerge, loadConfig, versionNumber } from '../lib/config.mjs';
import { PRESET } from './helpers/preset.mjs';

function tmpRepo(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-config-'));
  fs.mkdirSync(path.join(root, 'loop'));
  if (config !== undefined) fs.writeFileSync(path.join(root, 'loop', 'loop.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return root;
}

const runnable = {
  repo: 'acme/app',
  gitAuthor: { name: 'A Person', email: 'person@example.com' },
  deploy: { devUrl: 'https://dev.example.com' },
  guard: { allowedDbProject: 'abcdefghijklmnopqrst' },
};

test('defaults fill missing keys', () => {
  const cfg = loadConfig(tmpRepo({ repo: 'acme/app' }));
  assert.equal(cfg.repo, 'acme/app');
  assert.equal(cfg.base, 'develop');
  assert.equal(cfg.review.minDesignScore, 7);
  assert.equal(cfg.maxCiFixes, 3);
});

test('a missing config file gives the defaults', () => {
  assert.deepEqual(loadConfig(tmpRepo()), deepMerge(DEFAULTS, {}));
});

test('invalid JSON throws a named error', () => {
  assert.throws(() => loadConfig(tmpRepo('{ nope')), /loop[\\/]loop\.config\.json is not valid JSON/);
});

test('empty repo is a named problem', () => {
  const p = configProblems(deepMerge(PRESET, { ...runnable, repo: '' }));
  assert.equal(p.length, 1);
  assert.match(p[0], /^repo:/);
});

test('a fully set config has no problems', () => {
  assert.deepEqual(configProblems(deepMerge(PRESET, runnable)), []);
});

test('base equal to production is rejected', () => {
  const p = configProblems(deepMerge(PRESET, { ...runnable, base: 'main' }));
  assert.ok(p.some((x) => /both "main"/.test(x)));
});

test('nested override keeps sibling defaults', () => {
  const cfg = loadConfig(tmpRepo({ review: { minDesignScore: 8 } }));
  assert.equal(cfg.review.minDesignScore, 8);
  assert.equal(cfg.review.maxRounds, 2);
  assert.equal(cfg.deploy.health, '/api/health');
});

test('arrays replace instead of merging', () => {
  const cfg = loadConfig(tmpRepo({ postMerge: [] }));
  assert.deepEqual(cfg.postMerge, []);
  assert.ok(!configProblems(deepMerge(cfg, { ...runnable, guard: { allowedDbProject: '' } })).some((x) => /allowedDbProject/.test(x)));
});

test('dev URL is only required when the backlog has UI', () => {
  const cfg = deepMerge(PRESET, { ...runnable, deploy: { devUrl: '' } });
  assert.ok(configProblems(cfg, { backlog: { items: [{ ui: true }] } }).some((x) => /devUrl/.test(x)));
  assert.ok(!configProblems(cfg, { backlog: { items: [{ ui: false }] } }).some((x) => /devUrl/.test(x)));
});

test('bypassing permissions is not a supported mode', () => {
  assert.ok(configProblems(deepMerge(PRESET, { ...runnable, permissionMode: 'bypassPermissions' })).some((x) => /not supported/.test(x)));
});

test('version numbers compare', () => {
  assert.ok(versionNumber('2.1.319 (Claude Code)') > versionNumber('2.1.295'));
  assert.equal(versionNumber('nope'), 0);
});

test('the core defaults name no framework, host or database', () => {
  assert.doesNotMatch(JSON.stringify(DEFAULTS), /supabase|vercel|vitest|playwright|pnpm|next/i);
  assert.deepEqual(DEFAULTS.postMerge, []);
  assert.deepEqual(DEFAULTS.gates, { files: [], frozenJsonKeys: [], ratchets: [] });
  assert.deepEqual(DEFAULTS.guard.packs, ['github']);
});

test('the profile sits between the defaults and the project config', () => {
  const root = tmpRepo({ profile: 'python-api', localGate: { commands: ['make check'] }, deploy: { devUrl: 'https://dev.example.com' } });
  fs.mkdirSync(path.join(root, 'loop', 'profiles', 'python-api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'loop', 'profiles', 'python-api', 'profile.json'), JSON.stringify({ localGate: { commands: ['pytest'], timeoutMin: 5 }, deploy: { health: '/healthz', expect: { status: ['ok'] } }, guard: { packs: ['github'] } }));
  const cfg = loadConfig(root);
  assert.equal(cfg.profile, 'python-api');
  assert.deepEqual(cfg.localGate, { commands: ['make check'], timeoutMin: 5 }, 'the project config wins over the profile, key by key');
  assert.deepEqual(cfg.deploy, { adapter: 'http-health', devUrl: 'https://dev.example.com', health: '/healthz', commitField: 'commit', expect: { status: ['ok'] }, bypassSecretEnv: '', bypassHeader: '' });
  assert.equal(cfg.base, 'develop', 'what neither names keeps its default');
});

/** A repo with blocks: { '<category>/<name>': config }. */
function repoWithBlocks(config, blocks, profiles = {}) {
  const root = tmpRepo(config);
  for (const [id, cfg] of Object.entries(blocks)) {
    fs.mkdirSync(path.join(root, 'loop', 'stack', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'loop', 'stack', id, 'block.json'), JSON.stringify({ title: id, description: id, choose: id, config: cfg }));
  }
  for (const [name, profile] of Object.entries(profiles)) {
    fs.mkdirSync(path.join(root, 'loop', 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'loop', 'profiles', name, 'profile.json'), JSON.stringify(profile));
  }
  return root;
}
const BLOCKS = {
  'forge/f': { guard: { packs: ['github'] } },
  'toolchain/t': { localGate: { commands: ['check'], timeoutMin: 5 }, gates: { files: ['scripts/**'] } },
  'product/p': { workTypes: { screen: { rubric: ['craft'], accept: 'site' } }, gates: { files: ['e2e.config.*'] } },
  'hosting/none': { deploy: { adapter: 'none' } },
  'hosting/site': { deploy: { adapter: 'http-health' } },
};

test('the stack sits between the defaults and the profile: its blocks are put together, then the profile and the project override them', () => {
  const profiles = { whole: { stack: ['forge/f', 'toolchain/t', 'product/p'], localGate: { timeoutMin: 9 } } };
  const cfg = loadConfig(repoWithBlocks({ profile: 'whole', localGate: { commands: ['make check'] } }, BLOCKS, profiles));
  assert.deepEqual(cfg.stack, ['forge/f', 'toolchain/t', 'product/p'], 'the stack the config was made from is part of it');
  assert.deepEqual(cfg.gates.files, ['scripts/**', 'e2e.config.*'], 'blocks add to a list');
  assert.deepEqual(cfg.localGate, { commands: ['make check'], timeoutMin: 9 }, 'the project wins over the profile, the profile over the blocks');
  assert.deepEqual(cfg.workTypes, { default: { rubric: [], accept: 'none' }, screen: { rubric: ['craft'], accept: 'site' } }, 'a work type comes with its product block');
  assert.equal(cfg.base, 'develop', 'what no layer names keeps its default');
});

test('a project lists its own blocks, with or without a profile: its list replaces the profile\'s', () => {
  const profiles = { whole: { stack: ['forge/f', 'toolchain/t', 'product/p'], localGate: { timeoutMin: 9 } } };
  const alone = loadConfig(repoWithBlocks({ stack: ['forge/f', 'toolchain/t', 'hosting/none'] }, BLOCKS));
  assert.equal(alone.deploy.adapter, 'none');
  assert.deepEqual(alone.workTypes, DEFAULTS.workTypes);
  const both = loadConfig(repoWithBlocks({ profile: 'whole', stack: ['forge/f', 'toolchain/t', 'hosting/none'] }, BLOCKS, profiles));
  assert.deepEqual(both.stack, ['forge/f', 'toolchain/t', 'hosting/none']);
  assert.deepEqual(both.gates.files, ['scripts/**'], 'the profile\'s blocks are not in the stack');
  assert.equal(both.localGate.timeoutMin, 9, 'what the profile overrides still holds');
  // no stack at all is the core alone
  assert.deepEqual(loadConfig(repoWithBlocks({ stack: [] }, BLOCKS)), DEFAULTS);
});

test('a stack that cannot be one throws a named error', () => {
  assert.throws(() => loadConfig(repoWithBlocks({ stack: ['forge/f', 'toolchain/t', 'hosting/none', 'hosting/site'] }, BLOCKS)), /stack: hosting\/none and hosting\/site are both hosting blocks/);
  assert.throws(() => loadConfig(repoWithBlocks({ stack: ['toolchain/t'] }, BLOCKS)), /stack: no forge block/);
  assert.throws(() => loadConfig(repoWithBlocks({ stack: ['forge/f', 'toolchain/t', 'product/gone'] }, BLOCKS)), /"product\/gone" is not a block under loop\/stack\/ \(known: forge\/f, hosting\/none, hosting\/site, product\/p, toolchain\/t\)/);
  assert.throws(() => loadConfig(repoWithBlocks({ stack: 'forge/f' }, BLOCKS)), /stack must be a list of block names/);
  // two blocks of categories that may be many, setting one value differently
  const clash = { ...BLOCKS, 'product/q': { workTypes: { screen: { rubric: ['craft'], accept: 'local' } } } };
  assert.throws(() => loadConfig(repoWithBlocks({ stack: ['forge/f', 'toolchain/t', 'product/p', 'product/q'] }, clash)), /the stack cannot be put together: product\/p and product\/q both set workTypes\.screen\.accept \("site" and "local"\)\. Take one of the two blocks out of `stack`\./);
});

test('an invalid profile throws a named error', () => {
  const root = tmpRepo({ profile: 'broken' });
  fs.mkdirSync(path.join(root, 'loop', 'profiles', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'loop', 'profiles', 'broken', 'profile.json'), '{ nope');
  assert.throws(() => loadConfig(root), /loop[\\/]profiles[\\/]broken[\\/]profile\.json is not valid JSON/);
  // a name with no folder, and a name that is a path
  assert.throws(() => loadConfig(tmpRepo({ profile: 'nope' })), /profile "nope" \(loop\/loop\.config\.json\) is not a folder under loop\/profiles\//);
  assert.throws(() => loadConfig(tmpRepo({ profile: '../x' })), /is not a folder under loop\/profiles\//);
});

test('an unknown guard pack and an unusable ratchet are named problems', () => {
  const p = configProblems(deepMerge(PRESET, { ...runnable, guard: { packs: ['github', 'oracle'] }, gates: { ratchets: [{ name: 'cov', files: ['x'], number: '(' }] } }));
  assert.ok(p.some((x) => /guard\.packs: "oracle" is not a guard pack/.test(x)), p.join('|'));
  assert.ok(p.some((x) => /gates\.ratchets: "cov" is not usable/.test(x)), p.join('|'));
});

test('building-block patterns must be paths with a * for one name', () => {
  const problems = (blocks) => configProblems(deepMerge(DEFAULTS, { architecture: { blocks } })).filter((p) => p.startsWith('architecture.blocks'));
  assert.deepEqual(loadConfig(tmpRepo({})).architecture, { blocks: [] }, 'no profile: nothing is checked against the tree');
  for (const ok of [[], ['src/lib/*'], ['src/*/', 'src/app/(admin)/*', 'bin/*']]) assert.deepEqual(problems(ok), [], JSON.stringify(ok));
  for (const bad of [['src/lib'], ['src/**'], ['../other/*'], ['/abs/*'], ['src/./*'], ['src\\lib\\*'], [7], 'src/*']) assert.equal(problems(bad).length, 1, JSON.stringify(bad));
});

test('a pack asks for what it needs: the database pack wants the allowed project', () => {
  const noRef = deepMerge(PRESET, { ...runnable, guard: { allowedDbProject: '' } });
  assert.ok(configProblems(noRef).some((x) => /allowedDbProject/.test(x)));
  // without the pack, nobody asks
  assert.ok(!configProblems(deepMerge(noRef, { guard: { packs: ['github'] } })).some((x) => /allowedDbProject/.test(x)));
});

test('no deployed site: adapter "none" needs no dev URL even with UI items', () => {
  const cfg = deepMerge(PRESET, { ...runnable, deploy: { adapter: 'none', devUrl: '' } });
  assert.ok(!configProblems(cfg, { backlog: { items: [{ ui: true }] } }).some((x) => /devUrl/.test(x)));
});
