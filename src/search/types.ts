/**
 * Every type alias and interface of `src/search/` (AL4 hybrid-search 1.3; `.agrules` section 5).
 * Contract types are imported, never redefined.
 */
import type { Embedding } from '../../contracts/embeddings.schema';
import type { SearchFailure, SearchRequestDraft } from '../../contracts/hybrid-search.schema';

/** Result of the one Embedding Request of a search (AL4 1.4.2). */
export type QueryEmbeddingResult =
  /** 1024 finite numbers, not all zero. */
  | { ok: true; embedding: Embedding }
  /** Kind `query_embedding_failed`. */
  | { ok: false; failure: SearchFailure };

/** What the Search Command's argument parsing produced (AL4 1.4.6). */
export type ParsedSearchArgs =
  | { ok: true; draft: SearchRequestDraft }
  /** Usage error text, no input values beyond option names. */
  | { ok: false; problem: string };
