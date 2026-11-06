# 3 · Context and scope

<!-- Update in the same PR as a new integration. One box per external system, one arrow per
     direction of data. -->

```mermaid
flowchart LR
  user(["User<br/>browser, phone"]) -->|HTTPS| app["The app<br/>Next.js on Vercel"]
  owner(["Owner"]) -->|admin pages| app
  app -->|SQL via Supabase client, RLS| db[("Supabase<br/>Postgres + Auth")]
  app -.->|"stubbed when APP_ENV=preview"| ext["External services<br/>email, payments …"]
  ci["GitHub Actions<br/>ci"] -->|build, test, e2e on a local build| app
```

| Neighbour                    | What crosses the boundary                     | Owner of the account |
| ---------------------------- | --------------------------------------------- | -------------------- |
| Supabase                     | Data, auth sessions                           | Owner                |
| Vercel                       | Deploys from the base and production branches | Owner                |
| <!-- e.g. email provider --> |                                               |                      |

## Out of scope

<!-- Systems people might expect us to integrate with, and why we don't. -->
