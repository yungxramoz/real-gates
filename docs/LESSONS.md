# Lessons

Rules learned the hard way. They override habits and default skill behaviour.

Every rule here is **checkable**: it names the command or query that proves it was followed. A
lesson without one is a decision; put it in `docs/DECISIONS.md` instead.

Keep the list short: at most 20 rows (`retro.maxLessons`). Every session reads the whole file, so
a row that stops earning its place costs each of them. State the general rule, not the list of
cases it came from: a rule holds across items, a list of single cases does not. When a lesson can
be enforced in code (a guard rule, a CI check, a test), do that too and link it: code holds harder
than prose.

How a row gets here and how it leaves:

- **During a run**, a retro hands out action items and one `LEARN-n` item carries them out
  ([how the loop learns](../loop/README.md#how-the-loop-learns-the-retro)). It merges through the
  same gates.
- **The next retro checks it.** The runner counts whether the failure came back after the row
  merged. A row that did not help is revised or removed, and the minutes in `docs/retros/` say why.
- **Never a workaround for the harness.** When the guard refuses harmless work or the runner is
  wrong, the retro reports an impediment to the owner. No row here teaches how to phrase around it.
- **After a run**, `/run-retro` moves lessons that apply to any project back into the template.

Format: `L-nn`, the rule in bold with its proving command, the date, why (the incident in one or
two sentences), and where it is enforced if it is.

| #    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Since    | Why                                                                                                                                          | Enforced by                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| L-01 | **Merge on the PR's own state at the moment of merging, and test what will actually land.** Read the state first: `gh pr view <n> --json mergeStateStatus,headRefOid,statusCheckRollup`. Refuse `DIRTY` (a conflicted PR gets no CI run, so a green badge is from an older base) and refuse a red or missing required check. The base must be an ancestor of the branch: `git merge-base --is-ancestor origin/<base> origin/<branch>`. If it is not, update the branch and let CI run again on the result. Merge with `--match-head-commit <sha>` so a push after review cannot slip in.          | template | Two PRs were green on their own and merged cleanly as text. Together the typecheck was red: one renamed a function the other still called.   | `loop/lib/gates.mjs` pre-merge checks, `loop/adapters/forge-github.mjs` merge |
| L-02 | **A `cancelled` CI job with no runner never ran. It is not a test failure.** Read the jobs before diagnosing: `gh api repos/<owner>/<repo>/actions/runs/<id>/jobs --jq '.jobs[] \| "\(.name): \(.conclusion) runner=\(.runner_name)"'`. `cancelled` with an empty `runner_name` means runner starvation; `cancelled` with a runner and no failed job means something stopped the run (a newer push in the same concurrency group, a person). Either way it has no verdict. Re-run it (`gh run rerun <id>`). Never "fix" code for it, and never merge on the assumption that it would have passed. | template | Seven of eight open PRs and the base branch showed red CI. Every failing job was `cancelled` with no runner. After a re-run, all were green. | `loop/adapters/forge-github.mjs` CI wait                                      |

## Keep doing

Practices that worked, written down by a retro so later sessions keep them. Each names the
evidence: which items went through cleanly because of it.

Format: `K-nn`, the practice, the date, the evidence.

| #   | Practice | Since | Evidence |
| --- | -------- | ----- | -------- |
