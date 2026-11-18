// The working folder of a session.
//
// A session may write freely under .loop/, and a read-only step nowhere else. Without a folder of
// its own, every session invents names beside the runner's files (a PR body, a probe script, a
// copy of the package) and nothing ever removes them. So the runner names one folder per step in
// the prompt, creates it before the session, and removes it when what the step worked on is
// finished:
//
//   .loop/work/<id>/<step>/    id: an item, a milestone or a retro
//                              step: build, review, accept, packet or retro
//
// Nothing here is a gate: the guard does not refuse a file written elsewhere under .loop/. A
// removal that fails is logged and never stops the run.

import fs from 'node:fs';
import path from 'node:path';

/** Steps that start in an empty folder every time: an independent look, or a fresh install. */
const FRESH = new Set(['review', 'accept', 'packet', 'retro']);
/** Steps that have a folder at all. The permission check at run start has none. */
export const WORK_STEPS = new Set(['build', ...FRESH]);

/** An id as one folder name: nothing that leaves the folder and nothing a file system refuses. */
export function folderName(id) {
  const n = String(id ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return n || 'unnamed';
}

/**
 * root: the repository · run: its .loop folder · git(...args): runs git there and never throws ·
 * log(line): the runner's console.
 */
export function createWork({ root, run, git = () => {}, log = () => {} }) {
  const base = path.join(run, 'work');
  const dirOf = (id, step) => path.join(base, folderName(id), folderName(step));
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

  function remove(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      // retries: on Windows a scanner or a process the session left behind can hold a file for a moment
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      log(`⚠ could not remove ${rel(dir)}: ${e.message}`);
      return;
    }
    git('worktree', 'prune'); // a temporary worktree went with the folder: git forgets it too
  }
  /** The folder of an id goes once no step is left in it. */
  function removeIfEmpty(id) {
    try {
      fs.rmdirSync(path.join(base, folderName(id)));
    } catch {}
  }

  /** What these steps kept for `id` is removed: the item is done, the milestone packed, the retro over. */
  function done(id, ...steps) {
    for (const step of steps) remove(dirOf(id, step));
    removeIfEmpty(id);
  }

  return {
    done,
    /** The folder as a prompt names it: from the repository root, with forward slashes. */
    path: (id, step) => rel(dirOf(id, step)),
    /** Before a session: its folder exists, and is empty for a step that starts over. */
    prepare(id, step) {
      if (!id || !WORK_STEPS.has(step)) return;
      const dir = dirOf(id, step);
      if (FRESH.has(step)) remove(dir);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        log(`⚠ could not create ${rel(dir)}: ${e.message}`);
      }
    },
    /**
     * At run start, when no session is running: what a killed run left of things that are
     * finished. No retro is being held, so every retro folder goes.
     */
    sweep({ items = [], milestones = [] } = {}) {
      for (const id of items) done(id, 'build', 'review');
      for (const m of milestones) done(m, 'accept', 'packet');
      let names = [];
      try {
        names = fs.readdirSync(base);
      } catch {}
      for (const name of names) done(name, 'retro');
    },
  };
}
