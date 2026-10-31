/**
 * AL2 unit tests: the search repository (AL4 hybrid-search 1.4.3, 1.4.4 Exact mode, 1.4.8, U2):
 * `buildPlaceSearchStatement` (`src/db/place-search.ts`) and `createPlaceSearchStore`
 * (`src/db/search-store.ts`) against the Test Database, always called with the Query Embedding
 * Q. These mirror the contract's AC-1 .. AC-40, AC-59, AC-60 and AC-64 at the store level, where
 * the store receives already-normalized Tag titles. Approximate mode is checked only for the
 * statement's binding shape (its real text arrives in U3).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createDb, destroyQuietly } from '../../src/db/connection';
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { buildPlaceSearchStatement } from '../../src/db/place-search';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createPlaceSearchStore } from '../../src/db/search-store';
import type { PlaceSearchQuery, StoreResult } from '../../src/db/types';
import type { EmbeddingStore } from '../../contracts/embeddings.schema';
import {
  DEFAULT_RESULT_LIMIT,
  DEFAULT_SEARCH_MODE,
  DISTANCE_TOLERANCE_METRES,
  MAX_RESULT_LIMIT,
  SIMILARITY_TOLERANCE,
  SearchResultSchema,
  compareRankingOrder,
  isInRankingOrder,
  normalizeTagTitle,
  wgs84DistanceMetres,
  type AreaFilter,
  type SearchMode,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';
import {
  AREA_B,
  NOT_SEARCHABLE_IDS,
  POINT_S,
  SEARCHABLE_RANKING,
  SEARCH_SET,
  fakeVector,
  isSearchable,
  liesInArea,
  manyPlaces,
  queryEmbeddingQ,
  recordOf,
  saveRecords,
  seedPlaces,
  seedSearchSet,
  type SyntheticSearchPlace,
} from '../../contracts/hybrid-search.support';
import type { PlaceStore, SchemaSetup } from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  clientDetails,
  clientListing,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import type { PlaceDetails } from '../../contracts/wikimapia-client.schema';

const NOT_CONFIGURED = {
  ok: false,
  failure: {
    kind: 'store_unavailable',
    message: 'Place Store is not configured: connection string is missing or unusable',
  },
};

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;
let db: Knex;

beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect((await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
  embeddings = createEmbeddingStore({ connectionString: testUrl });
  db = createDb(testUrl, 1);
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await destroyQuietly(db);
    await embeddings.close();
    await places.close();
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryParts = Partial<PlaceSearchQuery>;

/** A query with Q, the default mode and the Default Result Limit unless overridden. */
function q(parts: QueryParts = {}): PlaceSearchQuery {
  return {
    queryEmbedding: queryEmbeddingQ(),
    mode: DEFAULT_SEARCH_MODE,
    limit: DEFAULT_RESULT_LIMIT,
    ...parts,
  };
}

const sRadius = (radiusMetres: number, parts: QueryParts = {}): PlaceSearchQuery =>
  q({ radius: { centre: POINT_S, radiusMetres }, ...parts });

/** One store per search, always closed. */
async function searchWith(
  query: PlaceSearchQuery,
  connectionString: string = testUrl,
): Promise<StoreResult<SearchResult[]>> {
  const store = createPlaceSearchStore({ connectionString });
  try {
    return await store.searchMatchingPlaces(query);
  } finally {
    await store.close();
  }
}

