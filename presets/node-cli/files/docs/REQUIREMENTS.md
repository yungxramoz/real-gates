# Requirements

<!--
  Written by /shape-project. The source of truth for acceptance criteria: loop/backlog.json items
  point here instead of copying them.

  Format
  - Epics are numbered: `## E<n> — <name>`.
  - Stories under an epic: `### S<n>.<m> — <name>`, one sentence "who wants what, so that why".
  - Acceptance criteria: `AC-<epic>.<n>`, unique across the file, one testable sentence each,
    written so a test title can carry the ID. For a command: the command line, then what appears
    on stdout, on stderr, and the exit code.
  - Gate: an AC is built once a contract names it (docs/contracts/<item>.md, committed with the
    PR). scripts/ac-trace.mjs fails CI when a built AC is not named by a test that ran and passed
    (it reads the JUnit reports; skipped and todo tests do not count). ACs not built yet are
    listed as pending. `npm run ac-trace -- --all` checks every AC, for a release.
  - Never renumber an AC. Retire one by striking it through and saying why.
-->

## E0 — Platform

### S0.1 — The tool installs, starts and explains itself

As a user, I want the installed tool to tell me its version and what it can do, so that I know it
works before I rely on it.

- AC-0.1 `app --version` prints the version from package.json on stdout and exits 0.
- AC-0.2 `app --help`, and `app` with no arguments, print a usage text on stdout that lists every
  command with its summary, and exit 0.
- AC-0.3 `app <unknown>` prints one line on stderr that names the unknown command and points at
  `--help`, prints nothing on stdout, and exits 2.
- AC-0.4 The packed package, installed into an empty folder, runs: it ships every file the binary
  imports.

<!-- shape-project: E1, E2, … with their stories and ACs -->
