- `pnpm check` (the gate wiring check, then format, lint and types with `vp check`, then the unit
  tests with coverage) and `pnpm build` must pass.
- New logic gets unit tests. Never lower a coverage threshold in `gates/test.ts`; the ratchet only
  goes up and the runner refuses a PR that lowers it.
- Settings for the build go into `vite.config.ts`. Leave `lint`, `fmt` and `test` there as they
  are imported: `scripts/check-gates.mjs` fails when one is left out, overridden or changed.
