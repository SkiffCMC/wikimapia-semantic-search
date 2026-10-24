/**
 * AL2 unit tests: `src/db/read.ts` `loadListingState` against the Test Database (AL4 1.4.5).
 * Listing Save and the reads are pinned by the contract tests through the Place Store; the
 * empty-id branch is never reached there.
 */
import { saveListing } from '../../src/db/save-listing';
import { loadListingState } from '../../src/db/read';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_STORE, createDb, destroyQuietly } from '../../src/db/connection';
import { clientListing, requireTestDatabaseUrl } from '../../contracts/storage.support';

const setup = createSchemaSetup({ connectionString: requireTestDatabaseUrl() });
const db = createDb(requireTestDatabaseUrl(), POOL_MAX_STORE);

beforeAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
  await saveListing(db, await clientListing('box-belgrade-page1.json'), undefined);
});

afterAll(async () => {
  await destroyQuietly(db);
  await setup.close();
});

it.each<[number[], number[]]>([
  [[62587, 424242], [62587]],
  [[], []],
])('loadListingState(%j) returns the stored rows of exactly those ids', async (ids, stored) => {
  const state = await db.transaction((trx) => loadListingState(trx, ids));
  expect(state.rows.map((row) => row.place_id)).toStrictEqual(stored);
});
