/**
 * AL5 CONTRACT TESTS: Hybrid Search, Place Search (behaviour, black box, Test Database).
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261027-hybrid-search-al6.md (revision 3; one describe per
 *           AC, AC-1 .. AC-71; AC-72 runs the command through pnpm and lives in
 *           ./hybrid-search.command.test.ts, which needs no database)
 * Enforces: .agrules section 1 (filters restrict, meaning ranks; nothing outside the Spatial
 *           Filter or the Tag Filter in either Search Mode; only the Query Text is embedded),
 *           section 2 (one `voyage-4` query Embedding of 1024 numbers, `inputType: "query"`,
 *           only `voyage-4` Embedding Records compared, every answer validated, every result
 *           parsed with its Zod schema and links back to its Place), section 3 (parameterized
 *           queries: special characters change nothing), section 4 (read only, attribution
 *           line, no secrets in failures, no live network, Test Database only, synthetic data).
 *
 * Subjects under test, never doubled: `searchPlaces` (src/search/search-places.ts) and
 * `runSearchCommand` (src/search/command.ts). The finished `createPlaceStore`,
 * `createSchemaSetup`, `createEmbeddingStore` and `buildPlaceDocument` set up and inspect the
 * Test Database. Only the Embedding Service is a test double (Simulated Embedding Service
 * answering Q). Until AL2 exists this file fails to import: that is the expected red state.
 *
 * Approximate mode is checked only for the guarantees of AC-65 .. AC-69 (inside the filters, no
 * repeats, at most N, Ranking Order, true scores and content); no test requires a particular
 * number of Approximate results or that a particular Place appears (AL6 section 5).
 *
 * Schema-only and validator checks live in ./hybrid-search.schema.test.ts and pass before AL2.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createEmbeddingStore } from '../src/db/embedding-store';
import { createPlaceStore } from '../src/db/place-store';
import { createSchemaSetup } from '../src/db/schema-setup';
import { buildPlaceDocument } from '../src/embed/place-document';
import { runSearchCommand } from '../src/search/command';
import { searchPlaces } from '../src/search/search-places';
import {
  EMBEDDING_MODEL,
  EmbeddingStoreCountsResultSchema,
  QUERY_INPUT_TYPE,
  ReadEmbeddingRecordResultSchema,
  isEmbeddingDue,
  type EmbeddingFailureKind,
  type EmbeddingStore,
} from './embeddings.schema';
import {
  ATTRIBUTION_LINE,
  DATABASE_URL_ENV,
  DISTANCE_TOLERANCE_METRES,
  MAX_QUERY_TEXT_LENGTH,
  MAX_RADIUS_METRES,
  MAX_RESULT_LIMIT,
  MODE_LINES,
  NO_RESULTS_LINE,
  QueryEmbeddingRequestSchema,
  SEARCH_COMMAND_OPTIONS,
  SEARCH_FAILURE_LABELS,
  SEARCH_SCRIPT,
  SIMILARITY_TOLERANCE,
  SearchCommandResultSchema,
  SearchOutcomeSchema,
  VOYAGE_API_KEY_ENV,
  findResultListIssues,
  hasRadiusFilter,
  isSearchUsageLine,
  resultCountLine,
  searchResultBlock,
  tagTitlesMatch,
  wgs84DistanceMetres,
  type AreaFilter,
  type RunSearchCommandFn,
  type SearchFailure,
  type SearchMode,
  type SearchOutcome,
  type SearchPlacesFn,
  type SearchRequest,
  type SearchResult,
} from './hybrid-search.schema';
import {
  AREA_B,
  NOT_SEARCHABLE_IDS,
  POINT_S,
  SEARCHABLE_RANKING,
  SEARCH_SET,
  SimulatedQueryEmbeddingService,
  TEST_VOYAGE_API_KEY,
  connectionError,
  fakeVector,
  isSearchable,
  liesInArea,
  manyPlaces,
  queryAnswer,
  queryEmbeddingQ,
  rateLimitError,
  recordOf,
  refusedError,
  saveRecords,
  searchSetPlace,
  seedPlaces,
  seedSearchSet,
  unavailableError,
  type QueryServiceAnswer,
  type SyntheticSearchPlace,
} from './hybrid-search.support';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  TagCatalogueResultSchema,
  type CreatePlaceStoreFn,
  type CreateSchemaSetupFn,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
} from './storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  clientDetails,
  clientListing,
  requireTestDatabaseUrl,
} from './storage.support';
import { FIXTURE_NAMES, TEST_API_KEY } from './wikimapia-client.support';

// Compile-time check: the entry points have the contract's signatures.
const searchFn: SearchPlacesFn = searchPlaces;
const command: RunSearchCommandFn = runSearchCommand;
const createStore: CreatePlaceStoreFn = createPlaceStore;
const createSetup: CreateSchemaSetupFn = createSchemaSetup;

// ---------------------------------------------------------------------------
// Lifecycle: one Test Database, every Schema Setup step applied, emptied before every test
// (AC-62, Embeddings AC-58)
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let store: PlaceStore;
let embeddings: EmbeddingStore;
/** Every attempted global `fetch` (Voyage, Anthropic, Wikimapia, anything): must stay empty (AC-61). */
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in hybrid-search contract tests'));
  });
  testUrl = requireTestDatabaseUrl();
  setup = createSetup({ connectionString: testUrl });
  okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  store = createStore({ connectionString: testUrl });
  embeddings = createEmbeddingStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  await embeddings.close();
  await store.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers (every outcome is parsed with its contract schema before use)
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

const BOTH_MODES: readonly SearchMode[] = ['exact', 'approximate'];

interface SearchSetup {
  answer?: QueryServiceAnswer;
  /** `null` = no key at all. */
  apiKey?: string | null;
  connectionString?: string;
}

/** Calls the real `searchPlaces`; a list outcome is also checked with `findResultListIssues`. */
async function search(request: SearchRequest, s: SearchSetup = {}) {
  const service = new SimulatedQueryEmbeddingService(s.answer);
  const outcome: SearchOutcome = SearchOutcomeSchema.parse(
    await searchFn(request, {
      connectionString: s.connectionString ?? testUrl,
      embeddingService: service,
      ...(s.apiKey === null ? {} : { apiKey: s.apiKey ?? TEST_VOYAGE_API_KEY }),
    }),
  );
  if (outcome.ok) expect(findResultListIssues(request, outcome.results)).toStrictEqual([]);
  return { outcome, service };
}

/** For requests that break the contract's types on purpose (section 3.7). */
async function searchUnchecked(request: unknown, s: SearchSetup = {}) {
  return search(request as never, s);
}

function resultsOf(outcome: SearchOutcome): SearchResult[] {
  if (!outcome.ok) {
    throw new Error(`expected results, got ${outcome.failure.kind}: ${outcome.failure.message}`);
  }
  return outcome.results;
}

function failureOf(outcome: SearchOutcome): SearchFailure {
  if (outcome.ok) throw new Error('expected a Search Failure, got results');
  return outcome.failure;
}

