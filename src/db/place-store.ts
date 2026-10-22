/**
 * Place Store (public entry point; AL4 1.2, 1.4.1, 1.4.8, 1.5): validates every input before
 * any DB access, then runs the save or read on the parsed value only. The factory never throws
 * and no method ever rejects: every failure resolves `invalid_data` or `store_unavailable`
 * without secrets, error messages or input values (AC-51, AC-53 .. AC-58).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { StoreConfigSchema } from '../../contracts/storage.schema';
import type {
  CreatePlaceStoreFn,
  PlaceStore,
  PlaceStoreOptions,
  PlaceRefInput,
  ReadPlaceResult,
  ReadShapesResult,
  SaveResult,
  SaveListingPageInput,
  SavePlaceDetailsInput,
  StoreCountsResult,
  StoreFailure,
  StoredCommentKeysResult,
  TagCatalogueResult,
  PlaceTagLinksResult,
  TagRefInput,
  WriteHook,
} from '../../contracts/storage.schema';
import { POOL_MAX_STORE, createDb, destroyQuietly } from './connection';
import { storeUnavailable, unavailableFrom } from './failures';
import {
  countAll,
  listCommentKeys,
  listLinksOfTag,
  listTagCatalogue,
  readPlaceValue,
  readShapesValue,
} from './read';
import { saveDetails } from './save-details';
import { saveListing } from './save-listing';
import type { StoreResult, Validated } from './types';
import { validateDetailsInput, validateListingInput, validatePlaceRef, validateTagRef } from './validate';

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const READ_BACK_FAILED_MESSAGE = 'Place Store unavailable: stored data failed the read-back check';
const UNEXPECTED_MESSAGE = 'Place Store unavailable: unexpected internal failure';

/** Multi-query reads see one consistent snapshot and never write (AL4 1.5). */
export const READ_TRANSACTION_CONFIG: Knex.TransactionConfig = {
  isolationLevel: 'repeatable read',
  readOnly: true,
};

function openDb(options: PlaceStoreOptions): Knex | undefined {
  try {
    const parsed = StoreConfigSchema.safeParse({ connectionString: options.connectionString });
    if (!parsed.success) return undefined;
    return createDb(parsed.data.connectionString, POOL_MAX_STORE);
  } catch {
    return undefined;
  }
}

function readHook(options: PlaceStoreOptions): WriteHook | undefined {
  try {
    return options.onWrite;
  } catch {
    return undefined;
  }
}

function fail(failure: StoreFailure): { ok: false; failure: StoreFailure } {
  return { ok: false, failure };
}

function saveFailure(action: string): (error: unknown) => StoreFailure {
  return (error) => unavailableFrom(error, action);
}

function readFailure(action: string): (error: unknown) => StoreFailure {
  return (error) =>
    error instanceof z.ZodError
      ? storeUnavailable(READ_BACK_FAILED_MESSAGE)
      : unavailableFrom(error, action);
}

/**
 * AL4 1.2 steps 1 .. 5: validate (no DB on `invalid_data`), refuse when not configured, run the
 * operation on the parsed value, and map any throw. Never rejects.
 */
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

function noInput(): Validated<undefined> {
  return { ok: true, value: undefined };
}

function buildStore(db: Knex | undefined, onWrite: WriteHook | undefined): PlaceStore {
  return {
    saveListingPage: (page: SaveListingPageInput): Promise<SaveResult> =>
      guarded(
        db,
        () => validateListingInput(page),
        (conn, value) => saveListing(conn, value, onWrite),
        saveFailure('listing save'),
      ),
    savePlaceDetails: (input: SavePlaceDetailsInput): Promise<SaveResult> =>
      guarded(
        db,
        () => validateDetailsInput(input),
        (conn, value) => saveDetails(conn, value, onWrite),
        saveFailure('details save'),
      ),
    readPlace: (input: PlaceRefInput): Promise<ReadPlaceResult> =>
      guarded(
        db,
        () => validatePlaceRef(input),
        (conn, value) =>
          conn.transaction((trx) => readPlaceValue(trx, value.placeId), READ_TRANSACTION_CONFIG),
        readFailure('read place'),
      ),
    listTags: (): Promise<TagCatalogueResult> =>
      guarded(db, noInput, (conn) => listTagCatalogue(conn), readFailure('list tags')),
    listPlaceTagLinks: (input: TagRefInput): Promise<PlaceTagLinksResult> =>
      guarded(
        db,
        () => validateTagRef(input),
        (conn, value) => listLinksOfTag(conn, value.tagId),
        readFailure('list place tag links'),
      ),
    listStoredComments: (input: PlaceRefInput): Promise<StoredCommentKeysResult> =>
      guarded(
        db,
        () => validatePlaceRef(input),
        (conn, value) => listCommentKeys(conn, value.placeId),
        readFailure('list stored comments'),
      ),
    readPlaceShapes: (input: PlaceRefInput): Promise<ReadShapesResult> =>
      guarded(
        db,
        () => validatePlaceRef(input),
        (conn, value) =>
          conn.transaction((trx) => readShapesValue(trx, value.placeId), READ_TRANSACTION_CONFIG),
        readFailure('read place shapes'),
      ),
    countStored: (): Promise<StoreCountsResult> =>
      guarded(db, noInput, (conn) => countAll(conn), readFailure('count stored')),
    close: () => destroyQuietly(db),
  };
}

export const createPlaceStore: CreatePlaceStoreFn = (options) => {
  try {
    return buildStore(openDb(options), readHook(options));
  } catch {
    return buildStore(undefined, undefined);
  }
};
