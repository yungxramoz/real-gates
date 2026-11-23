# 3 · Solution strategy

<!-- Written by /setup-loop from the stack, then changed only through a decision. -->

- **How it is built:** real-gates loop: one agent, the script merges ([D-001](../DECISIONS.md))
- **Language and toolchain:** TypeScript strict on Vite+ (Oxfmt, Oxlint with the type check,
  Vitest); pnpm
- **Tests:** unit tests beside the code with a coverage ratchet; end-to-end tests with Playwright
  against a production build started locally
- **Gates:** the lint, format and test rules live in `gates/` and cannot be changed by a pull
  request; `scripts/check-gates.mjs` holds the config to them
<!-- stack:strategy -->

## Key ideas

<!-- Two to five bullets: the ideas that shape the code. -->
