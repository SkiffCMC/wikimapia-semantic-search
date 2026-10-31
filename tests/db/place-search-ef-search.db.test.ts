/**
 * AL2 unit tests: decision D-EF (AL4 hybrid-search 1.4.8 lazy per-mode pool, 1.4.9 session
 * setting, U3) against the Test Database with the Search Set plus 1,000 Places, analyzed.
 * - The setting itself: the Approximate search connection reads an ef_search of 100, the Exact
 *   one the default. The tests never change that setting: they only read it with
 *   `current_setting`.
 * - Limit and correctness of both modes through the store. On this data the planner does not
 *   pick the HNSW index for Approximate mode (AL4 1.4.10), so the store-level count of 50 says
 *   nothing about ef_search. The behavioural D-EF proof is the forced-plan test over the HNSW
 *   cloud in `place-search-hnsw-cloud.db.test.ts` (AL4 1.4.11).
 * - Lifecycle of the lazy per-mode pools.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createDb, destroyQuietly } from '../../src/db/connection';
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createPlaceSearchStore, openSearchDb } from '../../src/db/search-store';
import type { PlaceSearchQuery, StoreResult } from '../../src/db/types';
import { toVectorLiteral } from '../../src/db/vector';
import {
  MAX_RESULT_LIMIT,
  SIMILARITY_TOLERANCE,
  compareRankingOrder,
  isInRankingOrder,
  type SearchMode,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';
import {
  SEARCH_SET,
  isSearchable,
  manyPlaces,
  queryEmbeddingQ,
  seedPlaces,
  similarityOf,
} from '../../contracts/hybrid-search.support';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const CLOSED = {
  ok: false,
  failure: { kind: 'store_unavailable', message: 'Place Store unavailable: the store is closed' },
};

const SEEDED = [
  ...SEARCH_SET,
  ...manyPlaces({
    firstId: 3001,
    count: 1000,
    centre: { lat: 45.5, lon: 20.457 },
    tag: 'hotel',
    top: 0.9849,
    step: 0.0005,
  }),
];

let testUrl = '';
let db: Knex;

/**
 * All tests here are read-only, so the Places are seeded once. The seeding stores are closed
 * right after, so their idle connections cannot drift the backend count during a test.
 */
beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  const setup = createSchemaSetup({ connectionString: testUrl });
  const places = createPlaceStore({ connectionString: testUrl });
  const embeddings = createEmbeddingStore({ connectionString: testUrl });
  try {
    expect((await setup.apply()).ok).toBe(true);
    expect((await setup.emptyStore()).ok).toBe(true);
    await seedPlaces(places, embeddings, SEEDED);
  } finally {
    await embeddings.close();
    await places.close();
    await setup.close();
  }
  db = createDb(testUrl, 1);
  await db.raw('analyze places, place_embeddings, place_tags, tags');
}, 300_000);

