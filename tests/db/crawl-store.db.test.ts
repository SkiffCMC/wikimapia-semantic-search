/**
 * AL2 unit tests: the Crawl Store (`src/db/crawl-store.ts`; AL4 hydration 1.4.11, 1.5;
 * crawl-run1-fixes AL4 1.4.6, 1.4.9) against the Test Database. The contract tests read Crawl
 * Progress after real Runs; here only what they never meet: a not-configured store, the read-back
 * gate, a Finished Page without a reported total, Parked Places left out of the due list and the
 * narrowed messages of an invalid Failure Records query. Rows are synthetic.
 */
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import type { FailureRecordsInput } from '../../contracts/crawl-run1-fixes.schema';
import { ZERO_RUN_COUNTS } from '../../contracts/hydration.schema';
import { CENTRAL_BELGRADE_POINT, RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const url = requireTestDatabaseUrl();
const setup = createSchemaSetup({ connectionString: url });
const db = createDb(url, POOL_MAX_SETUP);
const store = createCrawlStore({ connectionString: url });

beforeAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
  await Promise.all([store.close(), setup.close(), destroyQuietly(db)]);
});

/** A finished Run of `test-one` with the given raw `counts` text. */
function insertRun(counts: string) {
  return db(CRAWL_TABLES.runs).insert({
    run_id: 1,
    region_name: 'test-one',
    status: 'completed',
    started_at: RUN_START,
    ended_at: RUN_START,
    last_activity: RUN_START,
    counts,
  });
}

describe('createCrawlStore', () => {
  it.each([
    [
      'listPlacesDueForDetails',
      (s: typeof store) => s.listPlacesDueForDetails({ bbox: SMALL_BBOX, dueBefore: RUN_START }),
    ],
    ['readCrawlProgress', (s: typeof store) => s.readCrawlProgress({ regionName: 'test-one' })],
    ['readFailureRecords', (s: typeof store) => s.readFailureRecords({ runId: 1 })],
    ['readExplicitRetries', (s: typeof store) => s.readExplicitRetries({ regionName: 'test-one' })],
  ])(
    'without a connection string, %s resolves the fixed not-configured failure',
    async (_m, call) => {
      const broken = createCrawlStore({ connectionString: '' });
      expect(await call(broken)).toStrictEqual({
        ok: false,
        failure: {
          kind: 'store_unavailable',
          message: 'Place Store is not configured: connection string is missing or unusable',
        },
      });
      await broken.close();
    },
  );
});

describe('readCrawlProgress', () => {
  it('counts that are not an object fail the read-back check', async () => {
    await insertRun(JSON.stringify('synthetic'));
    expect(await store.readCrawlProgress({ regionName: 'test-one' })).toStrictEqual({
      ok: false,
      failure: {
        kind: 'store_unavailable',
        message: 'Place Store unavailable: stored data failed the read-back check',
      },
    });
  });

  it('a Finished Page without a reported total has no totalFound', async () => {
    await insertRun(JSON.stringify(ZERO_RUN_COUNTS));
    await db(CRAWL_TABLES.passes).insert({
      region_name: 'test-one',
      pass_number: 1,
      bbox_west: SMALL_BBOX.west,
      bbox_south: SMALL_BBOX.south,
      bbox_east: SMALL_BBOX.east,
      bbox_north: SMALL_BBOX.north,
      tile_width: 0.005,
      tile_height: 0.005,
      tile_count: 2,
      started_by_run_id: 1,
      started_at: RUN_START,
    });
    await db(CRAWL_TABLES.finishedPages).insert({
      region_name: 'test-one',
      pass_number: 1,
      tile_number: 1,
      page_no: 1,
      run_id: 1,
      place_count: 0,
      is_short: true,
      finished_at: RUN_START,
    });
    const view = await store.readCrawlProgress({ regionName: 'test-one' });
    expect(view.ok && view.value.passes[0]?.finishedPages).toStrictEqual([
      { tileNumber: 1, page: 1, runId: 1, placeCount: 0, short: true },
    ]);
  });
});

describe('listPlacesDueForDetails', () => {
  it('leaves out a Parked Place of the bbox', async () => {
    const { lon, lat } = CENTRAL_BELGRADE_POINT;
    const placeStore = createPlaceStore({ connectionString: url });
    await placeStore.saveListingPage({
      page: 1,
      pageSize: 100,
      totalFound: 2,
      places: [900, 901].map((placeId) => ({
        placeId,
        name: `Synthetic place ${String(placeId)}`,
        url: `http://wikimapia.org/${String(placeId)}/Synthetic`,
        location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
        outline: [],
      })),
    });
    await placeStore.close();
    const repo = openCrawlRepository({ connectionString: url });
    const begun = await repo.beginRun({
      regionName: 'test-one',
      bbox: SMALL_BBOX,
      tileSize: { width: 0.005, height: 0.005 },
      tileCount: 1,
      relist: false,
      startedAt: RUN_START,
      abandonBefore: '2026-10-22T08:00:00Z',
      counts: ZERO_RUN_COUNTS,
      retryParked: false,
    });
    const runId = begun.ok && begun.value.kind === 'started' ? begun.value.runId : 0;
    for (const second of [10, 20, 30]) {
      await repo.recordItemFailure({
        runId,
        item: { kind: 'place_details', placeId: 900 },
        failureKind: 'wikimapia_error',
        message: 'Place 900: synthetic',
        failedAt: `2026-10-22T09:00:${String(second)}Z`,
      });
    }
    await repo.close();
    expect(
      await store.listPlacesDueForDetails({ bbox: SMALL_BBOX, dueBefore: '2026-10-22T09:01:00Z' }),
    ).toStrictEqual({ ok: true, value: { places: [{ placeId: 901 }] } });
  });
});

describe('readFailureRecords', () => {
  // Non-fresh objects, so the invalid queries type-check as FailureRecordsInput.
  const bothShapes = { placeId: 1, runId: 1 };
  const oneShape = { placeId: 0, extra: 1 };
  it.each<[string, FailureRecordsInput, object]>([
    [
      'naming both shapes',
      bothShapes,
      {
        message: 'Invalid data: (whole input): Invalid input',
        issues: [{ path: [], message: 'Invalid input' }],
      },
    ],
    [
      'naming one shape',
      oneShape,
      {
        message: 'Invalid data: placeId: Too small: expected number to be >0 (+1 more)',
        issues: [
          { path: ['placeId'], message: 'Too small: expected number to be >0' },
          { path: [], message: 'Unrecognized key: "extra"' },
        ],
      },
    ],
  ])('a query %s is invalid_data with the matching issues', async (_case, input, failure) => {
    expect(await store.readFailureRecords(input)).toStrictEqual({
      ok: false,
      failure: { kind: 'invalid_data', ...failure },
    });
  });
});
