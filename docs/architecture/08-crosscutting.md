# 8 · Crosscutting concepts

<!-- One short section per rule that applies across modules. A changed rule updates this page in
     the same PR. Hard rules live in CLAUDE.md; this page says how the code follows them. -->

## Auth and access

<!-- Who can do what, where it is checked (RLS policy, route guard), how admins are identified. -->

## Data access

- RLS on every table, default deny. Anonymous users read only public data.
- Public writes go through `SECURITY DEFINER` functions with a fixed `search_path`.
- Rules that need consistency (capacity, counters) live in one Postgres function with a row lock.

## Errors

<!-- How errors reach the user, what is logged (never personal data), what the health endpoint
reports. -->

## Text and locale

<!-- Where user-facing strings live, the locale, date and number formats. -->

## Accessibility

- WCAG 2.2 AA. Every journey test runs axe.
- Everything works at 360 px.

## Security

- Server-only keys never reach the client (`NEXT_PUBLIC_` is public).
- Inputs are validated with Zod at the boundary.

<!-- add: CSP, rate limits, CSRF, as they come up -->
