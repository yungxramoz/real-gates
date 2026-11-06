import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRules } from '../scripts/check-rules.mjs';

const rule = (over = {}) => ({ id: 'P-1', target: 'shell', pattern: '\\bdocker\\s+run\\b', reason: 'no docker', examples: { block: 'docker run x', allow: 'docker ps' }, ...over });
const t = (...rules) => ({ rules });

test('adding a valid rule passes', () => {
  assert.deepEqual(checkRules(t(), t(rule())), []);
  assert.deepEqual(checkRules(t(rule()), t(rule(), rule({ id: 'P-2' }))), []);
});
test('removing a base rule fails', () => {
  assert.match(checkRules(t(rule()), t()).join(), /P-1: removed/);
});
test('changing a base rule fails, even a reason', () => {
  assert.match(checkRules(t(rule()), t(rule({ reason: 'softer' }))).join(), /P-1: changed/);
  assert.match(checkRules(t(rule()), t(rule({ phases: ['review'] }))).join(), /P-1: changed/);
});
test('key order alone is not a change', () => {
  const r = rule();
  const reordered = Object.fromEntries(Object.entries(r).reverse());
  assert.deepEqual(checkRules(t(r), t(reordered)), []);
});
test('duplicate id fails', () => {
  assert.match(checkRules(null, t(rule(), rule())).join(), /duplicate id/);
});
test('invalid regex fails', () => {
  assert.match(checkRules(null, t(rule({ pattern: '(' }))).join(), /not a valid regular expression/);
});
test('a block example the rule does not match fails', () => {
  assert.match(checkRules(null, t(rule({ examples: { block: 'podman run', allow: 'docker ps' } }))).join(), /block example/);
});
test('an allow example the rule matches fails', () => {
  assert.match(checkRules(null, t(rule({ examples: { block: 'docker run x', allow: 'docker run y' } }))).join(), /allow example/);
});
test('missing reason, examples or a bad target fail', () => {
  const p = checkRules(null, t({ id: 'P-9', target: 'disk', pattern: 'x' })).join('|');
  assert.match(p, /target must be/);
  assert.match(p, /needs a reason/);
  assert.match(p, /needs examples/);
});
test('the CLI passes on the shipped empty table', () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-rules.mjs');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check-rules: OK/);
});
