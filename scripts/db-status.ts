/**
 * `pnpm db:status [--test]` (AL4 1.1, 2.7): prints applied and pending Schema Setup steps and
 * the enabled extensions of `DATABASE_URL` (or `TEST_DATABASE_URL` with `--test`). Contains
 * no SQL; goes through `createSchemaSetup` only. Never prints a connection string, password
 * or env value.
 */
import { fileURLToPath } from 'node:url';
import { DATABASE_URL_ENV, TEST_DATABASE_URL_ENV } from '../contracts/storage.schema';
import { createSchemaSetup } from '../src/db/schema-setup';
import { applyEnvDefaults, readEnvFile } from './load-env';

const useTest = process.argv.slice(2).includes('--test');
const envName = useTest ? TEST_DATABASE_URL_ENV : DATABASE_URL_ENV;
const envFile = useTest ? '.env.test' : '.env';

function list(label: string, items: readonly string[]): void {
  process.stdout.write(`${label}:${items.length === 0 ? ' (none)' : ''}\n`);
  for (const item of items) process.stdout.write(`  ${item}\n`);
}

applyEnvDefaults(readEnvFile(fileURLToPath(new URL(`../${envFile}`, import.meta.url))));
const connectionString = process.env[envName];

if (connectionString === undefined || connectionString === '') {
  process.stderr.write(`${envName} is not set\n`);
  process.exitCode = 1;
} else {
  const setup = createSchemaSetup({ connectionString });
  try {
    const result = await setup.inspect();
    if (result.ok) {
      list('Applied steps', result.value.appliedSteps);
      list('Pending steps', result.value.pendingSteps);
      list('Enabled extensions', result.value.enabledExtensions);
    } else {
      process.stderr.write(`${result.failure.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    await setup.close();
  }
}
