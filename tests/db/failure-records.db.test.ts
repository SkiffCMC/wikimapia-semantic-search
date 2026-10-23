/**
 * AL2 unit tests: the Failure Record write step (`src/db/failure-records.ts` `failureStep`
 * behind the repository's `recordItemFailure`) and the public reads `readFailureRecords` /
 * `readExplicitRetries` of `createCrawlStore` (AL4 crawl-run1-fixes 1.3, 1.4.8, 1.5 rows
 * "Failure Record (`failureStep`)" and "Public reads", 2.2, 2.3, 2.5). AL3 routing
 * 20261022-crawl-run1-fixes-03-failure-records, section 2.1 A.
 *
 * Store-side stand-in for contract AC-21, AC-25, AC-26, AC-28 and the store side of AC-37 until
 * the Run uses `recordItemFailure` (U6).
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`) and the contract's unreachable
 * URL. Runs are created through the repository (`beginRun`); Failure Records are written only
 * through `recordItemFailure`; Explicit Retry rows are seeded with the Knex query builder on a
 * tracked `testDb()` handle (table names from `CRAWL_TABLES`, no raw SQL), since nothing writes
 * them before U4. Records are read back only through the public Crawl Store. Every result is
 * parsed with its contract result schema (or a test-local schema of the AL4 1.3
 * `FailureStepValue`). No Place is seeded in `places` here, so no record is ever Parked and no
 * result carries `parked` (U4, AL3 routing 20261022-crawl-run1-fixes-04-parking, section 2.1 E;
 * Parking itself is covered by `tests/db/parking.db.test.ts`). All data is synthetic. Every
 * repository, store, setup and Knex handle is closed in `afterEach`/`afterAll`.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import type { BeginRunInput, CrawlRepository } from '../../src/db/types';
import {
  EmptyResultSchema,
  InvalidDataFailureSchema,
  SchemaStepsResultSchema,
  StoreUnavailableFailureSchema,
  storeResultSchema,
  type SchemaSetup,
  type StoreFailure,
  type WriteHook,
} from '../../contracts/storage.schema';
import {
  ABANDONMENT_AGE_SECONDS,
  ItemFailureKindSchema,
  RunIdSchema,
  ZERO_RUN_COUNTS,
  toMoment,
  type Moment,
} from '../../contracts/hydration.schema';
import {
  ExplicitRetriesResultSchema,
  FailureRecordsResultSchema,
  type CreateFailureAwareCrawlStoreFn,
  type ExplicitRetry,
  type FailureRecord,
  type FailureRecordsInput,
} from '../../contracts/crawl-run1-fixes.schema';
import { RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';

// Compile-time check: the entry point has the contract's (amended) signature.
const create: CreateFailureAwareCrawlStoreFn = createCrawlStore;
type FailureAwareStore = ReturnType<CreateFailureAwareCrawlStoreFn>;

const UNREACHABLE_TIMEOUT_MS = 60_000;
const REGION = 'test-one';
const OTHER_REGION = 'test-two';
const EMPTY_REGION = 'test-far';
const TILE_SIZE = { width: 0.005, height: 0.005 } as const;
const HOOK_SECRET_MESSAGE = `hook failed at postgres://wm_hook:${UNREACHABLE_PASSWORD}@127.0.0.1:5432/wm`;

// ---------------------------------------------------------------------------
// Test-local value schemas (AL4 1.3 types; not contract schemas)
// ---------------------------------------------------------------------------

/**
 * `FailureStepValue` (AL4 1.3): `parked` only for a Place that is Parked after the record. This
 * file never seeds `places`, so no record here may carry it (the `record` helper asserts that).
 */
const FailureStepValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('recorded'),
    parked: z
      .strictObject({ placeId: z.number().int().positive(), failureKind: ItemFailureKindSchema })
      .optional(),
  }),
  z.strictObject({ kind: z.literal('taken_over') }),
]);
const FailureStepResultSchema = storeResultSchema(FailureStepValueSchema);
type FailureStepResult = z.infer<typeof FailureStepResultSchema>;

