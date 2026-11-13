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
// A cause in the harness itself (the guard, the runner, the prompts, CI's wiring) is not the
// loop's to fix, and not to work around either: the retro records it as an impediment for the
// owner, and that signal stops calling retros.
//
// Signals: review:<category>:<cause> (a blocking review finding with the cause key the reviewer
// gave it), review:<category> (the same category whatever the cause), guard:<rule id> (a guard
// block), ci:<job name> (a red CI job on a PR), gate:<command> (the local gate), premerge.
//
// Why two thresholds: a cause the reviewer named, a red CI job or a failing gate in two different
// items is a pattern (learnThreshold). A bare review category or a guard rule is coarse, and a
// retro costs a session, so those need more items (learnCategoryThreshold).

import { TERMINAL } from './state.mjs';

/** After this many action items a signal that still comes back goes to the owner. */
export const MAX_ACTIONS_PER_SIGNAL = 3;

const oneLine = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
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

/** Signals a guard rule or a bare review category gives: coarse, so they need more items. */
export const isCoarse = (signal) => /^guard:/.test(signal) || /^review:[^:]+$/.test(signal);

/**
 * Count one failure. Returns true when this one makes a retro due: the signal has now shown up in
 * `threshold` different items since it was last on a retro's table. Mutates S.learn and S.retro.
 *
 * A LEARN item's own failures never count towards a retro: it studies a failure, often trips it
 * while doing so, and its own review rounds are not a pattern in the product's work.
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
  if (e.muted) return false;
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

/** What the numbers say about an action item, before the retro decides. */
export function actionVerdict(a, cfg) {
  if (!a.since) return 'not merged yet';
  if (a.hits.length >= 2) return 'no effect';
  if (a.itemsSince.length >= (cfg.retro?.checkAfterItems ?? 5)) return a.hits.length ? 'weak' : 'worked';
  return 'too early';
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
 * has to do: { retro, learn (the LEARN item to queue, or null), impediments (new ones), checks,
 * dropped (what was not taken, with the reason) }.
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

  // 2. Impediments: causes in the harness. One per signal; that signal stops calling retros.
  // One that waits for a recheck (the harness changed) is settled by the numbers: open again as
  // soon as its signal came back on the new harness, closed once a few sessions ran without it.
  for (const i of r.impediments.filter((x) => x.status === 'recheck' && x.signal)) {
    if ((i.back || []).length) {
      i.status = 'open';
      if (S.learn?.[i.signal]) S.learn[i.signal].muted = { by: i.id };
    } else if ((S.iterations || 0) - (i.recheckAt || 0) >= 6) i.status = 'closed';
  }
  const impediments = [];
  for (const x of Array.isArray(out.impediments) ? out.impediments : []) {
    if (!x?.title) continue;
    const signal = S.learn?.[x.signal] ? x.signal : null;
    if (signal && r.impediments.some((i) => i.status === 'open' && i.signal === signal)) {
      dropped.push(`impediment "${text(x.title, 80)}": ${signal} is already reported`);
      continue;
    }
    const imp = { id: `IMP-${r.impediments.length + 1}`, retro: id, status: 'open', at, title: text(x.title, 160), part: text(x.part, 20) || 'other', evidence: text(x.evidence), example: text(x.example, 400), wanted: text(x.wanted), signal };
    r.impediments.push(imp);
    impediments.push(imp);
    if (signal) S.learn[signal].muted = { by: imp.id };
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
    actions.push({ id: `A-${r.actions.length + actions.length + 1}`, retro: id, status: 'open', title: text(x.title, 160), rung: ['lesson', 'test', 'rule', 'tool'].includes(x.rung) ? x.rung : 'lesson', what: text(x.what, 900), expect: text(x.expect, 300), doneWhen: text(x.done_when, 300), signal, since: null, itemsSince: [], hits: [] });
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
  const retro = { id, kind, milestone: milestone || null, at, covers, summary: text(out.summary, 1200), wentWell, problems, checks, actions, impediments, escalated, dropped, learn: learn?.id || null };
  r.held.push({ id, kind, milestone: milestone || null, at, actions: actions.map((a) => a.id), impediments: impediments.map((i) => i.id), learn: retro.learn });
  return { retro, learn, impediments, checks, escalated, dropped };
}

/**
 * The harness changed (a sync from the template): every signal reported as an impediment counts
 * again, so the next retro sees whether the change removed it. Returns the impediments affected.
 */
export function harnessChanged(S, version) {
  const r = retroState(S);
  if (r.harness === version) return [];
  const first = r.harness === undefined;
  r.harness = version;
  if (first) return [];
  for (const e of Object.values(S.learn || {})) if (e.muted && e.muted.by !== 'owner') delete e.muted;
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
    `## Impediments: for the owner\n\nCauses in the harness. The loop does not fix these and does not work around them.\n\n${table(['Impediment', 'Part', 'Evidence', 'Example', 'Wanted'], retro.impediments.map((i) => [`${i.id} ${i.title}`, i.part, i.evidence, i.example ? `\`${i.example.replace(/`/g, "'")}\`` : '-', i.wanted]))}`,
    retro.escalated.length ? `## Given to the owner\n\nThese signals had ${MAX_ACTIONS_PER_SIGNAL} action items and still come back: ${retro.escalated.map((s) => `\`${s}\``).join(', ')}.` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

/** Every open impediment, as the page the owner reads (.loop/IMPEDIMENTS.md). */
export function renderImpediments(S) {
  const r = retroState(S);
  const rows = r.impediments.filter((i) => i.status !== 'closed');
  return `# Impediments\n\nWhat holds the loop back and is not the loop's to fix: causes in the guard, the runner, the prompts or CI's wiring. A retro puts them here. Fix them in the template and bring the fix in with \`node scripts/sync-template.mjs\`; the signal then counts again, and the next retro checks whether it is gone ("recheck").\n\n${table(['Id', 'Status', 'Part', 'Impediment', 'Evidence', 'Example', 'Wanted', 'Signal', 'Retro'], rows.map((i) => [i.id, i.status, i.part, i.title, i.evidence, i.example ? `\`${i.example.replace(/`/g, "'")}\`` : '-', i.wanted, i.signal || '-', i.retro]))}\n`;
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
