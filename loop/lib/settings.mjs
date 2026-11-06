// The settings every loop session starts with, and the guard snapshot they point at.

import fs from 'node:fs';
import path from 'node:path';

import { writeJson } from './state.mjs';

/** The guard and the modules it imports, at their repo paths. */
export const GUARD_FILES = ['loop/guard.mjs', 'loop/guard/core.mjs', 'loop/guard/sql.mjs', 'loop/guard/paths.mjs', 'loop/guard/rules.mjs', 'loop/lib/config.mjs'];

/**
 * Copy the guard from origin/<base> into .loop/guard/ (a protected path), so a working-tree edit
 * cannot switch a rule off mid-session. Before the base has the guard (the very first run of a
 * fresh template) it copies the working tree and says so.
 */
export function snapshotGuard(root, base, proc) {
  const dir = path.join(root, '.loop', 'guard');
  fs.rmSync(dir, { recursive: true, force: true });
  let fromTree = false;
  for (const rel of GUARD_FILES) {
    const r = proc.gitTry('show', `origin/${base}:${rel}`);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (r.ok) fs.writeFileSync(dest, r.out + '\n');
    else {
      fromTree = true;
      fs.copyFileSync(path.join(root, rel), dest);
    }
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  return { dir, entry: path.join(dir, 'loop', 'guard.mjs'), fromTree };
}

export function sessionSettings(guardEntry) {
  return {
    // Everything the loop learns goes into committed files. Machine-local memory would steer later
    // sessions invisibly, and differently on every machine.
    autoMemoryEnabled: false,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__.*',
          // If the guard cannot start or crashes, the tool call is refused (fail closed).
          hooks: [{ type: 'command', command: `node "${guardEntry.replace(/\\/g, '/')}"`, timeout: 15, onFailure: 'block' }],
        },
      ],
    },
    permissions: {
      deny: ['Bash(gh pr merge:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(supabase db push:*)', 'Bash(supabase db reset:*)', 'mcp__supabase__apply_migration'],
    },
  };
}

export function writeSettings(file, guardEntry) {
  writeJson(file, sessionSettings(guardEntry));
}
