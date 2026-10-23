/**
 * AL5 CONTRACT: Crawl Run 1 fixes (feature `crawl-run1-fixes`, Stage 1, a change to substeps 1
 * and 3).
 *
 * Layer:    AL5 (Contracts). Source of truth for AL4 design and AL2 implementation.
 * Derives:  docs/al6-requirements/20261022-crawl-run1-fixes-al6.md (AC-1 .. AC-46, rules 1 .. 10,
 *           stakeholder decisions Q1 .. Q11), intent docs/al7-intent/20261022-crawl-run1-fixes-al7.md
 * Enforces: .agrules section 1 "Offline Ingestion" (the crawl stops instead of spending requests
 *           on a used-up Key Quota; resumable), section 2 (every stored or reported shape is
 *           checked with Zod), section 3 (Failure Records and Explicit Retries live in `src/db/`
 *           and are created by a versioned Schema Setup step), section 4 "No Commenter IPs",
 *           "No Data or Secrets in Git", "Recorded API Fixtures", "No Live External Calls in
 *           Tests" and "Strict Types Only" (all I/O typed through `z.infer`).
 *
 * This feature amends two finished contracts instead of adding new entry points:
 * - ./wikimapia-client.schema.ts: `RawPlaceDetailsSchema.tags` admits a missing or `null` item
 *   (part A); `RawDebugResponseSchema` carries the optional `code`; the new Client Failure kind
 *   `key_quota_exhausted` (KeyQuotaExhaustedFailureSchema, KEY_QUOTA_CODE = 1004) and the pure
 *   `classifyDebugResponse` (part B).
 * - ./hydration.schema.ts: Run Outcome / Run Record status `quota_exhausted` (a Clean Stop,
 *   exit status success), the counts `placesParkedThisRun`, `placesParked`, `placesReleased`
 *   with their SUMMARY_LABELS, the Explicit Retry option `retryParked` (`--retry-parked`) and the
 *   Dry Run's `parkedPlacesInRegion` (parts B and C).
 * This file adds the Failure Record, Explicit Retry and Parking shapes (part C).
 *
 * Public entry points (black box for ./crawl-run1-fixes.test.ts), all already existing:
 * - `src/wikimapia/client.ts` exports `createWikimapiaClient` (CLIENT_ENTRY_POINT)
 * - `src/crawl/run-crawl.ts`   exports `runCrawl`              (RUN_ENTRY_POINT)
 * - `src/crawl/command.ts`     exports `runCrawlCommand`       (COMMAND_ENTRY_POINT)
 * - `src/db/crawl-store.ts`    exports `createCrawlStore`, which from this feature on returns a
 *   `CrawlStore & FailureRecordStore` (ENTRY_POINT, CreateFailureAwareCrawlStoreFn)
 * - `src/db/schema-setup.ts`   exports `createSchemaSetup` (its newest step adds this storage;
 *   `emptyStore()` also removes every Failure Record and Explicit Retry, AC-42)
 *
 * Failure Records hold identifiers, kinds, messages and moments only: never Wikimapia place
 * content, Commenter IPs, API Keys or connection strings (AC-27, rule 10).
 */
import { z } from 'zod';
import {
  FailedItemSchema,
  ItemFailureKindSchema,
  MomentSchema,
  RegionNameSchema,
  RunIdSchema,
  type CrawlStore,
  type CrawlStoreOptions,
  type FailedItem,
  type ItemFailureKind,
  type Moment,
} from './hydration.schema';
import { storeResultSchema } from './storage.schema';
import { PlaceIdSchema } from './wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** The Crawl Store gains the Failure Record and Explicit Retry reads (FailureRecordStore). */
export const ENTRY_POINT = {
  module: 'src/db/crawl-store.ts',
  export: 'createCrawlStore',
} as const;

/** Part A and part B of the Client: the real, amended Wikimapia Client. */
export const CLIENT_ENTRY_POINT = {
  module: 'src/wikimapia/client.ts',
  export: 'createWikimapiaClient',
} as const;

/** Parts B and C of the Crawl. */
export const RUN_ENTRY_POINT = { module: 'src/crawl/run-crawl.ts', export: 'runCrawl' } as const;
export const COMMAND_ENTRY_POINT = {
  module: 'src/crawl/command.ts',
  export: 'runCrawlCommand',
} as const;

