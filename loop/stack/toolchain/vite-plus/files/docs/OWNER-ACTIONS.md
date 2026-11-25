# Owner actions

Things only the owner can do: they need the owner's accounts, money, legal identity or a call that
is theirs. Written by `/setup-loop` and `/shape-project` at setup time. Asks raised **during a
run** go to `.loop/OWNER-ACTIONS.md`, which the loop writes and `.loop/REPORT.md` points to.

Each action says what to do with exact clicks and values, so nobody has to guess. Tick it when done
and note how it was checked.

## Format

```markdown
### OA-<n> — <short title>

- **Why:** what is blocked until this is done (item IDs)
- **Where:** the account or dashboard
- **Steps:** numbered, with the exact values to enter
- **Check:** the command or page that proves it is done
- [ ] done
```

## Open

<!-- shape-project: accounts, secrets, legal content, decisions only the owner can make.
Typical ones:
- Enable required checks and Actions on the GitHub repo.
- Protect the base branch: require a pull request and the `ci` check.
-->

## Done

<!-- Move finished actions here with the date and how they were checked. -->
