# The stack profile

The core loop (`loop/run.mjs`, `loop/lib/`, `loop/guard/core.mjs`, `loop/prompts/`) names no
framework, host or database. Everything it needs to know about what a project is built with is in
this folder. To run the loop on another stack, replace this folder and the app skeleton; the core
stays as it is.

```
loop/profile/
  profile.json     which commands, files, packs and adapters the stack uses
  prompts/*.md     the stack's own words for the steps a session takes
```

Config is read in three layers, later ones win: the defaults in `loop/lib/config.mjs`, then
`profile.json`, then `loop/loop.config.json` (this project's own values: repo, branches, URLs).
Objects merge key by key; lists and single values replace.

## profile.json

| Key | What the core does with it |
| --- | --- |
| `profile` | The profile's name, for the log |
| `localGate.commands` | Shell commands the runner runs on the pushed branch head before it waits for CI. A failure goes to a fix session |
| `gates.files` | Globs a PR may not change at all, because CI runs through them: test, lint and type configs, the repo's own scripts |
| `gates.frozenJsonKeys` | `[{ file, key }]`: one key of a JSON file that may not change (the commands CI runs), while the rest of the file may |
| `gates.ratchets` | Numbers in a config file that may only go up. See below |
| `guard.packs` | Guard packs to switch on: the rules for one tool or service (`loop/guard/packs/`) |
| `forge.adapter` | Where pull requests, CI results and the merge live (`loop/adapters/forge-*.mjs`) |
| `deploy` | How the runner learns that the dev site serves the merged commit. See below |
| `postMerge` | Steps the runner takes after a merge, each `{ adapter, … }` (`loop/adapters/postmerge-*.mjs`) |
| `notify.adapter` | How the owner is told (`loop/adapters/notify-*.mjs`) |

A project may override any of these in `loop/loop.config.json`.

### Ratchets

```json
{
  "name": "coverage",
  "files": ["vitest.config.mts"],
  "comments": "js",
  "within": "thresholds\\s*:\\s*\\{([\\s\\S]*?)\\}",
  "number": "\\b(lines|functions|branches|statements)\\s*:\\s*(\\d+(?:\\.\\d+)?)",
  "hint": "Add tests instead."
}
```

- `files`: a PR may change these only by raising the numbers. It may not add, remove or rename them.
- `number`: a regex. Group 1 is the key, group 2 the number.
- `within`: optional regex. Group 1 is the block the numbers live in. With several blocks, the
  lowest value per key counts.
- `comments`: `js` (`//` and `/* */`), `hash` (`#`) or `none`. Comments are removed first, so a
  commented-out higher number cannot hide a lowered one.

The same shape covers other tools, for example a Python coverage floor:

```json
{ "name": "coverage", "files": ["pyproject.toml"], "comments": "hash", "number": "\\b(fail_under)\\s*=\\s*(\\d+(?:\\.\\d+)?)" }
```

### Deploy

```json
{ "adapter": "http-health", "health": "/api/health", "commitField": "commit", "expect": { "db": ["ok", "stub"] }, "bypassSecretEnv": "VERCEL_BYPASS", "bypassHeader": "x-vercel-protection-bypass" }
```

`http-health` polls `deploy.devUrl + health` until the JSON body's `commitField` starts with the
merged commit and every field in `expect` has one of its allowed values. Only then does milestone
acceptance start. `bypassHeader` and `bypassSecretEnv` are for a site behind preview protection.
`"adapter": "none"` means nothing is deployed: there is no acceptance on a site.

## prompts/

A core prompt pulls in the stack's words with `{{>name}}`, which is replaced by
`prompts/<name>.md`. The fragment may use the same `{{VARIABLES}}` as the prompt around it. The
preflight refuses to start when a fragment is missing.

| Fragment | Used in | Says |
| --- | --- | --- |
| `build-proof` | build, step 6 | which commands must pass locally, what tests new work needs, how UI work is proven |
| `build-gate-files` | build, step 8 | in words, the files `gates` protects |
| `review-drive` | review | how the reviewer starts the branch and uses it like a user |
| `accept-drive` | acceptance, steps 2 and 3 | how the evaluator reaches the deployed site and walks the journeys |
| `packet-shots` | packet, steps 1 and 2 | how the screenshots for the owner are taken |

## What else a stack brings

Outside this folder, and not read by the core:

- the app skeleton and its tests;
- the CI workflow. It must report one check with the name in `ciCheck`, write JUnit reports for
  `scripts/ac-trace.mjs --results`, and run on pull requests to the base branch and on pushes to it;
- a health endpoint, when `deploy.adapter` is `http-health`.

## Adding a guard pack or an adapter

- **Guard pack**: a new file in `loop/guard/packs/` that exports `name` and any of `deny`, `mcp`,
  `shell`, `configProblems`; one line in `PACKS` (`loop/guard/packs/index.mjs`) and one in
  `GUARD_FILES` (`loop/lib/settings.mjs`). A pack can only block.
- **Adapter**: a new file in `loop/adapters/` with the interface its kind documents at the top of
  the existing file, and one line in the matching table in `loop/adapters/index.mjs`.

Both are part of the harness: a loop session cannot change them.
