---
name: setup-loop
description: Sets up the unattended build loop in a clone of this template. Asks for the GitHub repo, branches, dev database project, forbidden projects, preview URL, notify topic and git author one question at a time, writes loop/loop.config.json and .env.example, creates the base branch, then proves the setup with a validator, a dry run and the LOOP-0 item. Use right after "Use this template", when the dry run or preflight reports config problems, or when the repo, branches, database or deploy URL change. Safe to run again.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/check-config.mjs"*) Bash(node loop/run.mjs --dry-run*) Bash(node loop/run.mjs --status*) Bash(gh auth status*) Bash(gh repo view*) Bash(git status*) Bash(git branch*) Bash(git remote*) Bash(git ls-remote*) Bash(claude --version*)
---

# Set up the loop

Done means: `node "${CLAUDE_SKILL_DIR}/scripts/check-config.mjs"` prints `ready`,
`node loop/run.mjs --dry-run` shows no problems, and LOOP-0 is the next item.

## Rules

1. **A person answers.** Ask one question at a time, give your recommended answer and the reason,
   then wait. If nobody can answer (a headless `-p` session), stop and change nothing.
2. **Idempotent.** Read `loop/loop.config.json` first. A value that is already set is shown and
   kept unless the user changes it. Never blank a set value.
3. **Ask before anything outward-facing or destructive**: `git push`, creating a GitHub repo, repo
   settings, branch protection, secrets, deleting branches or files, installing global tools,
   starting the loop. Show the exact command, wait for a yes. The user runs interactive logins
   (`gh auth login`, `claude` → `/login`) themselves.
4. **Write only these files**: `loop/loop.config.json`, `.env.example`, the `branches:` filters in
   `.github/workflows/*.yml`, and new rows in `docs/OWNER-ACTIONS.md`. Never edit `loop/run.mjs`,
   `loop/lib/`, `loop/guard*` or `loop/backlog.json`.
5. **Ask only what this stack needs.** `profile` in `loop/loop.config.json` names the stack profile
   (`loop/profiles/<name>/profile.json`). Read it first. No `postMerge` steps there: skip step 4
   (database). `deploy.adapter` is `none`: skip step 5 (deploy). Use the project's package manager
   in every command you show (`pnpm` with a `pnpm-lock.yaml`, otherwise `npm`).
6. **Secrets stay out of git.** `.env.example` holds names with empty values. Never ask the user to
   paste a secret into the chat; tell them where it goes.

## Workflow

Copy this checklist into your reply and tick it off as you go:

```
Setup progress:
- [ ] 1. Baseline: run the validator, read the current config
- [ ] 2. Tools: Node, Claude Code, gh, dependencies installed, a browser for the tests if the stack uses one
- [ ] 3. Repo and branches (repo, base, production, ciCheck)
- [ ] 4. Database (allowed project, forbidden projects, DB URL variable), if the profile has one
- [ ] 5. Deploy (dev URL, health path, bypass secret variable), if the profile deploys
- [ ] 6. Notify topic and git author
- [ ] 7. Write the config, .env.example, CI branch filters, owner actions
- [ ] 8. Validate: run check-config, fix, repeat until "ready"
- [ ] 9. Dry run: node loop/run.mjs --dry-run
- [ ] 10. LOOP-0: commit the setup, offer to run the first item
```

