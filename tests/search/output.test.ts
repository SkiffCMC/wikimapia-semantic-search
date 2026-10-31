/**
 * AL2 unit tests: output lines of the Search Command (`src/search/output.ts`; AL4 hybrid-search
 * 1.4.7, U5). Pure: synthetic Search Results and Search Failures, no database, no network.
 */
import { failureLine, outcomeLines } from '../../src/search/output';
import {
  ATTRIBUTION_LINE,
  MODE_LINES,
  NO_RESULTS_LINE,
  SEARCH_FAILURE_LABELS,
  SEARCH_OPTION_FOR_PARAMETER,
  SearchFailureSchema,
  SearchOutcomeSchema,
  resultCountLine,
  searchResultBlock,
  type SearchFailure,
  type SearchMode,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';

const R1: SearchResult = {
  placeId: 9101,
  name: 'Synthetic Museum',
  wikimapiaUrl: 'http://wikimapia.org/9101',
  tags: ['museum', 'art gallery'],
  centre: { lat: 44.817, lon: 20.457 },
  distanceMetres: 120.4,
  similarity: 0.9,
};
const R2: SearchResult = {
  placeId: 9102,
  name: 'Synthetic Square',
  wikimapiaUrl: 'http://wikimapia.org/9102',
  tags: [],
  centre: { lat: 44.818, lon: 20.458 },
  similarity: 0.5,
};

describe.each<SearchMode>(['exact', 'approximate'])('AC-42 layouts in %s mode', (mode) => {
  it('a list: mode line, one block per result, count, attribution', () => {
    const outcome = SearchOutcomeSchema.parse({ ok: true, results: [R1, R2] });
    expect(outcomeLines(mode, outcome)).toStrictEqual([
      MODE_LINES[mode],
      ...searchResultBlock(1, R1),
      ...searchResultBlock(2, R2),
      resultCountLine(2),
      ATTRIBUTION_LINE,
    ]);
  });

  it('an empty list: mode line, no-results line, attribution', () => {
    expect(outcomeLines(mode, { ok: true, results: [] })).toStrictEqual([
      MODE_LINES[mode],
      NO_RESULTS_LINE,
      ATTRIBUTION_LINE,
    ]);
  });
});

const invalid = (parameter: string): SearchFailure => ({
  kind: 'invalid_request',
  parameter,
  message: `synthetic message for ${parameter}`,
});

describe('failures', () => {
  it.each<[string, SearchFailure, string]>([
    ['invalid_request radiusMetres', invalid('radiusMetres'), SEARCH_OPTION_FOR_PARAMETER.radiusMetres],
    ['invalid_request spatialFilter', invalid('spatialFilter'), SEARCH_OPTION_FOR_PARAMETER.spatialFilter],
    ['invalid_request queryText', invalid('queryText'), SEARCH_OPTION_FOR_PARAMETER.queryText],
    ['invalid_request request', invalid('request'), 'request'],
    ['invalid_request unknown parameter', invalid('colour'), 'colour'],
    ['missing_key', { kind: 'missing_key', message: 'synthetic: set VOYAGE_API_KEY' }, 'VOYAGE_API_KEY'],
    ['query_embedding_failed', { kind: 'query_embedding_failed', embeddingFailure: 'rate_limit', message: 'synthetic rate limit' }, 'synthetic rate limit'],
    ['store_unavailable', { kind: 'store_unavailable', message: 'synthetic store down' }, 'synthetic store down'],
  ])('%s: one line with the label, the message and the option', (_, failure, named) => {
    expect(SearchFailureSchema.safeParse(failure).success).toBe(true);
    const line = failureLine(failure);
    expect(line.startsWith('Search failed: ')).toBe(true);
    expect(line).toContain(SEARCH_FAILURE_LABELS[failure.kind]);
    expect(line).toContain(failure.message);
    expect(line).toContain(named);
    for (const mode of ['exact', 'approximate'] as const) {
      expect(outcomeLines(mode, { ok: false, failure })).toStrictEqual([line]);
    }
  });
});