async function resultsFor(request: SearchRequest, s: SearchSetup = {}): Promise<SearchResult[]> {
  return resultsOf((await search(request, s)).outcome);
}

async function idsFor(request: SearchRequest): Promise<number[]> {
  return (await resultsFor(request)).map((r) => r.placeId);
}

function resultFor(results: readonly SearchResult[], placeId: number): SearchResult {
  const result = results.find((r) => r.placeId === placeId);
  if (result === undefined) throw new Error(`place ${String(placeId)} was not returned`);
  return result;
}

function expectSimilarity(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(SIMILARITY_TOLERANCE);
}

/** Oracle: the Matching Places of a request among synthetic Places (glossary). */
function matchingIds(request: SearchRequest, places: readonly SyntheticSearchPlace[]): Set<number> {
  const matching = places.filter((place) => {
    if (!isSearchable(place)) return false;
    if (hasRadiusFilter(request)) {
      if (wgs84DistanceMetres(request.centre, place.centre) > request.radiusMetres) return false;
    }
    if (request.area !== undefined && !liesInArea(place, request.area)) return false;
    if (request.tags !== undefined) {
      const present = place.tags ?? [];
      if (!request.tags.some((f) => present.some((t) => tagTitlesMatch(f, t)))) return false;
    }
    return true;
  });
  return new Set(matching.map((p) => p.placeId));
}

/**
 * The guarantees of every Search Result in either mode (AC-14, AC-15, AC-23, AC-65, AC-66,
 * AC-68): a Matching Place, true similarity, content as stored.
 */
function expectMatchingResults(
  request: SearchRequest,
  results: readonly SearchResult[],
  places: readonly SyntheticSearchPlace[] = SEARCH_SET,
): void {
  const matching = matchingIds(request, places);
  for (const r of results) {
    expect(matching.has(r.placeId)).toBe(true);
    const place = places.find((p) => p.placeId === r.placeId);
    if (place?.similarity === undefined) throw new Error('unknown place returned');
    expectSimilarity(r.similarity, place.similarity);
    expect(r.name).toBe(place.name);
    expect(r.wikimapiaUrl).toBe(`http://wikimapia.org/${String(place.placeId)}`);
    expect(r.tags).toStrictEqual(place.tags ?? []);
    expect(r.centre).toStrictEqual(place.centre);
  }
}

/** Every stored item the search could touch (AC-39). */
async function snapshot(placeIds: readonly number[]) {
  const places = [];
  const records = [];
  for (const placeId of placeIds) {
    places.push(ReadPlaceResultSchema.parse(await store.readPlace({ placeId })));
    records.push(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId })),
    );
  }
  return {
    counts: okValue(StoreCountsResultSchema.parse(await store.countStored())),
    embeddingCounts: okValue(
      EmbeddingStoreCountsResultSchema.parse(await embeddings.countEmbeddingStore()),
    ),
    tags: okValue(TagCatalogueResultSchema.parse(await store.listTags())),
    places,
    records,
  };
}

const SEARCH_SET_IDS = SEARCH_SET.map((p) => p.placeId);

async function runCommand(
  argv: readonly string[],
  extra: {
    env?: Partial<Record<typeof VOYAGE_API_KEY_ENV | typeof DATABASE_URL_ENV, string>>;
    answer?: QueryServiceAnswer;
  } = {},
) {
  const service = new SimulatedQueryEmbeddingService(extra.answer);
  const output: string[] = [];
  const result = SearchCommandResultSchema.parse(
    await command(argv, {
      env: extra.env ?? { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, [DATABASE_URL_ENV]: testUrl },
      write: (line) => {
        output.push(line);
      },
      embeddingService: service,
    }),
  );
  return { result, output, service };
}

function commandResults(result: { outcome?: SearchOutcome | undefined }): SearchResult[] {
  if (result.outcome === undefined) throw new Error('the command made no search');
  return resultsOf(result.outcome);
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  const password = decodeURIComponent(new URL(testUrl).password);
  if (password !== '') expect(text).not.toContain(password);
}

const S_RADIUS = (radiusMetres: number): SearchRequest => ({
  queryText: 'museum',
  centre: POINT_S,
  radiusMetres,
});

// ===========================================================================
// 3.1 Ranking by meaning (US-1, US-5, US-8)
// ===========================================================================

describe('AC-1 No filters', () => {
  it('returns the six Searchable Places in Ranking Order with their true Similarity Scores', async () => {
    await seedSearchSet(store, embeddings);
    const results = await resultsFor({ queryText: 'museum' });
    expect(results.map((r) => r.placeId)).toStrictEqual(SEARCHABLE_RANKING);
    [0.99, 0.95, 0.9, 0.7, 0.6, 0.5].forEach((score, i) => {
      expectSimilarity(results[i]?.similarity ?? Number.NaN, score);
    });
  });
});

describe('AC-2 Query embedded as a query', () => {
  it.each(BOTH_MODES)(
    '%s mode: one Embedding Request, the Query Text only, voyage-4, Document Kind query',
    async (mode) => {
      await seedSearchSet(store, embeddings);
      const { outcome, service } = await search({ ...S_RADIUS(500), tags: ['museum'], mode });
      expect(outcome.ok).toBe(true);
      expect(service.calls).toHaveLength(1);
      const request = QueryEmbeddingRequestSchema.parse(service.calls[0]);
      expect(request.input).toStrictEqual(['museum']);
      expect(request.model).toBe(EMBEDDING_MODEL);
      expect(request.inputType).toBe(QUERY_INPUT_TYPE);
    },
  );
});

describe('AC-3 Query Text as given', () => {
  it.each([
    ['  quiet spot near the river  ', 'quiet spot near the river'],
    ['\t Трг Републике — Đinđić, Dorćol \n', 'Трг Републике — Đinđić, Dorćol'],
  ])('%j is sent as %j', async (queryText, sent) => {
    await seedSearchSet(store, embeddings);
    const { outcome, service } = await search({ queryText });
    expect(outcome.ok).toBe(true);
    expect(service.texts).toStrictEqual([sent]);
  });
});

describe('AC-4 Only Searchable Places', () => {
  const requests: SearchRequest[] = [
    { queryText: 'museum', limit: MAX_RESULT_LIMIT },
    { ...S_RADIUS(50), limit: MAX_RESULT_LIMIT },
    { queryText: 'museum', area: AREA_B, limit: MAX_RESULT_LIMIT },
    { queryText: 'museum', tags: ['museum'], limit: MAX_RESULT_LIMIT },
  ];
  it.each(BOTH_MODES)(
    '%s mode: 105, 106, 107 and 110 are never returned, whatever the filters',
    async (mode) => {
      await seedSearchSet(store, embeddings);
      for (const request of requests) {
        const ids = (await resultsFor({ ...request, mode })).map((r) => r.placeId);
        for (const id of NOT_SEARCHABLE_IDS) expect(ids).not.toContain(id);
      }
    },
  );
});

