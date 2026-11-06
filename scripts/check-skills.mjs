#!/usr/bin/env node
// Checks every skill in .claude/skills/ against the authoring rules the template follows
// (Anthropic's skill authoring guide and the Claude Code skills docs):
//
//   - SKILL.md starts with YAML frontmatter that parses
//   - name: lowercase letters, digits and hyphens, at most 64 characters, equal to the folder name,
//     without the reserved words "claude" or "anthropic"
//   - description: present, at most 1,024 characters, third person (not "I ..." / "You ..."), no XML tags
//   - the five human-run skills set disable-model-invocation: true, so an unattended loop session
//     can never load them
//   - the SKILL.md body stays under 500 lines
//   - every relative markdown link resolves; reference files are linked straight from SKILL.md
//     (one level deep) and carry a "Contents" heading once they pass 100 lines
//   - evals/evals.json holds a baseline note and at least three scenarios
//
// Usage: node scripts/check-skills.mjs [--root <repo dir>]
// Node built-ins only, so it runs before `pnpm install`. Exit 0 when clean, 1 with named problems.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Skills a person runs. They ask questions or change the setup, so the model must never load them. */
export const HUMAN_SKILLS = [
  'setup-loop',
  'shape-project',
  'draft-design',
  'run-retro',
  'sync-arc42',
];

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const RESERVED_RE = /claude|anthropic/;
const MAX_DESCRIPTION = 1024; // Agent Skills spec limit for `description`
const MAX_BODY_LINES = 500; // "Keep SKILL.md under 500 lines" (authoring guide)
const TOC_AFTER_LINES = 100; // reference files longer than this need a table of contents
const MIN_SCENARIOS = 3; // "Build three scenarios" (authoring guide, evaluations first)
const TRUE_RE = /^(true|yes|on|1)$/i; // the boolean spellings Claude Code accepts

/**
 * Parses the YAML subset a SKILL.md header uses: `key: scalar`, quoted scalars, block scalars
 * (`|`, `>`), and lists (indented `- item` or `[a, b]`). Nested maps (hooks, metadata) are kept as
 * raw text. Returns { data, body, bodyStart, errors }.
 */
export function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const errors = [];
  if (lines[0].trim() !== '---') {
    return {
      data: {},
      body: src,
      bodyStart: 0,
      errors: ['the first line is not "---", so there is no frontmatter'],
    };
  }
  const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  if (close === -1)
    return {
      data: {},
      body: '',
      bodyStart: 0,
      errors: ['the frontmatter has no closing "---" line'],
    };

  const head = lines.slice(1, close);
  const data = {};
  for (let i = 0; i < head.length; i++) {
    const line = head[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    if (!m) {
      errors.push(`frontmatter line ${i + 2} is not "key: value": ${JSON.stringify(line)}`);
      continue;
    }
    const key = m[1];
    const raw = (m[2] ?? '').trim();
    if (Object.hasOwn(data, key)) errors.push(`frontmatter key "${key}" appears twice`);

    // Indented continuation lines belong to this key.
    const block = [];
    while (i + 1 < head.length && (/^\s+\S/.test(head[i + 1]) || !head[i + 1].trim()))
      block.push(head[++i]);
    while (block.length && !block[block.length - 1].trim()) block.pop();

    if (/^[|>][+-]?$/.test(raw)) {
      const indent = Math.min(
        ...block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length),
      );
      const body = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = raw.startsWith('|')
        ? body.join('\n')
        : body
            .join('\n')
            .replace(/([^\n])\n(?=[^\n])/g, '$1 ')
            .trim();
      continue;
    }
    if (raw === '') {
      if (block.length && block.every((l) => !l.trim() || /^\s*-\s/.test(l))) {
        data[key] = block
          .filter((l) => l.trim())
          .map((l) => unquote(l.replace(/^\s*-\s+/, '').trim(), key, errors));
      } else {
        data[key] = block.length ? { raw: block.join('\n') } : '';
      }
      continue;
    }
    if (block.length) {
      errors.push(
        `frontmatter key "${key}" has a value and indented lines after it; use a block scalar (">") for long text`,
      );
    }
    if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) errors.push(`frontmatter key "${key}": the list "[" is never closed`);
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim(), key, errors))
        .filter(Boolean);
      continue;
    }
    data[key] = unquote(raw, key, errors);
  }
  const body = lines.slice(close + 1).join('\n');
  return { data, body, bodyStart: close + 2, errors };
}

