// The runner's child processes (loop/lib/proc.mjs): a git command that talks to the remote is
// tried again when the network failed, so one bad moment does not end an unattended run.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TRANSIENT_GIT, createProc } from '../lib/proc.mjs';

const tmps = [];
after(() => tmps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

/** A fake git: fails `fails` times with `stderr`, then prints "ok". It counts its calls in a file. */
function fakeGit({ fails, stderr, code = 128 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-proc-'));
  tmps.push(dir);
  const calls = path.join(dir, 'calls.txt');
  const bin = path.join(dir, 'git.mjs');
  fs.writeFileSync(
    bin,
    `import fs from 'node:fs';
const calls = ${JSON.stringify(calls)};
const n = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(calls, process.argv.slice(2).join(' ') + '\\n');
if (n < ${fails}) {
  process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${code});
}
process.stdout.write('ok\\n');
`,
  );
  const proc = createProc({ root: dir, env: () => ({ ...process.env, LOOP_GIT_BIN: bin, LOOP_GIT_RETRY_MS: '1' }) });
  return { proc, count: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0) };
}
const EMPTY_REPLY = "fatal: unable to access 'https://example.com/acme/app.git/': Empty reply from server\n";

test('a fetch that fails because the network failed is tried again, and the run goes on', () => {
  const g = fakeGit({ fails: 2, stderr: EMPTY_REPLY });
  assert.equal(g.proc.git('fetch', 'origin', '--prune'), 'ok');
  assert.equal(g.count(), 3);
  // the same through the call that never throws
  const t = fakeGit({ fails: 3, stderr: 'fatal: Could not resolve host: github.com\n' });
  assert.deepEqual([t.proc.gitTry('fetch', 'origin').ok, t.count()], [true, 4]);
});

test('a network that stays down is reported after four tries, with what git said', () => {
  const g = fakeGit({ fails: 99, stderr: EMPTY_REPLY });
  assert.throws(() => g.proc.git('fetch', 'origin', '--prune'), /git fetch origin --prune → exit 128 \(after 4 tries\)\n.*Empty reply from server/);
  assert.equal(g.count(), 4);
  const t = fakeGit({ fails: 99, stderr: EMPTY_REPLY });
  const r = t.proc.gitTry('fetch', 'origin');
  assert.deepEqual([r.ok, r.code, t.count()], [false, 128, 4]);
  assert.match(r.err, /Empty reply from server/);
});

test('any other failure is not waited on: a wrong ref, a rejected push, a command that is not remote', () => {
  // a remote command that failed for a reason trying again cannot change
  const ref = fakeGit({ fails: 99, stderr: "fatal: couldn't find remote ref nope\n" });
  assert.throws(() => ref.proc.git('fetch', 'origin', 'nope'), /exit 128\n/);
  assert.equal(ref.count(), 1);
  // a command that does not talk to the remote, even when its message looks like a network one
  const local = fakeGit({ fails: 99, stderr: EMPTY_REPLY });
  assert.throws(() => local.proc.git('rev-parse', 'HEAD'));
  assert.equal(local.count(), 1);
  // a push is never repeated by the runner: sessions push, and a merge is the forge's
  const push = fakeGit({ fails: 99, stderr: EMPTY_REPLY });
  assert.equal(push.proc.gitTry('push', 'origin', 'x').ok, false);
  assert.equal(push.count(), 1);
  // and a command that works runs once
  const fine = fakeGit({ fails: 0, stderr: '' });
  assert.deepEqual([fine.proc.git('status'), fine.proc.gitTry('fetch', 'origin').out, fine.count()], ['ok', 'ok', 2]);
});

test('what counts as a network failure', () => {
  for (const line of [
    EMPTY_REPLY,
    'fatal: Could not resolve host: github.com',
    'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
    'fatal: the remote end hung up unexpectedly',
    'fatal: early EOF',
    "fatal: unable to access 'https://example.com/a.git/': Failed to connect to example.com port 443: Connection timed out",
    'error: RPC failed; curl 56 OpenSSL SSL_read: Connection was reset, errno 10054',
  ]) assert.ok(TRANSIENT_GIT.test(line), line);
  for (const line of ["fatal: couldn't find remote ref nope", 'fatal: not a git repository', "error: pathspec 'x' did not match any file(s) known to git", 'fatal: Authentication failed', 'remote: Repository not found.', '! [rejected] main -> main (non-fast-forward)']) {
    assert.ok(!TRANSIENT_GIT.test(line), line);
  }
});
