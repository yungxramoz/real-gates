# 4 · Building blocks

<!-- The module map. Start from the folder tree (`git ls-files src | cut -d/ -f1-3 | sort -u`),
     then check it by hand. A new module or route group updates this page in the same PR:
     `node scripts/arch-check.mjs` fails when a folder in src/ or a module in src/lib/ is not
     named here in backticks, or when a path named here is gone. -->

```mermaid
flowchart TB
  subgraph app["src/app — routes"]
    pages["pages"]
    api["api/health"]
  end
  subgraph lib["src/lib — logic"]
    env["env.ts<br/>validated config"]
    supa["supabase/<br/>server + client"]
    stub["stub.ts<br/>preview stubs"]
  end
  subgraph shared["src — shared by every page"]
    i18n["i18n/<br/>user-facing strings"]
    styles["styles/<br/>design tokens"]
  end
  db[("supabase/migrations")]
  pages --> i18n
  pages --> styles
  pages --> supa
  api --> supa
  supa --> env
  supa -.-> db
```

| Block              | Path                  | Responsibility                                      | Depends on         |
| ------------------ | --------------------- | --------------------------------------------------- | ------------------ |
| Health             | `src/app/api/health/` | Reports `{ commit, db }` for acceptance             | `src/lib/supabase` |
| Config             | `src/lib/env.ts`      | Reads and validates environment variables           | —                  |
| Data access        | `src/lib/supabase/`   | Server and browser clients                          | Config             |
| Stubs              | `src/lib/stub.ts`     | Fakes external services in preview and CI           | Config             |
| Strings            | `src/i18n/`           | Every user-facing string, in one place              | —                  |
| Design tokens      | `src/styles/`         | The colours of `DESIGN.md` as CSS custom properties | —                  |
| <!-- new block --> |                       |                                                     |                    |
