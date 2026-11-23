# Stack blocks

The core loop (`loop/run.mjs`, `loop/lib/`, `loop/guard/core.mjs`, `loop/prompts/`) names no
framework, host or database. Everything it needs to know about what a project is built with comes
from **stack blocks**: one block per choice, one folder here per block. A project lists the blocks
it is built with, and the loop puts them together.

```
loop/stack/
  forge/github/             where pull requests, CI results and the merge live
  toolchain/pnpm-vitest/    how the code is checked, tested and kept from getting worse
  toolchain/npm-node-test/
  framework/next/           what the code is written with
  product/web-ui/           what a user touches: how an item is reviewed, a milestone accepted
  product/cli-command/
  database/supabase/        where the data lives, and what happens to it after a merge
  hosting/vercel/           where the merged base runs
  hosting/none/
    block.json              what the block is, when to choose it, what it adds to the config
    prompts/*.md            its words for the steps a session takes
```

Every block ships with the harness, whatever a project uses. That is why the runner's own suite
(`loop/test/stack.test.mjs`) can test each of them in any project.

`node loop/scripts/stack.mjs` prints the stack of this project and what it adds up to: the work
types, the local gate, the guard packs, the post-merge steps. `--list` prints every block there is.

## Naming the stack

A project names its blocks in `loop/loop.config.json`, in one of two ways:

```json
{ "profile": "next-supabase-vercel" }
```

```json
{ "stack": ["forge/github", "toolchain/pnpm-vitest", "product/web-ui", "hosting/none"] }
```

A **profile** (`loop/profiles/<name>/profile.json`) is a stack that was proven as a whole: a named
list of blocks that a real project was built with. Two ship: `next-supabase-vercel` and
`node-cli`. A project's own `stack` replaces the profile's list.

Config is read in four layers, later ones win: the defaults in `loop/lib/config.mjs`, then the
blocks of the stack put together, then the profile's other keys, then `loop/loop.config.json` (this
project's own values: repo, branches, URLs). Between these layers objects merge key by key, lists
and single values replace, and `null` removes a value.

## Categories

| Category | A stack has | A block of it says |
| --- | --- | --- |
| `forge` | exactly one | where pull requests, CI results and the merge live |
| `toolchain` | exactly one | which commands prove a change, which files CI runs through, which numbers may only go up |
| `framework` | any number | how the source is laid out, and so what a building block of the code is |
| `product` | any number | what kinds of thing an item can deliver, and how each is driven, scored and accepted |
| `database` | any number | the steps after a merge, and what a session may do to the data |
| `hosting` | one or none | how the runner learns that the merged base is running |

Blocks are put together in this order, and within a category in the order the project lists them.
That is the order of the guard packs, of the local gate's commands and of the words in a prompt.

## block.json

```json
{
  "title": "CLI command",
  "description": "Commands a person or a script runs in a terminal, shipped as an npm package. …",
  "choose": "The product has commands people run in a terminal.",
  "config": {
    "workTypes": { "command": { "rubric": ["help_and_errors", "ergonomics", "output", "robustness"], "accept": "local" } },
    "guard": { "packs": ["npm"] }
  }
}
```

| Key | What it is |
| --- | --- |
| `title` | The block's name for a person |
| `description` | What the block does to the loop: what is checked, what is refused, how its items are judged |
| `choose` | When a project takes it, as one sentence that is true or false for a project |
| `config` | What it adds to the loop config. Any key of `DEFAULTS` in `loop/lib/config.mjs` except a project's own values (repo, branches, git author) |

### How the config of several blocks becomes one

- **Objects** merge key by key.
- **Lists** are joined: `guard.packs` of the forge block, then of the product block, then of the
  database block. A value two blocks name is kept once.
- **A single value two blocks set differently is a conflict**, and the loop refuses to start:
  neither block can be right about the other's choice. Two blocks that set the same value agree.

So a block states only what is its own. The database block adds its post-merge step and its guard
pack; it does not repeat the forge's pack.

### What a block may put in `config`

| Key | What the core does with it |
| --- | --- |
| `localGate.commands` | Shell commands the runner runs on the pushed branch head before it waits for CI. A failure goes to a fix session |
| `architecture.blocks` | Path patterns that say what a building block of the code is (`src/lib/*`: every file and folder there; a slash at the end: folders only). `scripts/arch-check.mjs` fails a PR when one is not named on the building-blocks page of `docs/architecture/` |
| `gates.files` | Globs a PR may not change at all, because CI runs through them: test, lint and type configs, the repo's own scripts |
| `gates.frozenJsonKeys` | `[{ file, key }]`: one key of a JSON file that may not change (the commands CI runs), while the rest of the file may |
| `gates.ratchets` | Numbers in a config file that may only go up. See below |
| `workTypes` | What kinds of thing an item can deliver, and how each is reviewed and accepted. See below. Only a product block defines one |
| `guard.packs` | Guard packs to switch on: the rules for one tool or service (`loop/guard/packs/`) |
| `forge.adapter` | Where pull requests, CI results and the merge live (`loop/adapters/forge-*.mjs`) |
| `deploy` | How the runner learns that the dev site serves the merged commit, or `"adapter": "none"` |
| `postMerge` | Steps the runner takes after a merge, each `{ adapter, … }` (`loop/adapters/postmerge-*.mjs`) |
| `notify.adapter` | How the owner is told (`loop/adapters/notify-*.mjs`) |

A project may override any of these in `loop/loop.config.json`.

### Work types

```json
"workTypes": {
  "command": { "rubric": ["help_and_errors", "ergonomics", "output", "robustness"], "accept": "local" }
}
```

