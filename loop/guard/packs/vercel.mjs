// Guard pack: Vercel. The loop reads deployments; settings, domains and production deploys are
// the owner's.
//
// The rule id keeps its `core:` prefix: it was a core rule before packs existed, and the guard
// log, the LEARN signatures and the tests name it.

import { no } from '../shared.mjs';

export const name = 'vercel';

export function mcp(tool) {
  if (/vercel/i.test(tool) && !/^(get|list|search|web_fetch|aggregate|count|filter)/i.test(tool.split('__').pop())) {
    return no('core:vercel-write', 'Vercel settings and deployments are the owner\'s; the loop only reads them.');
  }
  return null;
}

export function shell(c) {
  if (/(^|[;&|(]\s*|\bnpx\s+|\bpnpm\s+(dlx\s+|exec\s+)?)vercel\s+(env|deploy\b[^;&|]*--prod|promote|rollback|domains?|alias|remove|rm|project|link)\b/i.test(c)) return no('core:vercel-write', 'Vercel settings and production deploys are the owner\'s.');
  return null;
}