describe('AC-5 Result Limit', () => {
  it('Result Limit 3 returns the 3 best', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', limit: 3 })).toStrictEqual([103, 102, 101]);
  });
});

describe('AC-6 Default Result Limit', () => {
  it('25 Searchable Places, no Result Limit: exactly the best 20, in Ranking Order', async () => {
    const places = manyPlaces({
      firstId: 501,
      count: 25,
      centre: POINT_S,
      tag: 'museum',
      top: 0.9,
      step: 0.01,
    });
    await seedPlaces(store, embeddings, places);
    const expected = [...places]
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, 20)
      .map((p) => p.placeId);
    expect(await idsFor({ queryText: 'museum' })).toStrictEqual(expected);
  });
});

describe('AC-7 Highest Result Limit', () => {
  it('60 Searchable Places, Result Limit 50: exactly the best 50, in Ranking Order', async () => {
    const places = manyPlaces({
      firstId: 601,
      count: 60,
      centre: POINT_S,
      tag: 'museum',
      top: 0.9,
      step: 0.01,
    });
    await seedPlaces(store, embeddings, places);
    const expected = [...places]
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, 50)
      .map((p) => p.placeId);
    expect(await idsFor({ queryText: 'museum', limit: 50 })).toStrictEqual(expected);
  });
});

describe('AC-8 Fewer Matching Places than the limit', () => {
  it('Result Limit 50 returns exactly the 6 Searchable Places, none repeated, no placeholder', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', limit: 50 })).toStrictEqual(SEARCHABLE_RANKING);
  });
});

describe('AC-9 Ties', () => {
  it('equal Similarity Scores are ordered by ascending Place ID, whatever the save order', async () => {
    const tie = { centre: POINT_S, tags: ['museum'] as const, similarity: 0.8, axis: 5 };
    await seedPlaces(store, embeddings, [
      { placeId: 202, name: 'Tie B', ...tie },
      { placeId: 201, name: 'Tie A', ...tie },
      { placeId: 203, name: 'Better', centre: POINT_S, similarity: 0.85 },
    ]);
    const results = await resultsFor({ queryText: 'museum' });
    expect(results.map((r) => r.placeId)).toStrictEqual([203, 201, 202]);
    expect(results[1]?.similarity).toBe(results[2]?.similarity);
  });
});

describe('AC-10 Complete answer in Exact mode', () => {
  it('1 Matching Place among 1,001 Searchable Places is found by radius, area and tag, explicit or default Exact', async () => {
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
    await seedPlaces(store, embeddings, [needle, ...haystack]);
    const selective: SearchRequest[] = [
      S_RADIUS(500),
      { queryText: 'museum', area: AREA_B },
      { queryText: 'museum', tags: ['needle tag'] },
    ];
    for (const request of selective) {
      for (const mode of [undefined, 'exact'] as const) {
        const ids = await idsFor(mode === undefined ? request : { ...request, mode });
        expect(ids).toStrictEqual([2999]);
      }
    }
    const top = await idsFor({ queryText: 'museum', tags: ['hotel'], limit: 50 });
    expect(top).toStrictEqual(
      [...haystack]
        .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
        .slice(0, 50)
        .map((p) => p.placeId),
    );
  }, 300_000);
});

describe('AC-11 Older Embedding still searchable', () => {
  it('a Place that is Embedding Due is searched with its existing Embedding', async () => {
    await seedSearchSet(store, embeddings);
    const read = okValue(ReadPlaceResultSchema.parse(await store.readPlace({ placeId: 101 })));
    const record = okValue(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId: 101 })),
    );
    if (!read.found || read.place.status !== 'detailed' || !record.found) {
      throw new Error('place 101 is not set up');
    }
    expect(isEmbeddingDue(buildPlaceDocument(read.place), record.record)).toBe(true);
    const results = await resultsFor({ queryText: 'museum' });
    expectSimilarity(resultFor(results, 101).similarity, 0.9);
  });
});

describe('AC-12 No result is not a failure', () => {
  it('an empty Place Store gives an empty list', async () => {
    expect(await idsFor({ queryText: 'museum' })).toStrictEqual([]);
  });
});

// ===========================================================================
// 3.2 Radius Filter (US-2)
// ===========================================================================

describe('AC-13 Radius happy path', () => {
  it('Point S, 500 m: 102, 101, 108, 109, 104 with their Distances; 103 (800 m) is left out', async () => {
    await seedSearchSet(store, embeddings);
    const results = await resultsFor(S_RADIUS(500));
    expect(results.map((r) => r.placeId)).toStrictEqual([102, 101, 108, 109, 104]);
    for (const r of results) {
      const stated = searchSetPlace(r.placeId).statedDistance;
      expect(Math.abs((r.distanceMetres ?? Number.NaN) - stated)).toBeLessThan(1);
    }
  });
});

describe('AC-14 Distance value', () => {
  it.each(BOTH_MODES)(
    '%s mode: every Distance is within 1 m of the WGS 84 distance; 0 at the Search Centre',
    async (mode) => {
      await seedSearchSet(store, embeddings);
      const results = await resultsFor({ ...S_RADIUS(1000), mode });
      for (const r of results) {
        const truth = wgs84DistanceMetres(POINT_S, r.centre);
        expect(Math.abs((r.distanceMetres ?? Number.NaN) - truth)).toBeLessThanOrEqual(
          DISTANCE_TOLERANCE_METRES,
        );
      }
      const centre = results.find((r) => r.placeId === 101);
      if (mode === 'exact' || centre !== undefined) expect(centre?.distanceMetres).toBe(0);
    },
  );
});

describe('AC-15 Never outside the circle', () => {
  it.each(BOTH_MODES)(
    '%s mode: every result lies within the Radius though 103 has a higher score and the limit is not reached',
    async (mode) => {
      await seedSearchSet(store, embeddings);
      const request: SearchRequest = { ...S_RADIUS(500), limit: MAX_RESULT_LIMIT, mode };
      const results = await resultsFor(request);
      expectMatchingResults(request, results);
      expect(results.map((r) => r.placeId)).not.toContain(103);
    },
  );
});

describe('AC-16 Boundary included', () => {
  it('a Radius equal to the Distance Place Search itself reports for 102 still returns 102', async () => {
    await seedSearchSet(store, embeddings);
    const measured = resultFor(await resultsFor(S_RADIUS(1000)), 102).distanceMetres;
    if (measured === undefined) throw new Error('no Distance reported');
    const ids = await idsFor(S_RADIUS(measured));
    expect(ids).toContain(102);
    expect(ids).not.toContain(104);
  });
});

describe('AC-17 Small circle', () => {
  it('50 m around Point S returns only 101', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor(S_RADIUS(50))).toStrictEqual([101]);
  });
});

describe('AC-18 Wider circle', () => {
  it('1000 m around Point S returns all six Searchable Places in Ranking Order', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor(S_RADIUS(1000))).toStrictEqual(SEARCHABLE_RANKING);
  });
});

