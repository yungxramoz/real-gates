# Environment

What the machine that runs the loop needs, and what the preflight messages mean.

## Contents

- Tools
- What a loop session can see
- Preflight messages
- Keeping the machine awake

## Tools

| Tool | Check | Fix (the user runs it, or says yes) |
|---|---|---|
| Node | `node --version` | install the current LTS |
| Claude Code | `claude --version` against the floor in `loop/lib/config.mjs` | `claude update`, then `claude` → `/login` with the subscription |
| gh | `gh auth status` | `gh auth login` (interactive) |
| pnpm | `pnpm --version` | `corepack enable` |
| Playwright | Chromium in the browser cache | `pnpm exec playwright install chromium` |

`ANTHROPIC_API_KEY` in the environment makes sessions bill the API instead of the subscription. The
runner removes it from its sessions unless `allowApiKey` is set in the config. Tell the user if it
is set.

## What a loop session can see

Every loop session starts with `--setting-sources project,local` and `--strict-mcp-config`, plus
`--mcp-config .mcp.json` when the repo has one. So a session sees:

- the repo's `.claude/settings.json` and `.claude/settings.local.json`, not the user's
  `~/.claude/settings.json`
- only the MCP servers in the repo's `.mcp.json`, not the user's personal servers
- the repo's skills in `.claude/skills/`; the five setup skills set `disable-model-invocation`, so
  a loop session never loads them

If the project wants an MCP server inside the loop (for example a Supabase server for read-only
inspection), it goes in `.mcp.json`, scoped to `guard.allowedDbProject`. Writing `.mcp.json` is
outside this skill's file list: propose the exact file and wait for a yes.

## Preflight messages

The runner checks every run start. Fix the cause; never weaken the check.

**Isolation problem: a plugin, MCP server, user skill or auto-memory path shows up in the session's
init event.** Something from the user's personal setup leaked into a loop session. The cleanest fix
is a separate Claude Code config folder for the loop, so personal plugins and skills cannot load:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-loop" claude      # once: /login
CLAUDE_CONFIG_DIR="$HOME/.claude-loop" node loop/run.mjs --dry-run
```

On PowerShell: `$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-loop"`. Then rerun the dry run.

**Permission smoke test failed: the guard log did not record the planted command.** The guard hook
did not run. Check that `node` is on the PATH of the shell that starts the loop, and that nothing
passes `--bare` (bare mode skips hooks). Do not continue until the smoke test passes: without it no
gate is enforced.

**Auto mode is not available headless.** The loop needs `--permission-mode auto` and never
bypasses permissions. The user's plan or org settings have to allow auto mode; write it as an owner
action and stop.

**Config problem.** Same text as `check-config.mjs` prints: go back to the step that owns the key.

## Keeping the machine awake

A run takes hours. The machine must not sleep:

| OS | Command |
|---|---|
| Windows | `powercfg /change standby-timeout-ac 0` (undo: `30`) |
| macOS | `caffeinate -i node loop/run.mjs` |
| Linux | `systemd-inhibit node loop/run.mjs` |
