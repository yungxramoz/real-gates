# Architecture (lean arc42)

Seven of the twelve [arc42](https://arc42.org) sections. The others either duplicate files that
already exist or stay empty in a project this size. Diagrams are Mermaid, which GitHub renders.

**Rule:** a PR that changes a building block, an integration or a crosscutting rule updates the
matching section in the same PR. The reviewer blocks it otherwise. `/sync-arc42` fixes drift once
per milestone.

| §   | Section                                     | Source of truth                                 | Updated when                              |
| --- | ------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| 1   | [Goals](01-goals.md)                        | Links to `docs/BRIEF.md`                        | `/shape-project`                          |
| 3   | [Context and scope](03-context.md)          | Context diagram: users, external services       | A new integration (email, payments, auth) |
| 4   | [Solution strategy](04-strategy.md)         | Stack preset and key decisions                  | `/setup-loop`, then rarely                |
| 5   | [Building blocks](05-building-blocks.md)    | Module map from the folder tree                 | A new module or route group, same PR      |
| 8   | [Crosscutting concepts](08-crosscutting.md) | Auth, data access, errors, i18n, a11y, security | A changed rule, same PR                   |
| 9   | [Decisions](09-decisions.md)                | Links into `docs/DECISIONS.md`, never copies    | Automatically: it is a link               |
| 11  | [Risks and tech debt](11-risks.md)          | Follow-ups and known gaps from packets          | `/sync-arc42` per milestone               |
