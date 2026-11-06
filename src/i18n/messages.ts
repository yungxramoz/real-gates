/**
 * Every user-facing string, in one place. Components read from here and never hard-code text, so
 * copy can be reviewed, changed or translated in one file.
 *
 * Add a locale by copying this object into a sibling module with the same shape
 * (`satisfies Messages` keeps it complete) and choosing it in `src/app/layout.tsx`.
 */

export const messages = {
  meta: {
    lang: 'en',
    siteName: 'New project',
    title: 'New project',
    description: 'A fresh project, started from the real-gates template.',
  },
  a11y: {
    skipToContent: 'Skip to content',
  },
  home: {
    eyebrow: 'Ready to build',
    title: 'Your project starts here',
    lead: 'This placeholder page is served by a production build with every gate already running. Replace it with the first screen of your product.',
    checksHeading: 'What is already in place',
    checks: [
      {
        name: 'Health endpoint',
        detail: '/api/health reports the deployed commit and whether the database answers.',
      },
      {
        name: 'Quality gates',
        detail: 'Lint, typecheck, unit tests with a coverage ratchet, build and e2e with axe.',
      },
      {
        name: 'Traceability',
        detail: 'Every acceptance criterion in docs/REQUIREMENTS.md needs a test that names it.',
      },
    ],
    nextHeading: 'Next step',
    next: 'Describe what you are building in docs/BRIEF.md, then shape the backlog.',
  },
} as const;

export type Messages = typeof messages;
