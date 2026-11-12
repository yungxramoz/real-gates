// Guard pack: Supabase. One allowed project, read-only SQL from a session, and no session ever
// applies or resets a database: the runner applies merged migrations itself (the supabase-cli
// post-merge adapter).
//
// Rule ids keep their `core:` prefix: they were core rules before packs existed, and the guard
// log, the LEARN signatures and the tests name them.

import { sqlBlockReason } from './postgres-sql.mjs';
import { matchRules } from '../rules.mjs';
import { no } from '../shared.mjs';

export const name = 'supabase';

export const deny = ['Bash(supabase db push:*)', 'Bash(supabase db reset:*)', 'mcp__supabase__apply_migration'];

export function mcp(tool, input, ctx) {
  if (!/supabase/i.test(tool)) return null;
  const g = ctx.cfg.guard || {};
  const projectId = input.project_id || input.projectId || input.project_ref;
  if (projectId !== undefined && projectId !== g.allowedDbProject) return no('core:db-project', `only the configured Supabase project (${g.allowedDbProject || 'none configured'}) may be touched; got ${projectId}.`);
  if (/apply_migration$/i.test(tool)) return no('core:apply-migration', 'migrations are applied by the runner after merge, never by a session.');
  if (/(create_project|delete_branch|create_branch|merge_branch|reset_branch|rebase_branch|pause_project|restore_project|deploy_edge_function|create_edge_function_secret|delete_feedback)$/i.test(tool)) return no('core:db-admin', `${tool} is the owner's, not the loop's.`);
  if (/execute_sql$/i.test(tool)) {
    const reason = sqlBlockReason(input.query || input.sql || '', { allowWrite: false, schema: g.dbSchema || '' });
    if (reason) return no('core:sql', reason);
    const hit = matchRules(ctx.projectRules || [], 'sql', input.query || input.sql || '', ctx.phase);
    if (hit) return no(hit.id, hit.reason);
  }
  return null;
}

export function shell(c) {
  if (/\bsupabase\s+(db\s+(push|reset)|migration\s+(up|repair|squash))\b/i.test(c)) return no('core:db-apply', 'the runner applies migrations after merge; a session never applies or resets a database.');
  return null;
}

export function configProblems(cfg) {
  const p = [];
  const g = cfg.guard || {};
  const usesDb = (cfg.postMerge || []).some((s) => s.adapter === 'supabase-cli');
  if (usesDb && !g.allowedDbProject) p.push('guard.allowedDbProject: the one Supabase project ref the loop may touch');
  if ((g.forbiddenRefs || []).includes(g.allowedDbProject) && g.allowedDbProject) p.push('guard.forbiddenRefs contains guard.allowedDbProject');
  return p;
}
