# Interview question bank

Ask one question per message. Each comes with a recommended answer; adapt it to what you already
heard. Skip a question the owner already answered. A topic is done when you could write its part of
the brief without guessing.

## Contents

- Problem and audience
- Core journeys
- Scope edges
- Data and integrations
- Constraints
- Accounts and owner actions
- Play-back format

## Problem and audience

| Question | Recommend |
|---|---|
| Who uses it, and what do they do today instead? | name one primary user group; others come later |
| What is the one thing it must do well on day one? | the job the primary user comes back for |
| How will you know it works? | one number or event you can see within a month |
| Who runs it day to day (admin, content, support)? | the owner, through a small admin area |

## Core journeys

A journey is a user goal from start to finish, for example "a visitor signs up for an event and
gets a confirmation email". Aim for three to five.

| Question | Recommend |
|---|---|
| Walk me through the first visit, step by step. | the shortest path to the main job, no account needed if possible |
| What happens when something goes wrong (full, expired, invalid)? | a clear message and the next step, never a dead end |
| What does the admin do, and how often? | list, edit, export; nothing that a spreadsheet does better |
| What must work on a phone? | everything; design at 360 px first |

## Scope edges

| Question | Recommend |
|---|---|
| What will it explicitly not do in the first version? | payments, accounts and multi-language unless the main job needs them |
| Is there anything it must never do (data, legal, brand)? | write each as a rule; it may become a guard rule or a CI check |
| What can wait for a later milestone? | anything that is not on a core journey |

## Data and integrations

| Question | Recommend |
|---|---|
| What does it store about people? | the minimum for the journey; no personal data in logs or test fixtures |
| Who may see which data? | public reads only aggregate or published data; everything else behind auth with row-level security |
| Which external services: email, payments, maps, analytics? | one provider per need; each gets a stub for CI |
| Does any data come from elsewhere (import, API)? | a one-off import script before a live sync |

## Constraints

| Question | Recommend |
|---|---|
| Language, locale, time zone, currency? | one locale for v1; all strings in one file |
| Accessibility target? | WCAG 2.2 AA |
| Legal: privacy notice, imprint, cookie consent? | a privacy page and no tracking cookies, so no banner is needed |
| Brand assets you may not use? | write each as a rule in `CLAUDE.md` |
| Budget for hosted services? | free tiers; write a limit per service in `docs/DECISIONS.md` |

## Accounts and owner actions

Everything here becomes a row in `docs/OWNER-ACTIONS.md`, not a question for the loop:

- domain and DNS records
- email sending domain verification
- payment provider account and keys
- hosting project, environment variables, deployment protection bypass
- the dev and production databases

Ask: "Which of these do you already have?" Recommend creating dev accounts before the first
milestone and production ones before the release.

## Play-back format

After each topic:

```
What I heard about <topic>:
- ...
- ...
Anything wrong or missing?
```

After the whole interview, one screen: who, journeys (numbered), out of scope, integrations,
constraints, owner actions. Then ask: "Is this the app?"
