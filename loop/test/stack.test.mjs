// Stack blocks (loop/lib/stack.mjs, loop/stack/): how a list of blocks becomes one config and one
// set of words, what every shipped block has to be, and the proof that the two profiles, now
// lists of blocks, say exactly what they said as whole profiles.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, blockIds, composeStack, expandIncludes, fragmentParts, hasFragment, includesOf, loadBlock, loadStack, stackProblems, typesOf } from '../lib/stack.mjs';
import { DEFAULTS, configFor, configProblems, deepMerge, loadProfile, profileNames } from '../lib/config.mjs';
import { PACKS } from '../guard/packs/index.mjs';
import { adapterProblems } from '../adapters/index.mjs';
import { workTypeProblems } from '../lib/worktypes.mjs';
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
      expandIncludes(tpl, blocks, { types: ['command'] }),
      ['6. Prove it.', '   - run the check', '   - add tests,', '     never fewer', '   - a test per command', '   - check the health endpoint', '', '8. Not yours: the scripts', 'and the configs. The guard', '   blocks it.', '2. install the package'].join('\n'),
    );
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
  });
  for (const id of ids) {
    test(`${id}: says what it is and when to choose it, and adds only what the loop config knows`, () => {
      const b = loadBlock(REPO, id);
      assert.ok(CATEGORIES[b.category], `${b.category} is no category`);
      for (const k of ['title', 'description', 'choose']) assert.ok(b[k].trim().length > 0, `${id}: block.json needs "${k}"`);
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
    assert.match(listed.stdout, / {2}product\/cli-command: CLI command\n {4}Commands a person or a script runs in a terminal/);
    assert.match(listed.stdout, /Choose it when: The repository is on GitHub\./);
  });
  test('a project sees what its stack adds up to, with a profile and with its own list', () => {
    const cli = repoWith({});
    fs.cpSync(path.join(LOOP, 'stack'), path.join(cli, 'loop', 'stack'), { recursive: true });
    fs.cpSync(path.join(LOOP, 'profiles'), path.join(cli, 'loop', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'loop', 'loop.config.json'), JSON.stringify({ profile: 'node-cli' }));
    assert.deepEqual(describeStack(cli), {
      profile: 'node-cli',
      stack: [{ id: 'forge/github', title: 'GitHub' }, { id: 'toolchain/npm-node-test', title: 'npm and node:test' }, { id: 'product/cli-command', title: 'CLI command' }, { id: 'hosting/none', title: 'Not deployed' }],
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
      assert.deepEqual(settled(configFor(REPO, { profile: name })), settled(deepMerge(withUi, before)));
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
      const renders = {
        'build.md': types.map((t) => ({ types: [t] })),
        'review.md': types.map((t) => ({ variant: t, types: [t] })),
        'accept.md': types.filter((t) => cfg.workTypes[t].accept !== 'none').map((t) => ({ variant: cfg.workTypes[t].accept, types: [t] })),
        // a milestone nothing of which is accepted still gets its packet
        'packet.md': types.map((t) => ({ variant: cfg.workTypes[t].accept, types: [t] })),
      };
      const withIncludes = corePrompts().filter((x) => includesOf(x.text).length);
      assert.deepEqual(withIncludes.map((p) => p.name).sort(), Object.keys(renders).sort(), 'every prompt with an include is compared');
      for (const p of withIncludes) {
        const before = p.text.replace(/\{\{>([\w-]+)\}\}/g, (_, frag) => old(frag));
        assert.ok(renders[p.name].length > 0);
        for (const how of renders[p.name]) assert.equal(expandIncludes(p.text, blocks, { ...how, where: p.name }), before, `${p.name} with ${JSON.stringify(how)}`);
      }
      assert.deepEqual(configProblems(deepMerge(cfg, { repo: 'acme/app', gitAuthor: { name: 'A Person', email: 'person@example.com' }, deploy: { devUrl: 'https://dev.example.com' }, guard: { allowedDbProject: 'abcdefghijklmnopqrst' } })), []);
    });
  }
});
