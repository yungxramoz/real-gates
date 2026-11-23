#!/usr/bin/env node
// Turns a fresh copy of the template into a project built from a list of stack blocks.
//
//   node scripts/build-stack.mjs --stack <block>,<block>,… --dry-run   show what would happen
//   node scripts/build-stack.mjs --stack <block>,<block>,…             do it
//   node scripts/build-stack.mjs --stack … --json                      the plan, for a program
//
// `node loop/scripts/stack.mjs --list` prints every block there is. /setup-loop asks what you are
// building, recommends the blocks and runs this.
//
// A stack that is one of the profiles needs no building: the template as it stands is the web
// profile, and `node scripts/apply-preset.mjs` swaps in another one. This script is for every
// other list of blocks. It
//   1. removes the files of the web profile the template's root holds
//      (loop/profiles/next-supabase-vercel/root.json), except the ones a chosen block still needs,
//   2. writes what each chosen block brings (loop/stack/<category>/<name>/files/), in stack order:
//        package.json            every block's part, put together: objects merge, and a value two
//                                blocks set differently is a problem
//        <file>.at.<slot>        added to <file>, in front of its `<!-- stack:<slot> -->` line.
//                                `<file>.at.end` goes to the end of the file
//        any other file          written as it is; two blocks bringing the same one is a problem
//   3. writes loop/loop.config.json with the list under "stack",
//   4. deletes presets/ (pass --keep-presets to keep it).
//
// It refuses a working tree with uncommitted changes unless --force is given, so git can bring
// everything back, and it changes nothing when the plan has a problem.
//
// Node built-ins only. Exit 0 when done, 1 with the reason.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE =
  'usage: node scripts/build-stack.mjs --stack <block>,<block>,… [--dry-run] [--json] [--force] [--keep-presets] [--root <dir>]';
/** The profile whose project the template's root is. */
const ROOT_PROFILE = 'next-supabase-vercel';
const SLOT = /\.at\.([a-z][a-z0-9-]*)$/;
/** The top-level keys of package.json in their usual order; a key not listed comes after them. */
const PACKAGE_KEYS = [
  'name',
  'version',
  'private',
  'description',
  'type',
  'bin',
  'files',
  'scripts',
  'dependencies',
  'devDependencies',
  'engines',
  'packageManager',
];

