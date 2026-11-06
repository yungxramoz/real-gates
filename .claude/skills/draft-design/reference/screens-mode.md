# Screens mode: `/draft-design screens <epic>`

Prototypes the screens of one epic before the loop builds them, so each UI item has a mock to be
scored against. Uses the accepted `DESIGN.md`; does not change the direction.

## Workflow

```
Screens progress:
- [ ] 1. Read the epic, DESIGN.md and the accepted mocks
- [ ] 2. List the epic's screens and states; confirm with the owner
- [ ] 3. Build each screen with DESIGN.md tokens and components only
- [ ] 4. Shoot, look, fix, repeat
- [ ] 5. Show; one refinement round
- [ ] 6. Accept and link the mocks from the backlog items
```

1. **Read** the epic's stories and ACs in `docs/REQUIREMENTS.md`, its items in `loop/backlog.json`,
   `DESIGN.md` and `design/mocks/accepted/`.
2. **List screens and states.** One row per screen: which ACs it serves and which states it needs
   (empty, loading, error, success, full, no permission). Ask the owner to confirm the list;
   recommend leaving out states no AC mentions.
3. **Build** `design/mocks/accepted/<epic>/<screen>.html`, copying the `:root` block from
   `DESIGN.md` unchanged. Show states as stacked sections of one file, each with a small label. A
   component that `DESIGN.md` lacks is allowed only if no existing one fits; add it to `DESIGN.md`
   in step 6.
4. **Shoot**: `node .claude/skills/draft-design/scripts/shoot.mjs design/mocks/accepted/<epic>`
   from the repo root. Look at every PNG, fix, rerun until no `PROBLEM`.
5. **Show** the shots, ask for changes, apply them once, shoot again.
6. **Accept**: add each mock's path to the `refs` of the backlog items that build it, add new
   components to `DESIGN.md`, then validate the backlog:

   ```bash
   node .claude/skills/shape-project/scripts/check-backlog.mjs
   ```

   Fix any `PROBLEM`, rerun until `OK`. Propose a branch `design/<epic>` and a PR into the base
   branch; wait for a yes before `git push`.

Do this before the loop reaches the epic: an item whose mock arrives after its build gets scored
against the general direction only.
