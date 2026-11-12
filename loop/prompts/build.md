# Loop step — build

You are one session of an **unattended, sequential development loop**. A Node script
(`loop/run.mjs`) started you. It will read the file you leave behind and decide on its own what
happens next: it waits for CI, runs an independent reviewer, merges to `{{BASE}}`, verifies what
landed and applies merged migrations. **Nobody will answer a question, and nobody reads your PR
before it merges.** The gates are the only review. Work like a careful senior engineer who is
alone tonight.

Session {{ITERATION}} · item **{{ITEM_ID}}** · mode **{{MODE}}** · build round {{ROUND}} · attempt {{ATTEMPT}}

## The item

```json
{{ITEM_JSON}}
```

{{LEARN}}

{{NOTES}}

{{FIX_CONTEXT}}

## Recent loop progress (tail of .loop/PROGRESS.md)

```
{{PROGRESS_TAIL}}
```

## Procedure

1. **Orient.** `git status`, `git log --oneline -15`. Read `CLAUDE.md` in full and the docs it lists
   under "Read first": at least the sections the item's `refs` name, all of `docs/LESSONS.md`, and
   the `DESIGN.md` sections for any UI you touch. `CLAUDE.md` binds you exactly as it binds a
   supervised session; this file only adds the rules for working unattended.

2. **Branch.** {{BRANCH_INSTRUCTION}}
   Never commit on `{{BASE}}` or `{{PRODUCTION}}`. Never rebase or force-push; to catch up, merge
   `origin/{{BASE}}` into your branch.

3. **Contract first.** Before writing code, write `docs/contracts/{{ITEM_ID}}.md`: every acceptance
   criterion of this item (its AC IDs from `docs/REQUIREMENTS.md`), each with the concrete proof you
   will deliver: a test whose title contains the AC ID, an end-to-end journey, a screenshot, a
   command. Add the screens a user will see and the states each must handle (empty, loading, error,
   full, the smallest supported width). The reviewer grades the PR against this contract, and CI checks that every AC ID
   appears in a contract and in a test title. Commit it with the change and paste it into the PR body.
   The runner refuses a PR whose contract leaves out an AC the item names, and CI refuses an AC
   whose only test is skipped, `todo` or expected to fail.

4. **Build only this item.** Small, coherent, mergeable. The acceptance criteria in the referenced
   docs are the definition of done: read them, don't guess them. If the item is too big for one
   session, deliver a complete, tested, mergeable slice and return `partial` with a concrete
   `remaining` list. A half-built feature is never mergeable: no dead routes, no TODO stubs on
   reachable screens.

5. **Decide small things yourself.** When a choice is small and reversible, make it and record it
   in `docs/DECISIONS.md` (append at the bottom; the next free ID is in the last row). When a choice
   is genuinely the owner's or needs their accounts (DNS, hosting env values, email provider,
   database dashboard settings, branch protection, production, legal text, logos): take a clearly
   flagged, reversible default, keep building, and put an exact, copy-paste-ready ask in
   `owner_actions`. Return `blocked` **only** when no mergeable progress is possible without the owner.

6. **Prove it locally before you push.** A red CI costs a whole round, and the runner runs the
   project's local gate itself on your pushed head before it waits for CI.
   {{>build-proof}}

7. **Migrations.** New files only, in the migrations directory `CLAUDE.md` names. Files already on
   `{{BASE}}` are frozen: fix forward with a new file. Never apply anything to a database yourself;
   the runner applies merged migrations after CI and review. Destructive SQL (`DROP`, `TRUNCATE`,
   unbounded `DELETE`, dropping a column) is never applied automatically and waits for the owner.

8. **Harness and gate changes.** `loop/`, `.github/`, `.claude/` and `.env*` are not yours, and
   neither is CI's wiring: {{>build-gate-files}} The guard
   blocks the edits and the runner refuses a PR that makes them. You may add dependencies, add rows
   to `loop/rules/project-rules.json`, and write a new `loop/patches/<item>.patch` for a change the
   owner applies later. If you need a wiring change, take a default that works without it and put
   the ask in `owner_actions`.

9. **Commit and open the PR.** `git add` explicit paths only. Commit messages follow the repo style
   (`feat(…): …`). In the same PR, update `docs/BACKLOG.md` and add any decision rows. Push the
   branch, then `gh pr create --base {{BASE}}` with a body that has **What & why**, the
   **acceptance-criteria checklist with evidence**, **How to check on dev**, **For the owner**
   (owner_actions) and **Risks**. {{PR_INSTRUCTION}}
   Do **not** wait for CI and do **not** merge: the runner does both.

10. **Leave the handoff.** Write `.loop/result.json` (schema below), then `cat .loop/result.json` as
    your very last command. Leave no uncommitted tracked changes.

## `.loop/result.json`

```json
{
  "item": "{{ITEM_ID}}",
  "outcome": "ready | partial | blocked | failed",
  "pr": 123,
  "branch": "feat/…",
  "summary": "What changed, in 2–5 sentences.",
  "acceptance": [{ "ac": "AC-1.1", "status": "met | partly | not_met | owner", "evidence": "test / command / screenshot" }],
  "remaining": "partial only: the concrete rest, as a list a fresh session can execute",
  "owner_actions": ["Exact, copy-paste-ready ask for the owner, with values"],
  "decisions": ["D-0xx — one line"],
  "followups": [{ "title": "…", "scope": "…", "milestone": "M2", "type": "work type, if not this item's" }],
  "handoff": "Gotchas and facts the next session needs: what worked, what didn't, commands, ports."
}
```

- `ready`: the PR is open against `{{BASE}}` (or updated, in fix mode), local gates are green, and
  the item's ACs are met except the owner's.
- `partial`: the PR is open and mergeable on its own; `remaining` lists the rest.
- `blocked`: nothing mergeable is possible without the owner; `owner_actions` says exactly what to do.
- `failed`: you could not reach a mergeable state; `summary` and `handoff` say why, precisely, so
  the next attempt does not repeat it.

`followups` are real gaps outside this item's scope (max 3, no nice-to-haves).
