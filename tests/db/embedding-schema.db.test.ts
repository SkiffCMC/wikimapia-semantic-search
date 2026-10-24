/**
 * AL2 unit tests: Schema Setup with step 7 (`src/db/migrations/20261023_01_create_place_embeddings.ts`,
 * `src/db/schema-setup.ts`). Only what the contract tests do not reach: undoing every step and
 * emptying the store while step 7 is undone. AL4 embeddings 1.4.9, 2.2.
 */
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createPlaceStore } from '../../src/db/place-store';
import type { SchemaSetup } from '../../contracts/storage.schema';
import { syntheticDetails } from '../../contracts/embeddings.support';
import { FETCHED_AT, requireTestDatabaseUrl } from '../../contracts/storage.support';

const STEP_NAMES = [
  '20261021_01_enable_extensions',
  '20261021_02_create_places',
  '20261021_03_create_tags',
  '20261021_04_create_comments',
  '20261022_01_create_crawl_progress',
  '20261022_02_create_item_failures',
  '20261023_01_create_place_embeddings',
];

let setup: SchemaSetup;

beforeAll(async () => {
  setup = createSchemaSetup({ connectionString: requireTestDatabaseUrl() });
  expect((await setup.apply()).ok).toBe(true);
});

afterEach(async () => {
  expect((await setup.apply()).ok).toBe(true);
});

afterAll(async () => {
  await setup.close();
});

it('undoAll undoes all seven steps, step 7 first, and drops the vector extension', async () => {
  expect(await setup.undoAll()).toStrictEqual({
    ok: true,
    value: { steps: [...STEP_NAMES].reverse() },
  });
  const after = await setup.inspect();
  if (!after.ok) throw new Error(after.failure.message);
  expect(after.value.tables).toStrictEqual([]);
  expect(after.value.enabledExtensions).not.toContain('vector');
}, 60_000);

it('emptyStore with step 7 undone still empties the store tables', async () => {
  const places = createPlaceStore({ connectionString: requireTestDatabaseUrl() });
  try {
    const details = await syntheticDetails(900);
    expect((await places.savePlaceDetails({ details, fetchedAt: FETCHED_AT })).ok).toBe(true);
    expect(await setup.undoLast()).toStrictEqual({ ok: true, value: { steps: [STEP_NAMES[6]] } });

    expect(await setup.emptyStore()).toStrictEqual({ ok: true, value: {} });
    expect(await places.readPlace({ placeId: 900 })).toStrictEqual({
      ok: true,
      value: { found: false, placeId: 900 },
    });
  } finally {
    await places.close();
  }
}, 60_000);
