import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolationProblems, runClaude, runClaudeOnce, sessionArgs } from '../lib/claude.mjs';
import { REVIEW_SCHEMA } from '../lib/schemas.mjs';
import { sessionSettings } from '../lib/settings.mjs';
import { DEFAULTS, deepMerge } from '../lib/config.mjs';
import { PRESET } from './helpers/preset.mjs';
import { makeSandbox } from './helpers/sandbox.mjs';

const cfg = deepMerge(PRESET, { budgets: { maxUsdPerSession: 7 } });
const args = (o) => sessionArgs(cfg, { prompt: 'p', settingsFile: 's.json', ...o });
const val = (a, flag) => a[a.indexOf(flag) + 1];

test('every session is isolated, unattended and capped', () => {
  const a = args({ phase: 'build' });
  assert.equal(val(a, '--setting-sources'), 'project,local');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(val(a, '--permission-prompts'), 'none');
  assert.equal(val(a, '--permission-mode'), 'auto');
  assert.equal(val(a, '--max-budget-usd'), '7');
  assert.ok(!a.includes('--disallowedTools'));
});

test('never passes --bare or a bypass mode', () => {
  for (const phase of ['build', 'review', 'accept', 'packet', 'smoke']) {
    const a = args({ phase, schema: REVIEW_SCHEMA });
    assert.ok(!a.includes('--bare'));
    assert.ok(!a.some((x) => /bypass|dangerously/i.test(x)));
  }
});

test('read-only phase gets disallowedTools and json-schema', () => {
  const a = args({ phase: 'review', schema: REVIEW_SCHEMA });
  assert.equal(val(a, '--disallowedTools'), 'Edit,Write,MultiEdit,NotebookEdit');
  assert.deepEqual(JSON.parse(val(a, '--json-schema')), REVIEW_SCHEMA);
  // the variadic --disallowedTools must be followed by another flag, not swallow the schema
  assert.match(a[a.indexOf('--disallowedTools') + 2], /^--/);
});

test('the repo MCP config is passed when it exists', () => {
  assert.equal(val(args({ phase: 'build', mcpConfig: '/r/.mcp.json' }), '--mcp-config'), '/r/.mcp.json');
});

test('settings turn auto memory off and the guard fails closed', () => {
  const s = sessionSettings('C:\\r\\.loop\\guard\\loop\\guard.mjs');
  assert.equal(s.autoMemoryEnabled, false);
  const h = s.hooks.PreToolUse[0];
  assert.match(h.matcher, /mcp__\.\*/);
  assert.equal(h.hooks[0].onFailure, 'block');
  assert.equal(h.hooks[0].command, 'node "C:/r/.loop/guard/loop/guard.mjs"');
});

test('foreign plugin, MCP server, personal skill and auto memory are isolation problems', () => {
  const init = { plugins: [{ name: 'x', path: 'builtin' }, { name: 'mine', path: '/home/u/.claude/plugins/mine' }], mcp_servers: [{ name: 'gmail' }, { name: 'supabase' }], skills: ['debug', 'my-skill', 'setup-loop'], memory_paths: { auto: '/home/u/.claude/projects/x/memory' } };
  const p = isolationProblems(init, { userSkills: ['my-skill', 'setup-loop'], repoSkills: ['setup-loop'], repoMcp: ['supabase'] });
  assert.equal(p.length, 4);
  assert.match(p.join('|'), /plugin "mine"/);
  assert.match(p.join('|'), /MCP server "gmail"/);
  assert.match(p.join('|'), /personal skill "my-skill"/);
  assert.match(p.join('|'), /auto memory/);
  assert.deepEqual(isolationProblems({ plugins: [{ name: 'x', path: 'builtin' }], mcp_servers: [], skills: ['debug'], memory_paths: {} }), []);
  assert.equal(isolationProblems(null).length, 1);
});

const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));
function ctxFor(sb) {
  let n = 0;
  const logs = [];
  return {
    ctx: {
      cfg: sb.cfg,
      root: sb.root,
      paths: { logs: path.join(sb.root, '.loop', 'logs'), settings: path.join(sb.root, '.loop', 's.json'), stop: path.join(sb.root, '.loop', 'STOP') },
      env: () => sb.env,
      envBase: sb.env,
      log: (m) => logs.push(m),
      nextSessionNumber: () => ++n,
      stopRequested: () => false,
      sleepUnlessStopped: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    logs,
    sessions: () => n,
  };
}

test('structured_output is returned', async () => {
  const sb = makeSandbox();
  boxes.push(sb);
  const { ctx } = ctxFor(sb);
  sb.queue({ structured: { verdict: 'approve', blocking: [], summary: 'ok' } });
  const r = await runClaudeOnce(ctx, { prompt: 'x', phase: 'review', item: { id: 'A1' }, timeoutMin: 1, schema: REVIEW_SCHEMA });
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { verdict: 'approve', blocking: [], summary: 'ok' });
  assert.equal(r.init.subtype, 'init');
  assert.ok(sb.calls()[0].args.includes('--json-schema'));
});

