/**
 * AL2 unit tests: `src/db/places-due.ts` (`selectPlacesDue`, `countPlacesDue`) against the Test
 * Database (AL4 hydration 1.3 `places-due.ts` signatures, 1.4.7 R1 statement, 1.5 "Places due
 * list/count"). AL3 routing 20261022-hydration-03-store-read, section 2.1 A.
 *
 * Module-level stand-in for contract R1 and AC-30 .. AC-34 (query side) until
 * `contracts/hydration.test.ts` can load (U7).
 *
 * Runs on a `createDb(requireTestDatabaseUrl(), POOL_MAX_STORE)` handle. Issues no SQL itself:
 * Places go in through the public Place Store (`saveListingPage` / `savePlaceDetails`), as the
 * contract's `seedSummaries` / `seedDetails` do. Values are synthetic or the Client's reading of
 * the recorded fixtures. Every list is parsed with `PlacesDueValueSchema` before asserting.
 */
import type { Knex } from 'knex';
import { countPlacesDue, selectPlacesDue } from '../../src/db/places-due';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_STORE, createDb, destroyQuietly } from '../../src/db/connection';
import {
  EmptyResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  type PlaceStore,
  type SchemaSetup,
} from '../../contracts/storage.schema';
import {
  PlacesDueValueSchema,
  isInDetailsOrder,
  type DuePlace,
} from '../../contracts/hydration.schema';
import {
  CENTRAL_BELGRADE_POINT,
  REGION_FAR,
  RUN_START,
  SMALL_BBOX,
} from '../../contracts/hydration.support';
import { clientDetails, requireTestDatabaseUrl } from '../../contracts/storage.support';
import type {
  BoundingBox,
  PlaceDetails,
  PlaceSummary,
} from '../../contracts/wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Lifecycle: Test Database migrated once, emptied before every test
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
let store: PlaceStore;
let db: Knex;

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: url });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  expect(applied.ok).toBe(true);
  store = createPlaceStore({ connectionString: url });
  db = createDb(url, POOL_MAX_STORE);
});

beforeEach(async () => {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
});

afterAll(async () => {
  await destroyQuietly(db);
  await store.close();
  await setup.close();
});

// ---------------------------------------------------------------------------
// Synthetic Places (same shapes as the contract's `summary()` / `syntheticPlaceDetails()`)
// ---------------------------------------------------------------------------

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
    await store.saveListingPage({ page: 1, pageSize: 10, totalFound: places.length, places }),
  );
  expect(result.ok).toBe(true);
}

async function seedDetails(details: PlaceDetails, fetchedAt: string): Promise<void> {
  const result = SaveResultSchema.parse(await store.savePlaceDetails({ details, fetchedAt }));
  expect(result.ok).toBe(true);
}

/** The R1 data set of the contract (`R1 Place Store` describe block). */
async function seedR1(): Promise<void> {
  const p = CENTRAL_BELGRADE_POINT;
  await seedSummaries(
    summary(900, p.lon, p.lat),
    summary(300, 20.452, 44.82),
    summary(950, 20.47, 44.817),
  );
  await seedDetails(await clientDetails('getbyid-62587.json'), '2026-08-01T00:00:00Z');
  await seedDetails(await clientDetails('getbyid-1381893.json'), '2026-07-01T00:00:00Z');
  await seedDetails(syntheticPlaceDetails(700, p.lon, p.lat), '2026-07-01T00:00:00Z');
  await seedDetails(syntheticPlaceDetails(800, p.lon, p.lat), '2026-09-22T09:00:00Z');
}

const CUTOFF = '2026-09-22T09:00:00Z';
const CUTOFF_PLUS_ONE = '2026-09-22T09:00:01Z';

const R1_EXPECTED: DuePlace[] = [
  { placeId: 300 },
  { placeId: 900 },
  { placeId: 700, detailsFetchedAt: '2026-07-01T00:00:00Z' },
  { placeId: 1381893, detailsFetchedAt: '2026-07-01T00:00:00Z' },
  { placeId: 62587, detailsFetchedAt: '2026-08-01T00:00:00Z' },
];

