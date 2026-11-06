#!/usr/bin/env node
// CI gate: the project rule table (loop/rules/project-rules.json) may only get stricter.
//
// The loop adds rows itself when it keeps hitting the same failure (a LEARN item). It must never be
// able to remove or soften one, because nobody reviews its PRs. So this check fails when a row that
// exists on the base branch is missing or changed, and when any row does not do what its own
// examples say.
//
// Usage: node loop/scripts/check-rules.mjs [--base <git ref>]   (default: compare nothing, check rows)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGETS } from '../guard/rules.mjs';

const FILE = 'loop/rules/project-rules.json';
const stable = (r) => JSON.stringify(r, Object.keys(r).sort());

/** Problems with `head` (and against `base`, when given). Both are parsed tables. */
export function checkRules(base, head) {
  const p = [];
  const rows = Array.isArray(head?.rules) ? head.rules : null;
  if (!rows) return [`${FILE}: "rules" must be an array`];
  const ids = new Set();
  for (const r of rows) {
    const id = r?.id || '(no id)';
    if (!r?.id) p.push(`a rule has no id`);
    else if (ids.has(r.id)) p.push(`${id}: duplicate id`);
    ids.add(r?.id);
    if (!TARGETS.includes(r?.target)) p.push(`${id}: target must be one of ${TARGETS.join(', ')}`);
    if (!r?.reason) p.push(`${id}: needs a reason the agent will read`);
    let re = null;
    try {
      re = new RegExp(r?.pattern, r?.flags ?? 'i');
      if (!r?.pattern) throw new Error('empty');
    } catch (e) {
      p.push(`${id}: pattern is not a valid regular expression (${e.message})`);
    }
    const ex = r?.examples || {};
    if (typeof ex.block !== 'string' || typeof ex.allow !== 'string') p.push(`${id}: needs examples.block and examples.allow`);
    else if (re) {
      if (!re.test(ex.block)) p.push(`${id}: its block example "${ex.block}" is not matched, so the rule blocks nothing it claims to`);
      if (re.test(ex.allow)) p.push(`${id}: its allow example "${ex.allow}" is matched, so the rule blocks more than it claims to`);
    }
  }
  const before = Array.isArray(base?.rules) ? base.rules : [];
  const now = new Map(rows.filter((r) => r?.id).map((r) => [r.id, r]));
  for (const r of before) {
    if (!r?.id) continue;
    const h = now.get(r.id);
    if (!h) p.push(`${r.id}: removed — rules may only be added (the loop must not loosen its own guard)`);
    else if (stable(h) !== stable(r)) p.push(`${r.id}: changed — rules may only be added; add a new, stricter row instead`);
  }
  return p;
}

function readAt(ref, root) {
  const r = spawnSync('git', ['show', `${ref}:${FILE}`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null; // the table does not exist on the base yet
  return JSON.parse(r.stdout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const i = process.argv.indexOf('--base');
  try {
    const head = JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8'));
    const base = i > 0 ? readAt(process.argv[i + 1], root) : null;
    const problems = checkRules(base, head);
    if (problems.length) {
      console.error(`check-rules: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
      process.exit(1);
    }
    console.log(`check-rules: OK — ${head.rules.length} project rule(s)${base ? `, none removed or changed since ${process.argv[i + 1]}` : ''}`);
  } catch (e) {
    console.error(`check-rules: ${e.message}`);
    process.exit(1);
  }
}
