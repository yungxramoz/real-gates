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
  return {
    sh,
    git: (...a) => git(a, { allowFail: false }).out,
    gitTry: (...a) => git(a, { allowFail: true }),
    gh: (...a) => ghRun(a).out,
    ghTry: (...a) => ghRun(a, { allowFail: true }),
    ghJson: (...a) => JSON.parse(ghRun(a).out || 'null'),
    /** Any other command-line tool an adapter drives. Never throws: the adapter judges the result. */
    tool: (name, args, opts = {}) => run(name)(args, { allowFail: true, ...opts }),
  };
}
