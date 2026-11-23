import { defineConfig } from 'vite-plus';

import fmt from './gates/fmt.ts';
import lint from './gates/lint.ts';
import test from './gates/test.ts';

// The build's own settings go here. `lint`, `fmt` and `test` are passed as they are imported:
// scripts/check-gates.mjs fails when they are not.
export default defineConfig({
  lint,
  fmt,
  test,
});
