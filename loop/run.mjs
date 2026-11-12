#!/usr/bin/env node
// real-gates: an unattended, sequential development loop. See loop/README.md.
//
// One backlog item at a time, one fresh `claude -p` session per step, state on disk. The script,
// not the agent, decides what is done: it waits for CI, runs an independent reviewer, merges,
// verifies what landed, waits for CI on the base branch, applies merged migrations, accepts each
// milestone on the deployed dev site, and stops on budgets, stalls, holds or a STOP file.
//
// Usage: node loop/run.mjs [--dry-run] [--once] [--item ID] [--only M] [--max-iterations N]
//                          [--max-hours H] [--status] [--reset ID] [--skip ID] [--release ID]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configProblems, loadConfig, MIN_CLAUDE_VERSION, versionNumber } from './lib/config.mjs';
import { backlogProblems, createState, HELD_PHASE, readJson, TERMINAL, writeJson } from './lib/state.mjs';
import { binary, createProc } from './lib/proc.mjs';
import { isolationProblems, repoMcpServers, runClaudeOnce, sessionEnv, userSkillNames } from './lib/claude.mjs';
import { branchProtected } from './lib/github.mjs';
import { changedFiles, fingerprint, harnessFiles, snapshotGuard, writeSettings } from './lib/settings.mjs';
import { countFailure, runItem, settleBaseCi } from './lib/engine.mjs';
import { READ_ONLY_PHASES } from './guard/core.mjs';
import { packMilestones } from './lib/milestones.mjs';
import { POST_MERGE } from './adapters/index.mjs';
import { writeReport, printStatus } from './lib/report.mjs';

// ------------------------------------------------------------------------------------------ setup
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(ROOT, '.loop');
const paths = {
  run: RUN,
  state: path.join(RUN, 'state.json'),
  status: path.join(RUN, 'status.json'),
  lock: path.join(RUN, 'lock'),
  stop: path.join(RUN, 'STOP'),
  progress: path.join(RUN, 'PROGRESS.md'),
  owner: path.join(RUN, 'OWNER-ACTIONS.md'),
  report: path.join(RUN, 'REPORT.md'),
  result: path.join(RUN, 'result.json'),
  ledger: path.join(RUN, 'ledger.jsonl'),
  task: path.join(RUN, 'current-task.md'),
  settings: path.join(RUN, 'claude-settings.json'),
  logs: path.join(RUN, 'logs'),
  reviews: path.join(RUN, 'reviews'),
  guardLog: path.join(RUN, 'logs', 'guard.log'),
};

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const args = { dry: flag('--dry-run'), once: flag('--once'), item: opt('--item'), only: opt('--only'), status: flag('--status'), reset: opt('--reset'), skip: opt('--skip'), release: opt('--release') };

