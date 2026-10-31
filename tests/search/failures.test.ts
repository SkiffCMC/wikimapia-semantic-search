/**
 * AL2 unit tests: the Search Failure builders `src/search/failures.ts` (AL4 hybrid-search 1.3,
 * 1.4.2, U1). Pure.
 */
import {
  INTERNAL_FAILURE,
  embeddingFailure,
  missingKeyFailure,
  storeFailure,
} from '../../src/search/failures';
import { EmbeddingFailureKindSchema } from '../../contracts/embeddings.schema';
import type { EmbeddingFailureKind } from '../../contracts/embeddings.schema';
import { SearchFailureSchema } from '../../contracts/hybrid-search.schema';
import type { StoreFailure } from '../../contracts/storage.schema';

const parses = (failure: unknown): boolean => SearchFailureSchema.safeParse(failure).success;

it('missingKeyFailure() is missing_key naming VOYAGE_API_KEY', () => {
  const failure = missingKeyFailure();
  expect(parses(failure)).toBe(true);
  expect(failure.kind).toBe('missing_key');
  expect(failure.message).toContain('VOYAGE_API_KEY');
});

it.each<EmbeddingFailureKind>(EmbeddingFailureKindSchema.options)(
  'embeddingFailure(%j, message) carries that kind and message',
  (kind) => {
    const failure = embeddingFailure(kind, 'fixed text');
    expect(failure).toStrictEqual({
      kind: 'query_embedding_failed',
      embeddingFailure: kind,
      message: 'fixed text',
    });
    expect(parses(failure)).toBe(true);
  },
);

it.each<[string, StoreFailure | { message: string }]>([
  [
    'store_unavailable',
    { kind: 'store_unavailable', message: 'Place Store unavailable: ECONNREFUSED' },
  ],
  [
    'invalid_data',
    {
      kind: 'invalid_data',
      message: 'Place Store unavailable: ECONNREFUSED',
      issues: [{ path: ['limit'], message: 'too small' }],
    },
  ],
  ['a bare message', { message: 'Place Store unavailable: ECONNREFUSED' }],
])('storeFailure(%s) is store_unavailable with that message', (_l, input) => {
  const failure = storeFailure(input);
  expect(failure).toStrictEqual({
    kind: 'store_unavailable',
    message: 'Place Store unavailable: ECONNREFUSED',
  });
  expect(parses(failure)).toBe(true);
});

it('INTERNAL_FAILURE is store_unavailable "Place search failed: internal error"', () => {
  expect(INTERNAL_FAILURE).toStrictEqual({
    kind: 'store_unavailable',
    message: 'Place search failed: internal error',
  });
  expect(parses(INTERNAL_FAILURE)).toBe(true);
});