afterAll(async () => {
  const setup = createSchemaSetup({ connectionString: testUrl });
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await destroyQuietly(db);
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(mode: SearchMode): PlaceSearchQuery {
  return { queryEmbedding: queryEmbeddingQ(), mode, limit: MAX_RESULT_LIMIT };
}

async function searchWith(query: PlaceSearchQuery): Promise<StoreResult<SearchResult[]>> {
  const store = createPlaceSearchStore({ connectionString: testUrl });
  try {
    return await store.searchMatchingPlaces(query);
  } finally {
    await store.close();
  }
}

async function results(query: PlaceSearchQuery): Promise<SearchResult[]> {
  const result = await searchWith(query);
  if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

/** Oracle: the true top 50 of every Searchable seeded Place, in Ranking Order. */
const TRUE_TOP_50 = SEEDED.filter(isSearchable)
  .map((p) => ({ placeId: p.placeId, similarity: p.similarity ?? Number.NaN }))
  .sort(compareRankingOrder)
  .slice(0, MAX_RESULT_LIMIT)
  .map((p) => p.placeId);

function expectTrueSearchable(list: readonly SearchResult[]): void {
  expect(isInRankingOrder(list)).toBe(true);
  for (const r of list) {
    const place = SEEDED.find((p) => p.placeId === r.placeId);
    expect(place !== undefined && isSearchable(place)).toBe(true);
    expect(Math.abs(r.similarity - similarityOf(r.placeId, SEEDED))).toBeLessThanOrEqual(
      SIMILARITY_TOLERANCE,
    );
  }
}

const SettingSchema = z.object({ rows: z.array(z.object({ value: z.string().nullable() })) });

async function efSearch(handle: Knex): Promise<string | null | undefined> {
  const raw: unknown = await handle.raw("select current_setting('hnsw.ef_search', true) as value");
  return SettingSchema.parse(raw).rows[0]?.value;
}

async function castVector(handle: Knex): Promise<void> {
  await handle.raw('select ?::vector as v', [toVectorLiteral(queryEmbeddingQ())]);
}

const ActivitySchema = z.object({ rows: z.array(z.object({ n: z.number() })) });

async function otherBackends(): Promise<number> {
  const raw: unknown = await db.raw(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and backend_type = 'client backend'`,
  );
  const n = ActivitySchema.parse(raw).rows[0]?.n;
  if (n === undefined) throw new Error('no pg_stat_activity count');
  return n;
}

// ---------------------------------------------------------------------------
// The setting (D-EF)
// ---------------------------------------------------------------------------

describe('ef_search on the search connections', () => {
  it('the Approximate handle reads 100 before and after a vector cast; the Exact handle reads 40', async () => {
    const approximate = openSearchDb(testUrl, 'approximate');
    const exact = openSearchDb(testUrl, 'exact');
    try {
      expect(await efSearch(approximate)).toBe('100');
      await castVector(approximate);
      expect(await efSearch(approximate)).toBe('100');
      await castVector(exact);
      expect(await efSearch(exact)).toBe('40');
    } finally {
      await destroyQuietly(approximate);
      await destroyQuietly(exact);
    }
  });
});

// ---------------------------------------------------------------------------
// Limit and correctness through the store (not ef_search evidence; see the header)
// ---------------------------------------------------------------------------

describe('unfiltered limit-50 searches through the store', () => {
  it('Approximate, no filter, limit 50: exactly 50 Searchable Places with true similarities, in Ranking Order', async () => {
    const list = await results(q('approximate'));
    expect(list).toHaveLength(MAX_RESULT_LIMIT);
    expect(new Set(list.map((r) => r.placeId)).size).toBe(list.length);
    expectTrueSearchable(list);
  });

  it('Exact, no filter, limit 50 through the store gives the true top 50', async () => {
    const list = await results(q('exact'));
    expect(list.map((r) => r.placeId)).toStrictEqual(TRUE_TOP_50);
    expectTrueSearchable(list);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle of the lazy per-mode pools (AL4 1.4.8)
// ---------------------------------------------------------------------------

describe('search store lifecycle', () => {
  it('30 open / search / close cycles alternating modes leave the backend count at its baseline', async () => {
    const baseline = await otherBackends();
    for (let i = 0; i < 30; i += 1) {
      expect((await results(q(i % 2 === 0 ? 'exact' : 'approximate'))).length).toBeGreaterThan(0);
    }
    expect(await otherBackends()).toBe(baseline);
  }, 120_000);

  it('a search after close() resolves store_unavailable (closed) and opens no connection', async () => {
    const baseline = await otherBackends();
    const store = createPlaceSearchStore({ connectionString: testUrl });
    expect((await store.searchMatchingPlaces(q('approximate'))).ok).toBe(true);
    await store.close();
    expect(await store.searchMatchingPlaces(q('approximate'))).toStrictEqual(CLOSED);
    expect(await store.searchMatchingPlaces(q('exact'))).toStrictEqual(CLOSED);
    expect(await otherBackends()).toBe(baseline);
  });

  it('a store searched in both modes holds two backends until close()', async () => {
    const baseline = await otherBackends();
    const store = createPlaceSearchStore({ connectionString: testUrl });
    try {
      expect((await store.searchMatchingPlaces(q('exact'))).ok).toBe(true);
      expect((await store.searchMatchingPlaces(q('approximate'))).ok).toBe(true);
      expect(await otherBackends()).toBe(baseline + 2);
    } finally {
      await store.close();
    }
    expect(await otherBackends()).toBe(baseline);
  });
});
