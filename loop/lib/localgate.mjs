// The local gate: the project's own check commands, run by the runner on the pushed branch head
// before it waits for CI.
//
// The build prompt tells the agent to prove its work locally. Nothing checked that it did, and a
// red CI costs a CI wait plus a whole fix session. So the runner runs `localGate.commands` itself.
// A failure goes back to a fix session with the output; CI still runs afterwards and stays the
// gate that decides the merge.
//
// The commands run code the agent wrote, so they get the same reduced environment as a session.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tail = (text, n) => String(text || '').split('\n').slice(-n).join('\n');

/** { ok: true, note? } | { ok: false, command, text } */
export function runLocalGate(L, item, s) {
  const commands = (L.cfg.localGate?.commands || []).filter((c) => typeof c === 'string' && c.trim());
  if (!commands.length || L.args?.dry) return { ok: true };
  const { proc } = L;
  const skip = (why) => ({ ok: true, note: `skipped (${why}); CI still gates the merge` });

  proc.gitTry('fetch', 'origin', '--prune');
  // Never touch work a session left behind: the runner keeps it aside before the next item.
  if (proc.gitTry('status', '--porcelain', '--untracked-files=no').out) return skip('the working tree has uncommitted tracked changes');
  const remote = proc.gitTry('rev-parse', '--verify', `origin/${s.branch}`).out;
  if (!remote) return skip(`origin/${s.branch} does not exist`);
  if (!proc.gitTry('checkout', '-q', s.branch).ok) return skip(`could not check out ${s.branch}`);
  try {
    if (proc.gitTry('rev-parse', 'HEAD').out !== remote) proc.gitTry('merge', '-q', '--ff-only', `origin/${s.branch}`);
    if (proc.gitTry('rev-parse', 'HEAD').out !== remote) return skip(`local ${s.branch} is not the pushed head`);
    const timeoutMs = (L.cfg.localGate?.timeoutMin ?? 20) * 60_000;
    for (const command of commands) {
      L.log(`… local gate on ${remote.slice(0, 7)}: ${command}`);
      const r = spawnSync(command, { shell: true, cwd: L.root, env: L.session.env('gate', item.id), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (r.status === 0) continue;
      const why = r.error?.code === 'ETIMEDOUT' ? `timed out after ${L.cfg.localGate?.timeoutMin ?? 20} min` : r.error ? `could not start (${r.error.message})` : `exited ${r.status}`;
      const file = path.join(L.paths.logs, `gate-${item.id}-r${s.rounds}.txt`);
      fs.mkdirSync(L.paths.logs, { recursive: true });
      fs.writeFileSync(file, `$ ${command}\n${why}\n\n${tail(`${r.stdout || ''}\n${r.stderr || ''}`, 400)}\n`);
      const rel = path.relative(L.root, file).replace(/\\/g, '/');
      return { ok: false, command, text: `**The local gate failed** on PR #${s.pr}: the runner ran \`${command}\` on your pushed head ${remote.slice(0, 7)} and it ${why}. CI runs the same checks, so it would be red too. The output (tail) is in \`${rel}\`. Read it, find the root cause and fix it properly. Never weaken a test or a gate to get green.` };
    }
    return { ok: true, note: `${commands.length} command(s) passed on ${remote.slice(0, 7)}` };
  } finally {
    // The tree was clean before, so anything changed now was written by the gate commands (a
    // coverage ratchet that updates its own config, a formatter): drop it and go back to the base.
    proc.gitTry('checkout', '-q', '--', '.');
    proc.gitTry('checkout', '-q', L.cfg.base);
  }
}
