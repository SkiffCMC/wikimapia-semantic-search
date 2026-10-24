/**
 * AL2 unit tests: Schema Setup (`src/db/schema-setup.ts`, AL4 1.4.1, 1.4.10; hydration AL4
 * 1.4.12; crawl-run1-fixes AL4 2.1) against the Test Database. The contract tests cover apply,
 * undoAll, inspect, the structure and emptyStore on the full schema. Here: undoLast step by step,
 * emptyStore while newer tables are absent, the step-6 undo with a `quota_exhausted` Run Record,
 * and the not-configured and unreachable failures of the methods the contracts do not call.
 */
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createPlaceStore } from '../../src/db/place-store';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import {
  UNREACHABLE_DATABASE_URL,
  clientListing,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';

const url = requireTestDatabaseUrl();
const setup = createSchemaSetup({ connectionString: url });
const store = createPlaceStore({ connectionString: url });
const db = createDb(url, POOL_MAX_SETUP);

afterAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
  await Promise.all([setup.close(), store.close(), destroyQuietly(db)]);
});

const QUOTA_RUN = {
  region_name: 'test-region-b',
  status: 'quota_exhausted',
  started_at: '2026-10-22T08:00:00Z',
  ended_at: '2026-10-22T08:09:00Z',
  last_activity: '2026-10-22T08:09:00Z',
  counts: JSON.stringify({ requests: 0 }),
};

async function storedPlaces(): Promise<unknown> {
  const counts = await store.countStored();
  return counts.ok ? counts.value.places : counts.failure;
}

it('undoLast undoes one step, newest first; emptyStore still clears what is left', async () => {
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
  await db(CRAWL_TABLES.runs).insert(QUOTA_RUN);
  const runs = await db(CRAWL_TABLES.runs).select('*');

  for (const step of ['20261023_01_create_place_embeddings', '20261022_02_create_item_failures']) {
    expect(await setup.undoLast()).toStrictEqual({ ok: true, value: { steps: [step] } });
  }
  // Step 6 undone: the quota_exhausted Run Record stays; the NOT VALID check refuses new ones.
  expect(await db(CRAWL_TABLES.runs).select('*')).toStrictEqual(runs);
  await expect(
    db(CRAWL_TABLES.runs).insert({ ...QUOTA_RUN, region_name: 'test-region-c' }),
  ).rejects.toMatchObject({ code: '23514', constraint: 'crawl_runs_status_valid' });

  await store.saveListingPage(await clientListing('box-belgrade-page1.json'));
  expect(await setup.emptyStore()).toStrictEqual({ ok: true, value: {} });
  expect(await storedPlaces()).toBe(0);
  expect(await db(CRAWL_TABLES.runs).select('*')).toStrictEqual([]);

  const crawlStep = '20261022_01_create_crawl_progress';
  expect(await setup.undoLast()).toStrictEqual({ ok: true, value: { steps: [crawlStep] } });
  await store.saveListingPage(await clientListing('box-belgrade-page1.json'));
  expect(await setup.emptyStore()).toStrictEqual({ ok: true, value: {} });
  expect(await storedPlaces()).toBe(0);
}, 60_000);

it('undoLast with nothing applied undoes nothing', async () => {
  expect((await setup.undoAll()).ok).toBe(true);
  expect(await setup.undoLast()).toStrictEqual({ ok: true, value: { steps: [] } });
}, 60_000);

it('a not-configured setup resolves every method with the fixed failure', async () => {
  const broken = createSchemaSetup({ connectionString: '' });
  const failure = {
    ok: false,
    failure: {
      kind: 'store_unavailable',
      message: 'Place Store is not configured: connection string is missing or unusable',
    },
  };
  const results = [
    await broken.apply(),
    await broken.undoAll(),
    await broken.undoLast(),
    await broken.inspect(),
    await broken.emptyStore(),
  ];
  expect(results).toStrictEqual(Array.from({ length: 5 }, () => failure));
  await expect(broken.close()).resolves.toBeUndefined();
});

it('an unreachable setup names the failed action', async () => {
  const unreachable = createSchemaSetup({ connectionString: UNREACHABLE_DATABASE_URL });
  const message = (action: string) => ({
    ok: false,
    failure: {
      kind: 'store_unavailable',
      message: `Place Store unavailable: ${action} failed (ECONNREFUSED)`,
    },
  });
  try {
    expect([
      await unreachable.undoAll(),
      await unreachable.undoLast(),
      await unreachable.emptyStore(),
    ]).toStrictEqual([
      message('schema setup undo'),
      message('schema setup undo last'),
      message('empty store'),
    ]);
  } finally {
    await unreachable.close();
  }
}, 60_000);
