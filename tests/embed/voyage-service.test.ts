/**
 * AL2 unit tests: the Voyage adapter `src/embed/voyage-service.ts` (`createVoyageEmbeddingService`,
 * `normaliseVoyageAnswer`).
 *
 * Design refs: AL4 embeddings 1.4.6 (Voyage adapter), section 3 (SDK retries off, 120 s timeout),
 * U5 "Unit tests must cover". AL3 routing 20261023-embeddings-05-voyage-batch, section 2.1 A.
 *
 * No database. The adapter talks to the real `voyageai` SDK, pointed through the `baseUrl` option
 * at a local `node:http` server on 127.0.0.1 that answers REST snake_case bodies and records every
 * request. Nothing leaves 127.0.0.1; `fetch` and the SDK are not stubbed. The only key is the
 * synthetic `TEST_VOYAGE_API_KEY`. Vectors come only from `fakeEmbedding` (no vector literal in
 * this file, contract AC-59). SDK message text is never asserted on.
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createVoyageEmbeddingService,
  normaliseVoyageAnswer,
} from '../../src/embed/voyage-service';
import type { VoyageServiceOptions } from '../../src/embed/types';
import {
  DOCUMENT_INPUT_TYPE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingAnswerSchema,
  classifyEmbeddingServiceError,
  findEmbeddingAnswerIssues,
} from '../../contracts/embeddings.schema';
import type { EmbeddingService, EmbeddingServiceRequest } from '../../contracts/embeddings.schema';
import { TEST_VOYAGE_API_KEY, fakeEmbedding } from '../../contracts/embeddings.support';
import { at } from '../../contracts/storage.support';

// Compile-time check: the factory has the AL4 1.3 signature.
const create: (options: VoyageServiceOptions) => Promise<EmbeddingService> =
  createVoyageEmbeddingService;

const TEXTS = ['Synthetic place 301\nTags: park', 'Synthetic place 302', 'Synthetic place 303'];
const RETRY_CHECK_MS = 300;
const SLOW_ANSWER_MS = 3000;

// ---------------------------------------------------------------------------
// Local HTTP server on 127.0.0.1
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** Parsed JSON body (`JSON.parse` output), or the raw text when it is not JSON. */
  readonly body: unknown;
}

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly delayMs?: number;
}

type Handler = (request: RecordedRequest) => Reply;

const received: RecordedRequest[] = [];
const pendingTimers = new Set<NodeJS.Timeout>();
let handler: Handler = () => okReply(1, 1);
let server: Server;
let baseUrl = '';

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: parseBody(Buffer.concat(chunks).toString('utf8')),
      };
      received.push(recorded);
      const reply = handler(recorded);
      const send = (): void => {
        if (res.destroyed) return;
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          ...(reply.headers ?? {}),
        });
        res.end(reply.body);
      };
      if (reply.delayMs === undefined) {
        send();
      } else {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          send();
        }, reply.delayMs);
        pendingTimers.add(timer);
      }
    });
  });
  baseUrl = await listen(server);
});

beforeEach(() => {
  received.length = 0;
  handler = () => okReply(1, 1);
});

