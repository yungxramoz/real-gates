#!/usr/bin/env node
/**
 * ac-trace — every acceptance criterion has a contract and a test that names it.
 *
 *   node scripts/ac-trace.mjs [--no-contracts] [--root <dir>]
 *
 * 1. Reads the AC IDs from `docs/REQUIREMENTS.md`: `AC-<digits>.<digits>` at the start of a list
 *    item or a heading (`- AC-1.2 …`, `1. **AC-1.2** …`, `### AC-1.2 …`). An ID elsewhere in the
 *    prose is a reference, not a definition.
 * 2. Checks each one appears in at least one contract (`.loop/contracts/*.md` or
 *    `docs/contracts/*.md`). `--no-contracts` skips this half, for a project the loop has not run
 *    on yet.
 * 3. Checks each one appears in at least one test *title* under `tests/` (`test('AC-1.2 …')`,
 *    `it(…)`, `describe(…)`). A comment that names an AC proves nothing, so comments do not count.
 *
 * Prints every AC with no test (and with no contract), and exits 1 on any gap. A requirements file
 * with no AC IDs at all is a gap too: a gate that matches nothing proves nothing.
 *
 * Node built-ins only, so it runs before `pnpm install`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const USAGE = 'usage: node scripts/ac-trace.mjs [--no-contracts] [--root <dir>]';

const AC_DEFINITION =
  /^\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(?:\*\*|__|`)?(AC-\d+\.\d+)(?!\.?\d)/;
// `AC-1.1` must not match inside `AC-1.10` or `AC-1.1.2`; a sentence-ending dot is fine.
const AC_ANYWHERE = /(?<![\w.-])AC-\d+\.\d+(?!\.?\d)/g;
const TEST_TITLE =
  /\b(?:test|it|describe)(?:\.[A-Za-z]+)*\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
const TEST_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'coverage', 'artifacts']);
const CONTRACT_DIRS = ['.loop/contracts', 'docs/contracts'];

function parseArgs(argv) {
  const options = { contracts: true, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-contracts') options.contracts = false;
    else if (arg === '--root' && argv[i + 1] !== undefined) options.root = resolve(argv[++i]);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

class UsageError extends Error {}

/**
 * AC IDs defined in the requirements, in document order, without duplicates. HTML comments and
 * fenced code blocks are examples, not definitions, so they are skipped.
 */
function definedAcs(markdown) {
  const ids = [];
  let fenced = false;
  const visible = markdown.replace(/<!--[\s\S]*?-->/g, '');
  for (const line of visible.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = AC_DEFINITION.exec(line);
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** Every AC ID that appears in a test title in `source`. */
function acsInTestTitles(source) {
  const ids = new Set();
  for (const title of source.matchAll(TEST_TITLE)) {
    for (const id of title[2].matchAll(AC_ANYWHERE)) ids.add(id[0]);
  }
  return ids;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

function contractFiles(root) {
  const files = [];
  for (const dir of CONTRACT_DIRS) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(full, entry.name));
    }
  }
  return files;
}

function trace({ root, contracts }) {
  const requirementsPath = join(root, 'docs', 'REQUIREMENTS.md');
  if (!existsSync(requirementsPath)) {
    return { error: `docs/REQUIREMENTS.md not found under ${root}` };
  }
  const acs = definedAcs(readFileSync(requirementsPath, 'utf8'));

  const tested = new Set();
  for (const file of walk(join(root, 'tests'))) {
    if (!TEST_FILE.test(file)) continue;
    for (const id of acsInTestTitles(readFileSync(file, 'utf8'))) tested.add(id);
  }

  const contracted = new Set();
  const contractPaths = contracts ? contractFiles(root) : [];
  for (const file of contractPaths) {
    for (const id of readFileSync(file, 'utf8').matchAll(AC_ANYWHERE)) contracted.add(id[0]);
  }

  return {
    acs,
    noTest: acs.filter((id) => !tested.has(id)),
    noContract: contracts ? acs.filter((id) => !contracted.has(id)) : [],
    unknownInTests: [...tested].filter((id) => !acs.includes(id)).sort(),
    contractCount: contractPaths.length,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ac-trace: ${error.message}\n${USAGE}`);
    process.exit(2);
  }

  const result = trace(options);
  if (result.error) {
    console.error(`ac-trace: ${result.error}`);
    process.exit(1);
  }

  const where = relative(process.cwd(), options.root) || '.';
  if (result.acs.length === 0) {
    console.error(
      `ac-trace: no AC IDs found in ${join(where, 'docs/REQUIREMENTS.md')}. Define each ` +
        'criterion at the start of a list item or heading, e.g. "- AC-1.1 The visitor sees …".',
    );
    process.exit(1);
  }

  for (const id of result.unknownInTests) {
    console.warn(`ac-trace: warning: ${id} is named in a test title but not in REQUIREMENTS.md`);
  }
  for (const id of result.noTest)
    console.error(`ac-trace: ${id} has no test (no test title names it)`);
  for (const id of result.noContract) {
    console.error(`ac-trace: ${id} has no contract (.loop/contracts or docs/contracts)`);
  }

  const gaps = result.noTest.length + result.noContract.length;
  const scope = options.contracts
    ? `tests and ${result.contractCount} contract file(s)`
    : 'tests (contracts skipped)';
  if (gaps > 0) {
    console.error(
      `ac-trace: FAIL — ${gaps} gap(s) across ${result.acs.length} AC(s), checked ${scope}`,
    );
    process.exit(1);
  }
  console.log(`ac-trace: OK — ${result.acs.length} AC(s) traced to ${scope}`);
}

main();
