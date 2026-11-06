// The project rule table: loop/rules/project-rules.json.
//
// The locked core (core.mjs) holds the rules every project needs. This table holds the ones a
// project learns: the loop's LEARN items add rows here, through the normal PR gates. The table may
// only grow — loop/scripts/check-rules.mjs fails CI when a row from the base branch is removed or
// changed — so the loop can tighten its guard but never loosen it.
//
// A row: { id, target: "shell" | "path" | "sql" | "mcp", pattern, flags?, phases?, reason,
//          examples: { block: "…", allow: "…" } }
//   shell → the command line; path → the repo-relative file path an edit writes;
//   sql   → an execute_sql query with its comments removed; mcp → "<tool name> <json input>".

import fs from 'node:fs';

export const TARGETS = ['shell', 'path', 'sql', 'mcp'];

export function readRuleTable(file) {
  if (!fs.existsSync(file)) return { rules: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Rows that compile, as { ...row, re }. Throws on the first invalid row (the guard fails closed). */
export function compileRules(table) {
  const rows = Array.isArray(table?.rules) ? table.rules : [];
  return rows.map((r) => {
    if (!r || !r.id || !TARGETS.includes(r.target) || !r.pattern || !r.reason) throw new Error(`project rule ${r?.id || '?'}: needs id, target (${TARGETS.join('|')}), pattern and reason`);
    return { ...r, re: new RegExp(r.pattern, r.flags ?? 'i') };
  });
}

/** The first rule that blocks `text` for `target` in `phase`, or null. */
export function matchRules(rules, target, text, phase) {
  return rules.find((r) => r.target === target && (!r.phases?.length || r.phases.includes(phase)) && r.re.test(String(text))) || null;
}
