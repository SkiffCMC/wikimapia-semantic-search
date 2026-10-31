/**
 * The one Embedding Request of a valid search (AL4 hybrid-search 1.4.2; AC-2, AC-3, AC-57,
 * AC-58, AC-60): build the query request, call the service exactly once (no retry), classify a
 * thrown error, validate the answer and extract the Query Embedding. Never rejects, and never
 * uses an error's own message. The Voyage adapter is chosen by the caller, not here.
 */
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingAnswerSchema,
  EmbeddingSchema,
  QUERY_INPUT_TYPE,
  classifyEmbeddingServiceError,
  findEmbeddingAnswerIssues,
} from '../../contracts/embeddings.schema';
import type { EmbeddingFailureKind } from '../../contracts/embeddings.schema';
import type {
  QueryEmbeddingRequest,
  QueryEmbeddingService,
} from '../../contracts/hybrid-search.schema';
import { embeddingFailure } from './failures';
import type { QueryEmbeddingResult } from './types';

/** Seconds the query request may take before it counts as a Connection Failure (AL4 1.4.1). */
export const QUERY_EMBEDDING_TIMEOUT_SECONDS = 30;

const INVALID_PREFIX = 'The Embedding Service answer is invalid: ';

/** The numeric `statusCode` a caught error carries, if any. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const status = error.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** The fixed message of a thrown-error kind (AL4 1.4.2). */
function thrownMessage(
  kind: Exclude<EmbeddingFailureKind, 'invalid_answer'>,
  error: unknown,
): string {
  switch (kind) {
    case 'connection':
      return 'The Embedding Service could not be reached.';
    case 'rate_limit':
      return 'The Embedding Service answered with its rate limit; try again later.';
    case 'refused': {
      const status = statusCodeOf(error);
      const http = status === undefined ? '' : ` (HTTP ${String(status)})`;
      return `The Embedding Service refused the request${http}. Check VOYAGE_API_KEY and the Voyage account.`;
    }
  }
}

function invalidAnswer(issue: string): QueryEmbeddingResult {
  return { ok: false, failure: embeddingFailure('invalid_answer', `${INVALID_PREFIX}${issue}`) };
}

/** The one query request: exactly the given text, `voyage-4`, `query`, 1024, no `truncation`. */
export function buildQueryEmbeddingRequest(text: string): QueryEmbeddingRequest {
  return {
    input: [text],
    model: EMBEDDING_MODEL,
    inputType: QUERY_INPUT_TYPE,
    outputDimension: EMBEDDING_DIMENSIONS,
  };
}

/** Embeds the text with one call to the service; resolves with the embedding or a failure. */
export async function embedQueryText(
  service: QueryEmbeddingService,
  text: string,
): Promise<QueryEmbeddingResult> {
  let answer: unknown;
  try {
    answer = await Promise.resolve().then(() => service.embed(buildQueryEmbeddingRequest(text)));
  } catch (error) {
    const kind = classifyEmbeddingServiceError(error);
    return { ok: false, failure: embeddingFailure(kind, thrownMessage(kind, error)) };
  }
  const issues = findEmbeddingAnswerIssues(answer, 1);
  const firstIssue = issues[0];
  if (firstIssue !== undefined) return invalidAnswer(firstIssue);
  const item = EmbeddingAnswerSchema.parse(answer).data[0];
  if (item === undefined) return invalidAnswer('the answer cannot be read');
  const vector = EmbeddingSchema.parse(item.embedding);
  if (vector.every((value) => value === 0)) {
    return invalidAnswer('the Query Embedding is all zeros');
  }
  return { ok: true, embedding: vector };
}
