# Lessons

Rules learned the hard way. They override habits and default skill behaviour.

Every rule here is **checkable**: it names the command or query that proves it was followed. A
lesson without one is a decision; put it in `docs/DECISIONS.md` instead.

Keep the list short. Merge or remove a rule that stops earning its place, and say why in the
commit. When a lesson can be enforced in code (a guard rule, a CI check, a test), do that too and
link it: code holds harder than prose.

How a row gets here:

- **During a run**, a `LEARN-n` item adds it when the same failure repeats (same review finding,
  same guard block, same kind of CI fix, any acceptance failure). It merges through the same gates.
- **After a run**, `/run-retro` moves lessons that apply to any project back into the template.

Format: `L-nn`, the rule in bold with its proving command, the date, why (the incident in one or
two sentences), and where it is enforced if it is.

| #    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Since    | Why                                                                                                                                          | Enforced by                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| L-01 | **Merge on the PR's own state at the moment of merging, and test what will actually land.** Read the state first: `gh pr view <n> --json mergeStateStatus,headRefOid,statusCheckRollup`. Refuse `DIRTY` (a conflicted PR gets no CI run, so a green badge is from an older base) and refuse a red or missing required check. The base must be an ancestor of the branch: `git merge-base --is-ancestor origin/<base> origin/<branch>`. If it is not, update the branch and let CI run again on the result. Merge with `--match-head-commit <sha>` so a push after review cannot slip in. | template | Two PRs were green on their own and merged cleanly as text. Together the typecheck was red: one renamed a function the other still called.   | `loop/lib/github.mjs` pre-merge checks |
| L-02 | **A `cancelled` CI job with no runner never ran. It is not a test failure.** Read the jobs before diagnosing: `gh api repos/<owner>/<repo>/actions/runs/<id>/jobs --jq '.jobs[] \| "\(.name): \(.conclusion) runner=\(.runner_name)"'`. `cancelled` with an empty `runner_name` means runner starvation, or a newer push cancelling the run. Re-run it (`gh run rerun <id>`). Never "fix" code for it, and never merge on the assumption that it would have passed.                                                                                                                      | template | Seven of eight open PRs and the base branch showed red CI. Every failing job was `cancelled` with no runner. After a re-run, all were green. | `loop/lib/github.mjs` CI wait          |
