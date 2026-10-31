/**
 * AL5 CONTRACT TESTS: Hybrid Search (custom invariants, pure validators, the Search Set and the
 * Simulated Embedding Service).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261027-hybrid-search-al6.md (the custom rules behind AC-3,
 *           AC-9, AC-14, AC-16, AC-21, AC-31, AC-32, AC-35, AC-42 .. AC-44, AC-46 .. AC-49,
 *           AC-55 .. AC-58, AC-66, AC-67, AC-72; the Search Set, Point S and Area B of
 *           section 3).
 *           Plain Zod rules (types, ranges, enums, strict objects) are exercised through
 *           `searchPlaces` in ./hybrid-search.test.ts, not re-checked here.
 * Enforces: .agrules section 2 (validated Embedding answers, 1024-dim `voyage-4` query
 *           Embeddings, results that link back to their Place), section 4 (deterministic
 *           synthetic vectors, synthetic keys only).
 */
import { findEmbeddingAnswerIssues } from './embeddings.schema';
import {
  ATTRIBUTION_LINE,
  SearchCommandResultSchema,
  SearchFailureSchema,
  SearchOutcomeSchema,
  SearchResultSchema,
  checkSearchRequest,
  findResultListIssues,
  isSearchUsageLine,
  searchResultBlock,
  tagTitlesMatch,
  wgs84DistanceMetres,
  type SearchRequest,
  type SearchResult,
} from './hybrid-search.schema';
import {
  AREA_B,
  POINT_S,
  SEARCH_SET,
  SimulatedQueryEmbeddingService,
  cosineSimilarity,
  embeddingWithSimilarity,
  liesInArea,
  queryAnswer,
  queryEmbeddingQ,
  searchSetPlace,
} from './hybrid-search.support';

function result(change: Partial<SearchResult> = {}): SearchResult {
  return {
    placeId: 102,
    name: 'Art Gallery',
    wikimapiaUrl: 'http://wikimapia.org/102',
    tags: ['museum', 'art gallery'],
    centre: { lat: 44.8197, lon: 20.457 },
    similarity: 0.95,
    ...change,
  };
}

const RADIUS_500: SearchRequest = { queryText: 'museum', centre: POINT_S, radiusMetres: 500 };

describe('Search Request validator: names the offending parameter (AC-46 .. AC-49, AC-53, AC-55)', () => {
  it.each([
    [
      'both Spatial Filters',
      { queryText: 'm', centre: POINT_S, radiusMetres: 5, area: AREA_B },
      'spatialFilter',
    ],
    ['a Search Centre alone', { queryText: 'm', centre: POINT_S }, 'radiusMetres'],
    ['a Radius alone', { queryText: 'm', radiusMetres: 5 }, 'centre'],
    ['an unknown key', { queryText: 'm', sort: 'name' }, 'sort'],
    ['Query Text of only spacing', { queryText: '  \t ' }, 'queryText'],
    ['1,001 code points after trimming', { queryText: ` ${'😀'.repeat(1001)} ` }, 'queryText'],
    ['south equal to north', { queryText: 'm', area: { ...AREA_B, south: AREA_B.north } }, 'area'],
    ['a Tag title of only spacing', { queryText: 'm', tags: ['museum', ' '] }, 'tags'],
    ['not an object', null, 'request'],
  ])('%s -> %s', (_, input, parameter) => {
    const checked = checkSearchRequest(input);
    expect(checked).toMatchObject({ ok: false, failure: { kind: 'invalid_request', parameter } });
  });

  it.each([
    [
      '1,000 code points (2,000 UTF-16 units) with spacing around',
      { queryText: `  ${'😀'.repeat(1000)} ` },
    ],
    ['a Radius Filter', RADIUS_500],
    ['an Area Filter with Tags', { queryText: 'm', area: AREA_B, tags: [' Museum '] }],
  ])('accepts %s unchanged', (_, input) => {
    expect(checkSearchRequest(input)).toStrictEqual({ ok: true, request: input });
  });
});

describe('Tag Title Match (AC-31, AC-32)', () => {
  it.each([
    [' Museum ', 'museum', true],
    ['MUSEUM', 'museum', true],
    ['gallery', 'art gallery', false],
    ['muse', 'museum', false],
  ])('%j against %j: %s', (filter, title, matches) => {
    expect(tagTitlesMatch(filter, title)).toBe(matches);
  });
});

