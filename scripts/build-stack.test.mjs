// A stack that is no profile is built from its blocks: scripts/build-stack.mjs turns a real copy of
// this repository into that project, and these tests hold the result to what the loop needs. The
// stack they build is a full-stack app that runs locally: the first one that is not a profile.
//
// What a test here cannot do is install the dependencies: that needs the network. The built
// project's own gates (`pnpm check`, `pnpm build`, `pnpm test:e2e`) were run by hand on this
// stack, on a web app alone and on a server alone, when the blocks' files were written.
//
// In a repository that already is the project of one stack there is no presets/ folder, and
// nothing to build: the tests that need a fresh copy of the template are skipped there.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, plan } from './build-stack.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fresh = fs.existsSync(path.join(REPO, 'presets'));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const LOCAL_APP = [
  'forge/github',
  'toolchain/vite-plus',
  'framework/react-vite',
  'framework/fastify',
  'product/web-ui',
  'product/http-api',
  'database/sqlite',
  'hosting/none',
];

const run = (cmd, args, cwd, env) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env || process.env });
const node = (args, cwd, env) => run(process.execPath, args, cwd, env);
const git = (cwd, ...args) => {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

/** A committed copy of this repository's files (tracked and new, never ignored ones) in a temp folder. */
function copyOfRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-build-'));
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
  git(dir, 'config', 'user.email', 'build@example.com');
  git(dir, 'config', 'user.name', 'Build Tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'template');
  return dir;
}

/** A block added to a copy: { config, files: { '<path>': text } }. */
function addBlock(dir, id, { config = {}, files = {} } = {}) {
  const at = path.join(dir, 'loop', 'stack', ...id.split('/'));
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(
    path.join(at, 'block.json'),
    JSON.stringify({ title: id, description: id, choose: id, status: 'draft', config }),
  );
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(at, 'files', rel)), { recursive: true });
    fs.writeFileSync(path.join(at, 'files', rel), text);
  }
}

test(
  'a dry run changes nothing, a dirty tree is refused, and nothing is named without --stack',
  { skip: !fresh },
  () => {
    const dir = copyOfRepo();
    const dry = node(['scripts/build-stack.mjs', '--stack', LOCAL_APP.join(','), '--dry-run'], dir);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^Would build a project from 8 blocks:/);
    assert.match(
      dry.stdout,
      / {2}toolchain\/vite-plus: .* \[draft: tested, not yet proven by a project\]/,
    );
    assert.match(dry.stdout, / {2}hosting\/none: Not deployed\n/);
    assert.match(dry.stdout, / {2}remove {2}next\.config\.ts\n/);
    assert.match(
      dry.stdout,
      / {2}write {3}package\.json {2}\(toolchain\/vite-plus, framework\/react-vite, framework\/fastify, product\/web-ui\)/,
    );
    assert.equal(git(dir, 'status', '--porcelain'), '');

    const json = node(['scripts/build-stack.mjs', '--stack', LOCAL_APP.join(','), '--json'], dir);
    assert.equal(json.status, 0, json.stderr);
    const planned = JSON.parse(json.stdout);
    assert.deepEqual(planned.problems, []);
    assert.deepEqual(planned.empty, ['forge/github']);
    assert.ok(planned.write.every((w) => w.path && Array.isArray(w.from) && !('text' in w)));
    assert.equal(git(dir, 'status', '--porcelain'), '');

    fs.writeFileSync(path.join(dir, 'README.md'), 'edited\n');
    const refused = node(['scripts/build-stack.mjs', '--stack', LOCAL_APP.join(',')], dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /uncommitted changes\. Commit or stash first/);
    assert.ok(has(dir, 'presets') && has(dir, 'next.config.ts'), 'nothing was touched');

    const none = node(['scripts/build-stack.mjs'], dir);
    assert.equal(none.status, 1);
    assert.match(
      none.stderr,
      /no blocks named\. `node loop\/scripts\/stack\.mjs --list` prints every block\./,
    );
    const bad = node(['scripts/build-stack.mjs', '--everything'], dir);
    assert.equal(bad.status, 1);
    assert.match(
      bad.stderr,
      /unknown argument "--everything"\nusage: node scripts\/build-stack\.mjs/,
    );
  },
);

