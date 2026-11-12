# <!-- setup-loop: project name --> — project rules

You are working on **<!-- setup-loop: project name -->**: <!-- shape-project: one sentence on what it is and for whom -->.
The owner is the person who runs this repo and makes the product and release calls.

## Read first

1. `docs/BRIEF.md` — what we build and why, in plain language
2. `docs/REQUIREMENTS.md` — epics, stories, testable acceptance criteria (`AC-<epic>.<n>`)
3. `docs/BACKLOG.md` — where the build stands
4. `docs/DECISIONS.md` — decisions already made; don't silently re-decide them
5. `docs/CLI-CONVENTIONS.md` — how every command behaves: streams, exit codes, help, output
6. `docs/LESSONS.md` — rules learned the hard way, each with the command that proves it
7. `docs/architecture/README.md` — the lean arc42 docs; update the section a change touches in the same PR

## Stack

- **Node.js command-line tool**, plain ESM (`.mjs`), no build step, shipped as an npm package
- Node built-ins first. A runtime dependency is a decision: record it in `docs/DECISIONS.md`
- Tests with `node:test`: unit tests call `main()` in-process, end-to-end tests start the real
  binary and install the packed package. npm is the package manager
- `npm run check` (syntax, unit tests, coverage thresholds) and `npm run test:e2e` are the gates
- A change to the stack is a decision: record it in `docs/DECISIONS.md` first

## Environments

|                                               | Value                           |
| --------------------------------------------- | ------------------------------- |
| GitHub repo                                   | <!-- setup-loop: repo -->       |
| Base branch (the loop merges here)            | <!-- setup-loop: base -->       |
| Production branch (never touched by the loop) | <!-- setup-loop: production --> |
| Required CI check                             | <!-- setup-loop: ciCheck -->    |
| Commit author                                 | <!-- setup-loop: gitAuthor -->  |

Nothing is deployed. A milestone is accepted on the package itself: packed from the base branch,
installed into an empty folder, and used from there.

## HARD RULES — Package and releases

1. **Never publish.** No `npm publish`, no version bump, no tag, no registry login. A release is
   the owner's: it goes to `.loop/OWNER-ACTIONS.md` with the exact commands.
2. **Never change the machine.** No global installs, no `npm link`. To try the installed package,
   install the packed tarball into a folder under `.loop/`.
3. **What ships is what `files` in `package.json` lists.** A new source folder is added there in
   the same PR, and the pack test proves it.
4. **The command line is an interface.** Command names, flags, exit codes and any output a script
   could read are not changed without a decision in `docs/DECISIONS.md`.

## HARD RULES — Secrets and data

- Never edit `.env*` files. New variables go into `.env.example` with an empty value.
- No tokens or keys in code, logs, test fixtures or commits.
- No personal data (names, emails) in logs, errors, test fixtures or docs. Use `example.com`.
- The tool reads and writes only the paths its user names, plus documented config locations.

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

## How the autonomous loop works

The backlog is built by a sequential loop (`npm run loop`): one item per fresh headless session.

1. A **build** session writes a contract (every AC and its proof), then code, tests and a PR to the
   base branch, and ends with `.loop/result.json`.
2. The **script** runs the local gate and the pre-merge checks, then waits for CI while an
   independent, **read-only review** session runs.
3. Only then does the **script merge** (squash, `--match-head-commit`). The agent never merges.
4. The script checks the merge landed, checks base CI, and accepts each milestone on the installed
   package.

If you are inside a loop session, the step prompt from the script (`loop/prompts/`) adds the rules
for working unattended. Nobody can answer a question during a run: make small, reversible calls yourself and record them
in `docs/DECISIONS.md`; write anything that needs the owner to `.loop/OWNER-ACTIONS.md`.
How to run, watch and stop it: `loop/README.md`.

## Working with the owner

The owner makes the product and release calls.

- Ask only what is genuinely theirs to decide, or what needs their accounts (the npm registry,
  branch protection, a release).
- Bundle questions and recommend one answer. Show a transcript rather than describe behaviour.
- Small, reversible choices: decide yourself and record them in `docs/DECISIONS.md` (append at the
  bottom; the next free ID is in the last log bullet).
- At the end of a milestone, show the result: the commands to try, their transcripts, what to check.
