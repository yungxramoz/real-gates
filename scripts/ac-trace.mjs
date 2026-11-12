#!/usr/bin/env node
/**
 * ac-trace — every acceptance criterion has a contract and a test that names it.
 *
 *   node scripts/ac-trace.mjs [--all] [--no-contracts] [--results <dir>] [--root <dir>]
 *
 * 1. Reads the AC IDs from `docs/REQUIREMENTS.md`: `AC-<digits>.<digits>` at the start of a list
 *    item or a heading (`- AC-1.2 …`, `1. **AC-1.2** …`, `### AC-1.2 …`). An ID elsewhere in the
 *    prose is a reference, not a definition.
 * 2. An AC is **built** once a contract names it (`docs/contracts/*.md` or `.loop/contracts/*.md`,
 *    committed with the PR that builds it; the runner refuses a PR whose contract leaves out one of
 *    its item's ACs). Every built AC must appear in at least one test *title* under `tests/`
 *    (`test('AC-1.2 …')`, `it(…)`, `describe(…)`). A comment that names an AC proves nothing.
 * 3. A test that does not run proves nothing either: `test.skip`, `.todo`, `.fixme`, `.fails`,
 *    `xit`, `xtest` and `xdescribe` titles do not count.
 * 4. An AC no contract names yet is **pending**: listed, not a failure. The requirements are written
 *    before the first item is built, so a gate that demanded every test on day one could only be
 *    passed with placeholder tests.
 *
 * 5. With `--results <dir>` (CI), a title is not enough: every built AC must also be named by a
 *    test case that **ran and passed** in the JUnit reports under that folder (`*.xml`, any
 *    runner that writes JUnit). That also catches what a title scan cannot see: a test inside a
 *    skipped group, a conditional skip, a file the runner never collected. No report is a failure.
 *
 * `--all` is the release check: every AC must be in a contract and in a live test title.
 * `--no-contracts` is `--all` without the contract half (every AC needs a live test).
 *
 * Exits 1 on any gap. A requirements file with no AC IDs at all is a gap too: a gate that matches
 * nothing proves nothing.
 *
 * Node built-ins only, so it runs before `pnpm install`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const USAGE =
  'usage: node scripts/ac-trace.mjs [--all] [--no-contracts] [--results <dir>] [--root <dir>]';

const AC_DEFINITION =
  /^\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(?:\*\*|__|`)?(AC-\d+\.\d+)(?!\.?\d)/;
// `AC-1.1` must not match inside `AC-1.10` or `AC-1.1.2`; a sentence-ending dot is fine.
const AC_ANYWHERE = /(?<![\w.-])AC-\d+\.\d+(?!\.?\d)/g;
const TEST_TITLE =
  /\b(x?)(?:test|it|describe)((?:\.[A-Za-z]+)*)\s*\(\s*(['"`])((?:\\[\s\S]|(?!\3)[^\\])*)\3/g;
// Modifiers under which the test body does not run, or is expected to fail.
const NOT_RUN = /\.(?:skip|todo|fixme|fails)\b/;
const TEST_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'coverage', 'artifacts']);
const CONTRACT_DIRS = ['.loop/contracts', 'docs/contracts'];

function parseArgs(argv) {
  const options = { contracts: true, all: false, results: null, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-contracts') options.contracts = false;
    else if (arg === '--all') options.all = true;
    else if (arg === '--root' && argv[i + 1] !== undefined) options.root = resolve(argv[++i]);
    else if (arg === '--results' && argv[i + 1] !== undefined) options.results = argv[++i];
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

/** AC IDs in the test titles of `source`: `live` from tests that run, `skipped` from ones that do not. */
function acsInTestTitles(source) {
  const live = new Set();
  const skipped = new Set();
  for (const title of source.matchAll(TEST_TITLE)) {
    const into = title[1] || NOT_RUN.test(title[2]) ? skipped : live;
    for (const id of title[4].matchAll(AC_ANYWHERE)) into.add(id[0]);
  }
  return { live, skipped };
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

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (whole, dec, hex, name) =>
    dec
      ? String.fromCodePoint(Number(dec))
      : hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : (XML_ENTITIES[name] ?? whole),
  );

/**
 * AC IDs by outcome in one JUnit report. A test case passed when it has no `<failure>`, `<error>`
 * or `<skipped>` child. Its name and its class name both count: runners put the group titles in
 * either.
 */
