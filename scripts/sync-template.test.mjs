// A project made from the template must be able to take a later template fix with one command,
// and that command must never touch what is the project's own.
//
// In a project made from the template the first half still runs (it only needs this repository);
// the preset half needs presets/, which a project no longer has.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const node = (args, cwd) => run(process.execPath, args, cwd);
const git = (cwd, ...args) => {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) =>
  fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : null;

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A committed copy of this repository in a temp folder. */
function copyOfRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rg-sync-${name}-`));
  temps.push(dir);
  for (const rel of git(REPO, 'ls-files', '-co', '--exclude-standard')
    .split('\n')
    .filter(Boolean)) {
    if (!fs.existsSync(path.join(REPO, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'sync@example.com');
  git(dir, 'config', 'user.name', 'Sync Tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  commitAll(dir, 'template');
  return dir;
}

/** A project made from the template: its own config, backlog, a learned rule, a pending patch, its docs. */
function makeProject(template, { preset } = {}) {
  const dir = copyOfRepo('project');
  if (preset) {
    const applied = node(['scripts/apply-preset.mjs', preset], dir);
    assert.equal(applied.status, 0, applied.stderr);
  }
  const cfg = JSON.parse(read(dir, 'loop/loop.config.json'));
  Object.assign(cfg, {
    repo: 'acme/tool',
    gitAuthor: { name: 'A Person', email: 'person@example.com' },
  });
  write(dir, 'loop/loop.config.json', JSON.stringify(cfg, null, 2));
  write(
    dir,
    'loop/backlog.json',
    JSON.stringify({
      milestones: ['M0', 'M1'],
      items: [
        { id: 'LOOP-0', milestone: 'M0', title: 'setup' },
        { id: 'E1-1', milestone: 'M1', title: 'mine' },
      ],
    }),
  );
  write(
    dir,
    'loop/rules/project-rules.json',
    JSON.stringify({
      rules: [
        {
          id: 'P-1',
          target: 'shell',
          pattern: 'rm -rf dist',
          reason: 'no',
          examples: { block: 'rm -rf dist', allow: 'ls' },
        },
      ],
    }),
  );
  write(dir, 'loop/patches/LEARN-1.patch', 'diff --git a/x b/x\n');
  write(dir, 'docs/BRIEF.md', '# Brief\n\nMine.\n');
  commitAll(dir, 'the project');
  return dir;
}

/** A later template: a fix in the runner, a new file, a removed file, a changed skill and script, a changed doc skeleton. */
function evolve(template) {
  fs.appendFileSync(path.join(template, 'loop', 'lib', 'state.mjs'), '\n// fixed upstream\n');
  write(template, 'loop/lib/brand-new.mjs', 'export const added = true;\n');
  fs.rmSync(path.join(template, 'loop', 'lib', 'report.mjs'));
  fs.appendFileSync(
    path.join(template, '.claude', 'skills', 'setup-loop', 'SKILL.md'),
    '\nA new rule.\n',
  );
  fs.appendFileSync(path.join(template, 'scripts', 'ac-trace.mjs'), '\n// fixed upstream\n');
  fs.appendFileSync(
    path.join(template, '.github', 'workflows', 'ci.yml'),
    '\n# web workflow changed\n',
  );
  if (fs.existsSync(path.join(template, 'presets', 'node-cli')))
    fs.appendFileSync(
      path.join(template, 'presets', 'node-cli', 'files', '.github', 'workflows', 'ci.yml'),
      '\n# cli workflow changed\n',
    );
  fs.appendFileSync(path.join(template, 'docs', 'BRIEF.md'), '\n## A new skeleton section\n');
  // values that are the template's own must never reach a project
  write(
    template,
    'loop/loop.config.json',
    JSON.stringify(
      { ...JSON.parse(read(template, 'loop/loop.config.json')), base: 'trunk' },
      null,
      2,
    ),
  );
  write(
    template,
    'loop/backlog.json',
    JSON.stringify({
      milestones: ['M0'],
      items: [{ id: 'LOOP-0', milestone: 'M0', title: 'template setup item, reworded' }],
    }),
  );
  return commitAll(template, 'later template');
}

test("a project takes a later template: the harness changes, what is the project's own does not", () => {
  const template = copyOfRepo('template');
  const project = makeProject(template);
  const before = {
    config: read(project, 'loop/loop.config.json'),
    backlog: read(project, 'loop/backlog.json'),
    rules: read(project, 'loop/rules/project-rules.json'),
    brief: read(project, 'docs/BRIEF.md'),
    pkg: read(project, 'package.json'),
  };
  // a first sync at the same template records where the project stands and changes nothing else
  const first = node(['scripts/sync-template.mjs', '--from', template], project);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /nothing to do: the template part is up to date/);
  commitAll(project, 'lock');
  const commit = evolve(template);

  const dry = node(['scripts/sync-template.mjs', '--from', template, '--dry-run'], project);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would sync/);
  assert.equal(git(project, 'status', '--porcelain'), '', 'a dry run changes nothing');

  const r = node(['scripts/sync-template.mjs', '--from', template], project);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(read(project, 'loop/lib/state.mjs'), /fixed upstream/);
  assert.equal(read(project, 'loop/lib/brand-new.mjs'), 'export const added = true;\n');
  assert.equal(
    read(project, 'loop/lib/report.mjs'),
    null,
    'a file the template dropped is removed',
  );
  assert.match(read(project, '.claude/skills/setup-loop/SKILL.md'), /A new rule\./);
  assert.match(read(project, 'scripts/ac-trace.mjs'), /fixed upstream/);
  assert.match(read(project, '.github/workflows/ci.yml'), /web workflow changed/);
  assert.match(r.stdout, / {2}update {2}loop\/lib\/state\.mjs/);
  assert.match(r.stdout, / {2}add {5}loop\/lib\/brand-new\.mjs/);
  assert.match(r.stdout, / {2}remove {2}loop\/lib\/report\.mjs/);

  // the project's own files are exactly as they were
  assert.equal(read(project, 'loop/loop.config.json'), before.config);
  assert.equal(read(project, 'loop/backlog.json'), before.backlog);
  assert.equal(read(project, 'loop/rules/project-rules.json'), before.rules);
  assert.equal(read(project, 'loop/patches/LEARN-1.patch'), 'diff --git a/x b/x\n');
  assert.equal(read(project, 'docs/BRIEF.md'), before.brief);
  assert.equal(read(project, 'package.json'), before.pkg);
  // ... and the command says which of them the template changed meanwhile
  assert.match(r.stdout, /The template also changed files that are yours[\s\S]*docs\/BRIEF\.md/);
  assert.doesNotMatch(
    r.stdout.split('files that are yours')[1].split('Done.')[0],
    /loop\/|scripts\//,
  );
  const lock = JSON.parse(read(project, 'loop/template.lock.json'));
  assert.equal(lock.commit, commit);
  // a folder on this machine is not written into a committed file: only its name
  assert.equal(lock.source, path.basename(template));

  // the synced project still passes the loop's own config check, and a second sync has nothing to do
  commitAll(project, 'sync');
  const again = node(['scripts/sync-template.mjs', '--from', template], project);
  assert.match(again.stdout, /nothing to do/);
});

test('uncommitted changes are refused, and a folder that is not a template or not a project is named', () => {
  const template = copyOfRepo('template');
  const project = makeProject(template);
  evolve(template);
  write(project, 'README.md', 'edited\n');
  const refused = node(['scripts/sync-template.mjs', '--from', template], project);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /uncommitted changes/);
  assert.doesNotMatch(read(project, 'loop/lib/state.mjs'), /fixed upstream/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-sync-empty-'));
  temps.push(empty);
  git(project, 'checkout', '--', 'README.md');
  assert.match(
    node(['scripts/sync-template.mjs', '--from', empty], project).stderr,
    /has no loop\/harness\.json: it is not a template/,
  );
  git(empty, 'init', '-q');
  assert.match(
    node([path.join(REPO, 'scripts', 'sync-template.mjs'), '--from', template], empty).stderr,
    /it is not a project made from the template/,
  );
  assert.match(
    node(['scripts/sync-template.mjs', '--bogus'], project).stderr,
    /unknown argument "--bogus"/,
  );
});

test("a project without the command takes it by running the template's copy from its own folder", () => {
  const template = copyOfRepo('template');
  const project = makeProject(template);
  fs.rmSync(path.join(project, 'scripts', 'sync-template.mjs'));
  fs.rmSync(path.join(project, 'loop', 'harness.json'));
  commitAll(project, 'an older project');
  evolve(template);
  // no --from: the script lives in another repository, so that repository is the template
  const r = node([path.join(template, 'scripts', 'sync-template.mjs')], project);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(
    fs.existsSync(path.join(project, 'scripts', 'sync-template.mjs')),
    'the project now has the command itself',
  );
  assert.ok(fs.existsSync(path.join(project, 'loop', 'harness.json')));
  assert.match(read(project, 'loop/lib/state.mjs'), /fixed upstream/);
});

test(
  'a project of another stack keeps its own scripts and gets its own CI workflow',
  { skip: !fs.existsSync(path.join(REPO, 'presets', 'node-cli')) },
  () => {
    const template = copyOfRepo('template');
    const project = makeProject(template, { preset: 'node-cli' });
    const check = read(project, 'scripts/check.mjs');
    evolve(template);
    const r = node(['scripts/sync-template.mjs', '--from', template], project);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(read(project, '.github/workflows/ci.yml'), /cli workflow changed/);
    assert.doesNotMatch(read(project, '.github/workflows/ci.yml'), /web workflow changed/);
    assert.equal(
      read(project, 'scripts/check.mjs'),
      check,
      "the stack's own gate script is the project's",
    );
    assert.equal(JSON.parse(read(project, 'loop/loop.config.json')).profile, 'node-cli');
    assert.ok(!fs.existsSync(path.join(project, 'presets')), 'presets are not brought back');
    assert.ok(!fs.existsSync(path.join(project, 'src', 'app')), 'nor the web app');
    // the project's gates still pass after the sync
    for (const args of [
      ['scripts/check.mjs'],
      ['scripts/check-skills.mjs'],
      ['loop/scripts/check-rules.mjs'],
    ]) {
      const g = node(args, project);
      assert.equal(g.status, 0, `${args[0]}:\n${g.stdout}\n${g.stderr}`);
    }
  },
);
