/**
 * AL2 unit tests: `src/db/save-details.ts` against the Test Database (AL4 1.5 Transaction
 * boundaries, AL6 rule 13). Every Details Save behaviour is pinned by the contract tests
 * through the Place Store; the one thing they never do is run two saves of a Place at once.
 */
import type { Knex } from 'knex';
import { saveDetails } from '../../src/db/save-details';
import { countAll, readPlaceValue } from '../../src/db/read';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_STORE, createDb, destroyQuietly } from '../../src/db/connection';
import type { SchemaSetup } from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  LATER_FETCHED_AT,
  asPlaceDetails,
  clientDetails,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import type { PlaceDetails } from '../../contracts/wikimapia-client.schema';

let setup: SchemaSetup;
let db: Knex;

beforeAll(async () => {
  setup = createSchemaSetup({ connectionString: requireTestDatabaseUrl() });
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
  db = createDb(requireTestDatabaseUrl(), POOL_MAX_STORE);
});

afterAll(async () => {
  await destroyQuietly(db);
  await setup.close();
});

it('two concurrent saves of one Place serialize: both Updated, the Place equals one of them', async () => {
  const d = await clientDetails('getbyid-62587.json');
  await saveDetails(db, { details: d, fetchedAt: FETCHED_AT }, undefined);
  const a: PlaceDetails = { ...d, title: 'Variant A', description: 'Description A' };
  const b: PlaceDetails = { ...d, title: 'Variant B', description: 'Description B' };

  const reports = await Promise.all(
    [a, b].map((details) => saveDetails(db, { details, fetchedAt: LATER_FETCHED_AT }, undefined)),
  );
  const updated = { places: [{ placeId: 62587, outcome: 'updated' }] };
  expect(reports).toStrictEqual([updated, updated]);

  const value = await readPlaceValue(db, 62587);
  if (!value.found || value.place.status !== 'detailed') throw new Error('62587 not detailed');
  const back = asPlaceDetails(value.place);
  expect(back).toStrictEqual(back.title === 'Variant A' ? a : b);
  expect(await countAll(db)).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
});
