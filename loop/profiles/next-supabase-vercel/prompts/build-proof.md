- `pnpm check` and `pnpm build` must pass.
   - New logic gets unit tests. Never lower a coverage threshold; the ratchet only goes up and the
     runner refuses a PR that lowers it.
   - UI work gets at least one Playwright journey in `tests/e2e/journeys/` whose title carries the
     AC ID. Run it against a local production build on an unusual port, and first fetch a page and
     check for a string only your branch serves: another process on the port gives a convincing
     false pass. Take 360 px and desktop screenshots into `.loop/shots/{{ITEM_ID}}/` and **look at
     them**. Judge against `DESIGN.md` and `design/mocks/accepted/`. The reviewer scores design
     quality, originality, craft and functionality 1–10 and blocks anything below {{MIN_SCORE}}.
