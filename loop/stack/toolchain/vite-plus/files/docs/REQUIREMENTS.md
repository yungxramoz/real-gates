# Requirements

<!--
  Written by /shape-project. The source of truth for acceptance criteria: loop/backlog.json items
  point here instead of copying them.

  Format
  - Epics are numbered: `## E<n> — <name>`.
  - Stories under an epic: `### S<n>.<m> — <name>`, one sentence "who wants what, so that why".
  - Acceptance criteria: `AC-<epic>.<n>`, unique across the file, one testable sentence each,
    written so a test title can carry the ID.
  - Gate: an AC is built once a contract names it (docs/contracts/<item>.md, committed with the
    PR). scripts/ac-trace.mjs fails CI when a built AC is not named by a test that ran and passed
    (it reads the JUnit reports; skipped and todo tests do not count). ACs not built yet are
    listed as pending. `pnpm ac-trace --all` checks every AC, for a release.
  - Never renumber an AC. Retire one by striking it through and saying why.
-->

## E0 — Platform

### S0.1 — The project starts and answers

As the owner, I want what the project is made of to start and answer on a fresh clone, so that
every later change is built on something that runs.

<!-- stack:e0 -->

<!-- shape-project: E1, E2, … with their stories and ACs -->
