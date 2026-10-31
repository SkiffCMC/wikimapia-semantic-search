/**
 * AL2 unit tests: the Voyage adapter `src/embed/voyage-service.ts` (AL4 embeddings 1.4.6,
 * section 3). The `voyageai` SDK is mocked; the contract tests always inject their own service,
 * so everything here is unreached by them.
 */
import {
  createVoyageEmbeddingService,
  createVoyageQueryEmbeddingService,
  normaliseVoyageAnswer,
} from '../../src/embed/voyage-service';
import type { VoyageServiceOptions } from '../../src/embed/types';
import type { EmbeddingServiceRequest } from '../../contracts/embeddings.schema';
import type { QueryEmbeddingRequest } from '../../contracts/hybrid-search.schema';
import { TEST_VOYAGE_API_KEY } from '../../contracts/embeddings.support';

const sdk = vi.hoisted(() => ({
  constructed: [] as unknown[],
  embed: vi.fn<(request: unknown, options: unknown) => Promise<unknown>>(),
}));

vi.mock('voyageai', () => ({
  VoyageAIClient: class {
    constructor(options: unknown) {
      sdk.constructed.push(options);
    }
    embed = sdk.embed;
  },
}));

const REQUEST: EmbeddingServiceRequest = {
  input: ['Synthetic place 301', 'Synthetic place 302'],
  model: 'voyage-4',
  inputType: 'document',
  outputDimension: 1024,
};
const SDK_REQUEST = {
  input: REQUEST.input,
  model: 'voyage-4',
  inputType: 'document',
  outputDimension: 1024,
};

beforeEach(() => {
  sdk.constructed.length = 0;
  sdk.embed.mockReset();
});

it.each<[string, VoyageServiceOptions, EmbeddingServiceRequest, object, object, number]>([
  [
    'defaults',
    { apiKey: TEST_VOYAGE_API_KEY },
    REQUEST,
    { apiKey: TEST_VOYAGE_API_KEY },
    SDK_REQUEST,
    120,
  ],
  [
    'baseUrl, timeout and truncation given',
    { apiKey: TEST_VOYAGE_API_KEY, baseUrl: 'http://127.0.0.1:1/v1', timeoutSeconds: 5 },
    { ...REQUEST, truncation: true },
    { apiKey: TEST_VOYAGE_API_KEY, baseUrl: 'http://127.0.0.1:1/v1' },
    { ...SDK_REQUEST, truncation: true },
    5,
  ],
])(
  '%s: passes the client, request and call options through',
  async (_label, options, request, client, sent, timeout) => {
    sdk.embed.mockResolvedValue({ data: [], usage: { total_tokens: 7 } });
    const service = await createVoyageEmbeddingService(options);

    expect(await service.embed(request)).toStrictEqual({
      data: [],
      usage: { total_tokens: 7, totalTokens: 7 },
    });
    expect(sdk.constructed).toStrictEqual([client]);
    expect(sdk.embed.mock.calls).toStrictEqual([
      [sent, { maxRetries: 0, timeoutInSeconds: timeout }],
    ]);
  },
);

it.each<[string, unknown]>([
  ['an HTTP 401', Object.assign(new Error('unauthorized'), { statusCode: 401 })],
  ['a non-numeric statusCode', { statusCode: '500' }],
  ['an error without statusCode', new Error('socket hang up')],
  ['null', null],
  ['a string', 'boom'],
])('rethrows %s unchanged', async (_label, error) => {
  sdk.embed.mockRejectedValue(error);
  const service = await createVoyageEmbeddingService({ apiKey: TEST_VOYAGE_API_KEY });
  await expect(service.embed(REQUEST)).rejects.toBe(error);
});

it('an error with a 2xx statusCode (unreadable body) resolves undefined', async () => {
  sdk.embed.mockRejectedValue({ statusCode: 200 });
  const service = await createVoyageEmbeddingService({ apiKey: TEST_VOYAGE_API_KEY });
  await expect(service.embed(REQUEST)).resolves.toBeUndefined();
});

it.each<[string, unknown]>([
  ['not an object', 'text'],
  ['null', null],
  ['no usage', { data: [] }],
  ['usage null', { usage: null }],
  ['totalTokens already present', { usage: { totalTokens: 3, total_tokens: 4 } }],
  ['no total_tokens', { usage: {} }],
  ['non-numeric total_tokens', { usage: { total_tokens: '3' } }],
])('normaliseVoyageAnswer returns the answer as it came: %s', (_label, answer) => {
  expect(normaliseVoyageAnswer(answer)).toBe(answer);
});

// ---------------------------------------------------------------------------
// Query adapter `createVoyageQueryEmbeddingService` (AL4 hybrid-search 1.4.1, U1)
// ---------------------------------------------------------------------------

const QUERY: QueryEmbeddingRequest = {
  input: ['Музеј near the river'],
  model: 'voyage-4',
  inputType: 'query',
  outputDimension: 1024,
};

describe('createVoyageQueryEmbeddingService', () => {
  it.each<[string, VoyageServiceOptions, object, number]>([
    ['defaults', { apiKey: TEST_VOYAGE_API_KEY }, { apiKey: TEST_VOYAGE_API_KEY }, 120],
    [
      'baseUrl and a 30 s timeout given',
      { apiKey: TEST_VOYAGE_API_KEY, baseUrl: 'http://127.0.0.1:1/v1', timeoutSeconds: 30 },
      { apiKey: TEST_VOYAGE_API_KEY, baseUrl: 'http://127.0.0.1:1/v1' },
      30,
    ],
  ])('%s: query request without truncation, no SDK retry', async (_l, options, client, timeout) => {
    sdk.embed.mockResolvedValue({ data: [], usage: { total_tokens: 3 } });
    const service = await createVoyageQueryEmbeddingService(options);

    expect(await service.embed(QUERY)).toStrictEqual({
      data: [],
      usage: { total_tokens: 3, totalTokens: 3 },
    });
    expect(sdk.constructed).toStrictEqual([client]);
    expect(sdk.embed.mock.calls).toStrictEqual([
      [
        { input: QUERY.input, model: 'voyage-4', inputType: 'query', outputDimension: 1024 },
        { maxRetries: 0, timeoutInSeconds: timeout },
      ],
    ]);
  });

  it.each<[string, unknown]>([
    ['an HTTP 401', Object.assign(new Error('unauthorized'), { statusCode: 401 })],
    ['an HTTP 429', Object.assign(new Error('rate limit'), { statusCode: 429 })],
    ['an error without statusCode', new Error('timeout')],
  ])('rethrows %s unchanged', async (_l, error) => {
    sdk.embed.mockRejectedValue(error);
    const service = await createVoyageQueryEmbeddingService({ apiKey: TEST_VOYAGE_API_KEY });
    await expect(service.embed(QUERY)).rejects.toBe(error);
  });

  it('an error with a 2xx statusCode resolves undefined', async () => {
    sdk.embed.mockRejectedValue({ statusCode: 204 });
    const service = await createVoyageQueryEmbeddingService({ apiKey: TEST_VOYAGE_API_KEY });
    await expect(service.embed(QUERY)).resolves.toBeUndefined();
  });
});
