// A throwaway repository for runner tests: a real git work tree with a bare `origin`, the loop
// copied in, and the fake claude / gh / supabase binaries wired through LOOP_*_BIN.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deepMerge } from '../../lib/config.mjs';
import { WEB, presetConfig } from './preset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOP = path.resolve(HERE, '..', '..');

export const TEST_CONFIG = {
  repo: 'acme/app',
  gitAuthor: { name: 'Loop Tester', email: 'loop@example.com' },
  deploy: { devUrl: 'https://dev.example.com' },
  guard: { allowedDbProject: 'testref0000000000000' },
  postMerge: [],
  // The older scenarios script one session at a time and wait for base CI; the parallel review and
  // the background base CI have scenarios of their own that switch these on.
  review: { parallelWithCi: false },
  localGate: { commands: [] }, // the preset's own gate needs the app's toolchain; scenarios that test the gate set one
  baseCiWait: 'always',
  retro: { enabled: false }, // the retro has scenarios of its own that switch it on
  pollMs: 5,
  timeouts: { sessionMin: 1, reviewMin: 1, acceptMin: 1, packetMin: 1, retroMin: 1, ciMin: 0.003, smokeMin: 1 },
  usageLimit: { sleepMin: 0.0002, maxWaitHours: 1, minSleepMs: 1 },
};

export const DEFAULT_BACKLOG = { milestones: ['M1'], items: [{ id: 'A1', milestone: 'M1', title: 'First item', refs: ['docs/REQUIREMENTS.md'], scope: 'Add a file.', ui: false, dependsOn: [] }] };

function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function copyLoop(dest) {
  fs.cpSync(LOOP, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}test${path.sep}`) && !src.endsWith(`${path.sep}test`) });
}

export function makeSandbox({ backlog = DEFAULT_BACKLOG, config = {}, files = {}, profile = WEB } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-sb-'));
  const origin = path.join(tmp, 'origin.git');
  const root = path.join(tmp, 'work');
  const fake = path.join(tmp, 'fake');
  fs.mkdirSync(fake);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'loop@example.com');
  git(root, 'config', 'user.name', 'Loop Tester');
  git(root, 'config', 'core.autocrlf', 'false');
  copyLoop(path.join(root, 'loop'));
  const cfg = deepMerge(deepMerge(presetConfig(profile), TEST_CONFIG), config);
  fs.writeFileSync(path.join(root, 'loop', 'loop.config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(root, 'loop', 'backlog.json'), JSON.stringify(backlog, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test project\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '/.loop/\n');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'REQUIREMENTS.md'), '# Requirements\n\n- AC-1.1 A file exists.\n');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'checkout', '-q', '-b', cfg.base || 'develop');
  git(root, 'push', '-q', '-u', 'origin', cfg.base || 'develop');
  git(root, 'fetch', '-q', 'origin');

  const ghFile = path.join(fake, 'gh-state.json');
  fs.writeFileSync(ghFile, JSON.stringify({ repo: cfg.repo, origin, base: cfg.base || 'develop', ciCheck: 'ci', nextPr: 1, prs: {}, ci: {}, runs: {}, ciQueue: [], baseCiQueue: [], calls: [] }, null, 2));
  fs.writeFileSync(path.join(fake, 'claude-queue.json'), '[]');
  fs.writeFileSync(path.join(fake, 'supabase-state.json'), JSON.stringify({ remote: [], failPush: false, calls: [] }));

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, {
    LOOP_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'),
    LOOP_GH_BIN: path.join(HERE, 'fake-gh.mjs'),
    LOOP_SUPABASE_BIN: path.join(HERE, 'fake-supabase.mjs'),
    LOOP_FAKE_DIR: fake,
    LOOP_USER_SKILLS_DIR: path.join(tmp, 'no-user-skills'),
    GIT_CONFIG_NOSYSTEM: '1',
  });

  const readJson = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb);
  return {
    root,
    origin,
    fake,
    env,
    cfg,
    git: (...a) => git(root, ...a),
    originGit: (...a) => git(origin, ...a),
    ghState: () => readJson(ghFile),
    setGhState: (fn) => {
      const s = readJson(ghFile);
      fn(s);
      fs.writeFileSync(ghFile, JSON.stringify(s, null, 2));
    },
    supabaseState: () => readJson(path.join(fake, 'supabase-state.json')),
    setSupabaseState: (fn) => {
      const f = path.join(fake, 'supabase-state.json');
      const s = readJson(f);
      fn(s);
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    },
    queue: (...steps) => {
      const f = path.join(fake, 'claude-queue.json');
      fs.writeFileSync(f, JSON.stringify([...readJson(f, []), ...steps.flat()], null, 2));
    },
    queueLeft: () => readJson(path.join(fake, 'claude-queue.json'), []),
    calls: () => (fs.existsSync(path.join(fake, 'claude-calls.jsonl')) ? fs.readFileSync(path.join(fake, 'claude-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    probes: () => (fs.existsSync(path.join(fake, 'guard-probes.jsonl')) ? fs.readFileSync(path.join(fake, 'guard-probes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    state: () => readJson(path.join(root, '.loop', 'state.json'), null),
    file: (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null),
    run: (args = [], { timeoutMs = 240_000 } = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(root, 'loop', 'run.mjs'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('close', (code) => {
          clearTimeout(t);
          resolve({ code, stdout, stderr });
        });
      }),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/** The steps a happy item takes: build (commit + PR + result) then an approving review. */
export function happyItem(id, { branch = `feat/${id.toLowerCase()}`, files, ui = false } = {}) {
  return [
    { commit: { branch, files: files || { [`src/${id}.txt`]: `${id}\n` }, message: `feat: ${id}` }, createPr: { title: `feat: ${id}` }, result: { item: id, outcome: 'ready', pr: '$PR', branch, summary: `built ${id}` } },
    { structured: { verdict: 'approve', blocking: [], non_blocking: [], acceptance: [], scores: ui ? { design_quality: 8, originality: 8, craft: 8, functionality: 8 } : {}, design: 'n/a', summary: 'fine' } },
  ];
}

/** The permission smoke test at run start: the session tries a forbidden command. */
export const smokeStep = () => ({ guard: 'git add -A --dry-run', text: 'DONE' });
