// What the guard core and its packs share. Kept apart so a pack never has to import the core.

/** Steps that may read and run, but never change the repository. */
export const READ_ONLY_PHASES = new Set(['review', 'accept', 'packet', 'retro']);

/**
 * The folders whose migration files are frozen once they are on the base branch: every
 * `migrationsDir` of a post-merge step (the runner applies those), and `migrations.dirs` (a
 * database the app migrates itself, like a local file, has no step after a merge, and its
 * migrations are just as final). Without a trailing slash.
 */
export const migrationDirs = (cfg) => [...new Set([...(cfg?.migrations?.dirs || []), ...(cfg?.postMerge || []).map((s) => s.migrationsDir)].filter((d) => typeof d === 'string' && d).map((d) => d.replace(/\/+$/, '')))];

export const ok = { block: false };
export const no = (rule, reason) => ({ block: true, rule, reason });
export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
