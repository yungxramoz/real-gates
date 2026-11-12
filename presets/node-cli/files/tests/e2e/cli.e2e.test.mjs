// The real binary as a child process, and the package the way a user gets it: packed, installed
// into an empty folder, run from there. A file that `files` in package.json forgot fails here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = Object.keys(pkg.bin)[0];

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const cli = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
// npm is a .cmd on Windows, so it runs through a shell: one command line, with paths quoted.
const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
const npm = (args, cwd) => spawnSync(`npm ${args.map(quote).join(' ')}`, { cwd, encoding: 'utf8', shell: true });

test('AC-0.1 the binary prints the version on stdout and exits 0', () => {
  const r = cli(join(ROOT, 'bin', 'cli.mjs'), ['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${pkg.version}\n`);
  assert.equal(r.stderr, '');
});

test('AC-0.3 the binary exits 2 on an unknown command and keeps stdout empty', () => {
  const r = cli(join(ROOT, 'bin', 'cli.mjs'), ['frobnicate']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown command "frobnicate"/);
});

test('AC-0.4 the packed package, installed into an empty folder, runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-pack-'));
  temps.push(dir);
  const packed = npm(['pack', '--pack-destination', dir, '--json'], ROOT);
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = join(dir, JSON.parse(packed.stdout)[0].filename);
  const app = join(dir, 'app');
  const installed = npm(['install', '--prefix', app, '--no-audit', '--no-fund', tarball], dir);
  assert.equal(installed.status, 0, installed.stderr);
  const installedBin = join(app, 'node_modules', pkg.name, pkg.bin[NAME]);
  const version = cli(installedBin, ['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${pkg.version}\n`);
  assert.match(cli(installedBin, ['--help']).stdout, new RegExp(`^Usage: ${NAME} `));
});
