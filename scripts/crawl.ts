/**
 * `pnpm crawl --region <name> [options]` (AL4 1.4.10; AC-59 .. AC-61): runs the Crawl Command
 * with the real transport and clock. Loads `.env` as defaults (the shell and the scheduler win),
 * turns SIGINT/SIGTERM into a Clean Stop, writes every output line to stdout and sets the exit
 * code from the Run Outcome. Never prints an env value.
 */
import { fileURLToPath } from 'node:url';
import { API_KEY_ENV, DATABASE_URL_ENV } from '../contracts/hydration.schema';
import { runCrawlCommand } from '../src/crawl/command';
import { applyEnvDefaults, readEnvFile } from './load-env';

applyEnvDefaults(readEnvFile(fileURLToPath(new URL('../.env', import.meta.url))));

const controller = new AbortController();
const abort = (): void => {
  controller.abort();
};
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const apiKey = process.env[API_KEY_ENV];
const databaseUrl = process.env[DATABASE_URL_ENV];
const env = {
  ...(apiKey !== undefined ? { [API_KEY_ENV]: apiKey } : {}),
  ...(databaseUrl !== undefined ? { [DATABASE_URL_ENV]: databaseUrl } : {}),
};

let exitCode: 0 | 1 = 1;
try {
  const result = await runCrawlCommand(process.argv.slice(2), {
    env,
    write,
    signal: controller.signal,
  });
  exitCode = result.exitCode;
} finally {
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
}
process.exitCode = exitCode;
