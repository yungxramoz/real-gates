// Stack blocks (loop/lib/stack.mjs, loop/stack/): how a list of blocks becomes one config and one
// set of words, what every shipped block has to be, and the proof that the two profiles, now
// lists of blocks, say exactly what they said as whole profiles.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CATEGORIES, STATUSES, blockIds, composeStack, expandIncludes, fragmentParts, hasFragment, includesOf, loadBlock, loadStack, stackProblems, typesOf } from '../lib/stack.mjs';
import { DEFAULTS, configFor, configProblems, deepMerge, loadProfile, profileNames } from '../lib/config.mjs';
import { PACKS } from '../guard/packs/index.mjs';
import { adapterProblems } from '../adapters/index.mjs';
import { acceptPlace, acceptPlan, workTypeProblems } from '../lib/worktypes.mjs';
import { ratchetValues } from '../lib/gates.mjs';
import { decide } from '../guard/core.mjs';
import { matchesAny, repoRelative } from '../guard/paths.mjs';
import { migrationDirs } from '../guard/shared.mjs';
import { PRESET } from './helpers/preset.mjs';
import { catalogue, describeStack } from '../scripts/stack.mjs';

const LOOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(LOOP, '..');
const PROMPTS = path.join(LOOP, 'prompts');
const corePrompts = () => fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.md')).map((f) => ({ name: f, text: fs.readFileSync(path.join(PROMPTS, f), 'utf8') }));

const tmp = [];
after(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
/** A repo with these blocks: { '<category>/<name>': { config, prompts: { '<file>.md': text } } }. */
function repoWith(blocks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-stack-'));
  tmp.push(root);
  for (const [id, b] of Object.entries(blocks)) {
    const dir = path.join(root, 'loop', 'stack', id);
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'block.json'), typeof b.raw === 'string' ? b.raw : JSON.stringify({ title: id, description: id, choose: id, config: b.config || {} }));
    for (const [file, text] of Object.entries(b.prompts || {})) fs.writeFileSync(path.join(dir, 'prompts', file), text);
  }
  return root;
}
const BASE = { 'forge/f': {}, 'toolchain/t': {} };

