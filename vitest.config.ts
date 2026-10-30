import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setupEnv.ts'],
    // Integration tests share one throwaway database — run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