function parseArgs(argv) {
  const o = { stack: [], dry: false, json: false, force: false, keep: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else if (a === '--keep-presets') o.keep = true;
    else if (a === '--root' && argv[i + 1]) o.root = argv[++i];
    else if (a === '--stack' && argv[i + 1])
      o.stack.push(
        ...argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else throw new Error(`unknown argument "${a}"\n${USAGE}`);
  }
  return o;
}

function* walk(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else yield path.relative(base, full).replace(/\\/g, '/');
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const marker = (slot) => new RegExp(`^[ \\t]*<!-- stack:${slot} -->[ \\t]*\\r?\\n`, 'm');
const ANY_MARKER = /^[ \t]*<!-- stack:[a-z][a-z0-9-]* -->[ \t]*\r?\n/gm;

/** The harness of the repo at `root`: the code that knows what a stack is. */
async function harness(root) {
  const lib = (name) => import(pathToFileURL(path.join(root, 'loop', 'lib', name)).href);
  return { ...(await lib('stack.mjs')), ...(await lib('config.mjs')) };
}

/** What the project's own loop config starts as: the list of blocks, and the values /setup-loop asks for. */
function projectConfig(ids, composed) {
  const cfg = {
    $comment:
      'Written by scripts/build-stack.mjs and /setup-loop: this project\'s own values. "stack" lists the stack blocks the project is built with (loop/stack/). Every other key overrides the blocks, which override the defaults in loop/lib/config.mjs; anything left out keeps the value from there. What it adds up to: node loop/scripts/stack.mjs. Check it with: node loop/run.mjs --dry-run',
    stack: ids,
    repo: '',
    base: 'develop',
    production: 'main',
    ciCheck: 'ci',
  };
  // a stack that deploys the base branch has a URL only the project knows
  if (composed.deploy?.adapter && composed.deploy.adapter !== 'none') cfg.deploy = { devUrl: '' };
  return {
    ...cfg,
    guard: { protectedPaths: ['.env*', 'loop/**', '.github/**', '.claude/**'] },
    review: { minDesignScore: 7, maxRounds: 2 },
    budgets: { maxSessions: 150, maxHours: 120, maxUsdPerSession: 25, maxUsdPerRun: 0 },
    notify: { ntfyTopic: '' },
    gitAuthor: { name: '', email: '' },
  };
}

/**
 * What building the stack `ids` in the repo at `root` would do:
 * { problems, blocks, remove: [paths], write: [{ path, from: [block ids], text | file }], empty: [block ids] }.
 * `problems` not empty: nothing may be changed.
 */
export async function plan(root, ids) {
  const out = { problems: [], blocks: [], remove: [], write: [], empty: [] };
  const fail = (...p) => ({ ...out, problems: p });
  if (!fs.existsSync(path.join(root, 'loop', 'lib', 'stack.mjs')))
    return fail('loop/lib/stack.mjs is missing: this is not a copy of the template');
  const h = await harness(root);
  if (!ids.length)
    return fail(
      `no blocks named. \`node loop/scripts/stack.mjs --list\` prints every block.\n${USAGE}`,
    );
  let blocks;
  try {
    blocks = h.loadStack(root, ids);
  } catch (e) {
    return fail(...e.message.split('\n'));
  }
  const { config, conflicts } = h.composeStack(blocks);
  if (conflicts.length) return fail(...conflicts.map((c) => `the blocks do not fit: ${c}`));
  const stack = blocks.map((b) => b.id);
  out.blocks = blocks.map(({ id, title, status }) => ({ id, title, status }));

  // a stack that is a profile is not built: the template has it whole
  for (const name of h.profileNames(root)) {
    const whole = h.loadProfile(root, name).stack || [];
    if (whole.length === stack.length && whole.every((id) => stack.includes(id))) {
      return fail(
        name === ROOT_PROFILE
          ? `these blocks are the profile "${name}", which is the template as it stands: there is nothing to build`
          : `these blocks are the profile "${name}": take it whole with \`node scripts/apply-preset.mjs ${name}\``,
      );
    }
  }
  if (!fs.existsSync(path.join(root, 'presets')))
    return fail(
      'there is no presets/ folder: this repository already is the project of one stack. Build a stack in a fresh copy of the template.',
    );
  // A block whose code exists only in the project of a profile cannot be built into another
  // stack: nothing here would write that code, and what the block asks of the project (a health
  // answer that names the database, a config the gates freeze) would be asked of nothing.
  const buildable = (category) =>
    h
      .blockIds(root)
      .filter((id) => id.startsWith(`${category}/`) && !h.loadBlock(root, id).comesWith)
      .join(', ') || 'none ships yet';
  const tied = blocks.filter((b) => b.comesWith);
  if (tied.length)
    return fail(
      ...tied.map(
        (b) =>
          `${b.id} comes only as part of the profile "${b.comesWith}": its part of a project is that profile's. Take the profile whole, or choose a ${b.category} block that can be built into any stack (${buildable(b.category)}).`,
      ),
    );
  const toolchain = blocks.find((b) => b.category === 'toolchain');
  if (!fs.existsSync(path.join(toolchain.dir, 'files', 'package.json')))
    return fail(
      `${toolchain.id} brings no package.json: a stack is built on a toolchain that does`,
    );

  // 1. what the root holds of the web profile, and no chosen block still needs
  const manifest = readJson(path.join(root, 'loop', 'profiles', ROOT_PROFILE, 'root.json'));
  const kept = new Set(stack.flatMap((id) => manifest.keep?.[id] || []));
  out.remove = (manifest.files || []).filter(
    (rel) => !kept.has(rel) && fs.existsSync(path.join(root, rel)),
  );

  // 2. what the blocks bring
  const whole = new Map(); // path -> { from, file }
  const packages = [];
  const slots = []; // { path, slot, from, text }
  for (const b of blocks) {
    const dir = path.join(b.dir, 'files');
    const files = fs.existsSync(dir) ? [...walk(dir)].sort() : [];
    if (!files.length) out.empty.push(b.id);
    for (const rel of files) {
      const full = path.join(dir, rel);
      const slot = SLOT.exec(rel);
      if (slot)
        slots.push({
          path: rel.slice(0, slot.index),
          slot: slot[1],
          from: b.id,
          text: fs.readFileSync(full, 'utf8'),
        });
      else if (rel === 'package.json') packages.push({ id: b.id, config: readJson(full) });
      else if (whole.has(rel))
        out.problems.push(
          `${whole.get(rel).from} and ${b.id} both bring ${rel}: one file has one owner`,
        );
      else whole.set(rel, { from: b.id, file: full });
    }
  }
  const pkg = h.composeStack(packages);
  out.problems.push(...pkg.conflicts.map((c) => `the blocks' package.json parts do not fit: ${c}`));
  for (const key of ['dependencies', 'devDependencies']) {
    if (pkg.config[key]) pkg.config[key] = sorted(pkg.config[key]);
  }
  // the keys in the order a formatter of package.json puts them, so the file is clean as written
  pkg.config = Object.fromEntries(
    Object.entries(pkg.config)
      .map((entry, i) => ({ entry, at: PACKAGE_KEYS.indexOf(entry[0]), i }))
      .sort(
        (a, b) =>
          (a.at < 0 ? PACKAGE_KEYS.length : a.at) - (b.at < 0 ? PACKAGE_KEYS.length : b.at) ||
          a.i - b.i,
      )
      .map((x) => x.entry),
  );

  // a slot is filled in a file a block brings, or in one the root keeps
  const texts = new Map();
  const removed = (rel) => out.remove.some((r) => rel === r || rel.startsWith(`${r}/`));
  const textOf = (rel) => {
    if (texts.has(rel)) return texts.get(rel);
    const own = whole.get(rel);
    if (own) return fs.readFileSync(own.file, 'utf8');
    const there = path.join(root, rel);
    return !removed(rel) && fs.existsSync(there) ? fs.readFileSync(there, 'utf8') : null;
  };
  const filled = new Map(); // path -> block ids
  for (const s of slots) {
    const text = textOf(s.path);
    const part = s.text.endsWith('\n') ? s.text : `${s.text}\n`;
    const at = marker(s.slot);
    if (text === null)
      out.problems.push(
        `${s.from} adds to ${s.path}, which no block of this stack brings and the template does not keep`,
      );
    else if (s.slot !== 'end' && !at.test(text))
      out.problems.push(
        `${s.from} adds to ${s.path} at "${s.slot}", but the file has no <!-- stack:${s.slot} --> line`,
      );
    else {
      // a function as the replacement: the part is text, never a pattern with `$` in it
      texts.set(
        s.path,
        s.slot === 'end'
          ? `${text.endsWith('\n') ? text : `${text}\n`}${part}`
          : text.replace(at, (line) => part + line),
      );
      filled.set(s.path, [...(filled.get(s.path) || []), s.from]);
    }
  }

  // a slot nobody filled leaves no trace, and no gap where its line stood
  const clean = (rel, text) =>
    rel.endsWith('.md') ? text.replace(ANY_MARKER, '').replace(/\n{3,}/g, '\n\n') : text;
  for (const [rel, own] of whole) {
    const from = [...new Set([own.from, ...(filled.get(rel) || [])])];
    const text = texts.has(rel) ? texts.get(rel) : null;
    if (text !== null) out.write.push({ path: rel, from, text: clean(rel, text) });
    else if (/\.md$/.test(rel))
      out.write.push({ path: rel, from, text: clean(rel, fs.readFileSync(own.file, 'utf8')) });
    else out.write.push({ path: rel, from, file: own.file });
  }
  for (const [rel, text] of texts) {
    if (!whole.has(rel))
      out.write.push({ path: rel, from: [...new Set(filled.get(rel))], text: clean(rel, text) });
  }
  out.write.push({
    path: 'package.json',
    from: packages.map((p) => p.id),
    text: `${JSON.stringify(pkg.config, null, 2)}\n`,
  });
  out.write.push({
    path: 'loop/loop.config.json',
    from: ['the stack'],
    text: `${JSON.stringify(projectConfig(stack, config), null, 2)}\n`,
  });
  out.write.sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const w of out.write) {
    const norm = path.posix.normalize(w.path);
    if (
      norm !== w.path ||
      norm.startsWith('..') ||
      path.isAbsolute(norm) ||
      norm.startsWith('.git/')
    )
      out.problems.push(`${w.from[0]} brings "${w.path}", which is not a path inside the project`);
  }
  return out;
}

function dirtyTree(root) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return 'this folder is not a git repository';
  return r.stdout.trim() ? 'the working tree has uncommitted changes' : null;
}

