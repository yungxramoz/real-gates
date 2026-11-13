# Where the run's facts are

The runner writes everything under `.loop/` (not committed) and the committed files below. Read the
files; do not infer numbers from the chat.

## Contents

- Runtime files
- Committed files
- Computing the metrics

## Runtime files

| File | What it holds |
|---|---|
| `.loop/state.json` | per item: status, phase, rounds, CI fixes, review rounds, PR and merge sha; the counters per failure signal (`learn`); the retros, action items and impediments (`retro`); LEARN, FIX and ACC items |
| `.loop/PROGRESS.md` | one line per step, in order, with times |
| `.loop/REPORT.md` | the run's final summary, when the run ended normally |
| `.loop/OWNER-ACTIONS.md` | asks raised during the run |
| `.loop/reviews/<milestone>.md` | milestone packets with follow-ups and screenshots |
| `.loop/logs/guard.log` | one line per blocked action: time, item, phase, rule id, reason, what was refused |
| `.loop/retros/R-<n>.md` | the minutes of each retro (`data/R-<n>.md`: the numbers it was given, never committed) |
| `.loop/IMPEDIMENTS.md` | causes in the harness the retros reported, with status and example |
| `.loop/logs/NNN-<item>-<phase>.jsonl` | every session in full |
| `docs/contracts/<item>.md` | the contract each build wrote first (committed with its PR) |

The exact field names in `state.json` follow the runner version in this repo. Open the file and
read its keys before counting; never assume them.

## Committed files

| File | During the run |
|---|---|
| `docs/LESSONS.md` | lesson rows and "Keep doing" rows written by LEARN items |
| `docs/retros/R-<n>.md` | the minutes, filed by the LEARN item of each retro |
| `docs/DECISIONS.md` | small calls the loop made instead of asking |
| `loop/rules/project-rules.json` | rules added by LEARN items (add-only) |
| `loop/patches/*.patch` | runner changes the loop wanted but may not make |
| tests and CI checks | added by LEARN items; find them with `git log --grep LEARN` |

## Computing the metrics

| Metric | How |
|---|---|
| First-pass review | items approved in review round 1 ÷ items merged |
| Time per item | first build start to merge, from `PROGRESS.md`, median and mean |
| PR to merge | PR creation to merge, from `gh pr list --state merged --json createdAt,mergedAt` |
| Guard blocks by rule | count `guard.log` lines by rule id |
| Repeated failures | the `learn` counters in `state.json`: every signal with a count of 2 or more; `muted` names the impediment it was reported as |
| Did the fixes work | `retro.actions` in `state.json`: `status`, and for each the items built since it merged (`itemsSince`) and the ones the signal came back in (`hits`) |
| Held items | items whose phase was a hold phase, with the reason from `PROGRESS.md` |