function acsInJunit(xml) {
  const passed = new Set();
  const other = new Set();
  let cases = 0;
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    cases += 1;
    const attrs = match[1];
    const names = [...attrs.matchAll(/\b(?:name|classname)="([^"]*)"/g)].map((m) =>
      unescapeXml(m[1]),
    );
    const ok = !/<(?:failure|error|skipped)\b/.test(match[2] ?? '');
    for (const name of names) {
      for (const id of name.matchAll(AC_ANYWHERE)) (ok ? passed : other).add(id[0]);
    }
  }
  return { passed, other, cases };
}

/** Every JUnit report under `dir`: the ACs that passed, and how many reports and cases were read. */
function readResults(dir) {
  const passed = new Set();
  let files = 0;
  let cases = 0;
  for (const file of walk(dir)) {
    if (!file.endsWith('.xml')) continue;
    const found = acsInJunit(readFileSync(file, 'utf8'));
    files += 1;
    cases += found.cases;
    for (const id of found.passed) passed.add(id);
  }
  return { passed, files, cases };
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

function trace({ root, contracts, all, results }) {
  const requirementsPath = join(root, 'docs', 'REQUIREMENTS.md');
  if (!existsSync(requirementsPath)) {
    return { error: `docs/REQUIREMENTS.md not found under ${root}` };
  }
  const acs = definedAcs(readFileSync(requirementsPath, 'utf8'));

  const tested = new Set();
  const skipped = new Set();
  for (const file of walk(join(root, 'tests'))) {
    if (!TEST_FILE.test(file)) continue;
    const found = acsInTestTitles(readFileSync(file, 'utf8'));
    for (const id of found.live) tested.add(id);
    for (const id of found.skipped) skipped.add(id);
  }

  const contracted = new Set();
  const contractPaths = contracts ? contractFiles(root) : [];
  for (const file of contractPaths) {
    for (const id of readFileSync(file, 'utf8').matchAll(AC_ANYWHERE)) contracted.add(id[0]);
  }

  // Without --all (and with contracts in play), only the ACs a contract names are due.
  const strict = all || !contracts;
  const due = strict ? acs : acs.filter((id) => contracted.has(id));
  const ran = results ? readResults(resolve(root, results)) : null;
  if (ran && ran.cases === 0) {
    return {
      error: `no test case found in the JUnit reports under ${results} (${ran.files} file(s)): the tests must run before this check`,
    };
  }
  return {
    ran,
    notPassed: ran ? due.filter((id) => tested.has(id) && !ran.passed.has(id)) : [],
    acs,
    due,
    strict,
    pending: strict ? [] : acs.filter((id) => !contracted.has(id)),
    noTest: due.filter((id) => !tested.has(id)),
    onlySkipped: new Set(due.filter((id) => !tested.has(id) && skipped.has(id))),
    noContract: all && contracts ? acs.filter((id) => !contracted.has(id)) : [],
    unknownInTests: [...new Set([...tested, ...skipped])].filter((id) => !acs.includes(id)).sort(),
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
  for (const id of result.noTest) {
    console.error(
      result.onlySkipped.has(id)
        ? `ac-trace: ${id} has no test (only a skipped, todo or expected-to-fail test names it)`
        : `ac-trace: ${id} has no test (no test title names it)`,
    );
  }
  for (const id of result.notPassed) {
    console.error(
      `ac-trace: ${id} has no passing test (a test title names it, but no test case that ran and passed in the reports does)`,
    );
  }
  for (const id of result.noContract) {
    console.error(`ac-trace: ${id} has no contract (.loop/contracts or docs/contracts)`);
  }

  const gaps = result.noTest.length + result.noContract.length + result.notPassed.length;
  const scope =
    (options.contracts
      ? `tests and ${result.contractCount} contract file(s)`
      : 'tests (contracts skipped)') +
    (result.ran ? `, ${result.ran.cases} test case(s) in ${result.ran.files} report(s)` : '');
  if (result.pending.length) {
    console.log(
      `ac-trace: ${result.pending.length} AC(s) pending (no contract names them yet): ${result.pending.join(', ')}`,
    );
  }
  if (gaps > 0) {
    console.error(
      `ac-trace: FAIL — ${gaps} gap(s) across ${result.due.length} AC(s), checked ${scope}`,
    );
    process.exit(1);
  }
  console.log(
    result.strict
      ? `ac-trace: OK — ${result.acs.length} AC(s) traced to ${scope}`
      : `ac-trace: OK — ${result.due.length} built AC(s) traced to ${scope}, ${result.pending.length} pending`,
  );
}

main();