function unquote(raw, key, errors) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      errors.push(
        `frontmatter key "${key}": the double-quoted value is not closed or has a bad escape`,
      );
      return raw;
    }
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw))
      errors.push(`frontmatter key "${key}": the single-quoted value is not closed`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  // A plain YAML scalar cannot contain ": " or start with an indicator character; a real YAML
  // parser rejects the whole header, and the skill then loads without its description.
  if (/:\s/.test(raw))
    errors.push(
      `frontmatter key "${key}": the value contains ": ", which breaks YAML; quote it or use ">"`,
    );
  if (/^[{&*!%@`]/.test(raw))
    errors.push(`frontmatter key "${key}": the value starts with "${raw[0]}"; quote it`);
  return raw.replace(/\s+#.*$/, '');
}

/** Markdown with fenced code blocks and inline code removed, so example links are not checked. */
function stripCode(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** Relative link targets in a markdown text, without fragments. */
export function relativeLinks(md) {
  const out = [];
  for (const m of stripCode(md).matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.includes('${'))
      continue;
    const file = target.split('#')[0];
    if (file) out.push(decodeURIComponent(file));
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function checkEvals(dir, problem) {
  const file = path.join(dir, 'evals', 'evals.json');
  if (!fs.existsSync(file))
    return problem('evals/evals.json is missing (three scenarios and a baseline note)');
  let evals;
  try {
    evals = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return problem(`evals/evals.json is not valid JSON: ${e.message}`);
  }
  if (typeof evals.baseline !== 'string' || !evals.baseline.trim()) {
    problem('evals/evals.json has no "baseline" note (what happens without the skill)');
  }
  const scenarios = Array.isArray(evals.scenarios) ? evals.scenarios : [];
  if (scenarios.length < MIN_SCENARIOS) {
    problem(
      `evals/evals.json has ${scenarios.length} scenario(s); at least ${MIN_SCENARIOS} are required`,
    );
  }
  scenarios.forEach((s, i) => {
    const label = `evals/evals.json scenario ${i + 1}${s?.id ? ` (${s.id})` : ''}`;
    if (typeof s?.query !== 'string' || !s.query.trim())
      problem(`${label} has no "query" (the user prompt)`);
    const eb = s?.expected_behavior;
    if (!Array.isArray(eb) || !eb.length || eb.some((b) => typeof b !== 'string' || !b.trim())) {
      problem(`${label} needs "expected_behavior": a non-empty list of strings`);
    }
    if (!Array.isArray(s?.expected_files))
      problem(`${label} needs "expected_files": the files that must result (may be empty)`);
  });
}

/** All problems for the skills under `<root>/.claude/skills`, each prefixed with the skill folder. */
export function checkSkills(root) {
  const skillsDir = path.join(root, '.claude', 'skills');
  if (!fs.existsSync(skillsDir))
    return [`${path.join('.claude', 'skills')} does not exist under ${root}`];
  const problems = [];
  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (!dirs.length) problems.push('.claude/skills holds no skill folders');

  for (const name of HUMAN_SKILLS) {
    if (!dirs.includes(name)) problems.push(`${name}: the human-run skill folder is missing`);
  }

  for (const dirName of dirs) {
    const dir = path.join(skillsDir, dirName);
    const problem = (msg) => problems.push(`${dirName}: ${msg}`);
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      problem('SKILL.md is missing');
      continue;
    }
    const { data, body, errors } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    errors.forEach(problem);

    const name = data.name;
    if (typeof name !== 'string' || !name) problem('frontmatter has no "name"');
    else {
      if (!NAME_RE.test(name))
        problem(`name "${name}" must be 1-64 lowercase letters, digits or hyphens`);
      if (RESERVED_RE.test(name))
        problem(`name "${name}" contains a reserved word ("claude" or "anthropic")`);
      if (name !== dirName) problem(`name "${name}" does not match the folder name "${dirName}"`);
    }

    const desc = data.description;
    if (typeof desc !== 'string' || !desc.trim()) problem('frontmatter has no "description"');
    else {
      if (desc.length > MAX_DESCRIPTION)
        problem(`description is ${desc.length} characters; the limit is ${MAX_DESCRIPTION}`);
      if (/^(I|You)\b/.test(desc.trim()))
        problem('description must be third person ("Sets up ...", not "I ..." or "You ...")');
      if (/<\/?[A-Za-z][^>]*>/.test(desc)) problem('description must not contain XML tags');
    }

    if (
      HUMAN_SKILLS.includes(dirName) &&
      !TRUE_RE.test(String(data['disable-model-invocation'] ?? ''))
    ) {
      problem(
        'a human-run skill must set "disable-model-invocation: true" so loop sessions never load it',
      );
    }

    const bodyLines = body.replace(/\n+$/, '').split('\n').length;
    if (bodyLines >= MAX_BODY_LINES)
      problem(`SKILL.md body is ${bodyLines} lines; keep it under ${MAX_BODY_LINES}`);

    // Links and reference depth.
    const files = listFiles(dir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    const linkedFromSkill = relativeLinksFrom(skillFile, dir);
    for (const md of mdFiles) {
      const rel = path.relative(dir, md).split(path.sep).join('/');
      const text = fs.readFileSync(md, 'utf8');
      for (const link of relativeLinks(text)) {
        const target = path.resolve(path.dirname(md), link);
        if (!fs.existsSync(target)) problem(`${rel}: link "${link}" does not resolve`);
        else if (
          md !== skillFile &&
          target.endsWith('.md') &&
          target.startsWith(dir + path.sep) &&
          target !== skillFile
        ) {
          problem(
            `${rel}: links to another reference file ("${link}"); keep references one level deep from SKILL.md`,
          );
        }
      }
      if (md !== skillFile) {
        if (!linkedFromSkill.has(path.resolve(md))) {
          problem(`${rel} is not linked from SKILL.md, so it is never read`);
        }
        const lines = text.replace(/\r\n?/g, '\n').split('\n').length;
        if (lines > TOC_AFTER_LINES && !/^#{1,3}\s+(table of )?contents\s*$/im.test(text)) {
          problem(`${rel} is ${lines} lines; add a "## Contents" section at the top`);
        }
      }
    }
    checkEvals(dir, problem);
  }
  return problems;
}

function relativeLinksFrom(skillFile, dir) {
  const text = fs.readFileSync(skillFile, 'utf8');
  return new Set(relativeLinks(text).map((l) => path.resolve(dir, l)));
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/check-skills.mjs [--root <repo dir>]\nChecks .claude/skills/*/SKILL.md, references and evals. Exit 1 on problems.',
    );
    return 0;
  }
  const at = argv.indexOf('--root');
  const root =
    at >= 0 && argv[at + 1]
      ? path.resolve(argv[at + 1])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let problems;
  try {
    problems = checkSkills(root);
  } catch (e) {
    console.error(`check-skills: could not read the skills: ${e.message}`);
    return 1;
  }
  if (problems.length) {
    console.error(`check-skills: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  const count = fs
    .readdirSync(path.join(root, '.claude', 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).length;
  console.log(`check-skills: ${count} skill(s) OK`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
