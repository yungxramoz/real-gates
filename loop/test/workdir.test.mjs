// The working folders of the sessions (loop/lib/workdir.mjs): where they are, when they are
// emptied and when they go. A cleanup must never stop a run and never leave .loop/work/.

import { test, describe, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WORK_STEPS, createWork, folderName } from '../lib/workdir.mjs';

const tmps = [];
after(() => tmps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-work-'));
  tmps.push(root);
  const run = path.join(root, '.loop');
  const gitCalls = [];
  const logs = [];
  const work = createWork({ root, run, git: (...a) => gitCalls.push(a.join(' ')), log: (l) => logs.push(l) });
  const put = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const has = (rel) => fs.existsSync(path.join(root, rel));
  return { root, run, work, gitCalls, logs, put, has };
}

describe('the working folder of a session', () => {
  test('a prompt names it from the repository root, with forward slashes', () => {
    const { work } = sandbox();
    assert.equal(work.path('E1-1', 'build'), '.loop/work/E1-1/build');
    assert.equal(work.path('M2', 'accept'), '.loop/work/M2/accept');
    assert.equal(work.path('R-03', 'retro'), '.loop/work/R-03/retro');
  });

  test('every step of a session has one, the permission check has none', () => {
    const { work, has } = sandbox();
    assert.deepEqual([...WORK_STEPS].sort(), ['accept', 'build', 'packet', 'retro', 'review']);
    for (const step of WORK_STEPS) {
      work.prepare('X1', step);
      assert.ok(has(`.loop/work/X1/${step}`), step);
    }
    work.prepare('preflight', 'smoke');
    work.prepare(undefined, 'build');
    assert.equal(has('.loop/work/preflight'), false);
    assert.deepEqual(fs.readdirSync(path.join(sandbox().run, '..')), [], 'nothing is created before a session asks');
  });

  test('a build folder keeps what the round before left; every other step starts empty', () => {
    const { work, put, has } = sandbox();
    for (const step of WORK_STEPS) {
      work.prepare('X1', step);
      put(`.loop/work/X1/${step}/left.txt`);
      put(`.loop/work/X1/${step}/app/node_modules/pkg/index.js`);
      work.prepare('X1', step);
      assert.equal(has(`.loop/work/X1/${step}/left.txt`), step === 'build', step);
      assert.ok(has(`.loop/work/X1/${step}`), `${step}: the folder is there again`);
    }
  });

  test('done removes the named steps, and the id folder once nothing is left in it', () => {
    const { work, put, has, gitCalls } = sandbox();
    put('.loop/work/E1/build/body.md');
    put('.loop/work/E1/review/notes.txt');
    put('.loop/work/E1/accept/app/x');
    work.done('E1', 'build', 'review');
    assert.deepEqual([has('.loop/work/E1/build'), has('.loop/work/E1/review'), has('.loop/work/E1/accept/app/x')], [false, false, true]);
    assert.deepEqual(gitCalls, ['worktree prune', 'worktree prune'], 'git forgets a worktree that went with a folder');
    work.done('E1', 'accept');
    assert.equal(has('.loop/work/E1'), false);
    // nothing there: nothing happens, and git is not asked
    gitCalls.length = 0;
    work.done('E1', 'build', 'review');
    work.done('never-seen', 'build');
    assert.deepEqual(gitCalls, []);
  });

  test('an id never names a folder outside .loop/work/', () => {
    const { root, work, put, has } = sandbox();
    put('keep.txt');
    put('.loop/state.json', '{}');
    put('.loop/work/other/build/keep.txt');
    for (const id of ['..', '../..', '.', '', '/', '\\', '../../keep.txt', 'a/../../..', '..\\..', 'C:\\Windows', '/etc', '. .', '...']) {
      const p = work.path(id, 'build');
      assert.match(p, /^\.loop\/work\/[A-Za-z0-9._-]+\/build$/, `${JSON.stringify(id)} → ${p}`);
      assert.doesNotMatch(p, /\/\.+\//, `${JSON.stringify(id)} → ${p}`);
      work.prepare(id, 'review');
      work.done(id, 'build', 'review', 'accept', 'packet', 'retro');
    }
    assert.ok(has('keep.txt') && has('.loop/state.json') && has('.loop/work/other/build/keep.txt'));
    assert.deepEqual(fs.readdirSync(root).sort(), ['.loop', 'keep.txt']);
    assert.equal(folderName('E1.2'), 'E1.2');
    assert.equal(folderName('ACC-M1-1-1'), 'ACC-M1-1-1');
    assert.equal(folderName('feat/x y'), 'feat-x-y');
    assert.equal(folderName(folderName('a//b..')), folderName('a//b..'), 'a name that is already a folder name stays as it is');
  });

  test('at run start, what a killed run left of finished things goes; the rest stays', () => {
    const { work, put, has } = sandbox();
    put('.loop/work/A1/build/body.md'); // done
    put('.loop/work/A1/review/notes.txt');
    put('.loop/work/A2/build/body.md'); // still being built
    put('.loop/work/M1/accept/app/x'); // packed
    put('.loop/work/M1/packet/x');
    put('.loop/work/M2/accept/app/x'); // not packed yet
    put('.loop/work/R-01/retro/notes.md'); // no retro is being held at run start
    work.sweep({ items: ['A1'], milestones: ['M1'] });
    assert.deepEqual([has('.loop/work/A1'), has('.loop/work/M1'), has('.loop/work/R-01')], [false, false, false]);
    assert.ok(has('.loop/work/A2/build/body.md') && has('.loop/work/M2/accept/app/x'));
    // with no work folder at all there is nothing to do
    assert.doesNotThrow(() => sandbox().work.sweep({ items: ['A1'], milestones: ['M1'] }));
    assert.doesNotThrow(() => sandbox().work.sweep());
  });

  test('a folder that cannot be removed is reported and does not stop the run', () => {
    const { work, put, has, logs, gitCalls } = sandbox();
    put('.loop/work/E1/review/held.txt');
    const rm = mock.method(fs, 'rmSync', () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    try {
      assert.doesNotThrow(() => work.done('E1', 'review'));
      assert.doesNotThrow(() => work.prepare('E1', 'review'));
    } finally {
      rm.mock.restore();
    }
    assert.ok(has('.loop/work/E1/review/held.txt'));
    assert.equal(logs.length, 2);
    assert.match(logs[0], /could not remove \.loop\/work\/E1\/review: EBUSY/);
    assert.deepEqual(gitCalls, [], 'nothing was removed, so git is not asked to forget anything');
  });

  test('a link in a working folder is removed, never what it points at', () => {
    const { root, work, put, has } = sandbox();
    put('src/keep.txt');
    work.prepare('E1', 'build');
    // a junction on Windows, a symbolic link elsewhere: both need no special rights
    fs.symlinkSync(path.join(root, 'src'), path.join(root, '.loop', 'work', 'E1', 'build', 'src'), 'junction');
    assert.ok(has('.loop/work/E1/build/src/keep.txt'), 'the link works');
    work.done('E1', 'build');
    assert.equal(has('.loop/work/E1'), false);
    assert.ok(has('src/keep.txt'));
  });

  test('a temporary worktree a session left in its folder is gone for git too', () => {
    const { root, run, has } = sandbox();
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Loop Tester', '-c', 'user.email=loop@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const work = createWork({ root, run, git });
    work.prepare('E1', 'review');
    const wt = `${work.path('E1', 'review')}/wt`;
    assert.equal(git('worktree', 'add', '-q', '--detach', wt).status, 0);
    assert.match(git('worktree', 'list').stdout, /work\/E1\/review\/wt/);
    // the next review session starts over: the folder is empty and the same worktree can be added again
    work.prepare('E1', 'review');
    assert.equal(has(wt), false);
    assert.doesNotMatch(git('worktree', 'list').stdout, /work\/E1\/review\/wt/);
    assert.equal(git('worktree', 'add', '-q', '--detach', wt).status, 0);
    work.done('E1', 'build', 'review');
    assert.equal(has('.loop/work/E1'), false);
    assert.doesNotMatch(git('worktree', 'list').stdout, /work\/E1/);
  });
});
