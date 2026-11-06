import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseMigrationList, run } from '../adapters/postmerge-supabase-cli.mjs';
import { createProc } from '../lib/proc.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));
const step = { adapter: 'supabase-cli', migrationsDir: 'supabase/migrations', dbUrlEnv: 'DEV_DB_URL' };

/** A sandbox whose base has the given migration files committed. Returns the commit sha. */
function setup(files = {}, { env = { DEV_DB_URL: 'postgresql://dev.example.com/postgres' } } = {}) {
  const sb = makeSandbox();
  boxes.push(sb);
  for (const [name, sql] of Object.entries(files)) {
    const p = path.join(sb.root, 'supabase', 'migrations', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sql);
  }
  if (Object.keys(files).length) {
    sb.git('add', 'supabase');
    sb.git('commit', '-q', '-m', 'migrations');
  }
  const ctx = { proc: createProc({ root: sb.root, env: () => sb.env }), env: { ...sb.env, ...env } };
  return { sb, ctx, sha: sb.git('rev-parse', 'HEAD') };
}
const item = { id: 'A1' };

test('the migration list table parses', () => {
  const t = '\n   Local          | Remote         | Time (UTC)\n  ----------------|----------------|----\n   20260101000000 | 20260101000000 | x\n   20260202000000 |                | y\n';
  assert.deepEqual(parseMigrationList(t), { local: ['20260101000000', '20260202000000'], remote: ['20260101000000'] });
});

test('no migrations is ok', () => {
  const { ctx, sha } = setup();
  assert.equal(run(ctx, { mergeSha: sha, item, step }).ok, true);
});

test('push then a verified list is ok', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_init.sql': 'create table t (id int);\n' });
  const r = run(ctx, { mergeSha: sha, item, step });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(sb.supabaseState().remote, ['20260101000000']);
});

test('an earlier gap is applied too', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_a.sql': 'create table a (id int);\n', '20260202000000_b.sql': 'create table b (id int);\n' });
  sb.setSupabaseState((s) => (s.remote = []));
  assert.equal(run(ctx, { mergeSha: sha, item, step }).ok, true);
  assert.deepEqual(sb.supabaseState().remote, ['20260101000000', '20260202000000']);
});

test('destructive file holds and is not pushed', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_drop.sql': '-- clean up\ndrop table old_stuff;\n' });
  const r = run(ctx, { mergeSha: sha, item, step });
  assert.equal(r.ok, false);
  assert.match(r.why, /destructive/);
  assert.match(r.ownerAction, /20260101000000_drop\.sql/);
  assert.ok(!sb.supabaseState().calls.some((c) => c.startsWith('db push')));
});

test('a push that applies nothing holds (no silent pass)', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_init.sql': 'create table t (id int);\n' });
  sb.setSupabaseState((s) => (s.silentPush = true));
  const r = run(ctx, { mergeSha: sha, item, step });
  assert.equal(r.ok, false);
  assert.match(r.why, /not applied after the push/);
});

test('a failing push holds', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_init.sql': 'create table t (id int);\n' });
  sb.setSupabaseState((s) => (s.failPush = true));
  assert.match(run(ctx, { mergeSha: sha, item, step }).why, /relation "x" does not exist/);
});

test('remote missing a version the repo has is caught after an out-of-band change', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_init.sql': 'create table t (id int);\n' });
  sb.setSupabaseState((s) => (s.remote = ['20260101000000', '20259999000000']));
  const r = run(ctx, { mergeSha: sha, item, step });
  assert.equal(r.ok, false);
  assert.match(r.why, /20259999000000/);
});

test('missing DB URL env holds with an owner action', () => {
  const { ctx, sha } = setup({ '20260101000000_init.sql': 'create table t (id int);\n' }, { env: { DEV_DB_URL: '' } });
  const r = run(ctx, { mergeSha: sha, item, step });
  assert.equal(r.ok, false);
  assert.match(r.ownerAction, /Set DEV_DB_URL/);
});

test('an unreachable database holds', () => {
  const { sb, ctx, sha } = setup({ '20260101000000_init.sql': 'create table t (id int);\n' });
  sb.setSupabaseState((s) => (s.failList = true));
  assert.match(run(ctx, { mergeSha: sha, item, step }).why, /migration list failed/);
});
