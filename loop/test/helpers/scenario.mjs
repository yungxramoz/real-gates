// What the runner scenarios (run.*.test.mjs) share: a sandbox that is removed when the file's
// tests are over, and the session steps most of them script.
//
// The scenarios are spread over several files by what they are about, and that is what keeps the
// suite short. `node --test` runs files side by side and the tests of one file one after another,
// and a scenario starts a few hundred child processes: in one file they took a quarter of an hour
// on Windows, where starting a process is slow. A new scenario goes into the file of its subject;
// a file that has grown much longer than the others is split.

import { after } from 'node:test';

import { makeSandbox } from './sandbox.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.cleanup()));
export const box = (o) => {
  const sb = makeSandbox(o);
  boxes.push(sb);
  return sb;
};
export const changes = (category = 'tests') => ({ structured: { verdict: 'changes', blocking: [{ file: 'src/a.ts', issue: 'no test for the new branch', fix: 'add one', category, cause: 'Untested branch' }], summary: 'needs tests' } });
export const fixRound = (id) => ({ commit: { branch: '$OPEN', files: { [`src/${id}-fix-${Math.random().toString(36).slice(2, 6)}.txt`]: 'fix\n' }, message: 'fix' }, result: { item: id, outcome: 'ready', pr: '$PR', summary: 'fixed' } });
export const mergedFiles = (sb) => sb.originGit('ls-tree', '-r', '--name-only', 'develop').split('\n');
