#!/usr/bin/env node
// Validator for /shape-project: can the loop build from loop/backlog.json as written?
//
// Shape: { milestones: string[], items: [{ id, milestone, title, refs: string[], scope, dependsOn: string[],
// and either type: string (a work type of the profile) or ui: boolean }] }. It also checks that ids are unique, every milestone is known and has
// items, dependsOn resolves without cycles or forward references to a later milestone, every AC ID
// (AC-<n>.<n>) mentioned exists in docs/REQUIREMENTS.md exactly once, and every file ref resolves,
// including a #heading anchor in a markdown file.
//
// Once the backlog holds more than the setup item, it also checks docs/BRIEF.md: the sections
// "What success looks like" and "Terms" must say something. A build session reads the brief
// first; without a success measure and without defined terms it guesses what "done" and what
// each number means.
//
// Usage: node check-backlog.mjs [--root <repo dir>] [--backlog <file>] [--requirements <file>] [--brief <file>]
// Exit 0 when clean, 1 with every problem named.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node check-backlog.mjs [--root <repo dir>] [--backlog <file>] [--requirements <file>] [--brief <file>]

Checks loop/backlog.json against docs/REQUIREMENTS.md:
  - shape: milestones[] and items[] with id, milestone, title, refs[], scope, dependsOn[], and type (string) or ui (boolean)
  - unique item ids, known milestones, no empty milestone
  - dependsOn resolves, has no cycles, never points at a later milestone
  - every AC ID (AC-<n>.<n>) in refs, title or scope is defined in REQUIREMENTS.md, and defined once
  - every file ref exists (a "#heading" anchor in a .md file must match a heading)
  - once there are items beyond the setup item: docs/BRIEF.md has a success measure and its terms

  --root <dir>           repo root (default: nearest folder above the current one with loop/backlog.json)
  --backlog <file>       backlog file (default: <root>/loop/backlog.json)
  --requirements <file>  requirements file (default: <root>/docs/REQUIREMENTS.md)
  --brief <file>         brief (default: <root>/docs/BRIEF.md; not checked with --backlog unless given)

File refs resolve against the repo root. Exit code 0 when clean, 1 with named problems.`;

const AC_RE = /\bAC-\d+\.\d+\b/g;
// An AC is *defined* where its ID opens a list item, a heading or a table row.
const AC_DEF_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|\|\s*)(?:\*\*|__)?(AC-\d+\.\d+)\b/gm;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ITEM_KEYS = { id: 'string', milestone: 'string', title: 'string', refs: 'array', scope: 'string', dependsOn: 'array' };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (['--root', '--backlog', '--requirements', '--brief'].includes(a)) {
      if (!argv[i + 1]) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument "${a}" (see --help)`);
  }
  return args;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'loop', 'backlog.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** GitHub-style heading anchors of a markdown text. */
