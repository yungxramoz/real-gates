// Learning inside the unattended run.
//
// The model doesn't change between sessions; the repository does. When the same failure keeps
// coming back, the runner queues a LEARN item, first in line, whose job is to remove the cause: a
// lesson row in docs/LESSONS.md that names the command proving it, a test or check, or a stricter
// project guard rule. It goes through the same CI and review gates and merges itself.
//
// Signatures: review:<category>:<cause> (a blocking review finding with the cause key the reviewer
// gave it), review:<category> (the same category whatever the cause, with a higher threshold),
// guard:<rule id> (a guard block), ci:<job name> (a red CI job on a PR), gate:<command> (the local
// gate). Acceptance failures need no counter: each one already becomes an ACC fix item whose scope
// includes fixing the cause.
//
// Why two review levels: nine categories are coarse. Two unrelated bugs in fifty items are not a
// pattern, and a LEARN item costs a whole build cycle. The reviewer names the cause and is shown
// the keys already in use, so the same cause gets the same key; that pair triggers at
// learnThreshold. The bare category stays as a net for causes that never got the same key twice.

export const MAX_LEARN_PER_SIGNATURE = 3;

/**
 * Count one failure. Returns a LEARN item to queue when the signature has failed `threshold` more
 * times since the last LEARN item for it (so a LEARN that did not work is followed by another, up to
 * MAX_LEARN_PER_SIGNATURE), else null. Mutates S.learn.
 */
export function recordFailure(S, { signature, detail, item, threshold = 2 }) {
  S.learn ||= {};
  const e = (S.learn[signature] ||= { count: 0, sinceLearn: 0, details: [], queued: [] });
  e.count++;
  e.sinceLearn++;
  if (detail) e.details = [...e.details, `${item?.id || '-'}: ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}`].slice(-5);
  if (e.sinceLearn < threshold || e.queued.length >= MAX_LEARN_PER_SIGNATURE) return null;
  e.sinceLearn = 0;
  const n = Object.values(S.learn).reduce((a, x) => a + x.queued.length, 0) + 1;
  const id = `LEARN-${n}`;
  e.queued.push(id);
  const again = e.queued.length > 1 ? ` An earlier LEARN item (${e.queued.slice(0, -1).join(', ')}) did not stop it, so go one step up the ladder this time.` : '';
  return {
    kind: 'learn',
    id,
    milestone: item?.milestone,
    title: `Stop "${signature}" from recurring`,
    signature,
    scope: `The run hit "${signature}" ${e.count} times.${again} Recent cases:\n- ${e.details.join('\n- ')}`,
    refs: ['loop/prompts/learn.md', 'docs/LESSONS.md', 'loop/rules/project-rules.json'],
    ui: false,
    dependsOn: [],
  };
}

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
