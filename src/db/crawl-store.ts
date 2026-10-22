/**
 * Crawl Store (public entry point; AL4 hydration 1.4.11, 1.5 "Reads", "Places due list/count"):
 * Places Due for Details of a bbox and the Crawl Progress of a Region. Same pattern as the Place
 * Store: the factory never throws, every method validates its input before any database access,
 * then refuses when not configured, runs the read, gates the value with its contract schema and
 * maps every throw to a fixed message. No method ever rejects.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  CrawlProgressViewSchema,
  PlacesDueValueSchema,
  type CrawlProgressInput,
  type CrawlProgressResult,
  type CrawlStore,
  type CrawlStoreOptions,
  type CreateCrawlStoreFn,
  type PlacesDueInput,
  type PlacesDueResult,
} from '../../contracts/hydration.schema';
import { StoreConfigSchema, type StoreFailure } from '../../contracts/storage.schema';
import { POOL_MAX_STORE, createDb, destroyQuietly } from './connection';
import { readProgressView } from './crawl-progress';
import { storeUnavailable, unavailableFrom } from './failures';
import { READ_TRANSACTION_CONFIG } from './place-store';
import { selectPlacesDue } from './places-due';
import type { StoreResult, Validated } from './types';
import { validateCrawlProgressInput, validatePlacesDueInput } from './validate';

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const READ_BACK_FAILED_MESSAGE = 'Place Store unavailable: stored data failed the read-back check';
const UNEXPECTED_MESSAGE = 'Place Store unavailable: unexpected internal failure';

function openDb(options: CrawlStoreOptions): Knex | undefined {
  try {
    const parsed = StoreConfigSchema.safeParse({ connectionString: options.connectionString });
    if (!parsed.success) return undefined;
    return createDb(parsed.data.connectionString, POOL_MAX_STORE);
  } catch {
    return undefined;
  }
}

function fail(failure: StoreFailure): { ok: false; failure: StoreFailure } {
  return { ok: false, failure };
}

function readFailure(action: string): (error: unknown) => StoreFailure {
  return (error) =>
    error instanceof z.ZodError
      ? storeUnavailable(READ_BACK_FAILED_MESSAGE)
      : unavailableFrom(error, action);
}

/** Validate (no DB on `invalid_data`), refuse when not configured, run, map any throw. */
async function guarded<I, T>(
  db: Knex | undefined,
  validate: () => Validated<I>,
  operation: (db: Knex, value: I) => Promise<T>,
  toFailure: (error: unknown) => StoreFailure,
): Promise<StoreResult<T>> {
  try {
    const validated = validate();
    if (!validated.ok) return fail(validated.failure);
    if (db === undefined) return fail(storeUnavailable(NOT_CONFIGURED_MESSAGE));
    try {
      return { ok: true, value: await operation(db, validated.value) };
    } catch (error) {
      return fail(toFailure(error));
    }
  } catch {
    return fail(storeUnavailable(UNEXPECTED_MESSAGE));
  }
}

function buildStore(db: Knex | undefined): CrawlStore {
  return {
    listPlacesDueForDetails: (input: PlacesDueInput): Promise<PlacesDueResult> =>
      guarded(
        db,
        () => validatePlacesDueInput(input),
        async (conn, value) => {
          const places = await selectPlacesDue(conn, { bbox: value.bbox, dueBefore: value.dueBefore });
          return PlacesDueValueSchema.parse({ places });
        },
        readFailure('list places due'),
      ),
    readCrawlProgress: (input: CrawlProgressInput): Promise<CrawlProgressResult> =>
      guarded(
        db,
        () => validateCrawlProgressInput(input),
        async (conn, value) => {
          const view = await conn.transaction(
            (trx) => readProgressView(trx, value.regionName),
            READ_TRANSACTION_CONFIG,
          );
          return CrawlProgressViewSchema.parse(view);
        },
        readFailure('read crawl progress'),
      ),
    close: () => destroyQuietly(db),
  };
}

export const createCrawlStore: CreateCrawlStoreFn = (options) => {
  try {
    return buildStore(openDb(options));
  } catch {
    return buildStore(undefined);
  }
};