/** Only the fields of a started Run this file needs (non-strict: U4 adds `placesReleased`). */
const StartedSchema = z.object({ kind: z.literal('started'), runId: RunIdSchema });
const BeginResultSchema = storeResultSchema(
  z.union([StartedSchema, z.object({ kind: z.enum(['run_in_progress', 'region_changed']) })]),
);
const FinishResultSchema = storeResultSchema(z.strictObject({ updated: z.boolean() }));
const CountRowsSchema = z.array(z.object({ n: z.coerce.number().int() }));

type Parsed<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
let crawlStore: FailureAwareStore;
const repositories: CrawlRepository[] = [];
const knexes: Knex[] = [];

function openRepo(onWrite?: WriteHook, connectionString = requireTestDatabaseUrl()): CrawlRepository {
  const repo = openCrawlRepository({
    connectionString,
    ...(onWrite === undefined ? {} : { onWrite }),
  });
  repositories.push(repo);
  return repo;
}

function testDb(): Knex {
  const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
  knexes.push(db);
  return db;
}

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: url });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  expect(applied.ok).toBe(true);
  crawlStore = create({ connectionString: url });
});

beforeEach(async () => {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
});

afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const db of knexes.splice(0)) await destroyQuietly(db);
});

afterAll(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const db of knexes.splice(0)) await destroyQuietly(db);
  await crawlStore.close();
  await setup.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fails the test explicitly if the call rejects; otherwise yields its resolved value. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await expect(promise).resolves.toBeDefined();
  return promise;
}

