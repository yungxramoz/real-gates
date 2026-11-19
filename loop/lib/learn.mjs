// How the loop learns: what it counts, when a retro is due, and the books a retro keeps.
//
// The model does not change between sessions; the repository does. So the loop improves the way a
// team does, in a retrospective (loop/lib/retro.mjs holds the session, this file the rules):
//
//   1. The runner counts every failure by its signal, while the run goes on.
//   2. A retro looks at the whole stretch since the last one: what went well, what went wrong and
//      why. It is held at the end of every milestone, and early when one signal shows up in several
//      items.
//   3. It hands out a few action items. One LEARN item carries them out and merges through the same
//      gates as any other change.
//   4. The next retro checks each action item against the numbers: did the signal stop? An action
//      that did not help is revised or taken back. Nothing is kept on faith.
//
// The harness itself (the guard, the runner, the prompts, CI's wiring) is not the loop's to fix and
// not to work around, and nothing here asks a person to step in while a run goes on:
//
//   - A guard refusal is the guard working. It is counted as a cost and is never a problem, never
//     an impediment and never a reason to hold a retro. A session that was refused goes another
//     way; the rules are in its prompt (loop/lib/guardnotes.mjs).
//   - A defect in the harness that broke something (a crash, a lost result, a wrong report) is
//     recorded once as an impediment. The list is a record, not a request: one cause has one
//     entry, meeting it again raises a counter, and nothing in the run waits for it. After a
//     sync from the template an entry closes by itself when its cause stays away.
//
// Signals: review:<category>:<cause> (a blocking review finding with the cause key the reviewer
// gave it), review:<category> (the same category whatever the cause), ci:<job name> (a red CI job
// on a PR), gate:<command> (the local gate), premerge, and guard:<rule id> (a guard block, counted
// only).
//
// Why two thresholds: a cause the reviewer named, a red CI job or a failing gate in two different
// items is a pattern (learnThreshold). A bare review category is coarse, and a retro costs a
// session, so it needs more items (learnCategoryThreshold).

import { TERMINAL } from './state.mjs';

/** After this many action items a signal that still comes back goes to the owner. */
export const MAX_ACTIONS_PER_SIGNAL = 3;
/**
 * Sessions an impediment has to stay away for, after the harness changed, to be closed
 * (retro.recheckSessions). A defect that shows up once in fifty sessions is not gone after six.
 */
export const RECHECK_SESSIONS = 30;