describe('a list of blocks', () => {
  test('an empty stack is the core alone; a stack needs one forge and one toolchain, and at most one hosting', () => {
    assert.deepEqual(stackProblems([]), []);
    assert.deepEqual(stackProblems(['forge/f', 'toolchain/t']), []);
    assert.deepEqual(stackProblems(['forge/f', 'toolchain/t', 'product/a', 'product/b', 'database/x', 'database/y', 'framework/n', 'hosting/h']), []);
    assert.match(stackProblems(['toolchain/t']).join('|'), /^stack: no forge block\. A stack needs one: where pull requests/);
    assert.match(stackProblems(['forge/f']).join('|'), /^stack: no toolchain block/);
    assert.match(stackProblems(['forge/f', 'forge/g', 'toolchain/t']).join('|'), /forge\/f and forge\/g are both forge blocks\. A stack has one/);
    assert.match(stackProblems(['forge/f', 'toolchain/t', 'hosting/a', 'hosting/b']).join('|'), /hosting\/a and hosting\/b are both hosting blocks/);
  });
  test('a name that is no block name, an unknown category and a repeated block are named', () => {
    assert.deepEqual(stackProblems('forge/f'), ['stack must be a list of block names ("<category>/<name>")']);
    assert.deepEqual(stackProblems([1]), ['stack must be a list of block names ("<category>/<name>")']);
    assert.match(stackProblems(['github'])[0], /"github" is not a block name/);
    assert.match(stackProblems(['../forge/f'])[0], /is not a block name/);
    assert.match(stackProblems(['Forge/F'])[0], /is not a block name/);
    assert.match(stackProblems(['cloud/aws'])[0], /"cloud\/aws" names no category \(known: forge, toolchain, framework, product, database, hosting\)/);
    assert.match(stackProblems(['forge/f', 'toolchain/t', 'product/a', 'product/a']).join('|'), /"product\/a" is listed twice/);
  });
  test('blocks are put together by category, then as listed', () => {
    const root = repoWith({ ...BASE, 'hosting/h': {}, 'product/b': {}, 'product/a': {}, 'database/d': {}, 'framework/n': {} });
    assert.deepEqual(loadStack(root, ['hosting/h', 'product/b', 'database/d', 'toolchain/t', 'product/a', 'framework/n', 'forge/f']).map((b) => b.id), ['forge/f', 'toolchain/t', 'framework/n', 'product/b', 'product/a', 'database/d', 'hosting/h']);
    assert.deepEqual(Object.keys(CATEGORIES), ['forge', 'toolchain', 'framework', 'product', 'database', 'hosting']);
    assert.deepEqual(loadStack(root, []), []);
    assert.deepEqual(loadStack(root, undefined), []);
  });
  test('a block that is not there, or not readable, throws a named error', () => {
    const root = repoWith({ ...BASE, 'product/broken': { raw: '{ nope' }, 'product/list': { raw: '[]' }, 'product/badconfig': { raw: '{"config": []}' } });
    assert.deepEqual(blockIds(root), ['forge/f', 'product/badconfig', 'product/broken', 'product/list', 'toolchain/t']);
    assert.throws(() => loadBlock(root, 'product/none'), /stack: "product\/none" is not a block under loop\/stack\/ \(known: forge\/f, /);
    assert.throws(() => loadBlock(root, '../../etc'), /is not a block under loop\/stack\//);
    assert.throws(() => loadBlock(root, 'product/broken'), /loop\/stack\/product\/broken\/block\.json is not valid JSON/);
    assert.throws(() => loadBlock(root, 'product/list'), /block\.json must be an object/);
    assert.throws(() => loadBlock(root, 'product/badconfig'), /with `config` an object/);
    assert.throws(() => loadStack(root, ['forge/f']), /no toolchain block/);
    assert.throws(() => loadStack(root, ['forge/f', 'toolchain/t', 'product/none']), /"product\/none" is not a block/);
    assert.deepEqual(blockIds(path.join(root, 'nowhere')), []);
  });
});

describe('the config of several blocks', () => {
  const block = (id, config) => ({ id, config });
  test('objects merge key by key and lists are joined, a value two blocks name kept once', () => {
    const { config, conflicts } = composeStack([
      block('forge/f', { guard: { packs: ['github'] }, forge: { adapter: 'github' } }),
      block('toolchain/t', { localGate: { commands: ['check', 'arch'] }, gates: { files: ['scripts/**'], frozenJsonKeys: [{ file: 'package.json', key: 'scripts' }] } }),
      block('product/p', { guard: { packs: ['npm', 'github'] }, gates: { files: ['e2e.config.*', 'scripts/**'], frozenJsonKeys: [{ file: 'package.json', key: 'scripts' }, { file: 'package.json', key: 'engines' }] }, workTypes: { ui: { rubric: ['a'], accept: 'site' } } }),
      block('database/d', { deploy: { expect: { db: ['ok'] } }, $comment: 'not config' }),
      block('hosting/h', { deploy: { adapter: 'http-health', health: '/api/health' } }),
    ]);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(config, {
      guard: { packs: ['github', 'npm'] },
      forge: { adapter: 'github' },
      localGate: { commands: ['check', 'arch'] },
      gates: { files: ['scripts/**', 'e2e.config.*'], frozenJsonKeys: [{ file: 'package.json', key: 'scripts' }, { file: 'package.json', key: 'engines' }] },
      workTypes: { ui: { rubric: ['a'], accept: 'site' } },
      deploy: { expect: { db: ['ok'] }, adapter: 'http-health', health: '/api/health' },
    });
  });
  test('a single value two blocks set differently is a conflict that names both; the same value is not', () => {
    const { conflicts } = composeStack([block('hosting/a', { deploy: { adapter: 'none' }, base: 'develop' }), block('database/d', { deploy: { adapter: 'none' } }), block('product/p', { deploy: { adapter: 'http-health' }, base: ['develop'] })]);
    assert.deepEqual(conflicts, ['hosting/a and product/p both set deploy.adapter ("none" and "http-health")', 'hosting/a and product/p both set base ("develop" and ["develop"])']);
    // two blocks that define the same work type differently cannot both be right
    const types = composeStack([block('product/a', { workTypes: { ui: { accept: 'site' } } }), block('product/b', { workTypes: { ui: { accept: 'local' } } })]);
    assert.deepEqual(types.conflicts, ['product/a and product/b both set workTypes.ui.accept ("site" and "local")']);
  });
  test('putting blocks together changes none of them', () => {
    const a = block('product/a', { guard: { packs: ['x'] }, gates: { ratchets: [{ name: 'c' }] } });
    const { config } = composeStack([a, block('product/b', { guard: { packs: ['y'] } })]);
    config.guard.packs.push('z');
    config.gates.ratchets[0].name = 'changed';
    assert.deepEqual(a.config, { guard: { packs: ['x'] }, gates: { ratchets: [{ name: 'c' }] } });
  });
});

describe('the words of several blocks', () => {
  const root = repoWith({
    ...BASE,
    'toolchain/t': { prompts: { 'proof.md': '- run the check\n- add tests,\n  never fewer\n', 'gate.md': 'the scripts\nand the configs.' } },
    'product/web': { config: { workTypes: { ui: {} } }, prompts: { 'proof.md': '- a journey per screen\n', 'drive.md': '- open it in a browser\n', 'accept.site.md': '2. open the site\n', 'accept.local.md': '2. start it here\n' } },
    'product/cli': { config: { workTypes: { command: {} } }, prompts: { 'proof.md': '- a test per command\n', 'drive.md': '- run the binary\n', 'accept.md': '2. install the package\n' } },
    'hosting/h': { prompts: { 'proof.md': '- check the health endpoint\n' } },
  });
  const blocks = loadStack(root, ['forge/f', 'toolchain/t', 'product/web', 'product/cli', 'hosting/h']);
  const from = (o) => fragmentParts(blocks, o.name, o).map((p) => p.block);

  test('every block may add to a fragment, in stack order', () => {
    assert.deepEqual(from({ name: 'proof' }), ['toolchain/t', 'product/web', 'product/cli', 'hosting/h']);
    assert.deepEqual(from({ name: 'gate' }), ['toolchain/t']);
    assert.deepEqual(from({ name: 'nothing' }), []);
    assert.deepEqual(blocks.map(typesOf), [[], [], ['ui'], ['command'], []]);
  });
  test('a block that defines a work type speaks when the step is about that type, or about none any block defines', () => {
    assert.deepEqual(from({ name: 'proof', types: ['ui'] }), ['toolchain/t', 'product/web', 'hosting/h']);
    assert.deepEqual(from({ name: 'proof', types: ['command'] }), ['toolchain/t', 'product/cli', 'hosting/h']);
    assert.deepEqual(from({ name: 'proof', types: ['ui', 'command'] }), ['toolchain/t', 'product/web', 'product/cli', 'hosting/h']);
    assert.deepEqual(from({ name: 'proof', types: ['default'] }), ['toolchain/t', 'product/web', 'product/cli', 'hosting/h']);
    assert.deepEqual(from({ name: 'drive', types: ['command'] }), ['product/cli']);
    assert.deepEqual(from({ name: 'drive', types: [] }), ['product/web', 'product/cli']);
  });
  test('<name>.<variant>.md wins over <name>.md, block by block', () => {
    const text = (o) => fragmentParts(blocks, 'accept', o).map((p) => p.text);
    assert.deepEqual(text({ variant: 'site' }), ['2. open the site', '2. install the package']);
    assert.deepEqual(text({ variant: 'local', types: ['ui'] }), ['2. start it here']);
    assert.deepEqual(text({ types: ['ui'] }), [], 'the web block has no words for accept without a variant');
    assert.equal(hasFragment(blocks, 'accept'), true, 'a variant alone counts as having the fragment');
    assert.equal(hasFragment(blocks, 'accep'), false);
    assert.equal(hasFragment(blocks, 'proof'), true);
    assert.equal(hasFragment([], 'proof'), false);
  });
  test('an include is replaced by the words, each later line indented like the line it stands on', () => {
    const tpl = ['6. Prove it.', '   {{>proof}}', '', '8. Not yours: {{>gate}} The guard', '   blocks it.', '{{>accept}}'].join('\n');
    assert.deepEqual(includesOf(tpl), ['proof', 'gate', 'accept']);
    assert.equal(
      expandIncludes(tpl, blocks, { cases: [{ types: ['command'] }] }),
      ['6. Prove it.', '   - run the check', '   - add tests,', '     never fewer', '   - a test per command', '   - check the health endpoint', '', '8. Not yours: the scripts', 'and the configs. The guard', '   blocks it.', '2. install the package'].join('\n'),
    );
  });
  test('a step about several cases gives the words for each in turn, under the line that names it', () => {
    const cases = [
      { variant: 'site', types: ['ui'], label: '**The ui items, on the site:**' },
      { variant: 'local', types: ['command'], label: '**The command items, on the base:**' },
    ];
    assert.equal(
      expandIncludes('1. Read.\n{{>accept}}\n   {{>drive}}\n5. Judge.', blocks, { cases }),
      ['1. Read.', '**The ui items, on the site:**', '2. open the site', '**The command items, on the base:**', '2. install the package', '   **The ui items, on the site:**', '   - open it in a browser', '   **The command items, on the base:**', '   - run the binary', '5. Judge.'].join('\n'),
    );
    // one case needs no heading
    assert.equal(expandIncludes('{{>accept}}', blocks, { cases: [cases[1]] }), '2. install the package');
    // a case no block has words for is named: the web block words acceptance for the site and the base, the CLI block for neither in particular
    assert.throws(() => expandIncludes('{{>accept}}', blocks, { cases: [cases[0], { variant: 'elsewhere', types: ['ui'] }], where: 'loop/prompts/accept.md' }), /loop\/prompts\/accept\.md includes \{\{>accept\}\}, but no block of the stack \(forge\/f, toolchain\/t, product\/web, product\/cli, hosting\/h\) has a prompts\/accept\.elsewhere\.md or accept\.md for "ui" items/);
  });
  test('an include no block has words for is an error that names the stack', () => {
    assert.throws(() => expandIncludes('{{>drive}}', blocks.filter((b) => b.category !== 'product'), { where: 'loop/prompts/review.md' }), /loop\/prompts\/review\.md includes \{\{>drive\}\}, but no block of the stack \(forge\/f, toolchain\/t, hosting\/h\) has a prompts\/drive\.md/);
    assert.throws(() => expandIncludes('{{>drive}}', []), /the prompt includes \{\{>drive\}\}, but loop\.config\.json names no stack/);
  });
});

// ------------------------------------------------------------------ what every shipped block has to be
describe('every shipped block fits the contract', () => {
  const ids = blockIds(REPO);
  const included = new Set(corePrompts().flatMap((p) => includesOf(p.text)));
  test('the blocks the two profiles are made of are there', () => {
    for (const id of ['forge/github', 'toolchain/pnpm-vitest', 'toolchain/npm-node-test', 'framework/next', 'product/web-ui', 'product/cli-command', 'database/supabase', 'hosting/vercel', 'hosting/none']) assert.ok(ids.includes(id), `${id} is missing (have: ${ids.join(', ')})`);
    // every category but the forge has a second choice
    for (const category of ['toolchain', 'framework', 'product', 'database', 'hosting']) assert.ok(ids.filter((id) => id.startsWith(`${category}/`)).length >= 2, category);
  });
  for (const id of ids) {
    test(`${id}: says what it is and when to choose it, and adds only what the loop config knows`, () => {
      const b = loadBlock(REPO, id);
      assert.ok(CATEGORIES[b.category], `${b.category} is no category`);
      for (const k of ['title', 'description', 'choose']) assert.ok(b[k].trim().length > 0, `${id}: block.json needs "${k}"`);
      assert.ok(STATUSES.includes(JSON.parse(fs.readFileSync(path.join(b.dir, 'block.json'), 'utf8')).status), `${id}: block.json says "status": "proven" or "draft"`);
      for (const entry of fs.readdirSync(b.dir)) assert.ok(['block.json', 'prompts', 'files'].includes(entry), `${id}: ${entry} is not part of a block (block.json, prompts/, files/)`);
      assert.ok(b.description.length >= 60, `${id}: the description has to say what the block does to the loop`);
      for (const k of Object.keys(b.config)) assert.ok(k in DEFAULTS, `${id}: config.${k} is not a key of the loop config`);
      // a block never carries a project's own values
      for (const k of ['repo', 'base', 'production', 'gitAuthor', 'profile', 'stack']) assert.ok(!(k in b.config), `${id}: "${k}" is the project's`);
      for (const pack of b.config.guard?.packs || []) assert.ok(PACKS[pack], `${id}: "${pack}" is not a guard pack`);
      const alone = deepMerge(DEFAULTS, b.config);
      assert.deepEqual(adapterProblems(alone), []);
      assert.deepEqual(workTypeProblems(alone, null), []);
      if (b.category !== 'product') assert.deepEqual(typesOf(b), [], `${id}: only a product block defines a work type`);
      else assert.ok(typesOf(b).length > 0, `${id}: a product block defines the work type its items have`);
    });
    test(`${id}: every text is one a core prompt includes`, () => {
      const dir = path.join(loadBlock(REPO, id).dir, 'prompts');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        assert.match(f, /^[\w-]+(\.[\w-]+)?\.md$/, `${id}/prompts/${f}: <name>.md or <name>.<variant>.md`);
        assert.ok(included.has(f.split('.')[0]), `${id}/prompts/${f} is included by no core prompt`);
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.doesNotMatch(text, /^[ \t]+\S/, `${id}/prompts/${f}: the words start flush left; the include indents them`);
        assert.doesNotMatch(text, /\{\{>/, `${id}/prompts/${f}: a block's words include no other fragment`);
      }
    });
  }
  test('a product block has the words for reviewing its items and, where they are accepted, for accepting them', () => {
    for (const id of ids.filter((i) => i.startsWith('product/'))) {
      const b = loadBlock(REPO, id);
      for (const name of ['build-proof', 'review-drive', 'review-rubric']) assert.ok(hasFragment([b], name), `${id} lacks prompts/${name}.md`);
      const accepted = Object.values(b.config.workTypes).some((t) => t.accept !== 'none');
      if (accepted) for (const name of ['accept-drive', 'accept-score', 'packet-shots']) assert.ok(hasFragment([b], name), `${id} lacks prompts/${name}.md`);
    }
  });
  test('a toolchain block names the local gate and the files a PR may not change, in config and in words', () => {
    for (const id of ids.filter((i) => i.startsWith('toolchain/'))) {
      const b = loadBlock(REPO, id);
      assert.ok(b.config.localGate?.commands?.length > 0, `${id}: no local gate`);
      assert.ok(b.config.localGate.commands.includes('node scripts/arch-check.mjs'), `${id}: the local gate checks the architecture pages`);
      assert.ok(b.config.gates?.files?.length > 0 && b.config.gates?.ratchets?.length > 0, `${id}: no gate files or no ratchet`);
      for (const name of ['build-proof', 'build-gate-files']) assert.ok(hasFragment([b], name), `${id} lacks prompts/${name}.md`);
    }
  });
});

describe('node loop/scripts/stack.mjs', () => {
  const script = path.join(LOOP, 'scripts', 'stack.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  test('the catalogue lists every shipped block under its category, with what it is and when to choose it', () => {
    const cats = catalogue(REPO);
    assert.deepEqual(cats.map((c) => c.category), Object.keys(CATEGORIES));
    assert.deepEqual(cats.flatMap((c) => c.blocks.map((b) => b.id)).sort(), blockIds(REPO));
    assert.deepEqual(cats.map((c) => c.holds), ['exactly one', 'exactly one', 'any number', 'any number', 'any number', 'one or none']);
    for (const b of cats.flatMap((c) => c.blocks)) assert.ok(b.title && b.description && b.choose, b.id);
    const listed = run('--list', '--root', REPO);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /product \(any number\): what a user touches/);
    assert.match(listed.stdout, / {2}product\/cli-command: CLI command \[only as part of the profile node-cli\]\n {4}Commands a person or a script runs in a terminal/);
    assert.match(listed.stdout, / {2}forge\/github: GitHub\n {4}Pull requests, CI results and the merge live on GitHub/);
    // a block whose code exists only in a profile's project says which profile
    assert.deepEqual(cats.flatMap((c) => c.blocks).filter((b) => b.comesWith).map((b) => b.id).sort(), ['database/supabase', 'framework/next', 'product/cli-command', 'toolchain/npm-node-test', 'toolchain/pnpm-vitest']);
    assert.match(listed.stdout, /Choose it when: The repository is on GitHub\./);
  });
  test('a project sees what its stack adds up to, with a profile and with its own list', () => {
    const cli = repoWith({});
    fs.cpSync(path.join(LOOP, 'stack'), path.join(cli, 'loop', 'stack'), { recursive: true });
    fs.cpSync(path.join(LOOP, 'profiles'), path.join(cli, 'loop', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'loop', 'loop.config.json'), JSON.stringify({ profile: 'node-cli' }));
    assert.deepEqual(describeStack(cli), {
      profile: 'node-cli',
      stack: [{ id: 'forge/github', title: 'GitHub', status: 'proven' }, { id: 'toolchain/npm-node-test', title: 'npm and node:test', status: 'proven' }, { id: 'product/cli-command', title: 'CLI command', status: 'proven' }, { id: 'hosting/none', title: 'Not deployed', status: 'proven' }],
      workTypes: { default: { rubric: [], accept: 'none' }, command: { rubric: ['help_and_errors', 'ergonomics', 'output', 'robustness'], accept: 'local' } },
      localGate: ['npm run check', 'node scripts/arch-check.mjs'],
      guardPacks: ['github', 'npm'],
      postMerge: [],
      deploy: 'none',
      forge: 'github',
    });
    const printed = run('--root', cli);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /^Profile: node-cli\nStack:\n {2}forge\/github: GitHub\n/);
    assert.match(printed.stdout, / {2}command: scored on help_and_errors, ergonomics, output, robustness; accepted: local/);
    assert.match(printed.stdout, /After a merge: nothing\nDeployed: no\nForge: github/);
    assert.deepEqual(JSON.parse(run('--json', '--root', cli).stdout), describeStack(cli));
    // its own list, and no stack at all
    fs.writeFileSync(path.join(cli, 'loop', 'loop.config.json'), JSON.stringify({ stack: ['forge/github', 'toolchain/pnpm-vitest', 'product/web-ui', 'database/supabase', 'hosting/vercel'] }));
    const own = run('--root', cli).stdout;
    assert.match(own, /^No profile: the project lists its own blocks\./);
    assert.match(own, /Guard packs: github, supabase, vercel\nAfter a merge: supabase-cli\nDeployed: yes \(http-health\)/);
    fs.writeFileSync(path.join(cli, 'loop', 'loop.config.json'), '{}');
    assert.match(run('--root', cli).stdout, /Stack: none\. The loop runs with the core alone/);
  });
  test('a config that cannot be read, and an argument it does not know, end with the reason', () => {
    const broken = repoWith(BASE);
    fs.writeFileSync(path.join(broken, 'loop', 'loop.config.json'), JSON.stringify({ stack: ['forge/f'] }));
    const r = run('--root', broken);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^stack: stack: no toolchain block/);
    const bad = run('--everything');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /stack: unknown argument "--everything"\nusage: node loop\/scripts\/stack\.mjs/);
  });
});

