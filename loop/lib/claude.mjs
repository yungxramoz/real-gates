// Headless Claude Code sessions: one per step, isolated from the machine they run on.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { binary } from './proc.mjs';
import { READ_ONLY_PHASES } from '../guard/core.mjs';

export const UNATTENDED = 'You are running unattended inside the real-gates loop (loop/run.mjs). Nobody will answer questions: never ask, decide and report. Your full instructions are in .loop/current-task.md.';
const LIMIT_RE = /usage limit|hit your (?:session |weekly |5-hour )?limit|limit (?:reached|will reset)|out of (?:extra )?usage|rate[_ ]limit(?:ed)?/i;
const TRANSIENT_RE = /overloaded|529|internal server error|\b50[0-4]\b|ECONNRESET|ETIMEDOUT|socket hang up|network error|fetch failed/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);

/** The argv for one session. Never --bare (it skips hooks, so the guard would silently stop). */
export function sessionArgs(cfg, { prompt, phase, model, schema, settingsFile, mcpConfig }) {
  const a = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--settings', settingsFile];
  a.push('--setting-sources', 'project,local', '--strict-mcp-config');
  if (mcpConfig) a.push('--mcp-config', mcpConfig);
  a.push('--permission-mode', cfg.permissionMode, '--permission-prompts', 'none');
  a.push('--max-budget-usd', String(cfg.budgets.maxUsdPerSession));
  a.push('--append-system-prompt', UNATTENDED);
  if (model) a.push('--model', model);
  if (READ_ONLY_PHASES.has(phase)) a.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit');
  if (schema) a.push('--json-schema', JSON.stringify(schema));
  return a;
}

/** Skill names in the owner's personal skills folder: none of them may load in a loop session. */
export function userSkillNames(env = process.env) {
  const dir = env.LOOP_USER_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** MCP server names the repo's own .mcp.json declares. */
export function repoMcpServers(root) {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers || {});
  } catch {
    return [];
  }
}

/**
 * What in a session's init event did not come from the repository. On the original run a build
 * session loaded ten personal plugins, hundreds of skills and personal mail and drive connectors.
 */
export function isolationProblems(init, { userSkills = [], repoSkills = [], repoMcp = [] } = {}) {
  if (!init) return ['the session sent no init event, so its isolation cannot be checked'];
  const p = [];
  for (const pl of init.plugins || []) if (pl?.path !== 'builtin') p.push(`plugin "${pl?.name}" (${pl?.path}) is loaded — only built-in plugins may run in the loop`);
  for (const m of init.mcp_servers || []) {
    const name = typeof m === 'string' ? m : m?.name;
    if (!repoMcp.includes(name)) p.push(`MCP server "${name}" is loaded but not declared in the repo's .mcp.json`);
  }
  const personal = new Set(userSkills.filter((s) => !repoSkills.includes(s)));
  for (const s of init.skills || []) if (personal.has(typeof s === 'string' ? s : s?.name)) p.push(`personal skill "${s}" is loaded`);
  if (init.memory_paths?.auto) p.push(`auto memory is on (${init.memory_paths.auto}) — the loop must only learn through committed files`);
  return p;
}

