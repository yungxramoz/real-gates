# <!-- setup-loop: project name --> — project rules

<!--
  This file is a template. /setup-loop fills every `setup-loop:` placeholder from
  loop/loop.config.json, and /shape-project fills the `shape-project:` ones. Every loop session
  reads this file first.
-->

You are working on **<!-- setup-loop: project name -->**: <!-- shape-project: one sentence on what it is and for whom -->.
The owner is the person who runs this repo and makes the product, design and release calls.

## Read first

- `docs/BRIEF.md` — what we build and why, in plain language
- `docs/REQUIREMENTS.md` — epics, stories, testable acceptance criteria (`AC-<epic>.<n>`)
- `docs/BACKLOG.md` — where the build stands
- `docs/DECISIONS.md` — decisions already made; don't silently re-decide them
- `docs/LESSONS.md` — rules learned the hard way, each with the command that proves it
- `docs/architecture/README.md` — the lean arc42 docs; update the section a change touches in the same PR
<!-- stack:read-first -->

## Stack

- **TypeScript** (`strict`) on **Vite+**: one toolchain for the build, the formatter (Oxfmt), the
  linter and type check (Oxlint) and the unit tests (Vitest). pnpm is the package manager
- `pnpm check` (the gate wiring check, format, lint, types, unit tests with coverage), `pnpm build`
  and `pnpm test:e2e` (Playwright against `pnpm start`) are the gates
- Source in `src/`, one folder per part; a unit test sits beside the file it tests
  (`*.test.ts`), end-to-end tests are in `tests/e2e/`
<!-- stack:stack -->
- A change to the stack is a decision: record it in `docs/DECISIONS.md` first

## Environments

|                                               | Value                           |
| --------------------------------------------- | ------------------------------- |
| GitHub repo                                   | <!-- setup-loop: repo -->       |
| Base branch (the loop merges here)            | <!-- setup-loop: base -->       |
| Production branch (never touched by the loop) | <!-- setup-loop: production --> |
| Required CI check                             | <!-- setup-loop: ciCheck -->    |
| Commit author                                 | <!-- setup-loop: gitAuthor -->  |

<!-- stack:environments -->

## HARD RULES — Gates

1. **The rules are not yours to change.** `gates/lint.ts`, `gates/fmt.ts` and `gates/test.ts`
   hold the lint, format and test settings. The first two are frozen; in the third only the
   coverage thresholds may change, upwards. A change you need goes to `.loop/OWNER-ACTIONS.md`.
2. **`vite.config.ts` passes them on as they are.** Add build settings there freely; never leave
   out, spread, override or change `lint`, `fmt` or `test`. `scripts/check-gates.mjs` fails when
   one is not what its gate file exports.
3. **No second config.** Never add `.oxlintrc*`, `.oxfmtrc*`, `vitest.config.*` or another file a
   tool would read instead, and never hide a tracked file from the tools with an ignore file.
4. **The script names are fixed.** `check`, `build`, `start` and `test:e2e` in `package.json` are
   what the loop and CI call. A new script is the owner's to add.

<!-- stack:rules -->

## HARD RULES — Secrets and data

- Never edit `.env*` files. New variables go into `.env.example` with an empty value.
- No tokens or keys in code, logs, test fixtures or commits.
- No personal data (names, emails) in logs, errors, test fixtures or docs. Use `example.com`.

## HARD RULES — Git

- **Never push to the base or the production branch.** Never force-push. Never `git add -A`.
- Every change: feature branch → PR to **the base branch**. If a tool defaults to the production
  branch as base, use the base branch instead.
- Never run `gh pr merge`. **Only the loop script merges**, after its gates pass.
- The production branch is updated only from the base branch, after the owner approved the release
  in writing.
- Never edit `loop/**`, `.github/**`, `.claude/**` or `loop/backlog.json`. A change you want in the
  runner goes into `loop/patches/<id>.patch`.
- End a session with nothing uncommitted.

## Product rules

<!-- shape-project: the few product rules that are easy to miss, one bullet each. -->

## How the autonomous loop works

The backlog is built by a sequential loop (`pnpm loop`): one item per fresh headless session.

1. A **build** session writes a contract (every AC and its proof), then code, tests and a PR to the
   base branch, and ends with `.loop/result.json`.
2. The **script** runs the local gate and the pre-merge checks, then waits for CI while an
   independent, **read-only review** session runs.
3. Only then does the **script merge** (squash, `--match-head-commit`). The agent never merges.
4. The script checks the merge landed, checks base CI, and accepts each milestone where the
   product runs.
5. At the end of every milestone, and early when the same failure shows up in several items, the
   script holds a **retro**: what went well, what went wrong and why. Its action items become one
   `LEARN` item; the minutes are in `docs/retros/`. The harness is not yours: a refusal is the
   guard working, so go another way; never fix the guard or the runner, and never write a lesson
   that works around them.

If you are inside a loop session, the step prompt from the script (`loop/prompts/`) adds the rules
for working unattended. Nobody can answer a question during a run: make small, reversible calls
yourself and record them in `docs/DECISIONS.md`; write anything that needs the owner to
`.loop/OWNER-ACTIONS.md`. How to run, watch and stop it: `loop/README.md`.

## Working with the owner

The owner makes the product, design and release calls.

- Ask only what is genuinely theirs to decide, or what needs their accounts (branch protection, a
  release, a service's dashboard).
- Bundle questions and recommend one answer. Show rather than describe when options differ
  visually.
- Small, reversible choices: decide yourself and record them in `docs/DECISIONS.md` (append at the
  bottom; the next free ID is in the last log bullet).
- At the end of a milestone, show the result: how to start it, what to open, what to check.
