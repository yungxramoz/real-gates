// Post-merge adapters, by the name loop.config.json uses in postMerge[].adapter.
// An adapter exports `name` and `run(ctx, { mergeSha, item, step }) -> { ok, note? } | { ok: false, why, ownerAction }`.

import * as supabaseCli from './postmerge-supabase-cli.mjs';

export const POST_MERGE = { [supabaseCli.name]: supabaseCli };

export function postMergeAdapter(name) {
  const a = POST_MERGE[name];
  if (!a) throw new Error(`unknown post-merge adapter "${name}" (known: ${Object.keys(POST_MERGE).join(', ')})`);
  return a;
}