// ------------------------------------------------------------------- proven blocks and drafts
describe('a block is proven or a draft', () => {
  test('a block is proven only when it says so; the blocks a real project ran on are, the newer ones are drafts', () => {
    assert.deepEqual(STATUSES, ['proven', 'draft']);
    const root = repoWith({ 'product/said': { raw: '{"status":"proven"}' }, 'product/silent': { raw: '{}' }, 'product/other': { raw: '{"status":"finished"}' } });
    assert.deepEqual(['said', 'silent', 'other'].map((n) => loadBlock(root, `product/${n}`).status), ['proven', 'draft', 'draft']);
    const status = Object.fromEntries(blockIds(REPO).map((id) => [id, loadBlock(REPO, id).status]));
    assert.deepEqual(Object.keys(status).filter((id) => status[id] === 'proven').sort(), ['database/supabase', 'forge/github', 'framework/next', 'hosting/none', 'hosting/vercel', 'product/cli-command', 'product/web-ui', 'toolchain/npm-node-test', 'toolchain/pnpm-vitest']);
    assert.deepEqual(Object.keys(status).filter((id) => status[id] === 'draft').sort(), ['database/sqlite', 'framework/fastify', 'framework/react-vite', 'product/http-api', 'toolchain/vite-plus']);
    // a profile is a stack proven as a whole: it lists no draft
    for (const name of profileNames(REPO)) for (const id of loadProfile(REPO, name).stack) assert.equal(status[id], 'proven', `${name} lists ${id}`);
  });
  test('the stack command marks a draft, in the catalogue and in a project that uses one', () => {
    const script = path.join(LOOP, 'scripts', 'stack.mjs');
    const listed = spawnSync(process.execPath, [script, '--list', '--root', REPO], { encoding: 'utf8' }).stdout;
    assert.match(listed, / {2}product\/http-api: HTTP API \[draft: tested, not yet proven by a project\]\n/);
    assert.match(listed, / {2}product\/web-ui: Web UI\n/);
    const local = repoWith({});
    fs.cpSync(path.join(LOOP, 'stack'), path.join(local, 'loop', 'stack'), { recursive: true });
    fs.writeFileSync(path.join(local, 'loop', 'loop.config.json'), JSON.stringify({ stack: LOCAL_APP }));
    const printed = spawnSync(process.execPath, [script, '--root', local], { encoding: 'utf8' }).stdout;
    assert.match(printed, / {2}toolchain\/vite-plus: Vite\+ \(Oxlint, Oxfmt, Vitest\) \[draft: tested, not yet proven by a project\]\n/);
    assert.match(printed, / {2}forge\/github: GitHub\n/);
  });
});

