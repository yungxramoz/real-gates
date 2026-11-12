// Loop configuration: defaults, loading and validation.
//
// Three layers, later ones win:
//   1. DEFAULTS below: what the core loop needs whatever the project is built with. No framework,
//      host or database is named here.
//   2. loop/profiles/<name>/profile.json: the stack profile that `profile` in loop.config.json
//      names. Which commands prove a change, which files CI runs through, which guard packs and
//      adapters the stack needs (loop/profiles/README.md). Every profile ships with the harness,
//      so the runner's own suite can test each one whatever a project uses.
//   3. loop/loop.config.json: this project's own values (repo, branches, the dev URL, the git
//      author). /setup-loop writes it.
// This module merges them and names what is still missing.

import fs from 'node:fs';
import path from 'node:path';

import { packProblems } from '../guard/packs/index.mjs';

/** Oldest Claude Code the loop runs on: --permission-prompts none, fail-closed hooks, /goal. */
export const MIN_CLAUDE_VERSION = '2.1.319';

export const DEFAULTS = Object.freeze({
  repo: '', // owner/name on GitHub
  base: 'develop', // the loop merges here
  production: 'main', // the loop never touches it
  ciCheck: 'ci', // the one required check-run name
  profile: '', // the stack profile this project uses: a folder name under loop/profiles/. '' = none
  forge: { adapter: 'github' }, // pull requests, CI results, the merge (loop/adapters/forge-*.mjs)
  // "Does the dev site serve this commit?" http-health polls devUrl + health until the body's
  // commitField starts with the merged sha and every field in expect has an allowed value.
  // adapter 'none': nothing is deployed, so no milestone acceptance on a site.
  deploy: { adapter: 'http-health', devUrl: '', health: '/api/health', commitField: 'commit', expect: {}, bypassSecretEnv: '', bypassHeader: '' },
  postMerge: [], // steps the runner takes after a merge (loop/adapters/postmerge-*.mjs)
  // packs: the tool rules on top of the core guard (loop/guard/packs/). allowedDbProject and
  // dbSchema belong to the database packs.
  guard: { packs: ['github'], allowedDbProject: '', forbiddenRefs: [], protectedPaths: ['.env*', 'loop/**', '.github/**', '.claude/**'], dbSchema: '', requireBranchProtection: true },
  // What kinds of thing an item can deliver, and how each is reviewed and accepted
  // (loop/lib/worktypes.mjs). An item names one with `type`; `ui: true` is the type "ui",
  // anything else "default". A profile adds its own and removes one by setting it to null.
  workTypes: {
    ui: { rubric: ['design_quality', 'originality', 'craft', 'functionality'], accept: 'site' },
    default: { rubric: [], accept: 'none' },
  },
  // What a PR may not change because CI runs through it (loop/lib/gates.mjs).
  gates: { files: [], frozenJsonKeys: [], ratchets: [] },
  review: { minDesignScore: 7, maxRounds: 2, parallelWithCi: true }, // parallelWithCi: the reviewer starts while CI runs
  budgets: { maxSessions: 150, maxHours: 120, maxUsdPerSession: 25, maxUsdPerRun: 0 }, // maxUsdPerRun 0 = no run cap
  // Environment variables no agent session may see, on top of every postMerge[].dbUrlEnv (always
  // removed) and deploy.bypassSecretEnv (kept only for the steps that open the deployed site).
  sessionEnvDeny: [],
  // Commands the runner itself runs on the pushed branch head before it waits for CI. The agent is
  // told to prove its work locally; this checks that it did. Empty = no local gate.
  localGate: { commands: [], timeoutMin: 20 },
  contractsDir: 'docs/contracts', // <dir>/<item id>.md, written by the build session

  notify: { adapter: 'ntfy', ntfyTopic: '' },
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
  learnCategoryThreshold: 4, // review findings that share only a category (different causes) need this many
  // 'unless-tree-equal': when the landed check proved the merge commit has exactly the tree PR CI
  // passed on, the next item starts while base CI runs; a red result still queues a FIX item first
  // and a missing verdict still stops the run. 'always': every merge waits for base CI.
  baseCiWait: 'unless-tree-equal',
  // What the post-merge steps do when base CI is red after a merge. 'apply' (default): run them
  // anyway. The host deploys the base branch whether CI is green or not, and merged code without
  // its migration is the outage the hold gate exists for. 'wait': run them only once the FIX item
  // is done, for steps that must never act on a red base (a release, a publish).
  postMergeOnRedBase: 'apply',
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

export function profilesDir(root) {
  return path.join(root, 'loop', 'profiles');
}

export function profilePath(root, name) {
  return path.join(profilesDir(root), name, 'profile.json');
}

/** The profile folders the repo at `root` ships. */
export function profileNames(root) {
  try {
    return fs.readdirSync(profilesDir(root), { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(profilePath(root, d.name))).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function readJsonIfPresent(root, file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.relative(root, file)} is not valid JSON: ${e.message}`);
  }
}

/** The stack profile `name` of the repo at `root` ({} for no name). Throws when it does not exist or is invalid JSON. */
export function loadProfile(root, name) {
  if (!name) return {};
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !fs.existsSync(profilePath(root, name))) {
    throw new Error(`profile "${name}" (loop/loop.config.json) is not a folder under loop/profiles/ with a profile.json (known: ${profileNames(root).join(', ') || 'none'})`);
  }
  return readJsonIfPresent(root, profilePath(root, name));
}

/** DEFAULTS with a profile over them: what a project of that stack starts from. */
export function withProfile(profile) {
  return deepMerge(DEFAULTS, profile || {});
}

/**
 * The config for the repo at `root`: DEFAULTS, then the profile loop/loop.config.json names, then
 * loop/loop.config.json itself. Throws on invalid JSON or an unknown profile.
 */
export function loadConfig(root) {
  const own = readJsonIfPresent(root, configPath(root));
  return deepMerge(withProfile(loadProfile(root, own.profile)), own);
}

/**
 * What still has to be set before a real run, as plain sentences. Empty means runnable.
 * `backlog` is optional: with it, a dev URL is only required when some item has UI.
 */
export function configProblems(cfg, { backlog } = {}) {
  const p = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo || '')) p.push('repo: set it to the "owner/name" of this repository on the forge');
  if (!cfg.base) p.push('base: name the branch the loop merges into (e.g. develop)');
  if (!cfg.production) p.push('production: name the production branch (e.g. main)');
  if (cfg.base && cfg.base === cfg.production) p.push(`base and production are both "${cfg.base}": the loop must never merge into production`);
  if (!cfg.ciCheck) p.push('ciCheck: name the required CI check-run (e.g. ci)');
  if (!cfg.gitAuthor?.name) p.push('gitAuthor.name: the commit author the loop uses');
  if (!/^[^@\s]+@[^@\s]+$/.test(cfg.gitAuthor?.email || '')) p.push('gitAuthor.email: the commit author email the loop uses (some hosts only build previews for commits by a verified account email)');
  // A dev URL is needed when something is accepted on a deployed site: an item of such a work
  // type in the backlog, or, before there is a backlog, any such type in the profile.
  const onSite = (name) => cfg.workTypes?.[name]?.accept === 'site';
  const needsUrl = backlog ? (backlog.items || []).some((i) => onSite(i.type || (i.ui ? 'ui' : 'default'))) : Object.keys(cfg.workTypes || {}).some(onSite);
  if (needsUrl && cfg.deploy?.adapter !== 'none' && !/^https?:\/\//.test(cfg.deploy?.devUrl || '')) p.push('deploy.devUrl: the URL where the base branch is deployed (milestone acceptance runs there)');
  p.push(...packProblems(cfg)); // unknown guard packs, and what each listed pack needs
  for (const r of cfg.gates?.ratchets || []) {
    try {
      if (!r?.name || !Array.isArray(r.files) || !r.number) throw new Error('needs name, files and number');
      new RegExp(r.number);
      if (r.within) new RegExp(r.within);
    } catch (e) {
      p.push(`gates.ratchets: "${r?.name || '?'}" is not usable (${e.message})`);
    }
  }
  if (!['auto', 'acceptEdits'].includes(cfg.permissionMode)) p.push(`permissionMode "${cfg.permissionMode}" is not supported: use "auto" (the loop never bypasses permissions)`);
  if (!(cfg.review?.minDesignScore >= 1 && cfg.review?.minDesignScore <= 10)) p.push('review.minDesignScore must be between 1 and 10');
  if (!(cfg.budgets?.maxUsdPerSession > 0)) p.push('budgets.maxUsdPerSession must be a positive number');
  if (!(cfg.budgets?.maxUsdPerRun >= 0)) p.push('budgets.maxUsdPerRun must be 0 (no cap) or a positive number');
  if (!Array.isArray(cfg.localGate?.commands) || cfg.localGate.commands.some((c) => typeof c !== 'string')) p.push('localGate.commands must be a list of shell commands (strings)');
  if (!['always', 'unless-tree-equal'].includes(cfg.baseCiWait)) p.push('baseCiWait must be "always" or "unless-tree-equal"');
  if (!['apply', 'wait'].includes(cfg.postMergeOnRedBase)) p.push('postMergeOnRedBase must be "apply" or "wait"');
  if (!Array.isArray(cfg.sessionEnvDeny)) p.push('sessionEnvDeny must be a list of environment variable names');
  return p;
}

/** "2.1.319 (Claude Code)" → 2001319, for comparisons. 0 when unparseable. */
export function versionNumber(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}
