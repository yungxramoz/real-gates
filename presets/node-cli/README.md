# Preset: node-cli

A command-line tool in plain Node.js, shipped as an npm package. No deployed site, no database.

Apply it to a fresh copy of the template, before `/setup-loop`:

```sh
node scripts/apply-preset.mjs node-cli --dry-run   # shows what it removes and writes
node scripts/apply-preset.mjs node-cli
```

It removes the web preset's files (listed in `preset.json`), copies `files/` over the repository
root, and deletes the `presets/` folder. The loop (`loop/`), the skills and the docs skeletons
stay. It refuses to run on a working tree with uncommitted changes, so `git checkout .` and
`git clean` bring everything back.

## What you get

| | |
| --- | --- |
| Skeleton | `bin/cli.mjs`, `src/cli.mjs` with `--help`, `--version` and command dispatch; unit and end-to-end tests for AC-0.1 to AC-0.4 |
| Gates | `npm run check` (syntax, unit tests, coverage thresholds), `npm run test:e2e` (the binary, and the packed package installed into an empty folder) |
| Ratchet | `coverage.thresholds.json`: a PR may only raise the numbers |
| Work types | `command` for anything a user types: reviewed on a CLI rubric, accepted on the installed package. `default` for the rest |
| Guard packs | `github`, `npm` (no publish, no version bump, no global install) |
| Conventions | `docs/CLI-CONVENTIONS.md`: streams, exit codes, help, output. The rubric scores against it |
| CI | One `ci` job that writes JUnit reports for the AC gate |

## What differs from the web preset

- `deploy.adapter` is `none` and there are no post-merge steps. Milestone acceptance runs on the
  merged base branch: the evaluator packs it, installs the tarball under `.loop/` and uses the
  binary from there.
- Backlog items use `"type": "command"` instead of `"ui": true`.
- There is no `DESIGN.md`; `docs/CLI-CONVENTIONS.md` takes that place. The `/draft-design` skill stays
  in the repository (the skill check expects all five) but has nothing to do here.
- npm instead of pnpm. No linter or formatter is set up: `npm run check` only checks that every
  file parses. Adding one is a normal backlog item (it changes gate files, so the owner applies it).
