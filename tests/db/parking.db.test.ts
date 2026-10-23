/**
 * AL2 unit tests: the Parking reads of `src/db/parking.ts` (`selectParkingRows`,
 * `selectParkedPlaces`), the Explicit Retry release in the Run start (`releaseParkedPlaces`
 * behind `beginRun` with `retryParked`) and the `parked` flag of the Failure Record step
 * (`recordItemFailure`), against the Test Database (AL4 crawl-run1-fixes 1.3, 1.4.5, 1.4.6,
 * 1.4.8 `parked`, 1.5 "Run start with Explicit Retry", 2.4). AL3 routing
 * 20261022-crawl-run1-fixes-04-parking, section 2.1 B.
 *
 * Store-side stand-in for contract AC-29 .. AC-38 until the Run uses these steps (U6).
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Places are
 * seeded through the public Place Store (the Parking read joins `places`, so a Place is seeded
 * before Parking is expected). Runs are created through `beginRun`, Failure Records through
 * `recordItemFailure`. Release rows are checked with the Knex query builder on a tracked
 * `testDb()` handle (table names from `CRAWL_TABLES`, no raw SQL). Every repository result is
 * parsed with `storeResultSchema(...)` around a test-local schema of the AL4 1.3 types. All data
 * is synthetic, all moments are whole seconds. Every handle is closed in `afterEach`/`afterAll`.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { selectParkedPlaces, selectParkingRows } from '../../src/db/parking';
import type { BeginRunInput, CrawlRepository, ParkedPlace } from '../../src/db/types';
import {
  EmptyResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreUnavailableFailureSchema,
  storeResultSchema,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
  type WriteHook,
} from '../../contracts/storage.schema';
import {
  ABANDONMENT_AGE_SECONDS,
  CrawlProgressResultSchema,
  DuePlaceSchema,
  ItemFailureKindSchema,
  MomentSchema,
  RunIdSchema,
  ZERO_RUN_COUNTS,
  toMoment,
  type ItemFailureKind,
  type Moment,
} from '../../contracts/hydration.schema';
import {
  ExplicitRetriesResultSchema,
  FailureRecordsResultSchema,
  type CreateFailureAwareCrawlStoreFn,
  type ExplicitRetry,
  type FailureRecord,
} from '../../contracts/crawl-run1-fixes.schema';
import { CENTRAL_BELGRADE_POINT, RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import { UNREACHABLE_PASSWORD, requireTestDatabaseUrl } from '../../contracts/storage.support';
import type {
  BoundingBox,
  PlaceDetails,
  PlaceSummary,
} from '../../contracts/wikimapia-client.schema';

const create: CreateFailureAwareCrawlStoreFn = createCrawlStore;
type FailureAwareStore = ReturnType<CreateFailureAwareCrawlStoreFn>;

const REGION = 'test-one';
const OTHER_REGION = 'test-two';
const TILE_SIZE = { width: 0.005, height: 0.005 } as const;
const HOOK_SECRET_MESSAGE = `hook failed at postgres://wm_hook:${UNREACHABLE_PASSWORD}@127.0.0.1:5432/wm`;

/** West half of SMALL_BBOX: also holds the central point (20.457, 44.817). */
const WEST_HALF_BBOX: BoundingBox = { west: 20.452, south: 44.814, east: 20.458, north: 44.82 };
/** A point far outside SMALL_BBOX (inside the contract's REGION_FAR bbox). */
const FAR_POINT = { lon: 20.305, lat: 44.705 } as const;

// ---------------------------------------------------------------------------
// Test-local value schemas of the AL4 1.3 types (not contract schemas)
// ---------------------------------------------------------------------------

const ParkedPlaceSchema = z.strictObject({
  placeId: z.number().int().positive(),
  failureKind: ItemFailureKindSchema,
});

const FailureStepValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('recorded'), parked: ParkedPlaceSchema.optional() }),
  z.strictObject({ kind: z.literal('taken_over') }),
]);
const FailureStepResultSchema = storeResultSchema(FailureStepValueSchema);
type FailureStepResult = z.infer<typeof FailureStepResultSchema>;

