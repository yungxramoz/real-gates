// Tests for scripts/sanitize-scan.mjs. Run: node --test scripts/sanitize-scan.test.mjs
//
// The original project's names are never written out here either: the term tests use their own
// sample term, and the one built-in check is assembled from letters.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanRepo, listFiles, formatHit, TERMS } from './sanitize-scan.mjs';

const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
const SAMPLE_TERMS = [
  { hash: hash('acme'), label: 'sample term', kind: 'term' },
  { hash: hash('acme labs'), label: 'sample pair', kind: 'term' },
  { hash: hash('jane'), label: 'sample name', kind: 'name' },
];
const labels = (text, opts) => scanText(text, opts).map((h) => h.label);

test('a hashed term matches whole words, any case', () => {
  assert.deepEqual(labels('We use ACME here.', { terms: SAMPLE_TERMS }), ['sample term']);
  assert.deepEqual(labels('acme_schema.table', { terms: SAMPLE_TERMS }), ['sample term']);
  assert.deepEqual(labels('acmecorp is fine', { terms: SAMPLE_TERMS }), []);
});

test('a hashed pair matches across hyphens, underscores and spaces', () => {
  for (const s of ['acme-labs', 'Acme Labs', 'acme_labs']) {
    assert.ok(labels(s, { terms: SAMPLE_TERMS }).includes('sample pair'), s);
  }
});

test('a built-in term is caught', () => {
  const name = ['u', 'm', 'a', 'i'].join('');
  assert.ok(TERMS.some((t) => t.hash === hash(name)));
  assert.equal(scanText(`schema ${name}.items`).length, 1);
});

test('ticket ids, the locale and the old tool name are caught', () => {
  assert.deepEqual(labels('fixed in SAN-12'), ['ticket id from the original project']);
  assert.deepEqual(labels('locale de-ch'), ['original-project locale']);
  assert.deepEqual(labels('ran on PaperClip'), ['original multi-agent tool']);
});

test('emails: only example.com, example.org, noreply and git@github.com pass', () => {
  assert.deepEqual(labels('mail owner@example.com or team@example.org'), []);
  assert.deepEqual(labels('41898282+github-actions[bot]@users.noreply.github.com'), []);
  assert.deepEqual(labels('git clone git@github.com:owner/name.git'), []);
  assert.deepEqual(labels('write to someone@gmail.com'), ['email']);
  assert.deepEqual(labels('react@18.3.1 and @supabase/ssr'), []);
});

test('LICENSE is exempt from the email and name checks only', () => {
  const text = 'Copyright (c) 2026 Jane <jane@mail.test>\nACME';
  assert.deepEqual(labels(text, { file: 'LICENSE', terms: SAMPLE_TERMS }), ['sample term']);
  assert.deepEqual(labels(text, { file: 'README.md', terms: SAMPLE_TERMS }).sort(), [
    'email',
    'sample name',
    'sample term',
  ]);
});

test('vercel.app: a real slug is caught, placeholders and example hosts are not', () => {
  const L = 'vercel.app URL with a real team slug';
  assert.deepEqual(labels('https://shop-git-develop-janes-projects-1a2b3c4d.vercel.app'), [L]);
  assert.deepEqual(labels('see my-app.vercel.app'), [L]);
  assert.deepEqual(labels('https://<project>-git-<base>-<team>.vercel.app'), []);
  assert.deepEqual(labels('https://example-git-develop-example.vercel.app'), []);
  assert.deepEqual(labels('any *.vercel.app preview'), []);
});

test('Supabase project refs in URLs are caught', () => {
  const L = 'Supabase project ref in a URL';
  assert.deepEqual(labels('https://abcdefghijklmnopqrst.supabase.co'), [L]);
  assert.deepEqual(labels('mcp?project_ref=abcdefghijklmnopqrst'), [L]);
  assert.deepEqual(labels('supabase.com/dashboard/project/abcdefghijklmnopqrst/settings'), [L]);
  assert.deepEqual(labels('https://<ref>.supabase.co'), []);
});

test('JWTs and API keys are caught', () => {
  const jwt = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('.');
  assert.deepEqual(labels(`key=${jwt}`), ['JWT']);
  assert.deepEqual(labels('sk-ant-api03-abcdefghij0123456789abcd'), ['sk- style secret key']);
  assert.deepEqual(labels('re_12345678_abcdefghijklmnopqrstuv'), ['re_ style API key']);
  assert.deepEqual(labels('ghp_' + 'a1'.repeat(18)), ['GitHub token']);
  assert.deepEqual(labels('a task-list item and re_render_the_whole_component'), []);
});

test('hits carry file and line, and format as file:line label: match', () => {
  const [h] = scanText('ok\nSAN-7', { file: 'docs/x.md' });
  assert.deepEqual({ file: h.file, line: h.line }, { file: 'docs/x.md', line: 2 });
  assert.equal(formatHit(h), 'docs/x.md:2 ticket id from the original project: SAN-7');
});

test('CRLF files report the right line', () => {
  assert.equal(scanText('a\r\nb\r\nSAN-1\r\n')[0].line, 3);
});

function tempRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  return root;
}

