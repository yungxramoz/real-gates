import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, configProblems, deepMerge, loadConfig, versionNumber } from '../lib/config.mjs';

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
  const p = configProblems(deepMerge(DEFAULTS, { ...runnable, repo: '' }));
  assert.equal(p.length, 1);
  assert.match(p[0], /^repo:/);
});

test('a fully set config has no problems', () => {
  assert.deepEqual(configProblems(deepMerge(DEFAULTS, runnable)), []);
});

test('base equal to production is rejected', () => {
  const p = configProblems(deepMerge(DEFAULTS, { ...runnable, base: 'main' }));
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
  const cfg = deepMerge(DEFAULTS, { ...runnable, deploy: { devUrl: '' } });
  assert.ok(configProblems(cfg, { backlog: { items: [{ ui: true }] } }).some((x) => /devUrl/.test(x)));
  assert.ok(!configProblems(cfg, { backlog: { items: [{ ui: false }] } }).some((x) => /devUrl/.test(x)));
});

test('bypassing permissions is not a supported mode', () => {
  assert.ok(configProblems(deepMerge(DEFAULTS, { ...runnable, permissionMode: 'bypassPermissions' })).some((x) => /not supported/.test(x)));
});

test('version numbers compare', () => {
  assert.ok(versionNumber('2.1.319 (Claude Code)') > versionNumber('2.1.295'));
  assert.equal(versionNumber('nope'), 0);
});
