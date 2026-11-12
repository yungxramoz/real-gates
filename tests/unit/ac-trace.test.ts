import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * AC-0.1 — `scripts/ac-trace.mjs`, run as CI runs it: a real process against a throwaway tree.
 * It passes only when every defined AC is named in a test title (and in a contract, unless
 * `--no-contracts`), prints every gap by ID, and fails closed on a file it cannot use.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/ac-trace.mjs', import.meta.url));
const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-trace-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/**
 * Fixture test files are assembled with `spec()`, so this file's own source never holds a test
 * title with a fixture ID in it. Otherwise the repo's real `pnpm ac-trace` would read the
 * fixtures as tests, and a fixture could satisfy a real AC.
 */
function spec(fn: string, title: string, quote = "'"): string {
  return `${fn}(${quote}${title}${quote}, () => {});\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REQUIREMENTS = [
  '# Requirements',
  '',
  '<!-- Example only:',
  '- AC-9.9 never counts -->',
  '',
  '### AC-1.1 Heading form',
  '- AC-1.2 List item form',
  '1. **AC-1.3** Numbered and bold',
  '- [ ] AC-1.10 Checkbox form',
  '',
  'Prose that mentions AC-7.7 is a reference, not a definition.',
  '',
  '```md',
  '- AC-8.8 inside a fence',
  '```',
].join('\n');

const ALL_TESTED = [
  "import { test } from '@playwright/test';\n",
  spec('test', 'AC-1.1 heading'),
  spec('test.describe', 'AC-1.2 and AC-1.3 together', '"'),
  spec('it', 'AC-1.10 template literal', '`'),
].join('');

