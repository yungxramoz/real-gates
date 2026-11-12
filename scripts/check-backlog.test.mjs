// Tests for the brief check of .claude/skills/shape-project/scripts/check-backlog.mjs.
// Run: node --test scripts/check-backlog.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = fileURLToPath(
  new URL('../.claude/skills/shape-project/scripts/check-backlog.mjs', import.meta.url),
);
const { briefProblems, sectionText } = await import(
  new URL('../.claude/skills/shape-project/scripts/check-backlog.mjs', import.meta.url)
);

const setupOnly = { milestones: ['M0'], items: [{ id: 'LOOP-0' }] };
const shaped = { milestones: ['M0', 'M1'], items: [{ id: 'LOOP-0' }, { id: 'E1-1' }] };
const brief = (success, terms) =>
  `# Brief\n\n## What we build\nA tool.\n\n## What success looks like\n${success}\n\n## Terms\n${terms}\n\n## Out of scope\n- nothing\n`;
const COMMENT = '<!-- shape-project: write this -->';

test('a section is the text under its heading, without comments, up to the next heading', () => {
  const md = brief('Under two minutes.', '- **run**: one folder.');
  assert.equal(sectionText(md, 'What success looks like').trim(), 'Under two minutes.');
  assert.equal(sectionText(md, 'terms').trim(), '- **run**: one folder.');
  assert.equal(sectionText(md, 'Nope'), null);
  assert.equal(sectionText(brief(COMMENT, 'x'), 'What success looks like').trim(), '');
});

test('the skeleton brief is fine while the backlog holds only the setup item', () => {
  assert.deepEqual(briefProblems(brief(COMMENT, COMMENT), setupOnly), []);
  assert.deepEqual(briefProblems(null, setupOnly), []);
});

test('a shaped backlog needs a success measure and terms in the brief', () => {
  assert.deepEqual(
    briefProblems(
      brief(
        'I answer four questions about a run in under 2 minutes.',
        '- **run**: everything in one folder.',
      ),
      shaped,
    ),
    [],
  );
  const empty = briefProblems(brief(COMMENT, '| Term | Means |\n| --- | --- |\n|  |  |'), shaped);
  assert.equal(empty.length, 2, empty.join('|'));
  assert.match(empty[0], /"## What success looks like" is empty/);
  assert.match(empty[1], /"## Terms" is empty/);
  assert.match(
    briefProblems('# Brief\n\n## What success looks like\nFast.\n', shaped).join('|'),
    /has no "## Terms" section/,
  );
  assert.match(briefProblems(null, shaped)[0], /BRIEF\.md not found/);
});

test('the command line names the gaps, and a sample checked with --backlog is not asked for a brief', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-brief-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'loop'));
  fs.mkdirSync(path.join(dir, 'docs'));
  const item = (id) => ({
    id,
    milestone: 'M1',
    title: 't',
    refs: ['docs/REQUIREMENTS.md'],
    scope: 's',
    type: 'default',
    dependsOn: [],
  });
  fs.writeFileSync(
    path.join(dir, 'loop', 'backlog.json'),
    JSON.stringify({ milestones: ['M1'], items: [item('LOOP-0'), item('E1-1')] }),
  );
  fs.writeFileSync(path.join(dir, 'docs', 'REQUIREMENTS.md'), '# R\n\n- AC-1.1 x\n');
  fs.writeFileSync(path.join(dir, 'docs', 'BRIEF.md'), brief(COMMENT, COMMENT));
  const run = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: dir }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const gaps = run('--root', dir);
  assert.equal(gaps.code, 1);
  assert.match(gaps.out, /PROBLEM {2}docs\/BRIEF\.md: "## What success looks like" is empty/);
  assert.match(gaps.out, /PROBLEM {2}docs\/BRIEF\.md: "## Terms" is empty/);
  assert.equal(
    run(
      '--backlog',
      path.join(dir, 'loop', 'backlog.json'),
      '--requirements',
      path.join(dir, 'docs', 'REQUIREMENTS.md'),
    ).code,
    0,
  );
  fs.writeFileSync(
    path.join(dir, 'docs', 'BRIEF.md'),
    brief(
      'Four answers in under 2 minutes.',
      '- **run**: one folder, however often it was started.',
    ),
  );
  const ok = run('--root', dir);
  assert.equal(ok.code, 0, ok.out);
});