/** `selectPlacesDue` on the shared handle, gated with the contract value schema. */
async function select(
  bbox: BoundingBox,
  dueBefore: string,
  limit?: number,
  conn: Knex | Knex.Transaction = db,
): Promise<DuePlace[]> {
  const query = limit === undefined ? { bbox, dueBefore } : { bbox, dueBefore, limit };
  const places = await selectPlacesDue(conn, query);
  return PlacesDueValueSchema.parse({ places }).places;
}

function ids(places: readonly DuePlace[]): number[] {
  return places.map((p) => p.placeId);
}

// ---------------------------------------------------------------------------
// 1. R1 data set: contract order (R1, AC-30, AC-33)
// ---------------------------------------------------------------------------

describe('selectPlacesDue: the R1 data set', () => {
  it('gives exactly the contract order at the cutoff', async () => {
    await seedR1();
    const places = await select(SMALL_BBOX, CUTOFF);
    expect(places).toStrictEqual(R1_EXPECTED);
    expect(isInDetailsOrder(places)).toBe(true);
  });

  it('Summary-Only entries carry no detailsFetchedAt key at all', async () => {
    await seedR1();
    const places = await select(SMALL_BBOX, CUTOFF);
    for (const place of places.filter((p) => p.placeId === 300 || p.placeId === 900)) {
      expect(Object.hasOwn(place, 'detailsFetchedAt')).toBe(false);
    }
    for (const place of places.filter((p) => p.placeId !== 300 && p.placeId !== 900)) {
      expect(Object.hasOwn(place, 'detailsFetchedAt')).toBe(true);
    }
  });

  it('never lists the Place outside the bbox (950)', async () => {
    await seedR1();
    expect(ids(await select(SMALL_BBOX, CUTOFF_PLUS_ONE))).not.toContain(950);
  });
});

// ---------------------------------------------------------------------------
// 2. Strictly earlier than the cutoff (AC-31, AC-32)
// ---------------------------------------------------------------------------

