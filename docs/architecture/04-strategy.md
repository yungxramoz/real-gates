# 4 · Solution strategy

<!-- Written by /setup-loop from the preset, then changed only through a decision. -->

| Concern           | Choice                                                                       | Decision                 |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------ |
| How it is built   | real-gates loop: one agent, the script merges                                | [D-001](../DECISIONS.md) |
| Framework         | Next.js App Router, TypeScript strict                                        |                          |
| Data and auth     | Supabase, RLS default deny, writes through `SECURITY DEFINER` functions      |                          |
| Validation        | Zod at every boundary                                                        |                          |
| Hosting           | Vercel; base branch = dev site, production branch = live site                |                          |
| Tests             | Vitest (coverage ratchet), Playwright + axe against a local production build |                          |
| External services | Stub mode (`APP_ENV=preview`) so CI never calls them                         |                          |

## Key ideas

<!-- Two to five bullets: the ideas that shape the code, e.g. "capacity is decided in one Postgres
function with a row lock, never in application code". -->
