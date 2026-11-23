// Which unit tests run, where their report goes and how much of the code they must cover. A pull
// request may change this file only by raising the coverage thresholds: the loop refuses any
// other change. vite.config.ts imports it and passes it on as it is (scripts/check-gates.mjs).
import type { UserConfig } from 'vite-plus';

export default {
  include: ['src/**/*.test.{ts,tsx}'],
  reporters: ['default', ['junit', { outputFile: 'artifacts/junit/unit.xml' }]],
  coverage: {
    provider: 'v8',
    include: ['src/**'],
    exclude: ['src/**/*.test.{ts,tsx}'],
    thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
  },
} satisfies NonNullable<UserConfig['test']>;