// ------------------------------------------------- the newer blocks, alone and as one local app
// A web app with a server and a file database that runs on this machine only: the first stack
// that is not one of the two profiles. It is put together from blocks alone.
const LOCAL_APP = ['forge/github', 'toolchain/vite-plus', 'framework/react-vite', 'framework/fastify', 'product/web-ui', 'product/http-api', 'database/sqlite', 'hosting/none'];

describe('a local full-stack app, put together from blocks', () => {
  const cfg = configFor(REPO, { stack: LOCAL_APP });
  const blocks = loadStack(REPO, LOCAL_APP);
  const runnable = { repo: 'acme/app', gitAuthor: { name: 'A Person', email: 'person@example.com' } };
  test('the blocks fit together, and only the project\'s own values are missing', () => {
    assert.deepEqual(composeStack(blocks).conflicts, []);
    assert.deepEqual(adapterProblems(cfg), []);
    assert.deepEqual(workTypeProblems(cfg, { items: [{ id: 'U1', ui: true }, { id: 'A1', type: 'api' }, { id: 'L1' }] }), []);
    for (const p of configProblems(cfg)) assert.match(p, /^(repo|gitAuthor\.)/, p);
    assert.deepEqual(configProblems(deepMerge(cfg, runnable)), [], 'no dev URL and no database project: nothing is deployed and the data is a local file');
  });
  test('what it adds up to: two kinds of product accepted on the base, one gate, no step after a merge', () => {
    assert.deepEqual(cfg.workTypes, {
      default: { rubric: [], accept: 'none' },
      ui: { rubric: ['design_quality', 'originality', 'craft', 'functionality'], accept: 'site-or-local' },
      api: { rubric: ['contract', 'errors', 'robustness', 'security'], accept: 'site-or-local' },
    });
    assert.deepEqual(acceptPlan(cfg, [{ id: 'U1', ui: true }, { id: 'A1', type: 'api' }, { id: 'L1' }]), [{ place: 'local', types: ['ui', 'api'] }]);
    assert.deepEqual(cfg.localGate.commands, ['pnpm check', 'node scripts/arch-check.mjs']);
    assert.deepEqual(cfg.guard.packs, ['github']);
    assert.deepEqual(cfg.postMerge, []);
    assert.equal(cfg.deploy.adapter, 'none');
    assert.deepEqual(cfg.architecture.blocks, ['src/*/'], 'both frameworks name the same folders once');
    assert.deepEqual(cfg.migrations, { dirs: ['migrations'] });
    assert.deepEqual(migrationDirs(cfg), ['migrations']);
  });
  test('every step has its words, from the block they belong to, and none of another stack\'s', () => {
    const prompt = (name) => fs.readFileSync(path.join(PROMPTS, name), 'utf8');
    const render = (name, c) => expandIncludes(prompt(name), blocks, { cases: Array.isArray(c) ? c : [c], where: name });
    // the build of a screen: the toolchain, the screen's own proof, the database's rule. Not the API's
    const buildUi = render('build.md', { types: ['ui'] });
    assert.match(buildUi, /`pnpm check` \(the gate wiring check, then format, lint and types with `vp check`/);
    assert.match(buildUi, /UI work gets at least one Playwright journey/);
    assert.match(buildUi, /A change to the database schema is a new file in `migrations\/`/);
    assert.match(buildUi, /neither is CI's wiring: the `scripts` in `package\.json`, `scripts\/`, the lint and format rules in\n {3}`gates\/lint\.ts` and `gates\/fmt\.ts`/);
    assert.doesNotMatch(buildUi, /A new or changed endpoint/);
    // the build of an endpoint: its own proof instead of the screen's
    const buildApi = render('build.md', { types: ['api'] });
    assert.match(buildApi, /A new or changed endpoint \(work type `api`\) gets at least one end-to-end test/);
    assert.doesNotMatch(buildApi, /Playwright journey/);
    // a plain item: every product block says for which items its words hold
    const buildPlain = render('build.md', { types: ['default'] });
    assert.match(buildPlain, /UI work gets at least one Playwright journey[\s\S]*A new or changed endpoint \(work type `api`\)/);
    // the review of an endpoint is the API's
    const review = render('review.md', { variant: 'api', types: ['api'] });
    assert.match(review, /\*\*Use it like a client\*\* \(items of work type `api`\)/);
    assert.match(review, /The scores are for `api` items, calibrated against `docs\/API-CONVENTIONS\.md`/);
    assert.doesNotMatch(review, /UI items/);
    // one acceptance for both kinds, both on the merged base
    const cases = [
      { variant: 'local', types: ['ui'], label: '**The `ui` items:**' },
      { variant: 'local', types: ['api'], label: '**The `api` items:**' },
    ];
    const accept = render('accept.md', cases);
    assert.match(accept, /\*\*The `ui` items:\*\*\n2\. Run what was merged, never the working tree\.[\s\S]*3\. With Playwright against that local address/);
    assert.match(accept, /\*\*The `api` items:\*\*\n2\. Run what was merged, never the working tree\.[\s\S]*3\. Call \*\*every endpoint\*\* this milestone enables on that local address/);
    assert.match(accept, /\*\*The `ui` items:\*\*\n4\. Score every screen[\s\S]*\*\*The `api` items:\*\*\n4\. Score every endpoint on the rubric/);
    const packet = render('packet.md', cases);
    assert.match(packet, /\*\*The `api` items:\*\*\n1\. Nothing is deployed for this project\. Work from the build the acceptance step left/);
    for (const text of [buildUi, buildApi, buildPlain, review, accept, packet]) assert.doesNotMatch(text, /\{\{>|Dev URL|Supabase|Vercel|eslint|`npm run check`|CLI-CONVENTIONS/i);
    // and deployed, the same two blocks are accepted on the site
    const hosted = loadStack(REPO, [...LOCAL_APP.filter((id) => id !== 'hosting/none'), 'hosting/vercel']);
    assert.match(expandIncludes(prompt('accept.md'), hosted, { cases: [{ variant: 'site', types: ['api'] }] }), /3\. Call \*\*every endpoint\*\* this milestone enables on the dev URL/);
  });
});

describe('the Vite+ toolchain keeps its rules although every tool reads one config file', () => {
  const block = loadBlock(REPO, 'toolchain/vite-plus');
  const files = path.join(block.dir, 'files');
  const { gates } = block.config;
  test('the block brings the three gate files, the config that imports them and the check that holds them together', () => {
    for (const f of ['gates/lint.ts', 'gates/fmt.ts', 'gates/test.ts', 'vite.config.ts', 'scripts/check-gates.mjs']) assert.ok(fs.existsSync(path.join(files, f)), `files/${f}`);
    const config = fs.readFileSync(path.join(files, 'vite.config.ts'), 'utf8');
    for (const key of ['lint', 'fmt', 'test']) {
      assert.match(config, new RegExp(`import ${key} from './gates/${key}\\.ts';`));
      assert.match(config, new RegExp(`^  ${key},$`, 'm'), `${key} is passed as it is imported`);
    }
  });
  test('the lint and format rules are frozen, and no config file a tool would read instead can be added', () => {
    for (const f of ['gates/lint.ts', 'gates/fmt.ts', 'scripts/check-gates.mjs', 'tsconfig.json', 'tsconfig.node.json', '.oxlintrc.json', 'oxlint.config.ts', '.oxfmtrc.json', '.prettierrc', '.prettierignore', 'vitest.config.ts', 'vitest.workspace.ts']) assert.ok(matchesAny(f, gates.files), `${f} is a gate file`);
    // the config itself, the test settings (a ratchet) and the code stay free
    for (const f of ['vite.config.ts', 'gates/test.ts', 'src/app.ts', 'package.json']) assert.ok(!matchesAny(f, gates.files), `${f} may change`);
    assert.deepEqual(gates.frozenJsonKeys, [{ file: 'package.json', key: 'scripts' }]);
  });
  test('the coverage ratchet reads the thresholds of the gate file the block brings: it is not an empty gate', () => {
    const [ratchet] = gates.ratchets;
    assert.deepEqual(ratchet.files, ['gates/test.ts']);
    const text = fs.readFileSync(path.join(files, 'gates', 'test.ts'), 'utf8');
    assert.deepEqual(ratchetValues(text, ratchet), { lines: 80, functions: 80, branches: 70, statements: 80 });
    // a lowered number is seen, a number in a comment is not
    assert.equal(ratchetValues(text.replace('lines: 80', 'lines: 10'), ratchet).lines, 10);
    assert.equal(ratchetValues(text.replace('lines: 80', 'lines: 10 /* lines: 95 */'), ratchet).lines, 10);
  });
  test('the wiring check names a setting that is left out, changed or not from its gate file, and a file hidden from the tools', async () => {
    const { GATES, gateProblems } = await import(pathToFileURL(path.join(files, 'scripts', 'check-gates.mjs')).href);
    assert.deepEqual(GATES, { lint: 'gates/lint.ts', fmt: 'gates/fmt.ts', test: 'gates/test.ts' });
    const want = { lint: { rules: { eqeqeq: 'error' } }, fmt: { singleQuote: true }, test: { coverage: { thresholds: { lines: 80 } } } };
    assert.deepEqual(gateProblems({ config: { ...structuredClone(want), plugins: [], server: { port: 4300 } }, gates: want }), [], 'what else the config holds is its own');
    assert.match(gateProblems({ config: { ...want, lint: { ...want.lint, rules: {} } }, gates: want }).join('|'), /^`lint` in vite\.config\.ts is not what gates\/lint\.ts exports: pass the import as it is/);
    assert.match(gateProblems({ config: { ...want, test: { coverage: { thresholds: { lines: 1 } } } }, gates: want }).join('|'), /^`test` in vite\.config\.ts is not what gates\/test\.ts exports/);
    assert.match(gateProblems({ config: { lint: want.lint, test: want.test }, gates: want }).join('|'), /^vite\.config\.ts has no `fmt`: import gates\/fmt\.ts and pass it as it is \(`fmt,`\)$/);
    assert.match(gateProblems({ config: want, gates: { ...want, lint: undefined } }).join('|'), /^gates\/lint\.ts is missing or has no default export/);
    assert.match(gateProblems({ config: want, gates: want, hidden: ['src/sloppy.ts'] }).join('|'), /^`src\/sloppy\.ts` is tracked by git although an ignore file names it: the formatter and the linter skip it/);
    assert.equal(gateProblems({ config: {}, gates: {} }).length, 3);
  });
  // The check as a project runs it: a real config file, loaded the way the toolchain loads it.
  // That needs Vite's config loader, which the runner's own suite does not have (it is Node
  // built-ins only and runs before any install). Where the repository has Vite installed, as
  // the template does in CI, this runs; elsewhere it says why it did not.
  test('run against a real config, the check passes the honest one and fails every way of weakening it', async (t) => {
    // Vite+ in a project on that toolchain, plain Vite in the template itself
    const loader = (await import('vite-plus').catch(() => null)) ? 'vite-plus' : (await import('vite').catch(() => null)) ? 'vite' : null;
    if (!loader) return t.skip('neither Vite+ nor Vite is installed in this repository: the check needs their config loader');
    // inside the repository, so the config's import of Vite resolves; under .loop/, which git ignores
    fs.mkdirSync(path.join(REPO, '.loop'), { recursive: true });
    const root = fs.mkdtempSync(path.join(REPO, '.loop', 'check-gates-'));
    tmp.push(root);
    fs.cpSync(files, root, { recursive: true });
    const honest = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8').replace("from 'vite-plus'", `from '${loader}'`);
    const run = (config) => {
      fs.writeFileSync(path.join(root, 'vite.config.ts'), config);
      return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-gates.mjs')], { cwd: root, encoding: 'utf8' });
    };
    const ok = run(honest);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.match(ok.stdout, /check-gates: OK — vite\.config\.ts hands gates\/lint\.ts, gates\/fmt\.ts and gates\/test\.ts to their tools unchanged/);
    // a build setting of its own, and a config written as a function, are the project's business
    assert.equal(run(honest.replace('  lint,', "  server: { port: 4300 },\n  lint,")).status, 0);
    assert.equal(run(honest.replace('defineConfig({', 'defineConfig(() => ({').replace(/\}\);\s*$/, '}));\n')).status, 0);
    const fails = (config, why) => {
      const r = run(config);
      assert.equal(r.status, 1, `expected a failure: ${r.stdout}`);
      assert.match(r.stderr, why);
    };
    // a changed copy, the imported object changed in place, a setting left out
    fails(honest.replace('  lint,', '  lint: { ...lint, rules: {} },'), /`lint` in vite\.config\.ts is not what gates\/lint\.ts exports/);
    fails(honest.replace('  test,', '  test: { ...test, coverage: { ...test.coverage, thresholds: {} } },'), /`test` in vite\.config\.ts is not what gates\/test\.ts exports/);
    fails(honest.replace('export default', "test.coverage.thresholds.lines = 1;\nexport default"), /`test` in vite\.config\.ts is not what gates\/test\.ts exports/);
    fails(honest.replace('  fmt,\n', ''), /vite\.config\.ts has no `fmt`: import gates\/fmt\.ts and pass it as it is/);
    // a gate file that is gone, and a config that cannot be loaded, are failures too
    fs.renameSync(path.join(root, 'gates', 'fmt.ts'), path.join(root, 'gates', 'fmt.away'));
    fails(honest.replace("import fmt from './gates/fmt.ts';\n", 'const fmt = { singleQuote: true };\n'), /gates\/fmt\.ts is missing or has no default export/);
    fs.renameSync(path.join(root, 'gates', 'fmt.away'), path.join(root, 'gates', 'fmt.ts'));
    fails('export default {', /check-gates: could not read the config/);
    fs.rmSync(path.join(root, 'vite.config.ts'));
    const none = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-gates.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /could not read the config: no vite\.config\.ts in the project root/);
  });
});

describe('what the blocks bring into a project fits together', () => {
  const ids = blockIds(REPO);
  const filesOf = (id) => {
    const dir = path.join(loadBlock(REPO, id).dir, 'files');
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(dir, path.join(d, e.name)).replace(/\\/g, '/')])) : []);
    return { dir, files: walk(dir) };
  };
  const bases = ids.filter((id) => id.startsWith('toolchain/') && fs.existsSync(path.join(filesOf(id).dir, 'package.json')));
  test('a toolchain that a stack can be built on brings the four names a project is called by', () => {
    assert.deepEqual(bases, ['toolchain/vite-plus']);
    for (const id of bases) {
      const pkg = JSON.parse(fs.readFileSync(path.join(filesOf(id).dir, 'package.json'), 'utf8'));
      for (const name of ['check', 'build', 'start', 'test:e2e']) assert.ok(pkg.scripts[name], `${id}: no "${name}" script`);
      // the local gate of the block is a script it brings
      for (const command of loadBlock(REPO, id).config.localGate.commands) {
        const script = command.match(/^pnpm (\S+)$/)?.[1];
        const file = command.match(/^node (scripts\/\S+)$/)?.[1];
        assert.ok((script && pkg.scripts[script]) || file, `${id}: local gate "${command}"`);
      }
    }
  });
  test('a block whose code exists only in a profile\'s project names that profile, and brings no files of its own', () => {
    const tied = ids.map((id) => loadBlock(REPO, id)).filter((b) => b.comesWith);
    assert.deepEqual(tied.map((b) => `${b.id} with ${b.comesWith}`), ['database/supabase with next-supabase-vercel', 'framework/next with next-supabase-vercel', 'product/cli-command with node-cli', 'toolchain/npm-node-test with node-cli', 'toolchain/pnpm-vitest with next-supabase-vercel']);
    for (const b of tied) {
      assert.ok(loadProfile(REPO, b.comesWith).stack.includes(b.id), `${b.id}: the profile ${b.comesWith} lists it`);
      assert.deepEqual(filesOf(b.id).files, [], `${b.id}: its files are the profile's project, not the block's`);
    }
    // every other toolchain is one a stack can be built on, and every category but the forge's
    // has a block that can be built into any stack
    assert.deepEqual(ids.filter((id) => id.startsWith('toolchain/') && !loadBlock(REPO, id).comesWith), bases);
    for (const category of Object.keys(CATEGORIES)) assert.ok(ids.some((id) => id.startsWith(`${category}/`) && !loadBlock(REPO, id).comesWith), `${category}: a block to build with`);
    // a block that asks something of the health answer has its code in a profile: nothing a
    // built server would have to know about
    for (const id of ids) {
      const b = loadBlock(REPO, id);
      if (Object.keys(b.config.deploy?.expect || {}).length) assert.ok(b.comesWith, `${id} asks the health endpoint for ${Object.keys(b.config.deploy.expect).join(', ')}: the server a stack is built with does not answer that`);
    }
    const root = repoWith({ 'product/free': { raw: '{}' }, 'product/tied': { raw: '{"comesWith":"some-profile"}' }, 'product/odd': { raw: '{"comesWith":true}' } });
    assert.deepEqual(['free', 'tied', 'odd'].map((n) => loadBlock(root, `product/${n}`).comesWith), ['', 'some-profile', '']);
  });
  test('only a toolchain owns the four names; the other blocks bring scripts of their own under them', () => {
    for (const id of ids.filter((i) => !i.startsWith('toolchain/'))) {
      const file = path.join(filesOf(id).dir, 'package.json');
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of Object.keys(pkg)) assert.ok(['scripts', 'dependencies', 'devDependencies'].includes(key), `${id}: package.json part sets "${key}", which is the toolchain's`);
      for (const name of Object.keys(pkg.scripts || {})) assert.match(name, /^(build|start|dev):[a-z]+$/, `${id}: script "${name}"`);
      for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(version, /^\d+\.\d+\.\d+$/, `${id}: ${name} is pinned to one version`);
    }
  });
  test('every part a block adds to a shared page has its slot in a page a toolchain brings', () => {
    let parts = 0;
    for (const id of ids) {
      for (const rel of filesOf(id).files) {
        const slot = /^(.*)\.at\.([a-z][a-z0-9-]*)$/.exec(rel);
        if (!slot) continue;
        parts++;
        if (slot[2] === 'end') continue; // goes to the end of a file, wherever that comes from
        for (const base of bases) {
          const page = path.join(filesOf(base).dir, slot[1]);
          assert.ok(fs.existsSync(page), `${id} adds to ${slot[1]}, which ${base} does not bring`);
          assert.match(fs.readFileSync(page, 'utf8'), new RegExp(`^<!-- stack:${slot[2]} -->$`, 'm'), `${id} adds to ${slot[1]} at "${slot[2]}", and ${base}'s page has no such line`);
        }
      }
    }
    assert.ok(parts >= 10, 'the blocks of a built stack say their part on the shared pages');
  });
  test('no two blocks that may be in one stack bring the same file', () => {
    const owner = new Map();
    for (const id of ids) {
      for (const rel of filesOf(id).files.filter((f) => f !== 'package.json' && !/\.at\.[a-z][a-z0-9-]*$/.test(f))) {
        const other = owner.get(rel);
        // two toolchains, or two hosting blocks, are never in one stack
        const exclusive = other && other.split('/')[0] === id.split('/')[0] && ['toolchain', 'forge', 'hosting'].includes(id.split('/')[0]);
        assert.ok(!other || exclusive, `${other} and ${id} both bring ${rel}`);
        owner.set(rel, id);
      }
    }
  });
});

