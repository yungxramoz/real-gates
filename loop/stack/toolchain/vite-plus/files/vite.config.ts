import { defineConfig } from 'vite-plus';

import fmt from './gates/fmt.ts';
import lint from './gates/lint.ts';
import test from './gates/test.ts';

// A port from the environment, so a session can start this build on a port of its own.
const port = Number(process.env.PORT) || undefined;

// The build's own settings go here. `lint`, `fmt` and `test` are passed as they are imported:
// scripts/check-gates.mjs fails when they are not.
export default defineConfig({
  ...(port ? { server: { port, strictPort: true }, preview: { port, strictPort: true } } : {}),
  lint,
  fmt,
  test,
});
