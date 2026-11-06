# Design system

<!--
  Written by /draft-design. It builds three contrasting directions as static HTML of the key
  screens (360 px and desktop), the owner picks or mixes, one refinement round follows, and the
  result lands here and in design/mocks/accepted/.
  The reviewer scores every UI item against this file and the accepted mocks: design quality,
  originality, craft, functionality, 1–10 each. Any score below review.minDesignScore blocks.
  Keep it concrete: values, not adjectives.
-->

## Direction

<!-- draft-design: two or three sentences. The feel, who it is for, and the one thing that makes it
not generic. Link the accepted mocks: design/mocks/accepted/<screen>.html -->

## Tokens

All tokens are CSS custom properties on `:root`, with a dark-mode override. Components use tokens,
never raw values.

```css
:root {
  /* draft-design: colour — surface, text, muted, accent, accent-text, border, focus, danger, success */
  /* draft-design: space — a scale, e.g. --space-1 … --space-8 */
  /* draft-design: radius, shadow, motion (duration + easing) */
}
```

| Token                 | Value | Use |
| --------------------- | ----- | --- |
| <!-- draft-design --> |       |     |

Contrast: text on every surface meets WCAG 2.2 AA (4.5:1, large text 3:1).

## Type scale

| Step                                                             | Size / line height | Weight | Use |
| ---------------------------------------------------------------- | ------------------ | ------ | --- |
| <!-- draft-design: display, h1, h2, h3, body, small, caption --> |                    |        |     |

Fonts: <!-- draft-design: families and how they load -->

## Layout

<!-- draft-design: mobile-first breakpoints, max content width, grid, the gutter at 360 px -->

## Components

Built on native HTML elements. Each one lists its states: default, hover, focus, active, disabled,
loading, error, empty.

| Component                                                                          | Element | Notes |
| ---------------------------------------------------------------------------------- | ------- | ----- |
| <!-- draft-design: button, link, input, select, card, list, dialog, toast, nav --> |         |       |

## Voice

<!-- draft-design: how the product talks. Tone, person, sentence length, how errors are phrased,
three example strings -->

## Do / don't

| Do                    | Don't |
| --------------------- | ----- |
| <!-- draft-design --> |       |

## Accepted mocks

The reviewer calibrates against these. A new screen without a mock follows the closest one.

<!-- draft-design: one line per file in design/mocks/accepted/ -->
