---
name: sync-arc42
description: Syncs the lean arc42 architecture docs in docs/architecture/ with the code at the end of a milestone. Reads the diff since the last milestone, fixes drift in sections 1, 3, 4, 5, 8, 9 and 11, adds a missing Mermaid context or building-block diagram, links decisions in DECISIONS.md instead of copying them, and opens a docs pull request that goes through the normal gates and is never merged by this skill. Use after a milestone packet, when the owner says the architecture docs are stale, or asks for arc42, a context diagram, a building-block view or an architecture overview.
disable-model-invocation: true
argument-hint: "[milestone]"
allowed-tools: Bash(git log *) Bash(git diff *) Bash(git tag --list*) Bash(git ls-files*) Bash(git describe*)
---

# Sync arc42

Inside the loop, each PR that changes a building block, an integration or a crosscutting rule
updates its section in the same PR, and the reviewer blocks it otherwise. This skill catches what
slipped through, once per milestone.

## Rules

1. **Lean.** Only sections 1, 3, 4, 5, 8, 9 and 11, one file each in `docs/architecture/`. No new
   sections; no regenerated prose where nothing changed.
2. **Link, never copy.** Section 1 links `docs/BRIEF.md`; section 9 links decision IDs in
   `docs/DECISIONS.md`. Copied text drifts.
3. **Code is the truth.** A doc that disagrees with the code is fixed to match the code. If the code
   looks wrong, list it under section 11 and tell the owner; do not change code here.
4. **Diagrams are Mermaid** (`flowchart`), so GitHub renders them. One context diagram in section 3,
   one building-block diagram in section 5.
5. **Through the gates.** Changes go on a branch and into a PR to the base branch. Ask before
   `git push` and `gh pr create`. Never merge: no `gh pr merge`, no push to the base branch.
6. Only `docs/architecture/` changes. One question at a time when something is unclear, with a
   recommended answer.

## Workflow

```
arc42 progress:
- [ ] 1. Find the range since the last milestone
- [ ] 2. Read what changed
- [ ] 3. Compare each section with the code; list the drift
- [ ] 4. Fix the drift; add missing diagrams
- [ ] 5. Check links, diagrams and the no-copy rule
- [ ] 6. Branch, commit, PR (after a yes)
```

### 1. Find the range

The start is the first of these that exists:

1. the last milestone tag: `git tag --list --sort=-creatordate` (names chosen by the owner, often
   `m<n>` or `milestone-*`)
2. the merge commit of the last item of the previous milestone, from `.loop/PROGRESS.md` or
   `.loop/reviews/<milestone>.md`
3. the last commit that touched the docs: `git log -1 --format=%H -- docs/architecture/`

The end is `origin/<base>` (from `loop/loop.config.json`). Say the range in one line and confirm it
with the owner. With an argument (`/sync-arc42 M3`), use that milestone's packet.

### 2. Read what changed

```bash
git log --oneline <from>..origin/<base>
git diff --stat <from>..origin/<base>
git diff <from>..origin/<base> -- docs/DECISIONS.md
```

Then read the changed modules, routes, migrations, external clients and config, the milestone
packet's follow-ups, and every current file in `docs/architecture/`.

### 3. Compare

Per section, what is its source of truth and what counts as drift:
[reference/sections.md](reference/sections.md). List the drift as a table before editing:

| Section | Drift | Evidence (file or commit) | Fix |
|---|---|---|---|

Nothing drifted → say so, change nothing, stop.

### 4. Fix

Edit only the sections with drift. Keep each file's headings. Use the diagram templates in
[reference/sections.md](reference/sections.md#diagrams) when a diagram is missing or a node or edge
changed.

### 5. Check

- Every relative link in `docs/architecture/` resolves (open each target).
- Every decision ID in section 9 exists in `docs/DECISIONS.md`, and section 9 contains no copied
  decision text.
- Every Mermaid block starts with `flowchart`, node IDs are unique, and each node in section 5
  matches a real folder (`git ls-files <folder>` is not empty).

Fix and recheck until all three hold.

### 6. Open the PR

Show `git diff --stat`. Propose:

```bash
git switch -c docs/arc42-<milestone>
git add docs/architecture/
git commit -m "docs(arc42): sync with <milestone>"
git push -u origin docs/arc42-<milestone>
gh pr create --base <base> --title "docs(arc42): sync with <milestone>" --body "<drift table>"
```

Run them only after a yes. The PR goes through `ci` like any other. Merging is the owner's step;
say so and give the PR link.