let cfg;
try {
  cfg = loadConfig(ROOT);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (opt('--max-iterations')) cfg.budgets.maxSessions = Number(opt('--max-iterations'));
if (opt('--max-hours')) cfg.budgets.maxHours = Number(opt('--max-hours'));

const backlog = readJson(path.join(ROOT, 'loop', 'backlog.json'), null);
if (!backlog) {
  console.error('loop/backlog.json is missing or invalid JSON. /shape-project writes it.');
  process.exit(1);
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const short = (v, n = 140) => (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').slice(0, n);
const store = createState(paths.state, backlog, { dry: args.dry });
const proc = createProc({ root: ROOT, env: () => childEnv('script') });
const runStartedAt = Date.now();
let runSessions = 0;
let runCostUsd = 0;

function childEnv(phase, item) {
  const env = sessionEnv(process.env, cfg, phase); // agent sessions never see the runner's secrets
  if (!cfg.allowApiKey) delete env.ANTHROPIC_API_KEY; // run on the subscription, never bill the API by accident
  Object.assign(env, {
    GIT_AUTHOR_NAME: cfg.gitAuthor.name,
    GIT_AUTHOR_EMAIL: cfg.gitAuthor.email,
    GIT_COMMITTER_NAME: cfg.gitAuthor.name,
    GIT_COMMITTER_EMAIL: cfg.gitAuthor.email,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    CLAUDE_CODE_RETRY_WATCHDOG: '1', // unattended retry mode for 429/529
    CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(20 * 60_000), // longer outages fall through to the loop's own usage-limit wait
    LOOP_ROOT: ROOT,
    LOOP_PHASE: phase,
    LOOP_ITEM: item || '',
    LOOP_GUARD_LOG: paths.guardLog,
    LOOP_GUARD_CONFIG: path.join(RUN, 'guard', 'config.json'),
  });
  return env;
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}
function progress(line) {
  if (args.dry) return;
  fs.mkdirSync(RUN, { recursive: true });
  fs.appendFileSync(paths.progress, `- ${stamp()} · ${String(line).replace(/\s*\n\s*/g, ' ')}\n`);
}
function tailOf(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n');
  } catch {
    return '(empty)';
  }
}
function ownerAction(itemId, text) {
  if (args.dry) return;
  const existing = fs.existsSync(paths.owner) ? fs.readFileSync(paths.owner, 'utf8') : '# Things only the owner can do\n\nCollected by the loop during the run. Tick them off here; the loop never reads ticks.\n\n';
  const t = String(text).trim();
  if (existing.includes(t.slice(0, 120))) return;
  fs.writeFileSync(paths.owner, existing + `- [ ] **${itemId}** — ${t}  _(${stamp()})_\n`);
}
async function notify(title, body) {
  if (!cfg.notify?.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${cfg.notify.ntfyTopic}`, { method: 'POST', headers: { Title: title }, body });
  } catch {}
}
function setStatus(phase, item, extra = {}) {
  if (args.dry) return;
  writeJson(paths.status, { pid: process.pid, phase, item: item?.id || null, title: item?.title || null, since: new Date().toISOString(), runSessions, ...extra });
}
const stopRequested = () => fs.existsSync(paths.stop);
const budgetExceeded = () => runSessions >= cfg.budgets.maxSessions || Date.now() - runStartedAt > cfg.budgets.maxHours * 3600_000 || (cfg.budgets.maxUsdPerRun > 0 && runCostUsd >= cfg.budgets.maxUsdPerRun);
async function sleepUnlessStopped(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stopRequested()) return;
    await new Promise((r) => setTimeout(r, Math.min(30_000, end - Date.now())));
  }
}
function render(name, vars) {
  const tpl = fs.readFileSync(path.join(ROOT, 'loop', 'prompts', name), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (vars[k] === undefined) throw new Error(`loop/prompts/${name} uses {{${k}}}, but the runner supplies no value for it`);
    return String(vars[k] ?? '');
  });
}
function syncBase() {
  proc.git('fetch', 'origin', '--prune');
  const dirty = proc.git('status', '--porcelain', '--untracked-files=no');
  if (dirty) {
    // Never discard work: keep it in a named stash the owner can inspect.
    const label = `loop-autostash-${Date.now()}`;
    proc.gitTry('stash', 'push', '-m', label);
    progress(`the working tree had uncommitted tracked changes — kept as stash "${label}" (git stash list)`);
  }
  proc.git('checkout', '-q', cfg.base);
  const ff = proc.gitTry('merge', '--ff-only', `origin/${cfg.base}`);
  if (!ff.ok) throw new Error(`local ${cfg.base} cannot fast-forward to origin/${cfg.base}: ${ff.err}`);
}

const repoSkills = (() => {
  try {
    return fs.readdirSync(path.join(ROOT, '.claude', 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
})();

/** Stop the run when a session loaded something that did not come from the repository. */
function checkIsolation(r) {
  if (!r || r.limited) return;
  const p = isolationProblems(r.init, { userSkills: userSkillNames(process.env), repoSkills, repoMcp: repoMcpServers(ROOT) });
  if (!p.length) return;
  fs.writeFileSync(paths.stop, `Stopped by run.mjs: a loop session was not isolated (${path.relative(ROOT, r.log)}):\n- ${p.join('\n- ')}\n`);
  log(`!!! session not isolated — wrote .loop/STOP:\n - ${p.join('\n - ')}`);
}

const L = {
  root: ROOT,
  cfg,
  backlog,
  paths,
  proc,
  store,
  args,
  log,
  progress,
  progressTail: (n) => tailOf(paths.progress, n),
  ownerAction,
  ownerActionsTail: (n) => tailOf(paths.owner, n),
  notify,
  setStatus,
  stopRequested,
  budgetExceeded,
  render,
  syncBase,
  checkIsolation,
  envBase: process.env,
};
// ------------------------------------------------------------------------- session integrity
// Before every session: a fresh guard snapshot from the base branch and fresh settings. After it:
// the snapshot and settings must be unchanged, and the base and production branches must not have
// moved (only the runner's own merge moves the base). The guard's shell rules are an early
// warning; these checks hold whatever spelling a command used.
let harness = null;
let warnedTree = false;
function beforeSession() {
  fs.mkdirSync(RUN, { recursive: true });
  const snap = snapshotGuard(ROOT, cfg, proc);
  if (snap.fromTree && !warnedTree) {
    warnedTree = true;
    log(`⚠ the guard is not on origin/${cfg.base} yet: sessions use the working-tree copy until it is.`);
  }
  writeSettings(paths.settings, snap.entry);
  const files = harnessFiles(snap, paths.settings);
  harness = { files, prints: fingerprint(files) };
}
function stopRun(why, ask) {
  fs.writeFileSync(paths.stop, `Stopped by run.mjs: ${why}
`);
  log(`!!! ${why} — wrote .loop/STOP`);
  progress(`**run stopped** — ${why}`);
  if (ask) ownerAction('run', ask);
}
function remoteHeads() {
  proc.gitTry('fetch', 'origin', '--prune');
  const at = (b) => proc.gitTry('rev-parse', '--verify', `origin/${b}`).out || null;
  return { base: at(cfg.base), production: at(cfg.production) };
}
/** One line per session in .loop/ledger.jsonl, and the running cost in the state. */
function recordSession(res, phase, item) {
  const cost = Number(res.cost) || 0;
  const id = item?.id || '-';
  const cents = (n) => Math.round(n * 100) / 100;
  runCostUsd += cost;
  const c = (store.S.cost ||= { totalUsd: 0, byItem: {} });
  c.totalUsd = cents(c.totalUsd + cost);
  c.byItem[id] = cents((c.byItem[id] || 0) + cost);
  store.save();
  fs.appendFileSync(paths.ledger, JSON.stringify({ at: new Date().toISOString(), session: path.basename(res.log || ''), item: id, phase, ok: !!res.ok, limited: !!res.limited, timedOut: !!res.timedOut, turns: res.turns ?? null, durationMs: res.durationMs ?? null, costUsd: cost }) + '\n');
}
function afterSession(res, phase, item) {
  try {
    recordSession(res, phase, item);
  } catch (e) {
    log(`⚠ could not write the session ledger: ${e.message}`);
  }
  if (harness) {
    const changed = changedFiles(harness.prints, fingerprint(harness.files));
    if (changed.length) stopRun(`session ${path.basename(res.log)} changed the guard snapshot or the session settings (${changed.map((f) => path.relative(ROOT, f)).join(', ')})`, `A loop session (${item?.id || '-'}, ${phase}) changed harness files it may not touch. Read ${path.relative(ROOT, res.log)}, then re-run: the runner rebuilds them from ${cfg.base}.`);
  }
  const heads = remoteHeads();
  const S = store.S;
  for (const [name, now] of Object.entries(heads)) {
    const was = name === 'base' ? S.baseHead : S.productionHead;
    if (was !== undefined && now !== was) {
      const branch = cfg[name];
      stopRun(`origin/${branch} moved outside the runner during ${phase} of ${item?.id || '-'} (${String(was).slice(0, 7)} → ${String(now).slice(0, 7)})`, `origin/${branch} moved from ${String(was).slice(0, 7)} to ${String(now).slice(0, 7)} during a loop session (${item?.id || '-'}, ${phase}), not by the runner's merge. Inspect it (git log ${String(was).slice(0, 7)}..origin/${branch}), revert anything unreviewed, then re-run. Branch protection on ${branch} that requires the ${cfg.ciCheck} check prevents this.`);
    }
  }
  if (READ_ONLY_PHASES.has(phase)) {
    const dirty = proc.gitTry('status', '--porcelain', '--untracked-files=no').out;
    if (dirty) {
      countFailure(L, 'guard:core:read-only-tree', `the ${phase} session changed tracked files: ${dirty.split('\n').slice(0, 5).join('; ')}`, item?.id ? item : { id: String(item?.id || '-') });
      progress(`${item?.id || '-'} · the ${phase} session changed tracked files — kept aside as a stash, not used`);
    }
  }
}
function recordHeads() {
  const heads = remoteHeads();
  store.S.baseHead = heads.base;
  store.S.productionHead = heads.production;
  store.save();
}

L.session = {
  cfg,
  root: ROOT,
  paths,
  envBase: process.env,
  env: childEnv,
  log,
  stopRequested,
  sleepUnlessStopped,
  nextSessionNumber: () => {
    runSessions++;
    store.S.iterations++;
    store.save();
    return store.S.iterations;
  },
  uncountSession: () => runSessions--,
  beforeSession,
  afterSession,
  onLimit: (ms, opts) => {
    setStatus('usage-limit-wait', opts.item, { until: new Date(Date.now() + ms).toISOString() });
    log(`⏸ usage limit — sleeping ${Math.round(ms / 60000)} min and retrying the same step`);
    progress(`${opts.item?.id || '-'} · usage limit, waiting ${Math.round(ms / 60000)} min`);
  },
};

// --------------------------------------------------------------------------------- run lifecycle
function lockHolder() {
  const l = readJson(paths.lock, null);
  if (!l?.pid || l.pid === process.pid) return null;
  try {
    process.kill(l.pid, 0);
    return l.pid;
  } catch {
    return null;
  }
}

function acquireLock() {
  fs.mkdirSync(RUN, { recursive: true });
  const l = readJson(paths.lock, null);
  if (l?.pid && l.pid !== process.pid) {
    let alive = false;
    try {
      process.kill(l.pid, 0);
      alive = true;
    } catch {}
    if (alive) {
      console.error(`Another loop is running (pid ${l.pid}, since ${l.since}). One loop at a time: concurrent agents sharing a tree are what broke an earlier multi-agent setup.`);
      process.exit(1);
    }
  }
  writeJson(paths.lock, { pid: process.pid, since: new Date().toISOString() });
  const release = () => {
    try {
      if (readJson(paths.lock, {})?.pid === process.pid) fs.rmSync(paths.lock, { force: true });
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
}

function preflight() {
  const problems = [];
  const warn = [];
  if (!fs.existsSync(path.join(ROOT, 'CLAUDE.md'))) problems.push('CLAUDE.md not found: run from the repository');
  problems.push(...configProblems(cfg, { backlog }).map((p) => `loop/loop.config.json → ${p} (/setup-loop sets it)`));
  problems.push(...backlogProblems(backlog));
  for (const s of cfg.postMerge || []) if (!POST_MERGE[s.adapter]) problems.push(`postMerge adapter "${s.adapter}" is unknown (known: ${Object.keys(POST_MERGE).join(', ')})`);
  for (const s of cfg.postMerge || []) if (s.dbUrlEnv && !process.env[s.dbUrlEnv]) warn.push(`${s.dbUrlEnv} is not set: the first merge with a migration will hold until it is.`);
  if (!proc.sh('git', ['--version'], { allowFail: true }).ok) problems.push('git is not on PATH');
  else if (!proc.gitTry('rev-parse', '--verify', `origin/${cfg.base}`).ok) (args.dry ? warn : problems).push(`origin/${cfg.base} does not exist: create and push the ${cfg.base} branch (/setup-loop does)`);
  const ghOk = proc.ghTry('auth', 'status').ok;
  if (!ghOk) (args.dry ? warn : problems).push('gh is not logged in (`gh auth login`)');
  // Nobody reviews the loop's PRs, so GitHub itself has to refuse a push to the base. The runner's
  // after-session check only notices one once it has happened.
  if (ghOk && cfg.repo && cfg.guard?.requireBranchProtection !== false && !branchProtected({ proc, cfg }, cfg.base)) {
    (args.dry ? warn : problems).push(`${cfg.base} has no branch protection or ruleset on GitHub. Protect it: require a pull request and the "${cfg.ciCheck}" status check, no required approvals, no direct or force pushes (docs/OWNER-ACTIONS.md). If your GitHub plan does not offer protection for this repository, set guard.requireBranchProtection to false in loop/loop.config.json and accept that a stray push is only noticed afterwards.`);
  }
  if (process.env.ANTHROPIC_API_KEY && !cfg.allowApiKey) warn.push('ANTHROPIC_API_KEY is set: the loop removes it from its sessions so they run on your subscription.');
  const claude = binary('claude', process.env);
  const v = proc.sh(claude.cmd, [...claude.pre, '--version'], { allowFail: true, timeoutMs: 60_000 });
  if (!v.ok) problems.push(`claude --version failed: ${v.err || 'is Claude Code installed and on PATH?'}`);
  else if (versionNumber(v.out) < versionNumber(MIN_CLAUDE_VERSION)) problems.push(`Claude Code ${v.out} is older than ${MIN_CLAUDE_VERSION}: run \`claude update\``);
  else log(`claude ${v.out}`);
  warn.forEach((w) => log('⚠ ' + w));
  if (problems.length) {
    console.error('Preflight failed:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}

/**
 * Must pass at every run start. A session is told to run a command the guard refuses. The run
 * continues only if the guard log shows the block, and the session loaded nothing from outside the
 * repository. This catches a hook that silently stopped firing (bare mode, a broken settings file).
 */
async function smokeTest() {
  const before = (() => {
    try {
      return fs.statSync(paths.guardLog).size;
    } catch {
      return 0;
    }
  })();
  fs.writeFileSync(paths.task, 'Permission check for the loop. Run exactly one shell command and nothing else.');
  const r = await runClaudeOnce(L.session, {
    prompt: 'This is an automated permission check. Run exactly this one shell command with the Bash tool: git add -A --dry-run — a hook is expected to refuse it. Do not retry it, do not run anything else, then reply with the single word DONE.',
    phase: 'smoke',
    item: { id: 'preflight' },
    timeoutMin: cfg.timeouts.smokeMin,
    model: cfg.smokeModel || cfg.model,
  });
  runSessions--;
  let added = '';
  try {
    added = fs.readFileSync(paths.guardLog).subarray(before).toString('utf8');
  } catch {}
  const blocked = added.split('\n').some((l) => l.split('\t')[1] === 'preflight' && l.split('\t')[3] === 'core:add-all');
  const iso = isolationProblems(r.init, { userSkills: userSkillNames(process.env), repoSkills, repoMcp: repoMcpServers(ROOT) });
  if (r.limited) {
    console.error('The permission check hit a usage limit. Re-run the loop once the limit resets.');
    process.exit(1);
  }
  if (!blocked || iso.length) {
    console.error(`The permission check failed — see ${path.relative(ROOT, r.log)}.`);
    if (!blocked) console.error(' - the guard hook did not refuse the planted command, so it is not running in loop sessions. Nothing may run unguarded. (Is the session started with --bare? Is node on PATH for hooks?)');
    for (const p of iso) console.error(` - not isolated: ${p}`);
    process.exit(1);
  }
  log('permission check passed: the guard refused the planted command and the session was isolated');
}

// ------------------------------------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(RUN, { recursive: true });
  if (args.status) return printStatus(L);
  if ((args.reset || args.skip || args.release) && lockHolder()) {
    console.error(`A loop is running (pid ${lockHolder()}). Stop it first (.loop/STOP), then change its state: a running loop would overwrite the change.`);
    process.exit(1);
  }
  if (args.reset) {
    delete store.S.items[args.reset];
    store.save();
    return log(`reset ${args.reset} to todo`);
  }
  if (args.skip) {
    store.st(args.skip).status = 'skipped';
    store.save();
    return log(`marked ${args.skip} as skipped`);
  }
  if (args.release) {
    const s = store.st(args.release);
    if (s.phase !== HELD_PHASE) return log(`${args.release} is not held (phase ${s.phase}) — nothing to release`);
    s.released = stamp();
    store.save();
    return log(`${args.release}: released from hold (${s.hold?.kind}) — the next run continues it past that check`);
  }

  preflight();
  if (args.dry) {
    const next = store.pickNext({ item: args.item, only: args.only });
    log(next.none ? `nothing eligible${next.waiting.length ? ` — waiting on: ${next.waiting.join(' | ')}` : ''}` : `[dry-run] next item: ${next.id} · ${next.milestone} · ${next.title}`);
    return;
  }
  acquireLock();
  recordHeads();
  await smokeTest();
  log(`loop starting — ${store.allItems().length} items, budget ${cfg.budgets.maxSessions} sessions / ${cfg.budgets.maxHours} h`);
  progress(`loop started (pid ${process.pid})`);

  let reason = 'backlog exhausted';
  let held = false;
  for (;;) {
    if (stopRequested()) {
      reason = `.loop/STOP exists: ${fs.readFileSync(paths.stop, 'utf8').trim() || '(no reason given)'}`;
      break;
    }
    if (budgetExceeded()) {
      reason = 'budget reached (sessions, hours or dollars)';
      break;
    }
    // Base CI that earlier merges did not wait for: a red one puts its FIX item first in line.
    const bg = await settleBaseCi(L);
    if (bg.stop) {
      reason = bg.stop;
      break;
    }
    syncBase();
    const next = store.pickNext({ item: args.item, only: args.only });
    if (next.none) {
      const last = await settleBaseCi(L, { wait: true });
      if (last.stop) {
        reason = last.stop;
        break;
      }
      if (last.queued) continue;
      const pm = await packMilestones(L);
      if (pm.stop) {
        reason = pm.stop;
        break;
      }
      if (!store.pickNext({ item: args.item, only: args.only }).none) continue; // acceptance queued fix items
      if (next.waiting.length) reason = `nothing eligible — waiting on: ${next.waiting.join(' | ')}`;
      break;
    }
    log(`━━━ ${next.id} · ${next.milestone} · ${next.title}`);
    const outcome = await runItem(L, next);
    if (outcome === 'stopped' || outcome === 'budget' || outcome === 'waiting') continue;
    if (outcome === 'held') {
      held = true;
      reason = `${next.id} is held — ${store.st(next.id).lastError}`;
      await notify(`loop: ${next.id} held`, short(store.st(next.id).lastError, 300));
      break;
    }
    if (outcome === 'done' || outcome === 'partial') store.S.noProgress = 0;
    else if (outcome !== 'blocked') store.S.noProgress++;
    store.save();
    if (outcome !== 'done' && outcome !== 'partial') await notify(`loop: ${next.id} ${outcome}`, store.st(next.id).lastError || '');
    const pm = await packMilestones(L, next.milestone);
    if (pm.stop) {
      reason = pm.stop;
      break;
    }
    if (store.S.noProgress >= cfg.maxNoProgress) {
      reason = `circuit breaker: ${store.S.noProgress} items in a row ended without merging anything`;
      break;
    }
    if (args.once) {
      reason = '--once';
      break;
    }
  }
  // Nothing is reported as finished while a merge still waits for its base CI verdict.
  if (!stopRequested()) {
    const end = await settleBaseCi(L, { wait: true });
    if (end.stop) reason = `${reason}; ${end.stop}`;
    else if (end.queued) reason = `${reason}; ${cfg.base} CI turned red on an earlier merge: its fix item is first in line for the next run`;
  }
  try {
    syncBase();
  } catch {}
  if (!stopRequested() && !budgetExceeded() && !held && !args.once) {
    const pm = await packMilestones(L);
    if (pm.stop) reason = pm.stop;
  }
  writeReport(L, reason, runSessions);
  progress(`loop ended — ${reason}`);
  setStatus('stopped', null, { reason });
  log(`loop ended — ${reason}. Report: .loop/REPORT.md`);
  await notify('loop stopped', reason);
}

main().catch(async (e) => {
  console.error(e);
  progress(`loop crashed: ${short(String(e?.stack || e), 600)}`);
  setStatus('crashed', null, { error: String(e?.message || e) });
  await notify('loop crashed', String(e?.message || e));
  process.exit(1);
});
