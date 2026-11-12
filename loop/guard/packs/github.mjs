// Guard pack: GitHub through the `gh` CLI. Only the runner merges; repository settings, releases,
// secrets, branch protection and refs are the owner's.
//
// Rule ids keep their `core:` prefix: they were core rules before packs existed, and the guard
// log, the LEARN signatures and the tests name them.

import { READ_ONLY_PHASES, no } from '../shared.mjs';

export const name = 'github';

export const deny = ['Bash(gh pr merge:*)'];

export function shell(c, ctx) {
  if (/\bgh\s+pr\s+merge\b/i.test(c)) return no('core:merge', 'only the runner merges, after CI and review. Stop once the PR is open.');
  if (/\bgh\s+(repo\s+(delete|edit|rename|archive)|release\s+(create|delete|edit)|secret\s|variable\s|ruleset\s)/i.test(c)) return no('core:repo-admin', 'repository settings, releases, secrets and variables are the owner\'s.');
  if (/\bgh\s+api\b.*(-X|--method)\s*(DELETE|PUT|PATCH)/i.test(c)) return no('core:gh-api-write', 'mutating gh api calls are not allowed in the loop.');
  if (/\bgh\s+api\b.*(protection|rulesets|\/merges?\b|\/git\/refs)/i.test(c)) return no('core:gh-api-write', 'merges, branch protection, rulesets and refs are the owner\'s.');
  if (/\bgh\s+api\s+graphql\b.*\bmutation\b/i.test(c) || (/\bgh\s+api\s+graphql\b/i.test(c) && /--input|-F\s+query=@|-f\s+query=@/i.test(c))) return no('core:gh-api-write', 'GraphQL mutations are not allowed in the loop.');
  if (READ_ONLY_PHASES.has(ctx.phase) && /\bgh\s+pr\s+(close|edit|ready|merge|create|reopen)\b/i.test(c)) return no('core:read-only', `the ${ctx.phase} step may comment on PRs, not change them.`);
  return null;
}
