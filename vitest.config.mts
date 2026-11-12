import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws unless the bundler resolves the `react-server` condition, which only
      // Next.js does. Vitest gets the same empty module Next uses, so server modules can be tested.
      'server-only': fileURLToPath(
        new URL('./node_modules/next/dist/compiled/server-only/empty.js', import.meta.url),
      ),
    },
  },
  test: {
    // `tests/e2e` is Playwright's; collecting it here would run browser specs in Node.
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
    // The JUnit report is the evidence `pnpm ac-trace --results artifacts/junit` reads in CI: an
    // AC counts only when a test case naming it ran and passed.
    reporters: ['default', ['junit', { outputFile: 'artifacts/junit/unit.xml' }]],
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Pages and layouts are markup that the e2e suite renders; unit coverage measures logic.
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/app/**/page.tsx',
        'src/app/**/layout.tsx',
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // The ratchet: a run that beats a threshold raises it in this file, and a run below it
      // fails. Commit the raised numbers with the change that earned them; never lower them.
      thresholds: {
        autoUpdate: true,
        lines: 97.22,
        functions: 96.55,
        branches: 97.67,
        statements: 97.5,
      },
    },
  },
});