describe('AC-19 Empty circle', () => {
  it('500 m around 45, 21 gives an empty list, not a failure', async () => {
    await seedSearchSet(store, embeddings);
    expect(
      await idsFor({ queryText: 'museum', centre: { lat: 45, lon: 21 }, radiusMetres: 500 }),
    ).toStrictEqual([]);
  });
});

describe('AC-20 Circle uses the Centre Point only', () => {
  it('a Place 600 m away whose Outline Shape reaches within 100 m is not returned for 500 m', async () => {
    const far: SyntheticSearchPlace = {
      placeId: 111,
      name: 'Long Embankment',
      centre: { lat: 44.8224, lon: 20.457 },
      outlineBox: { south: 44.8178, north: 44.823, west: 20.4565, east: 20.4575 },
      tags: ['park'],
      similarity: 0.98,
    };
    expect(wgs84DistanceMetres(POINT_S, far.centre)).toBeGreaterThan(590);
    expect(wgs84DistanceMetres(POINT_S, { lat: 44.8178, lon: 20.457 })).toBeLessThan(100);
    await seedPlaces(store, embeddings, [...SEARCH_SET, far]);
    expect(await idsFor(S_RADIUS(500))).toStrictEqual([102, 101, 108, 109, 104]);
  });
});

describe('AC-21 Distance only with a Radius Filter', () => {
  it.each([
    ['no Spatial Filter', { queryText: 'museum' }],
    ['an Area Filter', { queryText: 'museum', area: AREA_B }],
  ] as [string, SearchRequest][])('%s: no result carries a Distance', async (_, request) => {
    await seedSearchSet(store, embeddings);
    const results = await resultsFor(request);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r).not.toHaveProperty('distanceMetres');
  });
});

// ===========================================================================
// 3.3 Area Filter (US-2)
// ===========================================================================

describe('AC-22 Area happy path', () => {
  it('Area B returns 102, 101, 108, 109 (109 by its Outline Shape); 103 and 104 are left out', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', area: AREA_B })).toStrictEqual([102, 101, 108, 109]);
  });
});

describe('AC-23 Never outside the box', () => {
  it.each(BOTH_MODES)(
    '%s mode: every result Lies In the Area though 103 has a higher score and the limit is not reached',
    async (mode) => {
      await seedSearchSet(store, embeddings);
      const request: SearchRequest = {
        queryText: 'museum',
        area: AREA_B,
        limit: MAX_RESULT_LIMIT,
        mode,
      };
      const results = await resultsFor(request);
      expectMatchingResults(request, results);
      expect(results.map((r) => r.placeId)).not.toContain(103);
      expect(results.map((r) => r.placeId)).not.toContain(104);
    },
  );
});

describe('AC-24 Edge included', () => {
  it.each([
    [
      'a Centre Point exactly on the north edge, no Outline Shape',
      { placeId: 112, name: 'Edge Kiosk', centre: { lat: AREA_B.north, lon: 20.457 } },
    ],
    [
      'an Outline Shape touching the east edge, Centre Point outside',
      {
        placeId: 113,
        name: 'Edge Garden',
        centre: { lat: 44.8175, lon: 20.4585 },
        outlineBox: { south: 44.817, north: 44.818, west: AREA_B.east, east: 20.459 },
      },
    ],
  ] as [string, SyntheticSearchPlace][])('%s: returned', async (_, place) => {
    await seedPlaces(store, embeddings, [{ ...place, tags: ['park'], similarity: 0.4 }]);
    expect(await idsFor({ queryText: 'museum', area: AREA_B })).toStrictEqual([place.placeId]);
  });
});

describe('AC-25 Outline entirely outside', () => {
  it('a Place whose Outline Shape and Centre Point are both outside the box is not returned', async () => {
    const outside: SyntheticSearchPlace = {
      placeId: 114,
      name: 'North Yard',
      centre: { lat: 44.8215, lon: 20.457 },
      outlineBox: { south: 44.821, north: 44.822, west: 20.456, east: 20.458 },
      tags: ['park'],
      similarity: 0.98,
    };
    await seedPlaces(store, embeddings, [...SEARCH_SET, outside]);
    expect(await idsFor({ queryText: 'museum', area: AREA_B })).toStrictEqual([102, 101, 108, 109]);
  });
});

describe('AC-26 Empty box', () => {
  it('a box far from Belgrade gives an empty list, not a failure', async () => {
    await seedSearchSet(store, embeddings);
    const area: AreaFilter = { south: 10.0, north: 10.1, west: 10.0, east: 10.1 };
    expect(await idsFor({ queryText: 'museum', area })).toStrictEqual([]);
  });
});

// ===========================================================================
// 3.4 Tag Filter (US-3)
// ===========================================================================

describe('AC-27 One Tag', () => {
  it('["museum"] returns 102, 101; 108 (museum Gone) is left out', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: ['museum'] })).toStrictEqual([102, 101]);
  });
});

describe('AC-28 Any of several Tags', () => {
  it('["museum", "hotel"] returns 103, 102, 101', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: ['museum', 'hotel'] })).toStrictEqual([
      103, 102, 101,
    ]);
  });
});

describe('AC-29 Tag and circle together', () => {
  it('["museum", "hotel"] within 500 m of Point S returns 102, 101', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ ...S_RADIUS(500), tags: ['museum', 'hotel'] })).toStrictEqual([102, 101]);
  });
});

describe('AC-30 Tag and box together', () => {
  it('["park"] in Area B returns only 109', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: ['park'], area: AREA_B })).toStrictEqual([
      109,
    ]);
  });
});

describe('AC-31 Case and spacing ignored', () => {
  it.each([[' Museum '], ['MUSEUM']])('[%j] gives the results of AC-27', async (title) => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: [title] })).toStrictEqual([102, 101]);
  });
});

describe('AC-32 Whole titles only', () => {
  it.each([['muse'], ['gallery']])('[%j] matches nothing', async (title) => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: [title] })).toStrictEqual([]);
  });
});

describe('AC-33 Unknown Tag', () => {
  it('["volcano"] gives an empty list, not a failure', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: ['volcano'] })).toStrictEqual([]);
  });
});

describe('AC-34 Repeated Tag titles', () => {
  it('["museum", "museum"] gives the results of AC-27, none twice', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor({ queryText: 'museum', tags: ['museum', 'museum'] })).toStrictEqual([
      102, 101,
    ]);
  });
});

// ===========================================================================
// 3.5 Search Results (US-4, US-10)
// ===========================================================================

describe('AC-35 Result content', () => {
  it('the Search Result for 102 in the search of AC-13 carries exactly the stated items', async () => {
    await seedSearchSet(store, embeddings);
    const r = resultFor(await resultsFor(S_RADIUS(500)), 102);
    expect(Object.keys(r).sort()).toStrictEqual(
      ['centre', 'distanceMetres', 'name', 'placeId', 'similarity', 'tags', 'wikimapiaUrl'].sort(),
    );
    expect(r.placeId).toBe(102);
    expect(r.name).toBe('Art Gallery');
    expect(r.wikimapiaUrl).toBe('http://wikimapia.org/102');
    expect(r.tags).toStrictEqual(['museum', 'art gallery']);
    expect(r.centre).toStrictEqual({ lat: 44.8197, lon: 20.457 });
    expect(Math.abs((r.distanceMetres ?? Number.NaN) - 300)).toBeLessThan(1);
    expectSimilarity(r.similarity, 0.95);
  });
});

