#!/usr/bin/env node
/**
 * arch-check — the architecture pages say what the code is.
 *
 *   node scripts/arch-check.mjs [--root <dir>] [--blocks <pattern>,<pattern>]
 *
 * The pages in `docs/architecture/` are kept true by the pull request that changes the code. A
 * reviewer can judge whether what a page says is right; whether the page still matches the tree
 * is something a script can check, on every pull request and with nobody watching:
 *
 * 1. **Building blocks.** Every block in the code is named on the building-blocks page
 *    (`*building-blocks.md`). What a block is comes from `architecture.blocks` in the stack
 *    profile, a list of path patterns: `src/lib/*` is every file and folder in `src/lib`,
 *    the same pattern with a slash at the end only the folders. A block counts as named when the
 *    page has its path, or a path inside it, in backticks. Test files, type declarations and
 *    dotfiles are not blocks.
 * 2. **Paths.** Every repository path the building-blocks page names in backticks exists, spelled
 *    with the same capitals.
 * 3. **Decisions.** Every decision ID a page names (`D-012`) is a row in `docs/DECISIONS.md`.
 * 4. **Links.** Every relative link on a page leads to a file that exists.
 *
 * Text inside an HTML comment or a fenced code block is not read: a placeholder or a diagram
 * proves nothing either way.
 *
 * The patterns live in the profile (`loop/profiles/<name>/profile.json`) or in
 * `loop/loop.config.json`, which a loop session cannot edit, so the loop cannot shrink the check
 * to get past it. `--blocks` is for a tree without a loop config.
 *
 * Exits 1 on any problem, and when the pages are missing. Node built-ins only.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'usage: node scripts/arch-check.mjs [--root <dir>] [--blocks <pattern>,<pattern>]';
const PAGES = 'docs/architecture';
const DECISIONS = 'docs/DECISIONS.md';

/** One path segment: a name, or `*` for any one name. */
const SEGMENT = /^(?:\*|[\w.@()[\]+~-]+)$/;
/** What a backticked text must look like to be read as a repository path. */
const PATH_LIKE = /^[\w.@()[\]+~-]+(?:\/[\w.@()[\]+~-]+)*$/;
/**
 * A Markdown link, with its destination the way CommonMark reads one: in angle brackets (group 1,
 * spaces and parentheses allowed), or bare (group 2) with parentheses as long as they pair up.
 * A route group is such a path: `src/app/(auth)/page.tsx`.
 */
const LINK =
  /\[[^\]\n]*\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s]|\((?:[^()\s]|\([^()\s]*\))*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', '__snapshots__']);
const NOT_A_BLOCK = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.d\.[cm]?ts)$/;

class UsageError extends Error {}

/** Why a block pattern is not usable, or null. */
export function patternProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'is not a path pattern';
  const body = pattern.replace(/\/$/, '');
  if (pattern.startsWith('/') || /\\/.test(pattern))
    return 'must be a path from the repository root, with forward slashes';
  const segments = body.split('/');
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..'))
    return 'may only use names and `*` for one whole name (no `..`, no `**`)';
  if (!segments.includes('*'))
    return 'names one path and no `*`: a block pattern says "everything in this folder"';
  return null;
}

