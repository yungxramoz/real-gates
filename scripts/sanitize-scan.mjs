#!/usr/bin/env node
// Sanitizer scan: no trace of the original project, no personal data, no keys.
//
// Usage: node scripts/sanitize-scan.mjs [repo-root]
// Scans every text file git knows about or would add (`git ls-files -co --exclude-standard`).
// Exit 0 when clean; exit 1 with one `file:line label: match` line per hit.
//
// Two kinds of checks, all case-insensitive:
// - TERMS: names from the original project. They are stored as SHA-256 prefixes, not as text, so
//   this public file does not itself publish the names and database refs it keeps out. A line is
//   split into lowercase words; every word and every pair of neighbouring words is hashed and
//   looked up. "san-labs", "San Labs" and "san_labs" all become the pair "san labs".
// - PATTERNS: shapes that are wrong in any public repo (emails, keys, tokens, real preview URLs).
//
// Exemptions: this file and its test are not scanned (they hold the samples). LICENSE is exempt
// from the email and name checks only, because it carries the copyright holder.
//
// Node built-ins only, so it runs before `pnpm install`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files that are never scanned: the scanner and its test. */
export const SELF_EXEMPT = ['scripts/sanitize-scan.mjs', 'scripts/sanitize-scan.test.mjs'];

/** Files exempt from the checks of kind 'name' and 'email' only. */
export const NAME_EXEMPT = ['LICENSE'];

/**
 * Original-project terms as sha256(term).slice(0, 16). `kind: 'name'` marks a person's name, which
 * LICENSE may carry. To add a term: node -e "console.log(require('crypto').createHash('sha256').update('two words').digest('hex').slice(0,16))"
 */
export const TERMS = [
  { hash: '3e0bf29567d4f55c', label: 'original-project name', kind: 'term' },
  { hash: '2f15dcbe17f980a7', label: 'original-project repo name', kind: 'term' },
  { hash: 'd0baddc5a8fdd49b', label: 'original-project domain', kind: 'term' },
  { hash: 'd8992dc14a6eb4ac', label: 'original-project GitHub owner', kind: 'term' },
  { hash: '9eda8c7541bf2957', label: 'original-project database name', kind: 'term' },
  { hash: '8bc25b9a9508eb67', label: 'forbidden database name', kind: 'term' },
  { hash: 'df20bce806a10947', label: 'original-project database ref', kind: 'term' },
  { hash: '637aedae04542be8', label: 'forbidden database ref', kind: 'term' },
  { hash: '9c04a53593965dc5', label: 'original-project design term', kind: 'term' },
  { hash: 'e457137f616efe6c', label: 'original-project venue', kind: 'term' },
  { hash: 'e2aa81854acc9a73', label: 'original-project town', kind: 'term' },
  { hash: '85fa6b23f894570d', label: 'personal team slug', kind: 'name' },
  { hash: '1faf23fc4ed5880a', label: 'personal name', kind: 'name' },
  { hash: '92e094ab2d7d0020', label: 'personal name', kind: 'name' },
];

const EMAIL_OK = [/@example\.(com|org)$/i, /noreply/i, /^git@github\.com$/i];
const hasDigit = (s) => /\d/.test(s);

/**
 * Regex checks. `keep(match)` can veto a hit (e.g. allowed emails). Every regex gets the `gi` flags.
 */