describe('AC-36 Gone Tags not listed', () => {
  it('108 lists only "monument"', async () => {
    await seedSearchSet(store, embeddings);
    expect(resultFor(await resultsFor(S_RADIUS(500)), 108).tags).toStrictEqual(['monument']);
  });
});

describe('AC-37 Place without Tags', () => {
  it('a Searchable Place with no Present Tags has an empty Result Tag Titles list', async () => {
    await seedPlaces(store, embeddings, [
      { placeId: 115, name: 'Untagged', centre: POINT_S, tags: [], similarity: 0.3 },
    ]);
    expect(resultFor(await resultsFor({ queryText: 'museum' }), 115).tags).toStrictEqual([]);
  });
});

describe('AC-38 Listing Link when stored', () => {
  it('a Place saved from the recorded listing and details returns its Listing Link exactly', async () => {
    const listing = SaveResultSchema.parse(
      await store.saveListingPage(await clientListing('box-belgrade-page1.json')),
    );
    expect(listing.ok).toBe(true);
    const details = await clientDetails('getbyid-1381893.json');
    const saved = SaveResultSchema.parse(
      await store.savePlaceDetails({ details, fetchedAt: '2026-10-21T10:00:00Z' }),
    );
    expect(saved.ok).toBe(true);
    const centre = { lat: details.location.lat, lon: details.location.lon };
    await saveRecords(embeddings, [
      recordOf({ placeId: 1381893, name: details.title, centre, similarity: 0.4 }, 0),
    ]);
    const r = resultFor(await resultsFor({ queryText: 'park' }), 1381893);
    expect(r.wikimapiaUrl).toBe('http://wikimapia.org/1381893/University-Park');
  });
});

describe('AC-39 Read only', () => {
  const embedFailure: QueryServiceAnswer = { error: refusedError() };
  it.each([
    ['exact, successful', { ...S_RADIUS(500), tags: ['museum'] }, undefined],
    [
      'approximate, successful',
      { ...S_RADIUS(500), tags: ['museum'], mode: 'approximate' },
      undefined,
    ],
    ['exact, Query Embedding Failure', S_RADIUS(500), embedFailure],
    ['approximate, Invalid Search Request', { queryText: '', mode: 'approximate' }, undefined],
  ] as [string, SearchRequest, QueryServiceAnswer | undefined][])(
    '%s: every stored item is exactly as before',
    async (_, request, answer) => {
      await seedSearchSet(store, embeddings);
      const before = await snapshot(SEARCH_SET_IDS);
      await search(request, answer === undefined ? {} : { answer });
      expect(await snapshot(SEARCH_SET_IDS)).toStrictEqual(before);
    },
  );
});

describe('AC-40 Text with special characters', () => {
  it('the text is sent exactly, the outcome is a list, the Place Store is unchanged', async () => {
    await seedSearchSet(store, embeddings);
    const before = await snapshot(SEARCH_SET_IDS);
    const queryText = `museum'; drop "places" -- 100%`;
    const { outcome, service } = await search({ queryText, tags: [`museum'; --`] });
    expect(resultsOf(outcome)).toStrictEqual([]);
    expect(service.texts).toStrictEqual([queryText]);
    const again = await search({ queryText });
    expect(resultsOf(again.outcome).map((r) => r.placeId)).toStrictEqual(SEARCHABLE_RANKING);
    expect(await snapshot(SEARCH_SET_IDS)).toStrictEqual(before);
  });
});

// ===========================================================================
// 3.6 Search Command (US-7)
// ===========================================================================

const NEAR_S = [SEARCH_COMMAND_OPTIONS.near, '44.817,20.457'];

describe('AC-41 Command form', () => {
  it('package.json has a `search` script run through tsx', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    expect(scripts[SEARCH_SCRIPT.name]).toMatch(new RegExp(`^${SEARCH_SCRIPT.runner}\\s`));
  });

  it('`museum --near 44.817,20.457 --radius 500`: Exact, latitude first, Radius 500, default limit', async () => {
    await seedSearchSet(store, embeddings);
    const { result, service } = await runCommand([
      'museum',
      ...NEAR_S,
      SEARCH_COMMAND_OPTIONS.radius,
      '500',
    ]);
    const request = result.request;
    expect(request?.queryText).toBe('museum');
    expect(request?.centre).toStrictEqual({ lat: 44.817, lon: 20.457 });
    expect(request?.radiusMetres).toBe(500);
    expect(request?.limit ?? 20).toBe(20);
    expect(request?.mode ?? 'exact').toBe('exact');
    expect(request?.area).toBeUndefined();
    expect(request?.tags).toBeUndefined();
    expect(service.texts).toStrictEqual(['museum']);
    expect(commandResults(result).map((r) => r.placeId)).toStrictEqual([102, 101, 108, 109, 104]);
  });

  it.each([
    [
      '--bbox 44.816,20.456,44.82,20.458',
      [SEARCH_COMMAND_OPTIONS.bbox, '44.816,20.456,44.82,20.458'],
      { area: AREA_B },
    ],
    [
      '--tag museum --tag hotel',
      [SEARCH_COMMAND_OPTIONS.tag, 'museum', SEARCH_COMMAND_OPTIONS.tag, 'hotel'],
      { tags: ['museum', 'hotel'] },
    ],
    ['--limit 3', [SEARCH_COMMAND_OPTIONS.limit, '3'], { limit: 3 }],
  ] as [string, string[], Partial<SearchRequest>][])(
    '%s sets the request',
    async (_, options, expected) => {
      await seedSearchSet(store, embeddings);
      const { result } = await runCommand(['museum', ...options]);
      expect(result.request).toMatchObject(expected);
      expect(result.exitCode).toBe(0);
    },
  );
});

describe('AC-42 Command output', () => {
  it('mode line, one block per result in Ranking Order, count, attribution', async () => {
    await seedSearchSet(store, embeddings);
    const { result, output } = await runCommand([
      'museum',
      ...NEAR_S,
      SEARCH_COMMAND_OPTIONS.radius,
      '500',
    ]);
    const results = commandResults(result);
    expect(output).toStrictEqual([
      MODE_LINES.exact,
      ...results.flatMap((r, i) => searchResultBlock(i + 1, r)),
      resultCountLine(results.length),
      ATTRIBUTION_LINE,
    ]);
    expect(output.some((line) => line.includes('Distance: 300 m'))).toBe(true);
  });

  it('an empty result prints the mode line, "No places found." and the attribution line', async () => {
    await seedSearchSet(store, embeddings);
    const { output } = await runCommand(['museum', SEARCH_COMMAND_OPTIONS.tag, 'volcano']);
    expect(output).toStrictEqual([MODE_LINES.exact, NO_RESULTS_LINE, ATTRIBUTION_LINE]);
  });
});

