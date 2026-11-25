// Child processes: git, the forge's CLI, the agent's CLI and any tool an adapter needs, with the
// loop's environment.
//
// LOOP_<NAME>_BIN overrides a binary (LOOP_GH_BIN, LOOP_CLAUDE_BIN, LOOP_SUPABASE_BIN, …): the test
// suite points them at fakes. A value ending in .mjs or .js runs through this Node.

import { spawnSync } from 'node:child_process';

/**
 * What git prints when the network or the host failed, not the request: the same command a
 * moment later works. An unattended run must not end on one of these.
 */
export const TRANSIENT_GIT = /unable to access|could not resolve host|empty reply from server|connection (?:reset|timed out|refused|was reset)|operation timed out|early eof|rpc failed|the remote end hung up|ssl_|gnutls|schannel|http 5\d\d|returned error: 5\d\d|temporary failure/i;
/** Git commands that talk to the remote. */
const REMOTE_GIT = new Set(['fetch', 'pull', 'ls-remote']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * What gh prints when it could not reach GitHub or GitHub failed for a moment: the same call a
 * little later works. A run once ended on `gh pr view` → "dial tcp …: connectex: …" while the
 * machine's network came back minutes later.
 */
export const TRANSIENT_GH = /dial tcp|connectex|could not resolve host|no such host|error connecting to|i\/o timeout|tls handshake timeout|connection (?:reset|refused|timed out)|unexpected eof|": eof\b|http 50[234]\b|bad gateway|service unavailable|gateway time-?out/i;
/** The request never reached GitHub: sending it again cannot do anything twice. */
export const UNSENT_GH = /dial tcp|connectex|could not resolve host|no such host|error connecting to/i;
/** Waits between gh tries, in units of LOOP_GH_RETRY_MS (5 s): about eight minutes in all. */
const GH_WAITS = [1, 4, 12, 24, 60];

/**
 * A gh call that only reads. Any other (a merge, a review, a re-run) may have reached GitHub
 * before the network failed, so it is sent again only when it never left (UNSENT_GH).
 */
export function ghReads(args) {
  const [cmd, sub] = args;
  if (cmd === 'auth') return sub === 'status';
  if (cmd === 'pr') return ['view', 'list', 'checks', 'diff'].includes(sub);
  if (cmd === 'run') return ['view', 'list'].includes(sub);
  if (cmd !== 'api') return false;
  const m = args.findIndex((a) => a === '-X' || a === '--method');
  if (m !== -1) return String(args[m + 1]).toUpperCase() === 'GET';
  // gh api sends a POST as soon as it has a field or a body
  return !args.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a));
}

/** { cmd, pre } for a binary name, honouring the LOOP_<NAME>_BIN override. */
export function binary(name, env = process.env) {
  const over = env[`LOOP_${name.toUpperCase()}_BIN`];
  if (over) return /\.(m?js)$/i.test(over) ? { cmd: process.execPath, pre: [over] } : { cmd: over, pre: [] };
  return { cmd: name, pre: [] };
}

export function createProc({ root, env = () => process.env }) {
  function sh(cmd, args, { allowFail = false, input, timeoutMs = 10 * 60_000, cwd = root, raw = false } = {}) {
    const r = spawnSync(cmd, args, { cwd, encoding: raw ? 'buffer' : 'utf8', input, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: env(), windowsHide: true });
    if (r.error && !allowFail) throw r.error;
    if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}\n${String(r.stderr || '').slice(-2000)}`);
    if (raw) return { ok: r.status === 0, out: r.stdout, err: String(r.stderr || ''), code: r.status };
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
  }
  const run = (name) => (args, opts) => {
    const b = binary(name, env());
    return sh(b.cmd, [...b.pre, ...args], opts);
  };
  const ghRun = run('gh');
  const gitRun = run('git');
  /**
   * git, with a remote command tried again when the network failed: after 5, 20 and 60 seconds
   * (LOOP_GIT_RETRY_MS sets the first wait). Any other failure is returned as it is.
   */
  function git(args, { allowFail }) {
    const first = Number(env().LOOP_GIT_RETRY_MS ?? 5000);
    const waits = REMOTE_GIT.has(args[0]) ? [first, first * 4, first * 12] : [];
    for (let attempt = 0; ; attempt++) {
      const r = gitRun(args, { allowFail: true });
      if (r.ok) return r;
      if (attempt < waits.length && TRANSIENT_GIT.test(r.err)) {
        pause(waits[attempt]);
        continue;
      }
      if (allowFail) return r;
      throw new Error(`git ${args.join(' ')} → exit ${r.code}${attempt ? ` (after ${attempt + 1} tries)` : ''}\n${r.err.slice(-2000)}`);
    }
  }
  /**
   * gh, tried again when GitHub could not be reached: a read after any network failure, a write
   * only when it never left (LOOP_GH_RETRY_MS sets the unit of the waits). Any other failure is
   * returned as it is.
   */
  function gh(args, { allowFail }) {
    const unit = Number(env().LOOP_GH_RETRY_MS ?? 5000);
    const again = ghReads(args) ? TRANSIENT_GH : UNSENT_GH;
    for (let attempt = 0; ; attempt++) {
      const r = ghRun(args, { allowFail: true });
      if (r.ok) return r;
      if (attempt < GH_WAITS.length && again.test(`${r.err}\n${r.out}`)) {
        pause(unit * GH_WAITS[attempt]);
        continue;
      }
      if (allowFail) return r;
      throw new Error(`gh ${args.join(' ')} → exit ${r.code}${attempt ? ` (after ${attempt + 1} tries)` : ''}\n${r.err.slice(-2000)}`);
    }
  }
  return {
    sh,
    git: (...a) => git(a, { allowFail: false }).out,
    gitTry: (...a) => git(a, { allowFail: true }),
    gh: (...a) => gh(a, { allowFail: false }).out,
    ghTry: (...a) => gh(a, { allowFail: true }),
    ghJson: (...a) => JSON.parse(gh(a, { allowFail: false }).out || 'null'),
    /** Any other command-line tool an adapter drives. Never throws: the adapter judges the result. */
    tool: (name, args, opts = {}) => run(name)(args, { allowFail: true, ...opts }),
  };
}
