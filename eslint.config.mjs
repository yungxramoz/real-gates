import next from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier';

/**
 * Secret containment is enforced here, not by review discipline: the server-only keys may only be
 * read in `src/lib/env.ts`, which validates them and hands out what a caller needs. Everything
 * else asks `serverEnv()`. CI's bundle guard is the second half: it builds with sentinel keys and
 * fails if one of them reaches `.next/static`.
 *
 * Add a key to SERVER_ONLY_KEYS when you add one to `.env.example`.
 */
const SERVER_ONLY_KEYS = ['SUPABASE_SECRET_KEY', 'EMAIL_API_KEY'];

function restrictEnvRead(name) {
  const message = `${name} is server-only. Read it through serverEnv() in src/lib/env.ts.`;
  return [
    {
      selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.name='${name}']`,
      message,
    },
    {
      selector: `MemberExpression[object.object.name='process'][object.property.name='env'][property.value='${name}']`,
      message,
    },
  ];
}

const config = [
  {
    // `loop/` is the runner (Node built-ins, its own `node --test` suite) and `.loop/` is its
    // git-ignored runtime state. `.claude/` holds the setup skills and their validators. All three
    // are protected paths that loop sessions cannot edit, so a lint gate on them would be a red
    // check no session could fix.
    ignores: [
      '.next/**',
      'artifacts/**',
      'coverage/**',
      'node_modules/**',
      // another stack's skeleton, copied as it is by scripts/apply-preset.mjs
      'presets/**',
      'test-results/**',
      'playwright-report/**',
      '**/*.d.ts',
      'loop/**',
      '.loop/**',
      '.claude/**',
    ],
  },
  ...next,
  prettier,
  {
    name: 'project/rules',
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error', ...SERVER_ONLY_KEYS.flatMap(restrictEnvRead)],
    },
  },
  {
    name: 'project/env-owner',
    files: ['src/lib/env.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    name: 'project/tooling',
    files: ['*.mjs', '*.mts', '*.config.ts', 'scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
];

export default config;