function okValue<T>(result: Parsed<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

function failureOf<T>(result: Parsed<T>): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

function plusSeconds(moment: Moment, seconds: number): Moment {
  return toMoment(new Date(Date.parse(moment) + seconds * 1000));
}

function abandonBeforeFor(startedAt: Moment): Moment {
  return plusSeconds(startedAt, -ABANDONMENT_AGE_SECONDS);
}

function beginInput(overrides: Partial<BeginRunInput> = {}): BeginRunInput {
  return {
    regionName: REGION,
    bbox: SMALL_BBOX,
    tileSize: TILE_SIZE,
    tileCount: 1,
    relist: false,
    startedAt: RUN_START,
    abandonBefore: abandonBeforeFor(RUN_START),
    counts: ZERO_RUN_COUNTS,
    retryParked: false,
    ...overrides,
  };
}

/** Starts a Run through the repository and returns its Run ID. */
async function startRun(repo: CrawlRepository, overrides: Partial<BeginRunInput> = {}): Promise<number> {
  const value = okValue(BeginResultSchema.parse(await settle(repo.beginRun(beginInput(overrides)))));
  const started = StartedSchema.safeParse(value);
  if (!started.success) throw new Error(`expected started, got ${value.kind}`);
  return started.data.runId;
}

/** Starts a Run at `startedAt` (no live Run of the Region may be left). */
async function startRunAt(
  repo: CrawlRepository,
  startedAt: Moment,
  overrides: Partial<BeginRunInput> = {},
): Promise<number> {
  return startRun(repo, { startedAt, abandonBefore: abandonBeforeFor(startedAt), ...overrides });
}

async function finishRun(repo: CrawlRepository, runId: number, endedAt: Moment): Promise<void> {
  const finished = okValue(
    FinishResultSchema.parse(
      await settle(repo.finishRun({ runId, status: 'completed', endedAt, counts: ZERO_RUN_COUNTS })),
    ),
  );
  expect(finished).toStrictEqual({ updated: true });
}

function placeRecord(
  runId: number,
  placeId: number,
  failedAt: Moment,
  overrides: Partial<FailureRecord> = {},
): FailureRecord {
  return {
    runId,
    item: { kind: 'place_details', placeId },
    failureKind: 'wikimapia_error',
    message: `Place ${String(placeId)}: Wikimapia error: synthetic failure`,
    failedAt,
    ...overrides,
  };
}

function listingRecord(
  runId: number,
  tileNumber: number,
  page: number,
  failedAt: Moment,
  overrides: Partial<FailureRecord> = {},
): FailureRecord {
  return {
    runId,
    item: { kind: 'listing_page', tileNumber, page },
    failureKind: 'connection',
    message: `Tile ${String(tileNumber)} page ${String(page)}: connection failure: synthetic`,
    failedAt,
    ...overrides,
  };
}

async function recordResult(repo: CrawlRepository, record: FailureRecord): Promise<FailureStepResult> {
  return FailureStepResultSchema.parse(await settle(repo.recordItemFailure(record)));
}

async function record(repo: CrawlRepository, rec: FailureRecord): Promise<void> {
  expect(await recordResult(repo, rec)).toStrictEqual({ ok: true, value: { kind: 'recorded' } });
}

async function readResult(input: FailureRecordsInput, store: FailureAwareStore = crawlStore) {
  return FailureRecordsResultSchema.parse(await settle(store.readFailureRecords(input)));
}

async function readRecords(input: FailureRecordsInput): Promise<FailureRecord[]> {
  return okValue(await readResult(input)).records;
}

async function readRetries(regionName: string): Promise<ExplicitRetry[]> {
  const result = ExplicitRetriesResultSchema.parse(
    await settle(crawlStore.readExplicitRetries({ regionName })),
  );
  return okValue(result).retries;
}

async function failureRowCount(): Promise<number> {
  const result: unknown = await testDb()(CRAWL_TABLES.itemFailures).count({ n: '*' });
  const first = CountRowsSchema.parse(result)[0];
  if (first === undefined) throw new Error('count returned no row');
  return first.n;
}

function recorder(): { hook: WriteHook; numbers: number[] } {
  const numbers: number[] = [];
  return {
    numbers,
    hook: (n) => {
      numbers.push(n);
    },
  };
}

function expectNoSecrets(failure: StoreFailure): void {
  const text = JSON.stringify(failure);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain('hook failed');
  expect(text).not.toContain('wm_hook');
}

const T = (seconds: number): Moment => plusSeconds(RUN_START, seconds);

// ===========================================================================
// A.1 / A.2 Round trip (AC-21, AC-26)
// ===========================================================================

describe('A.1 round trip of a Place item and a listing item', () => {
  it('recordItemFailure resolves recorded without parked; reads by Place and by Run return the exact records', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const place = placeRecord(runId, 900, T(10));
    const listing = listingRecord(runId, 2, 3, T(20));

    const placeResult = await recordResult(repo, place);
    expect(placeResult).toStrictEqual({ ok: true, value: { kind: 'recorded' } });
    expect(Object.hasOwn(okValue(placeResult), 'parked')).toBe(false);
    const listingResult = await recordResult(repo, listing);
    expect(listingResult).toStrictEqual({ ok: true, value: { kind: 'recorded' } });
    expect(Object.hasOwn(okValue(listingResult), 'parked')).toBe(false);

    const byPlace = okValue(await readResult({ placeId: 900 }));
    expect(byPlace).toStrictEqual({ records: [place] });
    const byRun = okValue(await readResult({ runId }));
    expect(byRun).toStrictEqual({ records: [place, listing] });
  });
});

describe('A.2 every field round-trips unchanged', () => {
  it('every ItemFailureKindSchema option round-trips', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const records = ItemFailureKindSchema.options.map((failureKind, i) =>
      placeRecord(runId, 900, T(i + 1), { failureKind, message: `kind ${failureKind}` }),
    );
    for (const rec of records) await record(repo, rec);
    expect(await readRecords({ placeId: 900 })).toStrictEqual(records);
    expect(await readRecords({ runId })).toStrictEqual(records);
  });

  it('a message with spaces, punctuation and non-ASCII text round-trips unchanged', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const message =
      'Place 900: Wikimapia error:  «Кнез Михаилова» — café, 100% (ok?); "quoted" \'single\' ✓ 東京\ttab';
    const rec = placeRecord(runId, 900, T(5), { message });
    await record(repo, rec);
    const [only] = await readRecords({ placeId: 900 });
    expect(only?.message).toBe(message);
    expect(only).toStrictEqual(rec);
  });

  it('a listing item keeps its Tile Number and Page Number', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const rec = listingRecord(runId, 7, 12, T(5), { failureKind: 'unexpected_response' });
    await record(repo, rec);
    expect(await readRecords({ runId })).toStrictEqual([rec]);
  });
});

