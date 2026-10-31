/**
 * AL2 unit tests: the Approximate session options (AL4 hybrid-search 1.4.9, decision D-EF, U3)
 * in `src/db/search-session.ts`. Pure, no database.
 */
import { MAX_RESULT_LIMIT, type SearchMode } from '../../contracts/hybrid-search.schema';
import { APPROXIMATE_HNSW_EF_SEARCH, searchSessionOptions } from '../../src/db/search-session';

describe('search session options (D-EF)', () => {
  it('APPROXIMATE_HNSW_EF_SEARCH is the integer 100, between MAX_RESULT_LIMIT and 1000', () => {
    expect(APPROXIMATE_HNSW_EF_SEARCH).toBe(100);
    expect(Number.isInteger(APPROXIMATE_HNSW_EF_SEARCH)).toBe(true);
    expect(APPROXIMATE_HNSW_EF_SEARCH).toBeGreaterThanOrEqual(MAX_RESULT_LIMIT);
    expect(APPROXIMATE_HNSW_EF_SEARCH).toBeLessThanOrEqual(1000);
  });

  it.each<[SearchMode, string | undefined]>([
    ['approximate', '-c hnsw.ef_search=100'],
    ['exact', undefined],
  ])('%s mode gets the connection options %j', (mode, expected) => {
    expect(searchSessionOptions(mode)).toBe(expected);
  });
});