test(
  'a stack that cannot be built is refused with the reason, and nothing is changed',
  { skip: !fresh },
  async () => {
    const dir = copyOfRepo();
    const problems = async (ids) => (await plan(dir, ids)).problems.join(' | ');
    // a profile is taken whole, not built
    assert.match(
      await problems([
        'hosting/vercel',
        'forge/github',
        'toolchain/pnpm-vitest',
        'framework/next',
        'product/web-ui',
        'database/supabase',
      ]),
      /these blocks are the profile "next-supabase-vercel", which is the template as it stands: there is nothing to build/,
    );
    assert.match(
      await problems([
        'forge/github',
        'toolchain/npm-node-test',
        'product/cli-command',
        'hosting/none',
      ]),
      /these blocks are the profile "node-cli": take it whole with `node scripts\/apply-preset\.mjs node-cli`/,
    );
    // a list that is no stack
    assert.match(await problems(['forge/github']), /stack: no toolchain block/);
    assert.match(
      await problems(['forge/github', 'toolchain/vite-plus', 'product/desktop']),
      /"product\/desktop" is not a block under loop\/stack\//,
    );
    assert.match(
      await problems(['forge/github', 'toolchain/vite-plus', 'hosting/none', 'hosting/vercel']),
      /are both hosting blocks/,
    );
    // a toolchain that comes only with its profile
    assert.match(
      await problems(['forge/github', 'toolchain/pnpm-vitest', 'product/web-ui', 'hosting/none']),
      /toolchain\/pnpm-vitest brings no project files: it comes only as part of a profile\. Build on a toolchain that does \(toolchain\/vite-plus\)\./,
    );
    assert.equal(git(dir, 'status', '--porcelain'), '');

    // what two blocks bring has to fit together
    addBlock(dir, 'framework/other', {
      files: {
        'index.html': '<!doctype html>',
        'package.json': JSON.stringify({ scripts: { 'build:web': 'something else' } }),
        'CLAUDE.md.at.nowhere': 'x\n',
        'docs/NOTHING.md.at.end': 'x\n',
      },
    });
    const clash = await problems([...LOCAL_APP, 'framework/other']);
    assert.match(
      clash,
      /framework\/react-vite and framework\/other both bring index\.html: one file has one owner/,
    );
    assert.match(
      clash,
      /the blocks' package\.json parts do not fit: framework\/react-vite and framework\/other both set scripts\.build:web \("vp build" and "something else"\)/,
    );
    assert.match(
      clash,
      /framework\/other adds to CLAUDE\.md at "nowhere", but the file has no <!-- stack:nowhere --> line/,
    );
    assert.match(
      clash,
      /framework\/other adds to docs\/NOTHING\.md, which no block of this stack brings and the template does not keep/,
    );
    const refused = await build(dir, [...LOCAL_APP, 'framework/other'], {
      force: true,
      log: () => {},
    });
    assert.equal(refused.ok, false);
    assert.ok(
      has(dir, 'next.config.ts') && has(dir, 'presets'),
      'a plan with a problem changes nothing',
    );

    // blocks whose config does not fit are refused before any file is looked at
    addBlock(dir, 'product/clash', {
      config: { workTypes: { ui: { rubric: ['craft'], accept: 'local' } } },
    });
    assert.match(
      await problems([...LOCAL_APP, 'product/clash']),
      /the blocks do not fit: product\/web-ui and product\/clash both set workTypes\.ui\.accept \("site-or-local" and "local"\)/,
    );

    // a path that leaves the project
    addBlock(dir, 'framework/escape', { files: { 'ok.txt': 'x' } });
    fs.mkdirSync(path.join(dir, 'loop', 'stack', 'framework', 'escape', 'files', '.git'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, 'loop', 'stack', 'framework', 'escape', 'files', '.git', 'config'),
      'x',
    );
    assert.match(
      await problems([...LOCAL_APP, 'framework/escape']),
      /framework\/escape brings "\.git\/config", which is not a path inside the project/,
    );
  },
);

