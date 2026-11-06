---
name: shape-project
description: Shapes an app idea into the documents the unattended loop builds from. Interviews the owner one question at a time, then writes docs/BRIEF.md, docs/REQUIREMENTS.md with numbered testable acceptance criteria (AC-n.n), milestones, loop/backlog.json items that point at those docs, seed rows in docs/DECISIONS.md and docs/OWNER-ACTIONS.md, validates the backlog, and ends with a builder check by a fresh subagent. Use when starting a project from the template, when the owner describes what to build, wants to brainstorm, plan or scope an app, writes requirements or user stories, or adds an epic or milestone.
disable-model-invocation: true
argument-hint: "[epic or milestone to add]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/check-backlog.mjs"*)
---

# Shape the project

Done means: a fresh session with no chat history can build every backlog item from the docs alone,
`node "${CLAUDE_SKILL_DIR}/scripts/check-backlog.mjs"` prints `OK`, and the builder check found no
open guess.

## Rules

1. **One question at a time.** Each question comes with a recommended answer and the reason. Wait.
   Play back what you heard after each topic in three to five bullets and let the owner correct it.
2. **The docs are the source of truth.** A backlog item names AC IDs and doc paths; it never copies
   acceptance criteria. Anything a builder needs goes into a doc, not into the chat.
3. **Every AC is testable.** One observable behaviour, written so a test title can carry its ID.
   No "fast", "nice" or "intuitive" without a number or an observable result.
4. **Decide small things, record them.** A reversible detail the owner does not care about gets a
   default and a row in `docs/DECISIONS.md`. Ask only what is genuinely the owner's call.
5. **Keep `LOOP-0` first.** It belongs to `/setup-loop`. Never remove or reorder it.
6. If nobody can answer (a headless `-p` session), stop and change nothing.

With an argument (`/shape-project <epic or milestone>`), shape only that addition: skip to step 2
for that scope, keep existing IDs, and continue numbering.

## Workflow

Copy this checklist into your reply and tick it off as you go:

```
Shaping progress:
- [ ] 1. Read what exists
- [ ] 2. Interview, one topic at a time, with a play-back after each
- [ ] 3. Play back the whole picture; get a yes
- [ ] 4. Write docs/BRIEF.md
- [ ] 5. Write docs/REQUIREMENTS.md (epics, stories, ACs)
- [ ] 6. Cut milestones; write loop/backlog.json and docs/BACKLOG.md
- [ ] 7. Validate: run check-backlog, fix, repeat until OK
- [ ] 8. Seed docs/DECISIONS.md, write docs/OWNER-ACTIONS.md
- [ ] 9. Builder check with a fresh subagent
- [ ] 10. Ask the builder check's questions, fix the docs, validate again
- [ ] 11. Hand off
```

### 1. Read what exists

Read `CLAUDE.md`, `docs/BRIEF.md`, `docs/REQUIREMENTS.md`, `docs/BACKLOG.md`, `docs/DECISIONS.md`,
`loop/backlog.json` and `DESIGN.md` if present. Skeleton files have comments that describe their
format; keep that format. Tell the owner in two lines what already exists.

### 2. Interview

Topics, in order: problem and audience → core journeys → scope edges (what it will not do) →
data and integrations → constraints (locale, accessibility, legal, budget) → accounts the owner
must create. Question bank with recommended defaults: [reference/interview.md](reference/interview.md).

Stop a topic when you could write its part of the brief without guessing. Do not ask about the
stack: the template's preset fixes it.

### 3. Play back

Summarise the whole picture on one screen: who, the three to five journeys, what is out, the
integrations, the constraints. Ask: "Is this the app?" Fix and repeat until yes.

### 4–6. Write the docs

Formats and examples for every file: [reference/doc-formats.md](reference/doc-formats.md).

- `docs/BRIEF.md`: plain language, one page.
- `docs/REQUIREMENTS.md`: epics `E<n>`, stories, ACs `AC-<epic>.<n>`, each AC defined once on its
  own list line.
- Milestones: each one ends in something the owner can try on the dev site. The first milestone is
  the thinnest end-to-end slice of the core journey.
- `loop/backlog.json`: one item is one PR a single session can finish (contract, code, tests,
  screenshots). Split anything larger. `ui: true` when the item changes what a user sees.
  `dependsOn` only for real build order.
- `docs/BACKLOG.md`: the milestones in prose: goal, what "done" looks like, the items in order.

### 7. Validate

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-backlog.mjs"
```

Fix every `PROBLEM` line (an unknown AC, a ref that does not resolve, a cycle, an empty
milestone) and run it again. Continue only at `OK`. The `note:` line lists ACs no item names
directly: each must be covered by an item that refs its section; otherwise add an item.

### 8. Decisions and owner actions

- `docs/DECISIONS.md`: one row per call made during shaping, including the defaults you chose
  under rule 4. Append after the last row and continue its ID sequence.
- `docs/OWNER-ACTIONS.md`: every account, DNS record, secret, payment or legal step only the owner
  can do, with when the loop needs it (milestone) and how to verify it.

### 9. Builder check

Dispatch a fresh subagent with the prompt in
[reference/builder-check.md](reference/builder-check.md). It reads only the repo, as a loop session
would, and lists every point it would have to guess. Do not give it the chat history or your
summary.

### 10. Close the guesses

Each guess becomes a question to the owner, one at a time, with your recommended answer. Write
each answer into the doc the builder check named (not into a backlog item's scope). Rerun step 7.
If more than five guesses came back, run the builder check once more after the fixes.

### 11. Hand off

Show a table of milestones with item counts and the first three items. Name the open owner
actions. Propose committing on a branch `docs/shape-project` and opening a PR into the base branch;
wait for a yes before `git push`. Recommend `/draft-design` next if any item has `ui: true` and
there is no `DESIGN.md`.