A backlog item names its type with `"type"`. The older `"ui": true` means the type `ui`; an item
with neither is `default`. The core knows only `default` (no scores, no acceptance): every other
type comes with the product block that says how its items are driven and scored. For each type:

- `rubric`: the scores the reviewer must give, each from 1 to 10. A missing score, or one below
  `review.minDesignScore`, blocks the item. `[]` means no scores.
- `accept`: how a milestone that contains such an item is accepted.
  - `site`: on the deployed dev site, after the deploy adapter says it serves the merged commit.
    A stack that deploys nothing cannot have such a type.
  - `local`: on the merged base branch itself, on the machine the loop runs on, whatever is
    deployed. A package is judged installed, not hosted.
  - `site-or-local`: where the product runs. On the deployed dev site when the stack deploys
    one, otherwise on the merged base itself. A web UI and an HTTP API are accepted this way, so
    the same block serves a hosted project and one that only runs locally.
  - `none`: no acceptance step.

A milestone is accepted once, in one session, and that session covers every kind of product the
milestone delivers, each where it runs: screens on the deployed site and a command from the
installed package, when it has both. The session gets the words of each product block in turn,
under a line that names the kind.

The preflight refuses a backlog item whose type no block of the stack defines, and a type that is
accepted at a place its product block has no words for. Items the loop creates take a type too: an
acceptance fix item gets the type of the item its failure is about (otherwise the first accepted
type of the milestone), a follow-up the type of the item that raised it.

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

The `npm-node-test` toolchain keeps its floor in a JSON file of its own:

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
`"adapter": "none"` means nothing is deployed; no work type may then use `"accept": "site"`, and
a type with `"site-or-local"` is accepted on the merged base.

The hosting block names the adapter and the health path. What the health body must say about a
service comes from that service's block: the Supabase block adds `expect.db`.

## prompts/

A core prompt pulls in the stack's words with `{{>name}}`. Every block may have words for it, in
`prompts/<name>.md`; they are put one after the other, in stack order. The words may use the same
`{{VARIABLES}}` as the prompt around them. The preflight refuses to start when no block of the
stack has words for an include.

| Fragment | Used in | Says | Whose it is |
| --- | --- | --- | --- |
| `build-proof` | build, step 6 | which commands must pass locally, what tests new work needs, how a change is proven | the toolchain, then every product block for its own items |
| `build-gate-files` | build, step 8 | in words, the files `gates` protects | the toolchain |
| `review-drive` | review | how the reviewer starts the branch and uses it like a user | the product block |
| `review-rubric` | review | what each score of the rubric means and what it is calibrated against | the product block |
| `accept-drive` | acceptance, steps 2 and 3 | how the evaluator gets at the product (the deployed site, a build started locally, an installed package) and walks every journey | the product block |
| `accept-score` | acceptance, step 4 | what is scored, and where the evidence goes | the product block |
| `packet-shots` | packet, steps 1 and 2 | how the evidence for the owner is taken | the product block |

**Who speaks.** A block that defines no work type always speaks. A product block speaks when the
step is about one of its work types: the build and the review of an item of that type, the
acceptance of a milestone with such items. When the step is about a type no block defines (an
item of the type `default`), every product block speaks and says for which items its words hold.

**Variants.** `<name>.<variant>.md` wins over `<name>.md`. The review picks the variant by the
item's work type (`review-drive.command.md`); acceptance and the packet by the place the work
type is accepted at (`accept-drive.site.md`, `accept-drive.local.md`). A block whose product is
accepted in one way only needs no variant (`accept-drive.md`); one whose product runs deployed
or locally has both.

**Several kinds in one step.** Acceptance and the packet are about a whole milestone. When it
delivers more than one work type, each include gives the words for every type in turn, each under
a line that names the type and its place, and the session does the step once per type.

**Write them flush left.** The words stand in a list of the prompt; the loop gives every line
after the first the indentation of the line the include stands on. A list item starts with `- `
or its number at the left edge, and its own continuation lines are indented under it as usual.

**Where a fragment puts files.** What a session writes for itself (a temporary worktree, an
installed package, scratch folders) goes into `{{WORK}}/`, the session's working folder: the
runner creates it, empties it where a step starts over and removes it when the item or the
milestone is finished ([Working folders](../README.md#working-folders)). The packet's fragment
also has `{{ACCEPT_WORK}}`, the folder the acceptance step of the same milestone used. Evidence
that has to outlast the session goes where it always went: `.loop/shots/{{ITEM_ID}}/` and
`.loop/reviews/{{MILESTONE}}/`. A fragment that names its own folder under `.loop/` still works,
but nothing removes that folder.

## A new block

1. **The folder**: `loop/stack/<category>/<name>/` with `block.json` and, where the block has
   something to say in a step, `prompts/`. `loop/test/stack.test.mjs` holds every block to this
   contract: it says what it is and when to choose it, adds only keys the config knows, has only
   texts a core prompt includes, and has the texts its category needs (a toolchain the proof and
   the gate files, a product block the review and the acceptance of its items).
2. **Only what is its own.** A block does not repeat another block's settings. If it needs a rule
   for a tool, that is a guard pack; if it needs the runner to do something, that is an adapter.
3. **Proven by a project.** A block ships once a real project was built with it. Until then it is
   a draft, whatever its tests say.

## A new profile

A profile is the name for a list of blocks that was proven as a whole.

1. **The profile**: `loop/profiles/<name>/profile.json` with `"stack"`.
   `loop/test/profiles.test.mjs` checks that its blocks give a complete config and words for
   every step.
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
