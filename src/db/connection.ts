/**
 * Connection factory (AL4 1.4.2): one Knex instance per connection string, with pool limits,
 * timeouts and a per-connection int8 parser that rejects unsafe integers. Creating an instance
 * never connects; the first query does.
 */
import knex from 'knex';
import type { Knex } from 'knex';
import pg from 'pg';
import { z } from 'zod';
import { BigintProbeRowSchema } from './rows';

export const POOL_MAX_STORE = 4;
export const POOL_MAX_SETUP = 1;
export const CONNECT_TIMEOUT_MS = 5_000;
export const ACQUIRE_TIMEOUT_MS = 10_000;
export const STATEMENT_TIMEOUT_MS = 30_000;

const BigintProbeResultSchema = z.object({ rows: z.array(BigintProbeRowSchema) });

export function parseSafeInt8(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error('int8 value is not a safe integer');
  return n;
}

/** Per-connection parser lookup; `oid` is pg's builtin type id (any number the server sends). */
function getTypeParser(oid: Parameters<typeof pg.types.getTypeParser>[0], format: string): unknown {
  if (oid === pg.types.builtins.INT8) return parseSafeInt8;
  return format === 'binary'
    ? pg.types.getTypeParser(oid, 'binary')
    : pg.types.getTypeParser(oid, 'text');
}

export function createDb(connectionString: string, poolMax: number, sessionOptions?: string): Knex {
  const connection: Knex.PgConnectionConfig = {
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    types: { getTypeParser },
    ...(sessionOptions !== undefined ? { options: sessionOptions } : {}),
  };
  return knex({
    client: 'pg',
    connection,
    pool: { min: 0, max: poolMax },
    acquireConnectionTimeout: ACQUIRE_TIMEOUT_MS,
  });
}

export async function destroyQuietly(db: Knex | undefined): Promise<void> {
  if (db === undefined) return;
  try {
    await db.destroy();
  } catch {
    // Closing is best effort: a failed or repeated destroy is not an error for the caller.
  }
}

/** Round-trips one int8 value through the server (parameterized; the value is a binding). */
export async function selectBigint(db: Knex, value: string): Promise<number> {
  const result: unknown = await db.raw('select ?::bigint as value', [value]);
  const row = BigintProbeResultSchema.parse(result).rows[0];
  if (row === undefined) throw new Error('select bigint returned no row');
  return row.value;
}