// ===========================================================================
// A.3 Order (AC-26)
// ===========================================================================

describe('A.3 records come back oldest first', () => {
  it('out-of-order failedAt inserts are returned oldest first, by Place and by Run', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const late = placeRecord(runId, 900, T(30), { message: 'late' });
    const early = placeRecord(runId, 900, T(10), { message: 'early' });
    const middle = placeRecord(runId, 900, T(20), { message: 'middle' });
    for (const rec of [late, early, middle]) await record(repo, rec);
    expect(await readRecords({ placeId: 900 })).toStrictEqual([early, middle, late]);
    expect(await readRecords({ runId })).toStrictEqual([early, middle, late]);
  });

  it('records with the same failedAt come back in insertion order', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const same = T(15);
    const records = ['first', 'second', 'third', 'fourth'].map((message) =>
      placeRecord(runId, 900, same, { message }),
    );
    for (const rec of records) await record(repo, rec);
    expect(await readRecords({ placeId: 900 })).toStrictEqual(records);
    expect(await readRecords({ runId })).toStrictEqual(records);
  });

  it('same failedAt in insertion order also across item kinds in one Run', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    const same = T(15);
    const records = [
      listingRecord(runId, 1, 1, same),
      placeRecord(runId, 900, same),
      listingRecord(runId, 1, 2, same),
    ];
    for (const rec of records) await record(repo, rec);
    expect(await readRecords({ runId })).toStrictEqual(records);
  });

  it('by Place, records of two Runs (the first finished, a second started) are both returned, oldest first', async () => {
    const repo = openRepo();
    const run1 = await startRun(repo);
    const r1b = placeRecord(run1, 900, T(50), { message: 'run 1, later' });
    const r1a = placeRecord(run1, 900, T(10), { message: 'run 1, earlier' });
    await record(repo, r1b);
    await record(repo, r1a);
    await finishRun(repo, run1, T(100));

    const run2 = await startRunAt(repo, T(3600));
    expect(run2).not.toBe(run1);
    const r2b = placeRecord(run2, 900, T(3700), { failureKind: 'connection', message: 'run 2, later' });
    const r2a = placeRecord(run2, 900, T(3650), { message: 'run 2, earlier' });
    await record(repo, r2b);
    await record(repo, r2a);

    expect(await readRecords({ placeId: 900 })).toStrictEqual([r1a, r1b, r2a, r2b]);
    expect(await readRecords({ runId: run1 })).toStrictEqual([r1a, r1b]);
    expect(await readRecords({ runId: run2 })).toStrictEqual([r2a, r2b]);
  });
});

// ===========================================================================
// A.4 Isolation
// ===========================================================================

describe('A.4 isolation', () => {
  it('records of another Place and of another Run are not returned; empty reads give { records: [] }', async () => {
    const repo = openRepo();
    const run1 = await startRun(repo);
    const a900 = placeRecord(run1, 900, T(10));
    const a901 = placeRecord(run1, 901, T(11));
    const aListing = listingRecord(run1, 1, 1, T(12));
    for (const rec of [a900, a901, aListing]) await record(repo, rec);
    await finishRun(repo, run1, T(100));

    const run2 = await startRunAt(repo, T(3600));
    const b902 = placeRecord(run2, 902, T(3610));
    await record(repo, b902);

    expect(await readRecords({ placeId: 900 })).toStrictEqual([a900]);
    expect(await readRecords({ placeId: 901 })).toStrictEqual([a901]);
    expect(await readRecords({ placeId: 902 })).toStrictEqual([b902]);
    expect(await readRecords({ runId: run1 })).toStrictEqual([a900, a901, aListing]);
    expect(await readRecords({ runId: run2 })).toStrictEqual([b902]);

    expect(okValue(await readResult({ placeId: 999 }))).toStrictEqual({ records: [] });
    expect(okValue(await readResult({ runId: run2 + 1000 }))).toStrictEqual({ records: [] });
  });

  it('an empty store gives { records: [] } by Place and by Run', async () => {
    expect(okValue(await readResult({ placeId: 900 }))).toStrictEqual({ records: [] });
    expect(okValue(await readResult({ runId: 1 }))).toStrictEqual({ records: [] });
  });

  it('a listing record is not returned by a Place read', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    await record(repo, listingRecord(runId, 1, 1, T(10)));
    expect(okValue(await readResult({ placeId: 1 }))).toStrictEqual({ records: [] });
  });
});

