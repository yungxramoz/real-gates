---
name: run-retro
description: Runs the retrospective after the loop has finished the app. Reads .loop/state.json, .loop/PROGRESS.md, the guard log, docs/LESSONS.md, loop/rules/project-rules.json, git history and pending runner patches in loop/patches/, shows what went wrong and what the loop learned, applies runner patches after a dry check and the owner's yes, validates rule changes with check-rules, and writes template-lessons.md with the lessons that apply to any project so the template improves. Use when the backlog is done, when the owner asks for a retro, post-mortem, lessons learned or what the loop learned, or when loop/patches/ holds patches waiting to be applied.
disable-model-invocation: true
allowed-tools: Bash(node loop/run.mjs --status*) Bash(git log *) Bash(git diff *) Bash(git apply --check *) Bash(node loop/scripts/check-rules.mjs*) Bash(node --test loop/test/*)
---

# Run the retro

The loop learns during the run on its own (LEARN items, lessons, stricter rules). This skill does
the two things the loop may not do: change its own runner, and carry lessons into the next
project.

## Rules

1. **Only after the run.** If `node loop/run.mjs --status` shows an item in progress or the lock is
   held, stop: patching the runner under a running loop corrupts its state. Ask the owner to stop
   it (create `.loop/STOP`) and come back.
2. **Never loosen a gate.** A patch or rule that removes, weakens or bypasses a guard rule, a CI
   check, a budget or a review threshold is reported, not applied. Project rules may only be added
   to; `check-rules.mjs` enforces it.
3. **Ask before every patch, push, PR, issue and deletion.** Show the exact command; wait for a yes.
4. **No project data leaves the project.** `template-lessons.md` names no product, person, email,
   URL, project ref or customer data. Describe the failure in generic terms.
5. One question at a time, with a recommended answer.

## Workflow

```
Retro progress:
- [ ] 1. Confirm the run is over
- [ ] 2. Collect the facts
- [ ] 3. Show the run in one table
- [ ] 4. Pending runner patches: check, ask, apply, test
- [ ] 5. Classify every lesson, rule and check: any project or this project
- [ ] 6. Validate rules with check-rules
- [ ] 7. Write template-lessons.md
- [ ] 8. Hand off
```

### 1. Confirm the run is over

```bash
node loop/run.mjs --status
```

Every item is done, skipped or needs a human, and nothing is running. Otherwise see rule 1.

### 2. Collect the facts

Read, in this order. Where to find each number: [reference/run-facts.md](reference/run-facts.md).

- `.loop/state.json`: items by status, rounds, CI fixes, review rounds, held items, LEARN and fix
  items, the failure counts per signature
- `.loop/PROGRESS.md` and `.loop/REPORT.md` (if present)
- `.loop/logs/guard.log`: blocks per rule
- `docs/LESSONS.md` and `docs/DECISIONS.md`: rows added during the run
  (`git log --reverse -p -- docs/LESSONS.md`)
- `loop/rules/project-rules.json`: rules added during the run
  (`git log -p -- loop/rules/project-rules.json`)
- `git log --oneline origin/<base>` for merges, `loop/patches/*.patch` for pending patches

### 3. Show the run

One table, then the three biggest time sinks in one line each:

| Metric | Value |
|---|---|
| Items done / needs human / skipped | |
| First-pass review (approved in round 1) | |
| CI fix rounds, review rounds | |
| Held items and why | |
| LEARN items and what each fixed | |
| Guard blocks by rule | |
| Pending runner patches | |

### 4. Pending runner patches

For each `loop/patches/<id>.patch`, oldest first:

1. Read it and the LEARN or fix item that wrote it. Explain in two lines what it changes and why.
2. Check rule 2. A loosening patch is reported and skipped.
3. Dry check:

   ```bash
   git apply --check loop/patches/<id>.patch
   ```

   If it fails, quote the error, say which file moved, and skip it. Do not use `--3way`, `--reject`
   or hand edits without a separate yes.
4. Ask: "Apply <id>?" Recommend yes when it passes the check and fixes a real failure from step 3.
5. On a branch `chore/retro-patches`: `git apply loop/patches/<id>.patch`, then run the runner
   suite:

   ```bash
   node --test loop/test/
   ```

   Red → undo with `git apply -R loop/patches/<id>.patch`, report, and move to the next patch.
   Green → ask whether to delete the patch file in the same commit (recommend yes: the change is in
   the runner now and in git history).

### 5. Classify

Every lesson row, rule, check and patch from the run goes into one of two buckets. Criteria and
examples: [reference/template-lessons.md](reference/template-lessons.md#any-project-or-this-project).

- **Any project**: about the loop, GitHub, CI, the guard, the preset stack or how agents fail.
  These go into `template-lessons.md`.
- **This project**: about this app's domain, data, design or accounts. They stay where they are.

Show the classification as one table and ask once: "Is this split right?" Also flag every row in
`docs/LESSONS.md` that does not name the command or test that proves it, and propose that command.

### 6. Validate rules

If step 4 or 5 added or changed a project rule, or a template lesson proposes one:

```bash
node loop/scripts/check-rules.mjs --base origin/<base>
```

`--base` also fails on a rule from the base branch that was removed or changed. Each rule needs a reason, one allow example and one block example that behave as declared. Fix and
rerun until it passes. A rule proposed for the template goes into `template-lessons.md` with its
examples, and is checked the same way: if it fits this project too, add it here for good; if not,
copy `loop/rules/project-rules.json` aside, add the rule, run the check, then restore the file from
the copy (never with `git checkout`, which would also drop other uncommitted work).

### 7. Write template-lessons.md

Write `.loop/retro/template-lessons.md` in the format in
[reference/template-lessons.md](reference/template-lessons.md). Then re-read it against rule 4 and
remove anything that identifies the project. If the repo has `scripts/sanitize-scan.mjs`, run it on
the file and fix every finding.

### 8. Hand off

- Applied patches: propose `git push` of `chore/retro-patches` and a PR into the base branch; wait
  for a yes. The owner merges it after `ci` passes.
- Template lessons: find the template repo with
  `gh repo view --json templateRepository -q .templateRepository.nameWithOwner` and offer to open
  one issue there with the file as its body
  (`gh issue create --repo <template> --title "Lessons from a run" --body-file .loop/retro/template-lessons.md`);
  wait for a yes.
- Summary: three lines on what went well, what the loop fixed by itself, and what the next project
  starts with.
