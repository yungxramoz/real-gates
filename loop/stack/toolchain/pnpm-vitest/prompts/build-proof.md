- `pnpm check` and `pnpm build` must pass.
- New logic gets unit tests. Never lower a coverage threshold; the ratchet only goes up and the
  runner refuses a PR that lowers it.
