#!/usr/bin/env node
// A fake Supabase CLI: `migration list` and `db push` against $LOOP_FAKE_DIR/supabase-state.json.
// State: { remote: [versions], failPush, silentPush (exit 0, applies nothing), failList, calls }.

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.env.LOOP_FAKE_DIR, 'supabase-state.json');
const S = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const args = process.argv.slice(2);
S.calls = [...(S.calls || []), args.filter((a) => !a.startsWith('postgres')).join(' ')];
const save = () => fs.writeFileSync(FILE, JSON.stringify(S, null, 2));
const dir = path.join(process.cwd(), 'supabase', 'migrations');
const local = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => f.match(/^(\d+)/)[1]).sort() : []);

if (args[0] === 'migration' && args[1] === 'list') {
  save();
  if (S.failList) {
    process.stderr.write('failed to connect to postgres\n');
    process.exit(1);
  }
  const all = [...new Set([...local(), ...S.remote])].sort();
  const rows = all.map((v) => `   ${local().includes(v) ? v : '              '} | ${S.remote.includes(v) ? v : '              '} | 2026-01-01 00:00:00`);
  process.stdout.write(`\n   Local          | Remote         | Time (UTC)\n  ----------------|----------------|---------------------\n${rows.join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'db' && args[1] === 'push') {
  if (S.failPush) {
    save();
    process.stderr.write('ERROR: relation "x" does not exist\n');
    process.exit(1);
  }
  if (!S.silentPush) S.remote = [...new Set([...S.remote, ...local()])].sort();
  save();
  process.stdout.write('Finished supabase db push.\n');
  process.exit(0);
}
save();
process.stderr.write(`fake supabase: unsupported ${args.join(' ')}\n`);
process.exit(1);
