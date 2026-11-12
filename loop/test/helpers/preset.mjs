// The config a project of this template's stack starts from: the core defaults with the stack
// profile over them. Tests of stack behaviour (guard packs, gate files, the deploy probe) build on
// this; tests of the core alone use DEFAULTS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProfile, withProfile } from '../../lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PROFILE = loadProfile(REPO);
export const PRESET = withProfile(PROFILE);
