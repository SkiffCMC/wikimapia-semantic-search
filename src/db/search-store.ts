/**
 * Place Search Store (AL4 hybrid-search 1.4.8, 1.5; AC-39, AC-59, AC-60). Same pattern as the
 * Embedding Store: the query is validated before any DB access, then one read-only statement
 * runs on the parsed value. The factory never throws, opens no pool, and no method ever rejects:
 * every failure resolves `invalid_data` or `store_unavailable` with fixed text plus a safe code
 * only. From U3 on (decision D-EF) the pool is opened lazily per Search Mode, because the
 * connection options depend on the mode (`searchSessionOptions`, AL4 1.4.9).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import type { SearchMode, SearchResult } from '../../contracts/hybrid-search.schema';
import { StoreConfigSchema, type StoreFailure } from '../../contracts/storage.schema';
import { createDb, destroyQuietly } from './connection';
import { storeUnavailable, unavailableFrom } from './failures';
import { selectMatchingPlaces } from './place-search';
import { searchSessionOptions } from './search-session';
import type {
  PlaceSearchQuery,
  PlaceSearchStore,
  PlaceSearchStoreOptions,
  StoreResult,
} from './types';
import { validatePlaceSearchQuery } from './validate';

export const POOL_MAX_SEARCH = 1;

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const CLOSED_MESSAGE = 'Place Store unavailable: the store is closed';
const READ_BACK_FAILED_MESSAGE = 'Place Store unavailable: stored data failed the read-back check';
const UNEXPECTED_MESSAGE = 'Place Store unavailable: unexpected internal failure';
const ACTION = 'place search';

/** A search connection pool for one Search Mode, with that mode's session options. */
export function openSearchDb(connectionString: string, mode: SearchMode): Knex {
  return createDb(connectionString, POOL_MAX_SEARCH, searchSessionOptions(mode));
}

/**
 * A missing or blank (empty or whitespace-only) connection string is not configured; a
 * non-string value throws on `trim` and is caught as not configured too. No pool is opened here.
 */
function configuredConnection(options: PlaceSearchStoreOptions): string | undefined {
  try {
    if (options.connectionString.trim() === '') return undefined;
    const parsed = StoreConfigSchema.safeParse({ connectionString: options.connectionString });
    if (!parsed.success) return undefined;
    return parsed.data.connectionString;
  } catch {
    return undefined;
  }
}

function fail(failure: StoreFailure): { ok: false; failure: StoreFailure } {
  return { ok: false, failure };
}

function failureFor(error: unknown): StoreFailure {
  if (error instanceof z.ZodError) return storeUnavailable(READ_BACK_FAILED_MESSAGE);
  return unavailableFrom(error, ACTION);
}

function buildStore(connectionString: string | undefined): PlaceSearchStore {
  const pools = new Map<SearchMode, Knex>();
  let closed = false;

  function poolFor(configured: string, mode: SearchMode): Knex {
    const existing = pools.get(mode);
    if (existing !== undefined) return existing;
    const db = openSearchDb(configured, mode);
    pools.set(mode, db);
    return db;
  }

  async function search(query: PlaceSearchQuery): Promise<StoreResult<SearchResult[]>> {
    try {
      const validated = validatePlaceSearchQuery(query);
      if (!validated.ok) return fail(validated.failure);
      if (connectionString === undefined) return fail(storeUnavailable(NOT_CONFIGURED_MESSAGE));
      if (closed) return fail(storeUnavailable(CLOSED_MESSAGE));
      try {
        const db = poolFor(connectionString, validated.value.mode);
        return { ok: true, value: await selectMatchingPlaces(db, validated.value) };
      } catch (error) {
        return fail(failureFor(error));
      }
    } catch {
      return fail(storeUnavailable(UNEXPECTED_MESSAGE));
    }
  }

  async function close(): Promise<void> {
    try {
      closed = true;
      const open = [...pools.values()];
      pools.clear();
      await Promise.all(open.map((db) => destroyQuietly(db)));
    } catch {
      // Closing is best effort and never rejects.
    }
  }

  return { searchMatchingPlaces: search, close };
}

export function createPlaceSearchStore(options: PlaceSearchStoreOptions): PlaceSearchStore {
  try {
    return buildStore(configuredConnection(options));
  } catch {
    return buildStore(undefined);
  }
}