/** HTML comments and fenced code blocks, blanked: the line numbers stay as they were. */
function readable(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^([ \t]*)(```|~~~)[\s\S]*?^\1\2[ \t]*$/gm, blank);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Names in a folder, [] when it is not one. */
function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Does `rel` exist under `root`, spelled exactly like this? A plain existence check passes
 * `src/Lib` for `src/lib` on Windows and macOS and fails on the Linux runner.
 */
export function existsExactly(root, rel) {
  let dir = root;
  for (const segment of rel.split('/').filter(Boolean)) {
    if (segment === '.') continue;
    if (segment === '..') {
      dir = dirname(dir);
      continue;
    }
    if (!entries(dir).some((e) => e.name === segment)) return false;
    dir = join(dir, segment);
  }
  return true;
}

/** The blocks a pattern finds in the tree, as repository paths. */
export function blocksOf(root, pattern) {
  const foldersOnly = pattern.endsWith('/');
  const segments = pattern.replace(/\/$/, '').split('/');
  let paths = [''];
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    const next = [];
    for (const parent of paths) {
      for (const e of entries(join(root, parent))) {
        if (segment !== '*' && e.name !== segment) continue;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const isDir = e.isDirectory();
        if (!isDir && !e.isFile()) continue; // links and devices are not blocks
        if (!last && !isDir) continue;
        if (last && foldersOnly && !isDir) continue;
        if (last && !isDir && NOT_A_BLOCK.test(e.name)) continue;
        next.push(parent ? `${parent}/${e.name}` : e.name);
      }
    }
    paths = next;
  });
  return paths.sort();
}

/** The repository paths a page names in backticks: [{ path, line }]. */
export function namedPaths(text) {
  const clean = readable(text);
  const out = [];
  for (const m of clean.matchAll(/`([^`\n]+)`/g)) {
    const path = m[1].trim().replace(/#.*$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
    if (PATH_LIKE.test(path)) out.push({ path, line: lineOf(clean, m.index) });
  }
  return out;
}

/**
 * Checks the pages of the repository at `root` against its tree. `blocks`: the block patterns.
 * Returns { problems: [{ file, line?, text }], counts, notes }.
 */
export function checkArchitecture({ root, blocks = [] }) {
  const problems = [];
  const notes = [];
  const counts = { pages: 0, links: 0, decisions: 0, paths: 0, blocks: 0 };
  const dir = join(root, PAGES);
  const files = entries(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
  if (!files.length) {
    problems.push({
      file: PAGES,
      text: 'there are no architecture pages. The template ships seven; restore them (docs/architecture/README.md lists them).',
    });
    return { problems, counts, notes };
  }
  counts.pages = files.length;

  const decisionsText = existsSync(join(root, DECISIONS))
    ? readFileSync(join(root, DECISIONS), 'utf8')
    : '';
  const known = new Set(
    [...decisionsText.matchAll(/^(?:\|\s*|#{1,6}\s+(?:\S+\s+)*?)(D-\d+)\b/gm)].map((m) => m[1]),
  );

  for (const name of files) {
    const file = `${PAGES}/${name}`;
    const clean = readable(readFileSync(join(dir, name), 'utf8'));

    for (const m of clean.matchAll(LINK)) {
      const target = m[1] ?? m[2];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      counts.links++;
      let rel;
      try {
        rel = decodeURIComponent(target.replace(/[#?].*$/, ''));
      } catch {
        rel = target.replace(/[#?].*$/, '');
      }
      const full = rel.startsWith('/') ? rel.slice(1) : `${PAGES}/${rel}`;
      if (!existsExactly(root, full))
        problems.push({
          file,
          line: lineOf(clean, m.index),
          text: `the link \`${target}\` leads to no file. Correct it or remove it.`,
        });
    }

    const seen = new Set();
    for (const m of clean.matchAll(/(?<![\w-])D-\d+(?!\w)/g)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      counts.decisions++;
      if (!known.has(m[0]))
        problems.push({
          file,
          line: lineOf(clean, m.index),
          text: `${m[0]} is not a row in ${DECISIONS}. Name a decision that exists, or record this one there first.`,
        });
    }
  }

  const blockPage = files.find((f) => /building-blocks\.md$/i.test(f));
  if (!blockPage) {
    problems.push({
      file: PAGES,
      text: 'there is no building-blocks page (a file whose name ends in building-blocks.md).',
    });
    return { problems, counts, notes };
  }
  const file = `${PAGES}/${blockPage}`;
  const named = namedPaths(readFileSync(join(dir, blockPage), 'utf8'));

  // what the page names must exist; a text whose first name is nothing in the repository is not a path
  const reported = new Set();
  for (const { path, line } of named) {
    if (!path.includes('/') || !existsExactly(root, path.split('/')[0]) || reported.has(path))
      continue;
    counts.paths++;
    if (existsExactly(root, path)) continue;
    reported.add(path);
    problems.push({
      file,
      line,
      text: `\`${path}\` is named here and is not in the repository. Correct the path, or remove what is gone.`,
    });
  }

  // what the code has must be named
  const bad = blocks.filter((b) => patternProblem(b));
  for (const b of bad)
    problems.push({
      file: 'architecture.blocks',
      text: `the pattern ${JSON.stringify(b)} ${patternProblem(b)}.`,
    });
  const patterns = blocks.filter((b) => !patternProblem(b));
  if (!blocks.length)
    notes.push(
      'no building blocks are configured (architecture.blocks in the stack profile): the pages were checked for links, decisions and paths only.',
    );
  const names = new Set(named.map((n) => n.path));
  const inCode = [...new Set(patterns.flatMap((p) => blocksOf(root, p)))].sort();
  counts.blocks = inCode.length;
  for (const block of inCode) {
    const isNamed = [...names].some((n) => n === block || n.startsWith(`${block}/`));
    if (!isNamed)
      problems.push({
        file,
        text: `\`${block}\` is in the code and not on this page. Add its row to the table and its node to the diagram, in the pull request that adds the code.`,
      });
  }
  return { problems, counts, notes };
}

function parseArgs(argv) {
  const options = { root: process.cwd(), blocks: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1] !== undefined) options.root = resolve(argv[++i]);
    else if (arg === '--blocks' && argv[i + 1] !== undefined) {
      options.blocks = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

/** `architecture.blocks` of the repository's loop config: defaults, then the profile, then the project. */
async function configuredBlocks(root) {
  const config = join(root, 'loop', 'lib', 'config.mjs');
  if (!existsSync(config)) return [];
  const { loadConfig } = await import(pathToFileURL(config).href);
  const blocks = loadConfig(root).architecture?.blocks;
  if (blocks !== undefined && !Array.isArray(blocks))
    throw new Error('architecture.blocks must be a list of path patterns');
  return blocks || [];
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`arch-check: ${e.message}\n${USAGE}`);
    process.exit(2);
  }
  let blocks = options.blocks;
  if (!blocks) {
    try {
      blocks = await configuredBlocks(options.root);
    } catch (e) {
      // a gate that cannot read what it has to check has not passed
      console.error(`arch-check: could not read the loop config: ${e.message}`);
      process.exit(1);
    }
  }
  const { problems, counts, notes } = checkArchitecture({ root: options.root, blocks });
  for (const n of notes) console.log(`arch-check: ${n}`);
  for (const p of problems)
    console.error(`arch-check: ${p.file}${p.line ? `:${p.line}` : ''}: ${p.text}`);
  const scope = `${counts.pages} page(s), ${counts.blocks} building block(s), ${counts.paths} path(s), ${counts.decisions} decision ID(s), ${counts.links} link(s)`;
  if (problems.length) {
    console.error(
      `arch-check: FAIL — ${problems.length} problem(s) in ${scope}. The pages follow the code: fix the page, not the check.`,
    );
    process.exit(1);
  }
  console.log(`arch-check: OK — ${scope}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
