# real-gates — template design

Status: approved by the owner on 2026-11-06 ("Yes on all", then "Okay then build it").
Source of the calls: the proposal page "One Agent, Real Gates — template" (v4) and the chat that
followed it. This document is what a builder plans from.

## Intent

The author ran a single-agent loop on their tournament website (the original project): 49 backlog items, 59 hours,
unattended, 0 failed items. People who saw the talk asked for it. They want to share the loop
**without sharing that repository**. `real-gates` is a public GitHub template that gives someone
else the same loop on a fresh project and works as well as it did there.

The goal of the loop is unchanged: **it builds a complete application and merges its own PRs.
Nobody reviews PRs.** Every safety property has to come from gates the script enforces, never from
a human reading a PR.

## Goals

1. A GitHub template repository (`Use this template`) named `real-gates`, MIT licence.
2. The original loop with every project-specific name lifted into `loop/loop.config.json`.
3. One stack preset: Next.js (App Router) + TypeScript + Supabase + Vercel + Vitest + Playwright.
4. Five interactive skills that take a person from an empty clone to a running loop:
   `/setup-loop`, `/shape-project`, `/draft-design`, `/run-retro`, `/sync-arc42`.
5. Learning that happens inside the unattended run, through the same gates.
6. Proof: a runner test suite with a fake `claude` and a fake `gh`, gate drills, a dogfood run.

## Non-goals

- A Claude Code plugin (later, once two projects want updates from one source).
- Other stack presets (adapters leave the seams).
- Full twelve-section arc42; E2E code coverage merged with unit coverage; a fixed 80 % threshold.
- Loop know-how skills before a drill shows the loop failing without them.

## Anti-goals (a failure even if it technically works)

- Any data from the original project in the template: Supabase refs, emails, names, decisions, ticket IDs, history.
- A gate that silently stopped firing (a hook skipped by `--bare`, a timeout treated as a pass).
- The loop loosening its own guard, gates or budgets, or editing its runner.
- A skill that asks questions running inside an unattended session.

## The calls (all YES unless marked)

### Repository
- New repo from extracted files, no fork, no history. Sanitizer scan before the first push.
- Skills in `.claude/skills/`, versioned with the repo.

### Core loop (layer 1, stack-agnostic, never edited by the loop)
- Fresh `claude -p` session per step; state in `.loop/state.json`; resume after crash; lock; STOP file.
- `/goal` finish line in every writing step; the script re-checks `result.json` and the PR itself.
- Contract first; independent reviewer; 4-score rubric (design quality, originality, craft,
  functionality); any score below `review.minDesignScore` (7) is blocking for UI items.
- Only the script merges: `--squash --match-head-commit`, base-ancestry check (L-01), "cancelled
  with no runner → re-run" (L-02).
- Budgets, circuit breaker, usage-limit sleep, ntfy notifications. original defaults kept.
- **Isolation**: every session runs with `--setting-sources project,local`, `--strict-mcp-config`
  plus `--mcp-config` from the repo's own `.mcp.json` when it exists. The preflight reads the
  session's `system/init` event and stops the run if it lists a non-builtin plugin, an MCP server
  not in the repo's config, a skill from `~/.claude/skills`, or an auto-memory path.
- `--permission-prompts none` on every session; `--permission-mode auto`. Bypass is unsupported.
- Read-only steps (review, accept, packet) start with
  `--disallowedTools Edit,Write,MultiEdit,NotebookEdit`; their verdict comes back through
  `--json-schema` as `structured_output` (verified on Claude Code 2.1.319). The guard stays as
  the backstop and still blocks git writes from those phases.
- `--max-budget-usd` per session (`budgets.maxUsdPerSession`).
- **NO `--bare`**: it skips hooks. Instead a permission smoke test is a must-pass at every run
  start: a session is told to run a planted forbidden command, and the run continues only if the
  guard log shows it blocked.
- Generated session settings set `autoMemoryEnabled: false`.
- Runner tested on Windows, macOS and Linux (CI OS matrix).

### Post-merge verification (from the 2026-11-06 chat)
1. **Landed check**: after the merge, the script fetches and confirms the merge commit is on
   `origin/<base>` and that `git patch-id --stable` of the merge commit equals the patch-id of the
   reviewed diff (`merge-base(base-before, reviewedSha)..reviewedSha`). Mismatch → item held.
2. **Base CI on the merge commit**: red → a `FIX-<sha>` item goes first in line. A **timeout is not
   a pass**: one re-run, then the item is held.
3. **Post-merge steps** (adapter list): the Supabase preset's `supabase-cli` adapter applies new
   migration files to the dev database with the Supabase CLI and the dev DB URL, from the script
   (no agent session), then verifies with the CLI's migration list that every local file is
   applied. Destructive SQL is never applied automatically. Unverified → item held, run stops.
4. **Milestone acceptance** on the deployed dev site; the agent first polls the health endpoint
   until `commit` equals the merged `origin/<base>` sha and `db` is `ok`. Failures → `ACC-*` fix
   items; max 2 rounds; then the packet. The loop does not pause at milestones.

### Guard
- Fail-closed PreToolUse hook (`onFailure: "block"`) on Bash, PowerShell, Edit, Write,
  MultiEdit, NotebookEdit, `mcp__.*`.
