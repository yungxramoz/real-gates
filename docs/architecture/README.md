# Architecture (lean arc42)

Seven pages, numbered in reading order. They are the seven of the twelve
[arc42](https://arc42.org) sections that earn their place in a project of this size; the others
either duplicate files that already exist or stay empty. The last column names the arc42 section a
page stands for. Diagrams are Mermaid, which GitHub renders.

**Rule:** a PR that changes a building block, an integration or a crosscutting rule updates the
matching page in the same PR. Two things hold it to that, with nobody watching:

- `node scripts/arch-check.mjs` runs on every PR. It fails when a building block in the code is
  not named on the building-blocks page, when a path named there is gone, when a page names a
  decision ID `docs/DECISIONS.md` does not have, or when a link leads nowhere.
- The reviewer blocks a PR whose pages say something that is not true.

`/sync-arc42` is for what neither sees: prose that drifted over a whole milestone.

| #   | Page                                        | Source of truth                                 | Updated when                              | arc42 section               |
| --- | ------------------------------------------- | ----------------------------------------------- | ----------------------------------------- | --------------------------- |
| 1   | [Goals](01-goals.md)                        | Links to `docs/BRIEF.md`                        | `/shape-project`                          | 1 Introduction and goals    |
| 2   | [Context and scope](02-context.md)          | Context diagram: users, external services       | A new integration (email, payments, auth) | 3 Context and scope         |
| 3   | [Solution strategy](03-strategy.md)         | Stack preset and key decisions                  | `/setup-loop`, then rarely                | 4 Solution strategy         |
| 4   | [Building blocks](04-building-blocks.md)    | Module map from the folder tree                 | A new module or route group, same PR      | 5 Building block view       |
| 5   | [Crosscutting concepts](05-crosscutting.md) | Auth, data access, errors, i18n, a11y, security | A changed rule, same PR                   | 8 Crosscutting concepts     |
| 6   | [Decisions](06-decisions.md)                | Links into `docs/DECISIONS.md`, never copies    | Every new architecture decision           | 9 Architecture decisions    |
| 7   | [Risks and tech debt](07-risks.md)          | Follow-ups and known gaps from packets          | `/sync-arc42` per milestone               | 11 Risks and technical debt |
