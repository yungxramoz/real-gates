# Making three directions that really differ

## Contents

- Axes of contrast
- A worked set of three
- Mock file skeleton
- The generic look, and how to avoid it
- What to look at in the screenshots

## Axes of contrast

Each direction picks one end or the middle of at least three axes. Write the picks down as the
direction's two-line idea before building it.

| Axis | One end | Other end |
|---|---|---|
| Type | one grotesque, tight, all weights | a serif display face with a quiet text face |
| Colour | near-monochrome with one accent | two or three saturated brand colours |
| Density | airy, one idea per screen | compact, information first |
| Shape | sharp corners, hairlines | soft radii, filled surfaces |
| Layout | strict grid, aligned edges | editorial, asymmetric, large type breaks the grid |
| Imagery | type and colour only | illustration, pattern or photography (own assets only) |
| Motion | none | small, purposeful transitions (described, not built) |

## A worked set of three

For an event sign-up site:

- **A Poster**: big condensed display type, black and one signal colour, strict grid, sharp
  corners. Feels like a gig poster.
- **B Club newsletter**: serif headings, warm off-white paper, generous spacing, soft cards, small
  illustrations in two colours.
- **C Dashboard**: compact grotesque, cool neutrals with status colours, dense lists, every number
  visible above the fold.

Same content, same screens, three clearly different answers.

## Mock file skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Event page — direction A</title>
<style>
  :root {
    --color-bg: #ffffff;
    --color-text: #111111;
    --color-accent: #e4002b;
    --font-display: "Archivo Narrow", system-ui, sans-serif;
    --font-text: system-ui, sans-serif;
    --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 40px;
    --radius: 0;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: var(--color-bg); color: var(--color-text); font-family: var(--font-text); }
  img, svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
  <main>…</main>
</body>
</html>
```

Name tokens by role (`--color-surface`, `--color-text-muted`), not by value (`--red`). Use the
same token names in all three directions so a mix is a matter of swapping values.

## The generic look, and how to avoid it

A mock looks generic when it could be any product. Signs and fixes:

| Sign | Fix |
|---|---|
| centred hero, gradient blob, three feature cards | lead with the real content of the core journey |
| one sans-serif at one weight everywhere | a type scale with real contrast in size and weight |
| grey on grey, timid accent | a palette with a clear role for each colour |
| stock icons in circles | fewer icons; type, numbers and layout carry the meaning |
| every block in a rounded card with a shadow | let alignment and space group things; cards only for real objects |
| "Lorem ipsum", "Feature one" | the brief's real words and plausible data |

## What to look at in the screenshots

At 360 px: nothing cut off or scrolled sideways, buttons reachable with a thumb, the primary action
visible without scrolling on the core-action screen, long words and numbers wrap.

At 1280 px: the layout uses the width (columns, side panels) instead of a stretched phone column;
line length for text stays readable (about 60 to 80 characters).

Both: one clear focal point per screen, consistent spacing steps, alignment to a grid, enough
contrast, states shown where they matter (empty, error, full).
