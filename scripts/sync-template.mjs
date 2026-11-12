#!/usr/bin/env node
// Brings the template's part of a project up to date: the loop, the skills, the shared scripts
// and the CI workflow. A project is a copy of the template, so a fix made there reaches it only
// through this command.
//
//   node scripts/sync-template.mjs --from <template folder or git URL> [--ref <branch>] --dry-run
//   node scripts/sync-template.mjs --from <template folder or git URL>
//
// Without --from it uses the template this repository was created from (asked from GitHub with
// `gh`), or, when the script is run out of another repository's folder, that repository:
//
//   cd my-project && node ../real-gates/scripts/sync-template.mjs      (a project that has no copy yet)
//
// What it changes is listed in the template's loop/harness.json:
//   mirror       folders that are the template's entirely. Files the template no longer has are removed.
//   files        single files that are the template's.
//   presetFiles  files that differ per stack (the CI workflow). They come from the template's
//                presets/<profile>/files/ for the profile this project uses.
//   keep         paths inside a mirrored folder that are the project's own: its config, its
//                backlog, the rules it learned, its pending runner patches.
// Nothing else is touched: docs, CLAUDE.md, the app and package.json stay as they are. When the
// template changed one of those since the last sync, the command names the file so you can look.
//
// It refuses a working tree with uncommitted changes unless --force is given, so git can undo
// it, and it records what it synced in loop/template.lock.json. Node built-ins only.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE =
  'usage: node scripts/sync-template.mjs [--from <template folder or git URL>] [--ref <branch or tag>] [--project <dir>] [--dry-run] [--force]';
const LOCK = 'loop/template.lock.json';
const posix = (p) => p.replace(/\\/g, '/');

function parseArgs(argv) {
  const o = { from: null, ref: null, project: null, dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (['--from', '--ref', '--project'].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument "${a}"\n${USAGE}`);
  }
  return o;
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

function* walk(dir, base = dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else yield posix(path.relative(base, full));
  }
}

/** Files of the template under `prefix`: what git tracks or would add, so no build output or runtime state. */
function templateFiles(source, prefix) {
  const r = git(source, 'ls-files', '-co', '--exclude-standard', '-z', '--', prefix);
  const listed =
    r.status === 0
      ? r.stdout.split('\0').filter(Boolean).map(posix)
      : [...walk(path.join(source, prefix), source)];
  return listed.filter((f) => fs.existsSync(path.join(source, f)));
}

const kept = (rel, keep) =>
  keep.some((k) => (k.endsWith('/**') ? rel.startsWith(k.slice(0, -2)) : rel === k));
const sameFile = (a, b) =>
  fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

/**
 * What a sync would do. { write: [{ rel, from, state: 'new' | 'changed' }], remove: [rel],
 * notes: [sentence], problems: [sentence], commit }
 */
export function plan(project, source) {
  const problems = [];
  const notes = [];
  const manifest = readJson(path.join(source, 'loop', 'harness.json'), null);
  if (!manifest)
    return {
      write: [],
      remove: [],
      notes,
      problems: [
        `${source} has no loop/harness.json: it is not a template this command can sync from`,
      ],
    };
  if (!fs.existsSync(path.join(project, 'loop', 'loop.config.json'))) {
    return {
      write: [],
      remove: [],
      notes,
      problems: [
        `${project} has no loop/loop.config.json: it is not a project made from the template`,
      ],
    };
  }
  const keep = manifest.keep || [];
  const write = [];
  const remove = [];
  const add = (rel, from) => {
    if (kept(rel, keep) || sameFile(from, path.join(project, rel))) return;
    write.push({ rel, from, state: fs.existsSync(path.join(project, rel)) ? 'changed' : 'new' });
  };

  for (const dir of manifest.mirror || []) {
    const inTemplate = new Set(templateFiles(source, dir));
    for (const rel of inTemplate) add(rel, path.join(source, rel));
    for (const rel of walk(path.join(project, dir), project)) {
      if (!inTemplate.has(rel) && !kept(rel, keep)) remove.push(rel);
    }
  }
  for (const rel of manifest.files || []) {
    // A listed file this template version does not have is simply not synced: a project's copy
    // of it, if any, stays.
    if (fs.existsSync(path.join(source, rel))) add(rel, path.join(source, rel));
  }

  // Files that differ per stack come from the preset of the profile this project uses. The
  // template's own root is the preset of the profile its own config names.
  const profile = readJson(path.join(project, 'loop', 'loop.config.json'), {}).profile || '';
  const rootProfile = readJson(path.join(source, 'loop', 'loop.config.json'), {}).profile || '';
  for (const rel of manifest.presetFiles || []) {
    const fromPreset = path.join(source, 'presets', profile, 'files', rel);
    const from = profile && profile !== rootProfile ? fromPreset : path.join(source, rel);
    if (fs.existsSync(from)) add(rel, from);
    else
      notes.push(
        `${rel}: the template has no version of it for the profile "${profile}"; your copy stays`,
      );
  }

  if (profile && !fs.existsSync(path.join(source, 'loop', 'profiles', profile, 'profile.json'))) {
    problems.push(
      `the template has no profile "${profile}" (loop/profiles/${profile}/): this project's stack would lose its profile`,
    );
  }
  const head = git(source, 'rev-parse', 'HEAD');
  return {
    write: write.sort((a, b) => a.rel.localeCompare(b.rel)),
    remove: remove.sort(),
    notes,
    problems,
    commit: head.status === 0 ? head.stdout.trim() : null,
    manifest,
  };
}

