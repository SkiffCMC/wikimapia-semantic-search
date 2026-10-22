import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readEnvFile } from './scripts/load-env';

const fileEnv = readEnvFile(fileURLToPath(new URL('.env.test', import.meta.url)));
const testEnv = Object.fromEntries(
  Object.entries(fileEnv).filter(([key]) => {
    const current = process.env[key];
    return current === undefined || current === '';
  }),
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['contracts/**/*.test.ts', 'tests/**/*.test.ts'],
    env: testEnv,
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
