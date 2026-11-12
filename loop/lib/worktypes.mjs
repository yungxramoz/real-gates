// Work types: what kind of thing a backlog item delivers, and so how it is reviewed and accepted.
//
// A web screen is judged by looking at it on the deployed site. A CLI command is judged by running
// it from an installed package. A library function needs neither. The profile says which kinds a
// stack has (`workTypes`), and for each one:
//   rubric   the scores the reviewer must give, 1–10 each; any below review.minDesignScore blocks.
//            [] = no scores
//   accept   how a milestone with such items is accepted:
//              'site'   on the deployed dev site, after the deploy adapter says it serves the merge
//              'local'  on the merged base branch itself, with nothing deployed
//              'none'   no acceptance step
//
// An item names its type with `type`. The older `ui: true | false` still works: true is the type
// `ui`, false (or nothing) is `default`.

const NO_TYPE = Object.freeze({ rubric: [], accept: 'none' });
export const ACCEPT_MODES = ['site', 'local', 'none'];

export function workTypeName(item) {
  return item?.type || (item?.ui ? 'ui' : 'default');
}

export function workType(cfg, item) {
  return cfg.workTypes?.[workTypeName(item)] || NO_TYPE;
}

/** How a milestone with these items is accepted: 'site' if any item needs the site, else 'local' if any needs that, else 'none'. */
export function acceptMode(cfg, items) {
  const modes = new Set((items || []).map((i) => workType(cfg, i).accept));
  return modes.has('site') ? 'site' : modes.has('local') ? 'local' : 'none';
}

/** The work type an acceptance fix item gets: the first type in the milestone that is accepted at all. */
export function acceptTypeName(cfg, items) {
  const mode = acceptMode(cfg, items);
  const it = (items || []).find((i) => workType(cfg, i).accept === mode);
  return it && mode !== 'none' ? workTypeName(it) : 'default';
}

/** What is wrong with the profile's work types, or with the backlog's use of them. */
export function workTypeProblems(cfg, backlog) {
  const p = [];
  const types = cfg.workTypes || {};
  for (const [name, t] of Object.entries(types)) {
    if (t === null) continue; // a profile removes a default type by setting it to null
    if (!Array.isArray(t?.rubric) || t.rubric.some((r) => !/^[a-z][a-z0-9_]*$/.test(r))) p.push(`workTypes.${name}.rubric must be a list of score names (lowercase, digits, underscores)`);
    if (!ACCEPT_MODES.includes(t?.accept)) p.push(`workTypes.${name}.accept must be one of ${ACCEPT_MODES.join(', ')}`);
    if (t?.accept === 'site' && cfg.deploy?.adapter === 'none' && (backlog?.items || []).some((i) => workTypeName(i) === name)) p.push(`work type "${name}" is accepted on a deployed site, but deploy.adapter is "none"`);
  }
  for (const i of backlog?.items || []) {
    const name = workTypeName(i);
    if (name !== 'default' && !types[name]) p.push(`backlog item ${i.id}: work type "${name}" is not one of the profile's (${Object.keys(types).filter((k) => types[k]).sort().join(', ') || 'none defined'})${i.type ? '' : '; `ui: true` means the type "ui"'}`);
  }
  return p;
}
