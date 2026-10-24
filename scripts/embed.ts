/**
 * `pnpm embed [--limit <n>]` (AL4 embeddings 1.4.10; AC-49 .. AC-51): runs the Embed Command
 * with the real Voyage adapter and clock. Loads `.env` as defaults (the shell wins), turns
 * SIGINT/SIGTERM into an Operator interrupt, writes every output line to stdout and sets the
 * exit code from the Run Outcome. Never prints an env value.
 */
import { fileURLToPath } from 'node:url';
import { DATABASE_URL_ENV, VOYAGE_API_KEY_ENV } from '../contracts/embeddings.schema';
import { runEmbedCommand } from '../src/embed/command';
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

const apiKey = process.env[VOYAGE_API_KEY_ENV];
const databaseUrl = process.env[DATABASE_URL_ENV];
const env = {
  ...(apiKey !== undefined ? { [VOYAGE_API_KEY_ENV]: apiKey } : {}),
  ...(databaseUrl !== undefined ? { [DATABASE_URL_ENV]: databaseUrl } : {}),
};

let exitCode: 0 | 1 = 1;
try {
  const result = await runEmbedCommand(process.argv.slice(2), {
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
