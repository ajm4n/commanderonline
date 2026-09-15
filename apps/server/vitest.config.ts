import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    // log.ts reads this at import time; keep the server quiet under test.
    env: { COMMANDER_QUIET: '1' },
  },
});