- **Locked core** (`loop/guard/core.mjs`, a protected path): no push to base or production, no
  force-push, no `gh pr merge`, no repo settings/secrets/branch protection, no `git add -A`,
  allowed DB project only and forbidden refs, no writes outside `.loop/` in read-only phases, no
  edits to protected paths (runner, guard, backlog), frozen applied migrations, no `.env` edits,
  no Supabase CLI push from an agent.
- **Project rules** (`loop/rules/project-rules.json`): a table the loop may only add to. Each rule
  has an id, a target (shell | path | sql), a regex, a reason, and one allow and one block example.
  CI runs `loop/scripts/check-rules.mjs`, which fails when a rule from the base branch is removed
  or changed, or when a rule's examples don't behave as declared.
- Every rule has an allow case and a block case in the unit suite.

### Learning (unattended)
- The script counts repeated failures per signature: the same review finding twice, the same guard
  block twice, the same kind of CI fix twice, and every acceptance failure. Each crossing queues a
  `LEARN-n` item first in line whose job is to fix the cause: a lesson row in `docs/LESSONS.md`
  that names the command proving it, a test or check, or a stricter project rule. It goes through
  the same CI and review gates and merges itself.
- A change the loop wants in the runner itself is written as `loop/patches/<id>.patch`; the run
  continues without it. `/run-retro` applies pending patches after the app is done.

### Stack preset (layer 2b)
- Next.js skeleton with `/api/health` returning `{ commit, db }`; stub mode for external services
  (`APP_ENV=preview` + stub base URLs) so e2e runs in CI against a local production build.
- CI (`ci` job): lint, typecheck, unit with Vitest v8 coverage and a ratchet
  (`thresholds.autoUpdate`), build, e2e with Playwright + axe against `next start`, AC-trace gate,
  rule-table check, skill frontmatter check, loop runner suite. Base CI also runs on push to base.
- AC-trace gate (`scripts/ac-trace.mjs`): every AC ID in `docs/REQUIREMENTS.md` appears in a
  contract and in at least one test title; prints ACs with no test.

### Skills (layer 3)
- Human skills: `disable-model-invocation: true`, checklist workflows, a validator script each
  (`check-config.mjs`, `check-backlog.mjs`, screenshot check, rule examples for retro).
- Names verb-object, lowercase, ≤ 64 chars; description third person, what + when, ≤ 1,024 chars,
  trigger words first; SKILL.md < 500 lines; references one level deep with a TOC over 100 lines;
  scripts via `${CLAUDE_SKILL_DIR}`, forward slashes; MCP tools by full name; no time-sensitive text.
- Evals first: each skill ships `evals/evals.json` with three scenarios and a no-skill baseline note.
- Step prompts live in `loop/prompts/*.md`, are not skills, and the writing ones start with `/goal`.

### Docs (layer 4 skeletons)
- `docs/BRIEF.md`, `REQUIREMENTS.md`, `BACKLOG.md`, `DECISIONS.md`, `LESSONS.md`,
  `OWNER-ACTIONS.md`, `docs/architecture/` (lean arc42: sections 1, 3, 4, 5, 8, 9, 11, Mermaid),
  `DESIGN.md`, `design/mocks/accepted/`, `CLAUDE.md`, `WHY.md` (each gate → the anonymized original
  incident that created it, plus the run's numbers), `README.md` with the loop diagram.
- `examples/sample-backlog/` with a small sanitized sample.

## Config shape (`loop/loop.config.json`)

```json
{
  "repo": "owner/name",
  "base": "develop",
  "production": "main",
  "ciCheck": "ci",
  "deploy": { "adapter": "vercel-preview", "devUrl": "", "health": "/api/health", "bypassSecretEnv": "VERCEL_BYPASS" },
  "postMerge": [{ "adapter": "supabase-cli", "dbUrlEnv": "DEV_DB_URL", "migrationsDir": "supabase/migrations", "holdOnUnverified": true }],
  "guard": { "allowedDbProject": "", "forbiddenRefs": [], "protectedPaths": [".env*", "loop/**"] },
  "review": { "minDesignScore": 7, "maxRounds": 2 },
  "budgets": { "maxSessions": 150, "maxHours": 120, "maxUsdPerSession": 25 },
  "notify": { "ntfyTopic": "" },
  "gitAuthor": { "name": "", "email": "" }
}
```

## Constraints

- The runner and guard use Node built-ins only (Node ≥ 22), so they run before `pnpm install`.
- Claude Code floor: 2.1.319 (checked by the preflight; not written in skill prose).
- Code, comments, docs and commits in English.
- No personal data anywhere; examples use `example.com`.

## Left to the builder

File layout inside `loop/lib/`, test helper design, exact regexes, wording of prompts and docs,
preset dependency versions (use the versions the original project ran green on), and the fake-gh state format.

## Proof bar before sharing (dogfood vs the original baseline)

| Metric | original | bar |
|---|---|---|
| Items failed | 0 of 49 | 0 |
| First-pass review | 69 % | ≥ 60 % |
| Time per item | 47 min | ≤ 60 min |
| PR → merge | 14 min | ≤ 20 min |
| Every gate fired at least once | yes | yes, drills included |
| Owner interventions | 2 stops | only OWNER-ACTIONS items |
