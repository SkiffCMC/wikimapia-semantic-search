/**
 * AL2 unit tests: Place Search `searchPlaces` (`src/search/search-places.ts`; AL4 hybrid-search
 * 1.2, 1.4.8, 1.5, U4) against the Test Database. A focused subset of the contract: order of
 * checks, adapter selection, the store lifecycle (created only after a good embedding, closed
 * before the call resolves), the outcome gate and the internal-error fallback.
 *
 * Test doubles: the contract's Simulated Query Embedding Service, plus two module seams that are
 * pass-through / refusing by default and overridden once in single tests (AL3 2.1):
 * `createPlaceSearchStore` (delegates to the real store) and `createVoyageQueryEmbeddingService`
 * (rejects: no real Voyage client is ever built). `searchPlaces` itself is never doubled.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createDb, destroyQuietly } from '../../src/db/connection';
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createPlaceSearchStore } from '../../src/db/search-store';
import type * as SearchStoreModule from '../../src/db/search-store';
import type { PlaceSearchQuery, PlaceSearchStore, StoreResult } from '../../src/db/types';
import { createVoyageQueryEmbeddingService } from '../../src/embed/voyage-service';
import type * as VoyageServiceModule from '../../src/embed/voyage-service';
import { QUERY_EMBEDDING_TIMEOUT_SECONDS } from '../../src/search/query-embedding';
import { searchPlaces } from '../../src/search/search-places';
import type { EmbeddingFailureKind, EmbeddingStore } from '../../contracts/embeddings.schema';
import {
  DEFAULT_RESULT_LIMIT,
  DISTANCE_TOLERANCE_METRES,
  MAX_QUERY_TEXT_LENGTH,
  MAX_RADIUS_METRES,
  MAX_RESULT_LIMIT,
  QueryEmbeddingRequestSchema,
  SIMILARITY_TOLERANCE,
  SearchOutcomeSchema,
  VOYAGE_API_KEY_ENV,
  findResultListIssues,
  queryTextToEmbed,
  wgs84DistanceMetres,
  type SearchFailure,
  type SearchMode,
  type SearchOutcome,
  type SearchPlacesFn,
  type SearchRequest,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';
import {
  AREA_B,
  POINT_S,
  SEARCHABLE_RANKING,
  SimulatedQueryEmbeddingService,
  TEST_VOYAGE_API_KEY,
  connectionError,
  fakeVector,
  queryAnswer,
  queryEmbeddingQ,
  rateLimitError,
  refusedError,
  searchSetPlace,
  seedSearchSet,
  similarityOf,
  unavailableError,
  type QueryServiceAnswer,
} from '../../contracts/hybrid-search.support';
import type { PlaceStore, SchemaSetup, StoreFailure } from '../../contracts/storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';

vi.mock('../../src/db/search-store', async (importOriginal) => {
  const real = await importOriginal<typeof SearchStoreModule>();
  return { ...real, createPlaceSearchStore: vi.fn(real.createPlaceSearchStore) };
});

vi.mock('../../src/embed/voyage-service', async (importOriginal) => {
  const real = await importOriginal<typeof VoyageServiceModule>();
  return {
    ...real,
    createVoyageQueryEmbeddingService: vi.fn<typeof real.createVoyageQueryEmbeddingService>(() =>
      Promise.reject(new Error('createVoyageQueryEmbeddingService must not be called')),
    ),
  };
});

// Compile-time check: the entry point has the contract's signature.
const search: SearchPlacesFn = searchPlaces;
const storeFactory = vi.mocked(createPlaceSearchStore);
const voyageFactory = vi.mocked(createVoyageQueryEmbeddingService);

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;
let db: Knex;
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in search-places tests'));
  });
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

afterEach(() => {
  // Vitest 4: mockReset restores the default implementations given to vi.fn above.
  storeFactory.mockReset();
  voyageFactory.mockReset();
});

afterAll(async () => {
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await destroyQuietly(db);
    await embeddings.close();
    await places.close();
    await setup.close();
    vi.unstubAllGlobals();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Setup {
  answer?: QueryServiceAnswer;
  /** `null` = no key at all. */
  apiKey?: string | null;
  connectionString?: string;
  /** `false` = no injected service (the Voyage adapter is selected). */
  inject?: boolean;
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  const password = decodeURIComponent(new URL(testUrl).password);
  if (password !== '') expect(text).not.toContain(password);
}

