# template-lessons.md

What carries over from one project to the template, and the format the template's maintainers can
act on.

## Contents

- Any project or this project
- Format
- Example entry
- Before you hand it over

## Any project or this project

| Goes to the template | Stays in the project |
|---|---|
| a gate that did not fire, or fired too late | a rule about this app's data model |
| an agent failure pattern (writes from a read-only step, skips a test, edits a frozen file) | a domain term or a copy rule |
| a GitHub, CI or host behaviour (a cancelled run with no runner, a stale branch) | a design token or component |
| a guard rule whose regex has nothing project-specific in it | a rule naming this project's paths, tables or services |
| a runner patch | an account or DNS step |
| a check or test that any project on the preset would want | a test of this app's journeys |

Test: would a project with a different domain on the same stack have hit it? Yes → template.

## Format

```markdown
# Lessons from a run

Run: <items> items, <hours> h, <failed> failed, first-pass review <n> %.

## <short title>

- **What happened**: the failure, in generic terms, and how often.
- **Cause**: why the existing gates did not stop it.
- **Fix in the project**: the lesson row, test, check, rule or patch the loop or the owner made,
  and the command that proves it.
- **Proposed for the template**: the file to change and the change (a diff, a rule with its allow
  and block examples, or a lesson row).
- **Rule check**: for a proposed rule, the `check-rules.mjs` output.
- **Evidence**: counts from the run (blocks, rounds, held items); no names, links or data.
```

Order entries by impact: the ones that cost the most time or nearly shipped a defect first.

## Example entry

```markdown
## Reviewers try to write files

- **What happened**: review sessions tried to edit files 9 times; each was blocked by the guard.
- **Cause**: the review prompt says "read-only", but the session still had write tools.
- **Fix in the project**: none needed; the guard held. Proving command: the guard log shows 9
  blocks for rule `readonly-write`.
- **Proposed for the template**: start read-only steps without write tools, so the guard is the
  backstop and not the main line.
- **Evidence**: 9 of 14 guard blocks came from review sessions.
```

## Before you hand it over

- No product name, person, email, URL, project ref, ticket ID or customer data.
- Every proposed rule has a reason, an allow example and a block example, and passed
  `check-rules.mjs`.
- Every entry names the command or test that proves the fix.
