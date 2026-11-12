# Config fields

Every key of `loop/loop.config.json`: the question to ask, the recommended answer, and where the
value comes from. A key left out of the file keeps the value from the stack profile
(`loop/profile/profile.json`), and what the profile does not set keeps its default from
`loop/lib/config.mjs` (`DEFAULTS`). Ask only for this project's own values. What belongs to the
stack (check commands, gate files, guard packs, adapters, the health contract) is the profile's
and is described in `loop/profile/README.md`; do not copy it into the project config.

## Contents

- Repo and branches
- Database
- Deploy
- Notify and git author
- Defaults to leave alone
- Owner actions this step usually produces

## Repo and branches

| Key | Ask | Recommend | Source |
|---|---|---|---|
| `repo` | "Which GitHub repo is this?" | the current remote | `gh repo view --json nameWithOwner -q .nameWithOwner` |
| `base` | "Which branch does the loop merge into?" | `develop` | the loop merges here, never anywhere else |
| `production` | "Which branch is production?" | `main` | the loop never touches it; must differ from `base` |
| `ciCheck` | do not ask | `ci` | the job name in `.github/workflows/ci.yml` |

Why a separate base branch: the loop merges dozens of PRs without a human review. Production only
moves when the owner merges `base` into it after looking at a milestone packet.

Branch setup when origin has only `main`:

```bash
git branch develop origin/main
git push -u origin develop
```

Both lines need a yes. Branch protection (require `ci` on `base`, block direct pushes to
`production`) is set in GitHub → Settings → Branches by the owner: write it as an owner action.

## Database

The preset's post-merge adapter (`postMerge[].adapter: "supabase-cli"`) applies new migration
files to one dev database from the script, then verifies with the CLI's migration list. The guard
lets agents talk to that one project and blocks every ref in `forbiddenRefs`.

| Key | Ask | Recommend |
|---|---|---|
| `guard.allowedDbProject` | "What is the project ref of the dev database the loop may use?" | a dedicated dev project, never the production one |
| `guard.forbiddenRefs` | "Which other projects are on this account?" | all of them, production first |
| `postMerge[0].dbUrlEnv` | do not ask | `DEV_DB_URL` |
| `postMerge[0].migrationsDir` | do not ask | `supabase/migrations` |
| `guard.dbSchema` | "Which schema do the app tables live in?" | the default in `loop/lib/config.mjs` |

Finding a Supabase project ref: it is the subdomain of the project URL
(`https://<ref>.supabase.co`) and the path segment in the dashboard URL
(`/dashboard/project/<ref>`). `supabase projects list` lists every ref on the account. If a
Supabase MCP server is connected, its `list_projects` tool does the same; call it by its full name
as listed by `claude mcp list` (for a server named `supabase`: `mcp__supabase__list_projects`).

The DB URL value is the dev project's connection string (dashboard → Connect). The user puts it in
the environment that runs the loop (see `loop/README.md`), never in a tracked file and never in the
chat.

**No database in this project**: set `"postMerge": []` and leave `guard.allowedDbProject` empty.
The validator then stops asking for it.

## Deploy

Milestone acceptance runs on the deployed base branch. The acceptance session polls
`<devUrl><health>` until the reported `commit` equals the merged base sha and `db` is `ok`.

| Key | Ask | Recommend |
|---|---|---|
| `deploy.devUrl` | "What URL serves the latest `<base>` deployment?" | the branch alias |
| `deploy.health` | do not ask | `/api/health` (the preset's route) |
| `deploy.bypassSecretEnv` | do not ask | `VERCEL_BYPASS` |

On Vercel the branch alias has the form `https://<project>-git-<base>-<team>.vercel.app`. Find it
under Project → Deployments → filter by the base branch → Domains. A custom domain for the dev
environment works too, once its DNS resolves.

Preview deployments are usually protected. The acceptance session gets past it with the
*Protection Bypass for Automation* secret (Project → Settings → Deployment Protection). The value
goes in the variable named by `bypassSecretEnv`, in the loop's environment.

Check the URL answers before writing it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "<devUrl><health>"
```

`401` or `403` without the bypass header is normal for a protected preview; `000` means the host is
wrong.

**Not deployed yet**: leave `devUrl` empty and write an owner action ("connect the repo to the
host, deploy `<base>`, then rerun /setup-loop"). The validator keeps naming the gap while any
backlog item has `"ui": true`.

## Notify and git author

| Key | Ask | Recommend |
|---|---|---|
| `notify.ntfyTopic` | "Do you want phone notifications through ntfy?" | yes, with a random topic |
| `gitAuthor.name` | "Which name should the loop commit as?" | `git config user.name` |
| `gitAuthor.email` | "Which email?" | `git config user.email`, if it is verified on the GitHub account |

ntfy topics are public: anyone who knows the name can read it. Generate one:

```bash
node -e "console.log('loop-' + crypto.randomUUID().slice(0, 12))"
```

Hosts that build previews per commit often skip commits whose author email does not belong to the
linked account. That is why the email has to be a verified one.

## Defaults to leave alone

`review.minDesignScore`, `review.maxRounds`, `budgets.*`, the per-item limits and the timeouts
come from a run of 49 items with no failed item. Mention them in one line. Change one only when the
user asks, and keep `budgets.maxUsdPerSession` set: it stops a single runaway session.

| Key | What it does | Default |
|---|---|---|
| `budgets.maxUsdPerRun` | stops the run once its sessions cost this much; `0` = no cap | `0` |
| `localGate.commands` | shell commands the runner runs on the pushed head before waiting for CI | preset: `["pnpm check"]` |
| `sessionEnvDeny` | extra environment variables no agent session may see | `[]` |
| `guard.requireBranchProtection` | the preflight refuses to start when the base branch is unprotected | `true` |
| `contractsDir` | where build sessions write `<item>.md` contracts | `docs/contracts` |
| `review.parallelWithCi` | the reviewer starts while CI runs; the merge still needs both on one commit | `true` |
| `baseCiWait` | `unless-tree-equal`: the next item starts while base CI runs on a commit whose tree PR CI already passed; `always`: wait after every merge | `unless-tree-equal` |
| `postMergeOnRedBase` | `apply`: run post-merge steps even when base CI is red (the host deploys the code anyway); `wait`: only after the FIX item is done | `apply` |
| `learnCategoryThreshold` | review findings that share a category but not a cause count as a pattern after this many | `4` |

Set `guard.requireBranchProtection` to `false` only when the user's GitHub plan has no branch
protection for this repository, and say what that costs: a stray push to the base is then only
noticed after it happened.

## Owner actions this step usually produces

Append to `docs/OWNER-ACTIONS.md`, one row each, with how to verify it:

| Action | Verify |
|---|---|
| Protect `<production>`; require a pull request and `<ciCheck>` on `<base>`, no required approvals | `node loop/run.mjs --dry-run` no longer warns about branch protection |
| Put the dev DB URL in the loop's environment as `<dbUrlEnv>` | the dry run no longer names it |
| Create the bypass secret, set it as `<bypassSecretEnv>` | `curl` with header `x-vercel-protection-bypass` returns 200 |
| Subscribe to the ntfy topic on the phone | a test message arrives: `curl -d hi ntfy.sh/<topic>` |
