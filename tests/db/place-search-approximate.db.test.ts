/**
 * AL2 unit tests: Approximate mode of the search repository (AL4 hybrid-search 1.4.4, U3) at the
 * store level, against the Test Database with the Query Embedding Q. Mirrors the contract's
 * AC-63 .. AC-69 (`MODE_REQUESTS`) plus AC-4, AC-14, AC-15, AC-21, AC-23. Black-box Approximate
 * results may be fewer than N (AC-67), so these tests check each returned row against the
 * oracles, never a particular count. The statement shape is checked purely on
 * `buildPlaceSearchStatement`.
 */
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { buildPlaceSearchStatement } from '../../src/db/place-search';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createPlaceSearchStore } from '../../src/db/search-store';
import type { PlaceSearchQuery, PlaceSearchStore } from '../../src/db/types';
import { toVectorLiteral } from '../../src/db/vector';
import type { EmbeddingStore } from '../../contracts/embeddings.schema';
import {
  DEFAULT_RESULT_LIMIT,
  DISTANCE_TOLERANCE_METRES,
  MAX_RESULT_LIMIT,
  SIMILARITY_TOLERANCE,
  isInRankingOrder,
  normalizeTagTitle,
  tagTitlesMatch,
  wgs84DistanceMetres,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';
import {
  AREA_B,
  POINT_S,
  SEARCHABLE_RANKING,
  SEARCH_SET,
  isSearchable,
  liesInArea,
  manyPlaces,
  queryEmbeddingQ,
  seedPlaces,
  seedSearchSet,
  similarityOf,
  type SyntheticSearchPlace,
} from '../../contracts/hybrid-search.support';
import type { PlaceStore, SchemaSetup } from '../../contracts/storage.schema';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;

beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect((await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
  embeddings = createEmbeddingStore({ connectionString: testUrl });
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await embeddings.close();
    await places.close();
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryParts = Partial<PlaceSearchQuery>;

/** An Approximate query with Q and the Default Result Limit unless overridden. */
function approx(parts: QueryParts = {}): PlaceSearchQuery {
  return {
    queryEmbedding: queryEmbeddingQ(),
    mode: 'approximate',
    limit: DEFAULT_RESULT_LIMIT,
    ...parts,
  };
}

const sRadius = (radiusMetres: number): QueryParts => ({
  radius: { centre: POINT_S, radiusMetres },
});

/** One store per test, always closed. */
async function withStore<T>(use: (store: PlaceSearchStore) => Promise<T>): Promise<T> {
  const store = createPlaceSearchStore({ connectionString: testUrl });
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}

async function resultsWith(store: PlaceSearchStore, query: PlaceSearchQuery) {
  const result = await store.searchMatchingPlaces(query);
  if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

const results = (query: PlaceSearchQuery): Promise<SearchResult[]> =>
  withStore((store) => resultsWith(store, query));

function resultFor(list: readonly SearchResult[], placeId: number): SearchResult {
  const found = list.find((r) => r.placeId === placeId);
  if (found === undefined) throw new Error(`place ${String(placeId)} was not returned`);
  return found;
}

function expectSimilarity(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(SIMILARITY_TOLERANCE);
}

/** Oracle: the place is a Matching Place of the query (glossary). */
function isMatching(place: SyntheticSearchPlace, query: PlaceSearchQuery): boolean {
  const { radius, area, tagTitles } = query;
  return (
    isSearchable(place) &&
    (radius === undefined ||
      wgs84DistanceMetres(radius.centre, place.centre) <= radius.radiusMetres) &&
    (area === undefined || liesInArea(place, area)) &&
    (tagTitles === undefined ||
      tagTitles.some((f) => (place.tags ?? []).some((t) => tagTitlesMatch(f, t))))
  );
}

/** Every result is a Matching Place with its true content, in Ranking Order, none twice. */
function expectMatchingResults(
  query: PlaceSearchQuery,
  list: readonly SearchResult[],
  seeded: readonly SyntheticSearchPlace[] = SEARCH_SET,
): void {
  expect(list.length).toBeLessThanOrEqual(query.limit);
  expect(isInRankingOrder(list)).toBe(true);
  for (const r of list) {
    const place = seeded.find((p) => p.placeId === r.placeId);
    if (place === undefined) throw new Error(`unknown place ${String(r.placeId)} returned`);
    expect(isMatching(place, query)).toBe(true);
    expectSimilarity(r.similarity, similarityOf(r.placeId, seeded));
    expect(r.name).toBe(place.name);
    expect(r.wikimapiaUrl).toBe(`http://wikimapia.org/${String(place.placeId)}`);
    expect(r.tags).toStrictEqual(place.tags ?? []);
    expect(r.centre).toStrictEqual(place.centre);
  }
}

/** The contract's `MODE_REQUESTS`, translated to store queries. */
const MODE_QUERIES: [string, PlaceSearchQuery, number[]][] = [
  ['AC-1 (no filters)', approx(), [...SEARCHABLE_RANKING]],
  ['AC-13 (Radius 500)', approx(sRadius(500)), [102, 101, 108, 109, 104]],
  ['AC-22 (Area B)', approx({ area: AREA_B }), [102, 101, 108, 109]],
  [
    'AC-29 (Tags and Radius)',
    approx({ ...sRadius(500), tagTitles: ['museum', 'hotel'].map(normalizeTagTitle) }),
    [102, 101],
  ],
];

// ---------------------------------------------------------------------------
// Results (AC-4, AC-14, AC-15, AC-21, AC-23, AC-65 .. AC-69)
// ---------------------------------------------------------------------------

describe('approximate results', () => {
  it.each(MODE_QUERIES)(
    'AC-4, AC-15, AC-23, AC-65, AC-66 %s: only expected Matching Places, true content, Ranking Order',
    async (_, query, expected) => {
      await seedSearchSet(places, embeddings);
      const list = await results(query);
      expectMatchingResults(query, list);
      for (const r of list) expect(expected).toContain(r.placeId);
    },
  );

  it('AC-14: each Distance is within tolerance of the WGS 84 distance; Place 101 reports 0', async () => {
    await seedSearchSet(places, embeddings);
    const list = await results(approx({ ...sRadius(500), limit: MAX_RESULT_LIMIT }));
    for (const r of list) {
      const truth = wgs84DistanceMetres(POINT_S, r.centre);
      expect(Math.abs((r.distanceMetres ?? Number.NaN) - truth)).toBeLessThanOrEqual(
        DISTANCE_TOLERANCE_METRES,
      );
    }
    expect(resultFor(list, 101).distanceMetres).toBe(0);
  });

  it.each([[1], [2], [MAX_RESULT_LIMIT]])(
    'AC-67: Result Limit %i gives at most that many, none twice',
    async (limit) => {
      await seedSearchSet(places, embeddings);
      const list = await results(approx({ limit }));
      expect(list.length).toBeLessThanOrEqual(limit);
      expect(new Set(list.map((r) => r.placeId)).size).toBe(list.length);
    },
  );

  it('AC-68, AC-21: each Approximate result equals its Exact twin; no Distance key without a Radius', async () => {
    await seedSearchSet(places, embeddings);
    const query = approx({ ...sRadius(1000), limit: MAX_RESULT_LIMIT });
    await withStore(async (store) => {
      const exact = await resultsWith(store, { ...query, mode: 'exact' });
      const approximate = await resultsWith(store, query);
      for (const r of approximate) {
        const twin = resultFor(exact, r.placeId);
        expect({ ...r, similarity: 0, distanceMetres: 0 }).toStrictEqual({
          ...twin,
          similarity: 0,
          distanceMetres: 0,
        });
        expectSimilarity(r.similarity, twin.similarity);
        expect(
          Math.abs((r.distanceMetres ?? Number.NaN) - (twin.distanceMetres ?? Number.NaN)),
        ).toBeLessThan(0.001);
      }
      const unfiltered = await resultsWith(store, approx({ limit: MAX_RESULT_LIMIT }));
      expect(unfiltered.length).toBeGreaterThan(0);
      for (const r of unfiltered) expect(r).not.toHaveProperty('distanceMetres');
    });
  });

  it.each<[string, QueryParts, boolean]>([
    ['an empty circle', { radius: { centre: { lat: 45, lon: 21 }, radiusMetres: 500 } }, true],
    ['an empty box', { area: { south: 10, west: 10, north: 10.1, east: 10.1 } }, true],
    ['the unknown Tag volcano', { tagTitles: ['volcano'] }, true],
    ['an empty store', {}, false],
  ])('AC-69: %s gives an empty list, not a failure', async (_, parts, seed) => {
    if (seed) await seedSearchSet(places, embeddings);
    const result = await withStore((store) => store.searchMatchingPlaces(approx(parts)));
    expect(result).toStrictEqual({ ok: true, value: [] });
  });

  it('60 seeded Places, no filter: at most 50 results, all correct', async () => {
    const many = manyPlaces({
      firstId: 601,
      count: 60,
      centre: POINT_S,
      tag: 'museum',
      top: 0.9,
      step: 0.01,
    });
    await seedPlaces(places, embeddings, many);
    const query = approx({ limit: MAX_RESULT_LIMIT });
    expectMatchingResults(query, await results(query), many);
  });
});

// ---------------------------------------------------------------------------
// Statement shape (pure; AL4 1.4.4 Approximate mode)
// ---------------------------------------------------------------------------

describe('approximate statement shape', () => {
  const SPATIAL: [string, QueryParts][] = [
    ['no spatial filter', {}],
    ['radius', sRadius(500)],
    ['area', { area: AREA_B }],
  ];
  const TAGS: [string, QueryParts][] = [
    ['no tags', {}],
    ['tags', { tagTitles: ['museum'] }],
  ];

  it.each(
    SPATIAL.flatMap(([spatial, s]) =>
      TAGS.map(([tags, t]): [string, string, QueryParts] => [spatial, tags, { ...s, ...t }]),
    ),
  )(
    '%s, %s: HNSW-servable inner sort, no fence, no index or setting names, vector bound twice',
    (_s, _t, parts) => {
      const { sql, bindings } = buildPlaceSearchStatement(approx(parts));
      expect(sql).toMatch(/order by e\.embedding <=> \?::vector\s+limit \?::int/);
      expect(sql).not.toMatch(/materialized/i);
      expect(sql).not.toMatch(/hnsw/i);
      expect(sql).not.toMatch(/ef_search/i);
      const literal = toVectorLiteral(queryEmbeddingQ());
      expect(bindings.filter((b) => b === literal)).toHaveLength(2);
    },
  );
});
