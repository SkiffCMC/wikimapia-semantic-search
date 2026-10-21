import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['contracts/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
