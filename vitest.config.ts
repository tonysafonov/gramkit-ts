import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/server/**/*.test.ts', 'bench/**/*.test.ts'],
    globalSetup: ['src/server/testing/global-setup.ts'],
    setupFiles: ['src/server/testing/setup.ts'],
    env: { ENV_FILE: '.env.test' },
    pool: 'forks',
    hookTimeout: 30_000,
  },
});
