# Document formats

If a skeleton file already exists, its comments win over this page: keep its headings and format.
This page fills the gaps.

## Contents

- docs/BRIEF.md
- docs/REQUIREMENTS.md
- loop/backlog.json
- docs/BACKLOG.md
- docs/DECISIONS.md
- docs/OWNER-ACTIONS.md
- Sizing items

## docs/BRIEF.md

Plain language, one page, no jargon. A new contributor reads it first.

```markdown
# Brief

## What we build
Two or three sentences: the app, for whom, and the job it does.

## Who uses it
- **Visitors**: ...
- **Admin**: ...

## What success looks like
One observable result with a number, in the owner's words.

## Terms
- **<thing that is counted>**: what starts and ends it, what is included, exact or estimate.
- **<status or stage list>**: every value, and the source file it was taken from.

## Core journeys
1. A visitor ... and gets ...
2. ...

## Not in the first version
- ...

## Constraints
Locale, accessibility, legal, brand rules.
```

## docs/REQUIREMENTS.md

Epics `E<n>`, stories `S<n>.<m>`, acceptance criteria `AC-<epic>.<n>`. Each AC is defined exactly
once, at the start of its own list line, so the AC-trace gate and `check-backlog.mjs` find it.

```markdown
## E2 Registration

### S2.1 A visitor registers for an event
As a visitor I want to register with my name and email so that my spot is held.

- **AC-2.1** Given an event with free spots, when a visitor submits a valid name and email, then
  the page shows a confirmation and one confirmation email is sent.
- **AC-2.2** Given a full event, when a visitor submits the form, then they are put on the waiting
  list and the page says so.
- **AC-2.3** Given an invalid email, when the visitor submits, then the field shows an error and
  nothing is stored.
```

Rules for an AC:

- One behaviour, observable from outside (UI, HTTP response, email, database row).
- Given / when / then, or one sentence with an observable result.
- Numbers instead of adjectives: "under 2 s on the dev site", not "fast".
- AC numbers are never reused. A dropped AC is struck through and stays.

The loop's test titles carry AC IDs (`test('AC-2.2 full event puts the visitor on the waiting
list', ...)`), and CI fails when an AC has no test.

## loop/backlog.json

```json
{
  "milestones": ["M0", "M1", "M2"],
  "items": [
    {
      "id": "E2-1",
      "milestone": "M1",
      "title": "Registration form with confirmation",
      "refs": ["AC-2.1", "AC-2.3", "docs/REQUIREMENTS.md#e2-registration", "DESIGN.md"],
      "scope": "The public form and its server action. Waiting list is E2-2. No admin view.",
      "ui": true,
      "dependsOn": ["E1-1"]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | stable, unique; `<epic>-<n>` reads well; never renumber after the loop started |
| `milestone` | one of `milestones` |
| `title` | what a user would notice, in under ten words |
| `refs` | AC IDs and doc paths (with `#heading` anchors); a note may follow in parentheses |
| `scope` | one to three sentences: what is in, what is explicitly not; no copied ACs |
| `ui` | `true` when a user sees a change; the reviewer then scores the design. The web profile's way to name the work type |
| `type` | instead of `ui`, in a profile with its own work types (`loop/profiles/<name>/profile.json`, `workTypes`): for the CLI profile, `"command"` for anything a user types, `"default"` for the rest. The reviewer scores that type's rubric and the milestone is accepted the way the type says |
| `dependsOn` | only real build order; never an item in a later milestone |

`M0` holds `LOOP-0` and setup items (stubs, health route, auth skeleton).

## docs/BACKLOG.md

Prose for people, generated from the same plan:

```markdown
## M1 Registration works end to end
Goal: a visitor can register on the dev site and gets the email.
Done when: AC-2.1 to AC-2.3 pass on the dev site; the owner tried it on a phone.
Items: E1-1, E2-1, E2-2
```

## docs/DECISIONS.md

Append after the last row and continue its ID sequence. One row per call:

| Column | Content |
|---|---|
| ID | next free `D-<n>` |
| Decision | the call, in one sentence |
| Why | the reason or source, in one sentence |
| Revisit when | the condition that would change it, or "no" |

## docs/OWNER-ACTIONS.md

One row per thing only the owner can do:

| Column | Content |
|---|---|
| Action | what to do, concretely |
| Where | the service and the page in it |
| Needed by | the milestone that blocks without it |
| Verify | a command or observation that proves it is done |

## Sizing items

One item is one PR that a single session finishes: contract, code, tests, screenshots, PR. Rough
signs an item is too big:

- more than about five ACs
- both a new data model and a new screen
- the scope needs "and also"
- it touches more than one epic

Split by journey step or by layer (data first, then screen). The first milestone should have three
to eight items.