const StartedSchema = z.object({
  kind: z.literal('started'),
  runId: RunIdSchema,
  abandonedRunIds: z.array(RunIdSchema),
  placesReleased: z.number().int().nonnegative(),
});
type Started = z.infer<typeof StartedSchema>;
const BeginRunValueSchema = z.discriminatedUnion('kind', [
  StartedSchema,
  z.strictObject({ kind: z.literal('run_in_progress'), runId: RunIdSchema, lastActivity: MomentSchema }),
  z.strictObject({ kind: z.literal('region_changed'), passNumber: z.number().int().min(1) }),
]);
const BeginRunResultSchema = storeResultSchema(BeginRunValueSchema);
const FinishResultSchema = storeResultSchema(z.strictObject({ updated: z.boolean() }));
const ParkedListResultSchema = storeResultSchema(z.array(ParkedPlaceSchema));
const DueListResultSchema = storeResultSchema(z.array(DuePlaceSchema));

const ReleaseRowsSchema = z.array(
  z.object({
    run_id: z.coerce.number().int(),
    place_id: z.coerce.number().int(),
    released_at: z.date(),
  }),
);
const CountRowsSchema = z.array(z.object({ n: z.coerce.number().int() }));

type Parsed<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
let placeStore: PlaceStore;
let crawlStore: FailureAwareStore;
let db: Knex;
const repositories: CrawlRepository[] = [];
const knexes: Knex[] = [];

function openRepo(onWrite?: WriteHook): CrawlRepository {
  const repo = openCrawlRepository({
    connectionString: requireTestDatabaseUrl(),
    ...(onWrite === undefined ? {} : { onWrite }),
  });
  repositories.push(repo);
  return repo;
}

function testDb(): Knex {
  const handle = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
  knexes.push(handle);
  return handle;
}

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: url });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  expect(applied.ok).toBe(true);
  placeStore = createPlaceStore({ connectionString: url });
  crawlStore = create({ connectionString: url });
  db = createDb(url, POOL_MAX_SETUP);
});

beforeEach(async () => {
  await emptyAll();
});

afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const handle of knexes.splice(0)) await destroyQuietly(handle);
});

afterAll(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const handle of knexes.splice(0)) await destroyQuietly(handle);
  await destroyQuietly(db);
  await crawlStore.close();
  await placeStore.close();
  await setup.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emptyAll(): Promise<void> {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
}

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

const T = (seconds: number): Moment => plusSeconds(RUN_START, seconds);
/** Start moments of later Runs: one per hour, so no earlier Run is ever live. */
const HOUR_N = (n: number): Moment => T(n * 3600);

