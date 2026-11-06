// Child processes: git, gh, supabase and claude, with the loop's environment.
//
// LOOP_GH_BIN, LOOP_SUPABASE_BIN and LOOP_CLAUDE_BIN override the binaries (the test suite points
// them at fakes). A value ending in .mjs or .js runs through this Node.

import { spawnSync } from 'node:child_process';

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
  const sbRun = run('supabase');
  return {
    sh,
    git: (...a) => sh('git', a).out,
    gitTry: (...a) => sh('git', a, { allowFail: true }),
    gh: (...a) => ghRun(a).out,
    ghTry: (...a) => ghRun(a, { allowFail: true }),
    ghJson: (...a) => JSON.parse(ghRun(a).out || 'null'),
    supabase: (args, opts = {}) => sbRun(args, { allowFail: true, ...opts }),
  };
}
