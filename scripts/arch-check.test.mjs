// Tests for scripts/arch-check.mjs: the architecture pages are held to the tree.
// Run: node --test scripts/arch-check.test.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blocksOf,
  checkArchitecture,
  existsExactly,
  namedPaths,
  patternProblem,
} from './arch-check.mjs';

const SCRIPT = fileURLToPath(new URL('./arch-check.mjs', import.meta.url));
const REPO = path.resolve(path.dirname(SCRIPT), '..');

const tmps = [];
after(() => tmps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const DECISIONS = `# Decisions\n\n| ID    | Decision |\n| ----- | -------- |\n| D-001 | **Built with the loop.** |\n| D-002 | **One binary.** |\n`;
const BLOCKS_PAGE = `# 4 · Building blocks

<!-- A placeholder that names \`src/ghost.mjs\` and [a dead link](nowhere.md) and D-099. -->

\`\`\`mermaid
flowchart TB
  cli["src/cli.mjs"] --> gone["src/gone.mjs"]
\`\`\`

| Block    | Path          | Responsibility | Depends on |
| -------- | ------------- | -------------- | ---------- |
| Binary   | \`bin/cli.mjs\` | Starts         | Dispatch   |
| Dispatch | \`src/cli.mjs\` | Picks          | —          |
`;

/** A small repository: two blocks in the code, both on the page. */
function repo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-arch-'));
  tmps.push(root);
  const all = {
    'bin/cli.mjs': '',
    'src/cli.mjs': '',
    'docs/DECISIONS.md': DECISIONS,
    'docs/BRIEF.md': '# Brief\n',
    'docs/architecture/README.md':
      '# Architecture\n\n[Goals](01-goals.md) · [Blocks](04-building-blocks.md)\n',
    'docs/architecture/01-goals.md': '# 1 · Goals\n\nSee [the brief](../BRIEF.md#why) and D-001.\n',
    'docs/architecture/04-building-blocks.md': BLOCKS_PAGE,
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const CLI = ['bin/*', 'src/*'];
const texts = (r) => r.problems.map((p) => `${p.file}${p.line ? `:${p.line}` : ''}: ${p.text}`);
const run = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });

test('pages that match the tree pass, and say what was checked', () => {
  const root = repo();
  const r = checkArchitecture({ root, blocks: CLI });
  assert.deepEqual(texts(r), []);
  assert.deepEqual(r.counts, { pages: 3, links: 3, decisions: 1, paths: 2, blocks: 2 });
  const cli = run(root, '--blocks', CLI.join(','));
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /arch-check: OK — 3 page\(s\), 2 building block\(s\)/);
});