export function headingSlugs(md) {
  const seen = new Map();
  const slugs = new Set();
  const text = md.replace(/\r\n?/g, '\n').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/[*_`]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    slugs.add(n ? `${base}-${n}` : base);
  }
  return slugs;
}

/** Sections of the brief a build session cannot work without, by heading. */
export const BRIEF_SECTIONS = [
  { heading: 'What success looks like', why: 'say how the owner will know it works: one observable result with a number' },
  { heading: 'Terms', why: 'define every noun that carries a number, and give every list taken from a source in full' },
];

/** The text under a `## heading`, up to the next heading of the same or a higher level, without comments. */
export function sectionText(md, heading) {
  const lines = String(md ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Does a section say something? A table's header row and its rule are layout, not content. */
function written(text) {
  const lines = text.split(/\r?\n/);
  const rule = (l) => /^\s*\|?\s*:?-{3,}/.test(l || '');
  const content = lines.filter((l, i) => !rule(l) && !rule(lines[i + 1]));
  return /[\p{L}\p{N}]/u.test(content.join('\n'));
}

/**
 * What the brief still lacks. A section counts as written when it has words that are not table
 * rules or empty table cells. Only asked once the backlog holds more than the setup item.
 */
export function briefProblems(briefText, backlog) {
  // a backlog whose items are not a list is backlogProblems' to report, not a crash here
  const real = (Array.isArray(backlog?.items) ? backlog.items : []).filter((i) => i && i.id !== 'LOOP-0');
  if (!real.length) return [];
  if (briefText === null) return ['docs/BRIEF.md not found; the build sessions read it first'];
  const p = [];
  for (const { heading, why } of BRIEF_SECTIONS) {
    const text = sectionText(briefText, heading);
    if (text === null) p.push(`docs/BRIEF.md has no "## ${heading}" section: ${why}`);
    else if (!written(text)) p.push(`docs/BRIEF.md: "## ${heading}" is empty: ${why}`);
  }
  return p;
}

/** Problems of a parsed backlog, given the requirements text and a file resolver. */
export function backlogProblems(backlog, requirementsText, { exists, read } = {}) {
  const p = [];
  const done = () => ({ problems: p, defined: new Set(), referenced: new Set() });
  if (!backlog || typeof backlog !== 'object' || Array.isArray(backlog)) {
    p.push('the backlog is not a JSON object');
    return done();
  }

  const milestones = backlog.milestones;
  if (!Array.isArray(milestones) || !milestones.length) p.push('"milestones" must be a non-empty list of milestone names');
  const msList = Array.isArray(milestones) ? milestones : [];
  msList.forEach((m, i) => {
    if (typeof m !== 'string' || !m.trim()) p.push(`milestones[${i}] must be a non-empty string`);
  });
  const dupMs = msList.filter((m, i) => msList.indexOf(m) !== i);
  for (const m of new Set(dupMs)) p.push(`milestone "${m}" is listed twice`);

  const items = backlog.items;
  if (!Array.isArray(items) || !items.length) {
    p.push('"items" must be a non-empty list');
    return done();
  }

  const ids = new Map();
  items.forEach((item, i) => {
    const label = `items[${i}]${item && typeof item.id === 'string' ? ` (${item.id})` : ''}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      p.push(`${label} is not an object`);
      return;
    }
    for (const [key, type] of Object.entries(ITEM_KEYS)) {
      const v = item[key];
      const good = type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === type;
      if (!good) p.push(`${label}: "${key}" must be ${type === 'array' ? 'a list of strings' : `a ${type}`}`);
      else if (type === 'string' && !v.trim()) p.push(`${label}: "${key}" is empty`);
    }
    // The work type: `type` names one of the profile's (the dry run checks the name), or the older `ui` flag.
    if (item.type !== undefined ? typeof item.type !== 'string' || !item.type.trim() : typeof item.ui !== 'boolean') p.push(`${label}: needs "type" (a work type of the profile, e.g. "command") or "ui" (true or false)`);
    if (typeof item.id === 'string') {
      if (!ID_RE.test(item.id)) p.push(`${label}: id "${item.id}" may only use letters, digits, ".", "_" and "-"`);
      if (ids.has(item.id)) p.push(`item id "${item.id}" is used twice (items[${ids.get(item.id)}] and items[${i}])`);
      else ids.set(item.id, i);
    }
    if (typeof item.milestone === 'string' && msList.length && !msList.includes(item.milestone)) {
      p.push(`${label}: milestone "${item.milestone}" is not in "milestones" (${msList.join(', ')})`);
    }
    if (Array.isArray(item.refs) && !item.refs.length) p.push(`${label}: "refs" is empty; point the item at the docs it builds`);
  });

  for (const m of msList) {
    if (typeof m === 'string' && !items.some((it) => it?.milestone === m)) p.push(`milestone "${m}" has no items`);
  }

  // Dependencies.
  const all = items.filter((it) => it && typeof it === 'object' && typeof it.id === 'string');
  const byId = new Map();
  for (const it of all) if (!byId.has(it.id)) byId.set(it.id, it); // a duplicate id is already named
  const depsOf = (it) => (Array.isArray(it.dependsOn) ? it.dependsOn : []);
  for (const it of all) {
    for (const dep of depsOf(it)) {
      if (dep === it.id) p.push(`${it.id} depends on itself`);
      else if (!byId.has(dep)) p.push(`${it.id} depends on "${dep}", which is not an item`);
      else if (msList.indexOf(byId.get(dep).milestone) > msList.indexOf(it.milestone)) {
        p.push(`${it.id} (${it.milestone}) depends on ${dep} in the later milestone ${byId.get(dep).milestone}`);
      }
    }
  }
  const state = new Map(); // undefined = unvisited, 1 = on the stack, 2 = done
  const reported = new Set();
  const visit = (id, stack) => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of depsOf(byId.get(id))) {
      if (!byId.has(dep) || dep === id) continue;
      if (state.get(dep) === 1) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          p.push(`dependency cycle: ${cycle.join(' -> ')}`);
        }
      } else if (!state.get(dep)) visit(dep, stack);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of byId.keys()) if (!state.get(id)) visit(id, []);

  // Acceptance criteria.
  const defs = [...String(requirementsText ?? '').matchAll(AC_DEF_RE)].map((m) => m[1]);
  const defined = new Set(defs);
  for (const ac of new Set(defs.filter((d, i) => defs.indexOf(d) !== i))) p.push(`REQUIREMENTS.md defines ${ac} more than once`);
  const referenced = new Set();
  for (const it of all) {
    const text = [it.title, it.scope, ...(Array.isArray(it.refs) ? it.refs : [])].filter((x) => typeof x === 'string').join('\n');
    for (const ac of new Set(text.match(AC_RE) || [])) {
      referenced.add(ac);
      if (!defined.has(ac)) p.push(`${it.id} mentions ${ac}, which REQUIREMENTS.md does not define`);
    }
  }

  // File refs: "path", "path#anchor", optionally followed by a note in parentheses.
  for (const it of all) {
    for (const ref of Array.isArray(it.refs) ? it.refs : []) {
      const r = ref.trim();
      if (/^AC-\d+\.\d+$/.test(r)) continue;
      const m = r.match(/^(\S+?)(?:#(\S+))?(?:\s+\(.*\))?$/);
      if (!m || !(m[1].includes('/') || /\.[a-z][a-z0-9]*$/i.test(m[1]))) {
        p.push(`${it.id}: ref "${ref}" is neither an AC ID (AC-<n>.<n>) nor a file path`);
        continue;
      }
      const [, file, anchor] = m;
      if (!exists?.(file)) {
        p.push(`${it.id}: ref "${ref}" points at ${file}, which does not exist`);
        continue;
      }
      if (anchor && file.endsWith('.md') && !headingSlugs(read(file)).has(anchor.toLowerCase())) {
        p.push(`${it.id}: ref "${ref}" has no heading "#${anchor}" in ${file}`);
      }
    }
  }
  return { problems: p, defined, referenced };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`check-backlog: ${e.message}`);
    return 1;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : args.backlog ? process.cwd() : findRoot(process.cwd());
  if (!root) {
    console.error('check-backlog: no loop/backlog.json found here or in any parent folder; run this from the repo (or pass --backlog)');
    return 1;
  }
  const backlogFile = path.resolve(root, args.backlog || path.join('loop', 'backlog.json'));
  const reqFile = path.resolve(root, args.requirements || path.join('docs', 'REQUIREMENTS.md'));

  let backlog;
  try {
    backlog = JSON.parse(fs.readFileSync(backlogFile, 'utf8'));
  } catch (e) {
    console.error(`check-backlog: cannot read ${backlogFile}: ${e.code === 'ENOENT' ? 'file not found' : e.message}`);
    return 1;
  }
  let requirements = '';
  const pre = [];
  try {
    requirements = fs.readFileSync(reqFile, 'utf8');
  } catch {
    pre.push(`${path.relative(root, reqFile) || reqFile} not found; acceptance criteria cannot be checked`);
  }

  // With --requirements, refs to docs/REQUIREMENTS.md mean that file (e.g. a sample checked in place).
  const defaultReq = path.resolve(root, 'docs', 'REQUIREMENTS.md');
  const resolve = (f) => {
    const abs = path.resolve(root, f);
    return args.requirements && abs === defaultReq ? reqFile : abs;
  };
  const result = backlogProblems(backlog, requirements, {
    exists: (f) => fs.existsSync(resolve(f)),
    read: (f) => fs.readFileSync(resolve(f), 'utf8'),
  });
  // The brief belongs to the repo's own backlog. A sample checked with --backlog has none, unless one is named.
  let brief = [];
  if (args.brief || !args.backlog) {
    const briefFile = path.resolve(root, args.brief || path.join('docs', 'BRIEF.md'));
    brief = briefProblems(fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : null, backlog);
  }
  const problems = [...pre, ...result.problems, ...brief];

  const unreferenced = [...result.defined].filter((ac) => !result.referenced.has(ac));
  console.log(`check-backlog: ${backlog?.items?.length ?? 0} item(s), ${backlog?.milestones?.length ?? 0} milestone(s), ${result.defined.size} AC(s) in REQUIREMENTS.md`);
  if (unreferenced.length) {
    console.log(`note: ${unreferenced.length} AC(s) are not named by any item (fine when an item refs their section): ${unreferenced.join(', ')}`);
  }
  if (problems.length) {
    console.log(`\ncheck-backlog: ${problems.length} problem(s)`);
    for (const line of problems) console.log(`PROBLEM  ${line}`);
    return 1;
  }
  console.log('check-backlog: OK');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`check-backlog: unexpected error: ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
