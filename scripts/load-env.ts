/**
 * Minimal `.env`-style file loading (AL4 2.7 "`scripts/load-env.ts`").
 *
 * Never prints values. Shell and CI values always win over file values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const EnvRecordSchema = z.record(z.string(), z.string());

/** Parses an env file into key/value pairs; returns `{}` when the file does not exist. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  return EnvRecordSchema.parse(parseEnv(readFileSync(path, 'utf8')));
}

/** Sets each key on `process.env` only when it is unset or empty. */
export function applyEnvDefaults(record: Record<string, string>): void {
  for (const [key, value] of Object.entries(record)) {
    const current = process.env[key];
    if (current === undefined || current === '') {
      process.env[key] = value;
    }
  }
}
