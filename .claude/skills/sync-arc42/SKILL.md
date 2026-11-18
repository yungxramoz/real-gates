---
name: sync-arc42
description: Syncs the lean arc42 architecture docs in docs/architecture/ with the code at the end of a milestone. Reads the diff since the last milestone, fixes drift in its seven pages (goals, context, strategy, building blocks, crosscutting concepts, decisions, risks), adds a missing Mermaid context or building-block diagram, links decisions in DECISIONS.md instead of copying them, and opens a docs pull request that goes through the normal gates and is never merged by this skill. Use after a milestone packet, when the owner says the architecture docs are stale, or asks for arc42, a context diagram, a building-block view or an architecture overview.
disable-model-invocation: true
argument-hint: "[milestone]"
allowed-tools: Bash(git log *) Bash(git diff *) Bash(git tag --list*) Bash(git ls-files*) Bash(git describe*)
---

# Sync arc42

Inside the loop, each PR that changes a building block, an integration or a crosscutting rule
updates its page in the same PR. `scripts/arch-check.mjs` fails the PR when a building block in
the code is not on the page or a path, decision ID or link leads nowhere, and the reviewer blocks
a page that says something untrue. This skill catches what neither sees: prose that drifted over
a milestone.

## Rules

1. **Lean.** Only the seven pages in `docs/architecture/`: goals, context, strategy, building
   blocks, crosscutting concepts, decisions, risks. No new pages; no regenerated prose where
   nothing changed.
2. **Link, never copy.** The goals page links `docs/BRIEF.md`; the decisions page links decision
   IDs in `docs/DECISIONS.md`. Copied text drifts.
3. **Code is the truth.** A doc that disagrees with the code is fixed to match the code. If the code
   looks wrong, list it on the risks page and tell the owner; do not change code here.
4. **Diagrams are Mermaid** (`flowchart`), so GitHub renders them. One context diagram on the
   context page, one building-block diagram on the building-blocks page.
5. **Through the gates.** Changes go on a branch and into a PR to the base branch. Ask before
   `git push` and `gh pr create`. Never merge: no `gh pr merge`, no push to the base branch.
6. Only `docs/architecture/` changes. One question at a time when something is unclear, with a
   recommended answer.

## Workflow

```
arc42 progress:
- [ ] 1. Find the range since the last milestone
- [ ] 2. Read what changed
- [ ] 3. Compare each page with the code; list the drift
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

Per page, what is its source of truth and what counts as drift:
[reference/sections.md](reference/sections.md). List the drift as a table before editing:

| Page | Drift | Evidence (file or commit) | Fix |
|---|---|---|---|

Nothing drifted → say so, change nothing, stop.

### 4. Fix

Edit only the pages with drift. Keep each file's name and headings. Use the diagram templates in
[reference/sections.md](reference/sections.md#diagrams) when a diagram is missing or a node or edge
changed.

### 5. Check

Run the check the loop runs:

```bash
node scripts/arch-check.mjs
```

It covers links, decision IDs, the paths the building-blocks page names, and that every building
block in the code is on that page. A project made from a template version without the script:
check those four by hand. Then, by hand in any case:

- The decisions page contains no copied decision text.
- Every Mermaid block starts with `flowchart`, node IDs are unique, and each node of the
  building-block diagram matches a real folder (`git ls-files <folder>` is not empty).

Fix and recheck until the script passes and both hold.

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
