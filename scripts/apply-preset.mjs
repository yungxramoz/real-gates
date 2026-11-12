#!/usr/bin/env node
// Turns a fresh copy of the template into a project of another stack.
//
//   node scripts/apply-preset.mjs                      list the presets
//   node scripts/apply-preset.mjs <name> --dry-run     show what would be removed and written
//   node scripts/apply-preset.mjs <name>               do it
//
// A preset is a folder presets/<name>/ with:
//   preset.json   { name, description, remove: [paths of the web preset this stack does not use] }
//   files/        copied over the repository root (the app skeleton, its CI workflow, CLAUDE.md,
//                 loop/loop.config.json naming the stack's profile, …)
// The stack's profile itself lives in loop/profiles/<name>/ and is not copied: every profile
// ships with the harness.
//
// It removes the paths in `remove`, copies `files/`, and deletes presets/ (pass --keep-presets to
// keep it). It refuses a working tree with uncommitted changes unless --force is given, so git
// can bring everything back. Run it before /setup-loop.
//
// Node built-ins only. Exit 0 when done, 1 with the reason.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE =
  'usage: node scripts/apply-preset.mjs [<name>] [--dry-run] [--force] [--keep-presets] [--root <dir>]';

function parseArgs(argv) {
  const o = { name: null, dry: false, force: false, keep: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a === '--keep-presets') o.keep = true;
    else if (a === '--root' && argv[i + 1]) o.root = argv[++i];
    else if (!a.startsWith('-') && !o.name) o.name = a;
    else throw new Error(`unknown argument "${a}"\n${USAGE}`);
  }
  return o;
}

export function listPresets(root) {
  const dir = path.join(root, 'presets');
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}
  return names
    .filter((n) => fs.existsSync(path.join(dir, n, 'preset.json')))
    .sort()
    .map((n) => ({
      name: n,
      ...JSON.parse(fs.readFileSync(path.join(dir, n, 'preset.json'), 'utf8')),
    }));
}

function* walk(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else yield path.relative(base, full).replace(/\\/g, '/');
  }
}

/** What applying `name` would do: { remove: [existing paths], write: [files], problems: [] }. */
export function plan(root, name) {
  const dir = path.join(root, 'presets', name);
  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !fs.existsSync(path.join(dir, 'preset.json'))) {
    return {
      remove: [],
      write: [],
      problems: [
        `"${name}" is not a preset (known: ${
          listPresets(root)
            .map((p) => p.name)
            .join(', ') || 'none'
        })`,
      ],
    };
  }
  const preset = JSON.parse(fs.readFileSync(path.join(dir, 'preset.json'), 'utf8'));
  if (!fs.existsSync(path.join(root, 'loop', 'profiles', name, 'profile.json')))
    problems.push(`loop/profiles/${name}/profile.json is missing: the preset has no stack profile`);
  const remove = [];
  for (const rel of preset.remove || []) {
    const norm = path.posix.normalize(String(rel).replace(/\\/g, '/'));
    // Only paths inside the repository, and never the harness or git itself.
    if (
      !norm ||
      norm.startsWith('..') ||
      path.isAbsolute(norm) ||
      /^(\.git|loop|presets|scripts|docs|\.github)(\/|$)/.test(norm) ||
      norm === '.'
    ) {
      problems.push(`preset.json: "${rel}" may not be removed by a preset`);
      continue;
    }
    if (fs.existsSync(path.join(root, norm))) remove.push(norm);
  }
  const filesDir = path.join(dir, 'files');
  const write = fs.existsSync(filesDir) ? [...walk(filesDir)].sort() : [];
  if (!write.length) problems.push(`presets/${name}/files/ is empty`);
  return { remove, write, problems, description: preset.description || '' };
}

function dirtyTree(root) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return 'this folder is not a git repository';
  return r.stdout.trim() ? 'the working tree has uncommitted changes' : null;
}

export function apply(
  root,
  name,
  { dry = false, force = false, keep = false, log = console.log } = {},
) {
  const p = plan(root, name);
  if (p.problems.length) return { ok: false, problems: p.problems };
  if (!dry && !force) {
    const dirty = dirtyTree(root);
    if (dirty)
      return {
        ok: false,
        problems: [`${dirty}. Commit or stash first so git can undo this, or pass --force.`],
      };
  }
  log(`${dry ? 'Would apply' : 'Applying'} preset "${name}": ${p.description}`);
  for (const rel of p.remove) {
    log(`  remove  ${rel}`);
    if (!dry) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
  for (const rel of p.write) {
    log(`  write   ${rel}`);
    if (dry) continue;
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, 'presets', name, 'files', rel), dest);
  }
  if (!keep) {
    log('  remove  presets/');
    if (!dry) fs.rmSync(path.join(root, 'presets'), { recursive: true, force: true });
  }
  return { ok: true, ...p };
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`apply-preset: ${e.message}`);
    return 1;
  }
  const root = path.resolve(
    o.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  if (!o.name) {
    const presets = listPresets(root);
    if (!presets.length)
      console.log(
        'apply-preset: no presets here. This repository already is the project of one stack.',
      );
    for (const p of presets) console.log(`${p.name}\n  ${p.description}\n`);
    if (presets.length)
      console.log(
        'The template as it stands is the web preset (Next.js, Supabase, Vercel): nothing to apply for it.',
      );
    return 0;
  }
  const r = apply(root, o.name, { dry: o.dry, force: o.force, keep: o.keep });
  if (!r.ok) {
    for (const line of r.problems) console.error(`apply-preset: ${line}`);
    return 1;
  }
  if (!o.dry)
    console.log(`\nDone. Review the result with \`git status\`, commit it, then run /setup-loop.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
