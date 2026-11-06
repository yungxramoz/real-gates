# Builder check

A fresh subagent reads the repo the way an unattended loop session will: no chat history, no
summary from you, only the files. What it would have to guess is what the loop would guess.

## How to dispatch

Use the Agent tool with a general-purpose subagent and the prompt below, unchanged except for the
item list. Pick the items: the first three of the first milestone, the first item of every later
milestone, and every item with `ui: true` that has no mock yet.

## Prompt

```
You are a build session in an unattended loop. Nobody will answer questions. You build one backlog
item per session from the repository alone.

Read CLAUDE.md, docs/BRIEF.md, docs/REQUIREMENTS.md, docs/BACKLOG.md, docs/DECISIONS.md,
DESIGN.md (if present) and loop/backlog.json. For each item below, read its refs.

Items: <ids>

For each item, list every point where you would have to guess to build it and to prove each AC
with a test: a missing value, an undefined term, an unclear rule, two docs that disagree, an AC you
could not test, a screen with no defined content or states, a dependency that is not in the
backlog.

Do not write or change any file. Answer with one table and nothing else:

| Item | What I would guess | Why the docs do not answer it | Which doc should answer it |

If an item needs no guess, write one row with "none".
```

## Using the answer

- Drop rows that the template already decides (stack, CI, the loop's own process).
- Merge rows that are the same gap across items.
- Each remaining row becomes one question to the owner, with your recommended answer.
- Write the answer into the doc in the last column. Then rerun `check-backlog.mjs`.
