// Loop configuration: defaults, loading and validation.
//
// Every value the original runner had hardcoded (repo, branch names, the one database project the
// loop may touch, the dev URL, the git author) lives in loop/loop.config.json. /setup-loop writes
// that file; this module fills in the defaults and names what is still missing.

import fs from 'node:fs';
import path from 'node:path';

/** Oldest Claude Code the loop runs on: --permission-prompts none, fail-closed hooks, /goal. */
export const MIN_CLAUDE_VERSION = '2.1.319';

export const DEFAULTS = Object.freeze({
  repo: '', // owner/name on GitHub
  base: 'develop', // the loop merges here
  production: 'main', // the loop never touches it
  ciCheck: 'ci', // the one required check-run name
  deploy: { adapter: 'vercel-preview', devUrl: '', health: '/api/health', bypassSecretEnv: 'VERCEL_BYPASS' },
  postMerge: [{ adapter: 'supabase-cli', dbUrlEnv: 'DEV_DB_URL', migrationsDir: 'supabase/migrations', holdOnUnverified: true }],
  guard: { allowedDbProject: '', forbiddenRefs: [], protectedPaths: ['.env*', 'loop/**', '.github/**', '.claude/**'], dbSchema: '' },
  review: { minDesignScore: 7, maxRounds: 2 },
  budgets: { maxSessions: 150, maxHours: 120, maxUsdPerSession: 25 },
  notify: { ntfyTopic: '' },
  gitAuthor: { name: '', email: '' },
  // Per-item limits, unchanged from the original run.
  maxAttemptsPerItem: 3, // failed / no-result build sessions before an item is marked failed
  maxRoundsPerItem: 8, // build sessions per item, fix rounds included, before needs_human
  maxPartialsPerItem: 4,
  maxCiFixes: 3,
  maxAcceptRounds: 2, // milestone acceptance passes on the dev site before the packet
  maxNoProgress: 3, // items in a row that end without merging anything → circuit breaker
  maxFollowups: 15,
  learnThreshold: 2, // the same failure this many times → a LEARN item that fixes the cause
  timeouts: { sessionMin: 150, reviewMin: 60, acceptMin: 120, packetMin: 60, ciMin: 45, smokeMin: 5 },
  pollMs: 30_000,
  usageLimit: { sleepMin: 30, maxWaitHours: 96 },
  goalMaxTurns: 120,
  useGoal: true,
  permissionMode: 'auto', // auto | acceptEdits. Bypassing permissions is deliberately unsupported.
  model: '', // '' = Claude Code default
  reviewModel: '',
  milestonePackets: true,
  allowApiKey: false, // false: ANTHROPIC_API_KEY is removed from sessions so they run on the subscription
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? structuredClone(base) : over;
  const out = isPlainObject(base) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue; // $comment and friends
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

export function configPath(root) {
  return path.join(root, 'loop', 'loop.config.json');
}

/** The config for the repo at `root`: loop/loop.config.json over DEFAULTS. Throws on invalid JSON. */
export function loadConfig(root) {
  const file = configPath(root);
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${path.relative(root, file)} is not valid JSON: ${e.message}`);
    }
  }
  return deepMerge(DEFAULTS, raw);
}

/**
 * What still has to be set before a real run, as plain sentences. Empty means runnable.
 * `backlog` is optional: with it, a dev URL is only required when some item has UI.
 */
export function configProblems(cfg, { backlog } = {}) {
  const p = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo || '')) p.push('repo: set it to the GitHub "owner/name" of this repository');
  if (!cfg.base) p.push('base: name the branch the loop merges into (e.g. develop)');
  if (!cfg.production) p.push('production: name the production branch (e.g. main)');
  if (cfg.base && cfg.base === cfg.production) p.push(`base and production are both "${cfg.base}": the loop must never merge into production`);
  if (!cfg.ciCheck) p.push('ciCheck: name the required CI check-run (e.g. ci)');
  if (!cfg.gitAuthor?.name) p.push('gitAuthor.name: the commit author the loop uses');
  if (!/^[^@\s]+@[^@\s]+$/.test(cfg.gitAuthor?.email || '')) p.push('gitAuthor.email: the commit author email the loop uses (Vercel only builds previews for commits by a verified account email)');
  const needsUrl = backlog ? (backlog.items || []).some((i) => i.ui) : true;
  if (needsUrl && !/^https?:\/\//.test(cfg.deploy?.devUrl || '')) p.push('deploy.devUrl: the URL where the base branch is deployed (milestone acceptance runs there)');
  const usesDb = (cfg.postMerge || []).some((s) => s.adapter === 'supabase-cli');
  if (usesDb && !cfg.guard?.allowedDbProject) p.push('guard.allowedDbProject: the one Supabase project ref the loop may touch');
  if ((cfg.guard?.forbiddenRefs || []).includes(cfg.guard?.allowedDbProject) && cfg.guard?.allowedDbProject) p.push('guard.forbiddenRefs contains guard.allowedDbProject');
  if (!['auto', 'acceptEdits'].includes(cfg.permissionMode)) p.push(`permissionMode "${cfg.permissionMode}" is not supported: use "auto" (the loop never bypasses permissions)`);
  if (!(cfg.review?.minDesignScore >= 1 && cfg.review?.minDesignScore <= 10)) p.push('review.minDesignScore must be between 1 and 10');
  if (!(cfg.budgets?.maxUsdPerSession > 0)) p.push('budgets.maxUsdPerSession must be a positive number');
  return p;
}

/** "2.1.319 (Claude Code)" → 2001319, for comparisons. 0 when unparseable. */
export function versionNumber(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}
