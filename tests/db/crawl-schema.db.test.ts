/**
 * AL2 unit tests: the crawl Schema Setup steps (`20261022_01_create_crawl_progress`,
 * `20261022_02_create_item_failures`; AL4 hydration 2.1 .. 2.5, crawl-run1-fixes 2.2). The
 * contract tests cover the steps, their undo and emptyStore. Here: the database backstops the
 * crawl code relies on but never trips itself (one live Run per Region besides the advisory lock,
 * one Short Page per Tile of a pass, the Failure Record item shape). Rows are synthetic.
 */
import { z } from 'zod';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const T_START = '2026-10-22T08:00:00Z';
const setup = createSchemaSetup({ connectionString: requireTestDatabaseUrl() });
const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);

beforeAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
  await Promise.all([setup.close(), destroyQuietly(db)]);
});

async function insertLiveRun(): Promise<number> {
  const rows: unknown = await db(CRAWL_TABLES.runs)
    .insert({
      region_name: 'test-region-a',
      status: 'in_progress',
      started_at: T_START,
      last_activity: T_START,
      counts: JSON.stringify({ requests: 0 }),
    })
    .returning('run_id');
  return z.array(z.object({ run_id: z.coerce.number() })).parse(rows)[0]?.run_id ?? 0;
}

async function insertPass(runId: number): Promise<void> {
  await db(CRAWL_TABLES.passes).insert({
    region_name: 'test-region-a',
    pass_number: 1,
    bbox_west: 20.4,
    bbox_south: 44.8,
    bbox_east: 20.5,
    bbox_north: 44.9,
    tile_width: 0.05,
    tile_height: 0.05,
    tile_count: 4,
    started_by_run_id: runId,
    started_at: T_START,
  });
}

function shortPage(runId: number, pageNo: number) {
  return db(CRAWL_TABLES.finishedPages).insert({
    region_name: 'test-region-a',
    pass_number: 1,
    tile_number: 1,
    page_no: pageNo,
    run_id: runId,
    place_count: 0,
    is_short: true,
    finished_at: T_START,
  });
}

function placeAndPageFailure(runId: number) {
  return db(CRAWL_TABLES.itemFailures).insert({
    run_id: runId,
    place_id: 900,
    tile_number: 3,
    page_no: 2,
    failure_kind: 'connection',
    message: 'synthetic',
    failed_at: T_START,
  });
}

describe('crawl tables', () => {
  it.each([
    [
      'a second live Run of a Region',
      () => insertLiveRun(),
      { code: '23505', constraint: 'crawl_runs_one_live_per_region' },
    ],
    ['a second Short Page of a Tile', (runId: number) => shortPage(runId, 2), { code: '23505' }],
    ['a Failure Record naming a Place and a page', placeAndPageFailure, { code: '23514' }],
  ] as const)('reject %s', async (_case, insert, error) => {
    const runId = await insertLiveRun();
    await insertPass(runId);
    await shortPage(runId, 1);
    await expect(insert(runId)).rejects.toMatchObject(error);
  });
});
