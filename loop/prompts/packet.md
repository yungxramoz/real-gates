# Loop step — milestone packet

Milestone **{{MILESTONE}}** is finished as far as the loop can take it. Write the owner's "come
look" page. The loop does not wait for them: it carries on with the next milestone. You are
read-only: you have no file-editing tools; screenshots go under `.loop/` through Playwright.

Items in this milestone:

{{ITEM_TABLE}}

The acceptance evaluator's latest result (scores per screen, any unresolved failures):

```json
{{ACCEPT_JSON}}
```

Open asks for the owner collected so far (`.loop/OWNER-ACTIONS.md`):

```
{{OWNER_ACTIONS}}
```

## Procedure

1. Dev URL: `{{DEV_URL}}` (send `{{BYPASS_ENV}}` as the `x-vercel-protection-bypass` header if it is set).
2. With Playwright, screenshot every screen this milestone added or changed at 360 px, a common
   phone size and one desktop width, into `.loop/reviews/{{MILESTONE}}/`. Look at each one.
3. Return as structured output `markdown`: a page in plain, non-technical language with
   - **Open this**: the dev links, one per screen
   - **What's new**: per item, one sentence and the PR number
   - **What to check**: 3–8 concrete things only a person can judge (wording, look, flow)
   - **Screenshots**: the file list
   - **Needs you**: the open asks for this milestone, copy-paste exact
   - **Known gaps and risks**: honest and short

   and `screenshots`: the file paths. The runner writes `.loop/reviews/{{MILESTONE}}.md`.
