// Guard pack: npm (and pnpm, yarn) for a project that ships a package. Publishing, registry
// accounts and releases are the owner's, and a session never changes the machine's global
// packages: what it needs to try an installed package goes into a folder under .loop/.

import { no } from '../shared.mjs';

export const name = 'npm';

export const deny = ['Bash(npm publish:*)'];

const PM = '(?:npm|pnpm|yarn)';

export function shell(c) {
  if (new RegExp(`\\b${PM}\\s+(publish|unpublish|deprecate|dist-tag|owner|access|login|adduser|logout|token)\\b`, 'i').test(c)) return no('npm:publish', 'publishing and registry accounts are the owner\'s. Put the release ask in owner_actions.');
  if (new RegExp(`\\b${PM}\\s+version\\s+(?!--help)\\S`, 'i').test(c)) return no('npm:version', 'a version bump is a release decision, and it creates a commit and a tag. Put the ask in owner_actions.');
  if (new RegExp(`\\b${PM}\\s+(i|install|add|link|uninstall|remove|rm)\\b[^;|&]*\\s(-g|--global)\\b`, 'i').test(c) || new RegExp(`\\b${PM}\\s+link\\s*($|[;|&])`, 'i').test(c) || /\byarn\s+global\b/i.test(c)) return no('npm:global', 'do not change this machine\'s global packages. Install into a folder under .loop/ (npm install --prefix .loop/<dir> <tarball>) and run the binary from there.');
  return null;
}
