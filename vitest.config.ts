import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 60_000, hookTimeout: 120_000,
    pool: 'forks',
    env: { APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', FILE_SCAN: 'dev-skip' },
  },
});
