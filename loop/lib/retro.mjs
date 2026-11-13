// The retro: one read-only session that looks back over the stretch since the last retro and
// decides what the loop keeps doing, what it changes and what it hands to the owner. The rules and
// the books are in learn.mjs; this file gathers the numbers, runs the session and files the result.
//
//   .loop/retros/R-01-data.md   the numbers the session is given
//   .loop/retros/R-01.json      what it returned, as the runner took it
//   .loop/retros/R-01.md        the minutes (the LEARN item files them in docs/retros/)
//   .loop/IMPEDIMENTS.md        every open impediment, for the owner

import fs from 'node:fs';
import path from 'node:path';

import { runClaude } from './claude.mjs';
import { goalPrompt } from './engine.mjs';
import { actionVerdict, applyRetro, harnessChanged, renderImpediments, renderMinutes, retroId, retroState } from './learn.mjs';
import { RETRO_SCHEMA } from './schemas.mjs';
import { readJson, writeJson } from './state.mjs';

const lines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : 'None.');
const usd = (n) => `$${(n || 0).toFixed(2)}`;

/** The harness version a project runs on: the template commit of its last sync (null in the template itself). */
export const harnessVersion = (root) => readJson(path.join(root, 'loop', 'template.lock.json'), null)?.commit || null;

/** At run start: after a sync from the template, the reported impediments are checked again. */
export function noteHarness(L) {
  const again = harnessChanged(L.store.S, harnessVersion(L.root));
  if (again.length) {
    L.progress(`the harness changed since the last run: ${again.map((i) => i.id).join(', ')} ${again.length === 1 ? 'is' : 'are'} checked again by the next retro`);
    fs.writeFileSync(path.join(L.paths.run, 'IMPEDIMENTS.md'), renderImpediments(L.store.S));
  }
  L.store.save();
}

/**
 * The numbers for one retro: everything since `since` (the last retro), from the event file, the
 * session ledger, the guard log and the state. Returns { markdown, covers }.
 */