// ---------------------------------------------------------------------------
// Constants (AL6 glossary, rules, decisions)
// ---------------------------------------------------------------------------

/** Glossary "Parking Threshold": Counted Failures of one and the same kind that park a Place. */
export const PARKING_THRESHOLD = 3;

/**
 * Decision Q3: the Item Failure kinds that count towards Parking. Connection Failures are kept
 * as Failure Records but never count.
 */
export const PARKING_COUNTED_KINDS: readonly ItemFailureKind[] = [
  'wikimapia_error',
  'unexpected_response',
  'invalid_request',
  'invalid_data',
];

/**
 * Stakeholder name of the Failure Record storage (AL6 section 5.3) and the columns it must have
 * at least (AC-21, decision Q6): the Run, the failed item (Place ID, or Tile Number and Page
 * Number for a Listing Page; the unused ones empty), the kind, the message and the moment.
 * Other columns (e.g. a key) are allowed. Whether Explicit Retries share this table is an AL4
 * choice; their storage is only observable through `FailureRecordStore.readExplicitRetries`.
 */
export const CRAWL_ITEM_FAILURES_TABLE = 'crawl_item_failures';
export const CRAWL_ITEM_FAILURES_COLUMNS = [
  'run_id',
  'place_id',
  'tile_number',
  'page_no',
  'failure_kind',
  'message',
  'failed_at',
] as const;
/** `failed_at` holds a UTC moment (`information_schema.columns.udt_name`). */
export const FAILED_AT_UDT_NAME = 'timestamptz';

// ---------------------------------------------------------------------------
// Failure Record (glossary, AC-21 .. AC-28)
// ---------------------------------------------------------------------------

/**
 * One Failure Record. `message` is exactly the `message` of the Run's `ItemFailureReport` for
 * the same Item Failure (AC-21); `failedAt` is the Simulated Clock moment at which the failure
 * was concluded (for a Connection Failure: the last of its bounded tries, AC-23), to the second.
 */
export const FailureRecordSchema = z.strictObject({
  runId: RunIdSchema,
  item: FailedItemSchema,
  failureKind: ItemFailureKindSchema,
  message: z.string().min(1),
  failedAt: MomentSchema,
});
export type FailureRecord = z.infer<typeof FailureRecordSchema>;

/** Read Failure Records of one Place (any Region, any Run) or of one Run (AC-26). */
export const FailureRecordsInputSchema = z.union([
  z.strictObject({ placeId: PlaceIdSchema }),
  z.strictObject({ runId: RunIdSchema }),
]);
export type FailureRecordsInput = z.infer<typeof FailureRecordsInputSchema>;

/** True when `records` are oldest first (`failedAt` never decreasing). */
export function isOldestFirst(records: readonly { failedAt: Moment }[]): boolean {
  return records.every((record, i) => {
    const previous = records[i - 1];
    return previous === undefined || Date.parse(previous.failedAt) <= Date.parse(record.failedAt);
  });
}

export const FailureRecordsValueSchema = z
  .strictObject({ records: z.array(FailureRecordSchema) })
  .refine((v) => isOldestFirst(v.records), {
    message: 'Failure Records are listed oldest first',
    path: ['records'],
  });
export type FailureRecordsValue = z.infer<typeof FailureRecordsValueSchema>;

export const FailureRecordsResultSchema = storeResultSchema(FailureRecordsValueSchema);
export type FailureRecordsResult = z.infer<typeof FailureRecordsResultSchema>;

// ---------------------------------------------------------------------------
// Explicit Retry (glossary, AC-37, AC-40)
// ---------------------------------------------------------------------------

/**
 * One Explicit Retry as kept in Crawl Progress: the Run that made it, its Region, its moment
 * (the Run's start moment, which becomes the Count Reset of each released Place) and the number
 * of Places it released. Every Run made with the option that is not a Dry Run keeps one, also
 * when it released no Place; a Dry Run keeps none (AC-40).
 */
export const ExplicitRetrySchema = z.strictObject({
  runId: RunIdSchema,
  regionName: RegionNameSchema,
  retriedAt: MomentSchema,
  placesReleased: z.number().int().nonnegative(),
});
export type ExplicitRetry = z.infer<typeof ExplicitRetrySchema>;

export const ExplicitRetriesInputSchema = z.strictObject({ regionName: RegionNameSchema });
export type ExplicitRetriesInput = z.infer<typeof ExplicitRetriesInputSchema>;