test('a block in the code that the page does not name is a problem: a file, a folder, a second pattern', () => {
  const root = repo({
    'src/report.mjs': '',
    'src/format/table.mjs': '',
    'bin/extra.mjs': '',
  });
  const r = checkArchitecture({ root, blocks: CLI });
  assert.deepEqual(
    texts(r).map((t) => t.match(/`([^`]+)` is in the code/)?.[1]),
    ['bin/extra.mjs', 'src/format', 'src/report.mjs'],
  );
  assert.match(
    texts(r)[0],
    /^docs\/architecture\/04-building-blocks\.md: .*Add its row to the table/,
  );
  const cli = run(root, '--blocks', CLI.join(','));
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /arch-check: FAIL — 3 problem\(s\)/);
});

test('a folder is named by its own path or by a path inside it, never by its parent', () => {
  const page = (rows) =>
    `${BLOCKS_PAGE}${rows.map((p) => `| X | \`${p}\` | x | — |`).join('\n')}\n`;
  const files = { 'src/format/table.mjs': '', 'src/format/values.mjs': '' };
  const check = (rows) =>
    texts(
      checkArchitecture({
        root: repo({ ...files, 'docs/architecture/04-building-blocks.md': page(rows) }),
        blocks: CLI,
      }),
    );
  assert.deepEqual(check(['src/format/']), []);
  assert.deepEqual(check(['src/format']), []);
  assert.deepEqual(check(['./src/format/table.mjs']), []);
  assert.deepEqual(check(['src/format/table.mjs#the-table']), []);
  assert.equal(check(['src/']).length, 1, 'the parent folder names none of its blocks');
  assert.equal(
    check(['src/formatter/']).length,
    2,
    'a longer name is another path, and it is not there',
  );
});

test('a pattern with a slash at the end finds folders only; tests, type files and dotfiles are no blocks', () => {
  const root = repo({
    'src/lib/env.ts': '',
    'src/lib/env.test.ts': '',
    'src/lib/env.spec.tsx': '',
    'src/lib/types.d.ts': '',
    'src/lib/.gitkeep': '',
    'src/lib/supabase/server.ts': '',
    'src/lib/__tests__/x.ts': '',
    'src/lib/node_modules/pkg/index.js': '',
    'src/app/page.tsx': '',
    'src/app/api/health/route.ts': '',
    'src/app/(admin)/page.tsx': '',
  });
  assert.deepEqual(blocksOf(root, 'src/lib/*'), ['src/lib/env.ts', 'src/lib/supabase']);
  assert.deepEqual(blocksOf(root, 'src/app/*/'), ['src/app/(admin)', 'src/app/api']);
  assert.deepEqual(blocksOf(root, 'src/*/'), ['src/app', 'src/lib']);
  assert.deepEqual(blocksOf(root, 'src/*/*/'), [
    'src/app/(admin)',
    'src/app/api',
    'src/lib/supabase',
  ]);
  assert.deepEqual(blocksOf(root, 'nowhere/*'), []);
  assert.deepEqual(blocksOf(root, 'src/cli.mjs/*'), [], 'a file has nothing in it');
});

test('a path the page names must be in the repository, with the same capitals', () => {
  const root = repo({
    'docs/architecture/04-building-blocks.md': `${BLOCKS_PAGE}| Old | \`src/old.mjs\` | gone | \`src/Cli.mjs\` |\n| Doc | \`docs/BRIEF.md#why\` | x | \`docs/NOPE.md\` |\n`,
  });
  const out = texts(checkArchitecture({ root, blocks: CLI }));
  assert.deepEqual(
    out.map((t) => t.match(/`([^`]+)` is named here/)?.[1]),
    ['src/old.mjs', 'src/Cli.mjs', 'docs/NOPE.md'],
  );
  assert.match(out[0], /^docs\/architecture\/04-building-blocks\.md:1[45]: /);
  assert.equal(existsExactly(root, 'src/cli.mjs'), true);
  assert.equal(existsExactly(root, 'src/Cli.mjs'), false);
  assert.equal(existsExactly(root, 'SRC/cli.mjs'), false);
});

test('only what looks like a path in this repository is read as one', () => {
  const page = `# 4 · Building blocks\n\n\`bin/cli.mjs\` and \`src/cli.mjs\`. Not paths: \`{ commit, db }\`, \`text/html\`, \`/api/health\`, \`app greet <name>\`, \`src/app/*/\`, \`APP_ENV=preview\`, \`n/a\`, \`https://example.com/a\`, \`--format\`.\n`;
  const root = repo({ 'docs/architecture/04-building-blocks.md': page });
  assert.deepEqual(texts(checkArchitecture({ root, blocks: CLI })), []);
  assert.deepEqual(
    namedPaths(page).map((n) => n.path),
    ['bin/cli.mjs', 'src/cli.mjs', 'text/html', 'n/a', '--format'],
    'what could be a path is kept; a first name that is nothing in the repository is then skipped',
  );
});

test('a decision ID a page names must be a row in docs/DECISIONS.md', () => {
  const root = repo({
    'docs/architecture/06-decisions.md': `# 6 · Decisions\n\n| Decision | Topic |\n| --- | --- |\n| [D-001](../DECISIONS.md) | built |\n| [D-007](../DECISIONS.md) | never recorded |\n\nSee also D-002, D-001 and AD-9 and D-7x.\n`,
  });
  assert.deepEqual(texts(checkArchitecture({ root, blocks: CLI })), [
    'docs/architecture/06-decisions.md:6: D-007 is not a row in docs/DECISIONS.md. Name a decision that exists, or record this one there first.',
  ]);
  // without the decisions file every ID is unknown
  const none = repo({ 'docs/DECISIONS.md': null });
  assert.match(
    texts(checkArchitecture({ root: none, blocks: CLI })).join('\n'),
    /01-goals\.md:3: D-001 is not a row/,
  );
});

test('a relative link must lead to a file; web links, anchors and mail are not followed', () => {
  const root = repo({
    'docs/architecture/02-context.md': `# 2 · Context\n\n[ok](01-goals.md) [ok](../BRIEF.md#why) [ok](<../BRIEF.md>) [web](https://example.com/x) [anchor](#scope) [mail](mailto:a@example.com)\n[dead](03-strategy.md) and [dead too](../Brief.md "title")\n`,
  });
  assert.deepEqual(texts(checkArchitecture({ root, blocks: CLI })), [
    'docs/architecture/02-context.md:4: the link `03-strategy.md` leads to no file. Correct it or remove it.',
    'docs/architecture/02-context.md:4: the link `../Brief.md` leads to no file. Correct it or remove it.',
  ]);
});

test('a link destination may hold parentheses and, in angle brackets, spaces', () => {
  const page = [
    '# 2 · Context',
    '',
    '[group](../../src/app/(auth)/page.tsx) [nested](../../src/app/(a(b))/page.tsx) [angle](<../../src/app/(auth)/page.tsx>)',
    "[spaced](<../../docs/with space.md>) [titled](../../src/app/(auth)/page.tsx 'the page') (see [goals](01-goals.md))",
    '[dead group](../../src/app/(gone)/page.tsx) [dead spaced](<../../docs/no such.md>)',
    '',
  ].join('\n');
  const root = repo({
    'src/app/(auth)/page.tsx': '',
    'src/app/(a(b))/page.tsx': '',
    'docs/with space.md': '',
    'docs/architecture/02-context.md': page,
    'docs/architecture/04-building-blocks.md': `${BLOCKS_PAGE}| Routes | \`src/app/(auth)/\` | x | \`src/app/(a(b))/\` |\n`,
  });
  const r = checkArchitecture({ root, blocks: CLI });
  assert.deepEqual(texts(r), [
    'docs/architecture/02-context.md:5: the link `../../src/app/(gone)/page.tsx` leads to no file. Correct it or remove it.',
    'docs/architecture/02-context.md:5: the link `../../docs/no such.md` leads to no file. Correct it or remove it.',
  ]);
  assert.equal(r.counts.links, 11, 'the three of the other pages and the eight here');
});

