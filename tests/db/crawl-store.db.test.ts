/**
 * AL2 unit tests: `src/db/crawl-store.ts` (public `createCrawlStore`) and the current-pass read
 * of `src/db/crawl-progress.ts` (`readCurrentPass`) against the Test Database (AL4 hydration
 * 1.3, 1.4.6 "PassState query", 1.4.11 Public Crawl Store, 1.5 "Reads", 2.2 .. 2.4). AL3 routing
 * 20261022-hydration-03-store-read, section 2.1 B.
 *
 * Module-level stand-in for contract R1, AC-53 and AC-58 (read side) until
 * `contracts/hydration.test.ts` can load (U7).
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`) and the contract's unreachable
 * URL. Places go in through the public Place Store. Crawl Progress rows are seeded through the
 * Knex query builder on a tracked `testDb()` handle (table names from `CRAWL_TABLES`, no raw
 * SQL). Every store result is parsed with its contract result schema before asserting. Every
 * store, setup and Knex handle is closed in `afterEach`/`afterAll`.
 */
import type { Knex } from 'knex';
import { createCrawlStore } from '../../src/db/crawl-store';
import { readCurrentPass } from '../../src/db/crawl-progress';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import {
  EmptyResultSchema,
  InvalidDataFailureSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
} from '../../contracts/storage.schema';
import {
  CrawlProgressResultSchema,
  CrawlProgressViewSchema,
  FinishedPageSchema,
  ItemFailureCountsSchema,
  ListingPassSchema,
  PlacesDueResultSchema,
  RunCountsSchema,
  RunRecordSchema,
  TileSizeSchema,
  ZERO_RUN_COUNTS,
  type CrawlProgressInput,
  type CrawlProgressView,
  type CrawlStore,
  type CreateCrawlStoreFn,
  type DuePlace,
  type PlacesDueInput,
  type RunCounts,
} from '../../contracts/hydration.schema';
import {
  CENTRAL_BELGRADE_POINT,
  RUN_START,
  SMALL_BBOX,
} from '../../contracts/hydration.support';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  clientDetails,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import {
  BoundingBoxSchema,
  type PlaceDetails,
  type PlaceSummary,
} from '../../contracts/wikimapia-client.schema';

// Compile-time check: the entry point has the contract's signature.
const create: CreateCrawlStoreFn = createCrawlStore;

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const READ_BACK_FAILED_MESSAGE = 'Place Store unavailable: stored data failed the read-back check';
const UNREACHABLE_TIMEOUT_MS = 60_000;

type Parsed = { ok: true; value: unknown } | { ok: false; failure: StoreFailure };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
let placeStore: PlaceStore;
let crawlStore: CrawlStore;
const extraStores: CrawlStore[] = [];
const knexes: Knex[] = [];

function trackStore(store: CrawlStore): CrawlStore {
  extraStores.push(store);
  return store;
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
  placeStore = createPlaceStore({ connectionString: url });
  crawlStore = create({ connectionString: url });
});

beforeEach(async () => {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
});

afterEach(async () => {
  for (const s of extraStores.splice(0)) await s.close();
  for (const db of knexes.splice(0)) await destroyQuietly(db);
});

