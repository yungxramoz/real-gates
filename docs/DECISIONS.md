# Decisions

Defaults chosen so work can start without waiting. **The owner can change any of them.** When
something changes, update this file and anything that cites the decision.

How to add one:

1. Take the next free ID from the **last log bullet** at the bottom. Never reuse or renumber an ID.
2. Add a row at the bottom of the table: the decision in bold first, then why, then what it
   affects. One row per decision. Write it so a fresh session can act on it without asking.
3. Add a log bullet at the bottom: date, ID, a short summary, who, the files it affects, and the
   next free ID.
4. A decision that replaces another says so ("supersedes D-0nn"), and the old row gets
   "superseded by D-0mm". Rows are never deleted.

Loop sessions record small, reversible calls here instead of asking. Calls that are the owner's
(product, design, release, accounts) go to `.loop/OWNER-ACTIONS.md` instead.

| ID    | Decision                                                                                                                                                                                                          | Why                                                                                                                                                              | Affects                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| D-001 | **This project is built with real-gates: one agent, item by item, and the loop script — not an agent — decides when an item is done and merges it into the base branch.** It never touches the production branch. | Gates the script enforces hold where prose rules don't, and a sequential loop avoids agents colliding in one working tree. The story behind each gate: `WHY.md`. | `loop/`, `CLAUDE.md`, `.github/workflows/` |

## Log

- D-001 added (built with real-gates) — template — affects `loop/`, `CLAUDE.md`. Next free ID: **D-002**