test(
  "a local full-stack app is built from its blocks: the web profile's files go, each block's come, and the loop starts",
  { skip: !fresh },
  async () => {
    const dir = copyOfRepo();
    const built = node(['scripts/build-stack.mjs', '--stack', LOCAL_APP.join(',')], dir);
    assert.equal(built.status, 0, built.stderr + built.stdout);
    assert.match(built.stdout, /forge\/github: this block brings no files\./);
    assert.match(
      built.stdout,
      /Done\. Install the dependencies \(`pnpm install`\), commit the result with the lockfile, then run \/setup-loop\./,
    );

    // the web profile's own files are gone, except what the web UI block scores screens against
    for (const rel of [
      'src/app',
      'src/lib',
      'supabase',
      'examples',
      'next.config.ts',
      'postcss.config.mjs',
      'vitest.config.mts',
      'eslint.config.mjs',
      '.prettierrc.json',
      '.prettierignore',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tests/unit',
      'presets',
    ]) {
      assert.ok(!has(dir, rel), `${rel} should be gone`);
    }
    for (const rel of [
      'DESIGN.md',
      'design/mocks/accepted/.gitkeep',
      'loop/run.mjs',
      'loop/stack/README.md',
      'docs/DECISIONS.md',
      'docs/BRIEF.md',
      'scripts/ac-trace.mjs',
      '.claude/skills/setup-loop/SKILL.md',
      'README.md',
    ]) {
      assert.ok(has(dir, rel), `${rel} should still be there`);
    }
    // every block's files are there, as it brought them
    const stackDir = path.join(REPO, 'loop', 'stack');
    for (const [block, rel] of [
      ['toolchain/vite-plus', 'gates/lint.ts'],
      ['toolchain/vite-plus', 'gates/test.ts'],
      ['toolchain/vite-plus', 'vite.config.ts'],
      ['toolchain/vite-plus', 'scripts/check-gates.mjs'],
      ['toolchain/vite-plus', 'scripts/run-scripts.mjs'],
      ['toolchain/vite-plus', 'playwright.config.ts'],
      ['toolchain/vite-plus', '.github/workflows/ci.yml'],
      ['framework/react-vite', 'src/web/App.tsx'],
      ['framework/fastify', 'src/server/app.ts'],
      ['product/web-ui', 'tests/e2e/journeys/home.spec.ts'],
      ['product/http-api', 'tests/e2e/api/health.spec.ts'],
      ['product/http-api', 'docs/API-CONVENTIONS.md'],
      ['database/sqlite', 'migrations/.gitkeep'],
    ]) {
      assert.equal(
        read(dir, rel),
        fs.readFileSync(path.join(stackDir, block, 'files', rel), 'utf8'),
        rel,
      );
    }

    // package.json is every block's part put together, in the order a formatter keeps
    const pkg = JSON.parse(read(dir, 'package.json'));
    assert.deepEqual(Object.keys(pkg), [
      'name',
      'version',
      'private',
      'description',
      'type',
      'scripts',
      'dependencies',
      'devDependencies',
      'engines',
      'packageManager',
    ]);
    assert.equal(
      pkg.scripts.check,
      'node scripts/check-gates.mjs && vp check && vp test run --coverage',
    );
    assert.equal(pkg.scripts.build, 'node scripts/run-scripts.mjs --all build:web build:server');
    assert.equal(pkg.scripts.start, 'node scripts/run-scripts.mjs --first start:server start:web');
    assert.equal(pkg.scripts['build:web'], 'vp build');
    assert.equal(pkg.scripts['start:server'], 'node src/server/main.ts');
    assert.deepEqual(Object.keys(pkg.dependencies), [
      '@fastify/static',
      'fastify',
      'react',
      'react-dom',
    ]);
    assert.deepEqual(
      Object.keys(pkg.devDependencies),
      [...Object.keys(pkg.devDependencies)].sort(),
    );
    for (const dep of ['vite-plus', '@playwright/test', '@axe-core/playwright', 'happy-dom'])
      assert.ok(pkg.devDependencies[dep], dep);
    assert.equal(read(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

    // every block's part of a shared page is in its place, and no marker is left
    const claude = read(dir, 'CLAUDE.md');
    assert.match(
      claude,
      /- `docs\/architecture\/README\.md` — [^\n]*\n- `DESIGN\.md` — the design system\. All UI follows it\.\n- `docs\/API-CONVENTIONS\.md` — /,
    );
    assert.match(
      claude,
      /\(`\*\.test\.ts`\), end-to-end tests are in `tests\/e2e\/`\n- \*\*React\*\* for the screens[\s\S]*- \*\*Fastify\*\* for the server[\s\S]*- \*\*SQLite\*\* for the data[\s\S]*- A change to the stack is a decision/,
    );
    assert.match(
      claude,
      /\| Commit author[^\n]*\|\n\nNothing is deployed\. A milestone is accepted on a production build of the merged base branch,\nstarted on the machine the loop runs on\.\n\n## HARD RULES — Gates/,
    );
    assert.match(
      claude,
      /4\. \*\*The script names are fixed\.\*\*[^\n]*\n[^\n]*\n\n## HARD RULES — Database\n\n1\. \*\*Every schema change is a new file\*\* in `migrations\/`/,
    );
    assert.match(claude, /5\. No database file in git\.\n\n## HARD RULES — Secrets and data/);
    const requirements = read(dir, 'docs/REQUIREMENTS.md');
    assert.match(
      requirements,
      /every later change is built on something that runs\.\n\n- AC-0\.1 The home page renders[^\n]*\n[^\n]*\n- AC-0\.2 `GET \/api\/health` answers 200[^\n]*\n[^\n]*\n\n<!-- shape-project: E1/,
    );
    assert.match(
      read(dir, 'docs/architecture/04-building-blocks.md'),
      /- \*\*Web app\*\* — `src\/web\/` — [^\n]*\n- \*\*Server\*\* — `src\/server\/` — [^\n]*\n$/,
    );
    assert.match(
      read(dir, 'docs/architecture/03-strategy.md'),
      /- \*\*Screens:\*\* React[\s\S]*- \*\*Server:\*\* Fastify[\s\S]*- \*\*Data:\*\* SQLite[\s\S]*- \*\*Hosting:\*\* none[^\n]*\n\n## Key ideas/,
    );
    assert.match(
      read(dir, 'docs/architecture/02-context.md'),
      /- \*\*GitHub Actions \(`ci`\)\*\* — [^\n]*\n- \*\*SQLite file\*\* — [^\n]*\n\n## Out of scope/,
    );
    assert.match(
      read(dir, '.gitignore'),
      /\*\.stackdump\n\n# database files: [^\n]*\n\*\.sqlite\n\*\.sqlite-\*\n\*\.db\n$/,
    );
    for (const rel of git(dir, 'ls-files', '-co', '--exclude-standard')
      .split('\n')
      // (a file the build removed is still in git's list until the result is committed)
      .filter((f) => !/^(loop|scripts|\.claude)\//.test(f) && has(dir, f))) {
      const text = read(dir, rel);
      assert.doesNotMatch(text, /<!-- stack:/, `${rel} still has a slot marker`);
      assert.ok(!/\.at\.[a-z-]+$/.test(rel), `${rel} is a part, not a file`);
      if (rel.endsWith('.md'))
        assert.doesNotMatch(text, /\n\n\n/, `${rel} has a gap where a slot stood`);
    }
    // nothing of the web profile is left in what the project reads
    for (const rel of [
      'CLAUDE.md',
      'docs/REQUIREMENTS.md',
      'docs/OWNER-ACTIONS.md',
      'docs/architecture/02-context.md',
      'docs/architecture/03-strategy.md',
      'docs/architecture/04-building-blocks.md',
      '.env.example',
      '.github/workflows/ci.yml',
      'package.json',
    ]) {
      assert.doesNotMatch(
        read(dir, rel),
        /supabase|vercel|next\.js|next start|eslint|prettier|npm run /i,
        rel,
      );
    }

    // the config lists the blocks; the project's own harness puts them together
    const cfg = JSON.parse(read(dir, 'loop/loop.config.json'));
    assert.deepEqual(cfg.stack, LOCAL_APP);
    assert.ok(!('profile' in cfg) && !('deploy' in cfg), 'no profile, and nothing is deployed');
    const { loadConfig } = await import(
      pathToFileURL(path.join(dir, 'loop', 'lib', 'config.mjs')).href
    );
    const stack = loadConfig(dir);
    assert.deepEqual(stack.localGate.commands, ['pnpm check', 'node scripts/arch-check.mjs']);
    assert.equal(stack.deploy.adapter, 'none');
    for (const command of stack.localGate.commands) {
      const script = command.match(/^pnpm (\S+)$/)?.[1];
      const file = command.match(/^node (scripts\/\S+)$/)?.[1];
      assert.ok(
        (script && pkg.scripts[script]) || (file && has(dir, file)),
        `local gate "${command}" must be a script of the project or a file in scripts/`,
      );
    }
    // every file the gates name is in the project
    for (const file of [
      'gates/lint.ts',
      'gates/fmt.ts',
      'tsconfig.json',
      ...stack.gates.ratchets.flatMap((r) => r.files),
    ])
      assert.ok(has(dir, file), `${file} is named by the gates`);

    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'build the stack');

    // the shared checks hold in the new project, without installing anything
    for (const args of [
      ['scripts/arch-check.mjs'],
      ['scripts/check-skills.mjs'],
      ['scripts/sanitize-scan.mjs'],
      ['loop/scripts/check-rules.mjs'],
      ['loop/scripts/stack.mjs'],
      ['.claude/skills/shape-project/scripts/check-backlog.mjs'],
    ]) {
      const r = node(args, dir);
      assert.equal(r.status, 0, `${args[0]}:\n${r.stdout}\n${r.stderr}`);
    }
    assert.match(
      node(['scripts/arch-check.mjs'], dir).stdout,
      /arch-check: OK — \d+ page\(s\), 2 building block\(s\)/,
    );
    const validator = node(['.claude/skills/setup-loop/scripts/check-config.mjs'], dir);
    assert.doesNotMatch(
      validator.stdout,
      /PROBLEM {2}config: (guard\.allowedDbProject|deploy\.devUrl|stack)/,
      validator.stdout,
    );

    // a second build is refused: the project is no longer a fresh copy of the template
    const again = node(['scripts/build-stack.mjs', '--stack', LOCAL_APP.join(',')], dir);
    assert.equal(again.status, 1);
    assert.match(
      again.stderr,
      /there is no presets\/ folder: this repository already is the project of one stack/,
    );

    // the loop's preflight accepts the project: stack, packs, adapters, prompt fragments, backlog
    cfg.repo = 'acme/app';
    cfg.gitAuthor = { name: 'Loop Tester', email: 'loop@example.com' };
    fs.writeFileSync(path.join(dir, 'loop', 'loop.config.json'), JSON.stringify(cfg, null, 2));
    const scan = node(['scripts/sanitize-scan.mjs'], dir);
    assert.equal(scan.status, 0, scan.stdout);
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
    assert.match(
      dryRun.stdout + dryRun.stderr,
      /the stack uses blocks no project has run on yet \(toolchain\/vite-plus, /,
    );
  },
);

test(
  'a stack that deploys gets a place for its dev URL, and a block no chosen block needs leaves nothing behind',
  { skip: !fresh },
  async () => {
    const dir = copyOfRepo();
    const p = await plan(dir, [
      'forge/github',
      'toolchain/vite-plus',
      'framework/fastify',
      'product/http-api',
      'hosting/vercel',
    ]);
    assert.deepEqual(p.problems, []);
    const cfg = JSON.parse(p.write.find((w) => w.path === 'loop/loop.config.json').text);
    assert.deepEqual(cfg.deploy, { devUrl: '' });
    // the runner waits for a deployment by reading the commit in the health answer: the server
    // this stack is built with reports it under the name the hosting block asks for
    const { loadConfig } = await import(
      pathToFileURL(path.join(dir, 'loop', 'lib', 'config.mjs')).href
    );
    fs.writeFileSync(path.join(dir, 'loop', 'loop.config.json'), JSON.stringify(cfg));
    const deploy = loadConfig(dir).deploy;
    git(dir, 'checkout', '--', 'loop/loop.config.json');
    assert.deepEqual(
      [deploy.adapter, deploy.health, deploy.commitField],
      ['http-health', '/api/health', 'commit'],
    );
    const server = fs.readFileSync(
      p.write.find((w) => w.path === 'src/server/app.ts').file,
      'utf8',
    );
    assert.match(
      server,
      new RegExp(
        `app\\.get\\('${deploy.health}', \\(\\) => \\(\\{ status: 'ok', ${deploy.commitField}: `,
      ),
    );
    assert.match(p.write.find((w) => w.path === '.env.example').text, /\nCOMMIT_SHA=\n$/);
    // no web UI block: the design system of the web profile goes with the rest
    assert.ok(p.remove.includes('DESIGN.md') && p.remove.includes('design'));
    assert.ok(!p.write.some((w) => /^src\/web\//.test(w.path) || w.path === 'index.html'));
    const pkg = JSON.parse(p.write.find((w) => w.path === 'package.json').text);
    assert.ok(!pkg.dependencies.react && !pkg.scripts['build:web'] && pkg.scripts['start:server']);
    // the hosting block is one of the profile's: it brings no files, and the builder says so
    assert.deepEqual(p.empty, ['forge/github', 'hosting/vercel']);
    // the parts of a page that no block filled are gone without a trace
    const claude = p.write.find((w) => w.path === 'CLAUDE.md').text;
    assert.doesNotMatch(claude, /<!-- stack:|DESIGN\.md|SQLite|React|\n\n\n/);
  },
);

test('run-scripts picks the scripts a project has: all of them to build, the first to start', async () => {
  const { pick } = await import(
    pathToFileURL(
      path.join(
        REPO,
        'loop',
        'stack',
        'toolchain',
        'vite-plus',
        'files',
        'scripts',
        'run-scripts.mjs',
      ),
    ).href
  );
  const scripts = {
    'build:web': 'vp build',
    'start:web': 'vp preview',
    'start:server': 'node src/server/main.ts',
    check: 'x',
  };
  assert.deepEqual(pick('--all', ['build:web', 'build:server'], scripts), { run: ['build:web'] });
  assert.deepEqual(
    pick('--all', ['build:server', 'build:web'], { ...scripts, 'build:server': 'tsc' }),
    { run: ['build:server', 'build:web'] },
  );
  assert.deepEqual(
    pick('--all', ['build:web', 'build:server'], {}),
    { run: [] },
    'nothing to build is not a failure',
  );
  assert.deepEqual(pick('--first', ['start:server', 'start:web'], scripts), {
    run: ['start:server'],
  });
  assert.deepEqual(pick('--first', ['start:server', 'start:web'], { 'start:web': 'vp preview' }), {
    run: ['start:web'],
  });
  assert.match(
    pick('--first', ['start:server', 'start:web'], {}).problem,
    /package\.json has none of these scripts: start:server, start:web/,
  );
  assert.match(pick('--first', ['start:server'], undefined).problem, /has none of these scripts/);
  assert.match(pick('--some', ['x'], scripts).problem, /^usage: /);
  assert.match(pick('--all', [], scripts).problem, /^usage: /);
  assert.deepEqual(
    pick('--all', ['toString', 'check'], scripts),
    { run: ['check'] },
    'only a script the file itself has',
  );
});
