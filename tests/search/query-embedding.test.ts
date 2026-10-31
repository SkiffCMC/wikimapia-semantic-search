/**
 * AL2 unit tests: the query embedding step `src/search/query-embedding.ts` (AL4 hybrid-search
 * 1.4.2, U1). Simulated query service and error makers from the contract support; no network.
 */
import {
  QUERY_EMBEDDING_TIMEOUT_SECONDS,
  buildQueryEmbeddingRequest,
  embedQueryText,
} from '../../src/search/query-embedding';
import { EMBEDDING_DIMENSIONS, findEmbeddingAnswerIssues } from '../../contracts/embeddings.schema';
import type { EmbeddingFailureKind } from '../../contracts/embeddings.schema';
import {
  QueryEmbeddingRequestSchema,
  SearchFailureSchema,
} from '../../contracts/hybrid-search.schema';
import type { QueryEmbeddingService, SearchFailure } from '../../contracts/hybrid-search.schema';
import {
  SimulatedQueryEmbeddingService,
  TEST_VOYAGE_API_KEY,
  connectionError,
  fakeVector,
  queryAnswer,
  queryEmbeddingQ,
  rateLimitError,
  refusedError,
  unavailableError,
} from '../../contracts/hybrid-search.support';
import type { QueryServiceAnswer } from '../../contracts/hybrid-search.support';

const TEXT = 'quiet museum near the river';
const CONNECTION = 'The Embedding Service could not be reached.';
const RATE_LIMIT = 'The Embedding Service answered with its rate limit; try again later.';
const refused = (status: number): string =>
  `The Embedding Service refused the request (HTTP ${String(status)}). Check VOYAGE_API_KEY and the Voyage account.`;
const invalid = (issue: string): string => `The Embedding Service answer is invalid: ${issue}`;
const firstIssue = (raw: unknown): string => findEmbeddingAnswerIssues(raw, 1)[0] ?? 'no issue';

const nonFinite = queryEmbeddingQ();
nonFinite[3] = Number.NaN;
const zeros = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

/** A Search Failure must parse and never carry the key, `Bearer` or the error's own text. */
function expectSafeFailure(failure: SearchFailure, error?: unknown): void {
  expect(SearchFailureSchema.safeParse(failure).success).toBe(true);
  expect(failure.message).not.toContain(TEST_VOYAGE_API_KEY);
  expect(failure.message).not.toContain('Bearer');
  if (error instanceof Error) expect(failure.message).not.toContain(error.message);
}

async function failureFor(answer: QueryServiceAnswer) {
  const service = new SimulatedQueryEmbeddingService(answer);
  const result = await embedQueryText(service, TEXT);
  expect(service.calls).toHaveLength(1);
  if (result.ok) throw new Error('expected a failure');
  expectSafeFailure(result.failure, 'error' in answer ? answer.error : undefined);
  return result.failure;
}

it('QUERY_EMBEDDING_TIMEOUT_SECONDS is 30', () => {
  expect(QUERY_EMBEDDING_TIMEOUT_SECONDS).toBe(30);
});

it.each([TEXT, 'Музеј Николе Тесле', 'Đinđić Šćepan çà', '  untrimmed  '])(
  'buildQueryEmbeddingRequest(%j) is the one query request, text unchanged, no truncation',
  (text) => {
    const request = buildQueryEmbeddingRequest(text);
    expect(request).toStrictEqual({
      input: [text],
      model: 'voyage-4',
      inputType: 'query',
      outputDimension: 1024,
    });
    expect(QueryEmbeddingRequestSchema.safeParse(request).success).toBe(true);
  },
);

it('a normal answer gives Q after exactly one call with the built request', async () => {
  const service = new SimulatedQueryEmbeddingService();
  const result = await embedQueryText(service, TEXT);
  expect(result).toStrictEqual({ ok: true, embedding: queryEmbeddingQ() });
  expect(service.calls).toStrictEqual([buildQueryEmbeddingRequest(TEXT)]);
});

it.each<[string, QueryServiceAnswer, EmbeddingFailureKind, string]>([
  ['connectionError', { error: connectionError() }, 'connection', CONNECTION],
  ['unavailableError (503)', { error: unavailableError() }, 'connection', CONNECTION],
  ['rateLimitError', { error: rateLimitError() }, 'rate_limit', RATE_LIMIT],
  ['refusedError (401)', { error: refusedError() }, 'refused', refused(401)],
  [
    'a 400 error',
    { error: Object.assign(new Error('bad'), { statusCode: 400 }) },
    'refused',
    refused(400),
  ],
  [
    'a non-numeric statusCode',
    { error: Object.assign(new Error('x'), { statusCode: '401' }) },
    'connection',
    CONNECTION,
  ],
])(
  'thrown %s: query_embedding_failed of that kind with the fixed message',
  async (_l, answer, kind, message) => {
    expect(await failureFor(answer)).toStrictEqual({
      kind: 'query_embedding_failed',
      embeddingFailure: kind,
      message,
    });
  },
);

it.each<[string, unknown, string]>([
  ['no Embedding', queryAnswer([]), firstIssue(queryAnswer([]))],
  [
    'two Embeddings',
    queryAnswer([queryEmbeddingQ(), queryEmbeddingQ()]),
    firstIssue(queryAnswer([queryEmbeddingQ(), queryEmbeddingQ()])),
  ],
  ['1023 numbers', queryAnswer([fakeVector(1023)]), firstIssue(queryAnswer([fakeVector(1023)]))],
  ['1025 numbers', queryAnswer([fakeVector(1025)]), firstIssue(queryAnswer([fakeVector(1025)]))],
  ['a non-finite value', queryAnswer([nonFinite]), firstIssue(queryAnswer([nonFinite]))],
  ['an unreadable answer', '<html>502 Bad Gateway</html>', 'the answer cannot be read'],
  ['undefined (2xx with no body)', undefined, 'the answer cannot be read'],
  [
    'model voyage-3.5 (AC-58)',
    queryAnswer([queryEmbeddingQ()], 'voyage-3.5'),
    firstIssue(queryAnswer([queryEmbeddingQ()], 'voyage-3.5')),
  ],
  ['an all-zero vector', queryAnswer([zeros]), 'the Query Embedding is all zeros'],
])('answer with %s: invalid_answer naming the first issue', async (_l, raw, issue) => {
  expect(await failureFor({ raw })).toStrictEqual({
    kind: 'query_embedding_failed',
    embeddingFailure: 'invalid_answer',
    message: invalid(issue),
  });
});

it.each<[string, unknown, EmbeddingFailureKind]>([
  ['refusedError', refusedError(), 'refused'],
  ['rateLimitError', rateLimitError(), 'rate_limit'],
  ['connectionError', connectionError(), 'connection'],
  ['a non-Error value', 'boom', 'connection'],
])(
  'a service whose embed throws %s synchronously resolves with that kind',
  async (_l, error, kind) => {
    let calls = 0;
    const service: QueryEmbeddingService = {
      embed: () => {
        calls += 1;
        throw error;
      },
    };
    const result = await embedQueryText(service, TEXT);
    expect(calls).toBe(1);
    if (result.ok) throw new Error('expected a failure');
    expect(result.failure).toMatchObject({
      kind: 'query_embedding_failed',
      embeddingFailure: kind,
    });
    expectSafeFailure(result.failure, error);
  },
);