export function buildSheet(L, since) {
  const S = L.store.S;
  const r = retroState(S);
  const after = (at) => !since || String(at) > since;
  const events = lines(L.paths.events).map(parse).filter((e) => e && after(e.at));
  const ledger = lines(L.paths.ledger).map(parse).filter((e) => e && after(e.at) && e.phase !== 'smoke');
  const defs = new Map(L.store.allItems().map((i) => [i.id, i]));
  const items = new Map();
  const row = (id) => {
    if (!items.has(id)) items.set(id, { id, sessions: 0, usd: 0, min: 0, rounds: 0, back: {}, merged: false, status: '' });
    return items.get(id);
  };
  const learning = (s) => s.phase === 'retro' || defs.get(s.item)?.kind === 'learn';
  for (const s of ledger) {
    const x = row(s.item);
    x.sessions++;
    x.usd += s.costUsd || 0;
    x.min += (s.durationMs || 0) / 60_000;
    x.step ||= ['accept', 'packet', 'retro'].includes(s.phase) ? s.phase : '';
  }
  for (const e of events) {
    if (!e.item) continue;
    if (e.type === 'build.round') row(e.item).rounds = Math.max(row(e.item).rounds, e.round || 0);
    if (e.type === 'check.sent_back') row(e.item).back[e.check] = (row(e.item).back[e.check] || 0) + 1;
    if (e.type === 'item.merged') row(e.item).merged = true;
    if (e.type === 'item.finished') row(e.item).status = e.status;
  }
  const built = [...items.values()].filter((x) => !x.step);
  const kind = (x) => defs.get(x.id)?.kind || 'backlog';
  const firstTime = built.filter((x) => kind(x) !== 'learn' && x.merged && x.rounds <= 1 && !Object.keys(x.back).length);
  const total = ledger.reduce((a, s) => ({ sessions: a.sessions + 1, usd: a.usd + (s.costUsd || 0), min: a.min + (s.durationMs || 0) / 60_000 }), { sessions: 0, usd: 0, min: 0 });
  const learn = ledger.filter(learning).reduce((a, s) => ({ sessions: a.sessions + 1, usd: a.usd + (s.costUsd || 0) }), { sessions: 0, usd: 0 });

  const blocks = new Map();
  for (const f of lines(L.paths.guardLog).map((l) => l.split('\t'))) {
    if (f.length < 5 || !after(f[0]) || f[2] === 'smoke') continue;
    const b = blocks.get(f[3]) || blocks.set(f[3], { rule: f[3], n: 0, items: new Set(), phases: new Set(), reason: f[4], examples: [] }).get(f[3]);
    b.n++;
    b.items.add(f[1]);
    b.phases.add(f[2]);
    if (f[5] && b.examples.length < 4 && !b.examples.includes(f[5])) b.examples.push(f[5]);
  }

  const signals = Object.entries(S.learn || {}).filter(([sig, e]) => (e.items || []).length || r.due?.signals?.includes(sig));
  const open = r.actions.filter((a) => a.status === 'open');
  const lessons = (() => {
    try {
      const t = fs.readFileSync(path.join(L.root, 'docs', 'LESSONS.md'), 'utf8');
      const rows = t.split('\n').filter((l) => /^\|\s*[LK]-\d+/.test(l));
      return { rows: rows.length, chars: rows.reduce((a, l) => a + l.length, 0), longest: Math.max(0, ...rows.map((l) => l.length)) };
    } catch {
      return { rows: 0, chars: 0, longest: 0 };
    }
  })();
  const limit = L.cfg.retro?.maxLessons ?? 20;
  const covers = `${built.length} item(s), ${total.sessions} session(s), ${usd(total.usd)}${since ? ` since ${since.slice(0, 16).replace('T', ' ')}Z` : ' since the run began'}`;

  const markdown = [
    `## The numbers\n\n${covers}. Of that, learning (retros and LEARN items): ${learn.sessions} session(s), ${usd(learn.usd)}.`,
    `### Items\n\n${table(['Item', 'Kind', 'Ended', 'Build rounds', 'Sent back by', 'Sessions', 'Cost', 'Minutes'], built.map((x) => [x.id, kind(x), x.status || (x.merged ? 'merged' : 'open'), x.rounds, Object.entries(x.back).map(([k, n]) => `${k} ×${n}`).join(', ') || 'nothing', x.sessions, usd(x.usd), x.min.toFixed(0)]))}`,
    `### Merged at the first attempt, sent back by nothing\n\n${firstTime.map((x) => x.id).join(', ') || 'None.'}`,
    `### Signals: failures counted since the last retro\n\nA signal with "calls this retro" showed up in enough different items to call it.\n\n${table(['Signal', 'Items since the last retro', 'All time', 'Latest cases', 'Note'], signals.map(([sig, e]) => [`\`${sig}\``, (e.items || []).join(', ') || '-', e.count, (e.details || []).slice(-3).join(' // '), [r.due?.signals?.includes(sig) ? 'calls this retro' : '', e.muted ? `reported (${e.muted.by})` : ''].filter(Boolean).join(', ')]))}`,
    `### Guard refusals\n\n${table(['Rule', 'Times', 'Items', 'Steps', 'What the guard said', 'Refused lines (examples)'], [...blocks.values()].map((b) => [`\`${b.rule}\``, b.n, [...b.items].join(', '), [...b.phases].join(', '), b.reason, b.examples.map((x) => `\`${x.replace(/`/g, "'")}\``).join(' // ') || '(not logged)']))}`,
    `### Earlier action items still open: check each one\n\n${table(['Action', 'From', 'Promised', 'Signal', 'Items built since it merged', 'Still happened in', 'By the numbers'], open.map((a) => [`${a.id} ${a.title}`, a.retro, a.expect, a.signal ? `\`${a.signal}\`` : '-', a.since ? a.itemsSince.length : '-', a.hits.join(', ') || (a.since ? 'none' : '-'), actionVerdict(a, L.cfg)]))}`,
    `### Impediments already reported\n\n${table(['Id', 'Status', 'Impediment', 'Signal'], r.impediments.filter((i) => i.status !== 'closed').map((i) => [i.id, i.status, i.title, i.signal ? `\`${i.signal}\`` : '-']))}`,
    `### docs/LESSONS.md\n\n${lessons.rows} row(s) of at most ${limit}, ${lessons.chars} characters, the longest row ${lessons.longest}.${lessons.rows >= limit ? ' **At the limit: merge or retire rows before adding one.**' : ''}`,
  ].join('\n\n');
  return { markdown, covers };
}

