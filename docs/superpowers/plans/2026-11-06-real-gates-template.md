# real-gates template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public GitHub template repo that gives a fresh project the original project's unattended build-review-merge loop, with every gate intact and config-driven.

**Architecture:** Layer 1 is a zero-dependency Node runner (`loop/`) split into small modules under `loop/lib/`, a fail-closed guard hook with a locked core plus an add-only project rule table, and adapters for CI, post-merge and deploy. Layer 2b is a Next.js + Supabase + Vercel preset with CI gates. Layer 3 is five interactive skills. Layer 4 is doc skeletons.

**Tech Stack:** Node ≥ 22 built-ins (`node:test`), git, gh, Claude Code ≥ 2.1.319; preset: Next.js 16.3.8, React 19.3.0, TypeScript, Supabase (`@supabase/ssr` 0.12.7), Vitest + v8 coverage, Playwright 1.63.0 + `@axe-core/playwright` 4.13.0, pnpm 12.9.1.

**Spec:** `docs/superpowers/specs/2026-11-06-real-gates-template-design.md`

**Source to extract from (read-only, private):** the original project's `scripts/loop/` (runner, guard, SQL guard, migration gate, prompts), its loop unit tests and its CI workflow.

## Global Constraints

- Runner, guard and loop scripts: Node built-ins only, ESM `.mjs`, Node ≥ 22.
- No identifiers from the original project anywhere (its name, domain, people, database refs, ticket IDs, locale). `scripts/sanitize-scan.mjs` enforces this.
- Every loop session: `-p`, `--output-format stream-json --verbose`, `--settings .loop/claude-settings.json`, `--setting-sources project,local`, `--strict-mcp-config` (+ `--mcp-config .mcp.json` if present), `--permission-mode auto`, `--permission-prompts none`, `--max-budget-usd <budgets.maxUsdPerSession>`. Never `--bare`, never `bypassPermissions`.
- Read-only phases `review | accept | packet`: add `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` and `--json-schema <schema>`; read the verdict from the result event's `structured_output`.
- Generated settings: `autoMemoryEnabled: false`, guard hook `onFailure: "block"`.
- Claude Code version floor 2.1.319 lives only in `loop/lib/config.mjs` (`MIN_CLAUDE_VERSION`).
- A CI timeout is never a pass. An unverified post-merge step holds the item and stops the run.
- Commits: the owner's verified GitHub email; the runner takes its author from `gitAuthor` in config.

## Review Focus

