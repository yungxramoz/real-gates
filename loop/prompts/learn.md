## This is a LEARN item: carry out a retro's action items

A retro looked back over the run and decided what changes. Its minutes are your brief: read
`.loop/retros/{{RETRO_ID}}.md` in full before anything else. Nobody reviews this loop's pull
requests, so the only way it gets better is by changing the repository, and the next retro checks
by the numbers whether your change did what it promised.

Do exactly what the minutes say, in one pull request:

1. **File the minutes.** Copy every `.loop/retros/R-<number>.md` (`R-01.md`, `R-02.md`) that
   is not in `docs/retros/` yet to `docs/retros/`. They are the record of what was decided and
   why: change no word in them. If the project formats Markdown (a format check in CI), run its
   formatter over them; that is the only change allowed. Never file anything from
   `.loop/retros/data/`: those are the raw numbers, with refused commands as they were logged.

2. **Carry out each action item** at the rung the retro chose:
   - `lesson`: one row in the rules table of `docs/LESSONS.md`: the rule in bold with **the
     command that proves it**, the date, why (the incident in one or two sentences), where it is
     enforced. State the general rule, not the list of cases. Keep the row short: every session
     reads the whole file.
   - `test`: a test in the existing suites, so CI runs it without any config change. It must fail
     when the mistake comes back: show that it does.
   - `rule`: a row in `loop/rules/project-rules.json` with an `id` (`P-<n>`), `target` (shell,
     path, sql or mcp), `pattern`, `reason` (what to do instead) and `examples.block` /
     `examples.allow`. Run `node loop/scripts/check-rules.mjs`. You may only **add** rows; CI fails
     a pull request that removes or changes one.
   - `tool`: the script or helper the action item describes, with a test, and one line in the
     doc a session reads so it is found.
   Put the action item's id (`A-<n>`) in the row, test title or commit that carries it out.

3. **Take back what a check retired**, and replace what it revised: remove the row, test or
   helper the minutes name, and say why in the commit. A lesson that did not hold is removed, not
   left to rot.

4. **Write down the practices to keep**, each as one row under "Keep doing" in
   `docs/LESSONS.md` (`K-<n>`, the practice, since when, the evidence). Add the section if the
   file has none.

5. **Keep `docs/LESSONS.md` within {{MAX_LESSONS}} rows.** At the limit, merge two rows that
   say the same or remove the one the minutes retire before you add one.

**Impediments are not yours.** The minutes list causes in the harness (the guard, the runner, the
prompts, CI's wiring) for the owner. Do not fix them, do not write a patch for the guard, and do
not add a lesson that only teaches how to phrase work around one: the template gets fixed
instead.

Your contract (procedure step 3) lists each action item with its proof in place of acceptance
criteria. In the pull request, give one line per action item: what you did and the command that
shows it. If an action item turns out to be wrong or impossible, do the others, say so plainly in
`summary`, and do not invent a substitute.
