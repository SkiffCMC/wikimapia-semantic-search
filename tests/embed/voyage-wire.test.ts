/**
 * AL2 unit test: the Voyage wire format of `src/embed/voyage-service.ts` (AL4 embeddings 1.4.6,
 * section 3). The only check of it: every contract test injects a Simulated service. The REAL
 * `voyageai` SDK talks to a local `node:http` server on 127.0.0.1; nothing leaves the machine.
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  createVoyageEmbeddingService,
  createVoyageQueryEmbeddingService,
} from '../../src/embed/voyage-service';
import { TEST_VOYAGE_API_KEY, fakeEmbedding } from '../../contracts/embeddings.support';

const TEXTS = ['Synthetic place 301\nTags: park', 'Synthetic place 302'];

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

it('sends the snake_case REST request with the Bearer key and normalises the answer', async () => {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: TEXTS.map((text, index) => ({
            object: 'embedding',
            embedding: fakeEmbedding(text),
            index,
          })),
          model: 'voyage-4',
          usage: { total_tokens: 42 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const service = await createVoyageEmbeddingService({
      apiKey: TEST_VOYAGE_API_KEY,
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    });

    const answer = await service.embed({
      input: TEXTS,
      model: 'voyage-4',
      inputType: 'document',
      outputDimension: 1024,
      truncation: true,
    });

    expect(received).toHaveLength(1);
    const [sent] = received;
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('/v1/embeddings');
    expect(sent?.headers.authorization).toBe(`Bearer ${TEST_VOYAGE_API_KEY}`);
    expect(sent?.body).toStrictEqual({
      input: TEXTS,
      model: 'voyage-4',
      input_type: 'document',
      output_dimension: 1024,
      truncation: true,
    });
    expect(answer).toStrictEqual({
      object: 'list',
      data: TEXTS.map((text, index) => ({
        object: 'embedding',
        embedding: fakeEmbedding(text),
        index,
      })),
      model: 'voyage-4',
      usage: { totalTokens: 42 },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

// ---------------------------------------------------------------------------
// Query adapter `createVoyageQueryEmbeddingService` (AL4 hybrid-search 1.4.1, section 3, U1)
// ---------------------------------------------------------------------------

const QUERY_TEXT = 'Музеј near the river';

/** Starts a 127.0.0.1 server; `respond` answers each request (or never, when it does nothing). */
async function withServer(
  respond: (res: ServerResponse) => void,
  run: (baseUrl: string, bodies: unknown[]) => Promise<void>,
): Promise<void> {
  const bodies: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      respond(res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${String(port)}/v1`, bodies);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}

function statusCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode
    : undefined;
}

describe('createVoyageQueryEmbeddingService over the wire', () => {
  it('sends a snake_case query request', async () => {
    await withServer(
      (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', embedding: fakeEmbedding(QUERY_TEXT), index: 0 }],
            model: 'voyage-4',
            usage: { total_tokens: 5 },
          }),
        );
      },
      async (baseUrl, bodies) => {
        const service = await createVoyageQueryEmbeddingService({
          apiKey: TEST_VOYAGE_API_KEY,
          baseUrl,
        });
        await service.embed({
          input: [QUERY_TEXT],
          model: 'voyage-4',
          inputType: 'query',
          outputDimension: 1024,
        });
        expect(bodies).toStrictEqual([
          { input: [QUERY_TEXT], model: 'voyage-4', input_type: 'query', output_dimension: 1024 },
        ]);
      },
    );
  });

  it.each([429, 401, 503])(
    'HTTP %i: exactly one request, the error keeps statusCode',
    async (status) => {
      await withServer(
        (res) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'synthetic failure' }));
        },
        async (baseUrl, bodies) => {
          const service = await createVoyageQueryEmbeddingService({
            apiKey: TEST_VOYAGE_API_KEY,
            baseUrl,
            timeoutSeconds: 30,
          });
          const error: unknown = await service
            .embed({
              input: [QUERY_TEXT],
              model: 'voyage-4',
              inputType: 'query',
              outputDimension: 1024,
            })
            .then(
              () => undefined,
              (e: unknown) => e,
            );
          expect(statusCodeOf(error)).toBe(status);
          expect(bodies).toHaveLength(1);
        },
      );
    },
  );

  it('a server slower than timeoutSeconds 1 gives an error without a numeric statusCode', async () => {
    await withServer(
      () => {
        // never answers
      },
      async (baseUrl, bodies) => {
        const service = await createVoyageQueryEmbeddingService({
          apiKey: TEST_VOYAGE_API_KEY,
          baseUrl,
          timeoutSeconds: 1,
        });
        const error: unknown = await service
          .embed({
            input: [QUERY_TEXT],
            model: 'voyage-4',
            inputType: 'query',
            outputDimension: 1024,
          })
          .then(
            () => 'resolved',
            (e: unknown) => e,
          );
        expect(error).not.toBe('resolved');
        expect(typeof statusCodeOf(error)).not.toBe('number');
        expect(bodies).toHaveLength(1);
      },
    );
  }, 15_000);
});
