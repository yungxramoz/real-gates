# Stack profiles

The core loop (`loop/run.mjs`, `loop/lib/`, `loop/guard/core.mjs`, `loop/prompts/`) names no
framework, host or database. Everything it needs to know about what a project is built with is in
a profile: one folder here per stack. A project picks one by name, with `"profile"` in
`loop/loop.config.json`.

```
loop/profiles/
  next-supabase-vercel/   a web app: Next.js, Supabase, Vercel
  node-cli/               a command-line tool shipped as an npm package
    profile.json          which commands, files, work types, packs and adapters the stack uses
    prompts/*.md          the stack's own words for the steps a session takes
```

Every profile ships with the harness, whatever a project uses. That is why the runner's own suite
(`loop/test/`) can test each of them in any project.

Config is read in three layers, later ones win: the defaults in `loop/lib/config.mjs`, then the
profile's `profile.json`, then `loop/loop.config.json` (this project's own values: repo, branches,
URLs). Objects merge key by key; lists and single values replace; `null` removes a default.

## profile.json

| Key | What the core does with it |
| --- | --- |
| `localGate.commands` | Shell commands the runner runs on the pushed branch head before it waits for CI. A failure goes to a fix session |
| `gates.files` | Globs a PR may not change at all, because CI runs through them: test, lint and type configs, the repo's own scripts |
| `gates.frozenJsonKeys` | `[{ file, key }]`: one key of a JSON file that may not change (the commands CI runs), while the rest of the file may |
| `gates.ratchets` | Numbers in a config file that may only go up. See below |
| `workTypes` | What kinds of thing an item can deliver, and how each is reviewed and accepted. See below |
| `guard.packs` | Guard packs to switch on: the rules for one tool or service (`loop/guard/packs/`) |
| `forge.adapter` | Where pull requests, CI results and the merge live (`loop/adapters/forge-*.mjs`) |
| `deploy` | How the runner learns that the dev site serves the merged commit, or `"adapter": "none"` |
| `postMerge` | Steps the runner takes after a merge, each `{ adapter, … }` (`loop/adapters/postmerge-*.mjs`) |
| `notify.adapter` | How the owner is told (`loop/adapters/notify-*.mjs`) |

A project may override any of these in `loop/loop.config.json`.

### Work types

```json
"workTypes": {
  "ui": null,
  "command": { "rubric": ["help_and_errors", "ergonomics", "output", "robustness"], "accept": "local" },
  "default": { "rubric": [], "accept": "none" }
}
```

A backlog item names its type with `"type"`. The older `"ui": true` means the type `ui`; an item
with neither is `default`. For each type:

- `rubric`: the scores the reviewer must give, each from 1 to 10. A missing score, or one below
  `review.minDesignScore`, blocks the item. `[]` means no scores.
- `accept`: how a milestone that contains such an item is accepted.
  - `site`: on the deployed dev site, after the deploy adapter says it serves the merged commit.
  - `local`: on the merged base branch itself, with nothing deployed.
  - `none`: no acceptance step.

The defaults define `ui` (four design scores, `site`) and `default`. A profile adds its own types
and removes one it has no use for by setting it to `null`. The preflight refuses a backlog item
whose type the profile does not define. Items the loop creates take a type too: an acceptance fix
item gets the type its milestone is accepted by, a follow-up the type of the item that raised it.

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

The CLI profile keeps its floor in a JSON file of its own:

```json
{ "name": "coverage", "files": ["coverage.thresholds.json"], "comments": "none", "number": "\"(lines|branches|functions)\"\\s*:\\s*(\\d+(?:\\.\\d+)?)" }
```

### Deploy

```json
{ "adapter": "http-health", "health": "/api/health", "commitField": "commit", "expect": { "db": ["ok", "stub"] }, "bypassSecretEnv": "VERCEL_BYPASS", "bypassHeader": "x-vercel-protection-bypass" }
```

`http-health` polls `deploy.devUrl + health` until the JSON body's `commitField` starts with the
merged commit and every field in `expect` has one of its allowed values. Only then does milestone
acceptance start. `bypassHeader` and `bypassSecretEnv` are for a site behind preview protection.
`"adapter": "none"` means nothing is deployed; no work type may then use `"accept": "site"`.

## prompts/

A core prompt pulls in the stack's words with `{{>name}}`, which is replaced by
`prompts/<name>.md`. The fragment may use the same `{{VARIABLES}}` as the prompt around it. The
preflight refuses to start when a fragment is missing.

| Fragment | Used in | Says |
| --- | --- | --- |
| `build-proof` | build, step 6 | which commands must pass locally, what tests new work needs, how a change is proven |
| `build-gate-files` | build, step 8 | in words, the files `gates` protects |
| `review-drive` | review | how the reviewer starts the branch and uses it like a user |
| `review-rubric` | review | what each score of the rubric means and what it is calibrated against |
| `accept-drive` | acceptance, steps 2 and 3 | how the evaluator gets at the product (the deployed site, or an installed package) and walks every journey |
| `accept-score` | acceptance, step 4 | what is scored, and where the evidence goes |
| `packet-shots` | packet, steps 1 and 2 | how the evidence for the owner is taken |

A profile with several work types can word a step per type: `review-drive.<type>.md` and
`review-rubric.<type>.md` win over the plain file for an item of that type, and
`accept-drive.<site|local>.md`, `accept-score.<…>.md` and `packet-shots.<…>.md` for that way of
accepting.

## A new stack

1. **The profile**: a folder here with `profile.json` and the seven fragments.
   `loop/test/profiles.test.mjs` checks every profile against this contract.
2. **The project files**: a folder `presets/<name>/` with `preset.json` (what of the web preset to
   remove) and `files/` (the app skeleton, its CI workflow, `CLAUDE.md`, a `loop/loop.config.json`
   that names the profile). `node scripts/apply-preset.mjs <name>` turns a fresh copy of the
   template into that project; `scripts/apply-preset.test.mjs` applies each preset to a real copy
   and runs its gates.
3. **What the stack's CI must do**: report one check with the name in `ciCheck`, write JUnit
   reports for `scripts/ac-trace.mjs --results`, and run on pull requests to the base branch and
   on pushes to it. A health endpoint, when `deploy.adapter` is `http-health`.

## Adding a guard pack or an adapter

- **Guard pack**: a new file in `loop/guard/packs/` that exports `name` and any of `deny`, `mcp`,
  `shell`, `configProblems`; one line in `PACKS` (`loop/guard/packs/index.mjs`) and one in
  `GUARD_FILES` (`loop/lib/settings.mjs`). A pack can only block.
- **Adapter**: a new file in `loop/adapters/` with the interface its kind documents at the top of
  the existing file, and one line in the matching table in `loop/adapters/index.mjs`.

Both are part of the harness: a loop session cannot change them.
