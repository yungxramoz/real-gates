# Owner actions

Things only the owner can do: they need the owner's accounts, money, legal identity or a call that
is theirs. Written by `/shape-project` at setup time. Asks raised **during a run** go to
`.loop/OWNER-ACTIONS.md`, which the loop writes and `pnpm loop --status` points to.

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

<!-- shape-project: accounts, DNS, secrets, legal content, decisions only the owner can make.
Typical ones for this preset:
- Connect the repo to a Vercel project; base branch deploys the dev site.
- Create a Vercel protection-bypass secret and store it as the VERCEL_BYPASS environment variable.
- Create the dev Supabase project; store its database URL as the DEV_DB_URL environment variable.
- Verify the email sending domain with the email provider.
- Enable required checks and Actions on the GitHub repo.
-->

## Done

<!-- Move finished actions here with the date and how they were checked. -->
