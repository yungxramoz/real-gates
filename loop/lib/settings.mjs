// The settings every loop session starts with, the guard snapshot they point at, and the integrity
// check the runner makes after every session.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeJson } from './state.mjs';
import { packDeny } from '../guard/packs/index.mjs';

/** The guard and the modules it imports, at their repo paths. */
export const GUARD_FILES = ['loop/guard.mjs', 'loop/guard/core.mjs', 'loop/guard/shared.mjs', 'loop/guard/paths.mjs', 'loop/guard/rules.mjs', 'loop/guard/packs/index.mjs', 'loop/guard/packs/postgres-sql.mjs', 'loop/guard/packs/github.mjs', 'loop/guard/packs/npm.mjs', 'loop/guard/packs/supabase.mjs', 'loop/guard/packs/vercel.mjs', 'loop/lib/config.mjs', 'loop/lib/stack.mjs'];

/**
 * The files as they are on origin/<base>: a Buffer each, in the order asked, or null for one the
 * base does not have. One git process reads them all (`cat-file --batch` answers every name on its
 * input, in order): a snapshot is taken before every session, and a process per file is what a run
 * and its test suite spend their time on where starting a process is slow (Windows).
 */
export function baseFiles(base, rels, proc) {
  // the names go in as bytes: with a raw (Buffer) answer, Node takes no string for the input
  const names = Buffer.from(rels.map((rel) => `origin/${base}:${rel}\n`).join(''), 'utf8');
  const r = proc.sh('git', ['cat-file', '--batch'], { allowFail: true, raw: true, input: names });
  const out = r.ok && Buffer.isBuffer(r.out) ? r.out : Buffer.alloc(0);
  let at = 0;
  return rels.map(() => {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) return null; // git gave no answer for this name
    // "<object id> <type> <size>", then the content and a newline; anything else ("<name> missing")
    // is one line saying the base does not have it
    const found = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(out.toString('utf8', at, eol));
    at = eol + 1;
    if (!found) return null;
    const size = Number(found[2]);
    const content = out.subarray(at, at + size);
    at += size + 1;
    return found[1] === 'blob' && content.length === size ? content : null;
  });
}

/**
 * Copy the guard from origin/<base> into .loop/guard/ (a protected path), with the runner's own
 * config beside it, so neither a working-tree edit nor a config edit can switch a rule off. Before
 * the base has the guard (the first run of a fresh template) it copies the working tree and says so.
 */
export function snapshotGuard(root, cfg, proc) {
  const dir = path.join(root, '.loop', 'guard');
  fs.rmSync(dir, { recursive: true, force: true });
  let fromTree = false;
  const onBase = baseFiles(cfg.base, GUARD_FILES, proc);
  for (const [i, rel] of GUARD_FILES.entries()) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (onBase[i]) fs.writeFileSync(dest, onBase[i]);
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