// ===========================================================================
// A.5 Append-only (AC-25)
// ===========================================================================

describe('A.5 Failure Records are append-only', () => {
  it('a second record for the same Place and Run adds a row; earlier records never change', async () => {
    const repo = openRepo();
    const run1 = await startRun(repo);
    const first = placeRecord(run1, 900, T(10));
    await record(repo, first);
    await record(repo, first);
    expect(await failureRowCount()).toBe(2);
    expect(await readRecords({ placeId: 900 })).toStrictEqual([first, first]);

    const third = placeRecord(run1, 900, T(20), { failureKind: 'connection', message: 'another' });
    await record(repo, third);
    expect(await failureRowCount()).toBe(3);
    const snapshot = await readRecords({ runId: run1 });
    expect(snapshot).toStrictEqual([first, first, third]);

    await finishRun(repo, run1, T(100));
    expect(await readRecords({ runId: run1 })).toStrictEqual(snapshot);
    expect(await readRecords({ placeId: 900 })).toStrictEqual(snapshot);

    const run2 = await startRunAt(repo, T(3600));
    const later = placeRecord(run2, 900, T(3610));
    await record(repo, later);
    await record(repo, listingRecord(run2, 1, 1, T(3620)));
    expect(await failureRowCount()).toBe(5);
    expect(await readRecords({ runId: run1 })).toStrictEqual(snapshot);
    expect(await readRecords({ placeId: 900 })).toStrictEqual([...snapshot, later]);
  });
});

// ===========================================================================
// A.6 / A.7 Taken over and unknown Run
// ===========================================================================

describe('A.6 a Run that is no longer in progress gets taken_over', () => {
  it('an abandoned Run (taken over by a later start): taken_over, no row, no hook call', async () => {
    const seeder = openRepo();
    const runA = await startRun(seeder);
    const takeoverAt = plusSeconds(RUN_START, ABANDONMENT_AGE_SECONDS + 1);
    const runB = await startRun(seeder, {
      startedAt: takeoverAt,
      abandonBefore: plusSeconds(RUN_START, 1),
    });
    expect(runB).not.toBe(runA);

    const rec = recorder();
    const repo = openRepo(rec.hook);
    const result = await recordResult(repo, placeRecord(runA, 900, plusSeconds(takeoverAt, 5)));
    expect(result).toStrictEqual({ ok: true, value: { kind: 'taken_over' } });
    expect(await failureRowCount()).toBe(0);
    expect(rec.numbers).toStrictEqual([]);
    expect(await readRecords({ runId: runA })).toStrictEqual([]);
  });

  it('a finished Run: taken_over for a Place and a listing item, no row, no hook call', async () => {
    const seeder = openRepo();
    const runId = await startRun(seeder);
    await finishRun(seeder, runId, T(60));

    const rec = recorder();
    const repo = openRepo(rec.hook);
    expect(await recordResult(repo, placeRecord(runId, 900, T(70)))).toStrictEqual({
      ok: true,
      value: { kind: 'taken_over' },
    });
    expect(await recordResult(repo, listingRecord(runId, 1, 1, T(71)))).toStrictEqual({
      ok: true,
      value: { kind: 'taken_over' },
    });
    expect(await failureRowCount()).toBe(0);
    expect(rec.numbers).toStrictEqual([]);
  });
});