test('crash without result is not ok', async () => {
  const sb = makeSandbox();
  boxes.push(sb);
  const { ctx } = ctxFor(sb);
  sb.queue({ mode: 'crash' });
  const r = await runClaudeOnce(ctx, { prompt: 'x', phase: 'build', item: { id: 'A1' }, timeoutMin: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.limited, false);
});

test('usage limit sleeps then retries the same step', async () => {
  const sb = makeSandbox();
  boxes.push(sb);
  const { ctx, sessions } = ctxFor(sb);
  let limits = 0;
  ctx.onLimit = () => limits++;
  sb.queue({ mode: 'limit' }, { text: 'after the reset' });
  const r = await runClaude(ctx, { prompt: 'x', phase: 'build', item: { id: 'A1' }, timeoutMin: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'after the reset');
  assert.equal(limits, 1);
  assert.equal(sessions(), 2);
});

test('transient errors retry, then give up after three', async () => {
  const sb = makeSandbox();
  boxes.push(sb);
  const { ctx } = ctxFor(sb);
  sb.queue({ mode: 'transient' }, { mode: 'transient' }, { mode: 'transient' }, { mode: 'transient' });
  const r = await runClaude(ctx, { prompt: 'x', phase: 'build', item: { id: 'A1' }, timeoutMin: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.transient, true);
  assert.equal(sb.queueLeft().length, 0);
});

test('a tool call naming a forbidden project writes STOP', async () => {
  const sb = makeSandbox({ config: { guard: { forbiddenRefs: ['forbiddenref00000000z'] } } });
  boxes.push(sb);
  const { ctx } = ctxFor(sb);
  ctx.cfg = sb.cfg;
  // a fake session whose stream contains a tool_use with the ref
  const fake = path.join(sb.fake, 'tool-use-claude.mjs');
  fs.writeFileSync(fake, `process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__supabase__list_tables',input:{project_id:'forbiddenref00000000z'}}]}})+'\\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,result:'x'})+'\\n')`);
  ctx.envBase = { ...sb.env, LOOP_CLAUDE_BIN: fake };
  await runClaudeOnce(ctx, { prompt: 'x', phase: 'build', item: { id: 'A1' }, timeoutMin: 1 });
  assert.match(fs.readFileSync(ctx.paths.stop, 'utf8'), /forbidden project/);
});

test('an agent session loses the runner-only secrets; the runner keeps them', async () => {
  const { sessionEnv } = await import('../lib/claude.mjs');
  const cfg = { postMerge: [{ dbUrlEnv: 'DEV_DB_URL' }], deploy: { bypassSecretEnv: 'VERCEL_BYPASS' }, sessionEnvDeny: ['STRIPE_KEY'] };
  const env = { PATH: '/bin', DEV_DB_URL: 'postgres://x', VERCEL_BYPASS: 's', STRIPE_KEY: 'k', OTHER: '1' };
  assert.deepEqual(sessionEnv(env, cfg, 'script'), env);
  for (const phase of ['build', 'review', 'smoke', 'gate']) assert.deepEqual(sessionEnv(env, cfg, phase), { PATH: '/bin', OTHER: '1' }, phase);
  for (const phase of ['accept', 'packet']) assert.deepEqual(sessionEnv(env, cfg, phase), { PATH: '/bin', VERCEL_BYPASS: 's', OTHER: '1' }, phase);
  assert.equal(env.DEV_DB_URL, 'postgres://x', 'the input is not changed');
});

test('session settings deny what the guard packs in use deny, and nothing of packs that are off', () => {
  const deny = (packs) => sessionSettings('/r/.loop/guard/loop/guard.mjs', { guard: { packs } }).permissions.deny;
  assert.deepEqual(deny([]), ['Bash(git push --force:*)', 'Bash(git push -f:*)']);
  assert.ok(deny(['github']).includes('Bash(gh pr merge:*)'));
  assert.ok(!deny(['github']).some((d) => /supabase/.test(d)));
  assert.deepEqual(deny(PRESET.guard.packs).sort(), ['Bash(gh pr merge:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(supabase db push:*)', 'Bash(supabase db reset:*)', 'mcp__supabase__apply_migration'].sort());
});

test('every guard file the runner snapshots exists, and every pack is in the snapshot', async () => {
  const { GUARD_FILES } = await import('../lib/settings.mjs');
  const { PACKS } = await import('../guard/packs/index.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  for (const f of GUARD_FILES) assert.ok(fs.existsSync(path.join(repo, f)), f);
  for (const name of Object.keys(PACKS)) assert.ok(GUARD_FILES.includes(`loop/guard/packs/${name}.mjs`), `pack ${name} must be in GUARD_FILES, or a session could edit its rules unnoticed`);
});