test('scanRepo covers untracked files, skips ignored, binary and exempt files', (t) => {
  const root = tempRepo({
    '.gitignore': 'ignored.md\n',
    'ignored.md': 'SAN-1',
    'docs/new.md': 'SAN-2',
    'img.png': 'SAN-3',
    'blob.dat': Buffer.from([0x53, 0x41, 0x4e, 0x00, 0x2d, 0x34]),
    'scripts/sanitize-scan.mjs': 'SAN-5',
    'scripts/sanitize-scan.test.mjs': 'SAN-6',
    LICENSE: 'Copyright someone <someone@mail.test>',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(!listFiles(root).includes('ignored.md'));
  assert.deepEqual(scanRepo(root).map(formatHit), [
    'docs/new.md:1 ticket id from the original project: SAN-2',
  ]);
});

test('the CLI exits 1 with the hits and 0 when clean', (t) => {
  const script = fileURLToPath(new URL('./sanitize-scan.mjs', import.meta.url));
  const dirty = tempRepo({ 'a.md': 'mail me: someone@gmail.com' });
  const clean = tempRepo({ 'a.md': 'mail me: owner@example.com' });
  t.after(() => [dirty, clean].forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
  assert.throws(
    () => execFileSync(process.execPath, [script, dirty], { encoding: 'utf8' }),
    (e) => e.status === 1 && /a\.md:1 email: someone@gmail\.com/.test(e.stdout),
  );
  assert.match(execFileSync(process.execPath, [script, clean], { encoding: 'utf8' }), /clean/);
});

// ----------------------------------------------------------------------- template and project mode
const AUTHOR = ['owner', 'mail.test'].join('@');
const STRANGER = ['someone', 'mail.test'].join('@');
const VERCEL_HOST = ['my-app-git-develop-team', 'vercel', 'app'].join('.');
const GH_TOKEN = ['ghp', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8'].join('_');

test('project mode: the original-project checks are off, keys and foreign emails are still caught', () => {
  const text = [
    `schema acme.items, locale ${['de', 'CH'].join('-')}, host https://${VERCEL_HOST}`,
    `author ${AUTHOR}, cc ${STRANGER}`,
    `token ${GH_TOKEN}`,
  ].join('\n');
  const template = labels(text, { terms: SAMPLE_TERMS });
  for (const l of [
    'sample term',
    'original-project locale',
    'vercel.app URL with a real team slug',
    'email',
    'GitHub token',
  ])
    assert.ok(template.includes(l), `template mode should report: ${l}`);
  assert.equal(template.filter((l) => l === 'email').length, 2);
  const project = scanText(text, {
    terms: SAMPLE_TERMS,
    mode: 'project',
    allowEmails: [AUTHOR.toUpperCase()],
  });
  assert.deepEqual(
    project.map((h) => `${h.label}: ${h.match}`),
    [`email: ${STRANGER}`, `GitHub token: ${GH_TOKEN}`],
  );
});

function repoWith(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-mode-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'loop'));
  fs.writeFileSync(path.join(dir, 'loop', 'loop.config.json'), JSON.stringify(config, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('a repo is the template until /setup-loop wrote its repo into the config', async (t) => {
  const { modeOf, projectIdentity } = await import('./sanitize-scan.mjs');
  const template = repoWith({ repo: '', gitAuthor: { name: '', email: '' } });
  const project = repoWith({ repo: 'owner/tool', gitAuthor: { name: 'An Owner', email: AUTHOR } });
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-mode-'));
  t.after(() =>
    [template, project, none].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  );
  assert.equal(modeOf(template), 'template');
  assert.equal(modeOf(project), 'project');
  assert.equal(modeOf(none), 'template', 'no config: the strict checks');
  assert.deepEqual(projectIdentity(project), { repo: 'owner/tool', email: AUTHOR });
});

test('a set-up project passes with its own identity in the config and the docs, and still fails on a key', (t) => {
  const script = fileURLToPath(new URL('./sanitize-scan.mjs', import.meta.url));
  const config = {
    repo: 'owner/tool',
    deploy: { devUrl: `https://${VERCEL_HOST}` },
    gitAuthor: { name: 'An Owner', email: AUTHOR },
  };
  const dir = repoWith(config, {
    'docs/OWNER-ACTIONS.md': `Protect develop in owner/tool. Commits are authored by ${AUTHOR}.\n`,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [script, ...args, dir], { encoding: 'utf8' }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const ok = run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /sanitize-scan: clean \(2 files, project checks\)/);
  // the same tree judged as a template: the host and the email are leaks there
  const strict = run('--template');
  assert.equal(strict.code, 1);
  assert.match(strict.out, /vercel\.app URL with a real team slug/);
  assert.match(strict.out, /loop\/loop\.config\.json:\d+ email/);
  assert.match(strict.out, /template checks/);
  // a key is a leak in any repo, and so is somebody else's address
  fs.writeFileSync(path.join(dir, 'notes.md'), `token ${GH_TOKEN}\nask ${STRANGER}\n`);
  const leak = run();
  assert.equal(leak.code, 1);
  assert.match(leak.out, /notes\.md:1 GitHub token/);
  assert.match(leak.out, /notes\.md:2 email/);
  assert.doesNotMatch(leak.out, /loop\.config\.json|OWNER-ACTIONS/);
});
