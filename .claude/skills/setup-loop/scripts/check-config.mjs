#!/usr/bin/env node
// Validator for /setup-loop: is this clone ready for `node loop/run.mjs`?
//
// It loads loop/loop.config.json through the runner's own module (loop/lib/config.mjs), so the
// answer matches what the runner's preflight will say, then checks what the config cannot know:
// .env.example, the git remote and branches, gh login, the Claude Code version floor, Node and the
// Playwright browsers. It never prints secret values and never changes anything.
//
// Usage: node check-config.mjs [--root <repo dir>] [--config-only]
// Exit 0 when ready, 1 with every problem named.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HELP = `Usage: node check-config.mjs [--root <repo dir>] [--config-only]

Checks that this clone is ready for the unattended loop:
  - loop/loop.config.json loads and loop/lib/config.mjs reports no config problems
  - .env.example names every secret the config points at, with no value filled in
  - git remote "origin" exists and has the base and production branches
  - gh is logged in and can see the configured repo
  - Claude Code is at least the version floor in loop/lib/config.mjs
  - Node is new enough for the runner; Playwright and its Chromium are installed, when the
    project's package.json declares @playwright/test

  --root <dir>    repo root (default: the nearest folder above the current one with loop/loop.config.json)
  --config-only   skip the git, gh, claude and Playwright checks

