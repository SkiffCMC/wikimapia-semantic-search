/**
 * Search session options (AL4 hybrid-search 1.4.9, decision D-EF). Approximate connections start
 * with pgvector's `hnsw.ef_search` raised to `APPROXIMATE_HNSW_EF_SEARCH` through the pg `options`
 * startup parameter, so `--approximate --limit 50` can return up to 50 results. This is a constant
 * connection parameter, never SQL and never built from input. Exact connections get no options.
 */
import type { SearchMode } from '../../contracts/hybrid-search.schema';

/** Integer; `MAX_RESULT_LIMIT` (50) <= value <= 1000 (pgvector's maximum). */
export const APPROXIMATE_HNSW_EF_SEARCH = 100;

export function searchSessionOptions(mode: SearchMode): string | undefined {
  if (mode === 'approximate') return `-c hnsw.ef_search=${String(APPROXIMATE_HNSW_EF_SEARCH)}`;
  return undefined;
}
