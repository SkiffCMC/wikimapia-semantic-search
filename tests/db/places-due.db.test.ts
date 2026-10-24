/**
 * AL2 unit test: `src/db/places-due.ts` (AL4 hydration 1.5 "Places due list/count"). The
 * contract tests cover the order, cutoff, edges and limit through the stores, which always pass
 * `excludePlaceIds`; this pins down the query without it. Synthetic Places on the Test Database.
 */
import { countPlacesDue, selectPlacesDue } from '../../src/db/places-due';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_STORE, createDb, destroyQuietly } from '../../src/db/connection';
import { CENTRAL_BELGRADE_POINT, SMALL_BBOX } from '../../contracts/hydration.support';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const url = requireTestDatabaseUrl();
const setup = createSchemaSetup({ connectionString: url });
const store = createPlaceStore({ connectionString: url });
const db = createDb(url, POOL_MAX_STORE);

afterAll(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
  await Promise.all([destroyQuietly(db), store.close(), setup.close()]);
});

function summary(placeId: number, lon: number, lat: number) {
  return {
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

it('without excludePlaceIds, lists and counts every due Place of the bbox', async () => {
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
  const { lon, lat } = CENTRAL_BELGRADE_POINT;
  const places = [summary(900, lon, lat), summary(300, 20.452, 44.82), summary(950, 20.47, 44.817)];
  expect((await store.saveListingPage({ page: 1, pageSize: 10, totalFound: 3, places })).ok).toBe(
    true,
  );

  const query = { bbox: SMALL_BBOX, dueBefore: '2026-10-22T09:00:00Z' };
  expect(await selectPlacesDue(db, query)).toStrictEqual([{ placeId: 300 }, { placeId: 900 }]);
  expect(await countPlacesDue(db, query)).toBe(2);
});
