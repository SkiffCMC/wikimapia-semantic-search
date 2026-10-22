/**
 * Crawl repository (internal; AL4 hydration 1.3, 1.4.7, 1.4.9, 1.5): the Run's database handle,
 * used only by `src/crawl/`. One Knex pool, one Run-wide write-hook counter shared by every write
 * step and Details Save, every method guarded so it never rejects. Same pattern as the Crawl
 * Store: the factory never throws; validated inputs are checked before any database access; a
 * not-configured repository resolves `store_unavailable`; every throw is mapped to a fixed
 * message plus a safe code (no error text is ever copied). No SQL here.
 */
import type { Knex } from 'knex';
import type { DuePlace, PlacesDueInput } from '../../contracts/hydration.schema';
import {
  StoreConfigSchema,
  type SavePlaceDetailsInput,
  type SaveReport,
  type StoreFailure,
  type WriteHook,
} from '../../contracts/storage.schema';
import { POOL_MAX_STORE, createDb, destroyQuietly } from './connection';
import {
  InvalidListingError,
  beginRunStep,
  finishRunStep,
  listingPageStep,
  renewActivityStep,
} from './crawl-progress';
import { storeUnavailable, unavailableFrom } from './failures';
import { countPlacesDue, selectPlacesDue } from './places-due';
import { saveDetails } from './save-details';
import type {
  BeginRunInput,
  BeginRunValue,
  CrawlRepository,
  CrawlRepositoryOptions,
  DueQuery,
  FinishInput,
  ListingStepInput,
  ListingStepValue,
  RenewInput,
  StoreResult,
  Validated,
} from './types';
import { validateDetailsInput, validatePlacesDueInput } from './validate';

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const UNEXPECTED_MESSAGE = 'Place Store unavailable: unexpected internal failure';

function openDb(options: CrawlRepositoryOptions): Knex | undefined {
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

function unchecked<I>(input: I): () => Validated<I> {
  return () => ({ ok: true, value: input });
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

function failureFor(action: string): (error: unknown) => StoreFailure {
  return (error) => unavailableFrom(error, action);
}

function listingFailure(error: unknown): StoreFailure {
  return error instanceof InvalidListingError
    ? error.failure
    : unavailableFrom(error, 'listing step');
}

/** One counter for the whole Run: the caller's hook sees 1, 2, 3, ... across every step. */
function runWideHook(onWrite: WriteHook | undefined): WriteHook | undefined {
  if (onWrite === undefined) return undefined;
  let n = 0;
  return async () => {
    n += 1;
    await onWrite(n);
  };
}

function buildRepository(db: Knex | undefined, hook: WriteHook | undefined): CrawlRepository {
  return {
    beginRun: (input: BeginRunInput): Promise<StoreResult<BeginRunValue>> =>
      guarded(
        db,
        unchecked(input),
        (conn, value) => beginRunStep(conn, value, hook),
        failureFor('run start'),
      ),
    renewActivity: (input: RenewInput): Promise<StoreResult<{ alive: boolean }>> =>
      guarded(
        db,
        unchecked(input),
        (conn, value) => renewActivityStep(conn, value, hook),
        failureFor('last activity renewal'),
      ),
    recordListingPage: (input: ListingStepInput): Promise<StoreResult<ListingStepValue>> =>
      guarded(
        db,
        unchecked(input),
        (conn, value) => listingPageStep(conn, value, hook),
        listingFailure,
      ),
    saveDetails: (input: SavePlaceDetailsInput): Promise<StoreResult<SaveReport>> =>
      guarded(
        db,
        () => validateDetailsInput(input),
        (conn, value) => saveDetails(conn, value, hook),
        failureFor('details save'),
      ),
    listPlacesDue: (query: DueQuery): Promise<StoreResult<DuePlace[]>> =>
      guarded(
        db,
        () => validatePlacesDueInput({ bbox: query.bbox, dueBefore: query.dueBefore }),
        (conn, value) =>
          selectPlacesDue(conn, {
            ...value,
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          }),
        failureFor('list places due'),
      ),
    countPlacesDue: (input: PlacesDueInput): Promise<StoreResult<number>> =>
      guarded(
        db,
        () => validatePlacesDueInput(input),
        (conn, value) => countPlacesDue(conn, value),
        failureFor('count places due'),
      ),
    finishRun: (input: FinishInput): Promise<StoreResult<{ updated: boolean }>> =>
      guarded(
        db,
        unchecked(input),
        (conn, value) => finishRunStep(conn, value, hook),
        failureFor('run finish'),
      ),
    close: () => destroyQuietly(db),
  };
}

export function openCrawlRepository(options: CrawlRepositoryOptions): CrawlRepository {
  try {
    return buildRepository(openDb(options), runWideHook(options.onWrite));
  } catch {
    return buildRepository(undefined, undefined);
  }
}