Exit code 0 when ready, 1 with a list of named problems.`;

// The runner uses node:test and other built-ins that need this Node major.
const MIN_NODE_MAJOR = 22;
// External commands answer locally; anything slower than this is treated as not answering.
const COMMAND_TIMEOUT_MS = 30_000;

const problems = [];
const oks = [];
const problem = (check, msg) => problems.push(`${check}: ${msg}`);
const ok = (check, msg) => oks.push(`${check}: ${msg}`);

function parseArgs(argv) {
  const args = { root: null, configOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--config-only') args.configOnly = true;
    else if (argv[i] === '--root') args.root = argv[++i];
    else throw new Error(`unknown argument "${argv[i]}" (see --help)`);
  }
  return args;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'loop', 'loop.config.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Runs a fixed command line (no user input in it) and returns { found, code, out }. */
function run(command, cwd) {
  // shell: true so Windows finds .cmd shims (claude installed through npm); the command is a constant.
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const notFound = r.status === 127 || /not recognized as an internal or external command|command not found|No such file/i.test(out);
  return { found: !r.error && !notFound, code: r.status, out };
}

/** "2.1.319 (Claude Code)" → 2001319; 0 when there is no version in the text. */
function versionNumber(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function checkConfig(root) {
  const modFile = path.join(root, 'loop', 'lib', 'config.mjs');
  let mod;
  try {
    mod = await import(pathToFileURL(modFile).href);
  } catch (e) {
    problem('config', `loop/lib/config.mjs could not be loaded (${e.message}); the runner is incomplete in this clone`);
    return { cfg: null, mod: null };
  }
  let cfg;
  try {
    cfg = mod.loadConfig(root);
  } catch (e) {
    problem('config', e.message);
    return { cfg: null, mod };
  }
  let backlog;
  const backlogFile = path.join(root, 'loop', 'backlog.json');
  if (fs.existsSync(backlogFile)) {
    try {
      backlog = readJson(backlogFile);
    } catch (e) {
      problem('backlog', `loop/backlog.json is not valid JSON (${e.message}); /shape-project writes it`);
    }
  }
  const found = mod.configProblems(cfg, backlog ? { backlog } : {});
  for (const p of found) problem('config', p);
  if (!found.length) ok('config', `loop/loop.config.json is complete (repo ${cfg.repo}, base ${cfg.base}, production ${cfg.production})`);
  return { cfg, mod };
}

function checkEnvExample(root, cfg) {
  const names = [
    ...(cfg.postMerge || []).map((s) => s.dbUrlEnv).filter(Boolean),
    cfg.deploy?.bypassSecretEnv,
  ].filter(Boolean);
  if (!names.length) return;
  const file = path.join(root, '.env.example');
  if (!fs.existsSync(file)) {
    problem('.env.example', `missing; add one line per secret the loop reads: ${names.map((n) => `${n}=`).join(', ')}`);
    return;
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const name of names) {
    const line = lines.find((l) => l.replace(/^\s*export\s+/, '').startsWith(`${name}=`));
    if (!line) {
      problem('.env.example', `add the line "${name}=" (the real value goes in your local environment, never in this file)`);
      continue;
    }
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (value && !/^<.*>$/.test(value)) {
      problem('.env.example', `${name} has a value filled in; this file is committed, so leave it empty or a <placeholder>`);
    }
  }
  if (!problems.some((p) => p.startsWith('.env.example'))) ok('.env.example', `names ${names.join(', ')}`);
}

function checkGit(root, cfg) {
  const remote = run('git remote get-url origin', root);
  if (!remote.found) return problem('git', 'git is not on PATH');
  if (remote.code !== 0) return problem('git', 'there is no remote "origin"; push this clone to its GitHub repo first');
  for (const [key, branch] of [['base', cfg.base], ['production', cfg.production]]) {
    if (!branch || !/^[\w./-]+$/.test(branch)) continue; // configProblems already names it
    const r = run(`git ls-remote --heads origin ${branch}`, root);
    if (r.code !== 0) problem('git', `could not list branches on origin (${r.out.split('\n')[0]})`);
    else if (!r.out) {
      problem('git', key === 'base'
        ? `origin has no "${branch}" branch; create it from "${cfg.production}" and push it (setup-loop step 3)`
        : `origin has no production branch "${branch}"`);
    } else ok('git', `origin has ${key} branch "${branch}"`);
  }
}

function checkGh(root, cfg) {
  const auth = run('gh auth status', root);
  if (!auth.found) return problem('gh', 'gh (GitHub CLI) is not on PATH; install it from https://cli.github.com');
  if (auth.code !== 0) return problem('gh', 'gh is not logged in; run "gh auth login" yourself (it is interactive)');
  ok('gh', 'logged in');
  if (/^[\w.-]+\/[\w.-]+$/.test(cfg.repo || '')) {
    const view = run(`gh repo view ${cfg.repo} --json nameWithOwner`, root);
    if (view.code !== 0) problem('gh', `gh cannot see the repo "${cfg.repo}"; check the name and that this account has write access`);
    else ok('gh', `can see ${cfg.repo}`);
  }
}

function checkClaude(root, mod) {
  const floor = mod?.MIN_CLAUDE_VERSION;
  const r = run('claude --version', root);
  if (!r.found || r.code !== 0) return problem('claude', 'Claude Code is not on PATH; install it and log in with "claude" then "/login"');
  const toNumber = typeof mod?.versionNumber === 'function' ? mod.versionNumber : versionNumber;
  const have = r.out.match(/\d+\.\d+\.\d+/)?.[0] || r.out;
  if (!floor) return problem('claude', 'loop/lib/config.mjs exports no MIN_CLAUDE_VERSION, so the floor cannot be checked');
  if (toNumber(r.out) < toNumber(floor)) {
    problem('claude', `Claude Code ${have} is older than the floor ${floor} in loop/lib/config.mjs; run "claude update"`);
  } else ok('claude', `Claude Code ${have} (floor ${floor})`);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) problem('node', `Node ${process.versions.node} is too old for the runner; install Node ${MIN_NODE_MAJOR} or newer`);
  else ok('node', `Node ${process.versions.node}`);
}

function playwrightBrowserDir(root) {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env === '0') return path.join(root, 'node_modules', 'playwright-core', '.local-browsers');
  if (env) return path.resolve(env);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/** The project's package manager, from its lockfile: what a "run this" hint has to name. */
function packageManager(root) {
  return fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? { install: 'pnpm install', exec: 'pnpm exec' } : { install: 'npm install', exec: 'npx' };
}

/**
 * Browser prerequisites, only for a project that declares Playwright. A stack without it (a
 * command-line tool, a library) has nothing to install here, and asking for it would keep the
 * validator from ever reaching "ready".
 */
function checkPlaywright(root) {
  let pkg = {};
  try {
    pkg = readJson(path.join(root, 'package.json'));
  } catch {
    // no readable package.json: nothing declares Playwright
  }
  if (!{ ...pkg.dependencies, ...pkg.devDependencies }['@playwright/test']) return;
  const pm = packageManager(root);
  if (!fs.existsSync(path.join(root, 'node_modules', '@playwright', 'test'))) {
    problem('playwright', `@playwright/test is not installed; run "${pm.install}"`);
  }
  const dir = playwrightBrowserDir(root);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // no browser folder yet: reported below
  }
  if (!entries.some((e) => /^chromium/.test(e))) {
    problem('playwright', `no Chromium for Playwright in ${dir}; run "${pm.exec} playwright install chromium"`);
  } else ok('playwright', `Chromium found in ${dir}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`check-config: ${e.message}`);
    return 1;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : findRoot(process.cwd());
  if (!root || !fs.existsSync(path.join(root, 'loop', 'loop.config.json'))) {
    console.error('check-config: no loop/loop.config.json found here or in any parent folder; run this from the repo (or pass --root)');
    return 1;
  }

  const { cfg, mod } = await checkConfig(root);
  if (cfg) checkEnvExample(root, cfg);
  if (!args.configOnly) {
    checkNode();
    if (cfg) checkGit(root, cfg);
    if (cfg) checkGh(root, cfg);
    checkClaude(root, mod);
    checkPlaywright(root);
  }

  for (const line of oks) console.log(`ok       ${line}`);
  for (const line of problems) console.log(`PROBLEM  ${line}`);
  console.log(problems.length ? `\ncheck-config: ${problems.length} problem(s) in ${root}` : `\ncheck-config: ready (${root})`);
  return problems.length ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`check-config: unexpected error: ${e.stack || e.message}`);
    process.exitCode = 1;
  },
);