describe('ac-trace', () => {
  it('AC-0.1 passes when every AC is in a test title, contracts skipped', () => {
    const root = tree({ 'docs/REQUIREMENTS.md': REQUIREMENTS, 'tests/e2e/a.spec.ts': ALL_TESTED });
    const { code, out } = run(root, '--no-contracts');
    expect(out).toContain('ac-trace: OK — 4 AC(s) traced to tests (contracts skipped)');
    expect(code).toBe(0);
  });

  it('AC-0.1 reads definitions only from list items and headings outside comments and fences', () => {
    const root = tree({ 'docs/REQUIREMENTS.md': REQUIREMENTS, 'tests/e2e/a.spec.ts': '' });
    const { out } = run(root, '--no-contracts');
    expect(out).toContain('FAIL — 4 gap(s) across 4 AC(s)');
    expect(out).not.toMatch(/AC-(9\.9|7\.7|8\.8) has no test/);
  });

  it('AC-0.1 prints each AC with no test and exits 1', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': REQUIREMENTS,
      'tests/unit/a.test.ts': spec('it', 'AC-1.1 only this one'),
    });
    const { code, out } = run(root, '--no-contracts');
    expect(code).toBe(1);
    expect(out).toContain('AC-1.2 has no test');
    expect(out).toContain('AC-1.3 has no test');
    expect(out).toContain('AC-1.10 has no test');
    expect(out).not.toContain('AC-1.1 has no test');
    expect(out).toContain('FAIL — 3 gap(s) across 4 AC(s)');
  });

  it('AC-0.1 a comment naming an AC is not a test', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-2.1 Something',
      'tests/unit/a.test.ts': `// AC-2.1 is covered below\n${spec('it', 'renders')}`,
    });
    const { code, out } = run(root, '--no-contracts');
    expect(code).toBe(1);
    expect(out).toContain('AC-2.1 has no test');
  });

  it('AC-0.1 an ID does not match a longer ID that starts with it', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-1.1 One\n- AC-1.10 Ten',
      'tests/unit/a.test.ts': spec('it', 'AC-1.10 ten'),
    });
    const { code, out } = run(root, '--no-contracts');
    expect(code).toBe(1);
    expect(out).toContain('AC-1.1 has no test');
    expect(out).not.toContain('AC-1.10 has no test');
  });

  it('AC-0.1 with contracts, an AC missing from every contract is a gap', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-3.1 One\n- AC-3.2 Two',
      'tests/unit/a.test.ts': spec('it', 'AC-3.1 one') + spec('it', 'AC-3.2 two'),
      '.loop/contracts/ITEM-1.md': '# Contract\n- AC-3.1 is proven by the unit test.',
    });
    const { code, out } = run(root, '--all');
    expect(code).toBe(1);
    expect(out).toContain('AC-3.2 has no contract');
    expect(out).not.toContain('AC-3.1 has no contract');
  });

  it('AC-0.1 with contracts in docs/contracts and .loop/contracts, a full trace passes', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-3.1 One\n- AC-3.2 Two',
      'tests/unit/a.test.ts': spec('it', 'AC-3.1 one') + spec('it', 'AC-3.2 two'),
      '.loop/contracts/ITEM-1.md': 'Covers AC-3.1.',
      'docs/contracts/ITEM-2.md': 'Covers AC-3.2.',
    });
    const { code, out } = run(root, '--all');
    expect(out).toContain('OK — 2 AC(s) traced to tests and 2 contract file(s)');
    expect(code).toBe(0);
  });

  it('AC-0.1 by default only the ACs a contract names are due; the rest are pending', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-3.1 One\n- AC-3.2 Two\n- AC-3.3 Three',
      'tests/unit/a.test.ts': spec('it', 'AC-3.1 one'),
      'docs/contracts/ITEM-1.md': 'Covers AC-3.1.',
    });
    const { code, out } = run(root);
    expect(out).toContain('2 AC(s) pending (no contract names them yet): AC-3.2, AC-3.3');
    expect(out).toContain('OK — 1 built AC(s) traced to tests and 1 contract file(s), 2 pending');
    expect(code).toBe(0);
  });

  it('AC-0.1 by default a built AC with no test is a gap', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-3.1 One\n- AC-3.2 Two',
      'tests/unit/a.test.ts': spec('it', 'AC-3.1 one'),
      'docs/contracts/ITEM-1.md': 'Covers AC-3.1 and AC-3.2.',
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('AC-3.2 has no test');
    expect(out).toContain('FAIL — 1 gap(s) across 2 AC(s)');
  });

  it('AC-0.1 a skipped, todo, fixme, expected-to-fail or x-prefixed test is not a test', () => {
    const titles = [
      spec('test.skip', 'AC-5.1 skipped'),
      spec('it.todo', 'AC-5.2 todo'),
      spec('test.fixme', 'AC-5.3 fixme'),
      spec('describe.skip', 'AC-5.4 group'),
      spec('xit', 'AC-5.5 x'),
      spec('it.fails', 'AC-5.6 fails'),
      spec('test.only', 'AC-5.7 runs'),
    ].join('');
    const root = tree({
      'docs/REQUIREMENTS.md': [1, 2, 3, 4, 5, 6, 7].map((n) => `- AC-5.${n} x`).join('\n'),
      'tests/unit/a.test.ts': titles,
    });
    const { code, out } = run(root, '--no-contracts');
    expect(code).toBe(1);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(out).toContain(`AC-5.${n} has no test (only a skipped, todo or expected-to-fail test`);
    }
    expect(out).not.toContain('AC-5.7 has no test');
    expect(out).toContain('FAIL — 6 gap(s) across 7 AC(s)');
  });

  it('AC-0.1 warns about an AC in a test title that the requirements do not define', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-4.1 One',
      'tests/unit/a.test.ts': spec('it', 'AC-4.1 one') + spec('it', 'AC-4.9 typo'),
    });
    const { code, out } = run(root, '--no-contracts');
    expect(code).toBe(0);
    expect(out).toContain('warning: AC-4.9 is named in a test title but not in REQUIREMENTS.md');
  });

  it('AC-0.1 fails closed on a missing requirements file or one with no AC IDs', () => {
    expect(run(tree({ 'tests/a.test.ts': '' }), '--no-contracts')).toMatchObject({ code: 1 });
    const empty = run(tree({ 'docs/REQUIREMENTS.md': '# Nothing yet' }), '--no-contracts');
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('no AC IDs found');
  });

  it('AC-0.1 with --results, a built AC needs a test case that ran and passed', () => {
    const testcase = (name: string, body = '') =>
      `<testcase classname="tests/unit/a.test.ts" name="${name}" time="0.01">${body}</testcase>`;
    const report = (...cases: string[]) =>
      `<?xml version="1.0"?><testsuites><testsuite name="a">${cases.join('')}</testsuite></testsuites>`;
    const files = {
      'docs/REQUIREMENTS.md': [1, 2, 3, 4].map((n) => `- AC-6.${n} x`).join('\n'),
      'docs/contracts/ITEM-1.md': 'Covers AC-6.1, AC-6.2, AC-6.3 and AC-6.4.',
      // every title is live in the source: only the reports show what really ran
      'tests/unit/a.test.ts': [1, 2, 3, 4].map((n) => spec('it', `AC-6.${n} t`)).join(''),
    };
    const root = tree({
      ...files,
      'artifacts/junit/unit.xml': report(
        testcase('group &gt; AC-6.1 t'),
        testcase('AC-6.2 t', '<skipped/>'),
        testcase('AC-6.3 t', '<failure message="boom">x</failure>'),
      ),
    });
    const { code, out } = run(root, '--results', 'artifacts/junit');
    expect(code).toBe(1);
    for (const n of [2, 3, 4]) expect(out).toContain(`AC-6.${n} has no passing test`);
    expect(out).not.toContain('AC-6.1 has no');
    expect(out).toContain('FAIL — 3 gap(s) across 4 AC(s)');

    const green = tree({
      ...files,
      'artifacts/junit/unit.xml': report(testcase('AC-6.1 t'), testcase('AC-6.2 t')),
      'artifacts/junit/e2e.xml': report(
        '<testcase name="journey" classname="AC-6.3 and AC-6.4 group"/>',
      ),
    });
    const ok = run(green, '--results', 'artifacts/junit');
    expect(ok.out).toContain(
      '4 built AC(s) traced to tests and 1 contract file(s), 3 test case(s) in 2 report(s)',
    );
    expect(ok.code).toBe(0);
  });

  it('AC-0.1 with --results, an AC in the title of a group counts for the tests that passed inside it', () => {
    // `node --test` writes one <testsuite> per describe and leaves the group title off the cases
    const xml = [
      '<?xml version="1.0"?><testsuites>',
      '<testsuite name="AC-7.1 outer group"><testsuite name="inner &amp; AC-7.2">',
      '<testcase name="works" classname="test"/>',
      '</testsuite><testcase name="also works" classname="test"/></testsuite>',
      '<testsuite name="AC-7.3 skipped group"><testcase name="never ran" classname="test"><skipped/></testcase></testsuite>',
      '<testsuite name="AC-7.4 empty group"/>',
      '<testcase name="outside every group" classname="test"/>',
      '</testsuites>',
    ].join('');
    const root = tree({
      'docs/REQUIREMENTS.md': [1, 2, 3, 4].map((n) => `- AC-7.${n} x`).join('\n'),
      'tests/unit/a.test.ts': [1, 2, 3, 4].map((n) => spec('describe', `AC-7.${n} group`)).join(''),
      'artifacts/junit/unit.xml': xml,
    });
    const { code, out } = run(root, '--no-contracts', '--results', 'artifacts/junit');
    expect(out).not.toMatch(/AC-7\.[12] has no/);
    expect(out).toContain('AC-7.3 has no passing test');
    expect(out).toContain('AC-7.4 has no passing test');
    expect(out).toContain('FAIL — 2 gap(s) across 4 AC(s)');
    expect(code).toBe(1);
  });

  it('AC-0.1 with --results, no report is a failure, not a pass', () => {
    const root = tree({
      'docs/REQUIREMENTS.md': '- AC-6.1 x',
      'tests/unit/a.test.ts': spec('it', 'AC-6.1 t'),
    });
    const { code, out } = run(root, '--results', 'artifacts/junit');
    expect(code).toBe(1);
    expect(out).toContain('no test case found in the JUnit reports under artifacts/junit');
  });

  it('AC-0.1 refuses an unknown argument', () => {
    const { code, out } = run(tree({ 'docs/REQUIREMENTS.md': '- AC-1.1 x' }), '--bogus');
    expect(code).toBe(2);
    expect(out).toContain('unknown argument: --bogus');
  });
});
