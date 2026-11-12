// What the guard core and its packs share. Kept apart so a pack never has to import the core.

/** Steps that may read and run, but never change the repository. */
export const READ_ONLY_PHASES = new Set(['review', 'accept', 'packet']);

export const ok = { block: false };
export const no = (rule, reason) => ({ block: true, rule, reason });
export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