describe('selectPlacesDue: the cutoff is exclusive', () => {
  it('a Place fetched exactly at the cutoff is not due', async () => {
    await seedR1();
    expect(ids(await select(SMALL_BBOX, CUTOFF))).not.toContain(800);
  });

  it('one second later it is due, and last', async () => {
    await seedR1();
    const places = await select(SMALL_BBOX, CUTOFF_PLUS_ONE);
    expect(places).toStrictEqual([
      ...R1_EXPECTED,
      { placeId: 800, detailsFetchedAt: '2026-09-22T09:00:00Z' },
    ]);
    expect(isInDetailsOrder(places)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Another Region (independence)
// ---------------------------------------------------------------------------

describe('selectPlacesDue / countPlacesDue: a Region far away', () => {
  it('REGION_FAR gives [] and a count of 0', async () => {
    await seedR1();
    expect(await select(REGION_FAR.bbox, RUN_START)).toStrictEqual([]);
    expect(await countPlacesDue(db, { bbox: REGION_FAR.bbox, dueBefore: RUN_START })).toBe(0);
  });

  it('an empty store gives [] and 0 for SMALL_BBOX', async () => {
    expect(await select(SMALL_BBOX, RUN_START)).toStrictEqual([]);
    expect(await countPlacesDue(db, { bbox: SMALL_BBOX, dueBefore: RUN_START })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Edges included, a hair outside excluded (AC-34)
// ---------------------------------------------------------------------------

describe('selectPlacesDue: bbox edges', () => {
  // SMALL_BBOX = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 }
  const mid = CENTRAL_BELGRADE_POINT;

  it('a Place on each edge is due (300 on the north-west corner, 401 east, 402 south)', async () => {
    await seedSummaries(
      summary(300, 20.452, 44.82),
      summary(401, 20.462, mid.lat),
      summary(402, mid.lon, 44.814),
    );
    expect(await select(SMALL_BBOX, RUN_START)).toStrictEqual([
      { placeId: 300 },
      { placeId: 401 },
      { placeId: 402 },
    ]);
  });

  it('the south-east corner is due as well', async () => {
    await seedSummaries(summary(403, 20.462, 44.814));
    expect(ids(await select(SMALL_BBOX, RUN_START))).toStrictEqual([403]);
  });

  it('a Place 0.000001 degrees outside any edge is not due', async () => {
    await seedSummaries(
      summary(501, 20.451999, mid.lat),
      summary(502, 20.462001, mid.lat),
      summary(503, mid.lon, 44.813999),
      summary(504, mid.lon, 44.820001),
    );
    expect(await select(SMALL_BBOX, RUN_START)).toStrictEqual([]);
    expect(await countPlacesDue(db, { bbox: SMALL_BBOX, dueBefore: RUN_START })).toBe(0);
  });

  it('a Detailed Place on an edge is due when old enough', async () => {
    await seedDetails(syntheticPlaceDetails(404, 20.462, 44.82), '2026-07-01T00:00:00Z');
    expect(await select(SMALL_BBOX, RUN_START)).toStrictEqual([
      { placeId: 404, detailsFetchedAt: '2026-07-01T00:00:00Z' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. limit truncates in Details Order
// ---------------------------------------------------------------------------

describe('selectPlacesDue: limit', () => {
  it('limit 2 gives the first 2 entries of the unlimited list', async () => {
    await seedR1();
    const full = await select(SMALL_BBOX, CUTOFF);
    expect(await select(SMALL_BBOX, CUTOFF, 2)).toStrictEqual(full.slice(0, 2));
    expect(await select(SMALL_BBOX, CUTOFF, 2)).toStrictEqual([{ placeId: 300 }, { placeId: 900 }]);
  });

  it('limit 3 cuts inside the Detailed part in Details Order', async () => {
    await seedR1();
    expect(await select(SMALL_BBOX, CUTOFF, 3)).toStrictEqual(R1_EXPECTED.slice(0, 3));
  });

  it('a limit larger than the count gives the full list', async () => {
    await seedR1();
    expect(await select(SMALL_BBOX, CUTOFF, 100)).toStrictEqual(R1_EXPECTED);
  });

  it('a limit equal to the count gives the full list', async () => {
    await seedR1();
    expect(await select(SMALL_BBOX, CUTOFF, R1_EXPECTED.length)).toStrictEqual(R1_EXPECTED);
  });

  it('no limit gives the full list', async () => {
    await seedR1();
    expect(await select(SMALL_BBOX, CUTOFF)).toStrictEqual(R1_EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// 6. countPlacesDue agrees with the list
// ---------------------------------------------------------------------------

describe('countPlacesDue', () => {
  it.each([
    [CUTOFF, 5],
    [CUTOFF_PLUS_ONE, 6],
  ])('at %s equals the unlimited list length (%i)', async (dueBefore, expected) => {
    await seedR1();
    const list = await select(SMALL_BBOX, dueBefore);
    const count = await countPlacesDue(db, { bbox: SMALL_BBOX, dueBefore });
    expect(typeof count).toBe('number');
    expect(count).toBe(list.length);
    expect(count).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 7. Inside a transaction
// ---------------------------------------------------------------------------

describe('selectPlacesDue / countPlacesDue inside a transaction', () => {
  it('both work on a Knex.Transaction', async () => {
    await seedR1();
    const [places, count] = await db.transaction(async (trx) => {
      const listed = await select(SMALL_BBOX, CUTOFF, undefined, trx);
      const counted = await countPlacesDue(trx, { bbox: SMALL_BBOX, dueBefore: CUTOFF });
      return [listed, counted] as const;
    });
    expect(places).toStrictEqual(R1_EXPECTED);
    expect(count).toBe(5);
  });

  it('limit works inside a transaction too', async () => {
    await seedR1();
    const places = await db.transaction((trx) => select(SMALL_BBOX, CUTOFF, 1, trx));
    expect(places).toStrictEqual([{ placeId: 300 }]);
  });
});

// ---------------------------------------------------------------------------
// 8. excludePlaceIds (AL4 crawl-run1-fixes 1.4.7; AL3 routing
//    20261022-crawl-run1-fixes-04-parking, section 2.1 C)
// ---------------------------------------------------------------------------

/** `selectPlacesDue` with an exclusion list, gated with the contract value schema. */
async function selectExcluding(
  excludePlaceIds: readonly number[],
  dueBefore: string = CUTOFF,
  limit?: number,
): Promise<DuePlace[]> {
  const places = await selectPlacesDue(db, {
    bbox: SMALL_BBOX,
    dueBefore,
    excludePlaceIds,
    ...(limit === undefined ? {} : { limit }),
  });
  return PlacesDueValueSchema.parse({ places }).places;
}

describe('selectPlacesDue / countPlacesDue: excludePlaceIds', () => {
  it('an empty list gives exactly the results without the option', async () => {
    await seedR1();
    expect(await selectExcluding([])).toStrictEqual(R1_EXPECTED);
    expect(await selectExcluding([], CUTOFF, 2)).toStrictEqual(R1_EXPECTED.slice(0, 2));
    expect(
      await countPlacesDue(db, { bbox: SMALL_BBOX, dueBefore: CUTOFF, excludePlaceIds: [] }),
    ).toBe(R1_EXPECTED.length);
  });

  it('excluding ids removes exactly those Places; the rest keep Details Order', async () => {
    await seedR1();
    const places = await selectExcluding([900, 1381893]);
    expect(places).toStrictEqual(
      R1_EXPECTED.filter((p) => p.placeId !== 900 && p.placeId !== 1381893),
    );
    expect(isInDetailsOrder(places)).toBe(true);
  });

  it('excluding every due Place gives []', async () => {
    await seedR1();
    expect(await selectExcluding(ids(R1_EXPECTED))).toStrictEqual([]);
    expect(
      await countPlacesDue(db, {
        bbox: SMALL_BBOX,
        dueBefore: CUTOFF,
        excludePlaceIds: ids(R1_EXPECTED),
      }),
    ).toBe(0);
  });

  it('limit applies after the exclusion: excluding the first due Place with limit 1 gives the second', async () => {
    await seedR1();
    expect(await selectExcluding([300], CUTOFF, 1)).toStrictEqual([{ placeId: 900 }]);
    expect(await selectExcluding([300, 900], CUTOFF, 2)).toStrictEqual(R1_EXPECTED.slice(2, 4));
  });

  it('ids that are not due, not in the bbox or not stored change nothing', async () => {
    await seedR1();
    // 800 is not due at the cutoff, 950 is outside the bbox, 123456 is not stored.
    expect(await selectExcluding([800, 950, 123456])).toStrictEqual(R1_EXPECTED);
    expect(
      await countPlacesDue(db, {
        bbox: SMALL_BBOX,
        dueBefore: CUTOFF,
        excludePlaceIds: [800, 950, 123456],
      }),
    ).toBe(R1_EXPECTED.length);
  });

  it('a duplicated id in the list is excluded once, like any other', async () => {
    await seedR1();
    expect(await selectExcluding([700, 700])).toStrictEqual(
      R1_EXPECTED.filter((p) => p.placeId !== 700),
    );
  });

  it.each([
    [[] as number[]],
    [[300]],
    [[900, 62587]],
    [[300, 900, 700, 1381893, 62587]],
  ])('countPlacesDue excluding %j equals the unlimited list length and ignores limit', async (excluded) => {
    await seedR1();
    const list = await selectExcluding(excluded, CUTOFF_PLUS_ONE);
    const count = await countPlacesDue(db, {
      bbox: SMALL_BBOX,
      dueBefore: CUTOFF_PLUS_ONE,
      excludePlaceIds: excluded,
    });
    expect(count).toBe(list.length);
    expect(count).toBe(R1_EXPECTED.length + 1 - excluded.length);
    expect(
      await countPlacesDue(db, {
        bbox: SMALL_BBOX,
        dueBefore: CUTOFF_PLUS_ONE,
        excludePlaceIds: excluded,
        limit: 1,
      }),
    ).toBe(count);
  });

  it('works inside a transaction', async () => {
    await seedR1();
    const [places, count] = await db.transaction(async (trx) => {
      const listed = await selectPlacesDue(trx, {
        bbox: SMALL_BBOX,
        dueBefore: CUTOFF,
        excludePlaceIds: [300],
      });
      const counted = await countPlacesDue(trx, {
        bbox: SMALL_BBOX,
        dueBefore: CUTOFF,
        excludePlaceIds: [300],
      });
      return [listed, counted] as const;
    });
    expect(places).toStrictEqual(R1_EXPECTED.slice(1));
    expect(count).toBe(R1_EXPECTED.length - 1);
  });
});