describe('WGS 84 distance reference (AC-14)', () => {
  it("Vincenty's published example: Flinders Peak to Buninyong is 54,972.271 m", () => {
    const flinders = { lat: -(37 + 57 / 60 + 3.7203 / 3600), lon: 144 + 25 / 60 + 29.5244 / 3600 };
    const buninyong = {
      lat: -(37 + 39 / 60 + 10.1561 / 3600),
      lon: 143 + 55 / 60 + 35.3839 / 3600,
    };
    expect(Math.abs(wgs84DistanceMetres(flinders, buninyong) - 54972.271)).toBeLessThan(0.01);
    expect(wgs84DistanceMetres(POINT_S, POINT_S)).toBe(0);
  });

  it('every stated Distance of the Search Set is the rounded WGS 84 distance from Point S', () => {
    for (const place of SEARCH_SET) {
      expect(Math.round(wgs84DistanceMetres(POINT_S, place.centre))).toBe(place.statedDistance);
    }
  });
});

describe('Search Set and Area B as stated (AL6 section 3 preamble)', () => {
  it('Area B holds the Centre Points of 101, 102, 105 .. 108, 110; 109 lies in it by its Outline Shape only', () => {
    const inside = SEARCH_SET.filter((p) =>
      liesInArea({ placeId: p.placeId, name: p.name, centre: p.centre }, AREA_B),
    );
    expect(inside.map((p) => p.placeId)).toStrictEqual([101, 102, 105, 106, 107, 108, 110]);
    expect(liesInArea(searchSetPlace(109), AREA_B)).toBe(true);
  });

  it('synthetic Embeddings have exactly the stated similarity with Q, also as 32-bit floats', () => {
    const q = queryEmbeddingQ();
    for (const s of [0.99, 0.95, 0.9, 0.5, -0.3]) {
      const v = embeddingWithSimilarity(s, 17);
      expect(v).toHaveLength(1024);
      expect(Math.abs(cosineSimilarity(q, v) - s)).toBeLessThan(1e-12);
      expect(Math.abs(cosineSimilarity(q, v.map(Math.fround)) - s)).toBeLessThan(1e-6);
    }
  });
});

describe('Search Result links back to its Place (.agrules section 2, AC-35, AC-38)', () => {
  it.each([
    ['the Built Link', 'http://wikimapia.org/102', true],
    ['a Listing Link', 'http://wikimapia.org/102/Art-Gallery', true],
    ['a link to another Place', 'http://wikimapia.org/103', false],
    ['a link elsewhere', 'https://example.org/102', false],
  ])('%s: %s', (_, wikimapiaUrl, valid) => {
    expect(SearchResultSchema.safeParse(result({ wikimapiaUrl })).success).toBe(valid);
  });
});

describe('Ranking Order of a result list (AC-9, AC-66, AC-67)', () => {
  it.each([
    [
      'descending scores',
      [
        result({ placeId: 103, wikimapiaUrl: 'http://wikimapia.org/103', similarity: 0.99 }),
        result(),
      ],
      true,
    ],
    [
      'a tie in ascending Place ID',
      [
        result({ similarity: 0.8 }),
        result({ placeId: 201, wikimapiaUrl: 'http://wikimapia.org/201', similarity: 0.8 }),
      ],
      true,
    ],
    [
      'ascending scores',
      [
        result(),
        result({ placeId: 103, wikimapiaUrl: 'http://wikimapia.org/103', similarity: 0.99 }),
      ],
      false,
    ],
    [
      'a tie in descending Place ID',
      [
        result({ placeId: 201, wikimapiaUrl: 'http://wikimapia.org/201', similarity: 0.8 }),
        result({ similarity: 0.8 }),
      ],
      false,
    ],
    ['a repeated Place', [result(), result()], false],
  ])('%s: valid = %s', (_, results, valid) => {
    expect(SearchOutcomeSchema.safeParse({ ok: true, results }).success).toBe(valid);
  });
});

describe('Result list property check (AC-14, AC-15, AC-21, AC-67)', () => {
  const at300 = wgs84DistanceMetres(POINT_S, result().centre);
  it.each([
    [
      'a Distance without a Radius Filter',
      { queryText: 'museum' },
      [result({ distanceMetres: at300 })],
    ],
    ['no Distance with a Radius Filter', RADIUS_500, [result()]],
    [
      'a Distance beyond the Radius',
      { ...RADIUS_500, radiusMetres: 200 },
      [result({ distanceMetres: at300 })],
    ],
    ['a Distance 5 m off the WGS 84 distance', RADIUS_500, [result({ distanceMetres: at300 + 5 })]],
    [
      'more results than the Result Limit',
      { queryText: 'museum', limit: 1 },
      [
        result({ placeId: 103, wikimapiaUrl: 'http://wikimapia.org/103', similarity: 0.99 }),
        result(),
      ],
    ],
  ] as [string, SearchRequest, SearchResult[]][])('reports %s', (_, request, results) => {
    expect(findResultListIssues(request, results)).toHaveLength(1);
  });

  it('accepts a correct list with the boundary Distance equal to the Radius', () => {
    const request: SearchRequest = { ...RADIUS_500, radiusMetres: at300 };
    expect(findResultListIssues(request, [result({ distanceMetres: at300 })])).toStrictEqual([]);
  });
});

