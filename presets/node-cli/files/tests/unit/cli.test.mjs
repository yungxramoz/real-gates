// The command line, in-process: `main` gets its output streams handed in, so nothing is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EXIT, NAME, main, usage } from '../../src/cli.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

async function run(argv, commands) {
  let out = '';
  let err = '';
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } };
  const code = await (commands ? main(argv, io, commands) : main(argv, io));
  return { code, out, err };
}

const greet = {
  greet: { summary: 'Say hello', usage: 'greet <name>', run: (args, io) => void io.stdout.write(`hello ${args[0]}\n`) },
  fail: { summary: 'Always fails', run: () => { throw new Error('the file is not there'); } },
  code: { summary: 'Returns its own exit code', run: () => 7 },
};

test('AC-0.1 --version and -V print the version from package.json and exit 0', async () => {
  for (const flag of ['--version', '-V']) {
    assert.deepEqual(await run([flag]), { code: EXIT.ok, out: `${pkg.version}\n`, err: '' });
  }
});

test('AC-0.2 --help, -h, help and no arguments print the usage on stdout and exit 0', async () => {
  for (const argv of [['--help'], ['-h'], ['help'], []]) {
    const r = await run(argv);
    assert.equal(r.code, EXIT.ok);
    assert.equal(r.err, '');
    assert.match(r.out, new RegExp(`^Usage: ${NAME} <command> \\[options\\]`));
  }
});

test('AC-0.2 the usage lists every command with its summary, in alphabetical order', () => {
  const text = usage(greet);
  assert.match(text, /Commands:\n {2}code {3}Returns its own exit code\n {2}fail {3}Always fails\n {2}greet {2}Say hello\n/);
  assert.match(usage({}), /Commands:\n {2}\(none yet\)\n/);
});

test('AC-0.3 an unknown command names it on stderr, prints nothing on stdout and exits 2', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, EXIT.usage);
  assert.equal(r.out, '');
  assert.equal(r.err, `${NAME}: unknown command "frobnicate". Run "${NAME} --help" for the list.\n`);
  // a name that exists on every object is still not a command
  assert.equal((await run(['toString'])).code, EXIT.usage);
});

test('a command runs with the rest of the arguments and exits 0 when it returns nothing', async () => {
  assert.deepEqual(await run(['greet', 'Ada'], greet), { code: EXIT.ok, out: 'hello Ada\n', err: '' });
  assert.equal((await run(['code'], greet)).code, 7);
});

test('--help after a command prints that command\'s usage and does not run it', async () => {
  const r = await run(['greet', '--help'], greet);
  assert.deepEqual(r, { code: EXIT.ok, out: `Usage: ${NAME} greet <name>\n\nSay hello\n`, err: '' });
  assert.match((await run(['fail', '-h'], greet)).out, new RegExp(`^Usage: ${NAME} fail\n`));
});

test('a command that throws exits 1 with one line on stderr and no stack trace', async () => {
  const r = await run(['fail'], greet);
  assert.deepEqual(r, { code: EXIT.failed, out: '', err: `${NAME} fail: the file is not there\n` });
});
