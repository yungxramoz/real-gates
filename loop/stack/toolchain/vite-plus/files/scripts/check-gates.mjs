#!/usr/bin/env node
// Does the config the toolchain really loads still carry the gate files, unchanged?
//
// Vite+ keeps the settings of every tool in one file, vite.config.ts: the build, the formatter,
// the linter, the tests. A session has to be free to edit that file (a plugin, an alias), so the
// loop cannot freeze it the way it freezes a lint config of its own. The rules therefore live in
// files of their own that the config imports, and those files are what a pull request may not
// change:
//
//   gates/lint.ts   the lint rules and the type check          frozen
//   gates/fmt.ts    the format rules                           frozen
//   gates/test.ts   which tests run, and the coverage floor    only its thresholds may rise
//
// Freezing them is half of it. The other half is this check: the config must still hand each of
// them to its tool as it is. It fails when vite.config.ts
//   - leaves one out, or passes a changed copy (`lint: { ...lint, rules: {} }`),
//   - changes the object it imported (`lint.rules.eqeqeq = 'off'`),
// and when a file is tracked by git although an ignore file names it: the formatter and the
// linter skip what git ignores, so such a file would be checked by nobody.
//
// A config file that a tool would read instead (.oxlintrc.json, vitest.config.ts, …) cannot be
// added either: the runner refuses a pull request that does (`gates.files` of the toolchain block).
//
//   node scripts/check-gates.mjs [--root <dir>]
//
// Exit 0 when the gates are wired, 1 with every problem named. It runs first in `check`, so the
// local gate and CI both start with it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/** The key of the config each gate file is handed to its tool under. */
export const GATES = { lint: 'gates/lint.ts', fmt: 'gates/fmt.ts', test: 'gates/test.ts' };

/**
 * What is wrong, as plain sentences. `config`: what the toolchain loaded. `gates`: what each gate
 * file exports, read before the config was loaded. `hidden`: tracked files an ignore file names.
 */
export function gateProblems({ config, gates, hidden = [] }) {
  const p = [];
  for (const [key, file] of Object.entries(GATES)) {
    if (gates[key] === undefined)
      p.push(
        `${file} is missing or has no default export: the ${key} settings have to come from it`,
      );
    else if (config?.[key] === undefined)
      p.push(`vite.config.ts has no \`${key}\`: import ${file} and pass it as it is (\`${key},\`)`);
    else if (!isDeepStrictEqual(config[key], gates[key]))
      p.push(
        `\`${key}\` in vite.config.ts is not what ${file} exports: pass the import as it is, without spreading, overriding or changing it`,
      );
  }
  for (const f of hidden)
    p.push(
      `\`${f}\` is tracked by git although an ignore file names it: the formatter and the linter skip it. Take it out of the ignore file, or out of git`,
    );
  return p;
}

/** What a gate file exports, as a copy: a config that changes the object it imported cannot change this. */
async function readGate(root, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return undefined;
  const exported = (await import(pathToFileURL(full).href)).default;
  return exported === undefined ? undefined : structuredClone(exported);
}

/** The config as the toolchain loads it: Vite+ re-exports Vite's own loader. */
async function loadConfig(root) {
  const { loadConfigFromFile } = await import('vite-plus').catch(() => import('vite'));
  const file = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']
    .map((f) => path.join(root, f))
    .find((f) => fs.existsSync(f));
  if (!file) throw new Error('no vite.config.ts in the project root');
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    file,
    root,
    'silent',
  );
  return loaded?.config || {};
}

/** Tracked files that an ignore file names. */
function hiddenFiles(root) {
  const r = spawnSync('git', ['ls-files', '-ci', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0)
    throw new Error(
      `git ls-files failed: ${(r.stderr || '').trim() || 'is this a git repository?'}`,
    );
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function check(root) {
  // the gate files first: their copies are taken before the config can touch what it imports
  const gates = {};
  for (const [key, file] of Object.entries(GATES)) gates[key] = await readGate(root, file);
  return gateProblems({ config: await loadConfig(root), gates, hidden: hiddenFiles(root) });
}

async function main(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else {
      console.error(
        `check-gates: unknown argument "${argv[i]}"\nusage: node scripts/check-gates.mjs [--root <dir>]`,
      );
      return 1;
    }
  }
  let problems;
  try {
    problems = await check(root);
  } catch (e) {
    // a gate that cannot read what it has to check has not passed
    console.error(`check-gates: could not read the config: ${e.message}`);
    return 1;
  }
  if (problems.length) {
    console.error(`check-gates: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
    return 1;
  }
  console.log(
    'check-gates: OK — vite.config.ts hands gates/lint.ts, gates/fmt.ts and gates/test.ts to their tools unchanged',
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(await main(process.argv.slice(2)));
