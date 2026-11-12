#!/usr/bin/env node
// A fake `gh` for the runner suite. State lives in $LOOP_FAKE_DIR/gh-state.json; merges are real
// squash merges into the sandbox's bare origin, so the landed check runs against real git.
//
// State: { repo, origin, base, nextPr, prs: {n: {...}}, ci: {sha: conclusion|'pending'|'starved'},
//          ciQueue: [...], baseCiQueue: [...], dirty: [prNumbers], tamperMerge: bool, calls: [] }
// A PR head the fake has not seen takes its CI result from ciQueue (default "success"); a base
// commit takes it from baseCiQueue (default "success"). "pending" never completes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.LOOP_FAKE_DIR;
const FILE = path.join(DIR, 'gh-state.json');
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const save = (s) => fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const out = (v) => {
  process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
  process.exit(0);
};
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};

const args = process.argv.slice(2);
const S = load();
S.calls = [...(S.calls || []), args.join(' ')].slice(-400);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const headOf = (pr) => {
  const r = spawnSync('git', ['rev-parse', `refs/heads/${pr.headRefName}`], { cwd: S.origin, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : pr.headRefOid;
};
let runSeq = Object.keys(S.runs || {}).length + 1000;
function ciFor(sha, queueName) {
  S.ci ||= {};
  S.runs ||= {};
  if (!(sha in S.ci)) {
    S.ci[sha] = (S[queueName] || []).shift() || 'success';
    const id = String(runSeq++);
    S.runs[id] = { sha };
    S.ci[`run:${sha}`] = id;
  }
  return { conclusion: S.ci[sha], runId: S.ci[`run:${sha}`] };
}
const url = (id) => `https://github.com/${S.repo}/actions/runs/${id}/job/1`;

try {
  const [a0, a1] = args;
  if (a0 === 'auth' && a1 === 'status') {
    save(S);
    out('Logged in to github.com as tester');
  }

  if (a0 === 'pr' && a1 === 'view') {
    const pr = S.prs[args[2]];
    if (!pr) fail(`no pull requests found for ${args[2]}`);
    const head = pr.state === 'OPEN' ? headOf(pr) : pr.headRefOid;
    pr.headRefOid = head;
    const { conclusion, runId } = ciFor(head, 'ciQueue');
    const done = conclusion !== 'pending';
    const mapped = { success: 'SUCCESS', failure: 'FAILURE', starved: 'CANCELLED' }[conclusion] || 'FAILURE';
    const rollup = [{ __typename: 'CheckRun', name: S.ciCheck || 'ci', status: done ? 'COMPLETED' : 'IN_PROGRESS', conclusion: done ? mapped : null, detailsUrl: url(runId) }];
    save(S);
    out({ ...pr, mergeStateStatus: (S.dirty || []).includes(pr.number) ? 'DIRTY' : 'CLEAN', statusCheckRollup: rollup, url: `https://github.com/${S.repo}/pull/${pr.number}` });
  }

  if (a0 === 'pr' && a1 === 'merge') {
    const pr = S.prs[args[2]];
    const match = opt('--match-head-commit');
    const head = headOf(pr);
    if (pr.state !== 'OPEN') fail('PR is not open');
    if (match && match !== head) fail('Head branch was modified. Review and try the merge again.');
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-fakegh-'));
    git(wt, 'clone', '-q', S.origin, '.');
    git(wt, 'config', 'user.email', 'merger@example.com');
    git(wt, 'config', 'user.name', 'Merger');
    git(wt, 'checkout', '-q', pr.baseRefName);
    git(wt, 'merge', '--squash', `origin/${pr.headRefName}`);
    if (S.tamperMerge) fs.writeFileSync(path.join(wt, 'TAMPERED.txt'), 'not reviewed\n');
    if (S.tamperWhitespace) {
      const first = git(wt, 'diff', '--cached', '--name-only').split('\n')[0];
      fs.writeFileSync(path.join(wt, first), fs.readFileSync(path.join(wt, first), 'utf8').replace(/^/gm, '    '));
    }
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', `${pr.title} (#${pr.number})`);
    git(wt, 'push', '-q', 'origin', pr.baseRefName);
    const sha = git(wt, 'rev-parse', 'HEAD');
    if (args.includes('--delete-branch')) git(S.origin, 'branch', '-D', pr.headRefName);
    fs.rmSync(wt, { recursive: true, force: true });
    Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: sha }, headRefOid: head });
    save(S);
    out(`✓ Squashed and merged pull request #${pr.number}`);
  }

  if (a0 === 'pr' && a1 === 'review') {
    S.reviews = [...(S.reviews || []), { pr: args[2] }];
    save(S);
    out('');
  }

  if (a0 === 'pr' && a1 === 'create') {
    // Used by the fake claude (and a careless agent): register a PR for --head or the current branch.
    const head = opt('--head') || git(process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD');
    const n = S.nextPr || 1;
    S.nextPr = n + 1;
    S.prs[n] = { number: n, state: 'OPEN', baseRefName: opt('--base') || S.base, headRefName: head, headRefOid: '', title: opt('--title') || head, isDraft: false, mergeCommit: null };
    save(S);
    out(`https://github.com/${S.repo}/pull/${n}`);
  }

  if (a0 === 'api') {
    const p = args[1];
    let m;
    if ((m = p.match(/commits\/([0-9a-f]+)\/check-runs/))) {
      const { conclusion, runId } = ciFor(m[1], 'baseCiQueue');
      const done = conclusion !== 'pending';
      save(S);
      out({ check_runs: [{ name: S.ciCheck || 'ci', status: done ? 'completed' : 'in_progress', conclusion: done ? ({ starved: 'cancelled' }[conclusion] || conclusion) : null, details_url: url(runId) }] });
    }
    if ((m = p.match(/actions\/runs\/(\d+)\/jobs/))) {
      const sha = S.runs?.[m[1]]?.sha;
      const c = S.ci?.[sha];
      save(S);
      out({ jobs: [{ name: c === 'failure' ? 'unit tests' : 'ci', conclusion: c === 'starved' ? 'cancelled' : c, runner_name: c === 'starved' ? null : 'runner-1' }] });
    }
    if ((m = p.match(/\/rules\/branches\/(.+)$/))) {
      save(S);
      out((S.rulesets || {})[m[1]] || []);
    }
    if ((m = p.match(/\/branches\/([^/]+)$/))) {
      save(S);
      out({ name: m[1], protected: !(S.unprotected || []).includes(m[1]) });
    }
    fail(`fake gh: unknown api path ${p}`);
  }

  if (a0 === 'run' && a1 === 'view') {
    save(S);
    out('unit tests\tRun tests\tAssertionError: expected 2 to equal 3\n');
  }
  if (a0 === 'run' && a1 === 'rerun') {
    const sha = S.runs?.[args[2]]?.sha;
    if (sha) S.ci[sha] = (S.rerunQueue || []).shift() || 'success';
    save(S);
    out('');
  }

  save(S);
  fail(`fake gh: unsupported command: ${args.join(' ')}`);
} catch (e) {
  fail(`fake gh crashed: ${e.stack || e}`);
}