export const PATTERNS = [
  { label: 'ticket id from the original project', re: /\bSAN-\d+\b/ },
  { label: 'original-project locale', re: /\bde-CH\b/ },
  { label: 'original multi-agent tool', re: /paperclip/ },
  {
    label: 'email',
    kind: 'email',
    re: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/,
    keep: (m) => !EMAIL_OK.some((ok) => ok.test(m)),
  },
  {
    // A concrete *.vercel.app host. Placeholders (<team>, {slug}, …, *) break the host and are not
    // matched; hosts containing "example" are allowed.
    label: 'vercel.app URL with a real team slug',
    re: /(?<![\w<>{}…*.-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.vercel\.app\b/,
    keep: (m) => !/example/i.test(m),
  },
  { label: 'Supabase project ref in a URL', re: /\b[a-z]{20}\.supabase\.(?:co|in|com)\b/ },
  { label: 'Supabase project ref in a URL', re: /project[_-]?ref=[a-z]{20}\b/ },
  { label: 'Supabase project ref in a URL', re: /supabase\.com\/dashboard\/project\/[a-z]{20}\b/ },
  { label: 'JWT', re: /\beyJ[a-z0-9_-]{10,}\.eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/ },
  { label: 'sk- style secret key', re: /\bsk-(?:[a-z]+-)*[a-z0-9_-]{20,}/, keep: hasDigit },
  { label: 're_ style API key', re: /\bre_[a-z0-9]{6,}_[a-z0-9_]{12,}\b/, keep: hasDigit },
  {
    label: 'GitHub token',
    re: /\b(?:ghp|gho|ghs|ghu)_[a-z0-9]{30,}\b|\bgithub_pat_[a-z0-9_]{30,}/,
  },
  { label: 'Supabase key', re: /\bsb_(?:secret|publishable)_[a-z0-9_-]{16,}/ },
];

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.zip',
  '.gz',
  '.mp4',
  '.webm',
  '.mov',
]);

const termHash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);

/** Lowercase words of a line, split on anything that is not a letter or a digit. */
function words(line) {
  return line
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Hits in one file's text. `file` is the repo-relative path with forward slashes; it decides the
 * LICENSE exemption. `terms` and `patterns` default to the built-in lists (tests pass their own).
 */
export function scanText(text, { file = '', terms = TERMS, patterns = PATTERNS } = {}) {
  const nameExempt = NAME_EXEMPT.includes(file);
  const byHash = new Map(
    terms.filter((t) => !(nameExempt && t.kind === 'name')).map((t) => [t.hash, t]),
  );
  const active = patterns.filter((p) => !(nameExempt && p.kind === 'email'));
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const w = words(line);
    const seen = new Set();
    for (let j = 0; j < w.length; j++) {
      for (const cand of j + 1 < w.length ? [w[j], `${w[j]} ${w[j + 1]}`] : [w[j]]) {
        const t = byHash.get(termHash(cand));
        if (t && !seen.has(cand)) {
          seen.add(cand);
          hits.push({ file, line: i + 1, label: t.label, match: cand });
        }
      }
    }
    for (const p of active) {
      const re = new RegExp(p.re.source, 'gi');
      for (const m of line.matchAll(re)) {
        if (p.keep && !p.keep(m[0])) continue;
        hits.push({ file, line: i + 1, label: p.label, match: m[0] });
      }
    }
  }
  return hits;
}

/** Repo-relative paths git tracks or would add, forward slashes. */
export function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [
    ...new Set(
      out
        .split('\0')
        .filter(Boolean)
        .map((f) => f.replace(/\\/g, '/')),
    ),
  ].sort();
}

function isBinary(buf, file) {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return true;
  return buf.subarray(0, 8192).includes(0);
}

/** Every hit in the repo at `root`. */
export function scanRepo(root) {
  const hits = [];
  for (const file of listFiles(root)) {
    if (SELF_EXEMPT.includes(file)) continue;
    const abs = path.join(root, file);
    let buf;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (isBinary(buf, file)) continue;
    hits.push(...scanText(buf.toString('utf8'), { file }));
  }
  return hits;
}

export function formatHit(h) {
  return `${h.file}:${h.line} ${h.label}: ${h.match}`;
}

function main() {
  const arg = process.argv[2];
  const root = arg
    ? path.resolve(arg)
    : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const hits = scanRepo(root);
  if (hits.length === 0) {
    console.log(`sanitize-scan: clean (${listFiles(root).length} files)`);
    return 0;
  }
  for (const h of hits) console.log(formatHit(h));
  console.log(
    `sanitize-scan: ${hits.length} hit(s) in ${new Set(hits.map((h) => h.file)).size} file(s)`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