export async function build(
  root,
  ids,
  { dry = false, force = false, keep = false, log = console.log } = {},
) {
  const p = await plan(root, ids);
  if (p.problems.length) return { ok: false, ...p };
  if (!dry && !force) {
    const dirty = dirtyTree(root);
    if (dirty)
      return {
        ok: false,
        ...p,
        problems: [`${dirty}. Commit or stash first so git can undo this, or pass --force.`],
      };
  }
  log(`${dry ? 'Would build' : 'Building'} a project from ${p.blocks.length} blocks:`);
  for (const b of p.blocks)
    log(
      `  ${b.id}: ${b.title}${b.status === 'proven' ? '' : ' [draft: tested, not yet proven by a project]'}`,
    );
  for (const rel of p.remove) {
    log(`  remove  ${rel}`);
    if (!dry) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
  for (const w of p.write) {
    log(`  write   ${w.path}  (${w.from.join(', ')})`);
    if (dry) continue;
    const dest = path.join(root, w.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (w.file) fs.copyFileSync(w.file, dest);
    else fs.writeFileSync(dest, w.text);
  }
  if (!keep) {
    log('  remove  presets/');
    if (!dry) fs.rmSync(path.join(root, 'presets'), { recursive: true, force: true });
  }
  if (p.empty.length)
    log(
      `\n${p.empty.join(', ')}: ${p.empty.length === 1 ? 'this block brings' : 'these blocks bring'} no files. What ${p.empty.length === 1 ? 'it says' : 'they say'} is in the loop config and in the prompts.`,
    );
  return { ok: true, ...p };
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`build-stack: ${e.message}`);
    return 1;
  }
  const root = path.resolve(
    o.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  if (o.json) {
    const p = await plan(root, o.stack);
    const { write, ...rest } = p;
    console.log(
      JSON.stringify(
        { ...rest, write: write.map(({ path: file, from }) => ({ path: file, from })) },
        null,
        2,
      ),
    );
    return p.problems.length ? 1 : 0;
  }
  const r = await build(root, o.stack, { dry: o.dry, force: o.force, keep: o.keep });
  if (!r.ok) {
    for (const line of r.problems) console.error(`build-stack: ${line}`);
    return 1;
  }
  if (!o.dry)
    console.log(
      '\nDone. Install the dependencies (`pnpm install`), commit the result with the lockfile, then run /setup-loop.',
    );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(await main());
