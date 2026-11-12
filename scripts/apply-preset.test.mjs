// Every preset, applied to a real copy of this repository, must give a project whose own gates
// pass and whose loop starts. This is the end-to-end proof that a second stack fits the contract.
//
// In a repository where a preset was already applied there is no presets/ folder: nothing to test.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listPresets, plan } from './apply-preset.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'apply-preset.mjs');
const presets = listPresets(REPO);
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const run = (cmd, args, cwd, env) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env || process.env });
const node = (args, cwd, env) => run(process.execPath, args, cwd, env);
const git = (cwd, ...args) => {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A committed copy of this repository's files (tracked and new, never ignored ones) in a temp folder. */
function copyOfRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-preset-'));
  temps.push(dir);
  for (const rel of git(REPO, 'ls-files', '-co', '--exclude-standard')
    .split('\n')
    .filter(Boolean)) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) continue; // deleted in the working tree
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dir, rel));
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'preset@example.com');
  git(dir, 'config', 'user.name', 'Preset Tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'template');
  return dir;
}

test(
  'with no name the script lists the presets; an unknown name is refused',
  { skip: !presets.length },
  () => {
    const list = node([SCRIPT]);
    assert.equal(list.status, 0);
    for (const p of presets) assert.match(list.stdout, new RegExp(`^${p.name}$`, 'm'));
    const bad = node([SCRIPT, 'no-such-stack']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /"no-such-stack" is not a preset/);
  },
);

test('a preset may not remove the harness, the docs or anything outside the repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-preset-bad-'));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, 'presets', 'evil', 'files'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'loop', 'profiles', 'evil'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'loop', 'profiles', 'evil', 'profile.json'), '{}');
  fs.writeFileSync(path.join(dir, 'presets', 'evil', 'files', 'x.txt'), 'x');
  fs.writeFileSync(
    path.join(dir, 'presets', 'evil', 'preset.json'),
    JSON.stringify({
      remove: ['loop/guard', '../outside', '.git', 'docs', '.', 'src/../loop', 'src'],
    }),
  );
  const p = plan(dir, 'evil');
  assert.equal(p.problems.length, 6, p.problems.join('|'));
  assert.deepEqual(p.remove, []);
});

for (const preset of presets) {
  test(`preset ${preset.name}: a dry run changes nothing, and a dirty tree is refused`, () => {
    const dir = copyOfRepo();
    const dry = node(['scripts/apply-preset.mjs', preset.name, '--dry-run'], dir);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would apply preset/);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    fs.writeFileSync(path.join(dir, 'README.md'), 'edited\n');
    const refused = node(['scripts/apply-preset.mjs', preset.name], dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /uncommitted changes/);
    assert.ok(fs.existsSync(path.join(dir, 'presets')), 'nothing was touched');
  });

  test(`preset ${preset.name}: applied to the template, the project's own gates pass and the loop starts`, () => {
    const dir = copyOfRepo();
    const applied = node(['scripts/apply-preset.mjs', preset.name], dir);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);

    // what the preset says it removes is gone, what it brings is there, the rest stayed
    // (a folder the preset both removes and brings, like src/, holds only the preset's files)
    const brought = (rel) => fs.existsSync(path.join(REPO, 'presets', preset.name, 'files', rel));
    for (const rel of preset.remove.filter((r) => !brought(r)))
      assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be removed`);
    for (const rel of git(REPO, 'ls-files', 'src', 'tests').split('\n').filter(Boolean)) {
      if (!brought(rel))
        assert.ok(
          !fs.existsSync(path.join(dir, rel)),
          `${rel} belongs to the web preset and should be gone`,
        );
    }
    assert.ok(!fs.existsSync(path.join(dir, 'presets')));
    for (const rel of [
      'loop/run.mjs',
      'loop/guard/core.mjs',
      `loop/profiles/${preset.name}/profile.json`,
      'docs/DECISIONS.md',
      'scripts/ac-trace.mjs',
      '.claude/skills/setup-loop/SKILL.md',
    ]) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} should still be there`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'loop', 'loop.config.json'), 'utf8'));
    assert.equal(cfg.profile, preset.name);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `apply ${preset.name}`);

    // the profile's local gate is a script of the project, and it passes on the skeleton
    const profile = JSON.parse(
      fs.readFileSync(path.join(dir, 'loop', 'profiles', preset.name, 'profile.json'), 'utf8'),
    );
    for (const command of profile.localGate.commands) {
      const script = command.match(/^npm run (\S+)$/)?.[1];
      assert.ok(
        script && pkg.scripts[script],
        `local gate "${command}" must be an npm script of the preset`,
      );
    }
    for (const script of ['check', 'test:e2e']) {
      const [cmd, ...args] = pkg.scripts[script].split(' ');
      assert.equal(cmd, 'node');
      const r = node(args, dir);
      assert.equal(r.status, 0, `${script} failed:\n${r.stdout}\n${r.stderr}`);
    }

    // the AC gate reads the reports those two runs wrote: no AC is built yet, none is unproven
    const trace = node(['scripts/ac-trace.mjs', '--results', 'artifacts/junit'], dir);
    assert.equal(trace.status, 0, trace.stdout + trace.stderr);
    // every AC of the skeleton has a passing test, so the release check passes without contracts
    const all = node(
      ['scripts/ac-trace.mjs', '--no-contracts', '--results', 'artifacts/junit'],
      dir,
    );
    assert.equal(all.status, 0, all.stdout + all.stderr);
    assert.match(all.stdout, /ac-trace: OK — \d+ AC\(s\) traced/);

    // the shared checks still hold in the new project
    for (const args of [
      ['scripts/check-skills.mjs'],
      ['scripts/sanitize-scan.mjs'],
      ['loop/scripts/check-rules.mjs'],
      ['.claude/skills/shape-project/scripts/check-backlog.mjs'],
    ]) {
      const r = node(args, dir);
      assert.equal(r.status, 0, `${args[0]}:\n${r.stdout}\n${r.stderr}`);
    }

    // the loop's preflight accepts the project: profile, packs, adapters, prompt fragments, backlog
    cfg.repo = 'acme/tool';
    cfg.gitAuthor = { name: 'Loop Tester', email: 'loop@example.com' };
    fs.writeFileSync(path.join(dir, 'loop', 'loop.config.json'), JSON.stringify(cfg, null, 2));
    const fake = path.join(dir, '.loop-fake');
    fs.mkdirSync(fake);
    fs.writeFileSync(
      path.join(fake, 'gh-state.json'),
      JSON.stringify({ repo: cfg.repo, base: 'develop', prs: {}, calls: [] }),
    );
    const helpers = path.join(dir, 'loop', 'test', 'helpers');
    const env = {
      ...process.env,
      LOOP_CLAUDE_BIN: path.join(helpers, 'fake-claude.mjs'),
      LOOP_GH_BIN: path.join(helpers, 'fake-gh.mjs'),
      LOOP_FAKE_DIR: fake,
    };
    delete env.ANTHROPIC_API_KEY;
    const dryRun = node(['loop/run.mjs', '--dry-run'], dir, env);
    assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
    assert.match(dryRun.stdout, /\[dry-run\] next item: LOOP-0/);
  });
}