describe('a database the app migrates itself: its migrations are frozen without a step after a merge', () => {
  test('the frozen folders are the post-merge steps\' and the ones the config names, each once', () => {
    assert.deepEqual(migrationDirs({}), []);
    assert.deepEqual(migrationDirs(undefined), []);
    assert.deepEqual(migrationDirs({ postMerge: [{ adapter: 'supabase-cli', migrationsDir: 'supabase/migrations' }, { adapter: 'other' }] }), ['supabase/migrations']);
    assert.deepEqual(migrationDirs({ migrations: { dirs: ['migrations/', 'db/migrations'] }, postMerge: [{ migrationsDir: 'migrations' }] }), ['migrations', 'db/migrations']);
    assert.deepEqual(migrationDirs(PRESET), ['supabase/migrations'], 'the web profile freezes what it froze');
  });
  test('the guard refuses an edit to a migration on the base, in a stack with SQLite and no post-merge step', () => {
    const ROOT = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
    const cfg = deepMerge(configFor(REPO, { stack: LOCAL_APP }), { repo: 'acme/app' });
    const edit = (rel, onBase) => decide({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, rel) } }, { phase: 'build', item: 'T1', branch: 'feat/x', cfg, rel: (p) => repoRelative(ROOT, p), isOnBase: (r) => onBase.includes(r), projectRules: [] });
    const first = 'migrations/0001_init.sql';
    assert.deepEqual([edit(first, [first]).block, edit(first, [first]).rule], [true, 'core:frozen-migration']);
    assert.equal(edit('migrations/0002_next.sql', [first]).block, false, 'a new migration');
    assert.equal(edit('src/migrations/0001_init.sql', ['src/migrations/0001_init.sql']).block, false, 'a folder of the same name elsewhere');
    assert.equal(edit('migrations/README.md', ['migrations/README.md']).block, false, 'only the migrations themselves');
  });
  test('a list of folders that is not one is a named problem', () => {
    const bad = (dirs) => configProblems(deepMerge(PRESET, { migrations: { dirs } })).filter((p) => /migrations\.dirs/.test(p)).length;
    assert.equal(bad(['migrations', 'db/migrations']), 0);
    for (const dirs of ['migrations', [''], [3], ['/abs'], ['../outside'], ['a/../b']]) assert.equal(bad(dirs), 1, JSON.stringify(dirs));
  });
});