afterAll(async () => {
  await crawlStore.close();
  await placeStore.close();
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

function failureOf(result: Parsed): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

function okValue<T>(result: { ok: true; value: T } | { ok: false; failure: StoreFailure }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.failure.kind}`);
  return result.value;
}

async function due(store: CrawlStore, input: PlacesDueInput) {
  return PlacesDueResultSchema.parse(await settle(store.listPlacesDueForDetails(input)));
}

async function progressResult(store: CrawlStore, input: CrawlProgressInput) {
  return CrawlProgressResultSchema.parse(await settle(store.readCrawlProgress(input)));
}

async function progress(regionName: string): Promise<CrawlProgressView> {
  return okValue(await progressResult(crawlStore, { regionName }));
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
}

/** A Place Summary as the Client returns it (synthetic, point-sized). */
function summary(placeId: number, lon: number, lat: number): PlaceSummary {
  return {
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic-place-${String(placeId)}`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

/** Place Details as the Client returns them (synthetic, point-sized). */
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

async function seedDetails(details: PlaceDetails, fetchedAt: string): Promise<void> {
  const result = SaveResultSchema.parse(await placeStore.savePlaceDetails({ details, fetchedAt }));
  expect(result.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Synthetic Crawl Progress (seeded through the Knex builder; whole-second UTC moments)
// ---------------------------------------------------------------------------

/** Non-zero counts that pass `RunCountsSchema` (7 = 3 + 4, 1 failure = sum by kind, ...). */
const NONZERO_COUNTS: RunCounts = RunCountsSchema.parse({
  wikimapiaRequests: 7,
  listingRequests: 3,
  detailsRequests: 4,
  rateLimitWaits: 1,
  rateLimitWaitSeconds: 12.5,
  listingPagesSaved: 3,
  tilesFinished: 2,
  tilesUnfinished: 0,
  placesListed: 5,
  placesNewlyStored: 4,
  detailsSaved: 4,
  detailsChanged: 3,
  placesStillDue: 1,
  itemFailures: 1,
  itemFailuresByKind: {
    connection: 1,
    wikimapia_error: 0,
    unexpected_response: 0,
    invalid_request: 0,
    invalid_data: 0,
  },
});

interface RunSeed {
  run_id: number;
  region_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_activity: string;
  counts: string;
}

interface PassSeed {
  region_name: string;
  pass_number: number;
  bbox_west: number;
  bbox_south: number;
  bbox_east: number;
  bbox_north: number;
  tile_width: number;
  tile_height: number;
  tile_count: number;
  started_by_run_id: number;
  started_at: string;
}

interface PageSeed {
  region_name: string;
  pass_number: number;
  tile_number: number;
  page_no: number;
  run_id: number;
  place_count: number;
  is_short: boolean;
  reported_total: number | null;
  finished_at: string;
}

const RUN_1 = 101;
const RUN_2 = 102;
const RUN_3 = 103;
const RUN_OTHER = 201;

const RUNS: Record<'one1' | 'one2' | 'one3' | 'two', RunSeed> = {
  one1: {
    run_id: RUN_1,
    region_name: 'test-one',
    status: 'completed',
    started_at: '2026-10-01T08:00:00Z',
    ended_at: '2026-10-01T09:00:00Z',
    last_activity: '2026-10-01T09:00:00Z',
    counts: JSON.stringify(NONZERO_COUNTS),
  },
  one2: {
    run_id: RUN_2,
    region_name: 'test-one',
    status: 'abandoned',
    started_at: '2026-10-02T08:00:00Z',
    ended_at: null,
    last_activity: '2026-10-02T08:30:00Z',
    counts: JSON.stringify(ZERO_RUN_COUNTS),
  },
  one3: {
    run_id: RUN_3,
    region_name: 'test-one',
    status: 'in_progress',
    started_at: RUN_START,
    ended_at: null,
    last_activity: '2026-10-22T09:05:00Z',
    counts: JSON.stringify(ZERO_RUN_COUNTS),
  },
  two: {
    run_id: RUN_OTHER,
    region_name: 'test-two',
    status: 'completed',
    started_at: '2026-10-03T10:00:00Z',
    ended_at: '2026-10-03T10:30:00Z',
    last_activity: '2026-10-03T10:30:00Z',
    counts: JSON.stringify(ZERO_RUN_COUNTS),
  },
};

function passSeed(
  regionName: string,
  passNumber: number,
  tile: { width: number; height: number },
  tileCount: number,
  runId: number,
  startedAt: string,
): PassSeed {
  return {
    region_name: regionName,
    pass_number: passNumber,
    bbox_west: SMALL_BBOX.west,
    bbox_south: SMALL_BBOX.south,
    bbox_east: SMALL_BBOX.east,
    bbox_north: SMALL_BBOX.north,
    tile_width: tile.width,
    tile_height: tile.height,
    tile_count: tileCount,
    started_by_run_id: runId,
    started_at: startedAt,
  };
}

const PASS_1 = passSeed('test-one', 1, { width: 0.006, height: 0.02 }, 2, RUN_1, '2026-10-01T08:00:00Z');
const PASS_2 = passSeed('test-one', 2, { width: 0.006, height: 0.004 }, 4, RUN_3, RUN_START);
const PASS_OTHER = passSeed('test-two', 1, { width: 0.02, height: 0.02 }, 1, RUN_OTHER, '2026-10-03T10:00:00Z');

function pageSeed(
  regionName: string,
  passNumber: number,
  tileNumber: number,
  pageNo: number,
  runId: number,
  placeCount: number,
  isShort: boolean,
  reportedTotal: number | null,
  finishedAt: string,
): PageSeed {
  return {
    region_name: regionName,
    pass_number: passNumber,
    tile_number: tileNumber,
    page_no: pageNo,
    run_id: runId,
    place_count: placeCount,
    is_short: isShort,
    reported_total: reportedTotal,
    finished_at: finishedAt,
  };
}

/** Pass 1: tile 1 pages 1 and 2 (short on 2), tile 2 short page 1 (reported_total null). */
const PASS_1_PAGES: readonly PageSeed[] = [
  pageSeed('test-one', 1, 1, 1, RUN_1, 10, false, 25, '2026-10-01T08:10:00Z'),
  pageSeed('test-one', 1, 1, 2, RUN_1, 5, true, 25, '2026-10-01T08:20:00Z'),
  pageSeed('test-one', 1, 2, 1, RUN_1, 3, true, null, '2026-10-01T08:30:00Z'),
];

/** Pass 2: tile 3 pages 1 and 2 not short (unfinished), tile 2 short page 1 (finished). */
const PASS_2_PAGES: readonly PageSeed[] = [
  pageSeed('test-one', 2, 3, 1, RUN_3, 10, false, 40, '2026-10-22T09:01:00Z'),
  pageSeed('test-one', 2, 3, 2, RUN_3, 10, false, 40, '2026-10-22T09:02:00Z'),
  pageSeed('test-one', 2, 2, 1, RUN_3, 4, true, 4, '2026-10-22T09:03:00Z'),
];

const PAGE_OTHER = pageSeed('test-two', 1, 1, 1, RUN_OTHER, 2, true, 2, '2026-10-03T10:10:00Z');

/** Rows in the order given (deliberately not the read order). */
async function insertRows(table: string, rows: readonly object[]): Promise<void> {
  const db = testDb();
  for (const row of rows) await db(table).insert(row);
}

/** The full seed of 2.1 B.7, inserted out of order. */
async function seedProgress(): Promise<void> {
  await insertRows(CRAWL_TABLES.runs, [RUNS.one3, RUNS.two, RUNS.one1, RUNS.one2]);
  await insertRows(CRAWL_TABLES.passes, [PASS_2, PASS_OTHER, PASS_1]);
  const [p1t1a, p1t1b, p1t2] = PASS_1_PAGES;
  const [p2t3a, p2t3b, p2t2] = PASS_2_PAGES;
  await insertRows(CRAWL_TABLES.finishedPages, [
    p2t3b,
    p1t2,
    PAGE_OTHER,
    p2t2,
    p1t1b,
    p2t3a,
    p1t1a,
  ].filter((r): r is PageSeed => r !== undefined));
}

/** Only pass 1 of `test-one` (with its Run). */
async function seedPassOneOnly(): Promise<void> {
  await insertRows(CRAWL_TABLES.runs, [RUNS.one1]);
  await insertRows(CRAWL_TABLES.passes, [PASS_1]);
  await insertRows(CRAWL_TABLES.finishedPages, [...PASS_1_PAGES].reverse());
}

const EXPECTED_PASS_1 = {
  passNumber: 1,
  regionName: 'test-one',
  bbox: SMALL_BBOX,
  tileSize: { width: 0.006, height: 0.02 },
  tileCount: 2,
  complete: true,
  finishedTiles: [1, 2],
  finishedPages: [
    { tileNumber: 1, page: 1, runId: RUN_1, placeCount: 10, short: false, totalFound: 25 },
    { tileNumber: 1, page: 2, runId: RUN_1, placeCount: 5, short: true, totalFound: 25 },
    { tileNumber: 2, page: 1, runId: RUN_1, placeCount: 3, short: true },
  ],
};

const EXPECTED_PASS_2 = {
  passNumber: 2,
  regionName: 'test-one',
  bbox: SMALL_BBOX,
  tileSize: { width: 0.006, height: 0.004 },
  tileCount: 4,
  complete: false,
  finishedTiles: [2],
  finishedPages: [
    { tileNumber: 2, page: 1, runId: RUN_3, placeCount: 4, short: true, totalFound: 4 },
    { tileNumber: 3, page: 1, runId: RUN_3, placeCount: 10, short: false, totalFound: 40 },
    { tileNumber: 3, page: 2, runId: RUN_3, placeCount: 10, short: false, totalFound: 40 },
  ],
};

const EXPECTED_RUNS = [
  {
    runId: RUN_1,
    regionName: 'test-one',
    status: 'completed',
    startedAt: '2026-10-01T08:00:00Z',
    endedAt: '2026-10-01T09:00:00Z',
    lastActivity: '2026-10-01T09:00:00Z',
    counts: NONZERO_COUNTS,
  },
  {
    runId: RUN_2,
    regionName: 'test-one',
    status: 'abandoned',
    startedAt: '2026-10-02T08:00:00Z',
    lastActivity: '2026-10-02T08:30:00Z',
    counts: ZERO_RUN_COUNTS,
  },
  {
    runId: RUN_3,
    regionName: 'test-one',
    status: 'in_progress',
    startedAt: RUN_START,
    lastActivity: '2026-10-22T09:05:00Z',
    counts: ZERO_RUN_COUNTS,
  },
];

// ---------------------------------------------------------------------------
// 1. Entry point
// ---------------------------------------------------------------------------

describe('createCrawlStore', () => {
  it('has the contract signature and exposes the three methods', () => {
    const store = trackStore(create({ connectionString: requireTestDatabaseUrl() }));
    expect(typeof store.listPlacesDueForDetails).toBe('function');
    expect(typeof store.readCrawlProgress).toBe('function');
    expect(typeof store.close).toBe('function');
  });

  it('never throws, whatever the connection string', () => {
    for (const connectionString of ['', UNREACHABLE_DATABASE_URL, 'not a url', ' ']) {
      expect(() => trackStore(create({ connectionString }))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. listPlacesDueForDetails (R1)
// ---------------------------------------------------------------------------

describe('listPlacesDueForDetails', () => {
  it('returns the R1 order for a smaller R1 seed, with exactly the key `places`', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(
      summary(900, p.lon, p.lat),
      summary(300, 20.452, 44.82),
      summary(950, 20.47, 44.817),
    );
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-08-01T00:00:00Z');
    await seedDetails(syntheticPlaceDetails(700, p.lon, p.lat), '2026-07-01T00:00:00Z');
    await seedDetails(syntheticPlaceDetails(800, p.lon, p.lat), '2026-09-22T09:00:00Z');

    const value = okValue(await due(crawlStore, { bbox: SMALL_BBOX, dueBefore: '2026-09-22T09:00:00Z' }));
    expect(Object.keys(value)).toStrictEqual(['places']);
    const expected: DuePlace[] = [
      { placeId: 300 },
      { placeId: 900 },
      { placeId: 700, detailsFetchedAt: '2026-07-01T00:00:00Z' },
      { placeId: 62587, detailsFetchedAt: '2026-08-01T00:00:00Z' },
    ];
    expect(value.places).toStrictEqual(expected);
  });

  it('an empty store gives { places: [] }', async () => {
    expect(okValue(await due(crawlStore, { bbox: SMALL_BBOX, dueBefore: RUN_START }))).toStrictEqual({
      places: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid input: invalid_data, validated before any DB access
// ---------------------------------------------------------------------------

interface InvalidCall {
  label: string;
  run: (store: CrawlStore) => Promise<Parsed>;
}

const REVERSED_BBOX = { west: SMALL_BBOX.east, south: SMALL_BBOX.south, east: SMALL_BBOX.west, north: SMALL_BBOX.north };

function dueWithExtraKey(): PlacesDueInput {
  const input = { bbox: SMALL_BBOX, dueBefore: RUN_START, extra: 1 };
  return input;
}

function progressWithExtraKey(): CrawlProgressInput {
  const input = { regionName: 'test-one', extra: 1 };
  return input;
}

const INVALID_CALLS: readonly InvalidCall[] = [
  {
    label: "dueBefore 'yesterday'",
    run: (store) => due(store, { bbox: SMALL_BBOX, dueBefore: 'yesterday' }),
  },
  {
    label: 'dueBefore with milliseconds',
    run: (store) => due(store, { bbox: SMALL_BBOX, dueBefore: '2026-10-22T09:00:00.000Z' }),
  },
  {
    label: 'reversed bbox (west > east)',
    run: (store) => due(store, { bbox: REVERSED_BBOX, dueBefore: RUN_START }),
  },
  {
    label: 'missing bbox',
    run: (store) => due(store, { dueBefore: RUN_START } as never),
  },
  {
    label: 'extra key on the places-due input',
    run: (store) => due(store, dueWithExtraKey()),
  },
  ...['Belgrade', '', 'a b'].map(
    (regionName): InvalidCall => ({
      label: `readCrawlProgress regionName ${JSON.stringify(regionName)}`,
      run: (store) => progressResult(store, { regionName }),
    }),
  ),
  {
    label: 'extra key on the progress input',
    run: (store) => progressResult(store, progressWithExtraKey()),
  },
];

describe('invalid input is invalid_data and never reaches the database', () => {
  const stores: [string, () => string][] = [
    ['the Test Database', () => requireTestDatabaseUrl()],
    ['an unreachable database', () => UNREACHABLE_DATABASE_URL],
    ['a not-configured store', () => ''],
  ];

  for (const [storeLabel, url] of stores) {
    describe(`on ${storeLabel}`, () => {
      it.each(INVALID_CALLS.map((c) => [c.label, c] as const))(
        '%s',
        async (_label, call) => {
          const store = trackStore(create({ connectionString: url() }));
          const failure = failureOf(await call.run(store));
          expect(failure.kind).toBe('invalid_data');
          expect(InvalidDataFailureSchema.safeParse(failure).success).toBe(true);
        },
      );
    });
  }

  it("the failure for dueBefore 'yesterday' does not echo the value", async () => {
    const failure = failureOf(await due(crawlStore, { bbox: SMALL_BBOX, dueBefore: 'yesterday' }));
    expect(JSON.stringify(failure)).not.toContain('yesterday');
  });

  it('invalid input leaves the database untouched', async () => {
    for (const call of INVALID_CALLS) await call.run(crawlStore);
    expect(await progress('test-one')).toStrictEqual({ regionName: 'test-one', passes: [], runs: [] });
  });
});

// ---------------------------------------------------------------------------
// 4. Not configured
// ---------------------------------------------------------------------------

describe('a not-configured store', () => {
  it('gives store_unavailable with the fixed message for both methods', async () => {
    const store = trackStore(create({ connectionString: '' }));
    const listFailure = failureOf(await due(store, { bbox: SMALL_BBOX, dueBefore: RUN_START }));
    expect(listFailure).toStrictEqual({ kind: 'store_unavailable', message: NOT_CONFIGURED_MESSAGE });
    const readFailure = failureOf(await progressResult(store, { regionName: 'test-one' }));
    expect(readFailure).toStrictEqual({ kind: 'store_unavailable', message: NOT_CONFIGURED_MESSAGE });
  });

  it('close() resolves, twice', async () => {
    const store = create({ connectionString: '' });
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('close() of a configured store resolves twice as well', async () => {
    const store = create({ connectionString: requireTestDatabaseUrl() });
    expect(okValue(await progressResult(store, { regionName: 'test-one' })).runs).toStrictEqual([]);
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Unreachable database
// ---------------------------------------------------------------------------

describe('an unreachable database', () => {
  it(
    'gives store_unavailable for both methods without password or connection string',
    async () => {
      const store = trackStore(create({ connectionString: UNREACHABLE_DATABASE_URL }));
      const listFailure = failureOf(await due(store, { bbox: SMALL_BBOX, dueBefore: RUN_START }));
      expect(listFailure.kind).toBe('store_unavailable');
      expectNoSecrets(JSON.stringify(listFailure));
      const readFailure = failureOf(await progressResult(store, { regionName: 'test-one' }));
      expect(readFailure.kind).toBe('store_unavailable');
      expectNoSecrets(JSON.stringify(readFailure));
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 6. Empty Region
// ---------------------------------------------------------------------------

describe('readCrawlProgress of a Region with nothing stored', () => {
  it('is { regionName, passes: [], runs: [] }', async () => {
    expect(await progress('test-one')).toStrictEqual({
      regionName: 'test-one',
      passes: [],
      runs: [],
    });
  });

  it('stays empty for a Region when only another Region has progress', async () => {
    await seedProgress();
    expect(await progress('test-far')).toStrictEqual({
      regionName: 'test-far',
      passes: [],
      runs: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Seeded Crawl Progress (AC-53 read side)
// ---------------------------------------------------------------------------

describe('readCrawlProgress of seeded Crawl Progress', () => {
  it('passes CrawlProgressViewSchema and equals the expected view', async () => {
    await seedProgress();
    const view = await progress('test-one');
    expect(CrawlProgressViewSchema.safeParse(view).success).toBe(true);
    expect(view).toStrictEqual({
      regionName: 'test-one',
      passes: [EXPECTED_PASS_1, EXPECTED_PASS_2],
      runs: EXPECTED_RUNS,
    });
  });

  it('lists only this Region\'s Runs, in runId order', async () => {
    await seedProgress();
    const view = await progress('test-one');
    expect(view.runs.map((r) => r.runId)).toStrictEqual([RUN_1, RUN_2, RUN_3]);
    expect(view.runs.every((r) => r.regionName === 'test-one')).toBe(true);
  });

  it('endedAt is present only for the completed Run', async () => {
    await seedProgress();
    const view = await progress('test-one');
    const byStatus = new Map(view.runs.map((r) => [r.status, r]));
    expect(Object.hasOwn(byStatus.get('completed') ?? {}, 'endedAt')).toBe(true);
    expect(byStatus.get('completed')?.endedAt).toBe('2026-10-01T09:00:00Z');
    expect(Object.hasOwn(byStatus.get('abandoned') ?? { endedAt: 'x' }, 'endedAt')).toBe(false);
    expect(Object.hasOwn(byStatus.get('in_progress') ?? { endedAt: 'x' }, 'endedAt')).toBe(false);
  });

  it('moments are whole-second Z text and counts round-trip', async () => {
    await seedProgress();
    const view = await progress('test-one');
    const wholeSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    for (const run of view.runs) {
      expect(run.startedAt).toMatch(wholeSecond);
      expect(run.lastActivity).toMatch(wholeSecond);
      if (run.endedAt !== undefined) expect(run.endedAt).toMatch(wholeSecond);
    }
    expect(view.runs.map((r) => r.counts)).toStrictEqual([
      NONZERO_COUNTS,
      ZERO_RUN_COUNTS,
      ZERO_RUN_COUNTS,
    ]);
  });

  it('passes are in passNumber order with the stored bbox, Tile Size and Tile Count', async () => {
    await seedProgress();
    const view = await progress('test-one');
    expect(view.passes.map((p) => p.passNumber)).toStrictEqual([1, 2]);
    for (const pass of view.passes) {
      expect(pass.regionName).toBe('test-one');
      expect(pass.bbox).toStrictEqual(SMALL_BBOX);
    }
    expect(view.passes.map((p) => [p.tileSize, p.tileCount])).toStrictEqual([
      [{ width: 0.006, height: 0.02 }, 2],
      [{ width: 0.006, height: 0.004 }, 4],
    ]);
  });

  it('finishedPages are ordered by tile then page; totalFound only when not null', async () => {
    await seedProgress();
    const view = await progress('test-one');
    for (const pass of view.passes) {
      const order = pass.finishedPages.map((p) => [p.tileNumber, p.page]);
      const sorted = [...order].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
      expect(order).toStrictEqual(sorted);
    }
    const pass1 = view.passes[0];
    if (pass1 === undefined) throw new Error('no pass 1');
    const nullTotal = pass1.finishedPages.find((p) => p.tileNumber === 2 && p.page === 1);
    expect(nullTotal).toBeDefined();
    expect(Object.keys(nullTotal ?? {}).sort()).toStrictEqual(
      ['tileNumber', 'page', 'runId', 'placeCount', 'short'].sort(),
    );
    const withTotal = pass1.finishedPages.find((p) => p.tileNumber === 1 && p.page === 1);
    expect(Object.keys(withTotal ?? {}).sort()).toStrictEqual(
      ['tileNumber', 'page', 'runId', 'placeCount', 'short', 'totalFound'].sort(),
    );
  });

  it('finishedTiles are the tiles with a short page, ascending; complete is derived', async () => {
    await seedProgress();
    const view = await progress('test-one');
    expect(view.passes.map((p) => [p.finishedTiles, p.complete])).toStrictEqual([
      [[1, 2], true],
      [[2], false],
    ]);
  });

  it('another Region shows only its own Run and pass', async () => {
    await seedProgress();
    const view = await progress('test-two');
    expect(view.runs).toStrictEqual([
      {
        runId: RUN_OTHER,
        regionName: 'test-two',
        status: 'completed',
        startedAt: '2026-10-03T10:00:00Z',
        endedAt: '2026-10-03T10:30:00Z',
        lastActivity: '2026-10-03T10:30:00Z',
        counts: ZERO_RUN_COUNTS,
      },
    ]);
    expect(view.passes).toStrictEqual([
      {
        passNumber: 1,
        regionName: 'test-two',
        bbox: SMALL_BBOX,
        tileSize: { width: 0.02, height: 0.02 },
        tileCount: 1,
        complete: true,
        finishedTiles: [1],
        finishedPages: [
          { tileNumber: 1, page: 1, runId: RUN_OTHER, placeCount: 2, short: true, totalFound: 2 },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. Read-back gate
// ---------------------------------------------------------------------------

describe('readCrawlProgress read-back gate', () => {
  const malformed: [string, string][] = [
    ['{}', JSON.stringify({})],
    ['a negative count', JSON.stringify({ ...ZERO_RUN_COUNTS, placesListed: -1 })],
    [
      'counts breaking a cross-field rule',
      JSON.stringify({ ...ZERO_RUN_COUNTS, wikimapiaRequests: 1 }),
    ],
  ];

  it.each(malformed)('malformed counts (%s) resolve store_unavailable, never reject', async (_label, counts) => {
    await insertRows(CRAWL_TABLES.runs, [{ ...RUNS.one1, counts }]);
    const failure = failureOf(await progressResult(crawlStore, { regionName: 'test-one' }));
    expect(failure).toStrictEqual({ kind: 'store_unavailable', message: READ_BACK_FAILED_MESSAGE });
  });

  it('a malformed row of another Region does not affect this Region', async () => {
    await insertRows(CRAWL_TABLES.runs, [{ ...RUNS.two, counts: JSON.stringify({}) }]);
    expect(await progress('test-one')).toStrictEqual({ regionName: 'test-one', passes: [], runs: [] });
  });
});

// ---------------------------------------------------------------------------
// 9. No content (AC-58 read side)
// ---------------------------------------------------------------------------

function collectKeys(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

describe('readCrawlProgress carries contract keys only (AC-58)', () => {
  it('every key found by a recursive walk is a contract key, and all of them appear', async () => {
    await seedProgress();
    const view = await progress('test-one');
    const found = [...collectKeys(JSON.parse(JSON.stringify(view)), new Set<string>())].sort();
    const contractKeys = new Set<string>([
      ...Object.keys(CrawlProgressViewSchema.shape),
      ...Object.keys(ListingPassSchema.shape),
      ...Object.keys(FinishedPageSchema.shape),
      ...Object.keys(RunRecordSchema.shape),
      ...Object.keys(RunCountsSchema.shape),
      // nested value shapes of those schemas
      ...Object.keys(ItemFailureCountsSchema.shape),
      ...Object.keys(BoundingBoxSchema.shape),
      ...Object.keys(TileSizeSchema.shape),
    ]);
    expect(found).toStrictEqual([...contractKeys].sort());
  });
});

// ---------------------------------------------------------------------------
// 10. Current-pass read (`readCurrentPass`, AL4 1.4.6 PassState query)
// ---------------------------------------------------------------------------

describe('readCurrentPass', () => {
  it('a Region with no pass gives undefined', async () => {
    const current = await testDb().transaction((trx) => readCurrentPass(trx, 'test-one'));
    expect(current).toBeUndefined();
  });

  it('a Region with a Run but no pass gives undefined', async () => {
    await insertRows(CRAWL_TABLES.runs, [RUNS.one1]);
    const current = await testDb().transaction((trx) => readCurrentPass(trx, 'test-one'));
    expect(current).toBeUndefined();
  });

  it('with the full seed, test-one gives the newest pass (2) and its PassState', async () => {
    await seedProgress();
    const current = await testDb().transaction((trx) => readCurrentPass(trx, 'test-one'));
    if (current === undefined) throw new Error('expected a current pass');
    expect(current.state).toStrictEqual({
      passNumber: 2,
      tileCount: 4,
      finishedTiles: [2],
      lastFinishedPage: [
        [2, 1],
        [3, 2],
      ],
    });
    expect(current.row).toMatchObject({
      region_name: 'test-one',
      pass_number: 2,
      bbox_west: SMALL_BBOX.west,
      bbox_south: SMALL_BBOX.south,
      bbox_east: SMALL_BBOX.east,
      bbox_north: SMALL_BBOX.north,
      tile_width: 0.006,
      tile_height: 0.004,
      tile_count: 4,
    });
  });

  it('test-two gives its own pass only', async () => {
    await seedProgress();
    const current = await testDb().transaction((trx) => readCurrentPass(trx, 'test-two'));
    expect(current?.state).toStrictEqual({
      passNumber: 1,
      tileCount: 1,
      finishedTiles: [1],
      lastFinishedPage: [[1, 1]],
    });
  });

  it('a pass with no finished page has empty lists', async () => {
    await insertRows(CRAWL_TABLES.runs, [RUNS.one3]);
    await insertRows(CRAWL_TABLES.passes, [PASS_2]);
    const current = await testDb().transaction((trx) => readCurrentPass(trx, 'test-one'));
    expect(current?.state).toStrictEqual({
      passNumber: 2,
      tileCount: 4,
      finishedTiles: [],
      lastFinishedPage: [],
    });
  });

  it('a complete pass 1 has finishedTiles of length tileCount', async () => {
    await seedPassOneOnly();
    const current = await testDb().transaction((trx) => readCurrentPass(trx, 'test-one'));
    if (current === undefined) throw new Error('expected a current pass');
    expect(current.state).toStrictEqual({
      passNumber: 1,
      tileCount: 2,
      finishedTiles: [1, 2],
      lastFinishedPage: [
        [1, 2],
        [2, 1],
      ],
    });
    expect(current.state.finishedTiles).toHaveLength(current.state.tileCount);
  });
});
