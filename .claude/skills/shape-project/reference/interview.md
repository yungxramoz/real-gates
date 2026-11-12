# Interview question bank

Ask one question per message. Each comes with a recommended answer; adapt it to what you already
heard. Skip a question the owner already answered. A topic is done when you could write its part of
the brief without guessing.

## Contents

- Before the first question
- Problem and audience
- Core journeys
- Scope edges
- Data and integrations
- Terms and numbers
- Constraints
- Accounts and owner actions
- Play-back format

## Before the first question

Read the owner's message as it arrived, not as it was probably meant.

- **Cut off or garbled?** A sentence that stops in the middle, a list item with no end, a line
  that does not parse: quote it and ask what it said. This is the first question, alone. Do not
  fill the gap yourself and do not ask the owner to confirm your filling.
- **A word that could mean two systems or two things?** ("our runs", "the report", "users".) Ask
  which, and say what each reading would change.
- **Start the running list** (rule 7): one line per answer and per default, from here on.

## Problem and audience

| Question | Recommend |
|---|---|
| Who uses it, and what do they do today instead? | name one primary user group; others come later |
| What is the one thing it must do well on day one? | the job the primary user comes back for |
| How will you know it works? **Always ask.** | one number or event you can see within a month |
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

When the product reads or reports on something that exists, read that source before you ask
(rule 5). Bring to the owner:

- every list the product will show, complete and with the file it comes from (all statuses, all
  stages, all kinds of check), never a shortened or remembered one;
- what the source does **not** hold and where that would have to come from;
- what differs between old and new versions of the source.

## Terms and numbers

Every number the product shows needs a definition the owner agreed to (rule 6). Ask one at a time.

| Question | Recommend |
|---|---|
| What exactly is one <thing that is counted>? Where does it start and end? | the smallest unit the owner already talks about; say what a stop, a retry or a resume does to it |
| Is this number exact or an estimate? Whose number is it? | label an estimate as one wherever it is shown |
| "How long": working time, or from first start to last end? | show both when they can differ by much |
| When two of them are compared and differ in size, what is fair? | per-unit figures beside the totals |
| What does "the biggest / slowest / most expensive" mean: a top list, a threshold, all sorted? | all, sorted, with a way to limit |

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

When the owner said yes to every recommendation in the topic, or their request was short, add one
open question before you move on: "What did I leave out here?"

After the whole interview, one screen, written from the running list: who, journeys (numbered),
terms (what each number means), success (the measure), out of scope, integrations, constraints,
defaults you set, owner actions. Check it against the list line by line before sending. Then ask:
"Is this the app?"
