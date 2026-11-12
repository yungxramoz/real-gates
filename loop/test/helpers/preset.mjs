// The config a project of a given stack starts from: the core defaults with that stack's profile
// over them. Every profile ships with the harness (loop/profiles/), so this suite tests each one
// whatever profile the repository it runs in uses. Tests of the core alone use DEFAULTS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProfile, withProfile } from '../../lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** The profile the older scenarios were written against. */
export const WEB = 'next-supabase-vercel';
export const presetConfig = (name) => ({ ...withProfile(loadProfile(REPO, name)), profile: name });
export const PRESET = presetConfig(WEB);