async function results(query: PlaceSearchQuery): Promise<SearchResult[]> {
  const result = await searchWith(query);
  if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.message}`);
  const parsed = z.array(SearchResultSchema).parse(result.value);
  expect(isInRankingOrder(parsed)).toBe(true);
  return parsed;
}

async function ids(query: PlaceSearchQuery): Promise<number[]> {
  return (await results(query)).map((r) => r.placeId);
}

function resultFor(list: readonly SearchResult[], placeId: number): SearchResult {
  const found = list.find((r) => r.placeId === placeId);
  if (found === undefined) throw new Error(`place ${String(placeId)} was not returned`);
  return found;
}

function expectSimilarity(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(SIMILARITY_TOLERANCE);
}

/** Oracle: the Searchable Places that pass `keep`, in Ranking Order, at most `limit`. */
function rankingOf(
  list: readonly SyntheticSearchPlace[],
  keep: (place: SyntheticSearchPlace) => boolean = () => true,
  limit: number = MAX_RESULT_LIMIT,
): number[] {
  return list
    .filter((p) => isSearchable(p) && keep(p))
    .map((p) => ({ placeId: p.placeId, similarity: p.similarity ?? Number.NaN }))
    .sort(compareRankingOrder)
    .slice(0, limit)
    .map((p) => p.placeId);
}

async function counts() {
  return { places: await places.countStored(), embeddings: await embeddings.countEmbeddingStore() };
}

// ---------------------------------------------------------------------------
// Ranking (AC-1, AC-4 .. AC-12, AC-64)
// ---------------------------------------------------------------------------

describe('ranking', () => {
  it.each<[string, PlaceSearchQuery]>([
    ['explicit exact mode (AC-64)', q({ mode: 'exact' })],
    ['Result Limit 50 (AC-8)', q({ limit: MAX_RESULT_LIMIT })],
  ])(
    'AC-1, AC-11: %s gives the six Searchable Places, Embedding Due included, with true scores',
    async (_, query) => {
      await seedSearchSet(places, embeddings);
      const list = await results(query);
      expect(list.map((r) => r.placeId)).toStrictEqual(SEARCHABLE_RANKING);
      [0.99, 0.95, 0.9, 0.7, 0.6, 0.5].forEach((score, i) => {
        expectSimilarity(list[i]?.similarity ?? Number.NaN, score);
      });
    },
  );

  it('AC-4: Places 105, 106, 107 (other model) and 110 never come back, whatever the filters', async () => {
    await seedSearchSet(places, embeddings);
    for (const query of [
      q({ limit: MAX_RESULT_LIMIT }),
      sRadius(50, { limit: MAX_RESULT_LIMIT }),
      q({ area: AREA_B, limit: MAX_RESULT_LIMIT }),
      q({ tagTitles: ['museum'], limit: MAX_RESULT_LIMIT }),
    ]) {
      const found = await ids(query);
      for (const id of NOT_SEARCHABLE_IDS) expect(found).not.toContain(id);
    }
  });

  it('AC-5: Result Limit 3 gives the 3 best', async () => {
    await seedSearchSet(places, embeddings);
    expect(await ids(q({ limit: 3 }))).toStrictEqual([103, 102, 101]);
  });

  it.each([
    ['AC-6', 501, 25, DEFAULT_RESULT_LIMIT],
    ['AC-7', 601, 60, MAX_RESULT_LIMIT],
  ])(
    '%s: %i Searchable Places from %i, limit %i: exactly the best, in Ranking Order',
    async (_, firstId, count, limit) => {
      const many = manyPlaces({
        firstId,
        count,
        centre: POINT_S,
        tag: 'museum',
        top: 0.9,
        step: 0.01,
      });
      await seedPlaces(places, embeddings, many);
      expect(await ids(q({ limit }))).toStrictEqual(rankingOf(many, () => true, limit));
    },
  );

  it('AC-9: equal scores are ordered by ascending Place ID, whatever the save order', async () => {
    const tie = { centre: POINT_S, tags: ['museum'] as const, similarity: 0.8, axis: 5 };
    await seedPlaces(places, embeddings, [
      { placeId: 202, name: 'Tie B', ...tie },
      { placeId: 201, name: 'Tie A', ...tie },
      { placeId: 203, name: 'Better', centre: POINT_S, similarity: 0.85 },
    ]);
    const list = await results(q());
    expect(list.map((r) => r.placeId)).toStrictEqual([203, 201, 202]);
    expect(list[1]?.similarity).toBe(list[2]?.similarity);
  });

  it('AC-10: the needle among 1,000 better haystack Places is found by radius, area and tag; the true top 50', async () => {
    const haystack = manyPlaces({
      firstId: 3001,
      count: 1000,
      centre: { lat: 45.5, lon: 20.457 },
      tag: 'hotel',
      top: 0.99,
      step: 0.0005,
    });
    const needle: SyntheticSearchPlace = {
      placeId: 2999,
      name: 'Needle',
      centre: POINT_S,
      tags: ['needle tag'],
      similarity: 0.1,
    };
    await seedPlaces(places, embeddings, [needle, ...haystack]);
    for (const query of [sRadius(500), q({ area: AREA_B }), q({ tagTitles: ['needle tag'] })]) {
      expect(await ids(query)).toStrictEqual([2999]);
    }
    expect(await ids(q({ tagTitles: ['hotel'], limit: MAX_RESULT_LIMIT }))).toStrictEqual(
      rankingOf(haystack),
    );
  }, 300_000);

  it('AC-12: an empty store gives an empty list, not a failure', async () => {
    expect(await searchWith(q())).toStrictEqual({ ok: true, value: [] });
  });
});

// ---------------------------------------------------------------------------
// Radius Filter (AC-13, AC-15 .. AC-21)
// ---------------------------------------------------------------------------

describe('radius', () => {
  it('AC-13, AC-15: 500 m around Point S: 102, 101, 108, 109, 104 with WGS 84 Distances, all inside', async () => {
    await seedSearchSet(places, embeddings);
    const list = await results(sRadius(500, { limit: MAX_RESULT_LIMIT }));
    expect(list.map((r) => r.placeId)).toStrictEqual([102, 101, 108, 109, 104]);
    for (const r of list) {
      const truth = wgs84DistanceMetres(POINT_S, r.centre);
      expect(Math.abs((r.distanceMetres ?? Number.NaN) - truth)).toBeLessThanOrEqual(
        DISTANCE_TOLERANCE_METRES,
      );
      expect(r.distanceMetres).toBeLessThanOrEqual(500);
    }
    expect(resultFor(list, 101).distanceMetres).toBe(0);
  });

  it('AC-16: a Radius equal to the reported Distance of 102 includes 102 and leaves out 104', async () => {
    await seedSearchSet(places, embeddings);
    const measured = resultFor(await results(sRadius(1000)), 102).distanceMetres;
    if (measured === undefined) throw new Error('no Distance reported');
    const found = await ids(sRadius(measured));
    expect(found).toContain(102);
    expect(found).not.toContain(104);
  });

  it.each<[string, PlaceSearchQuery, number[]]>([
    ['AC-17 50 m', sRadius(50), [101]],
    ['AC-18 1000 m', sRadius(1000), [...SEARCHABLE_RANKING]],
    [
      'AC-19 500 m around 45, 21',
      q({ radius: { centre: { lat: 45, lon: 21 }, radiusMetres: 500 } }),
      [],
    ],
  ])('%s', async (_, query, expected) => {
    await seedSearchSet(places, embeddings);
    expect(await ids(query)).toStrictEqual(expected);
  });

  it('AC-20: an Outline Shape reaching into the circle does not count; only the Centre Point does', async () => {
    const far: SyntheticSearchPlace = {
      placeId: 111,
      name: 'Long Embankment',
      centre: { lat: 44.8224, lon: 20.457 },
      outlineBox: { south: 44.8178, north: 44.823, west: 20.4565, east: 20.4575 },
      tags: ['park'],
      similarity: 0.98,
    };
    await seedPlaces(places, embeddings, [...SEARCH_SET, far]);
    expect(await ids(sRadius(500))).toStrictEqual([102, 101, 108, 109, 104]);
  });

  it.each<[string, PlaceSearchQuery]>([
    ['no Spatial Filter', q()],
    ['an Area Filter', q({ area: AREA_B })],
  ])('AC-21: %s: no result has a distanceMetres key', async (_, query) => {
    await seedSearchSet(places, embeddings);
    const list = await results(query);
    expect(list.length).toBeGreaterThan(0);
    for (const r of list) expect(r).not.toHaveProperty('distanceMetres');
  });
});

// ---------------------------------------------------------------------------
// Area Filter (AC-22 .. AC-26)
// ---------------------------------------------------------------------------

describe('area', () => {
  const FAR_BOX: AreaFilter = { south: 10.0, north: 10.1, west: 10.0, east: 10.1 };
  const tagged = (place: SyntheticSearchPlace): SyntheticSearchPlace => ({
    ...place,
    tags: ['park'],
    similarity: 0.4,
  });
  it.each<[string, SyntheticSearchPlace[], AreaFilter, number[]]>([
    [
      'AC-22, AC-23 Area B (109 by its Outline Shape)',
      [...SEARCH_SET],
      AREA_B,
      [102, 101, 108, 109],
    ],
    [
      'AC-24 a Centre Point on the north edge',
      [tagged({ placeId: 112, name: 'Edge Kiosk', centre: { lat: AREA_B.north, lon: 20.457 } })],
      AREA_B,
      [112],
    ],
    [
      'AC-24 an Outline Shape touching the east edge, Centre Point outside',
      [
        tagged({
          placeId: 113,
          name: 'Edge Garden',
          centre: { lat: 44.8175, lon: 20.4585 },
          outlineBox: { south: 44.817, north: 44.818, west: AREA_B.east, east: 20.459 },
        }),
      ],
      AREA_B,
      [113],
    ],
    [
      'AC-25 Outline Shape and Centre Point both outside',
      [
        ...SEARCH_SET,
        {
          placeId: 114,
          name: 'North Yard',
          centre: { lat: 44.8215, lon: 20.457 },
          outlineBox: { south: 44.821, north: 44.822, west: 20.456, east: 20.458 },
          tags: ['park'],
          similarity: 0.98,
        },
      ],
      AREA_B,
      [102, 101, 108, 109],
    ],
    ['AC-26 a box far from Belgrade', [...SEARCH_SET], FAR_BOX, []],
  ])('%s', async (_, seeded, area, expected) => {
    expect(rankingOf(seeded, (p) => liesInArea(p, area))).toStrictEqual(expected);
    await seedPlaces(places, embeddings, seeded);
    expect(await ids(q({ area, limit: MAX_RESULT_LIMIT }))).toStrictEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Tag Filter (AC-27 .. AC-34, Cyrillic, any count)
// ---------------------------------------------------------------------------

describe('tags', () => {
  it.each<[string, PlaceSearchQuery, number[]]>([
    ['AC-27 one Tag; Gone museum of 108 does not count', q({ tagTitles: ['museum'] }), [102, 101]],
    ['AC-28 any of several Tags', q({ tagTitles: ['museum', 'hotel'] }), [103, 102, 101]],
    ['AC-29 Tag and circle', sRadius(500, { tagTitles: ['museum', 'hotel'] }), [102, 101]],
    ['AC-30 Tag and box', q({ tagTitles: ['park'], area: AREA_B }), [109]],
    ['AC-31 " Museum " normalized', q({ tagTitles: [normalizeTagTitle(' Museum ')] }), [102, 101]],
    ['AC-31 "MUSEUM" normalized', q({ tagTitles: [normalizeTagTitle('MUSEUM')] }), [102, 101]],
    ['AC-32 "muse" is not a whole title', q({ tagTitles: ['muse'] }), []],
    ['AC-32 "gallery" is not a whole title', q({ tagTitles: ['gallery'] }), []],
    ['AC-33 unknown Tag', q({ tagTitles: ['volcano'] }), []],
    ['AC-34 a repeated title, none twice', q({ tagTitles: ['museum', 'museum'] }), [102, 101]],
  ])('%s', async (_, query, expected) => {
    await seedSearchSet(places, embeddings);
    expect(await ids(query)).toStrictEqual(expected);
  });

  it('a Cyrillic catalogue Tag "Музеј" is matched by the normalized filter " МУЗЕЈ " and listed as stored', async () => {
    const { lat, lon } = POINT_S;
    const details: PlaceDetails = {
      placeId: 116,
      title: 'Етнографски музеј',
      description: 'Synthetic Cyrillic search place.',
      tags: [{ id: 99201, title: 'Музеј' }],
      isBuilding: false,
      isRegion: false,
      isDeleted: false,
      outline: [],
      location: { lon, lat, north: lat, south: lat, east: lon, west: lon, city: 'Belgrade' },
      comments: [],
    };
    expect((await places.savePlaceDetails({ details, fetchedAt: FETCHED_AT })).ok).toBe(true);
    await saveRecords(embeddings, [
      recordOf({ placeId: 116, name: details.title, centre: POINT_S, similarity: 0.3 }, 0),
    ]);
    const list = await results(q({ tagTitles: [normalizeTagTitle(' МУЗЕЈ ')] }));
    expect(list.map((r) => r.placeId)).toStrictEqual([116]);
    expect(resultFor(list, 116).tags).toStrictEqual(['Музеј']);
  });

  it('300 distinct titles in one query work and do not grow the SQL text', async () => {
    await seedSearchSet(places, embeddings);
    const many = [...Array.from({ length: 299 }, (_, i) => `synthetic tag ${String(i)}`), 'museum'];
    expect(await ids(q({ tagTitles: many }))).toStrictEqual([102, 101]);
    expect(buildPlaceSearchStatement(q({ tagTitles: many })).sql).toBe(
      buildPlaceSearchStatement(q({ tagTitles: ['museum'] })).sql,
    );
  });
});

// ---------------------------------------------------------------------------
// Result content (AC-35 .. AC-38)
// ---------------------------------------------------------------------------

describe('content', () => {
  it('AC-35, AC-36: 102 in the 500 m search carries exactly the stated items; 108 lists only monument', async () => {
    await seedSearchSet(places, embeddings);
    const list = await results(sRadius(500));
    const r = resultFor(list, 102);
    expect(Object.keys(r).sort()).toStrictEqual(
      ['centre', 'distanceMetres', 'name', 'placeId', 'similarity', 'tags', 'wikimapiaUrl'].sort(),
    );
    expect(r.name).toBe('Art Gallery');
    expect(r.wikimapiaUrl).toBe('http://wikimapia.org/102');
    expect(r.tags).toStrictEqual(['museum', 'art gallery']);
    expect(r.centre).toStrictEqual({ lat: 44.8197, lon: 20.457 });
    expect(Math.abs((r.distanceMetres ?? Number.NaN) - 300)).toBeLessThan(1);
    expectSimilarity(r.similarity, 0.95);
    expect(resultFor(list, 108).tags).toStrictEqual(['monument']);
  });

  it('AC-37: a Searchable Place without Present Tags has an empty tags list', async () => {
    await seedPlaces(places, embeddings, [
      { placeId: 115, name: 'Untagged', centre: POINT_S, tags: [], similarity: 0.3 },
    ]);
    expect(resultFor(await results(q()), 115).tags).toStrictEqual([]);
  });

  it('AC-38: a Place saved from the recorded listing and details returns its stored Listing Link', async () => {
    expect((await places.saveListingPage(await clientListing('box-belgrade-page1.json'))).ok).toBe(
      true,
    );
    const details = await clientDetails('getbyid-1381893.json');
    expect((await places.savePlaceDetails({ details, fetchedAt: FETCHED_AT })).ok).toBe(true);
    const centre = { lat: details.location.lat, lon: details.location.lon };
    await saveRecords(embeddings, [
      recordOf({ placeId: 1381893, name: details.title, centre, similarity: 0.4 }, 0),
    ]);
    expect(resultFor(await results(q()), 1381893).wikimapiaUrl).toBe(
      'http://wikimapia.org/1381893/University-Park',
    );
  });
});

// ---------------------------------------------------------------------------
// Safety: parameterized statement (AC-40, AL4 1.4.3 "Binding order")
// ---------------------------------------------------------------------------

describe('safety', () => {
  it('AC-40: a title with SQL text matches nothing and changes nothing', async () => {
    await seedSearchSet(places, embeddings);
    const before = await counts();
    expect(await searchWith(q({ tagTitles: [`museum'; --`] }))).toStrictEqual({
      ok: true,
      value: [],
    });
    expect(await counts()).toStrictEqual(before);
    expect(await ids(q())).toStrictEqual(SEARCHABLE_RANKING);
  });

  const RADIUS = 1234.5;
  const CENTRE = { lat: 44.81711, lon: 20.45722 };
  const BOX: AreaFilter = { south: 44.81234, west: 20.45611, north: 44.82345, east: 20.45789 };
  const SPATIAL: [string, QueryParts][] = [
    ['no spatial filter', {}],
    ['radius', { radius: { centre: CENTRE, radiusMetres: RADIUS } }],
    ['area', { area: BOX }],
  ];
  const TAGS: [string, QueryParts][] = [
    ['no tags', {}],
    ['tags', { tagTitles: [`museum'; --`, 'zz sentinel title'] }],
  ];
  const DISTINCT_NUMBERS = [RADIUS, RADIUS + 1, CENTRE.lat, CENTRE.lon, ...Object.values(BOX)];

  it.each(
    (['exact', 'approximate'] as SearchMode[]).flatMap((mode) =>
      SPATIAL.flatMap(([spatial, s]) =>
        TAGS.map(([tags, t]): [SearchMode, string, string, QueryParts] => [
          mode,
          spatial,
          tags,
          { ...s, ...t },
        ]),
      ),
    ),
  )(
    '%s, %s, %s: one binding per ?, no ??, no bound value in the SQL text',
    (mode, _s, _t, parts) => {
      const { sql, bindings } = buildPlaceSearchStatement(q({ mode, ...parts }));
      expect(sql.split('?').length - 1).toBe(bindings.length);
      expect(sql).not.toContain('??');
      for (const binding of bindings) {
        for (const value of Array.isArray(binding) ? binding : [binding]) {
          if (typeof value === 'string') expect(sql).not.toContain(value);
        }
      }
      for (const n of DISTINCT_NUMBERS) expect(sql).not.toContain(String(n));
      if (mode === 'exact') {
        expect(sql).toMatch(/\bas\s+materialized\b/i);
        expect(sql).not.toMatch(/order\s+by\s+e\.embedding\s*<=>/i);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Validation and failures (AC-59, AC-60, AL4 1.4.8)
// ---------------------------------------------------------------------------

describe('validation and failures', () => {
  const invalid: [string, PlaceSearchQuery][] = [
    ['limit 0', q({ limit: 0 })],
    ['a 1023-number vector', q({ queryEmbedding: fakeVector(1023) })],
    [
      'radius and area together',
      q({ radius: { centre: POINT_S, radiusMetres: 500 }, area: AREA_B }),
    ],
  ];
  it.each(
    invalid.flatMap(([name, query]): [string, string, PlaceSearchQuery][] => [
      [name, 'the Test Database', query],
      [name, 'an unreachable database', query],
    ]),
  )('%s gives invalid_data without database access (%s)', async (_, where, query) => {
    const url = where === 'the Test Database' ? testUrl : UNREACHABLE_DATABASE_URL;
    const result = await searchWith(query, url);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe('invalid_data');
  });

  it('an unreachable database gives store_unavailable without the password or connection string', async () => {
    const result = await searchWith(sRadius(500), UNREACHABLE_DATABASE_URL);
    if (result.ok) throw new Error('expected store_unavailable');
    expect(result.failure.kind).toBe('store_unavailable');
    expect(result.failure.message).toMatch(
      /^Place Store unavailable: place search failed( \([0-9A-Z_]+\))?$/,
    );
    expect(result.failure.message).not.toContain(UNREACHABLE_PASSWORD);
    expect(result.failure.message).not.toContain('postgres://');
  }, 60_000);

  it.each([[''], ['   ']])(
    'connection string %j is not configured; close() twice never rejects',
    async (connectionString) => {
      const store = createPlaceSearchStore({ connectionString });
      expect(await store.searchMatchingPlaces(q())).toStrictEqual(NOT_CONFIGURED);
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
    },
  );

  it('close() twice after a search never rejects', async () => {
    const store = createPlaceSearchStore({ connectionString: testUrl });
    expect((await store.searchMatchingPlaces(q())).ok).toBe(true);
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connection hygiene (AL4 0.1 "DB connections")
// ---------------------------------------------------------------------------

const ActivitySchema = z.object({ rows: z.array(z.object({ n: z.number() })) });

async function otherBackends(): Promise<number> {
  const raw: unknown = await db.raw(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()`,
  );
  const n = ActivitySchema.parse(raw).rows[0]?.n;
  if (n === undefined) throw new Error('no pg_stat_activity count');
  return n;
}

it('30 open / search / close cycles leave the backend count at its baseline', async () => {
  await seedSearchSet(places, embeddings);
  const baseline = await otherBackends();
  for (let i = 0; i < 30; i += 1) {
    expect(await ids(q())).toStrictEqual(SEARCHABLE_RANKING);
  }
  expect(await otherBackends()).toBe(baseline);
}, 60_000);
