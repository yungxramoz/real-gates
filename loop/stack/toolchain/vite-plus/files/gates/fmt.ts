// The format rules. A pull request may not change this file: the loop refuses one that does.
// vite.config.ts imports it and passes it on as it is (scripts/check-gates.mjs).
import type { UserConfig } from 'vite-plus';

export default {
  singleQuote: true,
  printWidth: 100,
  // The loop, the skills, the workflows and the repository's own scripts come from the template
  // in the form they have there, and the runner writes the retro minutes as they are. A session
  // cannot edit any of them, so a format finding in them is one nobody here could fix.
  ignorePatterns: ['loop/**', '.claude/**', '.github/**', 'scripts/**', 'docs/retros/**'],
} satisfies NonNullable<UserConfig['fmt']>;