/** Characters a reader cannot see: written as \uXXXX, so a rule about them survives the minutes. */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;
export const visible = (v) => String(v ?? '').replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** One line of at most n characters. What is cut off is marked, never dropped silently. */
const oneLine = (v, n) => {
  const s = visible(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, Math.max(0, n - 4)).trimEnd()} […]` : s;
};
const pad = (n) => String(n).padStart(2, '0');

/** The retro's books in the state, with every key present (an older state has none of them). */
export function retroState(S) {
  const r = (S.retro ||= {});
  r.n ??= 0;
  r.due ??= null;
  r.lastAt ??= null;
  r.sessions ??= 0;
  r.milestones ||= {};
  r.actions ||= [];
  r.impediments ||= [];
  r.held ||= [];
  return r;
}

/** A guard refusal: the guard working. It is counted, and it never calls a retro. */
export const isGuard = (signal) => /^guard:/.test(String(signal ?? ''));

/** Signals a bare review category gives (and a guard rule, which is only counted): coarse, so they need more items. */
export const isCoarse = (signal) => isGuard(signal) || /^review:[^:]+$/.test(signal);

/** Words that say nothing about which defect a title names. */
const FILLER = new Set(['with', 'without', 'when', 'while', 'that', 'this', 'from', 'into', 'does', 'have', 'been', 'every', 'each', 'some', 'again', 'still', 'after', 'before', 'because', 'although', 'their', 'there', 'then', 'than', 'also', 'only', 'just', 'over', 'under', 'between']);

/** The words of a title that carry its meaning, without their endings: "crashes" and "crash" are one word. */
export function titleWords(t) {
  const words = String(t ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  return new Set(words.filter((w) => !FILLER.has(w)).map((w) => w.replace(/(?:ing|ed|es|s)$/, '')).filter((w) => w.length >= 3));
}

/**
 * Two titles that name the same thing: at least three meaningful words in common, and most of the
 * shorter title's words. Two sentences of the same shape about different things ("the e2e job
 * starts without a browser", "the unit job starts without a database") share too little.
 */
export function sameTitle(a, b) {
  const [A, B] = [titleWords(a), titleWords(b)];
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both >= 3 && both / Math.min(A.size, B.size) >= 0.6;
}

/**
 * Count one failure. Returns true when this one makes a retro due: the signal has now shown up in
 * `threshold` different items since it was last on a retro's table. Mutates S.learn and S.retro.
 *
 * A LEARN item's own failures never count towards a retro: it studies a failure, often trips it
 * while doing so, and its own review rounds are not a pattern in the product's work. A guard
 * refusal never does either: it is counted (the retro's sheet shows the cost), nothing more.
 */
export function recordFailure(S, { signature, detail, item, threshold = 2 }) {
  S.learn ||= {};
  const e = (S.learn[signature] ||= { count: 0, details: [], items: [] });
  e.items ||= [];
  e.count++;
  const id = item?.id || '-';
  if (detail) e.details = [...(e.details || []), `${id}: ${oneLine(detail, 300)}`].slice(-5);
  if (item?.kind === 'learn') return false;
  const r = retroState(S);
  // An action item that promised to stop this signal: every item it still shows up in is a hit.
  for (const a of r.actions) if (a.status === 'open' && a.since && a.signal === signature && !a.hits.includes(id)) a.hits.push(id);
  // An impediment that waits for its recheck keeps its own record: a retro in between starts the
  // per-signal count again, and must not wipe out that the signal came back on the new harness.
  for (const i of r.impediments) if (i.status === 'recheck' && i.signal === signature && !(i.back ||= []).includes(id)) i.back.push(id);
  if (isGuard(signature) || e.muted) return false;
  if (!e.items.includes(id)) e.items.push(id);
  if (e.items.length < threshold) return false;
  r.due ||= { signals: [], since: new Date().toISOString() };
  if (r.due.signals.includes(signature)) return false;
  r.due.signals.push(signature);
  return true;
}

/** The id of the next LEARN item: one more than any the state has seen. */
export function nextLearnId(S) {
  const ids = [...(S.extra || []).map((e) => e.id), ...Object.keys(S.items || {})];
  const max = Math.max(0, ...ids.map((id) => Number(/^LEARN-(\d+)$/.exec(id || '')?.[1] || 0)));
  return `LEARN-${max + 1}`;
}

/**
 * May a retro be called early now? Not while the last retro's LEARN item is still being built, and
 * not once learning has used its share of the sessions: the backlog comes first. The retro at the
 * end of a milestone is always held, and it takes every waiting signal with it.
 */
export function earlyRetro(S, cfg) {
  const r = retroState(S);
  if (!r.due?.signals?.length) return { due: false };
  const open = (S.extra || []).find((e) => e.kind === 'learn' && !TERMINAL.has(S.items?.[e.id]?.status));
  if (open) return { due: true, wait: `${open.id} is not finished` };
  const share = cfg.retro?.maxShare ?? 0.2;
  // a retro and its LEARN item take about three sessions
  const room = Math.max(3, Math.floor(share * ((S.iterations || 0) + 3)));
  if (r.sessions + 3 > room) return { due: true, wait: `learning has used ${r.sessions} of ${S.iterations || 0} sessions (share ${share})` };
  return { due: true, signals: r.due.signals };
}

/**
 * What the numbers say about an action item, before the retro decides. An acceptance round that
 * failed since it merged keeps it from "worked": acceptance finds what no review signal names.
 * An action item without a signal has no numbers at all: nothing counts whether what it promised
 * happened, so only a retro that read the sessions can judge it.
 */
export function actionVerdict(a, cfg) {
  if (!a.since) return 'not merged yet';
  if (!a.signal) return 'no numbers';
  if (a.hits.length >= 2) return 'no effect';
  if (a.itemsSince.length >= (cfg.retro?.checkAfterItems ?? 5)) return a.hits.length || (a.acceptFails || []).length ? 'weak' : 'worked';
  return 'too early';
}

/** A milestone failed an acceptance round: every action item that is being measured notes it. */
export function noteAcceptanceFailed(S, milestone, round) {
  const mark = `${milestone} round ${round}`;
  for (const a of retroState(S).actions) if (a.status === 'open' && a.since && !(a.acceptFails ||= []).includes(mark)) a.acceptFails.push(mark);
}

/**
 * An item ended. Open action items count it (the stretch they are measured over), and a LEARN item
 * that ended starts the clock for its retro's action items, or drops them when it did not merge.
 */
export function noteItemEnded(S, item, status) {
  const r = retroState(S);
  if (item?.kind === 'learn') {
    for (const a of r.actions.filter((x) => x.learn === item.id && x.status === 'open' && !x.since)) {
      if (status === 'done') a.since = new Date().toISOString();
      else Object.assign(a, { status: 'dropped', note: `${item.id} ended ${status}` });
    }
    return;
  }
  for (const a of r.actions) if (a.status === 'open' && a.since && !a.itemsSince.includes(item.id)) a.itemsSince.push(item.id);
}

/**
 * Take a retro's result into the books. Pure: mutates S, writes nothing. Returns what the runner
 * has to do: { retro, learn (the LEARN item to queue, or null), impediments (new ones), seenAgain
 * (known ones the retro met again), checks, dropped (what was not taken, with the reason) }.
 */
export function applyRetro(S, out, { id, kind, milestone, cfg, at = new Date().toISOString(), covers = '' }) {
  const r = retroState(S);
  const max = cfg.retro?.maxActions ?? 3;
  const dropped = [];
  const text = (v, n = 600) => oneLine(v, n);

  // 1. Earlier action items, checked.
  const checks = [];
  for (const c of Array.isArray(out.checks) ? out.checks : []) {
    const a = r.actions.find((x) => x.id === c?.action && x.status === 'open');
    if (!a) continue;
    const decision = ['keep', 'revise', 'retire'].includes(c.decision) ? c.decision : 'keep';
    const verdict = ['worked', 'no_effect', 'too_early'].includes(c.verdict) ? c.verdict : 'too_early';
    if (decision === 'retire') a.status = 'retired';
    else if (decision === 'revise') a.status = 'revised';
    else if (verdict === 'worked') a.status = 'worked';
    Object.assign(a, { checkedBy: id, verdict, note: text(c.note, 300) });
    checks.push({ action: a.id, title: a.title, verdict, decision, status: a.status, note: a.note, itemsSince: a.itemsSince.length, hits: a.hits.length });
  }
  // An action item the session said nothing about is judged by the numbers alone, so none stays
  // open because a session forgot it. One that worked is closed. One that had no effect stays
  // open and is shown as such: taking a fix back or replacing it needs a retro's decision. One
  // without a signal has no numbers ("no numbers" above): it stays open until a retro judges it.
  for (const a of r.actions.filter((x) => x.status === 'open' && x.since && !checks.some((c) => c.action === x.id))) {
    const numbers = actionVerdict(a, cfg);
    if (numbers !== 'worked' && numbers !== 'no effect') continue;
    const verdict = numbers === 'worked' ? 'worked' : 'no_effect';
    if (verdict === 'worked') a.status = 'worked';
    Object.assign(a, { checkedBy: id, verdict, note: verdict === 'worked' ? 'By the numbers: the retro gave no verdict.' : 'By the numbers: it came back, and the retro gave no decision. It stays open.' });
    checks.push({ action: a.id, title: a.title, verdict, decision: 'keep', status: a.status, note: a.note, itemsSince: a.itemsSince.length, hits: a.hits.length });
  }

  // 2. Impediments: defects in the harness that broke something. One cause has one entry: a
  // retro that meets a known one again adds to its count and opens no second entry. A guard
  // refusal is not a defect and is never recorded.
  const impediments = [];
  const seenAgain = [];
  for (const x of Array.isArray(out.impediments) ? out.impediments : []) {
    if (!x?.title) continue;
    const part = text(x.part, 20) || 'other';
    if (part === 'guard' || isGuard(x.signal)) {
      dropped.push(`impediment "${text(x.title, 80)}": a refusal is the guard working, it is not recorded`);
      continue;
    }
    const signal = S.learn?.[x.signal] ? x.signal : null;
    const live = (i) => i.status !== 'closed';
    // By its words alone an entry is the same only in the same part and when the signals do not
    // disagree: two defects with a signal each are two causes, however alike their titles read.
    const alike = (i) => i.part === part && !(signal && i.signal && i.signal !== signal) && sameTitle(i.title, x.title);
    const known =
      r.impediments.find((i) => i.id === x.same_as) ||
      (signal && (r.impediments.find((i) => i.signal === signal && live(i)) || r.impediments.find((i) => i.signal === signal))) ||
      r.impediments.find((i) => live(i) && alike(i)) ||
      r.impediments.find(alike);
    if (known) {
      if (!seenAgain.includes(known)) {
        Object.assign(known, { seen: (known.seen || 1) + 1, lastRetro: id, status: 'open', back: [] });
        known.signal ||= signal; // it was recorded before its signal was known
        if (x.example) known.example = text(x.example, 400);
        if (x.broke) known.broke = text(x.broke, 300); // what it broke this time
        if (known.signal && S.learn?.[known.signal]) S.learn[known.signal].muted = { by: known.id };
        seenAgain.push(known);
      }
      continue;
    }
    const imp = { id: `IMP-${r.impediments.length + 1}`, retro: id, status: 'open', at, title: text(x.title, 160), part, broke: text(x.broke, 300), evidence: text(x.evidence), example: text(x.example, 400), wanted: text(x.wanted), signal, seen: 1, lastRetro: id };
    r.impediments.push(imp);
    impediments.push(imp);
    if (signal) S.learn[signal].muted = { by: imp.id };
  }
  // One that waits for its recheck (the harness changed) is settled by the numbers: open again
  // as soon as its signal came back on the new harness, closed once enough sessions ran without
  // it. One without a signal is open again when a retro met it (above), closed otherwise.
  for (const i of r.impediments.filter((x) => x.status === 'recheck')) {
    if (i.signal && (i.back || []).length) {
      i.status = 'open';
      if (S.learn?.[i.signal]) S.learn[i.signal].muted = { by: i.id };
    } else if ((S.iterations || 0) - (i.recheckAt || 0) >= (cfg.retro?.recheckSessions ?? RECHECK_SESSIONS)) {
      Object.assign(i, { status: 'closed', closedBy: id, note: 'Not seen again since the harness changed.' });
      if (i.signal && S.learn?.[i.signal]?.muted?.by === i.id) delete S.learn[i.signal].muted; // it counts again
    }
  }

  // 3. New action items, a few at most. A signal that already had its share goes to the owner.
  const actions = [];
  const escalated = [];
  for (const x of Array.isArray(out.actions) ? out.actions : []) {
    if (!x?.title || !x?.what) continue;
    if (actions.length >= max) {
      dropped.push(`action "${text(x.title, 80)}": a retro hands out at most ${max}`);
      continue;
    }
    const signal = S.learn?.[x.signal] ? x.signal : null;
    if (signal && r.actions.filter((a) => a.signal === signal).length >= MAX_ACTIONS_PER_SIGNAL) {
      S.learn[signal].muted = { by: 'owner' };
      escalated.push(signal);
      dropped.push(`action "${text(x.title, 80)}": ${signal} already had ${MAX_ACTIONS_PER_SIGNAL} action items and still comes back, so it goes to the owner`);
      continue;
    }
    actions.push({ id: `A-${r.actions.length + actions.length + 1}`, retro: id, status: 'open', title: text(x.title, 160), rung: ['lesson', 'test', 'rule', 'tool'].includes(x.rung) ? x.rung : 'lesson', what: text(x.what, 4000), expect: text(x.expect, 1000), doneWhen: text(x.done_when, 1500), signal, since: null, itemsSince: [], hits: [] });
  }

  const wentWell = (Array.isArray(out.went_well) ? out.went_well : []).filter((w) => w?.practice).slice(0, 6).map((w) => ({ practice: text(w.practice, 300), evidence: text(w.evidence, 300), keep: !!w.keep }));
  const problems = (Array.isArray(out.problems) ? out.problems : []).filter((p) => p?.title).slice(0, 10).map((p) => ({ title: text(p.title, 200), evidence: text(p.evidence, 400), cause: text(p.cause, 400), owner: ['product', 'practice', 'harness', 'owner'].includes(p.owner) ? p.owner : 'practice', signal: S.learn?.[p.signal] ? p.signal : null }));

  // 4. The LEARN item: one per retro. It carries out the action items, takes back what a check
  // retired, writes the kept practices down and files the minutes. A milestone retro always has
  // one, so its minutes land in the repository.
  const changes = checks.filter((c) => c.status === 'retired' || c.status === 'revised');
  const keeps = wentWell.filter((w) => w.keep);
  let learn = null;
  if (actions.length || changes.length || keeps.length || kind === 'milestone') {
    const learnId = nextLearnId(S);
    for (const a of actions) a.learn = learnId;
    const lines = [
      `Retro ${id} was held (${covers || kind}). Its minutes are in .loop/retros/${id}.md: read them first, they are your brief.`,
      actions.length ? `Action items:\n${actions.map((a) => `- ${a.id} (${a.rung}): ${a.title}. ${a.what} Done when: ${a.doneWhen}`).join('\n')}` : 'This retro handed out no action items.',
      changes.length ? `Earlier action items to change:\n${changes.map((c) => `- ${c.action} "${c.title}": ${c.status === 'retired' ? 'take it back' : 'replace it as the new action items say'}. ${c.note}`).join('\n')}` : '',
      keeps.length ? `Practices to write down under "Keep doing":\n${keeps.map((k) => `- ${k.practice} (${k.evidence})`).join('\n')}` : '',
      'File the minutes: every .loop/retros/R-<number>.md that is not in docs/retros/ yet goes there, word for word. Nothing from .loop/retros/data/ is ever filed.',
    ];
    learn = { kind: 'learn', id: learnId, milestone, retro: id, title: actions.length ? `Retro ${id}: ${actions.map((a) => a.title).join('; ')}`.slice(0, 160) : `Retro ${id}: file the minutes${changes.length || keeps.length ? ' and update the lessons' : ''}`, scope: lines.filter(Boolean).join('\n\n'), refs: [`.loop/retros/${id}.md`, 'loop/prompts/learn.md', 'docs/LESSONS.md', 'loop/rules/project-rules.json'], ui: false, dependsOn: [] };
  }
  r.actions.push(...actions);

  // 5. Everything was on the table: the count of items per signal starts again.
  for (const e of Object.values(S.learn || {})) e.items = [];
  r.n++;
  r.due = null;
  r.lastAt = at;
  if (kind === 'milestone' && milestone) r.milestones[milestone] = id;
  const again = seenAgain.map((i) => ({ id: i.id, title: i.title, part: i.part, seen: i.seen }));
  const retro = { id, kind, milestone: milestone || null, at, covers, summary: text(out.summary, 1200), wentWell, problems, checks, actions, impediments, seenAgain: again, escalated, dropped, learn: learn?.id || null };
  r.held.push({ id, kind, milestone: milestone || null, at, actions: actions.map((a) => a.id), impediments: impediments.map((i) => i.id), learn: retro.learn });
  return { retro, learn, impediments, seenAgain, checks, escalated, dropped };
}

/**
 * The harness changed (a sync from the template): every open impediment waits for its recheck,
 * and the numbers settle it (applyRetro): closed when its cause stays away, open again when it
 * comes back. Nothing is asked of anyone and no signal starts calling retros again: a signal that
 * is recorded as an impediment stays quiet until its entry closes. Returns the impediments
 * affected.
 */
export function harnessChanged(S, version) {
  const r = retroState(S);
  if (r.harness === version) return [];
  const first = r.harness === undefined;
  r.harness = version;
  if (first) return [];
  // Entries from a harness that still recorded guard refusals: a refusal is the guard working.
  for (const i of r.impediments.filter((x) => x.status !== 'closed' && (x.part === 'guard' || isGuard(x.signal)))) {
    Object.assign(i, { status: 'closed', note: 'A refusal is the guard working: it is no longer recorded.' });
    if (i.signal && S.learn?.[i.signal]?.muted?.by === i.id) delete S.learn[i.signal].muted;
  }
  // Also the ones already waiting for a recheck: what they saw belongs to the harness before this one.
  const open = r.impediments.filter((i) => i.status === 'open' || i.status === 'recheck');
  for (const i of open) Object.assign(i, { status: 'recheck', recheckAt: S.iterations || 0, back: [] });
  return open;
}

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : 'None.');

/** The minutes of one retro, as the Markdown page that is filed in docs/retros/. */
export function renderMinutes(retro) {
  const owner = { product: 'the product', practice: 'how we work', harness: 'the harness', owner: 'the owner' };
  const what = retro.kind === 'milestone' ? `after milestone ${retro.milestone}` : 'called early';
  return [
    `# Retro ${retro.id}, ${what}`,
    `${retro.at.slice(0, 10)}. ${retro.covers ? `Covers ${retro.covers}. ` : ''}Written by the runner from the retro session's result; do not edit.`,
    retro.summary,
    `## What went well: keep doing\n\n${table(['Practice', 'Evidence', 'Written down'], retro.wentWell.map((w) => [w.practice, w.evidence, w.keep ? 'yes, under "Keep doing"' : 'no']))}`,
    `## What went wrong\n\n${table(['Problem', 'Evidence', 'Cause', 'The cause is in'], retro.problems.map((p) => [p.title, p.evidence, p.cause, owner[p.owner]]))}`,
    `## Earlier action items, checked\n\n${table(['Action', 'Items since', 'Still happened in', 'Verdict', 'Decision', 'Note'], retro.checks.map((c) => [`${c.action} ${c.title}`, c.itemsSince, c.hits, c.verdict.replace('_', ' '), c.decision, c.note]))}`,
    `## Action items\n\n${table(['Action', 'Kind', 'What', 'Expected effect', 'Done when'], retro.actions.map((a) => [`${a.id} ${a.title}`, a.rung, a.what, a.expect, a.doneWhen]))}${retro.learn ? `\n\nCarried out by ${retro.learn}.` : ''}`,
    `## Impediments\n\nDefects in the harness that broke something in this stretch. The loop does not fix them and does not work around them, and nothing in the run waits for them: they are a record for whoever maintains the template.\n\n${table(['Impediment', 'Part', 'What it broke', 'Evidence', 'Example', 'Wanted'], retro.impediments.map((i) => [`${i.id} ${i.title}`, i.part, i.broke, i.evidence, i.example ? `\`${i.example.replace(/`/g, "'")}\`` : '-', i.wanted]))}${(retro.seenAgain || []).length ? `\n\nMet again, already on the list: ${retro.seenAgain.map((i) => `${i.id} (${i.seen} times)`).join(', ')}.` : ''}`,
    retro.escalated.length ? `## Given to the owner\n\nThese signals had ${MAX_ACTIONS_PER_SIGNAL} action items and still come back: ${retro.escalated.map((s) => `\`${s}\``).join(', ')}.` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

