- `npm run check` (syntax, unit tests, coverage thresholds) and `npm run test:e2e` must pass.
- New logic gets unit tests in `tests/unit/` with `node:test`. Never lower a number in
  `coverage.thresholds.json`; the ratchet only goes up and the runner refuses a PR that lowers it.