/** Reset time from a usage-limit message: "|1767225600" epoch, or "resets 3am". */
export function parseReset(text) {
  const epoch = String(text).match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = String(text).match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  const d = new Date();
  d.setHours(h, Number(m[2] || 0), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch {}
}

/**
 * One headless session. ctx: { cfg, root, paths, env(phase, item), log, nextSessionNumber(), stopFile }.
 * Returns { ok, text, structured, init, isError, limited, resetAt, transient, timedOut, cost, turns, log, code }.
 */
export function runClaudeOnce(ctx, { prompt, phase, item, timeoutMin, model, schema }) {
  return new Promise((resolve) => {
    ctx.beforeSession?.(phase, item); // fresh guard snapshot and settings for every session
    const n = String(ctx.nextSessionNumber()).padStart(3, '0');
    const logFile = path.join(ctx.paths.logs, `${n}-${item?.id || 'x'}-${phase}.jsonl`);
    fs.mkdirSync(ctx.paths.logs, { recursive: true });
    const out = fs.createWriteStream(logFile);
    const mcp = path.join(ctx.root, '.mcp.json');
    const args = sessionArgs(ctx.cfg, { prompt, phase, model, schema, settingsFile: ctx.paths.settings, mcpConfig: fs.existsSync(mcp) ? mcp : null });
    const bin = binary('claude', ctx.envBase || process.env);
    ctx.log(`▶ ${phase} · ${item?.id || ''} · session ${n} · ${path.relative(ctx.root, logFile)}`);
    const child = spawn(bin.cmd, [...bin.pre, ...args], { cwd: ctx.root, env: ctx.env(phase, item?.id), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let stderr = '';
    let final = null;
    let init = null;
    let alarm = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctx.log(`⏱ session timed out after ${timeoutMin} min — killing it`);
      killTree(child);
    }, timeoutMin * 60_000);
    const forbidden = (ctx.cfg.guard?.forbiddenRefs || []).filter(Boolean);
    child.stdout.on('data', (chunk) => {
      out.write(chunk);
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          if (LIMIT_RE.test(line)) stderr += '\n' + line;
          continue;
        }
        if (ev.type === 'system' && ev.subtype === 'init') init = ev;
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === 'text' && c.text?.trim()) ctx.log('   │ ' + short(c.text.trim().split('\n')[0], 160));
            if (c.type === 'tool_use') {
              const inp = c.input || {};
              ctx.log(`   ▸ ${c.name}: ${short(inp.command || inp.file_path || inp.pattern || inp.query || inp.description || inp, 120)}`);
              if (forbidden.some((r) => JSON.stringify(inp).includes(r))) alarm = `tool ${c.name} referenced a forbidden project`;
            }
          }
        }
        if (ev.type === 'result') final = ev;
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (e) => (stderr += String(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      if (stderr) fs.writeFileSync(logFile.replace(/\.jsonl$/, '.stderr.log'), stderr);
      const text = final?.result || '';
      const isError = !final || final.is_error || final.subtype !== 'success' || code !== 0;
      const errText = `${isError ? text : ''}\n${stderr}`;
      const limited = isError && LIMIT_RE.test(errText);
      const transient = isError && !limited && TRANSIENT_RE.test(errText);
      ctx.log(`■ ${phase} · ${item?.id || ''} · exit ${code}${final ? ` · ${final.subtype} · ${final.num_turns ?? '?'} turns` : ''}${final?.total_cost_usd ? ` · ~$${final.total_cost_usd.toFixed(2)}` : ''}${limited ? ' · USAGE LIMIT' : ''}`);
      if (alarm) {
        fs.mkdirSync(path.dirname(ctx.paths.stop), { recursive: true });
        fs.writeFileSync(ctx.paths.stop, `Stopped by run.mjs: ${alarm} (session ${n}).\n`);
        ctx.log(`!!! ${alarm} — wrote .loop/STOP`);
      }
      const res = { ok: !isError, text, structured: final?.structured_output ?? null, init, isError, limited, resetAt: limited ? parseReset(errText) : null, transient, timedOut, cost: final?.total_cost_usd, turns: final?.num_turns, log: logFile, code };
      try {
        ctx.afterSession?.(res, phase, item); // integrity: harness unchanged, base and production unmoved
      } catch (e) {
        ctx.log(`!!! after-session check failed: ${e.message}`);
        fs.writeFileSync(ctx.paths.stop, `Stopped by run.mjs: the after-session check could not run (${e.message}).\n`);
      }
      resolve(res);
    });
  });
}

/** A session with usage-limit sleeps and up to three transient retries. `gaveUp` after the max wait. */
export async function runClaude(ctx, opts) {
  let waitedMs = 0;
  let transientTries = 0;
  const minSleep = ctx.cfg.usageLimit.minSleepMs ?? 60_000;
  for (;;) {
    const r = await runClaudeOnce(ctx, opts);
    if (r.limited) {
      ctx.uncountSession?.(); // a session that hit the limit did no work
      const until = r.resetAt ? r.resetAt + 3 * 60_000 : Date.now() + ctx.cfg.usageLimit.sleepMin * 60_000;
      const ms = Math.max(minSleep, Math.min(until - Date.now(), 6 * 3600_000));
      waitedMs += ms;
      if (waitedMs > ctx.cfg.usageLimit.maxWaitHours * 3600_000) return { ...r, gaveUp: true };
      ctx.onLimit?.(ms, opts);
      await ctx.sleepUnlessStopped(ms);
      if (ctx.stopRequested()) return { ...r, gaveUp: true };
      continue;
    }
    if (r.transient && transientTries < 3) {
      transientTries++;
      ctx.log(`↻ transient API error — retrying (${transientTries}/3)`);
      await ctx.sleepUnlessStopped(Math.max(minSleep, Math.min(120_000, minSleep * 2)));
      continue;
    }
    return r;
  }
}

export { sleep };
