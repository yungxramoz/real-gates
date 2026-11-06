# DESIGN.md template

Fill every section from the accepted mocks. Values are copied, not re-invented. Keep the file
under about 300 lines: it is read by every UI build session and by the reviewer.

## Contents

- Template
- Notes on each section

## Template

````markdown
# Design system

The accepted mocks in `design/mocks/accepted/` are the reference. The reviewer scores UI against
them and this file. When code and this file disagree, this file wins until it is changed in a PR.

## Idea
Two lines: what the design should feel like and why, in terms of the audience.

## Tokens
Defined once as CSS custom properties (in the app: the global stylesheet), used everywhere by name.

```css
:root {
  /* colour, by role */
  --color-bg: …;
  --color-surface: …;
  --color-text: …;
  --color-text-muted: …;
  --color-accent: …;
  --color-accent-text: …;   /* text on accent */
  --color-danger: …;
  --color-focus: …;
  /* type */
  --font-display: …;
  --font-text: …;
  /* space (one scale) */
  --space-1: …; --space-2: …; --space-3: …; --space-4: …; --space-5: …;
  /* shape */
  --radius-s: …; --radius-m: …;
  --border: 1px solid var(--color-text-muted);
}
```

### Contrast
| Text | Background | Ratio | Use |
|---|---|---|---|
| --color-text | --color-bg | …:1 | body |
| --color-accent-text | --color-accent | …:1 | primary button |

## Type scale
| Step | Size / line height | Weight | Font | Use |
|---|---|---|---|---|
| display | … | … | --font-display | page title |
| h2 | … | … | … | section |
| body | … | … | --font-text | text |
| small | … | … | … | meta, captions |

## Layout
Breakpoints, max content width, grid, spacing rules (which space step between what).

## Components
For each component in the mocks: purpose, anatomy, states (default, hover, focus, active,
disabled, error, loading), and which mock shows it.

### Button
…

### Form field
…

## Voice
How the product talks: person, tone, length. Three example lines from the mocks: a heading, a
button, an error message.

## Do and don't
| Do | Don't |
|---|---|
| … | … |
````

## Notes on each section

- **Tokens**: the exact `:root` of the final mock. Every token has a role name. Add a token only
  if a mock uses it.
- **Contrast**: compute each ratio (WCAG relative luminance) and write it down; a pair under 4.5:1
  for body text is a defect, not a style.
- **Type scale**: no more steps than the mocks use. Sizes in `rem` with the px value in brackets.
- **Components**: only what the mocks show. A component the loop needs later is added by screens
  mode, with a mock.
- **Do and don't**: concrete and checkable ("Primary button once per screen"), not taste
  ("Keep it clean").