// ------------------------------------------------------------- the profiles, as lists of blocks
// loop/test/fixtures/profiles-v1/ holds the two profiles as they were before blocks: one
// profile.json with every setting and one folder of texts per profile. The profiles now only
// list blocks, and these tests hold them to what they said then. A change to a block that is
// meant to change what a profile says changes its fixture in the same commit.
describe('a profile is a list of blocks, and says what it said as a whole', () => {
  const V1 = path.join(LOOP, 'test', 'fixtures', 'profiles-v1');
  const names = profileNames(REPO);
  test('both shipped profiles have their earlier form on file', () => {
    assert.deepEqual(names, fs.readdirSync(V1).sort());
  });
  /** A config without what differs by design: the order of a list of patterns, and a work type removed with null. */
  const settled = (cfg) => {
    const c = structuredClone(cfg);
    delete c.profile;
    delete c.stack;
    c.gates.files = [...c.gates.files].sort();
    c.workTypes = Object.fromEntries(Object.entries(c.workTypes).filter(([, t]) => t !== null));
    return c;
  };
  for (const name of names) {
    test(`${name}: lists blocks and nothing else`, () => {
      const profile = loadProfile(REPO, name);
      assert.deepEqual(Object.keys(profile).filter((k) => !k.startsWith('$')), ['stack']);
      assert.deepEqual(stackProblems(profile.stack), []);
      assert.deepEqual(composeStack(loadStack(REPO, profile.stack)).conflicts, []);
    });
    test(`${name}: the same settings, key for key`, () => {
      const before = JSON.parse(fs.readFileSync(path.join(V1, name, 'profile.json'), 'utf8'));
      // the type "ui" was a default every other stack had to remove; now the web UI block brings it
      const withUi = deepMerge(DEFAULTS, { workTypes: { ui: { rubric: ['design_quality', 'originality', 'craft', 'functionality'], accept: 'site' } } });
      const now = settled(configFor(REPO, { profile: name }));
      // a screen is accepted where the product runs, which for a deployed stack is the site, as before
      if (now.workTypes.ui) {
        assert.equal(now.workTypes.ui.accept, 'site-or-local');
        assert.equal(acceptPlace(now, now.workTypes.ui), 'site');
        now.workTypes.ui.accept = 'site';
      }
      assert.deepEqual(now, settled(deepMerge(withUi, before)));
      assert.deepEqual(configFor(REPO, { profile: name }).guard.packs, before.guard.packs, 'the guard packs keep their order');
      assert.deepEqual(configFor(REPO, { profile: name }).localGate.commands, before.localGate.commands, 'the local gate keeps its order');
    });
    test(`${name}: the same words in every prompt, character for character`, () => {
      const cfg = configFor(REPO, { profile: name });
      const blocks = loadStack(REPO, cfg.stack);
      const old = (frag) => fs.readFileSync(path.join(V1, name, 'prompts', `${frag}.md`), 'utf8').trim();
      const types = Object.keys(cfg.workTypes).filter((t) => cfg.workTypes[t]);
      // how the runner renders each step: the build and the review for an item of one work type
      // (the review picks its variant by that type), acceptance and the packet for the accepted
      // types of a milestone, with the place they are accepted at as the variant
      const place = (t) => acceptPlace(cfg, cfg.workTypes[t]);
      const accepted = types.filter((t) => place(t) !== 'none').map((t) => ({ variant: place(t), types: [t] }));
      const renders = {
        'build.md': types.map((t) => ({ types: [t] })),
        'review.md': types.map((t) => ({ variant: t, types: [t] })),
        // a milestone nothing of which is accepted still gets its packet, worded like an accepted one
        'accept.md': accepted,
        'packet.md': accepted,
      };
      const withIncludes = corePrompts().filter((x) => includesOf(x.text).length);
      assert.deepEqual(withIncludes.map((p) => p.name).sort(), Object.keys(renders).sort(), 'every prompt with an include is compared');
      for (const p of withIncludes) {
        const before = p.text.replace(/\{\{>([\w-]+)\}\}/g, (_, frag) => old(frag));
        assert.ok(renders[p.name].length > 0);
        for (const how of renders[p.name]) assert.equal(expandIncludes(p.text, blocks, { cases: [how], where: p.name }), before, `${p.name} with ${JSON.stringify(how)}`);
      }
      assert.deepEqual(configProblems(deepMerge(cfg, { repo: 'acme/app', gitAuthor: { name: 'A Person', email: 'person@example.com' }, deploy: { devUrl: 'https://dev.example.com' }, guard: { allowedDbProject: 'abcdefghijklmnopqrst' } })), []);
    });
  }
});
