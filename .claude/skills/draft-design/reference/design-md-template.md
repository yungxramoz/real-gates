# DESIGN.md template

Fill every section from the accepted mocks. Values are copied, not re-invented. Keep the file
under about 300 lines: it is read by every UI build session and by the reviewer. The project
already has a `DESIGN.md` skeleton with the same sections and `draft-design` comments: replace it
whole, and leave no `draft-design` comment behind.

## Contents

- Template
- Notes on each section

## Template

````markdown
# Design system

The accepted mocks in `design/mocks/accepted/` are the reference. The reviewer scores UI against
them and this file. When code and this file disagree, this file wins until it is changed in a PR.

## Direction
Two or three sentences: what the design should feel like and why, in terms of the audience, and
the one thing that makes it not generic.

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
@media (prefers-color-scheme: dark) {
  :root {
    /* the colour tokens again, for dark mode; contrast checked like the light ones */
  }
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

## Do / don't
| Do | Don't |
|---|---|
| … | … |

## Accepted mocks
The reviewer calibrates against these. A new screen without a mock follows the closest one.

- `design/mocks/accepted/<screen>.html`: what it shows
````

## Notes on each section

- **Tokens**: the exact `:root` of the final mock. Every token has a role name. Add a token only
  if a mock uses it.
- **Contrast**: compute each ratio (WCAG relative luminance) and write it down; a pair under 4.5:1
  for body text is a defect, not a style.
- **Type scale**: no more steps than the mocks use. Sizes in `rem` with the px value in brackets.
- **Components**: only what the mocks show. A component the loop needs later is added by screens
  mode, with a mock.
- **Do / don't**: concrete and checkable ("Primary button once per screen"), not taste
  ("Keep it clean").
