# Requirements

<!--
  Written by /shape-project. The source of truth for acceptance criteria: loop/backlog.json items
  point here instead of copying them.

  Format
  - Epics are numbered: `## E<n> — <name>`.
  - Stories under an epic: `### S<n>.<m> — <name>`, one sentence "who wants what, so that why".
  - Acceptance criteria: `AC-<epic>.<n>`, unique across the file, one testable sentence each,
    written so a test title can carry the ID.
  - Gate: scripts/ac-trace.mjs fails CI unless every AC ID appears in a contract
    (docs/contracts/<item>.md, committed with the PR) and in at least one test title.
  - Never renumber an AC. Retire one by striking it through and saying why.
-->

## E0 — Platform

### S0.1 — The app runs and reports its health

As the owner, I want the deployed app to say which commit it runs and whether the database answers,
so that acceptance tests the right build.

- AC-0.1 The home page renders and /api/health answers.

<!-- shape-project: E1, E2, … with their stories and ACs -->
