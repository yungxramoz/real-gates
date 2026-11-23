// The format rules. A pull request may not change this file: the loop refuses one that does.
// vite.config.ts imports it and passes it on as it is (scripts/check-gates.mjs).
import type { UserConfig } from 'vite-plus';

export default {
  singleQuote: true,
  printWidth: 100,
} satisfies NonNullable<UserConfig['fmt']>;