### 1. Baseline

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-config.mjs"
```

Every `PROBLEM` line is a to-do for one of the steps below. Read `loop/loop.config.json` and
`loop/README.md`. Tell the user in two lines what is set and what is missing, then start with the
first missing step. Skip steps whose values are set and confirmed.

### 2. Tools

Fix what the validator named, in this order. Each fix is the user's command or needs a yes:

- Claude Code below the floor in `loop/lib/config.mjs` → the user runs `claude update`.
- `gh` not logged in → the user runs `! gh auth login`.
- `@playwright/test` missing → ask, then install the dependencies (`pnpm install` or `npm install`).
- No Chromium → ask, then install it (`pnpm exec playwright install chromium`).

The validator names the last two only for a project whose `package.json` declares Playwright.

MCP servers: loop sessions see only servers in the repo's own `.mcp.json` (the runner passes
`--strict-mcp-config`). Run `claude mcp list` and tell the user which personal servers the loop will
*not* see. Details and the isolation preflight: [reference/environment.md](reference/environment.md).

### 3. Repo and branches

Ask, in this order, with the recommendation from [reference/config-fields.md](reference/config-fields.md):
`repo` (recommend the output of `gh repo view --json nameWithOwner -q .nameWithOwner`), `base`
(recommend `develop`), `production` (recommend `main`). `ciCheck` must equal the job name in
`.github/workflows/ci.yml` (the preset uses `ci`); read it, don't ask.

If origin has no base branch, propose and wait for a yes:

```bash
git branch <base> origin/<production>
git push -u origin <base>
```

Then add an owner action: protect `<production>` and require the `<ciCheck>` check on `<base>`.

### 4. Database

The preset's post-merge step applies migrations to **one** dev database. Ask:

1. `guard.allowedDbProject`: the dev project's ref. Recommend a dedicated dev project, never
   production.
2. `guard.forbiddenRefs`: every other project ref on the same account, production first.
3. The DB URL variable name (`postMerge[0].dbUrlEnv`, default `DEV_DB_URL`). Keep the default.

Where to find refs, and what to do when the project has no database:
[reference/config-fields.md](reference/config-fields.md#database).

### 5. Deploy

Ask for `deploy.devUrl`, the stable URL of the base branch deployment. Recommend the branch alias
(see [reference/config-fields.md](reference/config-fields.md#deploy)). Keep `health` at
`/api/health` and `bypassSecretEnv` at `VERCEL_BYPASS` unless the user has a reason. If the repo is
not connected to a host yet, write that as an owner action and leave `devUrl` empty; the validator
keeps naming it until it is set.

### 6. Notify topic and git author

- `notify.ntfyTopic`: optional. Recommend a hard-to-guess topic, since ntfy topics are public:
  `node -e "console.log('loop-' + crypto.randomUUID().slice(0, 12))"`.
- `gitAuthor`: recommend `git config user.name` and `git config user.email`. The email must be a
  verified email of the GitHub account the host links to, or preview builds are skipped.

Budgets and review thresholds keep their defaults. Mention them in one line; change them only when
asked.

### 7. Write

1. Write `loop/loop.config.json`: keep its `$comment` and key order, 2-space JSON.
2. `.env.example`: make sure there is one line `NAME=` per variable the config names
   (`postMerge[].dbUrlEnv`, `deploy.bypassSecretEnv`), each with a one-line `#` comment saying where
   the value comes from. Keep existing lines.
3. If `base` or `production` differ from the `branches:` filters in `.github/workflows/*.yml`,
   update the filters.
4. Append owner actions (accounts, secrets, branch protection, host env vars) to
   `docs/OWNER-ACTIONS.md`, one row each: what, where, why, and how to verify. Always include
   branch protection on `base`: require a pull request and the `ciCheck` status check, no direct
   pushes, no force-pushes, no required approvals (nobody approves the loop's PRs). Nobody
   reviews them either, so this is what stops a session's stray push at GitHub; the runner's
   after-session check only notices it afterwards. The preflight asks GitHub and refuses a real
   run while the base branch is unprotected (the dry run warns).

### 8. Validate

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-config.mjs"
```

For each `PROBLEM`, go back to the step that owns it, fix, run again. Continue only at `ready`.
A problem only the owner can fix (a login, an account) may stay open if it is in
`docs/OWNER-ACTIONS.md`; say so explicitly.

### 9. Dry run

```bash
node loop/run.mjs --dry-run
```

It runs the preflight and shows the next item without starting a build. Read every line. A config
problem → back to step 8. An isolation or permission problem →
[reference/environment.md](reference/environment.md#preflight-messages). Expect the next item to be
`LOOP-0`.

### 10. LOOP-0

LOOP-0 proves the pipeline end to end on a harmless change: build, CI, review, merge by the script,
base CI on the merge commit.

1. Show `git status`. Propose committing the setup files on a branch `chore/setup-loop` and opening
   a PR into `<base>`; wait for a yes before `git push` and `gh pr create`. The owner merges this
   one PR; after it, only the loop merges.
2. Once it is merged and `<base>` is checked out and pulled, offer the first run and recommend a
   separate terminal so the user can watch:

   ```bash
   node loop/run.mjs --once --item LOOP-0
   ```

3. After it finishes, `node loop/run.mjs --status` must show LOOP-0 done. Anything else → read
   `.loop/PROGRESS.md` and the newest log in `.loop/logs/`, explain the cause, go back to the
   owning step.

End with a three-line summary: what is set, what is still an owner action, and the next skill
(`/shape-project`).
