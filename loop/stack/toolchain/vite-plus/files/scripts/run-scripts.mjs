#!/usr/bin/env node
// Runs package scripts by name, where they exist.
//
// `build`, `start` and `test:e2e` are the names the loop, CI and a person use, whatever the
// project is made of. What they have to do depends on its parts: a web app is built, a server is
// started. So each part brings a script of its own (`build:web`, `start:server`), and the fixed
// names call this:
//
//   node scripts/run-scripts.mjs --all build:web build:server
//       every one of these that package.json has, in this order. A failure ends it there.
//       None of them: nothing to do, exit 0.
//   node scripts/run-scripts.mjs --first start:server start:web
//       the first of these that package.json has, and only that one. None: exit 1, because a
//       caller that starts the project and waits for it would wait for nothing.
//
// A pull request cannot change the `scripts` in package.json, so the names are settled when the
// project is set up. Node built-ins only.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node scripts/run-scripts.mjs --all|--first <script> [<script> …]';

/** The scripts to run: { run: [names] } or { problem }. */
export function pick(mode, names, scripts) {
  if (!['--all', '--first'].includes(mode) || !names.length) return { problem: USAGE };
  const have = names.filter((n) => typeof scripts?.[n] === 'string');
  if (mode === '--all') return { run: have };
  if (!have.length) return { problem: `package.json has none of these scripts: ${names.join(', ')}` };
  return { run: [have[0]] };
}

/** The package manager that started this script, so the scripts it runs see the same one. */
const packageManager = () => (process.env.npm_config_user_agent || '').split('/')[0] || 'pnpm';

function runScript(name, root) {
  return new Promise((resolve) => {
    // through the shell: the package manager is a .cmd file on Windows
    const child = spawn(`${packageManager()} run ${name}`, { cwd: root, stdio: 'inherit', shell: true });
    // a server started this way ends when its caller is told to end
    const stop = (signal) => child.kill(signal);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('error', (e) => {
      console.error(`run-scripts: could not start "${name}": ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main(argv, root) {
  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
  } catch (e) {
    console.error(`run-scripts: could not read package.json: ${e.message}`);
    return 1;
  }
  const picked = pick(argv[0], argv.slice(1), scripts);
  if (picked.problem) {
    console.error(`run-scripts: ${picked.problem}`);
    return 1;
  }
  if (!picked.run.length) console.log(`run-scripts: package.json has none of ${argv.slice(1).join(', ')}: nothing to do`);
  for (const name of picked.run) {
    const code = await runScript(name, root);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), process.cwd()));
