# real-gates

**One agent. A script that decides when it's done. Gates that say no.**

real-gates is a GitHub template for building a whole web app with one coding agent, unattended.
The agent builds one backlog item at a time. A script, not the agent, checks the work and merges
it. Nobody reviews the PRs: every safety property comes from a gate the script enforces.

It is the loop from a real run on a tournament website: 49 backlog items in 59 hours, no failed
item, 60 times a gate said no. [WHY.md](WHY.md) tells the story behind each gate.

## The loop

```mermaid
flowchart TD
  pick["Pick the next item<br/>(dependencies done, held item first)"] --> build["Build session with /goal<br/>contract, code, tests, PR"]
  build --> gate{"Local gate and pre-merge checks<br/>run by the script"}
  gate -- "fail" --> fixgate["Fix session with the output"] --> gate
  gate -- "pass" --> ci{"CI green?"}
  gate -- "pass" --> review{"Independent review<br/>read-only, every score ≥ 7"}
  ci -- "red" --> fixci["One fix session<br/>failing log and findings"] --> gate
  ci -- "cancelled, no runner" --> rerun["Re-run, never 'fix'"] --> ci
  review -- "changes" --> fixci
  ci -- "green" --> both{"Green and approved<br/>on the same commit?"}
  review -- "approve" --> both
  both -- "yes" --> merge["Script merges<br/>squash, match head commit"]
  merge --> landed{"Landed check<br/>merge = reviewed diff?"}
  landed -- "no" --> hold[["HELD: run stops"]]
  landed -- "yes" --> baseci{"Base CI on the merge commit<br/>in the background when the tree is the one CI passed"}
  baseci -- "red" --> fixitem["FIX item, first in line"] --> pick
  baseci -- "no verdict twice" --> hold
  baseci -- "green" --> post{"Post-merge steps<br/>migrations applied and verified?"}
  post -- "no" --> hold
  post -- "yes" --> ms{"Milestone complete?"}
  ms -- "no" --> pick
  ms -- "yes" --> accept{"Acceptance on the deployed dev site"}
  accept -- "failures" --> acc["ACC fix items, first in line"] --> pick
  accept -- "pass, or 2 rounds done" --> packet["Milestone packet for the owner"] --> pick

  build -. "same guard block twice" .-> count[("Failure counter")]
  ci -. "same CI fix twice" .-> count
  review -. "same cause twice" .-> count
  accept -. "any failure" .-> count
  count -. "threshold" .-> learn["LEARN item, first in line<br/>lesson, test or stricter rule"] -.-> pick
```

Every box with a question mark is a gate. A gate either passes, sends the item back for a fix, or
holds the run. The LEARN edge is how the loop learns: a repeated failure becomes an item that
fixes its cause, and that item goes through the same gates.

## Quick start

| Step | You do                                                           | You get                                                                               |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1    | **Use this template** on GitHub, then clone your copy            | A repo with no history                                                                |
| 1b   | Not a web app? `node scripts/apply-preset.mjs` lists the stacks  | The project files of that stack ([presets/node-cli](presets/node-cli/README.md))      |
| 2    | `/setup-loop` in Claude Code                                     | `loop/loop.config.json`, guard settings, CI values, branches                          |
| 3    | `/shape-project`                                                 | `docs/BRIEF.md`, `docs/REQUIREMENTS.md`, `loop/backlog.json`, `docs/OWNER-ACTIONS.md` |
| 4    | `/draft-design`                                                  | `DESIGN.md` and `design/mocks/accepted/`                                              |
| 5    | `pnpm loop --dry-run`, then `pnpm loop --once`, then `pnpm loop` | The app, merged item by item, with a packet per milestone                             |

You need Node 22 or newer, pnpm, `gh` logged in, and Claude Code logged in. The preflight checks
the versions and tells you what is missing. Details: [loop/README.md](loop/README.md).

After the app is done, `/run-retro` carries what the run learned back into the template, and
`/sync-arc42` keeps `docs/architecture/` true once per milestone.

## Taking a later template version

A project is a copy, so a fix in the template reaches it only when you fetch it:

```sh
node scripts/sync-template.mjs --dry-run   # what would change
node scripts/sync-template.mjs             # do it, then review, commit on a branch, open a PR
```

