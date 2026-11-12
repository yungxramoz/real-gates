// Adapters, by the name the profile and loop.config.json use. The core loop only ever calls these
// interfaces; what stands behind them (which forge, which host, which database tool) is the
// profile's choice. Each adapter file documents its interface at the top.
//
//   forge.adapter        pull requests, CI results, the merge           forge-github.mjs
//   deploy.adapter       "does the dev site serve this commit?"         deploy-http-health.mjs, none
//   postMerge[].adapter  steps the runner takes after a merge           postmerge-supabase-cli.mjs
//   notify.adapter       a message to the owner                         notify-ntfy.mjs, none
//
// A new adapter is a new file here and one line in its table below.

import * as supabaseCli from './postmerge-supabase-cli.mjs';
import * as github from './forge-github.mjs';
import * as httpHealth from './deploy-http-health.mjs';
import * as ntfy from './notify-ntfy.mjs';

/** Post-merge: `run(ctx, { mergeSha, item, step }) -> { ok, note? } | { ok: false, why, ownerAction }`. */
export const POST_MERGE = { [supabaseCli.name]: supabaseCli };
export const FORGE = { [github.name]: github };
/** `none`: the project has no deployed site, so there is nothing to wait for and no acceptance on one. */
export const DEPLOY = { [httpHealth.name]: httpHealth, none: { name: 'none', waitUntilServing: async () => ({ ok: true }) } };
export const NOTIFY = { [ntfy.name]: ntfy, none: { name: 'none', send: async () => {} } };

function pick(table, kind, name) {
  const a = table[name];
  if (!a) throw new Error(`unknown ${kind} adapter "${name}" (known: ${Object.keys(table).join(', ')})`);
  return a;
}

export const postMergeAdapter = (name) => pick(POST_MERGE, 'post-merge', name);
export const forgeAdapter = (name) => pick(FORGE, 'forge', name || 'github');
export const deployAdapter = (name) => pick(DEPLOY, 'deploy', name || 'http-health');
export const notifyAdapter = (name) => pick(NOTIFY, 'notify', name || 'ntfy');

/** Adapter names in the config that no table knows, as plain sentences for the preflight. */
export function adapterProblems(cfg) {
  const p = [];
  const check = (table, kind, name) => {
    if (name && !table[name]) p.push(`${kind} adapter "${name}" is unknown (known: ${Object.keys(table).join(', ')})`);
  };
  check(FORGE, 'forge', cfg.forge?.adapter);
  check(DEPLOY, 'deploy', cfg.deploy?.adapter);
  check(NOTIFY, 'notify', cfg.notify?.adapter);
  for (const s of cfg.postMerge || []) check(POST_MERGE, 'postMerge', s.adapter);
  return p;
}
