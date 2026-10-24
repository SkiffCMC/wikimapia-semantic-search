/**
 * Embedding Store (public entry point; AL4 embeddings 1.4.8, 1.5; R2, AC-39, AC-53 .. AC-58).
 * Same pattern as the Place Store: every input is validated before any DB access, then the read
 * or save runs on the parsed value only. The factory never throws and no method ever rejects:
 * every failure resolves `invalid_data` or `store_unavailable` without secrets, error messages
 * or input values. One run-wide write hook per store numbers every write of its lifetime.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import type {
  CreateEmbeddingStoreFn,
  EmbeddingCandidatesInput,
  EmbeddingCandidatesResult,
  EmbeddingStorageInfoResult,
  EmbeddingStore,
  EmbeddingStoreCountsResult,
  EmbeddingStoreOptions,
  ReadEmbeddingRecordResult,
  SaveEmbeddingRecordsInput,
  SaveEmbeddingRecordsResult,
} from '../../contracts/embeddings.schema';
import { StoreConfigSchema } from '../../contracts/storage.schema';
import type { StoreFailure, WriteHook } from '../../contracts/storage.schema';
import { POOL_MAX_STORE, createDb, destroyQuietly } from './connection';
import {
  countEmbeddingStoreRows,
  readEmbeddingStorageInfo,
  selectEmbeddingCandidates,
  selectEmbeddingRecord,
} from './embedding-read';
import { InvalidDataError, saveEmbeddingRecordsStep } from './embedding-save';
import { invalidData, storeUnavailable, unavailableFrom } from './failures';
import { READ_TRANSACTION_CONFIG } from './place-store';
import type { StoreResult, Validated } from './types';
import {
  validateEmbeddingCandidatesInput,
  validatePlaceRef,
  validateSaveEmbeddingRecordsInput,
} from './validate';
import { createRunWideHook } from './writer';

const NOT_CONFIGURED_MESSAGE =
  'Embedding Store is not configured: connection string is missing or unusable';
const READ_BACK_FAILED_MESSAGE =
  'Embedding Store unavailable: stored data failed the read-back check';
const UNEXPECTED_MESSAGE = 'Embedding Store unavailable: unexpected internal failure';

function openDb(options: EmbeddingStoreOptions): Knex | undefined {
  try {
    const parsed = StoreConfigSchema.safeParse({ connectionString: options.connectionString });
    if (!parsed.success) return undefined;
    return createDb(parsed.data.connectionString, POOL_MAX_STORE);
  } catch {
    return undefined;
  }
}

function readHook(options: EmbeddingStoreOptions): WriteHook | undefined {
  try {
    return createRunWideHook(options.onWrite);
  } catch {
    return undefined;
  }
}

function fail(failure: StoreFailure): { ok: false; failure: StoreFailure } {
  return { ok: false, failure };
}

/** `ZodError` -> read-back failure, `InvalidDataError` -> its issues, anything else -> code only. */
function failureFor(action: string): (error: unknown) => StoreFailure {
  return (error) => {
    if (error instanceof InvalidDataError) return invalidData(error.issues);
    if (error instanceof z.ZodError) return storeUnavailable(READ_BACK_FAILED_MESSAGE);
    return unavailableFrom(error, action);
  };
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

function noInput(): Validated<undefined> {
  return { ok: true, value: undefined };
}

function buildStore(db: Knex | undefined, hook: WriteHook | undefined): EmbeddingStore {
  return {
    listEmbeddingCandidates: (
      input: EmbeddingCandidatesInput,
    ): Promise<EmbeddingCandidatesResult> =>
      guarded(
        db,
        () => validateEmbeddingCandidatesInput(input),
        (conn, value) =>
          conn.transaction((trx) => selectEmbeddingCandidates(trx, value), READ_TRANSACTION_CONFIG),
        failureFor('embedding candidates read'),
      ),
    saveEmbeddingRecords: (input: SaveEmbeddingRecordsInput): Promise<SaveEmbeddingRecordsResult> =>
      guarded(
        db,
        () => validateSaveEmbeddingRecordsInput(input),
        (conn, value) => saveEmbeddingRecordsStep(conn, value, hook),
        failureFor('embedding records save'),
      ),
    readEmbeddingRecord: (input: { placeId: number }): Promise<ReadEmbeddingRecordResult> =>
      guarded(
        db,
        () => validatePlaceRef(input),
        (conn, value) => selectEmbeddingRecord(conn, value.placeId),
        failureFor('embedding record read'),
      ),
    countEmbeddingStore: (): Promise<EmbeddingStoreCountsResult> =>
      guarded(db, noInput, (conn) => countEmbeddingStoreRows(conn), failureFor('embedding count')),
    inspectEmbeddingStorage: (): Promise<EmbeddingStorageInfoResult> =>
      guarded(
        db,
        noInput,
        (conn) => readEmbeddingStorageInfo(conn),
        failureFor('embedding storage inspection'),
      ),
    close: () => destroyQuietly(db),
  };
}

export const createEmbeddingStore: CreateEmbeddingStoreFn = (options) => {
  try {
    return buildStore(openDb(options), readHook(options));
  } catch {
    return buildStore(undefined, undefined);
  }
};
