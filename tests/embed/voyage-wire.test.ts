/**
 * AL2 unit test: the Voyage wire format of `src/embed/voyage-service.ts` (AL4 embeddings 1.4.6,
 * section 3). The only check of it: every contract test injects a Simulated service. The REAL
 * `voyageai` SDK talks to a local `node:http` server on 127.0.0.1; nothing leaves the machine.
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVoyageEmbeddingService } from '../../src/embed/voyage-service';
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