/**
 * Hold one retro. kind: 'milestone' (at the end of `milestone`) or 'early' (a signal called it).
 * Returns null when the session gave no result, else what applyRetro returns.
 */
export async function holdRetro(L, { kind, milestone }) {
  const S = L.store.S;
  const r = retroState(S);
  const id = retroId(r.n + 1);
  const dir = path.join(L.paths.run, 'retros');
  fs.mkdirSync(dir, { recursive: true });
  const called = r.due?.signals || [];
  const sheet = buildSheet(L, r.lastAt);
  fs.writeFileSync(path.join(dir, `${id}-data.md`), `# Retro ${id}: the numbers\n\n${sheet.markdown}\n`);
  fs.writeFileSync(L.paths.task, L.render('retro.md', {
    RETRO_ID: id,
    BASE: L.cfg.base,
    WHY: kind === 'milestone' ? `Milestone **${milestone}** is built: this is its retro.${called.length ? ` These signals were waiting for it: ${called.map((s) => `\`${s}\``).join(', ')}.` : ''}` : `It was called early: ${called.map((s) => `\`${s}\``).join(', ')} showed up in several different items.`,
    SHEET: sheet.markdown,
    MAX_ACTIONS: L.cfg.retro?.maxActions ?? 3,
    CHECK_AFTER: L.cfg.retro?.checkAfterItems ?? 5,
    MAX_LESSONS: L.cfg.retro?.maxLessons ?? 20,
  }));
  L.setStatus('retro', { id, title: kind === 'milestone' ? `retro after ${milestone}` : 'retro called early' });
  const cond = `The retro described in .loop/current-task.md is complete: you checked every open action item against the numbers, and the structured result names what went well, what went wrong with its cause, the action items and the impediments.`;
  const run = await runClaude(L.session, { prompt: goalPrompt(L, cond), phase: 'retro', item: { id }, timeoutMin: L.cfg.timeouts.retroMin ?? 45, model: L.cfg.reviewModel || L.cfg.model, schema: RETRO_SCHEMA });
  L.checkIsolation(run);
  if (run.gaveUp || !run.structured) return null;

  const res = applyRetro(S, run.structured, { id, kind, milestone, cfg: L.cfg, covers: sheet.covers });
  writeJson(path.join(dir, `${id}.json`), res.retro);
  fs.writeFileSync(path.join(dir, `${id}.md`), renderMinutes(res.retro));
  fs.writeFileSync(path.join(L.paths.run, 'IMPEDIMENTS.md'), renderImpediments(S));
  if (res.learn) L.store.addExtra(res.learn);
  for (const i of res.impediments) {
    L.ownerAction(i.id, `Impediment in the harness (${i.part}): ${i.title}. ${i.example ? `Example: \`${i.example}\`. ` : ''}Wanted: ${i.wanted} Fix it in the template and sync; the loop does not work around it. Details: .loop/IMPEDIMENTS.md`);
    L.event('impediment.reported', { impediment: i.id, retro: id, part: i.part, signal: i.signal, title: i.title });
  }
  for (const p of res.retro.problems.filter((x) => x.owner === 'owner')) L.ownerAction(id, `The retro found something only you can settle: ${p.title}. ${p.cause}`);
  for (const s of res.escalated) L.ownerAction(id, `"${s}" keeps coming back after several action items (.loop/retros/). The loop stops spending sessions on it: look at the cases and decide what to change.`);
  for (const c of res.checks) L.event('action.checked', { action: c.action, retro: id, verdict: c.verdict, decision: c.decision, itemsSince: c.itemsSince, hits: c.hits });
  const n = res.retro;
  L.progress(`${id} · retro ${kind === 'milestone' ? `after ${milestone}` : 'called early'}: ${n.wentWell.length} to keep, ${n.problems.length} problem(s), ${n.actions.length} action item(s)${res.learn ? ` → ${res.learn.id} first in line` : ''}, ${res.impediments.length} impediment(s) → .loop/retros/${id}.md`);
  L.event('retro.held', { retro: id, kind, milestone: milestone || null, wentWell: n.wentWell.length, problems: n.problems.length, actions: n.actions.map((a) => a.id), impediments: res.impediments.map((i) => i.id), learn: res.learn?.id || null });
  if (res.learn) L.event('learn.queued', { item: null, signature: null, learn: res.learn.id, retro: id });
  L.store.save();
  return res;
}