/** Calls the real `searchPlaces`; parses the outcome, checks list rules and failure secrets. */
async function run(request: unknown, s: Setup = {}) {
  const service = new SimulatedQueryEmbeddingService(s.answer);
  const typed = request as SearchRequest;
  const outcome: SearchOutcome = SearchOutcomeSchema.parse(
    await search(typed, {
      connectionString: s.connectionString ?? testUrl,
      ...(s.inject === false ? {} : { embeddingService: service }),
      ...(s.apiKey === null ? {} : { apiKey: s.apiKey ?? TEST_VOYAGE_API_KEY }),
    }),
  );
  if (outcome.ok) expect(findResultListIssues(typed, outcome.results)).toStrictEqual([]);
  else expectNoSecrets(JSON.stringify(outcome));
  return { outcome, service };
}

function resultsOf(outcome: SearchOutcome): SearchResult[] {
  if (!outcome.ok) throw new Error(`expected results, got ${outcome.failure.kind}`);
  return outcome.results;
}

function failureOf(outcome: SearchOutcome): SearchFailure {
  if (outcome.ok) throw new Error('expected a Search Failure, got results');
  return outcome.failure;
}

function expectWithin(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function resultOf(placeId: number, similarity = similarityOf(placeId)): SearchResult {
  const place = searchSetPlace(placeId);
  return {
    placeId,
    name: place.name,
    wikimapiaUrl: `http://wikimapia.org/${String(placeId)}`,
    tags: [...(place.tags ?? [])],
    centre: place.centre,
    similarity,
  };
}

/** Overrides the store factory once with a fake store that records calls in order. */
function fakeStore(answer: () => Promise<StoreResult<SearchResult[]>>) {
  const events: string[] = [];
  const queries: PlaceSearchQuery[] = [];
  const store: PlaceSearchStore = {
    searchMatchingPlaces: (query) => {
      events.push('search');
      queries.push(query);
      return answer();
    },
    close: async () => {
      events.push('close');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      events.push('closed');
    },
  };
  storeFactory.mockImplementationOnce(() => store);
  return { events, queries };
}

const Q = 'museum';
const BOTH_MODES: readonly SearchMode[] = ['exact', 'approximate'];

// ---------------------------------------------------------------------------
// 1. Happy path (AC-1, AC-13)
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it.each<[string, Partial<SearchRequest>]>([
    ['mode omitted', {}],
    ['exact', { mode: 'exact' }],
  ])('AC-1 %s: the Searchable Ranking with true similarities', async (_, extra) => {
    await seedSearchSet(places, embeddings);
    const { outcome, service } = await run({ queryText: Q, ...extra });
    const results = resultsOf(outcome);
    expect(results.map((r) => r.placeId)).toStrictEqual(SEARCHABLE_RANKING);
    for (const r of results) {
      expectWithin(r.similarity, similarityOf(r.placeId), SIMILARITY_TOLERANCE);
      expect(r).not.toHaveProperty('distanceMetres');
    }
    expect(service.calls).toHaveLength(1);
    expect(QueryEmbeddingRequestSchema.safeParse(service.calls[0]).success).toBe(true);
  });

  it('AC-1 approximate: a Ranking-Order subset with true similarities', async () => {
    await seedSearchSet(places, embeddings);
    const { outcome, service } = await run({ queryText: Q, mode: 'approximate' });
    for (const r of resultsOf(outcome)) {
      expect(SEARCHABLE_RANKING).toContain(r.placeId);
      expectWithin(r.similarity, similarityOf(r.placeId), SIMILARITY_TOLERANCE);
      expect(r).not.toHaveProperty('distanceMetres');
    }
    expect(service.calls).toHaveLength(1);
    expect(QueryEmbeddingRequestSchema.safeParse(service.calls[0]).success).toBe(true);
  });

  it('AC-13 exact, Point S 500 m: matching ids and WGS 84 Distances', async () => {
    await seedSearchSet(places, embeddings);
    const expected = SEARCHABLE_RANKING.filter(
      (id) => wgs84DistanceMetres(POINT_S, searchSetPlace(id).centre) <= 500,
    );
    const { outcome, service } = await run({ queryText: Q, centre: POINT_S, radiusMetres: 500 });
    const results = resultsOf(outcome);
    expect(results.map((r) => r.placeId)).toStrictEqual(expected);
    for (const r of results) {
      if (r.distanceMetres === undefined) throw new Error('no Distance');
      expectWithin(
        r.distanceMetres,
        wgs84DistanceMetres(POINT_S, r.centre),
        DISTANCE_TOLERANCE_METRES,
      );
    }
    expect(service.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Query Text sent trimmed (AC-3)
// ---------------------------------------------------------------------------

it('AC-3: a Cyrillic Query Text is sent trimmed, inner text unchanged', async () => {
  await seedSearchSet(places, embeddings);
  const text = '  Музеј на тргу \t';
  const { outcome, service } = await run({ queryText: text });
  expect(outcome.ok).toBe(true);
  expect(service.texts).toStrictEqual([queryTextToEmbed(text)]);
  expect(service.texts).toStrictEqual(['Музеј на тргу']);
});

// ---------------------------------------------------------------------------
// 3. Invalid Search Request (AL6 3.7): no service call, no store
// ---------------------------------------------------------------------------

const CENTRE = POINT_S;

it.each<[string, unknown, string]>([
  ['AC-46 missing Query Text', {}, 'queryText'],
  ['AC-46 empty Query Text', { queryText: '' }, 'queryText'],
  ['AC-46 spacing only, approximate', { queryText: ' \t\n ', mode: 'approximate' }, 'queryText'],
  [
    'AC-47 1,001 characters',
    { queryText: `  ${'ж'.repeat(MAX_QUERY_TEXT_LENGTH + 1)} ` },
    'queryText',
  ],
  ...BOTH_MODES.map((mode): [string, unknown, string] => [
    `AC-48 both filters, ${mode}`,
    { queryText: Q, centre: CENTRE, radiusMetres: 500, area: AREA_B, mode },
    'spatialFilter',
  ]),
  ['AC-49 centre without radius', { queryText: Q, centre: CENTRE }, 'radiusMetres'],
  ['AC-49 radius without centre', { queryText: Q, radiusMetres: 500 }, 'centre'],
  [
    'AC-50 latitude 91',
    { queryText: Q, centre: { lat: 91, lon: 20 }, radiusMetres: 500 },
    'centre',
  ],
  [
    'AC-50 longitude Infinity',
    { queryText: Q, centre: { lat: 44, lon: Number.POSITIVE_INFINITY }, radiusMetres: 500 },
    'centre',
  ],
  ['AC-51 radius 0', { queryText: Q, centre: CENTRE, radiusMetres: 0 }, 'radiusMetres'],
  [
    'AC-51 radius above max',
    { queryText: Q, centre: CENTRE, radiusMetres: MAX_RADIUS_METRES + 1 },
    'radiusMetres',
  ],
  ['AC-51 radius NaN', { queryText: Q, centre: CENTRE, radiusMetres: Number.NaN }, 'radiusMetres'],
  [
    'AC-52 south not below north',
    { queryText: Q, area: { ...AREA_B, south: AREA_B.north } },
    'area',
  ],
  [
    'AC-52 missing edge, approximate',
    { queryText: Q, area: { south: 44.8, west: 20.4, north: 44.9 }, mode: 'approximate' },
    'area',
  ],
  ['AC-53 empty tag list', { queryText: Q, tags: [] }, 'tags'],
  ['AC-53 empty title', { queryText: Q, tags: ['museum', ''] }, 'tags'],
  ['AC-53 spacing-only title', { queryText: Q, tags: ['  '] }, 'tags'],
  ['AC-54 limit 0', { queryText: Q, limit: 0 }, 'limit'],
  ['AC-54 limit 2.5', { queryText: Q, limit: 2.5 }, 'limit'],
  ['AC-54 limit above max', { queryText: Q, limit: MAX_RESULT_LIMIT + 1 }, 'limit'],
  ['AC-55 unknown key radius', { queryText: Q, centre: CENTRE, radius: 500 }, 'radius'],
  ['AC-55 unknown key sort', { queryText: Q, sort: 'name' }, 'sort'],
  ['AC-70 mode fast', { queryText: Q, mode: 'fast' }, 'mode'],
  ['AC-70 mode empty', { queryText: Q, mode: '' }, 'mode'],
  ['AC-70 mode EXACT', { queryText: Q, mode: 'EXACT' }, 'mode'],
  ['not an object', null, 'request'],
])('%s: invalid_request naming %s, nothing called', async (_, request, parameter) => {
  const { outcome, service } = await run(request, { connectionString: UNREACHABLE_DATABASE_URL });
  expect(failureOf(outcome)).toMatchObject({ kind: 'invalid_request', parameter });
  expect(service.calls).toHaveLength(0);
  expect(storeFactory).not.toHaveBeenCalled();
  expect(voyageFactory).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 4. Missing Key (AC-56), also with an injected service
// ---------------------------------------------------------------------------

it.each<[string, string | null]>([
  ['absent', null],
  ['empty', ''],
  ['spacing only', '  \t '],
])('AC-56 key %s: missing_key, nothing called', async (_, apiKey) => {
  const { outcome, service } = await run(
    { queryText: Q, centre: POINT_S, radiusMetres: 500 },
    { apiKey, connectionString: UNREACHABLE_DATABASE_URL },
  );
  const failure = failureOf(outcome);
  expect(failure.kind).toBe('missing_key');
  expect(failure.message).toContain(VOYAGE_API_KEY_ENV);
  expect(service.calls).toHaveLength(0);
  expect(storeFactory).not.toHaveBeenCalled();
  expect(voyageFactory).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 5. Query Embedding Failure (AC-57, AC-58): one call, store never created
// ---------------------------------------------------------------------------

const nonFinite = queryEmbeddingQ();
nonFinite[3] = Number.NaN;

it.each<[string, QueryServiceAnswer, EmbeddingFailureKind]>([
  ['connection (no answer)', { error: connectionError() }, 'connection'],
  ['connection (503)', { error: unavailableError() }, 'connection'],
  ['rate limit', { error: rateLimitError() }, 'rate_limit'],
  ['refused', { error: refusedError() }, 'refused'],
  ['no Embedding', { raw: queryAnswer([]) }, 'invalid_answer'],
  [
    'two Embeddings',
    { raw: queryAnswer([queryEmbeddingQ(), queryEmbeddingQ()]) },
    'invalid_answer',
  ],
  ['1023 numbers', { raw: queryAnswer([fakeVector(1023)]) }, 'invalid_answer'],
  ['1025 numbers', { raw: queryAnswer([fakeVector(1025)]) }, 'invalid_answer'],
  ['a non-finite number', { raw: queryAnswer([nonFinite]) }, 'invalid_answer'],
  ['an unreadable answer', { raw: '<html>502 Bad Gateway</html>' }, 'invalid_answer'],
  [
    'model voyage-3.5 (AC-58)',
    { raw: queryAnswer([queryEmbeddingQ()], 'voyage-3.5') },
    'invalid_answer',
  ],
])('AC-57 %s: query_embedding_failed of that kind, 1 call, no store', async (_, answer, kind) => {
  const { outcome, service } = await run(
    { queryText: Q, centre: POINT_S, radiusMetres: 500 },
    { answer, connectionString: UNREACHABLE_DATABASE_URL },
  );
  expect(failureOf(outcome)).toMatchObject({
    kind: 'query_embedding_failed',
    embeddingFailure: kind,
  });
  expect(service.calls).toHaveLength(1);
  expect(storeFactory).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 6. Adapter selection (AL4 1.2 step 3)
// ---------------------------------------------------------------------------

describe('adapter selection', () => {
  it('an injected service: the Voyage adapter factory is never called', async () => {
    await seedSearchSet(places, embeddings);
    const { outcome, service } = await run({ queryText: Q });
    expect(outcome.ok).toBe(true);
    expect(service.calls).toHaveLength(1);
    expect(voyageFactory).not.toHaveBeenCalled();
  });

  it('no injected service: the adapter is built once with the trimmed key and 30 s timeout', async () => {
    await seedSearchSet(places, embeddings);
    const adapter = new SimulatedQueryEmbeddingService();
    voyageFactory.mockResolvedValueOnce(adapter);
    const { outcome } = await run(
      { queryText: Q },
      { inject: false, apiKey: '  key-with-spaces  ' },
    );
    expect(voyageFactory).toHaveBeenCalledTimes(1);
    expect(voyageFactory.mock.calls[0]).toStrictEqual([
      { apiKey: 'key-with-spaces', timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS },
    ]);
    expect(adapter.calls).toHaveLength(1);
    expect(resultsOf(outcome).map((r) => r.placeId)).toStrictEqual(SEARCHABLE_RANKING);
  });

  it.each<[string, () => void]>([
    ['rejects', () => undefined],
    [
      'throws synchronously',
      () => {
        voyageFactory.mockImplementationOnce(() => {
          throw new Error(`cannot load voyageai (Bearer ${TEST_VOYAGE_API_KEY})`);
        });
      },
    ],
  ])('the adapter factory %s: connection failure, store never created', async (_, arrange) => {
    arrange();
    const { outcome } = await run({ queryText: Q }, { inject: false });
    expect(failureOf(outcome)).toStrictEqual({
      kind: 'query_embedding_failed',
      embeddingFailure: 'connection',
      message: 'Embedding Service client could not be loaded',
    });
    expect(storeFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. Store Unavailable (AC-59, AC-60)
// ---------------------------------------------------------------------------

it.each<[string, () => string]>([
  ['unreachable', () => UNREACHABLE_DATABASE_URL],
  ['blank', () => ''],
])(
  'AC-59 %s connection string after a good embedding: store_unavailable',
  async (_, connectionString) => {
    const { outcome, service } = await run(
      { queryText: Q, centre: POINT_S, radiusMetres: 500 },
      { connectionString: connectionString() },
    );
    expect(failureOf(outcome).kind).toBe('store_unavailable');
    expect(service.calls).toHaveLength(1);
    expect(storeFactory).toHaveBeenCalledTimes(1);
  },
  60_000,
);

// ---------------------------------------------------------------------------
// 8. Tag normalisation (AC-27, AC-31, AC-34)
// ---------------------------------------------------------------------------

it.each([[['museum']], [[' Museum ']], [['MUSEUM']], [['museum', ' MUSEUM ']]])(
  'tags %j give AC-27 ids in Exact mode',
  async (tags) => {
    await seedSearchSet(places, embeddings);
    const { outcome } = await run({ queryText: Q, tags });
    expect(resultsOf(outcome).map((r) => r.placeId)).toStrictEqual([102, 101]);
  },
);

// ---------------------------------------------------------------------------
// 9. Gate and internal-error fallback (fake store)
// ---------------------------------------------------------------------------

describe('gate and fallback', () => {
  it('a rejecting store still resolves, without the error text, after close()', async () => {
    const secretText = `boom ${UNREACHABLE_DATABASE_URL} Bearer ${TEST_VOYAGE_API_KEY}`;
    const { events } = fakeStore(() => Promise.reject(new Error(secretText)));
    const { outcome } = await run({ queryText: Q });
    const failure = failureOf(outcome);
    expect(failure.kind).toBe('store_unavailable');
    expect(failure.message).not.toContain('boom');
    expect(events).toStrictEqual(['search', 'close', 'closed']);
  });

  it('results out of Ranking Order fail the result check, never a partial list', async () => {
    const { events } = fakeStore(() =>
      Promise.resolve({ ok: true, value: [resultOf(101), resultOf(102)] }),
    );
    const { outcome } = await run({ queryText: Q });
    expect(failureOf(outcome)).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store unavailable: search results failed the result check',
    });
    expect(events).toStrictEqual(['search', 'close', 'closed']);
  });

  it('a store failure is passed on with exactly its message', async () => {
    const failure: StoreFailure = {
      kind: 'store_unavailable',
      message: 'Place Store unavailable: synthetic store failure (code 57P01)',
    };
    const { events } = fakeStore(() => Promise.resolve({ ok: false, failure }));
    const { outcome } = await run({ queryText: Q });
    expect(failureOf(outcome)).toStrictEqual(failure);
    expect(events).toStrictEqual(['search', 'close', 'closed']);
  });

  it.each<[string, SearchRequest, PlaceSearchQuery]>([
    [
      'no filters',
      { queryText: Q },
      { queryEmbedding: queryEmbeddingQ(), mode: 'exact', limit: DEFAULT_RESULT_LIMIT },
    ],
    [
      'radius, tags, limit, approximate',
      {
        queryText: Q,
        centre: POINT_S,
        radiusMetres: 500,
        tags: [' Museum ', 'MUSEUM', 'Hotel'],
        limit: 5,
        mode: 'approximate',
      },
      {
        queryEmbedding: queryEmbeddingQ(),
        mode: 'approximate',
        limit: 5,
        radius: { centre: POINT_S, radiusMetres: 500 },
        tagTitles: ['museum', 'hotel'],
      },
    ],
    [
      'area',
      { queryText: Q, area: AREA_B },
      {
        queryEmbedding: queryEmbeddingQ(),
        mode: 'exact',
        limit: DEFAULT_RESULT_LIMIT,
        area: AREA_B,
      },
    ],
  ])('%s: the store receives the derived PlaceSearchQuery', async (_, request, expected) => {
    const { queries } = fakeStore(() => Promise.resolve({ ok: true, value: [] }));
    const { outcome } = await run(request, { connectionString: 'postgres-fake-connection' });
    expect(outcome).toStrictEqual({ ok: true, results: [] });
    expect(storeFactory.mock.calls).toStrictEqual([
      [{ connectionString: 'postgres-fake-connection' }],
    ]);
    expect(queries).toStrictEqual([expected]);
    const query = queries[0];
    for (const key of ['radius', 'area', 'tagTitles'] as const) {
      if (!(key in expected)) expect(query).not.toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Connection hygiene: close before resolve
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

it('30 mixed searches leave the backend count at its baseline once each resolved', async () => {
  await seedSearchSet(places, embeddings);
  const baseline = await otherBackends();
  for (let i = 0; i < 30; i += 1) {
    const mode = BOTH_MODES[i % 2] ?? 'exact';
    const kind = i % 3;
    const { outcome } = await run(
      { queryText: Q, mode },
      kind === 0
        ? {}
        : kind === 1
          ? { connectionString: UNREACHABLE_DATABASE_URL }
          : { answer: { error: connectionError() } },
    );
    expect(outcome.ok).toBe(kind === 0);
  }
  expect(await otherBackends()).toBe(baseline);
}, 120_000);

it('no test reached the network', () => {
  expect(fetchCalls).toStrictEqual([]);
});