describe('AC-43 Command exit status', () => {
  interface ExitCase {
    argv: string[];
    withoutKey?: boolean;
    answer?: QueryServiceAnswer;
    exitCode: 0 | 1;
    named?: string;
  }
  it.each([
    ['results', { argv: ['museum'], exitCode: 0 }],
    ['an empty list', { argv: ['museum', SEARCH_COMMAND_OPTIONS.tag, 'volcano'], exitCode: 0 }],
    [
      'an Invalid Search Request',
      {
        argv: ['museum', ...NEAR_S, SEARCH_COMMAND_OPTIONS.radius, '0'],
        exitCode: 1,
        named: SEARCH_COMMAND_OPTIONS.radius,
      },
    ],
    ['Missing Key', { argv: ['museum'], withoutKey: true, exitCode: 1, named: VOYAGE_API_KEY_ENV }],
    [
      'a Query Embedding Failure',
      { argv: ['museum'], answer: { error: rateLimitError() }, exitCode: 1 },
    ],
  ] as [string, ExitCase][])(
    '%s: the stated exit code; a failure names its kind',
    async (_, { argv, withoutKey, answer, exitCode, named }) => {
      await seedSearchSet(store, embeddings);
      const { result, output } = await runCommand(argv, {
        ...(withoutKey === true ? { env: { [DATABASE_URL_ENV]: testUrl } } : {}),
        ...(answer === undefined ? {} : { answer }),
      });
      expect(result.exitCode).toBe(exitCode);
      if (exitCode === 1) {
        const failure = failureOf(result.outcome ?? { ok: true, results: [] });
        const text = output.join('\n');
        expect(text).toContain(SEARCH_FAILURE_LABELS[failure.kind]);
        if (named !== undefined) expect(text).toContain(named);
      }
    },
  );

  it('Store Unavailable: exit code 1 naming the failure kind', async () => {
    const { result, output } = await runCommand(['museum'], {
      env: {
        [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY,
        [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(output.join('\n')).toContain(SEARCH_FAILURE_LABELS.store_unavailable);
  }, 60_000);
});

describe('AC-44 Command options checked', () => {
  const { near, radius, bbox, limit, approximate } = SEARCH_COMMAND_OPTIONS;
  it.each([
    ['no Query Text', [near, '44.817,20.457', radius, '500']],
    ['an unknown option', ['museum', '--fast']],
    ['--radius without --near', ['museum', radius, '500']],
    ['--near without --radius', ['museum', near, '44.817,20.457']],
    [
      'both --near and --bbox',
      ['museum', near, '44.817,20.457', radius, '500', bbox, '44.816,20.456,44.82,20.458'],
    ],
    ['a value that is not a number', ['museum', limit, 'ten']],
    ['a coordinate that is not a number', ['museum', near, 'abc,20.457', radius, '500']],
    ['a value given to --approximate', ['museum', `${approximate}=yes`]],
  ])('%s: failure with a usage message, no Embedding Service call', async (_, argv) => {
    const { result, output, service } = await runCommand(argv);
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBeUndefined();
    expect(output.some(isSearchUsageLine)).toBe(true);
    expect(service.calls).toHaveLength(0);
  });
});

describe('AC-45 Settings read from the environment', () => {
  it('VOYAGE_API_KEY and DATABASE_URL come from the environment given to the command', async () => {
    await seedSearchSet(store, embeddings);
    const noKey = await runCommand(['museum'], { env: { [DATABASE_URL_ENV]: testUrl } });
    expect(failureOf(noKey.result.outcome ?? { ok: true, results: [] }).kind).toBe('missing_key');
    const withBoth = await runCommand(['museum']);
    expect(commandResults(withBoth.result).map((r) => r.placeId)).toStrictEqual(SEARCHABLE_RANKING);
  });
});

describe('AC-71 Approximate flag', () => {
  const argv = ['museum', ...NEAR_S, SEARCH_COMMAND_OPTIONS.radius, '500'];
  it.each([
    ['--approximate', [SEARCH_COMMAND_OPTIONS.approximate]],
    [
      '--approximate twice',
      [SEARCH_COMMAND_OPTIONS.approximate, SEARCH_COMMAND_OPTIONS.approximate],
    ],
  ])(
    '%s: Approximate mode, same other parameters, output starts with `Mode: approximate`',
    async (_, flags) => {
      await seedSearchSet(store, embeddings);
      const { result, output } = await runCommand([...argv, ...flags]);
      expect(result.request?.mode).toBe('approximate');
      expect(result.request?.centre).toStrictEqual({ lat: 44.817, lon: 20.457 });
      expect(result.request?.radiusMetres).toBe(500);
      expect(output[0]).toBe(MODE_LINES.approximate);
      expect(result.exitCode).toBe(0);
      if (result.request !== undefined) {
        expectMatchingResults({ ...S_RADIUS(500), mode: 'approximate' }, commandResults(result));
      }
    },
  );

  it('without the flag: Exact mode and `Mode: exact`', async () => {
    await seedSearchSet(store, embeddings);
    const { result, output } = await runCommand(argv);
    expect(result.request?.mode ?? 'exact').toBe('exact');
    expect(output[0]).toBe(MODE_LINES.exact);
  });
});

// ===========================================================================
// 3.7 Invalid Search Requests (US-6): refused before the Embedding Service and the Place
// Store. The Place Store given is unreachable, so consulting it would show as Store Unavailable.
// ===========================================================================

async function expectRefused(request: unknown, parameter: string): Promise<void> {
  const { outcome, service } = await searchUnchecked(request, {
    connectionString: UNREACHABLE_DATABASE_URL,
  });
  const failure = failureOf(outcome);
  expect(failure).toMatchObject({ kind: 'invalid_request', parameter });
  expect(service.calls).toHaveLength(0);
}

const Q = 'museum';
const CENTRE = { lat: 44.817, lon: 20.457 };

describe('AC-46 Query Text missing or empty', () => {
  it.each([
    ['missing', {}],
    ['empty', { queryText: '' }],
    ['only spacing, approximate', { queryText: ' \t\n ', mode: 'approximate' }],
  ])('%s: refused naming queryText', async (_, request) => {
    await expectRefused(request, 'queryText');
  });
});

describe('AC-47 Query Text too long', () => {
  it('1,001 characters after trimming: refused naming queryText', async () => {
    await expectRefused({ queryText: `  ${'ж'.repeat(MAX_QUERY_TEXT_LENGTH + 1)}  ` }, 'queryText');
  });

  it('exactly 1,000 characters after trimming: accepted and sent trimmed', async () => {
    await seedSearchSet(store, embeddings);
    const text = 'ж'.repeat(MAX_QUERY_TEXT_LENGTH);
    const { outcome, service } = await search({ queryText: `  ${text}  ` });
    expect(outcome.ok).toBe(true);
    expect(service.texts).toStrictEqual([text]);
  });
});

describe('AC-48 Both Spatial Filters', () => {
  it.each(BOTH_MODES)(
    '%s mode: a Radius Filter and an Area Filter together are refused naming spatialFilter',
    async (mode) => {
      await expectRefused(
        { queryText: Q, centre: CENTRE, radiusMetres: 500, area: AREA_B, mode },
        'spatialFilter',
      );
    },
  );
});

describe('AC-49 Incomplete Radius Filter', () => {
  it.each([
    ['a Search Centre without a Radius', { queryText: Q, centre: CENTRE }, 'radiusMetres'],
    ['a Radius without a Search Centre', { queryText: Q, radiusMetres: 500 }, 'centre'],
  ])('%s: refused naming the missing part', async (_, request, parameter) => {
    await expectRefused(request, parameter);
  });
});

describe('AC-50 Bad Search Centre', () => {
  it.each([
    ['latitude 91', { lat: 91, lon: 20.457 }],
    ['longitude 181', { lat: 44.817, lon: 181 }],
    ['latitude NaN', { lat: Number.NaN, lon: 20.457 }],
    ['longitude Infinity', { lat: 44.817, lon: Number.POSITIVE_INFINITY }],
  ])('%s: refused naming centre', async (_, centre) => {
    await expectRefused({ queryText: Q, centre, radiusMetres: 500 }, 'centre');
  });
});

describe('AC-51 Bad Radius', () => {
  it.each([[0], [-5], [MAX_RADIUS_METRES + 1], [Number.NaN]])(
    'Radius %s: refused naming radiusMetres',
    async (radiusMetres) => {
      await expectRefused({ queryText: Q, centre: CENTRE, radiusMetres }, 'radiusMetres');
    },
  );

  it('a Radius of exactly 50,000 metres is accepted', async () => {
    await seedSearchSet(store, embeddings);
    expect(await idsFor(S_RADIUS(MAX_RADIUS_METRES))).toStrictEqual(SEARCHABLE_RANKING);
  });
});

describe('AC-52 Bad Area Filter', () => {
  it.each([
    ['south not below north', { ...AREA_B, south: AREA_B.north }],
    ['west not below east', { ...AREA_B, west: 20.459 }],
    ['a latitude outside -90..90', { ...AREA_B, north: 90.5 }],
    ['a longitude outside -180..180', { ...AREA_B, west: -180.5 }],
    ['a missing edge', { south: AREA_B.south, west: AREA_B.west, north: AREA_B.north }],
    ['a value that is not a finite number', { ...AREA_B, east: Number.NaN }],
  ])('%s: refused naming area', async (_, area) => {
    await expectRefused({ queryText: Q, area }, 'area');
  });
});

describe('AC-53 Bad Tag Filter', () => {
  it.each([
    ['an empty list', []],
    ['an empty title', ['museum', '']],
    ['a title of only spacing', ['  ']],
  ])('%s: refused naming tags', async (_, tags) => {
    await expectRefused({ queryText: Q, tags }, 'tags');
  });
});

describe('AC-54 Bad Result Limit', () => {
  it.each([[0], [-1], [2.5], [MAX_RESULT_LIMIT + 1]])(
    'Result Limit %s: refused naming limit',
    async (limit) => {
      await expectRefused({ queryText: Q, limit }, 'limit');
    },
  );
});

describe('AC-55 Unknown parameter', () => {
  it.each([
    ['radius', { queryText: Q, centre: CENTRE, radius: 500 }],
    ['sort', { queryText: Q, sort: 'name' }],
  ])('a parameter %j is refused naming it', async (parameter, request) => {
    await expectRefused(request, parameter);
  });
});

describe('AC-70 Bad Search Mode', () => {
  it.each([['fast'], [''], ['EXACT']])('Search Mode %j: refused naming mode', async (mode) => {
    await expectRefused({ queryText: Q, mode }, 'mode');
  });
});

// ===========================================================================
// 3.8 Failures (US-6)
// ===========================================================================

describe('AC-56 Missing key', () => {
  it.each([
    ['not set', null],
    ['empty', ''],
  ] as const)(
    'VOYAGE_API_KEY %s: Missing Key, no Embedding Service call, store not consulted',
    async (_, apiKey) => {
      const { outcome, service } = await search(S_RADIUS(500), {
        apiKey,
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      const failure = failureOf(outcome);
      expect(failure.kind).toBe('missing_key');
      expect(failure.message).toContain(VOYAGE_API_KEY_ENV);
      expect(service.calls).toHaveLength(0);
    },
  );
});

describe('AC-57 Query Embedding Failure', () => {
  const Q_VECTOR = queryEmbeddingQ();
  const nonFinite = [...Q_VECTOR];
  nonFinite[3] = Number.NaN;
  it.each([
    ['a Connection Failure (no answer)', { error: connectionError() }, 'connection'],
    ['a Connection Failure (503)', { error: unavailableError() }, 'connection'],
    ['a Service Rate Limit', { error: rateLimitError() }, 'rate_limit'],
    ['Service Refused', { error: refusedError() }, 'refused'],
    ['no Embedding', { raw: queryAnswer([]) }, 'invalid_answer'],
    ['two Embeddings', { raw: queryAnswer([Q_VECTOR, Q_VECTOR]) }, 'invalid_answer'],
    ['1023 numbers', { raw: queryAnswer([fakeVector(1023)]) }, 'invalid_answer'],
    ['1025 numbers', { raw: queryAnswer([fakeVector(1025)]) }, 'invalid_answer'],
    ['a value that is not a finite number', { raw: queryAnswer([nonFinite]) }, 'invalid_answer'],
    ['an answer that cannot be read', { raw: '<html>502 Bad Gateway</html>' }, 'invalid_answer'],
  ] as [string, QueryServiceAnswer, EmbeddingFailureKind][])(
    '%s: Query Embedding Failure of that kind, asked once, store not consulted',
    async (_, answer, kind) => {
      const { outcome, service } = await search(S_RADIUS(500), {
        answer,
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expect(failureOf(outcome)).toMatchObject({
        kind: 'query_embedding_failed',
        embeddingFailure: kind,
      });
      expect(service.calls).toHaveLength(1);
    },
  );
});

describe('AC-58 Wrong model in the answer', () => {
  it('an Embedding said to come from another model is an Invalid Embedding Answer', async () => {
    await seedSearchSet(store, embeddings);
    const { outcome } = await search(S_RADIUS(500), {
      answer: { raw: queryAnswer([queryEmbeddingQ()], 'voyage-3.5') },
    });
    expect(failureOf(outcome)).toMatchObject({
      kind: 'query_embedding_failed',
      embeddingFailure: 'invalid_answer',
    });
  });
});

describe('AC-59 Place Store unavailable', () => {
  it('an unreachable Place Store gives Store Unavailable and no results', async () => {
    const { outcome } = await search(S_RADIUS(500), { connectionString: UNREACHABLE_DATABASE_URL });
    expect(failureOf(outcome).kind).toBe('store_unavailable');
  }, 60_000);
});

describe('AC-60 No secrets in failures', () => {
  it('no Search Failure or command output shows a key, password or connection string', async () => {
    const texts: string[] = [];
    for (const s of [
      { answer: { error: refusedError() } },
      { answer: { error: connectionError() } },
      { connectionString: UNREACHABLE_DATABASE_URL },
      { apiKey: null },
    ] as SearchSetup[]) {
      texts.push(JSON.stringify((await search(S_RADIUS(500), s)).outcome));
    }
    const viaCommand = await runCommand(['museum'], { answer: { error: refusedError() } });
    texts.push(JSON.stringify(viaCommand.result.outcome), ...viaCommand.output);
    const unreachable = await runCommand(['museum'], {
      env: {
        [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY,
        [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL,
      },
    });
    texts.push(...unreachable.output);
    for (const text of texts) expectNoSecrets(text);
  }, 120_000);
});

// ===========================================================================
// 3.9 Tests (US-9)
// ===========================================================================

describe('AC-61 No live calls', () => {
  it('no test of this file attempted a global fetch (Voyage, Anthropic, Wikimapia or other)', () => {
    expect(fetchCalls).toStrictEqual([]);
  });
});

describe('AC-62 Synthetic data, Test Database only', () => {
  it('the tests use a database named *_test, never DATABASE_URL', () => {
    expect(() => requireTestDatabaseUrl()).not.toThrow();
    const dev = process.env.DATABASE_URL;
    if (dev !== undefined && dev !== '') expect(testUrl).not.toBe(dev);
  });

  it('the recorded fixtures folder holds exactly the known fixtures and its README', () => {
    const names = readdirSync(new URL('./fixtures/wikimapia/', import.meta.url)).sort();
    expect(names).toStrictEqual([...FIXTURE_NAMES, 'README.md'].sort());
  });
});

// ===========================================================================
// 3.10 Search Mode (US-11)
// ===========================================================================

const MODE_REQUESTS: [string, SearchRequest, number[]][] = [
  ['AC-1 (no filters)', { queryText: 'museum' }, [...SEARCHABLE_RANKING]],
  ['AC-13 (Radius 500)', S_RADIUS(500), [102, 101, 108, 109, 104]],
  ['AC-22 (Area B)', { queryText: 'museum', area: AREA_B }, [102, 101, 108, 109]],
  ['AC-29 (Tags and Radius)', { ...S_RADIUS(500), tags: ['museum', 'hotel'] }, [102, 101]],
];

describe('AC-63 Exact is the default', () => {
  it.each(MODE_REQUESTS)(
    '%s: no Search Mode gives exactly the results of explicit Exact',
    async (_, request) => {
      await seedSearchSet(store, embeddings);
      expect(await resultsFor(request)).toStrictEqual(
        await resultsFor({ ...request, mode: 'exact' }),
      );
    },
  );
});

describe('AC-64 Exact mode given explicitly', () => {
  it.each(MODE_REQUESTS)(
    '%s with mode exact returns the stated results in order',
    async (_, request, expected) => {
      await seedSearchSet(store, embeddings);
      expect(await idsFor({ ...request, mode: 'exact' })).toStrictEqual(expected);
    },
  );
});

describe('AC-65 Approximate stays inside the filters', () => {
  it.each(MODE_REQUESTS)(
    '%s in Approximate mode: every result is a Matching Place',
    async (_, request, expected) => {
      await seedSearchSet(store, embeddings);
      const results = await resultsFor({ ...request, mode: 'approximate' });
      expectMatchingResults(request, results);
      for (const r of results) expect(expected).toContain(r.placeId);
    },
  );
});

describe('AC-66 Approximate keeps the Ranking Order', () => {
  it('results are in Ranking Order with true Similarity Scores (102 before 101 when both appear)', async () => {
    await seedSearchSet(store, embeddings);
    const request: SearchRequest = {
      ...S_RADIUS(500),
      tags: ['museum', 'hotel'],
      mode: 'approximate',
    };
    const results = await resultsFor(request);
    expectMatchingResults(request, results);
    const ids = results.map((r) => r.placeId);
    if (ids.includes(101) && ids.includes(102))
      expect(ids.indexOf(102)).toBeLessThan(ids.indexOf(101));
  });
});

describe('AC-67 Approximate may return fewer', () => {
  it.each([[1], [2], [MAX_RESULT_LIMIT]])(
    'Result Limit %s: at most that many, no Place twice, not a failure',
    async (limit) => {
      await seedSearchSet(store, embeddings);
      const results = await resultsFor({ queryText: 'museum', limit, mode: 'approximate' });
      expect(results.length).toBeLessThanOrEqual(limit);
      expect(new Set(results.map((r) => r.placeId)).size).toBe(results.length);
    },
  );
});

describe('AC-68 Approximate result content', () => {
  it('each Approximate result equals the Exact result for the same Place and request', async () => {
    await seedSearchSet(store, embeddings);
    const request: SearchRequest = { ...S_RADIUS(1000), limit: MAX_RESULT_LIMIT };
    const exact = await resultsFor({ ...request, mode: 'exact' });
    const approximate = await resultsFor({ ...request, mode: 'approximate' });
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
  });
});

describe('AC-69 Approximate otherwise behaves like Exact', () => {
  it.each([
    ['an empty circle', { queryText: 'museum', centre: { lat: 45, lon: 21 }, radiusMetres: 500 }],
    [
      'an empty box',
      { queryText: 'museum', area: { south: 10, north: 10.1, west: 10, east: 10.1 } },
    ],
    ['an unknown Tag', { queryText: 'museum', tags: ['volcano'] }],
  ] as [string, SearchRequest][])(
    '%s: an empty list, the Query Text embedded once',
    async (_, request) => {
      await seedSearchSet(store, embeddings);
      const { outcome, service } = await search({ ...request, mode: 'approximate' });
      expect(resultsOf(outcome)).toStrictEqual([]);
      expect(service.texts).toStrictEqual(['museum']);
    },
  );

  it('an empty Place Store gives an empty list', async () => {
    expect(await idsFor({ queryText: 'museum', mode: 'approximate' })).toStrictEqual([]);
  });

  it.each([
    ['Missing Key', { apiKey: null, connectionString: UNREACHABLE_DATABASE_URL }, 'missing_key', 0],
    [
      'Query Embedding Failure',
      { answer: { error: rateLimitError() }, connectionString: UNREACHABLE_DATABASE_URL },
      'query_embedding_failed',
      1,
    ],
    ['Store Unavailable', { connectionString: UNREACHABLE_DATABASE_URL }, 'store_unavailable', 1],
  ] as [string, SearchSetup, SearchFailure['kind'], number][])(
    '%s is reported as in Exact mode',
    async (_, s, kind, calls) => {
      const { outcome, service } = await search({ ...S_RADIUS(500), mode: 'approximate' }, s);
      expect(failureOf(outcome).kind).toBe(kind);
      expect(service.calls).toHaveLength(calls);
    },
    60_000,
  );
});
