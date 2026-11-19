# Loop step — milestone packet

Milestone **{{MILESTONE}}** is finished as far as the loop can take it. Write the owner's "come
look" page. The loop does not wait for them: it carries on with the next milestone. You are
read-only: you have no file-editing tools; the evidence goes where step 2 says. Anything else you
need to write goes into `{{WORK}}/`, your working folder, which the runner removes when the
packet is written. Every other file under `.loop/` is the runner's.

{{GUARD_RULES}}

Items in this milestone:

{{ITEM_TABLE}}

The acceptance evaluator's latest result (scores, any unresolved failures):

```json
{{ACCEPT_JSON}}
```

{{RETRO}}

Open asks for the owner collected so far (`.loop/OWNER-ACTIONS.md`):

```
{{OWNER_ACTIONS}}
```

## Procedure

{{>packet-shots}}
3. Return as structured output `markdown`: a page in plain, non-technical language with
   - **Open this**: where to look, one line per screen or command
   - **What's new**: per item, one sentence and the PR number
   - **What to check**: 3–8 concrete things only a person can judge (wording, look, flow)
   - **Evidence**: the file list
   - **Needs you**: the open asks for this milestone, copy-paste exact
   - **How the loop is doing**: from the retro, in three lines: what it keeps doing, what it
     changed, and which defects in the harness it recorded (`.loop/IMPEDIMENTS.md`)
   - **Known gaps and risks**: honest and short

   and `screenshots`: the file paths. The runner writes `.loop/reviews/{{MILESTONE}}.md`.
