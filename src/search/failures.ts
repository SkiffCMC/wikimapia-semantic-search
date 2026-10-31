/**
 * Builders of Search Failures with fixed, secret-free messages (AL4 hybrid-search 1.3, 1.4.2;
 * AC-56 .. AC-60). No builder ever copies an error's own message.
 */
import type { EmbeddingFailureKind } from '../../contracts/embeddings.schema';
import type { SearchFailure } from '../../contracts/hybrid-search.schema';
import type { StoreFailure } from '../../contracts/storage.schema';
import { MISSING_KEY_MESSAGE } from '../embed/settings';

/** Missing Key (AC-56): the message names VOYAGE_API_KEY. */
export function missingKeyFailure(): SearchFailure {
  return { kind: 'missing_key', message: MISSING_KEY_MESSAGE };
}

/** Query Embedding Failure of the given kind (AC-57, AC-58). */
export function embeddingFailure(kind: EmbeddingFailureKind, message: string): SearchFailure {
  return { kind: 'query_embedding_failed', embeddingFailure: kind, message };
}

/** Store Unavailable (AC-59) from a Place Store failure; only its message is kept. */
export function storeFailure(failure: StoreFailure | { message: string }): SearchFailure {
  return { kind: 'store_unavailable', message: failure.message };
}

/** The failure of an unexpected internal error; Place Search still resolves. */
export const INTERNAL_FAILURE: SearchFailure = {
  kind: 'store_unavailable',
  message: 'Place search failed: internal error',
};