/** Every impediment that is not closed, as a page to read (.loop/IMPEDIMENTS.md). */
export function renderImpediments(S) {
  const r = retroState(S);
  const rows = r.impediments.filter((i) => i.status !== 'closed');
  const closed = r.impediments.length - rows.length;
  return `# Impediments\n\nDefects in the harness that broke something during the run: in the runner, the prompts, CI's wiring or a profile. This is a record, not a to-do list: nothing in the run waits for it, one cause has one row, and meeting it again raises "Seen". After a sync from the template (\`node scripts/sync-template.mjs\`) a row waits as "recheck" and closes by itself once its cause stays away. A guard refusal is the guard working and is never listed.\n\n${table(['Id', 'Status', 'Part', 'Impediment', 'What it broke', 'Evidence', 'Example', 'Wanted', 'Signal', 'First', 'Seen', 'Last'], rows.map((i) => [i.id, i.status, i.part, i.title, i.broke, i.evidence, i.example ? `\`${i.example.replace(/`/g, "'")}\`` : '-', i.wanted, i.signal || '-', i.retro, i.seen || 1, i.lastRetro || i.retro]))}${closed ? `\n\n${closed} closed.` : ''}\n`;
}

export const retroId = (n) => `R-${pad(n)}`;

/** The review finding categories the reviewer must pick from (loop/lib/schemas.mjs uses this list). */
export const REVIEW_CATEGORIES = ['acceptance', 'tests', 'bug', 'security', 'hard-rule', 'design', 'accessibility', 'docs', 'scope'];

/** A reviewer's cause text as a stable key: lowercase words joined by dashes, at most 40 chars. */
export function causeKey(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/**
 * What one review verdict counts as: per blocking finding its category, and its category with
 * the cause when the reviewer gave one. [{ signature, level: 'category' | 'cause', issues }]
 */
export function reviewFailures(verdict) {
  const out = new Map();
  const add = (signature, level, issue) => {
    const e = out.get(signature) || { signature, level, issues: [] };
    if (issue) e.issues.push(String(issue));
    out.set(signature, e);
  };
  for (const b of verdict?.blocking || []) {
    const cat = REVIEW_CATEGORIES.includes(b?.category) ? b.category : 'other';
    add(`review:${cat}`, 'category', b?.issue);
    const cause = causeKey(b?.cause);
    if (cause) add(`review:${cat}:${cause}`, 'cause', b?.issue);
  }
  return [...out.values()];
}

/** The cause keys this run has seen, as "category/cause", most frequent first: the reviewer reuses them. */
export function knownCauses(S) {
  return Object.entries(S?.learn || {})
    .map(([sig, e]) => [sig.match(/^review:([^:]+):(.+)$/), e.count])
    .filter(([m]) => m)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => `${m[1]}/${m[2]}`);
}

/** Signatures for one review verdict: one per blocking category. */
export function reviewSignatures(verdict) {
  const cats = new Set((verdict?.blocking || []).map((b) => (REVIEW_CATEGORIES.includes(b?.category) ? b.category : 'other')));
  return [...cats].map((c) => `review:${c}`);
}

/** Guard blocks a session caused: lines appended to the guard log since `offset` for `item`. */
export function guardSignatures(logText, item) {
  return String(logText || '')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 5 && f[1] === item)
    .map((f) => ({ signature: `guard:${f[3]}`, detail: f[4] }));
}
