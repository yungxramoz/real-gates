// Tests for scripts/check-skills.mjs: one good skill set and three bad skills in a temp-dir fixture.
// Run: node --test scripts/check-skills.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkSkills, parseFrontmatter, HUMAN_SKILLS } from './check-skills.mjs';

const SCRIPT = fileURLToPath(new URL('./check-skills.mjs', import.meta.url));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-skills-'));
  temps.push(dir);
  return dir;
}

const scenario = (id) => ({
  id,
  query: `run ${id}`,
  expected_behavior: ['does the thing'],
  expected_files: ['out.md'],
});
const goodEvals = {
  skill: 'x',
  baseline: 'Without the skill it guesses.',
  scenarios: [scenario('a'), scenario('b'), scenario('c')],
};

/** Writes one skill folder. `files` maps paths inside the folder to content (null skips a default). */
function writeSkill(root, dir, { frontmatter, body, files = {} } = {}) {
  const base = path.join(root, '.claude', 'skills', dir);
  const fm =
    frontmatter ??
    `name: ${dir}\ndescription: Does a thing for the fixture. Use when testing check-skills.\ndisable-model-invocation: true`;
  const all = {
    'SKILL.md': `---\n${fm}\n---\n\n${body ?? '# Skill\n\nSee [the reference](reference/guide.md).\n'}`,
    'reference/guide.md': '# Guide\n\nShort.\n',
    'evals/evals.json': JSON.stringify(goodEvals),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), content);
  }
}

function goodRoot() {
  const root = tempRoot();
  for (const name of HUMAN_SKILLS) writeSkill(root, name);
  return root;
}

const forSkill = (problems, dir) => problems.filter((p) => p.startsWith(`${dir}: `));

test('a complete set of good skills has no problems', () => {
  assert.deepEqual(checkSkills(goodRoot()), []);
});

test('bad name: pattern, reserved word and folder mismatch are each named', () => {
  const root = goodRoot();
  writeSkill(root, 'pdf-tools', {
    frontmatter: 'name: Claude_PDF\ndescription: You can use this to process PDFs.',
  });
  const p = forSkill(checkSkills(root), 'pdf-tools');
  assert.ok(
    p.some((x) => x.includes('must be 1-64 lowercase letters')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('does not match the folder name "pdf-tools"')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('third person')),
    p.join('\n'),
  );
  // Not a human skill, so disable-model-invocation is not required.
  assert.ok(!p.some((x) => x.includes('disable-model-invocation')), p.join('\n'));

  writeSkill(root, 'claude-helper', { frontmatter: 'name: claude-helper\ndescription: Helps.' });
  assert.ok(forSkill(checkSkills(root), 'claude-helper').some((x) => x.includes('reserved word')));
});

test('bad human skill: broken YAML, missing disable-model-invocation, too few evals', () => {
  const root = goodRoot();
  writeSkill(root, 'run-retro', {
    frontmatter:
      'name: run-retro\ndescription: Runs the retro: reads the state and writes lessons.',
    files: {
      'evals/evals.json': JSON.stringify({
        baseline: '',
        scenarios: [scenario('a'), { query: 'x' }],
      }),
    },
  });
  const p = forSkill(checkSkills(root), 'run-retro');
  assert.ok(
    p.some((x) => x.includes('contains ": ", which breaks YAML')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('disable-model-invocation: true')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('has 2 scenario(s); at least 3')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('no "baseline" note')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('scenario 2') && x.includes('expected_behavior')),
    p.join('\n'),
  );
});

test('bad structure: long body, broken link, nested and orphan references, no evals', () => {
  const root = goodRoot();
  const long = Array.from({ length: 520 }, (_, i) => `line ${i}`).join('\n');
  writeSkill(root, 'sync-arc42', {
    body: `# Skill\n\nSee [guide](reference/guide.md) and [gone](reference/missing.md).\n\n\`\`\`\n[in code](not/checked.md)\n\`\`\`\n${long}\n`,
    files: {
      'reference/guide.md': `# Guide\n\nMore in [deeper](deeper.md).\n${'x\n'.repeat(120)}`,
      'reference/deeper.md': '# Deeper\n',
    },
  });
  fs.rmSync(path.join(root, '.claude', 'skills', 'sync-arc42', 'evals'), { recursive: true });
  const p = forSkill(checkSkills(root), 'sync-arc42');
  assert.ok(
    p.some((x) => x.includes('body is') && x.includes('under 500')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('link "reference/missing.md" does not resolve')),
    p.join('\n'),
  );
  assert.ok(!p.some((x) => x.includes('not/checked.md')), 'links inside code fences are ignored');
  assert.ok(
    p.some((x) => x.includes('one level deep')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('reference/deeper.md is not linked from SKILL.md')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('add a "## Contents" section')),
    p.join('\n'),
  );
  assert.ok(
    p.some((x) => x.includes('evals/evals.json is missing')),
    p.join('\n'),
  );
});

test('a missing human skill folder is named', () => {
  const root = tempRoot();
  writeSkill(root, 'setup-loop');
  const p = checkSkills(root);
  assert.ok(p.includes('shape-project: the human-run skill folder is missing'), p.join('\n'));
});

test('frontmatter parser handles block scalars, quotes, lists and CRLF', () => {
  const { data, errors } = parseFrontmatter(
    '---\r\nname: a\r\ndescription: >-\r\n  Folded: text\r\n  on two lines\r\nargument-hint: "[x]"\r\nallowed-tools:\r\n  - Read\r\n  - Grep\r\n---\r\nbody\r\n',
  );
  assert.deepEqual(errors, []);
  assert.equal(data.description, 'Folded: text on two lines');
  assert.equal(data['argument-hint'], '[x]');
  assert.deepEqual(data['allowed-tools'], ['Read', 'Grep']);
  assert.ok(parseFrontmatter('no header').errors[0].includes('no frontmatter'));
});

test('CLI exits 0 on good skills and 1 with named problems', () => {
  const good = spawnSync(process.execPath, [SCRIPT, '--root', goodRoot()], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /5 skill\(s\) OK/);

  const root = goodRoot();
  writeSkill(root, 'Bad', { frontmatter: 'description: I do things.' });
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Bad: frontmatter has no "name"/);
  assert.match(bad.stderr, /Bad: description must be third person/);
});