export const ExplicitRetriesValueSchema = z
  .strictObject({ retries: z.array(ExplicitRetrySchema) })
  .refine(
    (v) =>
      v.retries.every((r, i) => {
        const previous = v.retries[i - 1];
        return previous === undefined || Date.parse(previous.retriedAt) <= Date.parse(r.retriedAt);
      }),
    { message: 'Explicit Retries are listed oldest first', path: ['retries'] },
  );
export type ExplicitRetriesValue = z.infer<typeof ExplicitRetriesValueSchema>;

export const ExplicitRetriesResultSchema = storeResultSchema(ExplicitRetriesValueSchema);
export type ExplicitRetriesResult = z.infer<typeof ExplicitRetriesResultSchema>;

// ---------------------------------------------------------------------------
// Crawl Store additions (read only; every write is done by the Run)
// ---------------------------------------------------------------------------

/**
 * Read access to Failure Records and Explicit Retries. Calls never reject; invalid input is
 * `invalid_data` and never reaches the database; an unreachable database is
 * `store_unavailable` without secrets. Empty lists when there is nothing.
 */
export interface FailureRecordStore {
  /** Failure Records of a Place or of a Run, oldest first, with every item of AC-21 (AC-26). */
  readFailureRecords(input: FailureRecordsInput): Promise<FailureRecordsResult>;
  /** Explicit Retries of a Region, oldest first (AC-37). */
  readExplicitRetries(input: ExplicitRetriesInput): Promise<ExplicitRetriesResult>;
}

/** `createCrawlStore` from `src/db/crawl-store.ts` must have this signature from now on. */
export type CreateFailureAwareCrawlStoreFn = (
  options: CrawlStoreOptions,
) => CrawlStore & FailureRecordStore;

// ---------------------------------------------------------------------------
// Parking rules as pure functions (glossary "Counted Failure", "Count Reset", "Parked Place")
// ---------------------------------------------------------------------------

/**
 * Count Reset of a Place (decision Q2): the latest of its most recent successful Details Save
 * and its most recent Explicit Retry; absent when it has neither.
 */
export function countResetOf(moments: {
  lastDetailsSaveAt?: Moment | undefined;
  lastExplicitRetryAt?: Moment | undefined;
}): Moment | undefined {
  const candidates = [moments.lastDetailsSaveAt, moments.lastExplicitRetryAt].filter(
    (m): m is Moment => m !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function placeIdOf(item: FailedItem): number | undefined {
  return item.kind === 'place_details' ? item.placeId : undefined;
}

/**
 * The Counted Failures of `placeId` among `records` (glossary): about that Place (never a
 * Listing Page, decision Q6), of a kind in PARKING_COUNTED_KINDS (decision Q3), and not before
 * the Count Reset. Moments are whole seconds and the Count Reset of an Explicit Retry is the
 * start moment of the Run that also retries the Place, so a record concluded in the same second
 * as the Count Reset counts (`failedAt >= countReset`); a Run tries a Place at most once, so no
 * Failure Record can share the second of the Details Save that resets the count.
 */
export function countedFailures(
  records: readonly FailureRecord[],
  placeId: number,
  countReset?: Moment,
): FailureRecord[] {
  const reset = countReset === undefined ? undefined : Date.parse(countReset);
  return records.filter(
    (r) =>
      placeIdOf(r.item) === placeId &&
      PARKING_COUNTED_KINDS.includes(r.failureKind) &&
      (reset === undefined || Date.parse(r.failedAt) >= reset),
  );
}

/**
 * The kind that parks `placeId`, or undefined when the Place is not a Parked Place: the first
 * kind with at least PARKING_THRESHOLD Counted Failures. They need not be consecutive (Q2).
 */
export function parkingKindOf(
  records: readonly FailureRecord[],
  placeId: number,
  countReset?: Moment,
): ItemFailureKind | undefined {
  const byKind = new Map<ItemFailureKind, number>();
  for (const record of countedFailures(records, placeId, countReset)) {
    const next = (byKind.get(record.failureKind) ?? 0) + 1;
    byKind.set(record.failureKind, next);
    if (next >= PARKING_THRESHOLD) return record.failureKind;
  }
  return undefined;
}

export function isParkedPlace(
  records: readonly FailureRecord[],
  placeId: number,
  countReset?: Moment,
): boolean {
  return parkingKindOf(records, placeId, countReset) !== undefined;
}