/**
 * Is a commit in the template checkout? A clone made for this run is shallow, so the commit of the
 * last sync may be missing: ask the remote for that one commit, and failing that for the history.
 */
function haveCommit(source, sha, fetchMissing) {
  const has = () => git(source, 'cat-file', '-e', `${sha}^{commit}`).status === 0;
  if (!/^[0-9a-f]{7,64}$/i.test(String(sha))) return false;
  if (has()) return true;
  if (!fetchMissing) return false;
  git(source, 'fetch', '-q', '--depth', '1', 'origin', sha);
  if (has()) return true;
  git(source, 'fetch', '-q', '--unshallow', 'origin');
  return has();
}

/**
 * Files outside the harness that the template changed since the last sync: the project's to look
 * at. Null when the two commits cannot be compared; the caller says so instead of staying silent.
 */
function changedElsewhere(project, source, p, fetchMissing) {
  const last = readJson(path.join(project, LOCK), {}).commit;
  if (!last || !p.commit || last === p.commit) return [];
  if (!haveCommit(source, last, fetchMissing)) return null;
  const r = git(source, 'diff', '--name-only', `${last}..${p.commit}`);
  if (r.status !== 0) return null;
  const own = (rel) =>
    (p.manifest.mirror || []).some((d) => rel.startsWith(`${d}/`)) ||
    (p.manifest.files || []).includes(rel) ||
    (p.manifest.presetFiles || []).includes(rel) ||
    rel.startsWith('presets/');
  return r.stdout
    .split('\n')
    .map((l) => posix(l.trim()))
    .filter((rel) => rel && !own(rel) && fs.existsSync(path.join(project, rel)));
}

/**
 * How the lock file names the template: its URL. A folder on this machine is named by its git
 * remote, or failing that by its folder name; the full path would put a user name into a
 * committed file.
 */
function sourceName(source, label) {
  if (/^(https?:|git@|ssh:)/.test(label)) return label;
  const remote = git(source, 'remote', 'get-url', 'origin');
  return remote.status === 0 && remote.stdout.trim() ? remote.stdout.trim() : path.basename(source);
}

function dirtyTree(root) {
  const r = git(root, 'status', '--porcelain');
  if (r.status !== 0) return 'this folder is not a git repository';
  return r.stdout.trim() ? 'the working tree has uncommitted changes' : null;
}

