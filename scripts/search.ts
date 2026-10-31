/**
 * `pnpm run search "<Query Text>" [options]` (AL4 hybrid-search 1.4.7; AC-41 .. AC-45, AC-72;
 * `pnpm run search -- <args>` works too): runs the Search Command with the real Voyage query
 * adapter. Loads `.env` as defaults (the shell wins), writes every output line to stdout and
 * sets the exit code. Never prints an env value.
 */
import { fileURLToPath } from 'node:url';
import { DATABASE_URL_ENV, VOYAGE_API_KEY_ENV } from '../contracts/hybrid-search.schema';
import { runSearchCommand } from '../src/search/command';
import { applyEnvDefaults, readEnvFile } from './load-env';

applyEnvDefaults(readEnvFile(fileURLToPath(new URL('../.env', import.meta.url))));

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const apiKey = process.env[VOYAGE_API_KEY_ENV];
const databaseUrl = process.env[DATABASE_URL_ENV];
const env = {
  ...(apiKey !== undefined ? { [VOYAGE_API_KEY_ENV]: apiKey } : {}),
  ...(databaseUrl !== undefined ? { [DATABASE_URL_ENV]: databaseUrl } : {}),
};

const result = await runSearchCommand(process.argv.slice(2), { env, write });
process.exitCode = result.exitCode;