test('text in an HTML comment or a code block proves nothing either way', () => {
  // the page of every test above has a comment and a diagram that name things which do not exist
  assert.deepEqual(texts(checkArchitecture({ root: repo(), blocks: CLI })), []);
  // and a block named only in a comment or a diagram is not named
  const root = repo({
    'src/report.mjs': '',
    'docs/architecture/04-building-blocks.md': `${BLOCKS_PAGE}\n<!-- | Report | \`src/report.mjs\` | x | — | -->\n\n\`\`\`\n\`src/report.mjs\`\n\`\`\`\n`,
  });
  assert.equal(texts(checkArchitecture({ root, blocks: CLI })).length, 1);
});

test('missing pages are a problem, not a pass', () => {
  const noPages = repo({
    'docs/architecture/README.md': null,
    'docs/architecture/01-goals.md': null,
    'docs/architecture/04-building-blocks.md': null,
  });
  assert.match(
    texts(checkArchitecture({ root: noPages, blocks: CLI }))[0],
    /there are no architecture pages/,
  );
  assert.equal(run(noPages, '--blocks', CLI.join(',')).status, 1);
  const noBlocksPage = repo({ 'docs/architecture/04-building-blocks.md': null });
  assert.match(
    texts(checkArchitecture({ root: noBlocksPage, blocks: CLI })).join('\n'),
    /there is no building-blocks page/,
  );
  // a project made from an earlier template has the arc42 number in the file name
  const old = repo({
    'docs/architecture/04-building-blocks.md': null,
    'docs/architecture/05-building-blocks.md': BLOCKS_PAGE,
    'docs/architecture/README.md': '# Architecture\n\n[Blocks](05-building-blocks.md)\n',
  });
  assert.deepEqual(texts(checkArchitecture({ root: old, blocks: CLI })), []);
});

test('without patterns the pages are still checked, and the output says what was left out', () => {
  const root = repo({ 'src/report.mjs': '' });
  const r = checkArchitecture({ root, blocks: [] });
  assert.deepEqual(texts(r), []);
  assert.match(r.notes[0], /no building blocks are configured/);
  const cli = run(root); // no loop/ in this tree: nothing configured
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /checked for links, decisions and paths only/);
});

test('a pattern that is not usable is named, on the command line and in the check', () => {
  assert.equal(patternProblem('src/lib/*'), null);
  assert.equal(patternProblem('src/*/'), null);
  assert.equal(patternProblem('*/'), null);
  for (const bad of ['src/lib', 'src/**', '../x/*', '/abs/*', 'src\\lib\\*', 'src/l*b/*', '', 7]) {
    assert.ok(patternProblem(bad), `${JSON.stringify(bad)} should be refused`);
  }
  const r = checkArchitecture({ root: repo(), blocks: ['src/**', 'bin/*'] });
  assert.match(
    texts(r).join('\n'),
    /architecture\.blocks: the pattern "src\/\*\*" may only use names/,
  );
  assert.equal(run(repo(), '--nope').status, 2);
});

test('the patterns come from the loop config: the profile, then the project', () => {
  const root = repo({
    'src/report.mjs': '',
    'loop/loop.config.json': JSON.stringify({ profile: 'node-cli' }),
  });
  fs.cpSync(path.join(REPO, 'loop', 'lib'), path.join(root, 'loop', 'lib'), { recursive: true });
  fs.cpSync(path.join(REPO, 'loop', 'guard'), path.join(root, 'loop', 'guard'), {
    recursive: true,
  });
  fs.cpSync(path.join(REPO, 'loop', 'profiles'), path.join(root, 'loop', 'profiles'), {
    recursive: true,
  });
  const fromProfile = run(root);
  assert.equal(fromProfile.status, 1, fromProfile.stdout);
  assert.match(fromProfile.stderr, /`src\/report\.mjs` is in the code and not on this page/);
  // the project sets its own: bin only
  fs.writeFileSync(
    path.join(root, 'loop', 'loop.config.json'),
    JSON.stringify({ profile: 'node-cli', architecture: { blocks: ['bin/*'] } }),
  );
  assert.equal(run(root).status, 0);
  // a config that cannot be read is a failure, never a pass
  fs.writeFileSync(path.join(root, 'loop', 'loop.config.json'), '{ not json');
  const broken = run(root);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /could not read the loop config/);
});

test('the template passes its own check, with the patterns of its profile', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', REPO], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /arch-check: OK — \d+ page\(s\), [1-9]\d* building block\(s\)/);
});