export function sync(
  project,
  source,
  { dry = false, force = false, label = source, log = console.log, fetchMissing = false } = {},
) {
  const p = plan(project, source);
  if (p.problems.length) return { ok: false, problems: p.problems };
  if (!dry && !force) {
    const dirty = dirtyTree(project);
    if (dirty)
      return {
        ok: false,
        problems: [`${dirty}. Commit or stash first so git can undo this, or pass --force.`],
      };
  }
  const elsewhere = changedElsewhere(project, source, p, fetchMissing);
  log(
    `${dry ? 'Would sync' : 'Syncing'} from ${label}${p.commit ? ` at ${p.commit.slice(0, 7)}` : ''}`,
  );
  for (const w of p.write) {
    log(`  ${w.state === 'new' ? 'add    ' : 'update '} ${w.rel}`);
    if (dry) continue;
    const dest = path.join(project, w.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(w.from, dest);
  }
  for (const rel of p.remove) {
    log(`  remove  ${rel}`);
    if (!dry) fs.rmSync(path.join(project, rel), { force: true });
  }
  if (!p.write.length && !p.remove.length) log('  nothing to do: the template part is up to date');
  for (const n of p.notes) log(`  note    ${n}`);
  if (elsewhere === null) {
    log(
      `
warning: the commit of the last sync (${String(readJson(path.join(project, LOCK), {}).commit).slice(0, 7)}) is not in the template any more, so this run cannot tell which of your own files the template changed since. Compare README.md, CLAUDE.md, docs and the CI workflow with the template yourself.`,
    );
  } else if (elsewhere.length) {
    log(
      `\nThe template also changed files that are yours. They were not touched; compare them yourself:`,
    );
    for (const rel of elsewhere) log(`  ${rel}`);
  }
  if (!dry) {
    const lock = {
      $comment:
        'Written by scripts/sync-template.mjs: which template commit this project last synced from.',
      source: sourceName(source, label),
      commit: p.commit,
      syncedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(project, LOCK), JSON.stringify(lock, null, 2) + '\n');
  }
  return { ok: true, ...p, elsewhere };
}

/** The template this repository was made from, as GitHub knows it. Null when gh cannot say. */
function templateFromGitHub(project) {
  const r = spawnSync(
    'gh',
    ['repo', 'view', '--json', 'templateRepository', '-q', '.templateRepository.url'],
    { cwd: project, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const url = r.status === 0 ? r.stdout.trim() : '';
  return /^https?:\/\//.test(url) ? url : null;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`sync-template: ${e.message}`);
    return 1;
  }
  const top = git(path.resolve(o.project || process.cwd()), 'rev-parse', '--show-toplevel');
  const project = path.resolve(top.status === 0 ? top.stdout.trim() : o.project || process.cwd());
  const scriptRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Run out of another repository's folder, that repository is the template.
  let from =
    o.from || (path.resolve(scriptRepo) !== project ? scriptRepo : templateFromGitHub(project));
  if (!from) {
    console.error(
      'sync-template: cannot tell which template to sync from. Pass --from <template folder or git URL>.',
    );
    return 1;
  }

  let source = from;
  let temp = null;
  if (/^(https?:|git@|ssh:)/.test(from)) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-template-'));
    const clone = git(
      temp,
      'clone',
      '-q',
      '--depth',
      '50',
      ...(o.ref ? ['--branch', o.ref] : []),
      from,
      'template',
    );
    if (clone.status !== 0) {
      console.error(`sync-template: could not clone ${from}: ${clone.stderr.trim()}`);
      fs.rmSync(temp, { recursive: true, force: true });
      return 1;
    }
    source = path.join(temp, 'template');
  } else {
    source = path.resolve(from);
    if (o.ref)
      console.error(
        'sync-template: --ref is only used with a git URL; a folder is taken as it is.',
      );
  }
  if (path.resolve(source) === project) {
    console.error('sync-template: the template and the project are the same folder.');
    return 1;
  }

  try {
    const r = sync(project, source, {
      dry: o.dry,
      force: o.force,
      label: from,
      fetchMissing: !!temp,
    });
    if (!r.ok) {
      for (const line of r.problems) console.error(`sync-template: ${line}`);
      return 1;
    }
    if (!o.dry && (r.write.length || r.remove.length)) {
      console.log(
        `\nDone. Before you commit:\n  node loop/run.mjs --dry-run      the preflight still accepts the project\n  the test:loop script             the runner's own suite\nThen commit on a branch and open a pull request into the base branch. The loop must not be running.`,
      );
    }
    return 0;
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
