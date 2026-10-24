/**
 * AL2 unit tests: `src/db/parking.ts` on the Test Database. The contract tests cover the Parking
 * rule, the Count Reset, Parking across Runs and Regions and the Explicit Retry; this pins down
 * what they never reach: the bbox edges of the Parking read, a Place missing from `places`,
 * synthetic Listing and Details Saves around Parking, and a `retryParked` start that is refused
 * or rolled back. Synthetic data only.
 */
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { selectParkedPlaces } from '../../src/db/parking';
import type { BeginRunInput, CrawlRepository } from '../../src/db/types';
import type { WriteHook } from '../../contracts/storage.schema';
import { ZERO_RUN_COUNTS, toMoment, type Moment } from '../../contracts/hydration.schema';
import { CENTRAL_BELGRADE_POINT, RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const url = requireTestDatabaseUrl();
const setup = createSchemaSetup({ connectionString: url });
const store = createPlaceStore({ connectionString: url });
const db = createDb(url, POOL_MAX_SETUP);
const repositories: CrawlRepository[] = [];

const T = (seconds: number): Moment => toMoment(new Date(Date.parse(RUN_START) + seconds * 1000));

beforeAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  await Promise.all(repositories.map((repo) => repo.close()));
  await Promise.all([destroyQuietly(db), store.close(), setup.close()]);
});

function openRepo(onWrite?: WriteHook): CrawlRepository {
  const repo = openCrawlRepository({ connectionString: url, ...(onWrite ? { onWrite } : {}) });
  repositories.push(repo);
  return repo;
}

async function seed(...places: [placeId: number, lon: number, lat: number][]): Promise<void> {
  const summaries = places.map(([placeId, lon, lat]) => ({
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  }));
  const saved = await store.saveListingPage({
    page: 1,
    pageSize: 10,
    totalFound: summaries.length,
    places: summaries,
  });
  expect(saved.ok).toBe(true);
}

function beginInput(startedAt: Moment, overrides: Partial<BeginRunInput> = {}): BeginRunInput {
  return {
    regionName: 'test-one',
    bbox: SMALL_BBOX,
    tileSize: { width: 0.005, height: 0.005 },
    tileCount: 1,
    relist: false,
    startedAt,
    abandonBefore: toMoment(new Date(Date.parse(startedAt) - 3600 * 1000)),
    counts: ZERO_RUN_COUNTS,
    retryParked: false,
    ...overrides,
  };
}

/** One Run at RUN_START with 3 Wikimapia Errors per Place; finished unless `live`. */
async function parkInRun(placeIds: readonly number[], live = false): Promise<CrawlRepository> {
  const repo = openRepo();
  const begun = await repo.beginRun(beginInput(RUN_START));
  if (!begun.ok || begun.value.kind !== 'started') throw new Error('expected a started Run');
  const runId = begun.value.runId;
  for (const placeId of placeIds) {
    for (const s of [10, 20, 30]) {
      const recorded = await repo.recordItemFailure({
        runId,
        item: { kind: 'place_details', placeId },
        failureKind: 'wikimapia_error',
        message: `Place ${String(placeId)}: synthetic`,
        failedAt: T(s),
      });
      expect(recorded.ok).toBe(true);
    }
  }
  if (live) return repo;
  const ended = await repo.finishRun({
    runId,
    status: 'completed',
    endedAt: T(100),
    counts: ZERO_RUN_COUNTS,
  });
  expect(ended.ok).toBe(true);
  return repo;
}

async function parkedIds(): Promise<number[]> {
  return (await selectParkedPlaces(db, { bbox: SMALL_BBOX })).map((p) => p.placeId);
}

async function rowCount(table: string): Promise<number> {
  const [row] = await db(table).count({ n: '*' });
  return Number(row?.n);
}

it('a bbox scope holds Centre Points inside it, edges included; a Place not stored never parks', async () => {
  const { lon, lat } = CENTRAL_BELGRADE_POINT;
  await seed(
    [300, 20.452, 44.82], // north-west corner
    [403, 20.462, 44.814], // south-east corner
    [900, lon, lat],
    [501, 20.451999, lat], // a hair west
    [950, 20.47, 44.817], // outside
    [905, lon, lat], // inside, not Parked
  );
  const repo = await parkInRun([300, 403, 900, 501, 950, 777]);
  expect(await parkedIds()).toStrictEqual([300, 403, 900]);
  expect(await repo.listPlacesDue({ bbox: SMALL_BBOX, dueBefore: T(200) })).toStrictEqual({
    ok: true,
    value: [{ placeId: 905 }],
  });
  expect(await selectParkedPlaces(db, { placeId: 950 })).toStrictEqual([
    { placeId: 950, failureKind: 'wikimapia_error' },
  ]);
  expect(await selectParkedPlaces(db, { placeId: 777 })).toStrictEqual([]);
});

it('Parking survives later Listing Saves; failures after a Details Save count', async () => {
  const { lon, lat } = CENTRAL_BELGRADE_POINT;
  await seed([900, lon, lat], [901, lon, lat]);
  const details = {
    placeId: 902,
    title: 'Synthetic place 902',
    description: '',
    tags: [],
    isBuilding: false,
    isRegion: false,
    isDeleted: false,
    outline: [],
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    comments: [],
  };
  expect((await store.savePlaceDetails({ details, fetchedAt: T(-60) })).ok).toBe(true);
  await parkInRun([900, 901, 902]);
  // 900 unchanged, 901 moved, 902 Detailed with the same link.
  await seed([900, lon, lat], [901, lon + 0.0001, lat], [902, lon, lat]);
  expect(await parkedIds()).toStrictEqual([900, 901, 902]);
});

it.each<[string, boolean, Partial<BeginRunInput>, number, string]>([
  ['a live Run of the Region', true, {}, 0, 'run_in_progress'],
  ['a changed Region', false, { tileCount: 2 }, 0, 'region_changed'],
  ['a failing retry-row write', false, {}, 2, 'store_unavailable'],
  ['a failing release write', false, {}, 3, 'store_unavailable'],
])(
  'a retryParked start refused by %s keeps no retry and releases nothing',
  async (_, live, overrides, failAt, outcome) => {
    const { lon, lat } = CENTRAL_BELGRADE_POINT;
    await seed([900, lon, lat], [901, lon, lat]);
    await parkInRun([900, 901], live);
    // Writes of this start: 1 Run Record, 2 retry row, 3 release rows (the pass is resumed).
    const repo = openRepo((n) => {
      if (n === failAt) throw new Error('hook failed');
    });
    const result = await repo.beginRun(beginInput(T(200), { ...overrides, retryParked: true }));
    expect(result.ok ? result.value.kind : result.failure.kind).toBe(outcome);
    expect(await rowCount(CRAWL_TABLES.runs)).toBe(1);
    expect(await rowCount(CRAWL_TABLES.explicitRetries)).toBe(0);
    expect(await rowCount(CRAWL_TABLES.placeReleases)).toBe(0);
    expect(await parkedIds()).toStrictEqual([900, 901]);
  },
);
