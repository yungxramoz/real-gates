#!/usr/bin/env node
// PreToolUse hook for every Claude Code session the loop starts (loop/run.mjs).
//
// It is wired in through the generated .loop/claude-settings.json with `onFailure: "block"`, so it
// never affects the owner's interactive sessions, and if it cannot start the tool call is refused.
// Exit 2 blocks the call; the stderr text goes back to the agent as the reason. It also fails
// closed on its own errors and on a payload it cannot read.
//
// The runner starts sessions with a snapshot of this file and its modules taken from the base
// branch (.loop/guard/), so a change in the working tree cannot switch a rule off mid-session.
//
// Environment (set by run.mjs): LOOP_ROOT, LOOP_PHASE (build | review | accept | packet | smoke),
// LOOP_ITEM, LOOP_GUARD_LOG.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { decide } from './guard/core.mjs';
import { repoRelative } from './guard/paths.mjs';
import { compileRules } from './guard/rules.mjs';
import { loadConfig } from './lib/config.mjs';

const PHASE = process.env.LOOP_PHASE || 'build';
const ITEM = process.env.LOOP_ITEM || '-';

function logBlock(root, rule, reason) {
  const file = process.env.LOOP_GUARD_LOG || path.join(root || '.', '.loop', 'logs', 'guard.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()}\t${ITEM}\t${PHASE}\t${rule}\t${String(reason).replace(/\s+/g, ' ')}\n`);
  } catch {}
}

function block(root, rule, reason) {
  logBlock(root, rule, reason);
  process.stderr.write(`Blocked by the loop guard (${rule}, phase ${PHASE}): ${reason}\n`);
  process.exit(2);
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

/** Rows on the base branch always apply; the working tree may only add rows (it can't drop one mid-session). */
function projectRules(root, base) {
  const rows = new Map();
  const fromBase = git(root, ['show', `origin/${base}:loop/rules/project-rules.json`]);
  const sources = [fromBase.ok ? fromBase.out : null];
  const local = path.join(root, 'loop', 'rules', 'project-rules.json');
  if (fs.existsSync(local)) sources.push(fs.readFileSync(local, 'utf8'));
  for (const text of sources) {
    if (!text) continue;
    for (const r of JSON.parse(text).rules || []) if (r?.id && !rows.has(r.id)) rows.set(r.id, r);
  }
  return compileRules({ rules: [...rows.values()] });
}

let root = process.env.LOOP_ROOT || '';
try {
  const raw = fs.readFileSync(0, 'utf8');
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    block(root, 'core:unreadable', 'the guard could not read this tool call, so it refuses it.');
  }
  const cwd = ev.cwd && fs.existsSync(ev.cwd) ? ev.cwd : process.cwd();
  if (!root) root = git(cwd, ['rev-parse', '--show-toplevel']).out || cwd;
  // The runner hands over the config it loaded at start (LOOP_GUARD_CONFIG, in the protected
  // snapshot), so editing loop/loop.config.json mid-run cannot rename the base branch away.
  const cfg = process.env.LOOP_GUARD_CONFIG ? JSON.parse(fs.readFileSync(process.env.LOOP_GUARD_CONFIG, 'utf8')) : loadConfig(root);
  const onBase = new Map();
  const ctx = {
    phase: PHASE,
    item: ITEM,
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out,
    cfg,
    rel: (p) => repoRelative(root, p),
    cwd: repoRelative(root, cwd),
    isOnBase: (rel) => {
      if (!onBase.has(rel)) onBase.set(rel, spawnSync('git', ['cat-file', '-e', `origin/${cfg.base}:${rel}`], { cwd: root, stdio: 'ignore', windowsHide: true }).status === 0);
      return onBase.get(rel);
    },
    projectRules: projectRules(root, cfg.base),
  };
  const d = decide(ev, ctx);
  if (d.block) block(root, d.rule, d.reason);
  process.exit(0);
} catch (e) {
  block(root, 'core:guard-error', `the guard failed (${e?.message || e}), so it refuses the call.`);
}