describe('A.7 an unknown runId', () => {
  it('gives taken_over and writes nothing', async () => {
    const seeder = openRepo();
    const runId = await startRun(seeder);
    const rec = recorder();
    const repo = openRepo(rec.hook);
    expect(await recordResult(repo, placeRecord(runId + 1000, 900, T(10)))).toStrictEqual({
      ok: true,
      value: { kind: 'taken_over' },
    });
    expect(await recordResult(repo, listingRecord(runId + 1000, 1, 1, T(10)))).toStrictEqual({
      ok: true,
      value: { kind: 'taken_over' },
    });
    expect(await failureRowCount()).toBe(0);
    expect(rec.numbers).toStrictEqual([]);
  });

  it('on an empty store (no Run at all) gives taken_over and writes nothing', async () => {
    const repo = openRepo();
    expect(await recordResult(repo, placeRecord(1, 900, T(10)))).toStrictEqual({
      ok: true,
      value: { kind: 'taken_over' },
    });
    expect(await failureRowCount()).toBe(0);
  });
});

// ===========================================================================
// A.8 Write hook (AC-28)
// ===========================================================================

describe('A.8 write hook', () => {
  it('one record is exactly one write, numbered one higher than the last write of beginRun', async () => {
    const rec = recorder();
    const repo = openRepo(rec.hook);
    const runId = await startRun(repo);
    const afterBegin = rec.numbers.length;
    expect(afterBegin).toBeGreaterThan(0);
    const lastOfBegin = rec.numbers[afterBegin - 1];

    await record(repo, placeRecord(runId, 900, T(10)));
    expect(rec.numbers).toHaveLength(afterBegin + 1);
    expect(rec.numbers[afterBegin]).toBe((lastOfBegin ?? 0) + 1);

    await record(repo, listingRecord(runId, 1, 1, T(11)));
    expect(rec.numbers).toHaveLength(afterBegin + 2);
    expect(rec.numbers[afterBegin + 1]).toBe((lastOfBegin ?? 0) + 2);
  });

  it('a hook that throws on the record write resolves store_unavailable without its text; no row is left', async () => {
    let armed = false;
    const repo = openRepo(() => {
      if (armed) throw new Error(HOOK_SECRET_MESSAGE);
    });
    const runId = await startRun(repo);

    armed = true;
    const result = await recordResult(repo, placeRecord(runId, 900, T(10)));
    const failure = failureOf(result);
    StoreUnavailableFailureSchema.parse(failure);
    expect(failure.kind).toBe('store_unavailable');
    expectNoSecrets(failure);
    expect(await failureRowCount()).toBe(0);
    expect(await readRecords({ runId })).toStrictEqual([]);
  });

  it('a hook that rejects on a listing record write also rolls back', async () => {
    let armed = false;
    const repo = openRepo(async () => {
      if (armed) throw new Error(HOOK_SECRET_MESSAGE);
      await Promise.resolve();
    });
    const runId = await startRun(repo);

    armed = true;
    const failure = failureOf(await recordResult(repo, listingRecord(runId, 1, 1, T(10))));
    StoreUnavailableFailureSchema.parse(failure);
    expectNoSecrets(failure);
    expect(await failureRowCount()).toBe(0);
  });
});

// ===========================================================================
// A.9 Invalid records (invalid_data, nothing written, hook not called)
// ===========================================================================

function invalidRecords(runId: number): [string, FailureRecord][] {
  const valid = placeRecord(runId, 900, T(10));
  const extraKey = { ...valid, extra: 'synthetic-extra-value' };
  const bothShapes = {
    ...valid,
    item: { kind: 'place_details', placeId: 900, tileNumber: 1, page: 1 },
  };
  return [
    ['empty message', { ...valid, message: '' }],
    ['sub-second failedAt', { ...valid, failedAt: '2026-10-22T10:00:00.500Z' }],
    ['failureKind key_quota_exhausted', { ...valid, failureKind: 'key_quota_exhausted' as never }],
    ['an extra key on the record', extraKey],
    ['an item with both shapes’ keys', bothShapes as never],
    ['placeId 0', { ...valid, item: { kind: 'place_details', placeId: 0 } }],
    ['runId 0', { ...valid, runId: 0 }],
  ];
}

