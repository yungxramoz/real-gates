// Guard packs: the rules for one tool or service, switched on by name in `guard.packs`.
//
// The core (../core.mjs) holds what every project needs whatever it is built with: git, the
// harness files, the read-only steps. A pack holds the rest. A profile lists the packs its stack
// needs; a pack that is not listed does not run.
//
// A pack is a module that exports:
//   name             the name `guard.packs` uses
//   deny?            Claude Code permission rules added to every session's settings (a second lock)
//   mcp?(tool, input, ctx)   -> { block: true, rule, reason } | null, for an `mcp__…` tool call
//   shell?(command, ctx)     -> the same, for a shell command (already normalised by the core)
//   configProblems?(cfg)     -> plain sentences for what the pack needs in the config
//
// Packs can only block. Nothing in a pack can allow what the core refuses. A new pack is a new
// file here plus one line in PACKS and one in GUARD_FILES (../../lib/settings.mjs), so it is part
// of the snapshot the runner checks after every session.

import * as github from './github.mjs';
import * as supabase from './supabase.mjs';
import * as vercel from './vercel.mjs';

export const PACKS = { [github.name]: github, [supabase.name]: supabase, [vercel.name]: vercel };

/** The pack modules for these names, in order. Throws on an unknown name: the guard fails closed. */
export function loadPacks(names) {
  return (names || []).map((n) => {
    if (!PACKS[n]) throw new Error(`unknown guard pack "${n}" (known: ${Object.keys(PACKS).join(', ')})`);
    return PACKS[n];
  });
}

/** Unknown pack names and whatever each listed pack still needs in the config. */
export function packProblems(cfg) {
  const names = cfg.guard?.packs;
  if (!Array.isArray(names)) return ['guard.packs must be a list of guard pack names'];
  const p = [];
  for (const n of names) {
    if (!PACKS[n]) p.push(`guard.packs: "${n}" is not a guard pack (known: ${Object.keys(PACKS).join(', ')})`);
    else p.push(...(PACKS[n].configProblems?.(cfg) || []));
  }
  return p;
}

/** Permission deny rules of the listed packs, for the generated session settings. */
export function packDeny(cfg) {
  return (cfg?.guard?.packs || []).flatMap((n) => PACKS[n]?.deny || []);
}
