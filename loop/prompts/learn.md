## This is a LEARN item: remove the cause, not the symptom

The run keeps hitting the same failure (the item's `scope` lists the cases). Nobody reviews this
loop's PRs, so the only way it gets better is by changing the repository. Pick the **lowest rung
that will actually hold**, and say in the PR why that rung:

1. **A lesson** in `docs/LESSONS.md`: one row that states the rule and **names the command that
   proves it** (a test, a script, a grep). Every later session reads this file. Use it when the
   rule needs judgement.
2. **A test or check** that fails when the mistake comes back: a unit test, a lint rule, a script
   CI runs. Use it when the mistake can be detected mechanically in the code.
3. **A stricter guard rule**: add a row to `loop/rules/project-rules.json` with an `id` (`P-<n>`),
   `target` (shell, path, sql or mcp), `pattern`, `reason` (what the agent should do instead) and
   `examples.block` / `examples.allow`. Run `node loop/scripts/check-rules.mjs`. Use it when an
   action must never happen, whatever the session thinks. You may only **add** rows; CI fails a PR
   that removes or changes one.

If the fix needs a change to the runner itself (`loop/run.mjs`, `loop/lib/`, the prompts), you
cannot make it: write it as `loop/patches/{{ITEM_ID}}.patch` (a `git diff` the owner can apply with
`git apply`) with a short description at the top, and also take the best rung above that you can.

If the cases turn out to have different causes, fix the one that recurs and say so.
