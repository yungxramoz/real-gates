---
name: draft-design
description: Drafts the visual design before the loop writes UI code. Builds three contrasting design directions as static HTML mocks of the two or three key screens, screenshots them at phone and desktop width, lets the owner pick or mix, runs one refinement round, then writes DESIGN.md (tokens as CSS custom properties, type scale, components, voice, do and don't) and design/mocks/accepted/, which the loop's reviewer scores against. Use when there is no DESIGN.md yet, when the owner asks for a design direction, mockups, a style guide, a look and feel or a design system, or with "screens" and an epic ID to prototype an epic's screens before the loop builds them.
disable-model-invocation: true
argument-hint: "[screens <epic>]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/shoot.mjs"*)
---

# Draft the design

The accepted mocks are the bar: the loop's reviewer scores every UI item against
`design/mocks/accepted/` and `DESIGN.md`, and any score below `review.minDesignScore` blocks the
merge. Generic is a defect; clarity breaks ties.

## Mode

- No argument → **direction mode** (below): the first design of the project.
- `screens <epic>` → **screens mode**: [reference/screens-mode.md](reference/screens-mode.md).
  Needs an accepted `DESIGN.md`; if there is none, say so and run direction mode first.

## Rules

1. **One question at a time**, with a recommended answer. If nobody can answer (a headless `-p`
   session), stop and change nothing.
2. **Static, self-contained HTML.** One file per screen, CSS inline in a `<style>` block, design
   tokens as CSS custom properties on `:root`, no JavaScript framework, no external images. System
   fonts or one web font per direction.
3. **Real content.** Text, names and numbers come from `docs/BRIEF.md` and `docs/REQUIREMENTS.md`.
   No lorem ipsum, no placeholder grey boxes where content belongs.
4. **Phone first.** Every screen works at 360 px without horizontal scroll; then it uses the room at
   1280 px instead of stretching.
5. **Accessible.** Text contrast at least 4.5:1 (3:1 for large text and UI borders), visible focus,
   touch targets at least 44 px, semantic elements.
6. **Own brand only.** No third-party logos, characters or artwork unless `CLAUDE.md` allows them.
7. Ask before deleting anything.

## Workflow

```
Design progress:
- [ ] 1. Read the brief, requirements and any brand rules
- [ ] 2. Agree on the key screens and the feel
- [ ] 3. Build three contrasting directions
- [ ] 4. Shoot: run shoot.mjs, look at every PNG, fix, repeat
- [ ] 5. Show the directions side by side; owner picks or mixes
- [ ] 6. One refinement round (build, shoot, show)
- [ ] 7. Accept: design/mocks/accepted/ and DESIGN.md
- [ ] 8. Check DESIGN.md against the accepted mocks
- [ ] 9. Hand off
```

### 1. Read

`docs/BRIEF.md`, `docs/REQUIREMENTS.md`, `CLAUDE.md` (brand and content rules), an existing
`DESIGN.md` if any. If `DESIGN.md` already has accepted tokens, ask whether to start over or use
screens mode; recommend screens mode.

### 2. Screens and feel

Ask, one at a time:

1. Which two or three screens? Recommend: the screen most visitors land on, the screen of the core
   action (a form, a booking), and the densest screen (a list, a table, an admin view).
2. Three words for how it should feel, and one site or app they like. Recommend words from the
   brief's audience.

### 3. Three directions

Build `design/mocks/directions/<a|b|c>-<slug>/<screen>.html` for every screen. The three must
differ on at least three axes (type, colour, density, shape, layout, imagery), so the owner sees a
real choice, not three shades of one idea. How to make them contrast and avoid the generic look:
[reference/directions.md](reference/directions.md).

### 4. Shoot

```bash
node "${CLAUDE_SKILL_DIR}/scripts/shoot.mjs" design/mocks/directions
```

It writes a 360 px and a 1280 px full-page PNG per screen into each direction's `shots/` folder
and names every page with horizontal overflow or console errors. Open each PNG and look at it:
hierarchy, spacing, alignment, contrast, broken wrapping. Fix the HTML and run it again until it
prints no `PROBLEM` and the screenshots look intentional at both widths.

If it says Playwright is not installed, ask before running the install command it prints.

### 5. Show and choose

Write `design/mocks/directions/index.html`: one column per direction, its 360 px and 1280 px shots
of each screen as `<img>` tags, and two lines on its idea. Ask the owner to open it (or show the
PNGs directly). Then one question: "Which one, or which parts of which?" Recommend one direction and
say why in terms of the brief.

### 6. Refine once

Build the chosen or mixed direction as `design/mocks/directions/final/`, apply the feedback, run
step 4 on it, show it. One round; small follow-ups go in as notes in `DESIGN.md`.

### 7. Accept

1. Copy the final screens to `design/mocks/accepted/<screen>.html` and their shots to
   `design/mocks/accepted/shots/`.
2. Write `DESIGN.md` from [reference/design-md-template.md](reference/design-md-template.md):
   tokens copied exactly from the final `:root`, the type scale, components used in the mocks,
   voice, do and don't.
3. Ask whether to delete `design/mocks/directions/`; recommend deleting it, since the accepted
   mocks are the record.

### 8. Check

- Every `var(--…)` used in the accepted mocks is defined in `DESIGN.md`, and every token in
  `DESIGN.md` is used or marked as reserved.
- Every text and background pair in `DESIGN.md` lists its contrast ratio, and each meets rule 5.
- Run `node "${CLAUDE_SKILL_DIR}/scripts/shoot.mjs" design/mocks/accepted` once more: no `PROBLEM`.

### 9. Hand off

Show the accepted shots side by side, list the files written, and propose committing them on a
branch `design/direction` with a PR into the base branch; wait for a yes before `git push`.
