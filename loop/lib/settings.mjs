// The settings every loop session starts with, the guard snapshot they point at, and the integrity
// check the runner makes after every session.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeJson } from './state.mjs';
import { packDeny } from '../guard/packs/index.mjs';

/** The guard and the modules it imports, at their repo paths. */
export const GUARD_FILES = ['loop/guard.mjs', 'loop/guard/core.mjs', 'loop/guard/shared.mjs', 'loop/guard/paths.mjs', 'loop/guard/rules.mjs', 'loop/guard/packs/index.mjs', 'loop/guard/packs/postgres-sql.mjs', 'loop/guard/packs/github.mjs', 'loop/guard/packs/npm.mjs', 'loop/guard/packs/supabase.mjs', 'loop/guard/packs/vercel.mjs', 'loop/lib/config.mjs'];

/**
 * Copy the guard from origin/<base> into .loop/guard/ (a protected path), with the runner's own
 * config beside it, so neither a working-tree edit nor a config edit can switch a rule off. Before
 * the base has the guard (the first run of a fresh template) it copies the working tree and says so.
 */
export function snapshotGuard(root, cfg, proc) {
  const dir = path.join(root, '.loop', 'guard');
  fs.rmSync(dir, { recursive: true, force: true });
  let fromTree = false;
  for (const rel of GUARD_FILES) {
    const r = proc.sh('git', ['show', `origin/${cfg.base}:${rel}`], { allowFail: true, raw: true });
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (r.ok) fs.writeFileSync(dest, r.out);
    else {
      fromTree = true;
      fs.copyFileSync(path.join(root, rel), dest);
    }
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  const config = path.join(dir, 'config.json');
  writeJson(config, cfg);
  return { dir, entry: path.join(dir, 'loop', 'guard.mjs'), config, fromTree };
}

export function sessionSettings(guardEntry, cfg = {}) {
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
      // A second lock beside the guard: the core's own, plus what each guard pack in use adds.
      deny: ['Bash(git push --force:*)', 'Bash(git push -f:*)', ...packDeny(cfg)],
    },
  };
}

export function writeSettings(file, guardEntry, cfg) {
  writeJson(file, sessionSettings(guardEntry, cfg));
}

/** sha256 of each file (null when missing), for the after-session integrity check. */
export function fingerprint(files) {
  return Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null]));
}

/** Files whose fingerprint changed. */
export function changedFiles(before, after) {
  return Object.keys(before).filter((f) => before[f] !== after[f]);
}

/** Every file of the snapshot plus the session settings. */
export function harnessFiles(snapshot, settingsFile) {
  return [...GUARD_FILES.map((rel) => path.join(snapshot.dir, rel)), snapshot.config, settingsFile];
}
