/**
 * Failure Records (AL4 crawl-run1-fixes 1.4.8, 1.5, 2.2, 2.3, 2.5): the Failure Record write
 * step of a Run and the public reads of Failure Records and Explicit Retries.
 *
 * The write step validates the record before any database access, then opens one short READ
 * COMMITTED transaction: the Run row is locked while it is in progress, and exactly one insert
 * goes through a Writer built with the given hook. A Place record then reads whether the Place
 * is Parked after it (same transaction; AL4 1.4.6), which sets `parked`. Records are append-only: nothing here updates
 * or deletes them (AC-25).
 *
 * Every value is a binding, every SQL text is a constant, and every row is parsed with its row
 * schema.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import type {
  ExplicitRetriesInput,
  ExplicitRetry,
  FailureRecord,
  FailureRecordsInput,
} from '../../contracts/crawl-run1-fixes.schema';
import type { FailedItem } from '../../contracts/hydration.schema';
import type { StoreFailure, WriteHook } from '../../contracts/storage.schema';
import { lockLiveRun } from './crawl-progress';
import { CRAWL_TABLES, ITEM_FAILURE_PAGE_COLUMN } from './crawl-tables';
import { selectParkedPlaces } from './parking';
import { FailureRowSchema, RetryRowSchema } from './rows';
import type { FailureRow, FailureStepValue, RetryRow } from './types';
import { validateFailureRecord } from './validate';
import { createWriter } from './writer';

const FAILED_AT_TEXT_SQL =
  'to_char(failed_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as failed_at_text';

const RETRIED_AT_TEXT_SQL =
  'to_char(retried_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as retried_at_text';

/** A Failure Record that fails validation; carries the `invalid_data` failure for the repository. */
export class InvalidFailureRecordError extends Error {
  readonly failure: StoreFailure;

  constructor(failure: StoreFailure) {
    super('failure record failed validation');
    this.name = 'InvalidFailureRecordError';
    this.failure = failure;
  }
}

/** Item columns of one record: a Place item or a listing item, never both. */
function itemColumns(item: FailedItem): Record<string, number | null> {
  if (item.kind === 'place_details') {
    return { place_id: item.placeId, tile_number: null, [ITEM_FAILURE_PAGE_COLUMN]: null };
  }
  return { place_id: null, tile_number: item.tileNumber, [ITEM_FAILURE_PAGE_COLUMN]: item.page };
}

/**
 * Failure Record step (AL4 1.4.8): one insert while the Run is live. An invalid record throws
 * `InvalidFailureRecordError` before any database access.
 */
export async function failureStep(
  db: Knex,
  record: FailureRecord,
  onWrite: WriteHook | undefined,
): Promise<FailureStepValue> {
  const validated = validateFailureRecord(record);
  if (!validated.ok) throw new InvalidFailureRecordError(validated.failure);
  const v = validated.value;
  return db.transaction(async (trx): Promise<FailureStepValue> => {
    if (!(await lockLiveRun(trx, v.runId))) return { kind: 'taken_over' };
    const writer = createWriter(onWrite);
    await writer.run(
      trx(CRAWL_TABLES.itemFailures).insert({
        run_id: v.runId,
        ...itemColumns(v.item),
        failure_kind: v.failureKind,
        message: v.message,
        failed_at: v.failedAt,
      }),
    );
    if (v.item.kind === 'place_details') {
      const parked = (await selectParkedPlaces(trx, { placeId: v.item.placeId })).at(0);
      return parked === undefined ? { kind: 'recorded' } : { kind: 'recorded', parked };
    }
    return { kind: 'recorded' };
  });
}

function toFailedItem(row: FailureRow): FailedItem {
  if (row.place_id !== null && row.tile_number === null && row.page_no === null) {
    return { kind: 'place_details', placeId: row.place_id };
  }
  if (row.place_id === null && row.tile_number !== null && row.page_no !== null) {
    return { kind: 'listing_page', tileNumber: row.tile_number, page: row.page_no };
  }
  throw new Error('failure record row has no single item');
}

function toFailureRecord(row: FailureRow): FailureRecord {
  return {
    runId: row.run_id,
    item: toFailedItem(row),
    failureKind: row.failure_kind,
    message: row.message,
    failedAt: row.failed_at_text,
  };
}

function toExplicitRetry(row: RetryRow): ExplicitRetry {
  return {
    runId: row.run_id,
    regionName: row.region_name,
    retriedAt: row.retried_at_text,
    placesReleased: row.places_released,
  };
}

/** Failure Records of one Place or one Run, oldest first, ties in insertion order (AC-26). */
export async function selectFailureRecords(
  db: Knex | Knex.Transaction,
  input: FailureRecordsInput,
): Promise<FailureRecord[]> {
  const where = 'placeId' in input ? { place_id: input.placeId } : { run_id: input.runId };
  const rows: unknown = await db(CRAWL_TABLES.itemFailures)
    .select(
      'run_id',
      'place_id',
      'tile_number',
      ITEM_FAILURE_PAGE_COLUMN,
      'failure_kind',
      'message',
      db.raw(FAILED_AT_TEXT_SQL),
    )
    .where(where)
    .orderBy([{ column: 'failed_at' }, { column: 'failure_id' }]);
  return z.array(FailureRowSchema).parse(rows).map(toFailureRecord);
}

/** Explicit Retries of one Region, oldest first (AC-37). */
export async function selectExplicitRetries(
  db: Knex | Knex.Transaction,
  input: ExplicitRetriesInput,
): Promise<ExplicitRetry[]> {
  const rows: unknown = await db(CRAWL_TABLES.explicitRetries)
    .select('run_id', 'region_name', db.raw(RETRIED_AT_TEXT_SQL), 'places_released')
    .where('region_name', input.regionName)
    .orderBy([{ column: 'retried_at' }, { column: 'run_id' }]);
  return z.array(RetryRowSchema).parse(rows).map(toExplicitRetry);
}