describe('Search Failure and command result rules (AC-43, AC-56)', () => {
  it('a Missing Key failure must name VOYAGE_API_KEY', () => {
    expect(SearchFailureSchema.safeParse({ kind: 'missing_key', message: 'no key' }).success).toBe(
      false,
    );
    expect(
      SearchFailureSchema.safeParse({ kind: 'missing_key', message: 'VOYAGE_API_KEY is not set' })
        .success,
    ).toBe(true);
  });

  const request = { queryText: 'museum' };
  const failure = { ok: false, failure: { kind: 'store_unavailable', message: 'unavailable' } };
  it.each([
    ['exit 0 for a list', { exitCode: 0, request, outcome: { ok: true, results: [] } }, true],
    ['exit 1 for a failure', { exitCode: 1, request, outcome: failure }, true],
    ['exit 1 for a usage error', { exitCode: 1 }, true],
    ['exit 0 for a failure', { exitCode: 0, request, outcome: failure }, false],
    ['exit 1 for a list', { exitCode: 1, request, outcome: { ok: true, results: [] } }, false],
    ['an outcome without its request', { exitCode: 0, outcome: { ok: true, results: [] } }, false],
  ])('%s: valid = %s', (_, value, valid) => {
    expect(SearchCommandResultSchema.safeParse(value).success).toBe(valid);
  });
});

describe('Usage line shows the documented command form (AC-44, AC-72, rule 13)', () => {
  it.each([
    ['the documented form alone', 'Usage: pnpm run search "<Query Text>" [options]', true],
    [
      'the documented form followed by the option list',
      'Usage: pnpm run search "<Query Text>" [options]  --near <lat>,<lon> --radius <metres>',
      true,
    ],
    ['a trailing carriage return', 'Usage: pnpm run search "<Query Text>" [options]\r', true],
    ['the short form `pnpm search`', 'Usage: pnpm search "<Query Text>" [options]', false],
    ['another placeholder case', 'Usage: pnpm run search "<query text>" [options]', false],
    ['no `[options]`', 'Usage: pnpm run search "<Query Text>" [--near <lat>,<lon>]', false],
    ['text glued to the form', 'Usage: pnpm run search "<Query Text>" [options]x', false],
    ['the form not at the start', 'Error. Usage: pnpm run search "<Query Text>" [options]', false],
  ])('%s -> %s', (_, line, expected) => {
    expect(isSearchUsageLine(line)).toBe(expected);
  });
});

describe('Command result block (AC-42)', () => {
  it('with a Distance, and without Tags or Distance', () => {
    expect(searchResultBlock(1, result({ distanceMetres: 299.6 }))).toStrictEqual([
      '1. Art Gallery (place 102)',
      '   Link: http://wikimapia.org/102',
      '   Tags: museum, art gallery',
      '   Centre: 44.8197, 20.457',
      '   Distance: 300 m',
      '   Similarity: 0.9500',
    ]);
    expect(searchResultBlock(2, result({ tags: [] }))).toStrictEqual([
      '2. Art Gallery (place 102)',
      '   Link: http://wikimapia.org/102',
      '   Tags: (none)',
      '   Centre: 44.8197, 20.457',
      '   Similarity: 0.9500',
    ]);
    expect(ATTRIBUTION_LINE).toBe('Data: Wikimapia (wikimapia.org), CC BY-NC-SA 3.0');
  });
});

describe('Simulated Embedding Service and query answers (AC-57, AC-58)', () => {
  it('answers Q as a usable single Embedding and records the request as sent', async () => {
    const service = new SimulatedQueryEmbeddingService();
    const answer = await service.embed({
      input: ['museum'],
      model: 'voyage-4',
      inputType: 'query',
      outputDimension: 1024,
    });
    expect(findEmbeddingAnswerIssues(answer, 1)).toStrictEqual([]);
    expect(service.texts).toStrictEqual(['museum']);
  });

  it.each([
    ['no Embedding', queryAnswer([])],
    ['two Embeddings', queryAnswer([queryEmbeddingQ(), queryEmbeddingQ()])],
    ['another model', queryAnswer([queryEmbeddingQ()], 'voyage-3.5')],
  ])('%s is an Invalid Embedding Answer for one query', (_, answer) => {
    expect(findEmbeddingAnswerIssues(answer, 1).length).toBeGreaterThan(0);
  });
});
