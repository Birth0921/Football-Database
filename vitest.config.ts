import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // shared PostgreSQL/Redis state → run files sequentially
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