afterEach(() => {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/** Starts `target` on 127.0.0.1, port 0, and returns its base URL. */
async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    target.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(portOf(target))}/v1`;
}

function portOf(target: Server): number {
  const address = target.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  const info: AddressInfo = address;
  return info.port;
}

/** A base URL on 127.0.0.1 where nothing listens any more. */
async function closedPortUrl(): Promise<string> {
  const other = createServer();
  const url = await listen(other);
  await new Promise<void>((resolve) => {
    other.close(() => {
      resolve();
    });
  });
  return url;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(count: number): EmbeddingServiceRequest {
  return {
    input: TEXTS.slice(0, count),
    model: EMBEDDING_MODEL,
    inputType: DOCUMENT_INPUT_TYPE,
    outputDimension: EMBEDDING_DIMENSIONS,
    truncation: true,
  };
}

/** A REST (snake_case) Voyage answer for the first `count` texts. */
function restAnswer(count: number, totalTokens: number) {
  return {
    object: 'list',
    data: TEXTS.slice(0, count).map((text, index) => ({
      object: 'embedding',
      embedding: fakeEmbedding(text),
      index,
    })),
    model: EMBEDDING_MODEL,
    usage: { total_tokens: totalTokens },
  };
}

function okReply(count: number, totalTokens: number): Reply {
  return { status: 200, body: JSON.stringify(restAnswer(count, totalTokens)) };
}

function adapter(options: Partial<VoyageServiceOptions> = {}): Promise<EmbeddingService> {
  return create({ apiKey: TEST_VOYAGE_API_KEY, baseUrl, ...options });
}

/** The rejection of `promise`; fails the test when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function statusCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode
    : undefined;
}

function chunkText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

// ---------------------------------------------------------------------------
// 1. Request shape
// ---------------------------------------------------------------------------

describe('createVoyageEmbeddingService: request shape', () => {
  it('sends exactly one POST to .../embeddings with the synthetic Bearer key', async () => {
    handler = () => okReply(2, 12);
    const service = await adapter();
    await service.embed(request(2));
    expect(received).toHaveLength(1);
    const sent = at(received, 0);
    expect(sent.method).toBe('POST');
    expect(sent.path.split('?')[0]).toMatch(/\/embeddings$/);
    expect(sent.headers.authorization).toBe(`Bearer ${TEST_VOYAGE_API_KEY}`);
  });

  it('the JSON body is snake_case: input in order, voyage-4, document, 1024, truncation true', async () => {
    handler = () => okReply(3, 30);
    const service = await adapter();
    await service.embed(request(3));
    const body = at(received, 0).body;
    expect(body).toMatchObject({
      input: TEXTS.slice(0, 3),
      model: EMBEDDING_MODEL,
      input_type: DOCUMENT_INPUT_TYPE,
      output_dimension: EMBEDDING_DIMENSIONS,
      truncation: true,
    });
    expect(body).not.toHaveProperty('inputType');
    expect(body).not.toHaveProperty('outputDimension');
  });

  it('a single text is sent as a list of one', async () => {
    handler = () => okReply(1, 4);
    const service = await adapter();
    await service.embed(request(1));
    expect(at(received, 0).body).toMatchObject({ input: [at(TEXTS, 0)] });
  });
});

// ---------------------------------------------------------------------------
// 2. Answer shape
// ---------------------------------------------------------------------------

describe('createVoyageEmbeddingService: answer shape', () => {
  it('a 200 REST answer comes back camelCase with usage.totalTokens and passes the contract gate', async () => {
    handler = () => okReply(2, 42);
    const service = await adapter();
    const answer = await service.embed(request(2));
    expect(findEmbeddingAnswerIssues(answer, 2)).toStrictEqual([]);
    const parsed = EmbeddingAnswerSchema.parse(answer);
    expect(parsed.usage.totalTokens).toBe(42);
    expect(parsed.model).toBe(EMBEDDING_MODEL);
    expect(parsed.data).toHaveLength(2);
    expect(at(parsed.data, 0).embedding).toStrictEqual(fakeEmbedding(at(TEXTS, 0)));
    expect(at(parsed.data, 0).index).toBe(0);
    expect(at(parsed.data, 1).embedding).toStrictEqual(fakeEmbedding(at(TEXTS, 1)));
    expect(at(parsed.data, 1).index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP errors carry the status; SDK retries are off
// ---------------------------------------------------------------------------

describe('createVoyageEmbeddingService: HTTP errors', () => {
  const cases: [number, 'refused' | 'rate_limit' | 'connection'][] = [
    [401, 'refused'],
    [403, 'refused'],
    [400, 'refused'],
    [429, 'rate_limit'],
    [503, 'connection'],
    [408, 'connection'],
  ];

  it.each(cases)(
    'HTTP %i rejects with that statusCode (%s) after exactly 1 request, no SDK retry',
    async (status, kind) => {
      handler = () => ({
        status,
        body: JSON.stringify({ detail: 'synthetic error' }),
        ...(status === 429 ? { headers: { 'retry-after': '0' } } : {}),
      });
      const service = await adapter();
      const error = await rejectionOf(service.embed(request(2)));
      expect(classifyEmbeddingServiceError(error)).toBe(kind);
      expect(statusCodeOf(error)).toBe(status);
      expect(received).toHaveLength(1);
      await delay(RETRY_CHECK_MS);
      expect(received).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Network failures carry no status
// ---------------------------------------------------------------------------

describe('createVoyageEmbeddingService: no status for network failures', () => {
  it('a closed port rejects without a numeric statusCode (connection)', async () => {
    const service = await adapter({ baseUrl: await closedPortUrl() });
    const error = await rejectionOf(service.embed(request(1)));
    expect(typeof statusCodeOf(error)).not.toBe('number');
    expect(classifyEmbeddingServiceError(error)).toBe('connection');
  });

  it('a server slower than timeoutSeconds 1 rejects in well under 3 s without a status (connection)', async () => {
    handler = () => ({ ...okReply(1, 1), delayMs: SLOW_ANSWER_MS });
    const service = await adapter({ timeoutSeconds: 1 });
    const started = performance.now();
    const error = await rejectionOf(service.embed(request(1)));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(SLOW_ANSWER_MS - 500);
    expect(typeof statusCodeOf(error)).not.toBe('number');
    expect(classifyEmbeddingServiceError(error)).toBe('connection');
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Unreadable 2xx body
// ---------------------------------------------------------------------------

describe('createVoyageEmbeddingService: unreadable 2xx', () => {
  it('a 200 text/html body resolves to a value the contract gate rejects (not Refused)', async () => {
    handler = () => ({
      status: 200,
      body: '<html>Bad gateway</html>',
      headers: { 'content-type': 'text/html' },
    });
    const service = await adapter();
    const value = await service.embed(request(1));
    expect(findEmbeddingAnswerIssues(value, 1)).not.toStrictEqual([]);
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Secrets: the adapter writes nothing to stdout / stderr
// ---------------------------------------------------------------------------

describe('createVoyageEmbeddingService: no key written by the adapter', () => {
  it('for a 401 and a closed port, nothing containing the key goes to stdout or stderr', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    handler = () => ({ status: 401, body: JSON.stringify({ detail: 'synthetic unauthorized' }) });
    const refusedService = await adapter();
    await rejectionOf(refusedService.embed(request(1)));
    const closedService = await adapter({ baseUrl: await closedPortUrl() });
    await rejectionOf(closedService.embed(request(1)));
    const written = [...stdout.mock.calls, ...stderr.mock.calls].map((call) => chunkText(call[0]));
    stdout.mockRestore();
    stderr.mockRestore();
    for (const text of written) expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  });
});

// ---------------------------------------------------------------------------
// 7. normaliseVoyageAnswer (pure)
// ---------------------------------------------------------------------------

describe('normaliseVoyageAnswer', () => {
  it('adds usage.totalTokens from a numeric usage.total_tokens, as a copy', () => {
    const input = { usage: { total_tokens: 5 }, data: [] };
    const result = normaliseVoyageAnswer(input);
    expect(result).toStrictEqual({ usage: { total_tokens: 5, totalTokens: 5 }, data: [] });
    expect(result).not.toBe(input);
  });

  it('keeps every other key of the answer', () => {
    const input = { ...restAnswer(2, 9) };
    const result = normaliseVoyageAnswer(input);
    expect(result).toStrictEqual({ ...input, usage: { total_tokens: 9, totalTokens: 9 } });
    expect(findEmbeddingAnswerIssues(result, 2)).toStrictEqual([]);
  });

  it('an answer that already has totalTokens is returned with the same values', () => {
    const input = { usage: { total_tokens: 5, totalTokens: 7 }, data: [] };
    expect(normaliseVoyageAnswer(input)).toStrictEqual({
      usage: { total_tokens: 5, totalTokens: 7 },
      data: [],
    });
    const camel = { usage: { totalTokens: 3 }, data: [] };
    expect(normaliseVoyageAnswer(camel)).toStrictEqual({ usage: { totalTokens: 3 }, data: [] });
  });

  it.each([
    ['null', null],
    ['a string', '<html>Bad gateway</html>'],
    ['an empty object', {}],
    ['a numeric usage', { usage: 3 }],
    ['a text total_tokens', { usage: { total_tokens: 'x' } }],
  ])('%s is returned unchanged', (_, value: unknown) => {
    const before = structuredClone(value);
    const result = normaliseVoyageAnswer(value);
    expect(result).toStrictEqual(before);
    expect(value).toStrictEqual(before);
  });

  it('never mutates its input', () => {
    const input = { usage: { total_tokens: 5 }, data: [{ embedding: [0.5], index: 0 }] };
    const before = structuredClone(input);
    normaliseVoyageAnswer(input);
    expect(input).toStrictEqual(before);
    const frozen = Object.freeze({ usage: Object.freeze({ total_tokens: 6 }), data: [] });
    expect(normaliseVoyageAnswer(frozen)).toMatchObject({ usage: { totalTokens: 6 } });
  });
});
