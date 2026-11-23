// Work types: what kind of thing a backlog item delivers, and so how it is reviewed and accepted.
//
// A web screen is judged by looking at it where it runs. A CLI command is judged by running it
// from an installed package. A library function needs neither. Each product block of the stack
// defines the kind it is about (`workTypes` in loop/stack/product/<name>/block.json), and for it:
//   rubric   the scores the reviewer must give, 1–10 each; any below review.minDesignScore blocks.
//            [] = no scores
//   accept   how a milestone with such items is accepted:
//              'site'           on the deployed dev site, after the deploy adapter says it serves
//                               the merge. A stack that deploys nothing cannot have such a type
//              'local'          on the merged base branch itself, on this machine, whatever is
//                               deployed (a package is judged installed, not hosted)
//              'site-or-local'  where the product runs: on the deployed dev site when the stack
//                               deploys one, otherwise on the merged base itself
//              'none'           no acceptance step
//
// An item names its type with `type`. The older `ui: true | false` still works: true is the type
// `ui`, false (or nothing) is `default`.

const NO_TYPE = Object.freeze({ rubric: [], accept: 'none' });
/** What a work type may say under `accept`. */
export const ACCEPT_MODES = ['site', 'local', 'site-or-local', 'none'];
/** Where a milestone can be accepted, in the order its parts are taken. */
export const PLACES = ['site', 'local'];

export function workTypeName(item) {
  return item?.type || (item?.ui ? 'ui' : 'default');
}

export function workType(cfg, item) {
  return cfg.workTypes?.[workTypeName(item)] || NO_TYPE;
}

/** Whether the stack deploys the base branch somewhere the runner can wait for. */
const deploys = (cfg) => cfg.deploy?.adapter !== 'none';

/** Where items of the work type `type` are accepted in this project: 'site', 'local' or 'none'. */
export function acceptPlace(cfg, type) {
  const accept = type?.accept;
  if (accept === 'site-or-local') return deploys(cfg) ? 'site' : 'local';
  return PLACES.includes(accept) ? accept : 'none';
}

/**
 * How a milestone with these items is accepted: one part per place, each with the work types
 * accepted there, in the order the items name them. A milestone can have both parts: screens on
 * the deployed site and a command on the merged base. [] = no acceptance step.
 */
export function acceptPlan(cfg, items) {
  return PLACES.map((place) => ({ place, types: [...new Set((items || []).filter((i) => acceptPlace(cfg, workType(cfg, i)) === place).map(workTypeName))] })).filter((part) => part.types.length);
}

/** The one word for how a milestone is accepted: 'site' as soon as a part of it is, else 'local', else 'none'. */
export function acceptMode(cfg, items) {
  return acceptPlan(cfg, items)[0]?.place || 'none';
}

/**
 * The work type an acceptance fix item gets, so that it is reviewed on the right rubric: the type
 * of the item the failure is about when the evaluator named one that is accepted, otherwise the
 * first accepted type of the milestone. 'default' when nothing is accepted.
 */
export function acceptTypeName(cfg, items, relatedId) {
  const accepted = (i) => acceptPlace(cfg, workType(cfg, i)) !== 'none';
  const related = relatedId ? (items || []).find((i) => i.id === relatedId) : null;
  const it = related && accepted(related) ? related : (items || []).find(accepted);
  return it ? workTypeName(it) : 'default';
}

/** What is wrong with the stack's work types, or with the backlog's use of them. */
export function workTypeProblems(cfg, backlog) {
  const p = [];
  const types = cfg.workTypes || {};
  for (const [name, t] of Object.entries(types)) {
    if (t === null) continue; // a project removes a type its stack brings by setting it to null
    if (!Array.isArray(t?.rubric) || t.rubric.some((r) => !/^[a-z][a-z0-9_]*$/.test(r))) p.push(`workTypes.${name}.rubric must be a list of score names (lowercase, digits, underscores)`);
    if (!ACCEPT_MODES.includes(t?.accept)) p.push(`workTypes.${name}.accept must be one of ${ACCEPT_MODES.join(', ')}`);
    if (t?.accept === 'site' && !deploys(cfg) && (backlog?.items || []).some((i) => workTypeName(i) === name)) p.push(`work type "${name}" is accepted on a deployed site, but deploy.adapter is "none"`);
  }
  for (const i of backlog?.items || []) {
    const name = workTypeName(i);
    if (name !== 'default' && !types[name]) p.push(`backlog item ${i.id}: work type "${name}" is not one of the stack's (${Object.keys(types).filter((k) => types[k]).sort().join(', ') || 'none defined'})${i.type ? '' : '; `ui: true` means the type "ui"'}`);
  }
  return p;
}
