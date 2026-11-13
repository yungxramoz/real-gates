# <!-- setup-loop: project name --> — project rules

<!--
  This file is a template. /setup-loop fills every `setup-loop:` placeholder from
  loop/loop.config.json, and /shape-project fills the `shape-project:` ones. Every loop session
  reads this file in full, so keep it short: rules here, reasons in docs/DECISIONS.md.
  Rules that must hold every time also live in the guard (loop/guard/) or in CI. This file is
  context, not enforcement.
-->

You are working on **<!-- setup-loop: project name -->**: <!-- shape-project: one sentence on what it is and for whom -->.
The owner is the person who runs this repo and makes the product, design and release calls.

## Read first

1. `docs/BRIEF.md` — what we build and why, in plain language
2. `docs/REQUIREMENTS.md` — epics, stories, testable acceptance criteria (`AC-<epic>.<n>`)
3. `docs/BACKLOG.md` — where the build stands
4. `docs/DECISIONS.md` — decisions already made; don't silently re-decide them
5. `DESIGN.md` — the design system. All UI follows it.
6. `docs/LESSONS.md` — rules learned the hard way, each with the command that proves it
7. `docs/architecture/README.md` — the lean arc42 docs; update the section a change touches in the same PR

## Stack

- **Next.js (App Router) + TypeScript** (`strict`)
- Supabase via `@supabase/ssr`, Zod at every boundary, Vitest + Playwright (with axe), pnpm
- Deployed on Vercel. External services have a stub mode (`APP_ENV=preview`) so e2e runs in CI
- Locale <!-- shape-project: locale, e.g. en-GB -->, time zone <!-- shape-project: time zone -->, currency <!-- shape-project: currency or "none" -->
- A change to the stack is a decision: record it in `docs/DECISIONS.md` first

## Environments

|                                               | Value                                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| GitHub repo                                   | <!-- setup-loop: repo -->                                   |
| Base branch (the loop merges here)            | <!-- setup-loop: base -->                                   |
| Production branch (never touched by the loop) | <!-- setup-loop: production -->                             |
| Required CI check                             | <!-- setup-loop: ciCheck -->                                |
| Dev site (base branch deployed)               | <!-- setup-loop: deploy.devUrl -->                          |
| Health endpoint                               | <!-- setup-loop: deploy.health --> returns `{ commit, db }` |
| Dev database (Supabase project ref)           | <!-- setup-loop: guard.allowedDbProject -->                 |
| Database schema                               | <!-- setup-loop: guard.dbSchema -->                         |
| Commit author                                 | <!-- setup-loop: gitAuthor -->                              |

## HARD RULES — Database

1. **The dev project above is the only database this repo may touch.** Every other project is out
   of bounds, reads included. Forbidden refs: <!-- setup-loop: guard.forbiddenRefs -->. The guard
   blocks any other project.
2. Use only the schema above. Never create, change or write to anything in `public`, `auth`
   internals or any other schema.
3. **RLS on every table, default deny.** Anonymous users read only what is meant to be public.
   Public writes go through `SECURITY DEFINER` functions with a fixed `search_path`.
4. Every schema change is a **new file** in `supabase/migrations/`, committed and reviewed.
   No ad-hoc SQL except read-only inspection.
5. **Applied migrations are frozen.** Never edit a migration that is already on the base branch.
   Fix forward with a new file.
6. **Destructive SQL** (`DROP`, `TRUNCATE`, unbounded `DELETE`, data-losing type changes, removing
   columns) only after the owner approved that statement. The loop never applies it; it goes to
   `.loop/OWNER-ACTIONS.md`.
7. Agents never apply migrations. After a merge, the script applies them with the Supabase CLI and
   verifies them. `supabase db push` and `supabase db reset` are blocked for agents.

## HARD RULES — Secrets and data

- Server-only keys (the Supabase service role key, email and payment API keys) are **never**
  `NEXT_PUBLIC_`, never in client code, logs or commits.
- Never edit `.env*` files. New variables go into `.env.example` with an empty value.
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

<!-- shape-project: the few product rules that are easy to miss, one bullet each. For example:
- All user-facing strings in one place (`src/i18n/<locale>.ts`), no hard-coded UI text.
- Mobile-first: everything works at 360 px. WCAG 2.2 AA.
- Design quality is a priority: build on DESIGN.md; "generic" is a defect.
-->

## How the autonomous loop works

The backlog is built by a sequential loop (`pnpm loop`): one item per fresh headless session.

1. A **build** session writes a contract (every AC and its proof), then code, tests and a PR to the
   base branch, and ends with `.loop/result.json`.
2. The **script** waits for CI, runs the pre-merge checks and starts an independent, **read-only
   review** session.
3. Only then does the **script merge** (squash, `--match-head-commit`). The agent never merges.
4. The script checks the merge landed, waits for base CI, applies and verifies migrations, and
   runs milestone acceptance on the dev site.
5. At the end of every milestone, and early when the same failure shows up in several items, the
   script holds a **retro**: what went well, what went wrong and why. Its action items become one
   `LEARN` item; the minutes are in `docs/retros/`. A cause in the harness is reported to the owner
   as an impediment: never fix the guard or the runner, and never write a lesson that works around
   them.

If you are inside a loop session, the step prompt from the script (`loop/prompts/`) adds the rules
for working unattended. Nobody can answer a question during a run: make small, reversible calls yourself and record them
in `docs/DECISIONS.md`; write anything that needs the owner to `.loop/OWNER-ACTIONS.md`.
How to run, watch and stop it: `loop/README.md`.

## Working with the owner

The owner makes the product, design and release calls.

- Ask only what is genuinely theirs to decide, or what needs their accounts (DNS, Vercel env
  values, email provider, branch protection, the production database).
- Bundle questions and recommend one answer. Show rather than describe when options differ
  visually.
- Small, reversible choices: decide yourself and record them in `docs/DECISIONS.md` (append at the
  bottom; the next free ID is in the last log bullet).
- At the end of a milestone, show the result on the dev site: link, mobile screenshots, what to
  check.
