// The runner's child processes (loop/lib/proc.mjs): a git command that talks to the remote, and a
// gh call that could not reach GitHub, are tried again when the network failed, so one bad moment
// does not end an unattended run.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TRANSIENT_GH, TRANSIENT_GIT, UNSENT_GH, createProc, ghReads } from '../lib/proc.mjs';

const tmps = [];
after(() => tmps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

/** A fake git (or gh): fails `fails` times with `stderr`, then prints "ok". It counts its calls in a file. */
function fakeGit({ fails, stderr, code = 128, name = 'git' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-proc-'));
  tmps.push(dir);
  const calls = path.join(dir, 'calls.txt');
  const bin = path.join(dir, `${name}.mjs`);
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
  const proc = createProc({ root: dir, env: () => ({ ...process.env, LOOP_GIT_BIN: bin, LOOP_GIT_RETRY_MS: '1', LOOP_GH_BIN: bin, LOOP_GH_RETRY_MS: '1' }) });
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

// gh: the run that ended on `gh pr view` while the network was gone for a moment
const DIAL =
  'Post "https://api.github.com/graphql": dial tcp 20.250.119.72:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time.\n';
const BAD_GATEWAY = 'HTTP 502: 502 Bad Gateway (https://api.github.com/repos/acme/app/pulls/22)\n';
const CLOSED = 'Get "https://api.github.com/repos/acme/app/actions/runs/7/jobs?per_page=100": EOF\n';

test('a gh read that could not reach GitHub is tried again, and the run goes on', () => {
  const g = fakeGit({ name: 'gh', fails: 2, stderr: DIAL, code: 1 });
  assert.equal(g.proc.gh('pr', 'view', '22', '--repo', 'acme/app', '--json', 'state'), 'ok');
  assert.equal(g.count(), 3);
  // a GitHub hiccup on a read counts too
  const t = fakeGit({ name: 'gh', fails: 1, stderr: BAD_GATEWAY, code: 1 });
  assert.deepEqual([t.proc.ghTry('api', 'repos/acme/app/commits/abc/check-runs').ok, t.count()], [true, 2]);
  // a connection closed before the answer came: gh says only "EOF"
  const eof = fakeGit({ name: 'gh', fails: 1, stderr: CLOSED, code: 1 });
  assert.equal(eof.proc.gh('api', 'repos/acme/app/actions/runs/7/jobs?per_page=100'), 'ok');
  assert.equal(eof.count(), 2);
});

test('GitHub out of reach for good is reported after six tries, with what gh said', () => {
  const g = fakeGit({ name: 'gh', fails: 99, stderr: DIAL, code: 1 });
  assert.throws(() => g.proc.gh('pr', 'view', '22'), /gh pr view 22 → exit 1 \(after 6 tries\)\n.*connectex/);
  assert.equal(g.count(), 6);
  const t = fakeGit({ name: 'gh', fails: 99, stderr: DIAL, code: 1 });
  const r = t.proc.ghTry('auth', 'status');
  assert.deepEqual([r.ok, t.count()], [false, 6]);
});

test('a gh write is sent again only when it never left, so nothing happens twice', () => {
  // the connection was never made: the merge did not reach GitHub
  const unsent = fakeGit({ name: 'gh', fails: 1, stderr: DIAL, code: 1 });
  assert.equal(unsent.proc.ghTry('pr', 'merge', '22', '--squash', '--match-head-commit', 'abc').ok, true);
  assert.equal(unsent.count(), 2);
  // a 502 may come after GitHub merged: the runner reads the PR again instead of merging twice
  const sent = fakeGit({ name: 'gh', fails: 99, stderr: BAD_GATEWAY, code: 1 });
  assert.equal(sent.proc.ghTry('pr', 'merge', '22', '--squash').ok, false);
  assert.equal(sent.count(), 1);
  // so may a connection that closed before the answer
  const closed = fakeGit({ name: 'gh', fails: 99, stderr: CLOSED.replace('Get', 'Post'), code: 1 });
  assert.equal(closed.proc.ghTry('pr', 'review', '22', '--comment', '--body-file', 'x').ok, false);
  assert.equal(closed.count(), 1);
  // and a failure that is no network failure is never repeated, read or write
  const notFound = fakeGit({ name: 'gh', fails: 99, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99.\n', code: 1 });
  assert.throws(() => notFound.proc.ghJson('pr', 'view', '99'));
  assert.equal(notFound.count(), 1);
});

test('which gh calls only read', () => {
  for (const args of [['auth', 'status'], ['pr', 'view', '1'], ['run', 'view', '2', '--log-failed'], ['api', 'repos/a/b/branches/main'], ['api', '-X', 'GET', 'repos/a/b', '-f', 'q=1']]) {
    assert.ok(ghReads(args), args.join(' '));
  }
  for (const args of [['pr', 'merge', '1'], ['pr', 'review', '1', '--comment'], ['run', 'rerun', '2'], ['api', 'repos/a/b/issues/1/comments', '-f', 'body=x'], ['api', '--method', 'POST', 'x'], ['pr', 'create']]) {
    assert.ok(!ghReads(args), args.join(' '));
  }
});

test('what counts as GitHub out of reach, and what as never sent', () => {
  for (const line of [DIAL, BAD_GATEWAY, CLOSED, 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', 'Get "https://api.github.com/user": net/http: TLS handshake timeout', 'read tcp 10.0.0.2:5050->140.82.121.6:443: wsarecv: An existing connection was forcibly closed by the remote host. connection reset', 'HTTP 503: Service Unavailable']) {
    assert.ok(TRANSIENT_GH.test(line), line);
  }
  for (const line of ['HTTP 404: Not Found (https://api.github.com/repos/a/b)', 'GraphQL: Could not resolve to a PullRequest with the number of 99.', 'Head branch was modified. Review and try the merge again.', 'HTTP 401: Bad credentials', 'Pull request is not mergeable']) {
    assert.ok(!TRANSIENT_GH.test(line), line);
  }
  assert.ok(UNSENT_GH.test(DIAL));
  assert.ok(UNSENT_GH.test('error connecting to api.github.com'));
  assert.ok(!UNSENT_GH.test(BAD_GATEWAY));
  assert.ok(!UNSENT_GH.test(CLOSED));
  assert.ok(!UNSENT_GH.test('connection reset by peer'));
});
