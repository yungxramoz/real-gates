#!/usr/bin/env node
// A fake `claude -p` for the runner suite. Each call takes the next step from
// $LOOP_FAKE_DIR/claude-queue.json and records its argv in claude-calls.jsonl.
//
// Step: { mode: ok|limit|crash|transient, guard: "<shell command>", commit: { branch, files, message,
//         mergeBase }, createPr: { title }, result: {...}, writes: { relPath: content }, structured,
//         text, initExtra }
// Placeholders: "$OPEN" = the branch of the newest open PR, "$PR" = the PR of the current branch.
// `guard` runs the PreToolUse hook command from the --settings file exactly as Claude Code would.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.LOOP_FAKE_DIR;
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const cwd = process.cwd();
const git = (...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gh = () => JSON.parse(fs.readFileSync(path.join(DIR, 'gh-state.json'), 'utf8'));

if (args.includes('--version')) {
  process.stdout.write(`${process.env.LOOP_FAKE_CLAUDE_VERSION || '2.1.319'} (Claude Code)\n`);
  process.exit(0);
}

fs.appendFileSync(path.join(DIR, 'claude-calls.jsonl'), JSON.stringify({ phase: process.env.LOOP_PHASE, item: process.env.LOOP_ITEM, args }) + '\n');
const qFile = path.join(DIR, 'claude-queue.json');
const queue = fs.existsSync(qFile) ? JSON.parse(fs.readFileSync(qFile, 'utf8')) : [];
const step = queue.shift() || { text: 'nothing scripted' };
fs.writeFileSync(qFile, JSON.stringify(queue, null, 2));

emit({ type: 'system', subtype: 'init', cwd, tools: ['Bash', 'Read'], mcp_servers: [], plugins: [{ name: 'builtin-x', path: 'builtin', source: 'x@builtin' }], skills: [], memory_paths: {}, permissionMode: opt('--permission-mode'), claude_code_version: '2.1.319', ...(step.initExtra || {}) });

if (step.mode === 'crash') process.exit(1);
if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
if (step.mode === 'limit') {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit", num_turns: 0 });
  process.exit(1);
}
if (step.mode === 'transient') {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded', num_turns: 0 });
  process.exit(1);
}

const subst = (v) => {
  if (typeof v === 'string') {
    if (v === '$OPEN') return Object.values(gh().prs).filter((p) => p.state === 'OPEN').at(-1)?.headRefName;
    if (v === '$PR') {
      const br = git('rev-parse', '--abbrev-ref', 'HEAD');
      return Object.values(gh().prs).filter((p) => p.headRefName === br).at(-1)?.number ?? null;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(subst);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)]));
  return v;
};

try {
  if (step.guard) {
    const settings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8'));
    const hook = settings.hooks.PreToolUse[0].hooks[0].command;
    const r = spawnSync(hook, { shell: true, cwd, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: step.guard }, cwd }), encoding: 'utf8' });
    fs.appendFileSync(path.join(DIR, 'guard-probes.jsonl'), JSON.stringify({ command: step.guard, status: r.status, stderr: r.stderr }) + '\n');
  }
  if (step.commit) {
    const c = subst(step.commit);
    const base = gh().base;
    git('fetch', '-q', 'origin');
    const remote = spawnSync('git', ['rev-parse', '--verify', `origin/${c.branch}`], { cwd }).status === 0;
    git('checkout', '-q', '-B', c.branch, remote ? `origin/${c.branch}` : `origin/${base}`);
    if (c.mergeBase) git('merge', '-q', '--no-edit', `origin/${base}`);
    for (const [rel, content] of Object.entries(c.files || {})) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), content);
      git('add', rel);
    }
    git('commit', '-q', '--allow-empty', '-m', c.message || 'change');
    git('push', '-q', '-u', 'origin', c.branch);
  }
  if (step.createPr) {
    const br = git('rev-parse', '--abbrev-ref', 'HEAD');
    const s = gh();
    const n = s.nextPr || 1;
    s.nextPr = n + 1;
    s.prs[n] = { number: n, state: 'OPEN', baseRefName: step.createPr.base || s.base, headRefName: br, headRefOid: git('rev-parse', 'HEAD'), title: step.createPr.title || br, isDraft: false, mergeCommit: null };
    fs.writeFileSync(path.join(DIR, 'gh-state.json'), JSON.stringify(s, null, 2));
  }
  for (const [rel, content] of Object.entries(step.writes || {})) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), typeof content === 'string' ? content : JSON.stringify(subst(content), null, 2));
  }
  if (step.result) {
    fs.mkdirSync(path.join(cwd, '.loop'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.loop', 'result.json'), JSON.stringify(subst(step.result), null, 2));
  }
  if (step.commit || step.createPr) {
    // A real session leaves the tree clean; go back to the base like the runner expects to find it.
    git('checkout', '-q', gh().base);
  }
} catch (e) {
  process.stderr.write(String(e.stack || e));
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(e.message), num_turns: 1 });
  process.exit(1);
}

emit({ type: 'result', subtype: 'success', is_error: false, result: step.text ?? 'done', structured_output: step.structured, num_turns: 3, total_cost_usd: 0.01 });
process.exit(0);