- Windows paths: guard and runner receive `C:\…` paths and CRLF; path rules must normalise `\` to `/` (test in Task 3).
- A config with empty `allowedDbProject` / `devUrl` (fresh clone before `/setup-loop`): preflight must fail with a named message, not crash (Task 2).
- A merge commit whose patch differs from the reviewed diff because base moved between review and merge (Task 6 landed-check test).
- A session that never emits a `result` event (killed, crashed): runner must treat it as no result, not hang (Task 7 fake-claude `crash` mode).
- A project rule whose regex is invalid or whose block example doesn't block: `check-rules` must fail loudly (Task 4).

---

### Task 1: Repo scaffold and loop test harness

**Files:**
- Create: `LICENSE` (MIT, the owner as copyright holder), `.gitignore` (`/.loop/`, `node_modules/`, `.next/`, `coverage/`, `.env*` except `.env.example`, `playwright-report/`, `test-results/`), `.gitattributes` (`* text=auto eol=lf`), `loop/test/helpers/sandbox.mjs`, `loop/test/helpers/fake-claude.mjs`, `loop/test/helpers/fake-gh.mjs`, `loop/test/helpers.test.mjs`

**Interfaces:**
- Produces: `makeSandbox({ backlog, config }) -> { root, origin, env, ghState(), setGhState(fn), run(args) -> Promise<{code, stdout, stderr}>, cleanup() }` — a temp dir with a real git repo, a bare `origin`, `loop/` copied in, `LOOP_CLAUDE_BIN`/`LOOP_GH_BIN`/`LOOP_SUPABASE_BIN` pointing at fakes.
- Fake claude reads a script queue at `$LOOP_FAKE_DIR/claude-queue.json` (array of steps: `{ mode: 'ok'|'limit'|'crash'|'transient', writes: {path: content}, git: [[...args]], pr: {create: {...}}, structured: {...}, text, initExtra }`), emits a `system/init` event then a `result` event. Fake gh keeps PRs, check runs and merges in `$LOOP_FAKE_DIR/gh-state.json` and implements: `auth status`, `pr view --json`, `pr merge --squash --delete-branch --match-head-commit`, `pr review`, `api repos/:r/commits/:sha/check-runs`, `api repos/:r/actions/runs/:id/jobs`, `run view --log-failed`, `run rerun`. A merge squashes the PR branch onto origin/base in the bare repo with real git.

- [ ] Step 1: `helpers.test.mjs` — `sandbox creates origin with base branch`, `fake gh round-trips a PR`, `fake claude emits init then result`. Run `node --test loop/test/` → FAIL (missing helpers).
- [ ] Step 2: Implement the three helpers. Run → PASS.
- [ ] Step 3: Commit `chore: repo scaffold and loop test harness`.

### Task 2: Config

**Files:** Create `loop/lib/config.mjs`, `loop/loop.config.json` (spec shape, empty values), `loop/test/config.test.mjs`

**Interfaces:**
- Produces: `DEFAULTS` (the original run's values: maxAttemptsPerItem 3, maxRoundsPerItem 8, maxPartialsPerItem 4, maxCiFixes 3, maxAcceptRounds 2, maxNoProgress 3, maxFollowups 15, sessionTimeoutMin 150, reviewTimeoutMin 60, ciTimeoutMin 45, goalMaxTurns 120, usageLimitSleepMin 30, usageLimitMaxWaitHours 96, learnThreshold 2), `MIN_CLAUDE_VERSION = '2.1.319'`, `loadConfig(root) -> Config` (deep-merge onto DEFAULTS), `configProblems(cfg) -> string[]`.
- `configProblems` names each missing value: `repo`, `gitAuthor.email`, `deploy.devUrl` (when any backlog item has `ui`), `guard.allowedDbProject` (when `postMerge` has `supabase-cli`), and rejects `base === production`.

- [ ] Step 1: Tests `defaults fill missing keys`, `empty repo is a named problem`, `base equal to production is rejected`, `nested override keeps sibling defaults`. Run → FAIL.
- [ ] Step 2: Implement. Run → PASS. Commit `feat(loop): config with defaults and named problems`.

### Task 3: Guard — locked core, SQL guard, project rules

**Files:** Create `loop/guard.mjs` (hook entry), `loop/guard/core.mjs`, `loop/guard/sql.mjs` (port of the original `sql-guard.mjs` with schema list from config `guard.dbSchema`, default `app`), `loop/guard/rules.mjs`, `loop/rules/project-rules.json` (`{ "rules": [] }`), `loop/test/guard-core.test.mjs`, `loop/test/guard-sql.test.mjs` (port all cases of the original SQL guard tests), `loop/test/guard-rules.test.mjs`

**Interfaces:**
- Produces: `decide(event, ctx) -> { block: false } | { block: true, reason, rule }` in `core.mjs`, where `ctx = { phase, item, branch, cfg, isOnBase(relPath) -> bool, projectRules }`; `sqlBlockReason(query, phase, schema) -> string|null`; `compileRules(json) -> Rule[]`, `matchRules(rules, target, text) -> Rule|null`.
- `guard.mjs` reads stdin, builds ctx from env (`LOOP_PHASE`, `LOOP_ITEM`, `LOOP_ROOT`), config and git, calls `decide`, on block appends `ISO item reason` to `.loop/logs/guard.log` and exits 2. Malformed stdin → exit 2 (fail closed). Guard internal error → exit 2 (fail closed).
- Core rules = every original shell/file/MCP rule, generalised: base/production names from config; protected paths `loop/**` (except `loop/patches/<new>.patch`, `loop/rules/project-rules.json` add via edits checked by CI), `.env*`; frozen migrations via `isOnBase`; Supabase MCP `project_id` must equal `guard.allowedDbProject`; `supabase db push|reset` blocked for agents; read-only phases block git writes and file writes outside `.loop/`.

- [ ] Step 1: Port tests; add `windows backslash path to loop/run.mjs is blocked`, `push to configured base 'trunk' is blocked`, `project rule block example blocks, allow example passes`, `guard crash exits 2`. Run → FAIL.
- [ ] Step 2: Implement. Run → PASS. Commit `feat(loop): fail-closed guard with locked core and project rule table`.

### Task 4: Tighten-only rule check

**Files:** Create `loop/scripts/check-rules.mjs`, `loop/test/check-rules.test.mjs`

**Interfaces:** `checkRules(baseJson|null, headJson) -> string[]` problems; CLI `node loop/scripts/check-rules.mjs [--base <ref>]` reads `git show <ref>:loop/rules/project-rules.json`, exits 1 with each problem.
Problems: a base rule id missing in head; any field of a base rule changed; duplicate id; invalid regex; block example not matched; allow example matched; missing reason/examples.

- [ ] Step 1: Tests for each problem plus `adding a valid rule passes`. Run → FAIL. Step 2: implement → PASS. Commit `feat(loop): CI check that project rules only tighten`.

### Task 5: State, picker, hold gate, learning counter

**Files:** Create `loop/lib/state.mjs`, `loop/lib/hold.mjs` (port of `migration-gate.mjs` generalised: `HELD_PHASE='postmerge-hold'`, verdict objects from adapters), `loop/lib/learn.mjs`, tests `state.test.mjs`, `hold.test.mjs` (port the original migration-gate cases that still apply), `learn.test.mjs`

**Interfaces:**
- `createState(file, backlog) -> Store` with `st(id)`, `allItems()` (fix + learn items first, then per milestone: items, follow-ups), `pickNext({item, only}) -> Item | {none, waiting}`, `settled(item)`, `save()`, `TERMINAL`.
- `heldItem(items, st)`; `holdRecord(results)`.
- `recordFailure(S, signature, detail) -> null | LearnItem`: increments `S.learn.counts[signature]`; when it reaches `learnThreshold` (or immediately for `acc:*`), returns a `{ kind:'learn', id:'LEARN-n', title, scope, refs:['docs/LESSONS.md','loop/rules/project-rules.json'] }` once per signature. Signatures: `review:<normalised issue>`, `guard:<rule id>`, `ci:<job name>`.

- [ ] Step 1: Tests `fix and learn items come before milestone items`, `held item wins over --item`, `same review finding twice queues one LEARN`, `third repeat does not queue a second LEARN`. FAIL → implement → PASS. Commit `feat(loop): state, picker, hold gate, learn counter`.

### Task 6: GitHub and git gates

**Files:** Create `loop/lib/proc.mjs`, `loop/lib/github.mjs`, test `github.test.mjs` (sandbox + fake gh)

**Interfaces:**
- `proc.mjs`: `sh(cmd, args, opts)`, `git(...)`, `gitTry(...)`, `gh(...)`, `ghTry(...)`, `ghJson(...)`; binaries from `LOOP_GH_BIN` / `LOOP_SUPABASE_BIN` else PATH.
- `github.mjs`: `prView(cfg, pr)`, `waitForPrCi(cfg, pr, {stop})`, `waitForCommitCi(cfg, sha, {stop}) -> {ok:true} | {ok:false, kind:'red'|'timeout'|'stopped', ...}` (timeout → one rerun, then `{ok:false, kind:'timeout'}`), `diagnoseRun`, `preMergeChecks(cfg, s)`, `mergePr(cfg, s)`, `landedCheck(cfg, {baseBefore, reviewedSha, mergeSha}) -> {ok, why}` (merge sha reachable from `origin/<base>`; `git patch-id --stable` of `mergeSha^..mergeSha` equals that of `merge-base(baseBefore, reviewedSha)..reviewedSha`).
- Poll intervals come from `cfg.pollMs` (default 30000; tests set 10).

- [ ] Step 1: Tests `commit CI timeout is not ok`, `starved run is re-run (L-02)`, `branch behind base fails pre-merge (L-01)`, `merge refused when head moved`, `landed check passes for a normal squash`, `landed check fails when merge content differs`. FAIL → implement → PASS. Commit `feat(loop): CI, merge and landed-check gates`.

### Task 7: Claude sessions and isolation

**Files:** Create `loop/lib/claude.mjs`, `loop/lib/settings.mjs`, `loop/lib/schemas.mjs` (review / accept JSON schemas), test `claude.test.mjs`

**Interfaces:**
- `sessionArgs(cfg, {prompt, phase, model, schema}) -> string[]` exactly per Global Constraints.
- `runClaudeOnce(ctx, opts) -> {ok, text, structured, init, isError, limited, resetAt, transient, timedOut, cost, log}`; `runClaude(ctx, opts)` with usage-limit sleep and 3 transient retries.
- `isolationProblems(init, {userSkills, repoMcp}) -> string[]` (non-builtin plugin, MCP server not in repo config, skill in `~/.claude/skills`, `memory_paths.auto` present).
- `writeSettings(root, cfg)` → `.loop/claude-settings.json` with `autoMemoryEnabled:false`, guard hook, deny list (`Bash(gh pr merge:*)`, force-push, `Bash(supabase db push:*)`, `Bash(supabase db reset:*)`, `mcp__supabase__apply_migration`).

- [ ] Step 1: Tests `read-only phase gets disallowedTools and json-schema`, `never passes --bare`, `structured_output is returned`, `usage limit sleeps then retries`, `crash without result is not ok`, `foreign plugin in init is an isolation problem`. FAIL → implement → PASS. Commit `feat(loop): isolated headless sessions`.

### Task 8: Post-merge adapter `supabase-cli`

**Files:** Create `loop/adapters/postmerge-supabase-cli.mjs`, `loop/adapters/index.mjs`, test `postmerge.test.mjs` (fake supabase bin)

**Interfaces:** adapter `{ name, run(ctx, {mergeSha, item}) -> {ok:true} | {ok:false, why, ownerAction} }`. supabase-cli: new files = added `*.sql` under `migrationsDir` in `mergeSha^..mergeSha` plus any local file the remote lacks; destructive regex (the original `DESTRUCTIVE_RE`) → not applied, owner action; else `supabase db push --db-url $<dbUrlEnv> --include-all` then `supabase migration list --db-url …` must show every local version remote; env var missing → not ok with owner action.

- [ ] Step 1: Tests `no migrations is ok`, `destructive file holds`, `push then verified list is ok`, `remote missing a version holds`, `missing DB URL env holds`. FAIL → implement → PASS. Commit `feat(loop): supabase-cli post-merge adapter`.

### Task 9: Runner orchestration

**Files:** Create `loop/run.mjs`, `loop/lib/engine.mjs` (runItem state machine), `loop/lib/milestones.mjs` (accept + packet), `loop/lib/report.mjs`, test `run.scenarios.test.mjs`

**Interfaces:** CLI flags as in the original (`--dry-run --once --item --only --max-iterations --max-hours --status --reset --skip --release <ID>`). Phases: `build → ci → review → merge → landed → baseci → postmerge → done`; hold phase on landed mismatch, base CI timeout, unverified post-merge. Owner asks raised during a run go to `.loop/OWNER-ACTIONS.md`; `docs/OWNER-ACTIONS.md` holds the setup-time ones `/shape-project` writes. Smoke test at every start: one session told to run `git push origin <base>`; pass only if `.loop/logs/guard.log` gained a line for item `preflight`. Isolation check on that session's init event.

- [ ] Step 1: Scenario tests with fake claude + gh: `happy path merges and marks done`, `red CI gets a fix round`, `review changes three times → needs_human`, `post-merge unverified → held and run stops`, `base CI timeout → held`, `landed mismatch → held`, `usage limit sleeps and retries`, `three no-merge items trip the circuit breaker`, `crash mid-review resumes at review`, `smoke test fails when guard log stays empty`, `repeated review finding queues LEARN item first`, `acceptance failure queues ACC item`. FAIL → implement → PASS. Commit `feat(loop): runner orchestration`.

### Task 10: Step prompts

**Files:** Create `loop/prompts/build.md`, `review.md`, `accept.md`, `packet.md`, `learn.md` (section rendered into build for `kind:'learn'`), test `prompts.test.mjs`
Generic versions of the original prompts: placeholders `{{…}}` the runner fills; project rules referenced via CLAUDE.md and DESIGN.md; design calibration against `design/mocks/accepted/`; health poll uses `{{DEV_URL}}{{HEALTH}}`; verdict fields match `schemas.mjs`. Test: every `{{VAR}}` in each prompt is supplied by the runner's render call; no identifiers from the original project.
- [ ] FAIL → write → PASS. Commit `feat(loop): generic step prompts`.

### Task 11: Stack preset (parallel)

**Files:** `package.json` (scripts: dev, build, start, lint, typecheck, test:unit, test:e2e, test:loop=`node --test loop/test/`, ac-trace, check:rules, check:skills, sanitize, loop=`node loop/run.mjs`), `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/route.ts`, `src/lib/supabase/{server,client}.ts`, `src/lib/env.ts` (Zod), `src/lib/stub.ts`, `vitest.config.mts` (v8, `thresholds.autoUpdate: true`), `playwright.config.ts`, `tests/unit/health.test.ts`, `tests/e2e/journeys/home.spec.ts` (axe), `scripts/ac-trace.mjs` + test, `supabase/migrations/.gitkeep`, `supabase/config.toml`, `.env.example`, `.github/workflows/ci.yml` (job `ci`, push+PR on base and production), `.github/workflows/loop-runner.yml` (OS matrix ubuntu/macos/windows running `pnpm test:loop`)
- [ ] Build passes; `pnpm test:unit`, `pnpm test:e2e` (local), `pnpm ac-trace` green. Commit `feat(preset): Next.js + Supabase + Vercel preset with CI gates`.

### Task 12: Skills (parallel)

**Files:** `.claude/skills/{setup-loop,shape-project,draft-design,run-retro,sync-arc42}/SKILL.md` + `scripts/` validators (`check-config.mjs`, `check-backlog.mjs`, `shoot.mjs`, `check-rule-examples` reuse of Task 4) + `evals/evals.json` (3 scenarios each); `scripts/check-skills.mjs` (frontmatter: name pattern, description ≤ 1024 and third person, `disable-model-invocation: true`, SKILL.md < 500 lines, linked references exist).
- [ ] `pnpm check:skills` green. Commit `feat(skills): five setup skills with validators and evals`.

### Task 13: Docs and sanitizer (parallel)

**Files:** `README.md`, `WHY.md`, `CLAUDE.md`, `DESIGN.md`, `design/mocks/accepted/.gitkeep`, `docs/{BRIEF,REQUIREMENTS,BACKLOG,DECISIONS,LESSONS,OWNER-ACTIONS}.md`, `docs/architecture/{README,01-goals,03-context,04-strategy,05-building-blocks,08-crosscutting,09-decisions,11-risks}.md`, `examples/sample-backlog/{backlog.json,REQUIREMENTS.md}`, `loop/README.md`, `loop/backlog.json` (LOOP-0 only), `scripts/sanitize-scan.mjs` + test.
- [ ] `pnpm sanitize` green over the whole repo. Commit `docs: explorer docs, skeletons and sanitizer scan`.

### Task 14: Verification

- [ ] `pnpm test:loop`, `pnpm test:unit`, `pnpm build`, `pnpm test:e2e`, `pnpm check:rules`, `pnpm check:skills`, `pnpm ac-trace`, `pnpm sanitize` — quote outputs.
- [ ] `node loop/run.mjs --dry-run` on the repo prints the named config problems (fresh clone).
- [ ] One fresh reviewer over the whole repo (code-review at high effort).
- [ ] Not possible locally, handed to the owner: create the GitHub repo, mark it a template, OS-matrix CI, gate drills and dogfood run (they need a real repo and a Supabase/Vercel project).
