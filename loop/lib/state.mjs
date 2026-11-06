// Run state (.loop/state.json) and the picker.
//
// The backlog (loop/backlog.json) holds item definitions only; progress lives here, owned by the
// runner. Items the run creates itself sit in S.extra: FIX items (base branch red, acceptance
// failures), LEARN items (a repeated failure) and follow-ups.

import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL = new Set(['done', 'blocked', 'failed', 'needs_human', 'skipped']);
/** A merged item waits here until its post-merge checks verify. Nothing else starts meanwhile. */
export const HELD_PHASE = 'hold';

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

export function freshState() {
  return { startedAt: new Date().toISOString(), iterations: 0, items: {}, extra: [], noProgress: 0, packed: [], accept: {}, learn: {} };
}

/**
 * The store for one run. `dry` keeps every change in memory: a dry run must never consume rounds.
 */
export function createState(file, backlog, { dry = false } = {}) {
  const S = Object.assign(freshState(), readJson(file, {}) || {});
  const st = (id) =>
    (S.items[id] ||= { status: 'todo', phase: 'build', attempts: 0, rounds: 0, partials: 0, ciFixes: 0, reviewRounds: 0, notes: [], prs: [] });

  function allItems() {
    const out = [];
    out.push(...S.extra.filter((e) => e.kind === 'fix'));
    out.push(...S.extra.filter((e) => e.kind === 'learn'));
    for (const m of backlog.milestones) {
      out.push(...backlog.items.filter((i) => i.milestone === m));
      out.push(...S.extra.filter((e) => e.kind === 'followup' && e.milestone === m));
    }
    out.push(...backlog.items.filter((i) => !backlog.milestones.includes(i.milestone)));
    return out;
  }

  /** Finished, or unreachable because something it depends on ended without being done. */
  function settled(it, seen = new Set()) {
    if (TERMINAL.has(st(it.id).status)) return true;
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    const byId = new Map(allItems().map((i) => [i.id, i]));
    return (it.dependsOn || []).some((d) => {
      const ds = st(d).status;
      if (TERMINAL.has(ds) && ds !== 'done') return true;
      const dep = byId.get(d);
      return dep && ds !== 'done' && settled(dep, seen);
    });
  }

  function heldItem(items = allItems()) {
    return items.find((it) => st(it.id).phase === HELD_PHASE && !TERMINAL.has(st(it.id).status));
  }

  /** The held item first, whatever --item or --only say: the next item may build on what it merged. */
  function pickNext({ item, only } = {}) {
    const items = allItems();
    const held = heldItem(items);
    if (held) return held;
    const waiting = [];
    for (const it of items) {
      if (item && it.id !== item) continue;
      if (only && it.milestone !== only && it.kind !== 'fix' && it.kind !== 'learn') continue;
      const s = st(it.id);
      if (TERMINAL.has(s.status)) continue;
      const bad = (it.dependsOn || []).map((d) => [d, st(d).status]).filter(([, ds]) => ds !== 'done');
      if (bad.length === 0) return it;
      waiting.push(`${it.id} ← ${bad.map(([d, ds]) => `${d}:${ds}`).join(', ')}`);
    }
    return { none: true, waiting };
  }

  function addExtra(entry) {
    if (S.extra.some((e) => e.id === entry.id)) return false;
    S.extra.push(entry);
    save();
    return true;
  }

  function save() {
    if (!dry) writeJson(file, S);
  }

  return { S, st, allItems, settled, heldItem, pickNext, addExtra, save };
}

/** Problems with the backlog that would make the picker misbehave. */
export function backlogProblems(backlog) {
  const p = [];
  if (!backlog || !Array.isArray(backlog.milestones) || !Array.isArray(backlog.items)) return ['loop/backlog.json needs "milestones" and "items" arrays'];
  const ids = new Set();
  for (const i of backlog.items) {
    if (!i.id || !i.milestone || !i.title) p.push(`backlog item ${i.id || '?'}: needs id, milestone and title`);
    if (ids.has(i.id)) p.push(`backlog item ${i.id}: duplicate id`);
    ids.add(i.id);
    if (/^(FIX|LEARN|ACC|FUP)-/.test(i.id || '')) p.push(`backlog item ${i.id}: the FIX-/LEARN-/ACC-/FUP- prefixes are reserved for items the run creates`);
  }
  for (const i of backlog.items) for (const d of i.dependsOn || []) if (!ids.has(d)) p.push(`backlog item ${i.id}: depends on unknown ${d}`);
  return p;
}
