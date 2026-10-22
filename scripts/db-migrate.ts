/**
 * `pnpm db:migrate [--test]` (AL4 1.1, 2.7): applies pending Schema Setup steps to
 * `DATABASE_URL` (or `TEST_DATABASE_URL` with `--test`). Contains no SQL; goes through
 * `createSchemaSetup` only. Never prints a connection string, password or env value.
 */
import { fileURLToPath } from 'node:url';
import { DATABASE_URL_ENV, TEST_DATABASE_URL_ENV } from '../contracts/storage.schema';
import { createSchemaSetup } from '../src/db/schema-setup';
import { applyEnvDefaults, readEnvFile } from './load-env';

const useTest = process.argv.slice(2).includes('--test');
const envName = useTest ? TEST_DATABASE_URL_ENV : DATABASE_URL_ENV;
const envFile = useTest ? '.env.test' : '.env';

applyEnvDefaults(readEnvFile(fileURLToPath(new URL(`../${envFile}`, import.meta.url))));
const connectionString = process.env[envName];

if (connectionString === undefined || connectionString === '') {
  process.stderr.write(`${envName} is not set\n`);
  process.exitCode = 1;
} else {
  const setup = createSchemaSetup({ connectionString });
  try {
    const result = await setup.apply();
    if (result.ok) {
      const { steps } = result.value;
      if (steps.length === 0) process.stdout.write('No pending steps.\n');
      for (const step of steps) process.stdout.write(`Applied ${step}\n`);
      process.stdout.write(`${String(steps.length)} step(s) applied.\n`);
    } else {
      process.stderr.write(`${result.failure.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    await setup.close();
  }
}