It updates what is the template's (the loop, the skills, the shared scripts, the CI workflow of
your stack) and never touches what is yours (the config, the backlog, the rules the loop learned,
your docs, the app). Details: [loop/README.md](loop/README.md#taking-a-later-template-version).

## The four layers

Each layer only knows the one below it. Read from the top down. The core loop names no framework,
host or database: it reads a stack profile. Two ship with the template: a web app (Next.js,
Supabase, Vercel), which the repository is as it stands, and a Node.js command-line tool, which
`node scripts/apply-preset.mjs node-cli` turns it into. Another stack is another profile and
app skeleton; layer 1 stays as it is. The contract between them is in
[loop/profiles/README.md](loop/profiles/README.md).

```mermaid
flowchart TB
  L4["4 · Project — written by you and the skills<br/>BRIEF · REQUIREMENTS · DECISIONS · LESSONS · DESIGN.md · arc42 · backlog.json"]
  L3["3 · Skills — .claude/skills/<br/>/setup-loop · /shape-project · /draft-design · /run-retro · /sync-arc42"]
  L2a["2a · Stack profile — loop/profiles/&lt;name&gt;/<br/>check commands · gate files · ratchets · work types · guard packs · adapter choice · prompt fragments"]
  L2b["2b · App skeleton and CI — repo root, or presets/&lt;name&gt;/files/<br/>the app · its CI job · coverage · e2e · AC trace"]
  L1b["1b · Adapters and guard packs — loop/adapters/, loop/guard/packs/<br/>forge · deploy probe · post-merge · notify · tool rules"]
  L1["1 · Core loop — human-owned, never edited by the loop<br/>loop/run.mjs · engine · gates · guard core · prompts · state · budgets"]
  L4 --> L3 --> L2a --> L1b --> L1
  L3 --> L2b
  L2a --> L1
```

| Layer                | Where                                                                 | Changes                                                                 |
| -------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1 · Core loop        | `loop/`                                                               | Never by the loop. A change it wants ships as `loop/patches/<id>.patch` |
| 1b · Adapters, packs | `loop/adapters/`, `loop/guard/packs/`                                 | When a new forge, host or tool is supported                             |
| 2a · Stack profile   | `loop/profiles/<name>/`                                               | Per stack; a project names one in `loop/loop.config.json`               |
| 2b · App skeleton    | `src/`, `tests/`, `.github/`, `supabase/`; other stacks in `presets/` | Per stack                                                               |
| 3 · Skills           | `.claude/skills/`                                                     | Rarely. Hidden from the loop (`disable-model-invocation: true`)         |
| 4 · Project          | `docs/`, `DESIGN.md`, `CLAUDE.md`, `loop/backlog.json`                | Every project                                                           |

## Where to watch a run

| What                       | Where                                                |
| -------------------------- | ---------------------------------------------------- |
| Overview                   | `pnpm loop --status`                                 |
| Live                       | the console, or `.loop/status.json`                  |
| History                    | `.loop/PROGRESS.md`                                  |
| Every session in full      | `.loop/logs/NNN-<item>-<phase>.jsonl`                |
| Blocked actions            | `.loop/logs/guard.log`                               |
| **Things only you can do** | `.loop/OWNER-ACTIONS.md`                             |
| **Milestone "come look"**  | `.loop/reviews/<milestone>.md`                       |
| Final summary              | `.loop/REPORT.md`                                    |
| Stop cleanly               | create `.loop/STOP`                                  |
| Phone                      | set `notify.ntfyTopic` and subscribe in the ntfy app |

## What is in the box

| Path                                  | What                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `loop/`                               | Runner, guard, rule table, prompts, adapters, test suite. [loop/README.md](loop/README.md)                   |
| `.claude/skills/`                     | The five setup skills                                                                                        |
| `docs/`                               | Brief, requirements, backlog, decisions, lessons, owner actions, [architecture](docs/architecture/README.md) |
| `DESIGN.md`, `design/mocks/accepted/` | The design system and the mocks the reviewer scores against                                                  |
| `CLAUDE.md`                           | Project rules every session reads                                                                            |
| `examples/sample-backlog/`            | A tiny sample project to read before you shape your own                                                      |
| `scripts/sanitize-scan.mjs`           | Fails when a file carries emails, keys or names that do not belong in a public repo                          |

## The talk

This template comes from the talk **One Agent, Real Gates**: six agents with job titles failed,
one agent with hard gates built the app.
<!-- Link to the slides or recording goes here once it is published. -->

## Licence

MIT. See [LICENSE](LICENSE).
