/**
 * AL2 unit tests: `src/db/connection.ts` (AL4 1.3 `connection.ts` block, 1.4.2 Connection,
 * AL3 U2 additions `parseSafeInt8` and `selectBigint`).
 *
 * Uses the Test Database from `requireTestDatabaseUrl()` (TEST_DATABASE_URL via .env.test) and
 * the contract's unreachable URL (nothing listens on 127.0.0.1:1). The test issues no SQL of its
 * own: the only query is `selectBigint` from `src/db/connection.ts`. Every Knex instance created
 * here is released through `destroyQuietly`.
 */
import type { Knex } from 'knex';
import {
  ACQUIRE_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  POOL_MAX_SETUP,
  POOL_MAX_STORE,
  STATEMENT_TIMEOUT_MS,
  createDb,
  destroyQuietly,
  parseSafeInt8,
  selectBigint,
} from '../../src/db/connection';
import { UNREACHABLE_DATABASE_URL, requireTestDatabaseUrl } from '../../contracts/storage.support';

const created: Knex[] = [];

function track(db: Knex): Knex {
  created.push(db);
  return db;
}

afterEach(async () => {
  for (const db of created.splice(0)) await destroyQuietly(db);
});

/** `error.code`, or `error.cause.code` when the former is absent. */
function codeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = Reflect.get(error, 'code');
  if (code !== undefined) return code;
  const cause: unknown = Reflect.get(error, 'cause');
  if (typeof cause !== 'object' || cause === null) return undefined;
  return Reflect.get(cause, 'code') as unknown;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

// ---------------------------------------------------------------------------
// 1. parseSafeInt8 (pure)
// ---------------------------------------------------------------------------

describe('parseSafeInt8', () => {
  it('parses the largest safe integer', () => {
    expect(parseSafeInt8('9007199254740991')).toBe(9007199254740991);
  });

  it('parses a negative value', () => {
    expect(parseSafeInt8('-42')).toBe(-42);
  });

  it('rejects an unsafe integer', () => {
    expect(() => parseSafeInt8('9007199254740993')).toThrow('int8 value is not a safe integer');
  });
});

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

describe('connection constants', () => {
  it('match AL4 1.3', () => {
    expect(POOL_MAX_STORE).toBe(4);
    expect(POOL_MAX_SETUP).toBe(1);
    expect(CONNECT_TIMEOUT_MS).toBe(5000);
    expect(ACQUIRE_TIMEOUT_MS).toBe(10000);
    expect(STATEMENT_TIMEOUT_MS).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// 3. Unreachable server (AC-57)
// ---------------------------------------------------------------------------

describe('createDb on an unreachable server', () => {
  it('does not throw on creation', () => {
    expect(() => track(createDb(UNREACHABLE_DATABASE_URL, POOL_MAX_STORE))).not.toThrow();
  });

  it('selectBigint rejects with ECONNREFUSED', async () => {
    const db = track(createDb(UNREACHABLE_DATABASE_URL, POOL_MAX_STORE));
    const error = await rejectionOf(selectBigint(db, '1'));
    expect(codeOf(error)).toBe('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// 4. Test Database: the per-connection int8 parser
// ---------------------------------------------------------------------------

describe('createDb on the Test Database', () => {
  it('selectBigint returns the largest safe int8 as a JS number', async () => {
    const db = track(createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP));
    const value = await selectBigint(db, '9007199254740991');
    expect(typeof value).toBe('number');
    expect(value).toBe(9007199254740991);
  });

  it('selectBigint returns a small negative int8 as a JS number', async () => {
    const db = track(createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP));
    expect(await selectBigint(db, '-42')).toBe(-42);
  });

  it('selectBigint rejects an unsafe int8', async () => {
    const db = track(createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP));
    await expect(selectBigint(db, '9007199254740993')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. destroyQuietly
// ---------------------------------------------------------------------------

describe('destroyQuietly', () => {
  it('resolves for undefined', async () => {
    await expect(destroyQuietly(undefined)).resolves.toBeUndefined();
  });

  it('resolves twice on the same used instance', async () => {
    const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
    expect(await selectBigint(db, '1')).toBe(1);
    await expect(destroyQuietly(db)).resolves.toBeUndefined();
    await expect(destroyQuietly(db)).resolves.toBeUndefined();
  });

  it('resolves twice on an unreachable, never connected instance', async () => {
    const db = createDb(UNREACHABLE_DATABASE_URL, POOL_MAX_STORE);
    await expect(destroyQuietly(db)).resolves.toBeUndefined();
    await expect(destroyQuietly(db)).resolves.toBeUndefined();
  });
});
