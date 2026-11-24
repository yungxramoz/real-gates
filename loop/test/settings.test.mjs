// The guard snapshot (loop/lib/settings.mjs): every session runs the guard as it is on the base
// branch, byte for byte, whatever the working tree says. It is read with one git process.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProc } from '../lib/proc.mjs';
import { GUARD_FILES, baseFiles, snapshotGuard } from '../lib/settings.mjs';

const tmps = [];
after(() => tmps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

/** A repository whose `origin/develop` holds `files`; the working tree can then be changed. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-settings-'));
  tmps.push(root);
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  };
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  git('init', '-q', '-b', 'develop');
  for (const [k, v] of Object.entries({ 'user.email': 'loop@example.com', 'user.name': 'Loop Tester', 'core.autocrlf': 'false' })) git('config', k, v);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  // counts the git processes the runner starts
  const calls = [];
  const proc = createProc({ root });
  const sh = proc.sh;
  proc.sh = (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '));
    return sh(cmd, args, opts);
  };
  return { root, write, proc, calls };
}

test('files are read from the base byte for byte, a missing one is null, and one git process reads them all', () => {
  const binary = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x0a, 0x80]);
  const r = repo({ 'a.txt': 'one\n', 'dir/crlf.txt': 'two\r\nlines\r\n', 'no-newline.txt': 'abc', 'empty.txt': '', 'bin.dat': binary, 'last.txt': 'the one after a missing file is still its own\n' });
  // a working tree that has moved on is not what is read
  r.write('a.txt', 'edited\n');
  const got = baseFiles('develop', ['a.txt', 'dir/crlf.txt', 'no-newline.txt', 'empty.txt', 'bin.dat', 'gone.txt', 'dir', 'last.txt'], r.proc);
  assert.deepEqual(got.slice(0, 4).map((b) => b.toString('utf8')), ['one\n', 'two\r\nlines\r\n', 'abc', '']);
  assert.ok(got[4].equals(binary));
  assert.equal(got[5], null, 'the base does not have it');
  assert.equal(got[6], null, 'a folder is not a file');
  assert.equal(got[7].toString('utf8'), 'the one after a missing file is still its own\n');
  assert.deepEqual(r.calls, ['git cat-file --batch']);
});

test('a base that is not there, or a folder that is no repository, gives no file', () => {
  const r = repo({ 'a.txt': 'one\n' });
  assert.deepEqual(baseFiles('no-such-branch', ['a.txt', 'b.txt'], r.proc), [null, null]);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-settings-'));
  tmps.push(bare);
  assert.deepEqual(baseFiles('develop', ['a.txt'], createProc({ root: bare, env: () => ({ ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(bare) }) })), [null]);
});

test('the snapshot is the guard of the base, not of the working tree; a guard file the base lacks comes from the tree, and the runner is told', () => {
  const onBase = Object.fromEntries(GUARD_FILES.map((rel) => [rel, `// ${rel} on the base\n`]));
  const r = repo(onBase);
  for (const rel of GUARD_FILES) r.write(rel, '// edited in the working tree\n');
  const cfg = { base: 'develop', guard: { packs: [] } };
  const snap = snapshotGuard(r.root, cfg, r.proc);
  assert.equal(snap.fromTree, false);
  for (const rel of GUARD_FILES) assert.equal(fs.readFileSync(path.join(snap.dir, rel), 'utf8'), onBase[rel], rel);
  assert.deepEqual(JSON.parse(fs.readFileSync(snap.config, 'utf8')), cfg);
  assert.equal(snap.entry, path.join(snap.dir, 'loop', 'guard.mjs'));
  assert.equal(r.calls.length, 1, 'one git process for the whole snapshot');

  // the first run of a fresh template: the base has only part of the guard yet
  const [first, ...rest] = GUARD_FILES;
  const fresh = repo({ [first]: '// on the base\n' });
  for (const rel of rest) fresh.write(rel, `// ${rel} in the tree\n`);
  fresh.write(first, '// edited in the working tree\n');
  const part = snapshotGuard(fresh.root, cfg, fresh.proc);
  assert.equal(part.fromTree, true);
  assert.equal(fs.readFileSync(path.join(part.dir, first), 'utf8'), '// on the base\n');
  for (const rel of rest) assert.equal(fs.readFileSync(path.join(part.dir, rel), 'utf8'), `// ${rel} in the tree\n`, rel);
});
