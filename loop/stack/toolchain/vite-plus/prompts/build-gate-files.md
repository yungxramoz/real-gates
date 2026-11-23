the `scripts` in `package.json`, `scripts/`, the lint and format rules in
`gates/lint.ts` and `gates/fmt.ts`, the type configs, and any config file a tool would read
instead of them (`.oxlintrc*`, `.oxfmtrc*`, `vitest.config.*`). `gates/test.ts` may change only
by raising coverage thresholds.