function summary(placeId: number, lon: number, lat: number): PlaceSummary {
  return {
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic-place-${String(placeId)}`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

function syntheticPlaceDetails(placeId: number, lon: number, lat: number): PlaceDetails {
  return {
    placeId,
    title: `Synthetic place ${String(placeId)}`,
    description: `Synthetic description ${String(placeId)}.`,
    tags: [],
    isBuilding: false,
    isRegion: false,
    isDeleted: false,
    outline: [],
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    comments: [],
  };
}

async function seedSummaries(...places: PlaceSummary[]): Promise<void> {
  const result = SaveResultSchema.parse(
    await placeStore.saveListingPage({ page: 1, pageSize: 10, totalFound: places.length, places }),
  );
  expect(result.ok).toBe(true);
}

async function seedDetails(details: PlaceDetails, fetchedAt: Moment): Promise<void> {
  const result = SaveResultSchema.parse(await placeStore.savePlaceDetails({ details, fetchedAt }));
  expect(result.ok).toBe(true);
}

/** Summary-Only Places at the central point of SMALL_BBOX. */
async function seedCentral(...placeIds: number[]): Promise<void> {
  const p = CENTRAL_BELGRADE_POINT;
  await seedSummaries(...placeIds.map((id) => summary(id, p.lon, p.lat)));
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

async function beginResult(repo: CrawlRepository, overrides: Partial<BeginRunInput> = {}) {
  return BeginRunResultSchema.parse(await settle(repo.beginRun(beginInput(overrides))));
}

async function startRunAt(
  repo: CrawlRepository,
  startedAt: Moment,
  overrides: Partial<BeginRunInput> = {},
): Promise<Started> {
  const value = okValue(
    await beginResult(repo, { startedAt, abandonBefore: abandonBeforeFor(startedAt), ...overrides }),
  );
  if (value.kind !== 'started') throw new Error(`expected started, got ${value.kind}`);
  return value;
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
  failureKind: ItemFailureKind = 'wikimapia_error',
): FailureRecord {
  return {
    runId,
    item: { kind: 'place_details', placeId },
    failureKind,
    message: `Place ${String(placeId)}: synthetic ${failureKind}`,
    failedAt,
  };
}

function listingRecord(runId: number, failedAt: Moment): FailureRecord {
  return {
    runId,
    item: { kind: 'listing_page', tileNumber: 1, page: 1 },
    failureKind: 'wikimapia_error',
    message: 'Tile 1 page 1: synthetic wikimapia_error',
    failedAt,
  };
}

async function recordResult(repo: CrawlRepository, rec: FailureRecord): Promise<FailureStepResult> {
  return FailureStepResultSchema.parse(await settle(repo.recordItemFailure(rec)));
}

/** Records and expects exactly `{ kind: 'recorded' }` with no `parked` key. */
async function recordUnparked(repo: CrawlRepository, rec: FailureRecord): Promise<void> {
  const value = okValue(await recordResult(repo, rec));
  expect(value).toStrictEqual({ kind: 'recorded' });
  expect(Object.hasOwn(value, 'parked')).toBe(false);
}

/** Records and expects `{ kind: 'recorded', parked: { placeId, failureKind } }`. */
async function recordParked(
  repo: CrawlRepository,
  rec: FailureRecord,
  failureKind: ItemFailureKind,
): Promise<void> {
  if (rec.item.kind !== 'place_details') throw new Error('expected a Place record');
  expect(okValue(await recordResult(repo, rec))).toStrictEqual({
    kind: 'recorded',
    parked: { placeId: rec.item.placeId, failureKind },
  });
}

/**
 * One finished Run of `regionName` at `startedAt` that records 3 Wikimapia Errors for each of
 * `placeIds` (Parked afterwards when the Place is seeded). Returns the Run ID.
 */
async function parkInRun(
  repo: CrawlRepository,
  startedAt: Moment,
  placeIds: readonly number[],
  regionName: string = REGION,
): Promise<number> {
  const run = await startRunAt(repo, startedAt, { regionName });
  for (const placeId of placeIds) {
    for (const s of [10, 20, 30]) {
      expect((await recordResult(repo, placeRecord(run.runId, placeId, plusSeconds(startedAt, s)))).ok).toBe(true);
    }
  }
  await finishRun(repo, run.runId, plusSeconds(startedAt, 100));
  return run.runId;
}

async function parkedIn(bbox: BoundingBox): Promise<ParkedPlace[]> {
  return z.array(ParkedPlaceSchema).parse(await selectParkedPlaces(db, { bbox }));
}

async function parkedPlace(placeId: number): Promise<ParkedPlace[]> {
  return z.array(ParkedPlaceSchema).parse(await selectParkedPlaces(db, { placeId }));
}

async function listParked(repo: CrawlRepository, bbox: BoundingBox): Promise<ParkedPlace[]> {
  return okValue(ParkedListResultSchema.parse(await settle(repo.listParkedPlaces({ bbox }))));
}

async function readRetries(regionName: string): Promise<ExplicitRetry[]> {
  const result = ExplicitRetriesResultSchema.parse(
    await settle(crawlStore.readExplicitRetries({ regionName })),
  );
  return okValue(result).retries;
}

async function readRecords(placeId: number): Promise<FailureRecord[]> {
  const result = FailureRecordsResultSchema.parse(
    await settle(crawlStore.readFailureRecords({ placeId })),
  );
  return okValue(result).records;
}

async function releaseRows(): Promise<{ runId: number; placeId: number; releasedAt: Moment }[]> {
  const rows: unknown = await testDb()(CRAWL_TABLES.placeReleases)
    .select('run_id', 'place_id', 'released_at')
    .orderBy([{ column: 'place_id' }, { column: 'run_id' }]);
  return ReleaseRowsSchema.parse(rows).map((r) => ({
    runId: r.run_id,
    placeId: r.place_id,
    releasedAt: toMoment(r.released_at),
  }));
}

async function retryRowCount(): Promise<number> {
  const result: unknown = await testDb()(CRAWL_TABLES.explicitRetries).count({ n: '*' });
  const first = CountRowsSchema.parse(result)[0];
  if (first === undefined) throw new Error('count returned no row');
  return first.n;
}

async function runCount(regionName: string = REGION): Promise<number> {
  const result = CrawlProgressResultSchema.parse(
    await settle(crawlStore.readCrawlProgress({ regionName })),
  );
  return okValue(result).runs.length;
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

const P900_WIKIMAPIA: ParkedPlace = { placeId: 900, failureKind: 'wikimapia_error' };

// ===========================================================================
// B.1 Three Wikimapia Errors park the Place (AC-29, AC-30)
// ===========================================================================

describe('B.1 the third Wikimapia Error parks a seeded Place', () => {
  it('in one Run: records 1 and 2 have no parked key, the third and a fourth return parked', async () => {
    await seedCentral(900);
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    await recordUnparked(repo, placeRecord(run.runId, 900, T(10)));
    expect(await parkedPlace(900)).toStrictEqual([]);
    await recordUnparked(repo, placeRecord(run.runId, 900, T(20)));
    expect(await parkedPlace(900)).toStrictEqual([]);
    await recordParked(repo, placeRecord(run.runId, 900, T(30)), 'wikimapia_error');
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);
    await recordParked(repo, placeRecord(run.runId, 900, T(40)), 'wikimapia_error');
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);
  });

  it('across three Runs: the third Run’s record returns parked', async () => {
    await seedCentral(900);
    const repo = openRepo();
    for (const n of [0, 1, 2]) {
      const run = await startRunAt(repo, HOUR_N(n * 2));
      const rec = placeRecord(run.runId, 900, plusSeconds(HOUR_N(n * 2), 10));
      if (n < 2) await recordUnparked(repo, rec);
      else await recordParked(repo, rec, 'wikimapia_error');
      await finishRun(repo, run.runId, plusSeconds(HOUR_N(n * 2), 100));
    }
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);
    expect(await listParked(repo, SMALL_BBOX)).toStrictEqual([P900_WIKIMAPIA]);
  });

  it('a Place that is not in places is never Parked, however many records it has', async () => {
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    for (const s of [10, 20, 30, 40]) await recordUnparked(repo, placeRecord(run.runId, 777, T(s)));
    expect(await parkedPlace(777)).toStrictEqual([]);
    expect(await selectParkingRows(db, { placeId: 777 })).toStrictEqual([]);
  });

  it('selectParkingRows returns the rows of the AL4 statement, oldest first, with the reset inputs', async () => {
    await seedCentral(900);
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    // Inserted out of order: the read is ordered by failed_at.
    await recordUnparked(repo, placeRecord(run.runId, 900, T(30), 'invalid_data'));
    await recordUnparked(repo, placeRecord(run.runId, 900, T(10), 'connection'));
    const expectedRow = (failedAt: Moment, kind: ItemFailureKind) => ({
      run_id: run.runId,
      place_id: 900,
      failure_kind: kind,
      message: `Place 900: synthetic ${kind}`,
      failed_at_text: failedAt,
      details_fetched_at_text: null,
      released_at_text: null,
    });
    const expected = [expectedRow(T(10), 'connection'), expectedRow(T(30), 'invalid_data')];
    expect(await selectParkingRows(db, { placeId: 900 })).toStrictEqual(expected);
    expect(await selectParkingRows(db, { bbox: SMALL_BBOX })).toStrictEqual(expected);
  });

  it('selectParkingRows carries details_fetched_at_text of a Detailed Place', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedDetails(syntheticPlaceDetails(900, p.lon, p.lat), '2026-07-01T00:00:00Z');
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    await recordUnparked(repo, placeRecord(run.runId, 900, T(10)));
    const rows = await selectParkingRows(db, { placeId: 900 });
    expect(rows.map((r) => [r.details_fetched_at_text, r.released_at_text])).toStrictEqual([
      ['2026-07-01T00:00:00Z', null],
    ]);
  });

  it('selectParkingRows and selectParkedPlaces work on a transaction too', async () => {
    await seedCentral(900);
    const repo = openRepo();
    await parkInRun(repo, RUN_START, [900]);
    const [rows, parked] = await db.transaction(async (trx) => [
      await selectParkingRows(trx, { placeId: 900 }),
      await selectParkedPlaces(trx, { bbox: SMALL_BBOX }),
    ] as const);
    expect(rows).toHaveLength(3);
    expect(parked).toStrictEqual([P900_WIKIMAPIA]);
  });
});

// ===========================================================================
// B.2 Kinds (AC-31, AC-32)
// ===========================================================================

describe('B.2 which kinds park', () => {
  it('three connection records do not park', async () => {
    await seedCentral(900);
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    for (const s of [10, 20, 30, 40]) {
      await recordUnparked(repo, placeRecord(run.runId, 900, T(s), 'connection'));
    }
    expect(await parkedPlace(900)).toStrictEqual([]);
    expect(await selectParkingRows(db, { placeId: 900 })).toHaveLength(4);
  });

  it('three invalid_data records park with invalid_data', async () => {
    await seedCentral(901);
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    await recordUnparked(repo, placeRecord(run.runId, 901, T(10), 'invalid_data'));
    await recordUnparked(repo, placeRecord(run.runId, 901, T(20), 'invalid_data'));
    await recordParked(repo, placeRecord(run.runId, 901, T(30), 'invalid_data'), 'invalid_data');
    expect(await parkedPlace(901)).toStrictEqual([{ placeId: 901, failureKind: 'invalid_data' }]);
  });

  it.each(['wikimapia_error', 'unexpected_response'] as const)(
    'two plus two alternating kinds do not park; a fifth %s does',
    async (fifth) => {
      await seedCentral(900);
      const repo = openRepo();
      const run = await startRunAt(repo, RUN_START);
      const kinds: ItemFailureKind[] = [
        'wikimapia_error',
        'unexpected_response',
        'wikimapia_error',
        'unexpected_response',
      ];
      for (const [i, kind] of kinds.entries()) {
        await recordUnparked(repo, placeRecord(run.runId, 900, T(10 * (i + 1)), kind));
      }
      expect(await parkedPlace(900)).toStrictEqual([]);
      await recordParked(repo, placeRecord(run.runId, 900, T(50), fifth), fifth);
      expect(await parkedPlace(900)).toStrictEqual([{ placeId: 900, failureKind: fifth }]);
    },
  );
});

// ===========================================================================
// B.3 Listing records (AC-34)
// ===========================================================================

describe('B.3 Listing Page records never park', () => {
  it('three listing records return no parked key and are never parking rows', async () => {
    await seedCentral(900);
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(summary(1, p.lon, p.lat));
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    for (const s of [10, 20, 30]) await recordUnparked(repo, listingRecord(run.runId, T(s)));
    expect(await selectParkingRows(db, { bbox: SMALL_BBOX })).toStrictEqual([]);
    expect(await selectParkingRows(db, { placeId: 1 })).toStrictEqual([]);
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual([]);
  });
});

// ===========================================================================
// B.4 Count Reset by a Details Save (AC-33)
// ===========================================================================

describe('B.4 a Details Save resets the count', () => {
  it('two errors, a Details Save with a later fetchedAt, then one error: not Parked', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedCentral(900);
    const repo = openRepo();
    const run = await startRunAt(repo, RUN_START);
    await recordUnparked(repo, placeRecord(run.runId, 900, T(10)));
    await recordUnparked(repo, placeRecord(run.runId, 900, T(20)));
    await finishRun(repo, run.runId, T(100));

    await seedDetails(syntheticPlaceDetails(900, p.lon, p.lat), T(200));
    const next = await startRunAt(repo, HOUR_N(2));
    await recordUnparked(repo, placeRecord(next.runId, 900, plusSeconds(HOUR_N(2), 10)));
    expect(await parkedPlace(900)).toStrictEqual([]);
    // Two more after the save do park (the save resets, it does not forbid Parking).
    await recordUnparked(repo, placeRecord(next.runId, 900, plusSeconds(HOUR_N(2), 20)));
    await recordParked(repo, placeRecord(next.runId, 900, plusSeconds(HOUR_N(2), 30)), 'wikimapia_error');
  });

  it('a Place Parked while Summary-Only stays Parked across later Runs and Listing Saves until released', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedCentral(900);
    const repo = openRepo();
    await parkInRun(repo, RUN_START, [900]);
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);

    const later = await startRunAt(repo, HOUR_N(48));
    expect(later.placesReleased).toBe(0);
    await seedSummaries(summary(900, p.lon, p.lat));
    await finishRun(repo, later.runId, plusSeconds(HOUR_N(48), 100));
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual([P900_WIKIMAPIA]);
  });
});

// ===========================================================================
// B.5 Scope
// ===========================================================================

describe('B.5 scope of the Parking read', () => {
  it('a bbox returns only Parked Places whose Centre Point is inside it, edges included', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(
      summary(300, 20.452, 44.82), // north-west corner
      summary(403, 20.462, 44.814), // south-east corner
      summary(900, p.lon, p.lat),
      summary(501, 20.451999, p.lat), // a hair west
      summary(950, 20.47, 44.817), // outside
      summary(902, FAR_POINT.lon, FAR_POINT.lat),
    );
    await seedCentral(905); // inside, but not Parked
    const repo = openRepo();
    await parkInRun(repo, RUN_START, [300, 403, 900, 501, 950, 902]);
    const run = await startRunAt(repo, HOUR_N(2));
    await recordUnparked(repo, placeRecord(run.runId, 905, plusSeconds(HOUR_N(2), 10)));

    const expected: ParkedPlace[] = [300, 403, 900].map((placeId) => ({
      placeId,
      failureKind: 'wikimapia_error',
    }));
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual(expected);
    expect(await listParked(repo, SMALL_BBOX)).toStrictEqual(expected);
    expect((await selectParkingRows(db, { bbox: SMALL_BBOX })).map((r) => r.place_id)).toStrictEqual([
      300, 300, 300, 403, 403, 403, 900, 900, 900, 905,
    ]);
  });

  it('a placeId scope returns the one Place or []', async () => {
    await seedCentral(900, 901);
    await seedSummaries(summary(950, 20.47, 44.817));
    const repo = openRepo();
    await parkInRun(repo, RUN_START, [900, 950]);
    expect(await parkedPlace(950)).toStrictEqual([{ placeId: 950, failureKind: 'wikimapia_error' }]);
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);
    expect(await parkedPlace(901)).toStrictEqual([]);
    expect(await parkedPlace(123456)).toStrictEqual([]);
  });

  it('an empty store gives [] for both scopes', async () => {
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual([]);
    expect(await parkedPlace(900)).toStrictEqual([]);
    expect(await selectParkingRows(db, { bbox: SMALL_BBOX })).toStrictEqual([]);
  });
});

// ===========================================================================
// B.6 .. B.8 Explicit Retry release in beginRun (AC-37, AC-38)
// ===========================================================================

/** 900 and 901 Parked inside SMALL_BBOX, 902 Parked far outside; the seeding Run is finished. */
async function seedThreeParked(repo: CrawlRepository): Promise<void> {
  await seedCentral(900, 901);
  await seedSummaries(summary(902, FAR_POINT.lon, FAR_POINT.lat));
  await parkInRun(repo, RUN_START, [900, 901, 902]);
  expect((await parkedPlace(902)).length + (await parkedIn(SMALL_BBOX)).length).toBe(3);
}

const RETRY_AT = HOUR_N(3);

describe('B.6 beginRun with retryParked releases the Region’s Parked Places', () => {
  it('releases 900 and 901, keeps 902 Parked, keeps one retry and two release rows at startedAt', async () => {
    const repo = openRepo();
    await seedThreeParked(repo);

    const retry = await startRunAt(repo, RETRY_AT, { retryParked: true });
    expect(retry.placesReleased).toBe(2);
    expect(await readRetries(REGION)).toStrictEqual([
      { runId: retry.runId, regionName: REGION, retriedAt: RETRY_AT, placesReleased: 2 },
    ]);
    expect(await releaseRows()).toStrictEqual([
      { runId: retry.runId, placeId: 900, releasedAt: RETRY_AT },
      { runId: retry.runId, placeId: 901, releasedAt: RETRY_AT },
    ]);
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual([]);
    expect(await parkedPlace(900)).toStrictEqual([]);
    expect(await parkedPlace(901)).toStrictEqual([]);
    expect(await parkedPlace(902)).toStrictEqual([{ placeId: 902, failureKind: 'wikimapia_error' }]);
    expect(await readRetries(OTHER_REGION)).toStrictEqual([]);
  });

  it('the released Places are due again and carry released_at_text in their parking rows', async () => {
    const repo = openRepo();
    await seedThreeParked(repo);
    const before = okValue(
      DueListResultSchema.parse(
        await settle(repo.listPlacesDue({ bbox: SMALL_BBOX, dueBefore: RETRY_AT })),
      ),
    );
    expect(before).toStrictEqual([]);

    await startRunAt(repo, RETRY_AT, { retryParked: true });
    const after = okValue(
      DueListResultSchema.parse(
        await settle(repo.listPlacesDue({ bbox: SMALL_BBOX, dueBefore: RETRY_AT })),
      ),
    );
    expect(after).toStrictEqual([{ placeId: 900 }, { placeId: 901 }]);
    const rows = await selectParkingRows(db, { placeId: 900 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.released_at_text)).toStrictEqual([RETRY_AT, RETRY_AT, RETRY_AT]);
  });
});

describe('B.7 after a release the count starts again at startedAt (AC-38)', () => {
  it('one and two new errors do not park, the third does; the old records are kept', async () => {
    const repo = openRepo();
    await seedCentral(900);
    await parkInRun(repo, RUN_START, [900]);

    const retry = await startRunAt(repo, RETRY_AT, { retryParked: true });
    expect(retry.placesReleased).toBe(1);
    // Same second as the release: counts.
    await recordUnparked(repo, placeRecord(retry.runId, 900, RETRY_AT));
    expect(await parkedPlace(900)).toStrictEqual([]);
    await finishRun(repo, retry.runId, plusSeconds(RETRY_AT, 100));

    const second = await startRunAt(repo, HOUR_N(5));
    await recordUnparked(repo, placeRecord(second.runId, 900, plusSeconds(HOUR_N(5), 10)));
    await finishRun(repo, second.runId, plusSeconds(HOUR_N(5), 100));
    expect(await parkedPlace(900)).toStrictEqual([]);

    const third = await startRunAt(repo, HOUR_N(7));
    await recordParked(
      repo,
      placeRecord(third.runId, 900, plusSeconds(HOUR_N(7), 10)),
      'wikimapia_error',
    );
    expect(await parkedPlace(900)).toStrictEqual([P900_WIKIMAPIA]);
    expect(await readRecords(900)).toHaveLength(6);
  });
});

describe('B.8 retries with nothing to release, and starts without the option', () => {
  it('retryParked: true with no Parked Place keeps one retry with placesReleased 0 and no release row', async () => {
    await seedCentral(900);
    const repo = openRepo();
    const run = await startRunAt(repo, RETRY_AT, { retryParked: true });
    expect(run.placesReleased).toBe(0);
    expect(await readRetries(REGION)).toStrictEqual([
      { runId: run.runId, regionName: REGION, retriedAt: RETRY_AT, placesReleased: 0 },
    ]);
    expect(await releaseRows()).toStrictEqual([]);
  });

  it('retryParked: true with only a Parked Place outside the Region releases nothing', async () => {
    const repo = openRepo();
    await seedSummaries(summary(902, FAR_POINT.lon, FAR_POINT.lat));
    await parkInRun(repo, RUN_START, [902]);
    const run = await startRunAt(repo, RETRY_AT, { retryParked: true });
    expect(run.placesReleased).toBe(0);
    expect(await releaseRows()).toStrictEqual([]);
    expect(await retryRowCount()).toBe(1);
    expect(await parkedPlace(902)).toHaveLength(1);
  });

  it('retryParked: false keeps no retry row, returns placesReleased 0 and leaves Parked Places Parked', async () => {
    const repo = openRepo();
    await seedThreeParked(repo);
    const run = await startRunAt(repo, RETRY_AT, { retryParked: false });
    expect(run.placesReleased).toBe(0);
    expect(await retryRowCount()).toBe(0);
    expect(await releaseRows()).toStrictEqual([]);
    expect((await parkedIn(SMALL_BBOX)).map((p) => p.placeId)).toStrictEqual([900, 901]);
  });

  it('a second retry with nothing left to release keeps a second retry row with 0', async () => {
    const repo = openRepo();
    await seedThreeParked(repo);
    const first = await startRunAt(repo, RETRY_AT, { retryParked: true });
    await finishRun(repo, first.runId, plusSeconds(RETRY_AT, 100));
    const second = await startRunAt(repo, HOUR_N(5), { retryParked: true });
    expect(second.placesReleased).toBe(0);
    expect(await readRetries(REGION)).toStrictEqual([
      { runId: first.runId, regionName: REGION, retriedAt: RETRY_AT, placesReleased: 2 },
      { runId: second.runId, regionName: REGION, retriedAt: HOUR_N(5), placesReleased: 0 },
    ]);
    expect((await releaseRows()).map((r) => r.runId)).toStrictEqual([first.runId, first.runId]);
  });
});

// ===========================================================================
// B.9 Refused starts keep nothing
// ===========================================================================

describe('B.9 a refused start with retryParked keeps no retry and releases nothing', () => {
  it('run_in_progress', async () => {
    await seedCentral(900, 901);
    const repo = openRepo();
    const live = await startRunAt(repo, RUN_START);
    for (const placeId of [900, 901]) {
      for (const s of [10, 20, 30]) {
        expect((await recordResult(repo, placeRecord(live.runId, placeId, T(s)))).ok).toBe(true);
      }
    }
    const value = okValue(
      await beginResult(repo, {
        startedAt: T(60),
        abandonBefore: abandonBeforeFor(T(60)),
        retryParked: true,
      }),
    );
    expect(value.kind).toBe('run_in_progress');
    expect(await retryRowCount()).toBe(0);
    expect(await releaseRows()).toStrictEqual([]);
    expect((await parkedIn(SMALL_BBOX)).map((p) => p.placeId)).toStrictEqual([900, 901]);
  });

  it('region_changed', async () => {
    await seedCentral(900, 901);
    const repo = openRepo();
    // Pass 1 of tileCount 1 stays incomplete (no Finished Page).
    await parkInRun(repo, RUN_START, [900, 901]);
    const value = okValue(
      await beginResult(repo, {
        startedAt: RETRY_AT,
        abandonBefore: abandonBeforeFor(RETRY_AT),
        tileCount: 2,
        retryParked: true,
      }),
    );
    expect(value).toStrictEqual({ kind: 'region_changed', passNumber: 1 });
    expect(await retryRowCount()).toBe(0);
    expect(await releaseRows()).toStrictEqual([]);
    expect((await parkedIn(SMALL_BBOX)).map((p) => p.placeId)).toStrictEqual([900, 901]);
  });
});

// ===========================================================================
// B.10 Write hook
// ===========================================================================

/** Writes made by one `beginRun` at RETRY_AT after seeding `parkedIds` (fresh store). */
async function startWrites(parkedIds: readonly number[], retryParked: boolean): Promise<number> {
  await emptyAll();
  const seeder = openRepo();
  await seedCentral(900, 901);
  if (parkedIds.length > 0) await parkInRun(seeder, RUN_START, parkedIds);
  else {
    const run = await startRunAt(seeder, RUN_START);
    await finishRun(seeder, run.runId, T(100));
  }
  const rec = recorder();
  const repo = openRepo(rec.hook);
  const run = await startRunAt(repo, RETRY_AT, { retryParked });
  expect(run.placesReleased).toBe(retryParked ? parkedIds.length : 0);
  return rec.numbers.length;
}

describe('B.10 write hook', () => {
  it('with 2 Parked Places the option adds exactly 2 writes (retry row, release rows)', async () => {
    const without = await startWrites([900, 901], false);
    const withOption = await startWrites([900, 901], true);
    expect(withOption - without).toBe(2);
  });

  it('with 0 Parked Places the option adds exactly 1 write (the retry row)', async () => {
    const without = await startWrites([], false);
    const withOption = await startWrites([], true);
    expect(withOption - without).toBe(1);
  });

  it('the hook numbers the start writes 1, 2, 3 in order (Run Record, retry row, releases)', async () => {
    const seeder = openRepo();
    await seedCentral(900, 901);
    await parkInRun(seeder, RUN_START, [900, 901]);
    const rec = recorder();
    const repo = openRepo(rec.hook);
    await startRunAt(repo, RETRY_AT, { retryParked: true });
    // The pass is resumed (no pass insert), and no Run is abandoned.
    expect(rec.numbers).toStrictEqual([1, 2, 3]);
  });

  it.each([
    ['the retry-row write', 2],
    ['the release-rows write', 3],
  ])('a hook that throws on %s rolls the whole start back', async (_label, failAt) => {
    const seeder = openRepo();
    await seedCentral(900, 901);
    await parkInRun(seeder, RUN_START, [900, 901]);
    const runsBefore = await runCount();

    const repo = openRepo((n) => {
      if (n === failAt) throw new Error(HOOK_SECRET_MESSAGE);
    });
    const result = await beginResult(repo, {
      startedAt: RETRY_AT,
      abandonBefore: abandonBeforeFor(RETRY_AT),
      retryParked: true,
    });
    const failure = failureOf(result);
    StoreUnavailableFailureSchema.parse(failure);
    expect(failure.kind).toBe('store_unavailable');
    expectNoSecrets(failure);
    expect(await runCount()).toBe(runsBefore);
    expect(await retryRowCount()).toBe(0);
    expect(await releaseRows()).toStrictEqual([]);
    expect((await parkedIn(SMALL_BBOX)).map((p) => p.placeId)).toStrictEqual([900, 901]);
  });
});

// ===========================================================================
// B.11 Parking belongs to the Place (AC-36)
// ===========================================================================

describe('B.11 a Place in two Regions is released by a retry of either', () => {
  it.each([
    [REGION, SMALL_BBOX],
    [OTHER_REGION, WEST_HALF_BBOX],
  ] as const)('a retry of %s releases 900', async (regionName, bbox) => {
    await seedCentral(900);
    const repo = openRepo();
    // Parked by a Run of the other Region.
    await parkInRun(repo, RUN_START, [900], regionName === REGION ? OTHER_REGION : REGION);
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual([P900_WIKIMAPIA]);
    expect(await parkedIn(WEST_HALF_BBOX)).toStrictEqual([P900_WIKIMAPIA]);

    const retry = await startRunAt(repo, RETRY_AT, { regionName, bbox, retryParked: true });
    expect(retry.placesReleased).toBe(1);
    expect(await parkedIn(SMALL_BBOX)).toStrictEqual([]);
    expect(await parkedIn(WEST_HALF_BBOX)).toStrictEqual([]);
    expect(await readRetries(regionName)).toStrictEqual([
      { runId: retry.runId, regionName, retriedAt: RETRY_AT, placesReleased: 1 },
    ]);
  });
});
