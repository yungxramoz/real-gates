#!/usr/bin/env node
// The project's own gates, as one command. CI runs it, the loop's local gate runs it, and a build
// session runs it before it pushes.
//
//   node scripts/check.mjs          syntax of every source file, then the unit tests with coverage.
//                                   The run fails below the numbers in coverage.thresholds.json.
//   node scripts/check.mjs --e2e    the end-to-end tests: the real binary, and the packed package
//
// Both write a JUnit report to artifacts/junit/, which `scripts/ac-trace.mjs --results` reads:
// an acceptance criterion counts only when a test that names it ran and passed.
//
// Node built-ins only. This file is a gate file: a loop session cannot change it.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');

function* sources(dir) {
  let entries = [];
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(rel);
    else if (/\.(mjs|js)$/.test(entry.name)) yield rel;
  }
}

// Started from inside another `node --test` run, a test process reports to its parent instead of
// writing its own reports and exit code. This script is a gate: it always runs on its own.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

function node(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env }).status ?? 1;
}

function tests(dir, report, extra = []) {
  const files = [...sources(dir)].filter((f) => /\.test\.mjs$/.test(f));
  if (!files.length) {
    // A suite with no tests proves nothing, so it is not a pass.
    console.error(`check: no test files in ${dir}/`);
    return 1;
  }
  mkdirSync(join(ROOT, 'artifacts', 'junit'), { recursive: true });
  return node(['--test', ...extra, '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${join('artifacts', 'junit', report)}`, ...files]);
}

if (e2e) process.exit(tests(join('tests', 'e2e'), 'e2e.xml'));

for (const file of ['bin', 'src', 'tests', 'scripts'].flatMap((d) => [...sources(d)])) {
  if (node(['--check', file]) !== 0) {
    console.error(`check: ${file} does not parse`);
    process.exit(1);
  }
}

const min = JSON.parse(readFileSync(join(ROOT, 'coverage.thresholds.json'), 'utf8'));
process.exit(
  tests(join('tests', 'unit'), 'unit.xml', [
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    `--test-coverage-lines=${min.lines}`,
    `--test-coverage-branches=${min.branches}`,
    `--test-coverage-functions=${min.functions}`,
  ]),
);
