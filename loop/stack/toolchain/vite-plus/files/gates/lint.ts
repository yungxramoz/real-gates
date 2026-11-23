// The lint rules and the type check. A pull request may not change this file: the loop refuses
// one that does. vite.config.ts imports it and passes it on as it is (scripts/check-gates.mjs).
import type { UserConfig } from 'vite-plus';

export default {
  options: { typeAware: true, typeCheck: true },
  categories: { correctness: 'error', suspicious: 'error' },
  rules: {
    'no-debugger': 'error',
    eqeqeq: 'error',
  },
} satisfies NonNullable<UserConfig['lint']>;