describe('A.9 invalid records resolve invalid_data and write nothing', () => {
  it.each(invalidRecords(1).map(([label]) => [label] as const))('%s', async (label) => {
    const rec = recorder();
    const repo = openRepo(rec.hook);
    const runId = await startRun(repo);
    const afterBegin = rec.numbers.length;
    const found = invalidRecords(runId).find(([l]) => l === label);
    if (found === undefined) throw new Error(`no case ${label}`);

    const failure = failureOf(await recordResult(repo, found[1]));
    expect(InvalidDataFailureSchema.safeParse(failure).success).toBe(true);
    expect(rec.numbers).toHaveLength(afterBegin);
    expect(await failureRowCount()).toBe(0);
    expect(await readRecords({ runId })).toStrictEqual([]);
  });

  it('the failures do not echo the bad values', async () => {
    const repo = openRepo();
    const runId = await startRun(repo);
    for (const [, bad] of invalidRecords(runId)) {
      const text = JSON.stringify(failureOf(await recordResult(repo, bad)));
      expect(text).not.toContain('10:00:00.500');
      expect(text).not.toContain('synthetic-extra-value');
      expect(text).not.toContain('synthetic failure');
    }
  });

  it(
    'invalid records give the same invalid_data on an unreachable database (no database access)',
    async () => {
      const real = openRepo();
      const runId = await startRun(real);
      const unreachable = openRepo(undefined, UNREACHABLE_DATABASE_URL);
      for (const [label, bad] of invalidRecords(runId)) {
        const onReal = await recordResult(real, bad);
        const onUnreachable = await recordResult(unreachable, bad);
        expect({ label, kind: failureOf(onUnreachable).kind }).toStrictEqual({
          label,
          kind: 'invalid_data',
        });
        expect(onUnreachable).toStrictEqual(onReal);
      }
      expect(await failureRowCount()).toBe(0);
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ===========================================================================
// A.10 Explicit Retries (AC-37 store side)
// ===========================================================================

interface RetrySeed {
  run_id: number;
  region_name: string;
  retried_at: string;
  places_released: number;
}

async function insertRetries(rows: readonly RetrySeed[]): Promise<void> {
  const db = testDb();
  for (const row of rows) await db(CRAWL_TABLES.explicitRetries).insert(row);
}

describe('A.10 readExplicitRetries', () => {
  it('returns the seeded retries of a Region oldest first; another Region gets only its own; none gives []', async () => {
    const repo = openRepo();
    const run1 = await startRun(repo);
    await finishRun(repo, run1, T(100));
    const run2Start = T(7200);
    const run2 = await startRunAt(repo, run2Start);
    await finishRun(repo, run2, T(7300));
    const otherStart = T(50);
    const runOther = await startRunAt(repo, otherStart, { regionName: OTHER_REGION });

    // Inserted out of order by retried_at.
    await insertRetries([
      { run_id: run2, region_name: REGION, retried_at: run2Start, places_released: 0 },
      { run_id: runOther, region_name: OTHER_REGION, retried_at: otherStart, places_released: 1 },
      { run_id: run1, region_name: REGION, retried_at: RUN_START, places_released: 3 },
    ]);

    const expected: ExplicitRetry[] = [
      { runId: run1, regionName: REGION, retriedAt: RUN_START, placesReleased: 3 },
      { runId: run2, regionName: REGION, retriedAt: run2Start, placesReleased: 0 },
    ];
    expect(await readRetries(REGION)).toStrictEqual(expected);
    expect(await readRetries(OTHER_REGION)).toStrictEqual([
      { runId: runOther, regionName: OTHER_REGION, retriedAt: otherStart, placesReleased: 1 },
    ]);

    const empty = ExplicitRetriesResultSchema.parse(
      await settle(crawlStore.readExplicitRetries({ regionName: EMPTY_REGION })),
    );
    expect(okValue(empty)).toStrictEqual({ retries: [] });
  });

  it('an empty store gives { retries: [] }', async () => {
    const result = ExplicitRetriesResultSchema.parse(
      await settle(crawlStore.readExplicitRetries({ regionName: REGION })),
    );
    expect(result).toStrictEqual({ ok: true, value: { retries: [] } });
  });
});
