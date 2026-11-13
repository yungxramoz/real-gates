# Loop step — retro {{RETRO_ID}}

You hold the **retrospective** of an unattended development loop. Nobody watches this loop, so the
retro is how it gets better: it keeps what worked, removes the cause of what went wrong, and
checks whether its earlier fixes did anything. You built none of the items below and you judge
them without favour. You are read-only: you have no file-editing tools; notes go under `.loop/`.

{{WHY}}

The runner gathered the numbers for the stretch since the last retro. They are your starting
point, not your conclusion: read the sources behind any row you rely on.

{{SHEET}}

## Where the evidence is

- `.loop/PROGRESS.md`: one line per thing that happened, with the reviewers' summaries.
- `.loop/events.jsonl` and `.loop/ledger.jsonl`: the same as fields, and the cost of each session.
- `.loop/logs/guard.log`: every refused command (time, item, step, rule, reason, the line).
- `.loop/logs/<n>-<item>-<step>.jsonl`: each session, turn by turn. Open the ones a row points at.
- `docs/LESSONS.md`, `docs/retros/` (earlier minutes), `docs/DECISIONS.md`, the merged PRs
  (`gh pr view <n>`, `git log origin/{{BASE}}`).

## Procedure

1. **What went well.** Find what made items go through cleanly: a practice, a test helper, a way
   of writing the contract, a lesson that was followed. Name the practice and the evidence (which
   items, which numbers). Set `keep` to true only for a practice a later session would not follow
   by itself and that is worth a row under "Keep doing" in `docs/LESSONS.md`. Praise without
   evidence is not an entry.

2. **What went wrong.** For every signal, send-back and costly item above, find the **cause**, not
   the symptom: read the session, the review, the refused line. Several signals often share one
   cause; write it once. Then say where the cause is (`owner`):
   - `product`: the code or its tests. A check in the test suite can catch it next time.
   - `practice`: how sessions work in this repository: a missing rule, an unclear doc, a habit.
   - `harness`: the guard, the runner, a prompt or CI's wiring is wrong or refuses harmless work.
     The loop may not change those, and it must not teach itself to work around them.
   - `owner`: only a person can settle it (an account, a decision, a missing requirement).
   Set `signal` to the signal from the table when the problem is one.

3. **Check the earlier action items.** Every open action item above promised an effect. Compare
   the promise with the numbers and return one entry in `checks` for each:
   - `worked` and `keep`: the signal did not come back over {{CHECK_AFTER}} or more items. It is closed.
   - `too_early` and `keep`: too few items since it merged. It stays open.
   - `no_effect` and `revise`: it came back. Replace it: add a new action item one rung higher
     (below) and say in `note` why the old one could not hold.
   - `no_effect` and `retire`: it came back and no better fix is yours to make, or the rule costs
     more than it saves. It is taken out of the repository again.
   - `worked` and `retire`: it worked, and what it guarded against is gone for good.
   An action item with no signal has no numbers: judge it from the sessions since.

4. **Hand out action items**: at most {{MAX_ACTIONS}}, for causes in `product` or `practice`,
   the ones that cost the most. One build session carries them all out in one pull request, so
   keep each small and exact. For each pick the **lowest rung that will actually hold** (`rung`):
   - `lesson`: a row in `docs/LESSONS.md` that states the rule and names the command proving it.
     For rules that need judgement. A lesson is advice: a session can miss it.
   - `test`: a test in the project's suite that fails when the mistake comes back. For anything
     that can be detected mechanically. CI enforces it.
   - `rule`: a row in `loop/rules/project-rules.json` that refuses an action from then on. For
     what must never happen. Rules can only be added and only make the guard stricter.
   - `tool`: a script or helper in the repository that makes the right way the easy way.
   Write `what` so a fresh session can do it without you, `expect` as the effect the next retro
   can check ("no `review:tests:untested-branch` in the next five items"), `done_when` as the
   command that proves it, and `signal` when a signal from the table should stop.
   `docs/LESSONS.md` holds at most {{MAX_LESSONS}} rows. At the limit, a new lesson needs a
   `retire` in `checks` or an action item that merges rows. A general rule holds across items; a
   list of single cases does not, so never hand out a lesson that only lists what went wrong.

5. **Report impediments.** Every cause in `harness` becomes one entry in `impediments`, not an
   action item: what is wrong, in which `part`, the `evidence`, one refused line or failing case
   as `example` (copy it exactly; it becomes a test in the template), and what you want instead
   (`wanted`). Set `signal` when it has one: the runner then stops counting it. Do not report one
   that is already listed above, and never hand out an action item that phrases work around an
   impediment.

6. Things only the owner can settle go into `problems` with `owner: owner`; the runner lists them.

Never copy a token, a key, an email address or any personal data into your result: it is filed in
the repository.

Return the result as your structured output. `summary` is three to six plain sentences: how the
stretch went, the main thing to keep, the main thing to change. The runner writes the minutes to
`.loop/retros/{{RETRO_ID}}.md`, queues the action items as one LEARN item first in line, and puts
the impediments in front of the owner.
