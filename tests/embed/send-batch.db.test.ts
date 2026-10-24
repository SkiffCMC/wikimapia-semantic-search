/**
 * AL2 unit tests: one Batch, `sendBatch` (`src/embed/send-batch.ts`), against the Test Database.
 *
 * Design refs: AL4 embeddings 1.4.4 (One Batch), 1.4.7 (progress lines), section 3 (retries),
 * U5 "Unit tests must cover". AL3 routing 20261023-embeddings-05-voyage-batch, section 2.1 B.
 * Stand-in for contract AC-18 (request shape, Embedded At), AC-26, AC-34 .. AC-38, AC-45, AC-48
 * (Batch side) and AC-51 (no error text copied) until `contracts/embeddings.test.ts` can load
 * (U7).
 *
 * Real Embedding Store (`createEmbeddingStore`) and real tally (`createTally`); the Embedding
 * Service and the clock are the contract's Simulated ones (nothing waits on real time, no
 * network). Runs against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`.
 * Places are seeded only through `createPlaceStore` with `syntheticDetails`. Vectors come only
 * from `fakeEmbedding` / `fakeVector` / `normalAnswer` (no vector literal, contract AC-59).
 * `sendBatch` itself never calls `tally.failed` and prints only the "sending" and "retrying"
 * progress lines; the U6 loop does the rest (AL4 1.4.2).
 */
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { createTally } from '../../src/embed/report';
import { sendBatch } from '../../src/embed/send-batch';
import type { BatchResult, DueItem, SendContext, Tally } from '../../src/embed/types';
import {
  DOCUMENT_INPUT_TYPE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_RETRY_WAITS_SECONDS,
  ReadEmbeddingRecordResultSchema,
  SaveEmbeddingRecordsResultSchema,
  VOYAGE_API_KEY_ENV,
  documentFingerprint,
  findEmbeddingAnswerIssues,
} from '../../contracts/embeddings.schema';
import type {
  EmbeddingRecord,
  EmbeddingService,
  EmbeddingStore,
} from '../../contracts/embeddings.schema';
import {
  NORMAL,
  RUN_START,
  SECOND,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  SimulatedServiceError,
  TEST_VOYAGE_API_KEY,
  byAttempt,
  connectionError,
  fail,
  fakeEmbedding,
  fakeVector,
  iso,
  normal,
  normalAnswer,
  raw,
  rateLimitError,
  refusedError,
  syntheticDetails,
  syntheticName,
  unavailableError,
} from '../../contracts/embeddings.support';
import type { ServiceResponder } from '../../contracts/embeddings.support';
import {
  EmptyResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
} from '../../contracts/storage.schema';
import type {
  PlaceStore,
  SchemaSetup,
  StoreFailure,
  WriteHook,
} from '../../contracts/storage.schema';
import { FETCHED_AT, at, requireTestDatabaseUrl } from '../../contracts/storage.support';

// Compile-time check: `sendBatch` has the AL4 1.3 signature.
const send: (ctx: SendContext, items: readonly DueItem[]) => Promise<BatchResult> = sendBatch;

const UNKNOWN_ID = 777_777;
const WAITS_MS = EMBEDDING_RETRY_WAITS_SECONDS.map((s) => s * 1000);
const FIRST_WAIT = EMBEDDING_RETRY_WAITS_SECONDS[0];
const SECOND_WAIT = EMBEDDING_RETRY_WAITS_SECONDS[1];
const RATE_LIMITED_MESSAGE =
  'The Embedding Service kept answering with its rate limit after 3 tries.';
const STORE_REJECTED_PREFIX = 'the Place Store rejected the Embedding Records: ';
const HOOK_TEXT = `hook failed Bearer ${TEST_VOYAGE_API_KEY}`;

// ---------------------------------------------------------------------------
// Lifecycle: Test Database migrated once, emptied before every test
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let store: EmbeddingStore;
const extraStores: EmbeddingStore[] = [];

beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect(SchemaStepsResultSchema.parse(await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
});

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
  store = createEmbeddingStore({ connectionString: testUrl });
});

afterEach(async () => {
  await store.close();
  for (const extra of extraStores.splice(0)) await extra.close();
});

afterAll(async () => {
  await places.close();
  await setup.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

async function seedSynthetic(...ids: number[]): Promise<void> {
  for (const id of ids) {
    const details = await syntheticDetails(id);
    okValue(
      SaveResultSchema.parse(await places.savePlaceDetails({ details, fetchedAt: FETCHED_AT })),
    );
  }
}

function item(placeId: number): DueItem {
  const document = `${syntheticName(placeId)}\nTags: synthetic tag`;
  return { placeId, document, fingerprint: documentFingerprint(document) };
}

function itemsOf(...ids: number[]): DueItem[] {
  return ids.map(item);
}

async function recordOf(placeId: number): Promise<EmbeddingRecord | undefined> {
  const value = okValue(
    ReadEmbeddingRecordResultSchema.parse(await store.readEmbeddingRecord({ placeId })),
  );
  return value.found ? value.record : undefined;
}

/** Keeps an older (`voyage-3.5`) record of `placeId` directly through the Embedding Store. */
async function keepOldRecord(placeId: number): Promise<EmbeddingRecord> {
  const record: EmbeddingRecord = {
    placeId,
    embedding: fakeEmbedding(`old ${String(placeId)}`),
    model: 'voyage-3.5',
    documentFingerprint: documentFingerprint(`old ${String(placeId)}`),
    embeddedAt: FETCHED_AT,
  };
  okValue(
    SaveEmbeddingRecordsResultSchema.parse(await store.saveEmbeddingRecords({ records: [record] })),
  );
  return record;
}

/** The record `sendBatch` should keep for `it` from a normal answer received at `receivedAtMs`. */
function freshRecord(it: DueItem, receivedAtMs: number, embedding = fakeEmbedding(it.document)) {
  return {
    placeId: it.placeId,
    embedding,
    model: EMBEDDING_MODEL,
    documentFingerprint: it.fingerprint,
    embeddedAt: iso(receivedAtMs),
  };
}

interface Harness {
  ctx: SendContext;
  clock: SimulatedEmbeddingClock;
  service: SimulatedEmbeddingService;
  tally: Tally;
  lines: string[];
}

interface HarnessOptions {
  responder?: ServiceResponder;
  service?: EmbeddingService;
  signal?: AbortSignal;
  onSleep?: () => void;
  store?: EmbeddingStore;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = new SimulatedEmbeddingClock(RUN_START, {
    ...(options.onSleep === undefined ? {} : { onSleep: options.onSleep }),
  });
  const service = new SimulatedEmbeddingService(clock, options.responder ?? (() => NORMAL));
  const tally = createTally();
  const lines: string[] = [];
  const ctx: SendContext = {
    service: options.service ?? service,
    store: options.store ?? store,
    clock,
    signal: options.signal,
    tally,
    progress: (line) => {
      lines.push(line);
    },
    batchNumber: 1,
  };
  return { ctx, clock, service, tally, lines };
}

function sleepsMs(clock: SimulatedEmbeddingClock): number[] {
  return clock.sleeps.map((s) => s.ms);
}

/** Rule 12 of the routing: one `request()` per attempt, one `batch()` per call. */
function expectCounters(h: Harness, requests: number = h.service.calls.length): void {
  const counts = h.tally.snapshot();
  expect(counts.embeddingRequests).toBe(requests);
  expect(counts.batchesSent).toBe(1);
  expect(counts.failedPlaces).toBe(0);
}

function sendingLine(n: number): string {
  return `Batch 1: sending ${String(n)} places`;
}

function retryLine(kind: 'connection failure' | 'rate limit', seconds: number): string {
  return `Batch 1: ${kind}, retrying in ${String(seconds)} s`;
}

function refusedMessage(status: number): string {
  return `The Embedding Service refused the request (HTTP ${String(status)}). Check ${VOYAGE_API_KEY_ENV} and the Voyage account.`;
}

function stopOf(result: BatchResult) {
  if (result.kind !== 'stopped') throw new Error(`expected stopped, got ${result.kind}`);
  return result.stop;
}

function expectNoSecretIn(texts: readonly string[], errorMessage?: string): void {
  for (const text of texts) {
    expect(text).not.toContain(TEST_VOYAGE_API_KEY);
    expect(text).not.toContain('Bearer');
    if (errorMessage !== undefined) expect(text).not.toContain(errorMessage);
  }
}

// ---------------------------------------------------------------------------
// 1. Kept (AC-18, AC-33, AC-48)
// ---------------------------------------------------------------------------

describe('sendBatch: a normal answer is kept', () => {
  it('request shape, records with Embedded At after a 5 s answer, tokens, counters, progress', async () => {
    await seedSynthetic(301, 302);
    const items = itemsOf(301, 302);
    const h = harness({ responder: () => ({ delayMs: 5 * SECOND, then: normal(40) }) });
    const result = await send(h.ctx, items);
    expect(result).toStrictEqual({ kind: 'kept', tokens: 40 });
    expect(h.service.calls).toHaveLength(1);
    expect(at(h.service.calls, 0).request).toStrictEqual({
      input: items.map((i) => i.document),
      model: EMBEDDING_MODEL,
      inputType: DOCUMENT_INPUT_TYPE,
      outputDimension: EMBEDDING_DIMENSIONS,
      truncation: true,
    });
    const receivedAt = Date.parse(RUN_START) + 5 * SECOND;
    for (const it of items) {
      expect(await recordOf(it.placeId)).toStrictEqual(freshRecord(it, receivedAt));
    }
    const counts = h.tally.snapshot();
    expect(counts.batchesSent).toBe(1);
    expect(counts.embeddingRequests).toBe(1);
    expect(counts.tokensUsed).toBe(40);
    expect(counts.placesEmbedded).toBe(2);
    expect(h.lines).toStrictEqual([sendingLine(2)]);
    expect(h.clock.sleeps).toHaveLength(0);
    expectCounters(h);
  });

  it('Embedded At is truncated to the second of the receive moment', async () => {
    await seedSynthetic(301);
    const items = itemsOf(301);
    const h = harness({ responder: () => ({ delayMs: 2500, then: NORMAL }) });
    expect(await send(h.ctx, items)).toStrictEqual({ kind: 'kept', tokens: 10 });
    expect((await recordOf(301))?.embeddedAt).toBe(iso(Date.parse(RUN_START) + 2 * SECOND));
    expectCounters(h);
  });
});

// ---------------------------------------------------------------------------
// 2. Index mapping (AC-26)
// ---------------------------------------------------------------------------

describe('sendBatch: Embedding kept with the right Place', () => {
  const E = [fakeVector(1024, 'E1'), fakeVector(1024, 'E2'), fakeVector(1024, 'E3')];

  it('with indexes the index decides, not the position in the answer', async () => {
    await seedSynthetic(301, 302, 303);
    const items = itemsOf(301, 302, 303);
    const answer = {
      data: [
        { object: 'embedding', embedding: at(E, 2), index: 2 },
        { object: 'embedding', embedding: at(E, 1), index: 1 },
        { object: 'embedding', embedding: at(E, 0), index: 0 },
      ],
      model: EMBEDDING_MODEL,
      usage: { totalTokens: 30 },
    };
    const h = harness({ responder: () => raw(answer) });
    expect(await send(h.ctx, items)).toStrictEqual({ kind: 'kept', tokens: 30 });
    for (const [i, it] of items.entries()) {
      expect((await recordOf(it.placeId))?.embedding).toStrictEqual(at(E, i));
    }
    expectCounters(h);
  });

  it('without indexes the position decides', async () => {
    await seedSynthetic(301, 302, 303);
    const items = itemsOf(301, 302, 303);
    const answer = {
      data: E.map((embedding) => ({ object: 'embedding', embedding })),
      model: EMBEDDING_MODEL,
      usage: { totalTokens: 30 },
    };
    const h = harness({ responder: () => raw(answer) });
    expect(await send(h.ctx, items)).toStrictEqual({ kind: 'kept', tokens: 30 });
    for (const [i, it] of items.entries()) {
      expect((await recordOf(it.placeId))?.embedding).toStrictEqual(at(E, i));
    }
    expectCounters(h);
  });

  it('an answer without model is kept with EMBEDDING_MODEL', async () => {
    await seedSynthetic(301);
    const items = itemsOf(301);
    const full = normalAnswer([at(items, 0).document], 5);
    const noModel = { object: full.object, data: full.data, usage: full.usage };
    const h = harness({ responder: () => raw(noModel) });
    expect(await send(h.ctx, items)).toStrictEqual({ kind: 'kept', tokens: 5 });
    expect((await recordOf(301))?.model).toBe(EMBEDDING_MODEL);
    expectCounters(h);
  });
});

// ---------------------------------------------------------------------------
// 3. Connection Failure retried (AC-34)
// ---------------------------------------------------------------------------

describe('sendBatch: Connection Failure then a normal answer', () => {
  it.each([
    ['no answer', connectionError()],
    ['temporarily unavailable (503)', unavailableError()],
  ])('%s: one 30 s wait, the same Batch again, kept, 2 requests', async (_, error) => {
    await seedSynthetic(301, 302);
    const items = itemsOf(301, 302);
    const h = harness({ responder: byAttempt(fail(error), NORMAL) });
    expect(await send(h.ctx, items)).toStrictEqual({ kind: 'kept', tokens: 10 });
    expect(h.service.calls).toHaveLength(2);
    expect(at(h.service.calls, 1).request.input).toStrictEqual(
      at(h.service.calls, 0).request.input,
    );
    expect(sleepsMs(h.clock)).toStrictEqual([FIRST_WAIT * 1000]);
    const receivedAt = Date.parse(RUN_START) + FIRST_WAIT * SECOND;
    for (const it of items) {
      expect(await recordOf(it.placeId)).toStrictEqual(freshRecord(it, receivedAt));
    }
    const counts = h.tally.snapshot();
    expect(counts.embeddingRequests).toBe(2);
    expect(counts.batchesSent).toBe(1);
    expect(counts.tokensUsed).toBe(10);
    expect(h.lines).toStrictEqual([sendingLine(2), retryLine('connection failure', FIRST_WAIT)]);
    expectNoSecretIn(h.lines, error.message);
    expectCounters(h);
  });
});

// ---------------------------------------------------------------------------
// 4. Connection Failure persists (AC-35)
// ---------------------------------------------------------------------------

describe('sendBatch: persistent Connection Failure', () => {
  it('3 requests 30 s then 60 s apart, failed connection, nothing kept, earlier record unchanged', async () => {
    await seedSynthetic(301, 302);
    const old = await keepOldRecord(301);
    const items = itemsOf(301, 302);
    const h = harness({ responder: () => fail(connectionError()) });
    expect(await send(h.ctx, items)).toStrictEqual({
      kind: 'failed',
      failureKind: 'connection',
      reason: 'connection failure after 3 tries',
    });
    expect(h.service.calls).toHaveLength(3);
    const starts = h.service.calls.map((c) => c.startedAtMs);
    expect([at(starts, 1) - at(starts, 0), at(starts, 2) - at(starts, 1)]).toStrictEqual(WAITS_MS);
    expect(sleepsMs(h.clock)).toStrictEqual(WAITS_MS);
    expect(await recordOf(301)).toStrictEqual(old);
    expect(await recordOf(302)).toBeUndefined();
    const counts = h.tally.snapshot();
    expect(counts.failedPlaces).toBe(0);
    expect(counts.placesEmbedded).toBe(0);
    expect(counts.tokensUsed).toBe(0);
    expect(h.tally.failures).toStrictEqual([]);
    expect(h.lines).toStrictEqual([
      sendingLine(2),
      retryLine('connection failure', FIRST_WAIT),
      retryLine('connection failure', SECOND_WAIT),
    ]);
    expectNoSecretIn(h.lines, connectionError().message);
    expectCounters(h, 3);
  });
});

// ---------------------------------------------------------------------------
// 5. Service Rate Limit (AC-36)
// ---------------------------------------------------------------------------

describe('sendBatch: Service Rate Limit', () => {
  it('persistent 429: stopped rate_limited after 3 requests (30 s, 60 s), nothing kept', async () => {
    await seedSynthetic(301, 302);
    const items = itemsOf(301, 302);
    const h = harness({ responder: () => fail(rateLimitError()) });
    expect(await send(h.ctx, items)).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'rate_limited', message: RATE_LIMITED_MESSAGE },
    });
    expect(h.service.calls).toHaveLength(3);
    expect(sleepsMs(h.clock)).toStrictEqual(WAITS_MS);
    expect(await recordOf(301)).toBeUndefined();
    expect(await recordOf(302)).toBeUndefined();
    expect(h.tally.snapshot().tokensUsed).toBe(0);
    expect(h.lines).toStrictEqual([
      sendingLine(2),
      retryLine('rate limit', FIRST_WAIT),
      retryLine('rate limit', SECOND_WAIT),
    ]);
    expectCounters(h, 3);
  });

  it('429 then a normal answer: kept after one 30 s wait', async () => {
    await seedSynthetic(301);
    const items = itemsOf(301);
    const h = harness({ responder: byAttempt(fail(rateLimitError()), NORMAL) });
    expect(await send(h.ctx, items)).toStrictEqual({ kind: 'kept', tokens: 10 });
    expect(h.service.calls).toHaveLength(2);
    expect(sleepsMs(h.clock)).toStrictEqual([FIRST_WAIT * 1000]);
    expect(h.lines).toStrictEqual([sendingLine(1), retryLine('rate limit', FIRST_WAIT)]);
    expect(await recordOf(301)).toStrictEqual(
      freshRecord(at(items, 0), Date.parse(RUN_START) + FIRST_WAIT * SECOND),
    );
    expectCounters(h, 2);
  });
});

// ---------------------------------------------------------------------------
// 6. Service Refused (AC-37, AC-51)
// ---------------------------------------------------------------------------

describe('sendBatch: Service Refused', () => {
  it.each([
    [401, refusedError()],
    [
      400,
      new SimulatedServiceError(
        400,
        `Status code: 400 bad request (Authorization: Bearer ${TEST_VOYAGE_API_KEY})`,
      ),
    ],
    [403, new SimulatedServiceError(403, 'Status code: 403 forbidden account')],
  ])(
    'HTTP %i: stopped failed after 1 request, no wait, no key or error text',
    async (status, error) => {
      await seedSynthetic(301, 302);
      const items = itemsOf(301, 302);
      const h = harness({ responder: () => fail(error) });
      const result = await send(h.ctx, items);
      const stop = stopOf(result);
      expect(stop.outcome).toBe('failed');
      expect(stop.message).toBe(refusedMessage(status));
      const message = stop.message ?? '';
      expect(message).toMatch(/Embedding Service refused/i);
      expect(message).toContain(`HTTP ${String(status)}`);
      expect(message).toContain(VOYAGE_API_KEY_ENV);
      expect(h.service.calls).toHaveLength(1);
      expect(h.clock.sleeps).toHaveLength(0);
      expect(await recordOf(301)).toBeUndefined();
      expect(await recordOf(302)).toBeUndefined();
      expect(h.lines).toStrictEqual([sendingLine(2)]);
      expectNoSecretIn([message, ...h.lines], error.message);
      expectCounters(h, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// 7. Invalid Embedding Answer (AC-38, approved decision 3)
// ---------------------------------------------------------------------------

describe('sendBatch: Invalid Embedding Answer', () => {
  const items = itemsOf(301, 302, 303);
  const three = (embedding: unknown[]) => ({
    data: [0, 1, 2].map((index) => ({ object: 'embedding', embedding, index })),
    model: EMBEDDING_MODEL,
    usage: { totalTokens: 30 },
  });
  const twoOnly = {
    data: [0, 1].map((index) => ({ object: 'embedding', embedding: fakeVector(1024), index })),
    model: EMBEDDING_MODEL,
    usage: { totalTokens: 20 },
  };
  const withValue = (value: unknown) => three([...fakeVector(1023), value]);
  const cases: [string, unknown][] = [
    ['2 Embeddings for 3 documents', twoOnly],
    ['an Embedding of 1023 numbers', three(fakeVector(1023))],
    ['an Embedding of 1025 numbers', three(fakeVector(1025))],
    ['a NaN value', withValue(Number.NaN)],
    ['an infinite value', withValue(Number.POSITIVE_INFINITY)],
    ['a text value', withValue('0.5')],
    ['an answer that cannot be read (text)', '<html>Bad gateway</html>'],
    ['an answer that cannot be read (null)', null],
    ['an answer that cannot be read (no data)', { usage: { totalTokens: 1 } }],
    [
      'an answer from model voyage-3.5',
      {
        ...normalAnswer(
          items.map((i) => i.document),
          30,
        ),
        model: 'voyage-3.5',
      },
    ],
  ];

  it.each(cases)(
    '%s: failed invalid_answer with the contract reason, 1 request, nothing kept, no tokens',
    async (_, bad) => {
      await seedSynthetic(301, 302, 303);
      const h = harness({ responder: () => raw(bad) });
      const issues = findEmbeddingAnswerIssues(bad, items.length);
      expect(issues.length).toBeGreaterThan(0);
      expect(await send(h.ctx, items)).toStrictEqual({
        kind: 'failed',
        failureKind: 'invalid_answer',
        reason: at(issues, 0),
      });
      expect(h.service.calls).toHaveLength(1);
      expect(h.clock.sleeps).toHaveLength(0);
      for (const it of items) expect(await recordOf(it.placeId)).toBeUndefined();
      const counts = h.tally.snapshot();
      expect(counts.tokensUsed).toBe(0);
      expect(counts.placesEmbedded).toBe(0);
      expect(h.lines).toStrictEqual([sendingLine(3)]);
      expectCounters(h, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// 8. The store rejects the records (Invalid Data)
// ---------------------------------------------------------------------------

describe('sendBatch: the Embedding Store rejects the records', () => {
  it('an item that is not a stored Detailed Place: failed invalid_data, nothing kept, no tokens', async () => {
    await seedSynthetic(301);
    const items = itemsOf(301, UNKNOWN_ID);
    const h = harness();
    const result = await send(h.ctx, items);
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failureKind).toBe('invalid_data');
    expect(result.reason.startsWith(STORE_REJECTED_PREFIX)).toBe(true);
    expect(result.reason.length).toBeGreaterThan(STORE_REJECTED_PREFIX.length);
    expect(await recordOf(301)).toBeUndefined();
    expect(await recordOf(UNKNOWN_ID)).toBeUndefined();
    const counts = h.tally.snapshot();
    expect(counts.tokensUsed).toBe(0);
    expect(counts.placesEmbedded).toBe(0);
    expect(h.service.calls).toHaveLength(1);
    expect(h.lines).toStrictEqual([sendingLine(2)]);
    expectNoSecretIn([result.reason]);
    expectCounters(h, 1);
  });
});

// ---------------------------------------------------------------------------
// 9. The store is unavailable while keeping (AC-42, AC-45)
// ---------------------------------------------------------------------------

describe('sendBatch: the Embedding Store is unavailable while keeping', () => {
  it('a write hook failing at write 1: stopped failed after 1 request, nothing kept, no hook text', async () => {
    await seedSynthetic(301, 302);
    const items = itemsOf(301, 302);
    const onWrite: WriteHook = (n) => {
      if (n === 1) throw new Error(HOOK_TEXT);
    };
    const failing = createEmbeddingStore({ connectionString: testUrl, onWrite });
    extraStores.push(failing);
    const h = harness({ store: failing });
    const stop = stopOf(await send(h.ctx, items));
    expect(stop.outcome).toBe('failed');
    expect(typeof stop.message).toBe('string');
    const message = stop.message ?? '';
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(HOOK_TEXT);
    expectNoSecretIn([message, ...h.lines]);
    expect(h.service.calls).toHaveLength(1);
    expect(await recordOf(301)).toBeUndefined();
    expect(await recordOf(302)).toBeUndefined();
    expect(h.tally.snapshot().tokensUsed).toBe(0);
    expectCounters(h, 1);
  });
});

// ---------------------------------------------------------------------------
// 10. Interrupt (AC-43, Batch side)
// ---------------------------------------------------------------------------

describe('sendBatch: interrupt', () => {
  it('signal already aborted when the first attempt fails: stopped interrupted, 1 request, no wait', async () => {
    await seedSynthetic(301, 302);
    const controller = new AbortController();
    controller.abort();
    const h = harness({ responder: () => fail(connectionError()), signal: controller.signal });
    expect(await send(h.ctx, itemsOf(301, 302))).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'interrupted' },
    });
    expect(h.service.calls).toHaveLength(1);
    expect(h.clock.sleeps).toHaveLength(0);
    expect(h.lines).toStrictEqual([sendingLine(2)]);
    expectCounters(h, 1);
  });

  it('signal already aborted when the first attempt hits the rate limit: interrupted, no wait', async () => {
    await seedSynthetic(301);
    const controller = new AbortController();
    controller.abort();
    const h = harness({ responder: () => fail(rateLimitError()), signal: controller.signal });
    expect(await send(h.ctx, itemsOf(301))).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'interrupted' },
    });
    expect(h.service.calls).toHaveLength(1);
    expect(h.clock.sleeps).toHaveLength(0);
    expectCounters(h, 1);
  });

  it('abort during the retry wait: stopped interrupted, no second request', async () => {
    await seedSynthetic(301, 302);
    const controller = new AbortController();
    const h = harness({
      responder: byAttempt(fail(connectionError()), NORMAL),
      signal: controller.signal,
      onSleep: () => {
        controller.abort();
      },
    });
    expect(await send(h.ctx, itemsOf(301, 302))).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'interrupted' },
    });
    expect(h.service.calls).toHaveLength(1);
    expect(h.clock.sleeps).toHaveLength(1);
    expect(await recordOf(301)).toBeUndefined();
    expect(await recordOf(302)).toBeUndefined();
    expectCounters(h, 1);
  });

  it('a normal answer is kept even when the signal is aborted (the in-flight Batch is kept in full)', async () => {
    await seedSynthetic(301);
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(await send(h.ctx, itemsOf(301))).toStrictEqual({ kind: 'kept', tokens: 10 });
    expect(await recordOf(301)).toBeDefined();
    expectCounters(h, 1);
  });
});

// ---------------------------------------------------------------------------
// 11. A synchronous throw is classified like a rejection
// ---------------------------------------------------------------------------

/** An Embedding Service whose `embed` throws synchronously (no Promise rejection). */
function throwingService(error: Error): EmbeddingService & { readonly count: () => number } {
  let calls = 0;
  return {
    count: () => calls,
    embed(): Promise<unknown> {
      calls += 1;
      throw error;
    },
  };
}

describe('sendBatch: synchronous throw', () => {
  it('a sync rate limit with the signal aborted: stopped interrupted after 1 call', async () => {
    await seedSynthetic(301);
    const controller = new AbortController();
    controller.abort();
    const service = throwingService(rateLimitError());
    const h = harness({ service, signal: controller.signal });
    expect(await send(h.ctx, itemsOf(301))).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'interrupted' },
    });
    expect(service.count()).toBe(1);
    expect(h.clock.sleeps).toHaveLength(0);
    expectCounters(h, service.count());
  });

  it('a sync refused error: stopped failed with the refused message after 1 call', async () => {
    await seedSynthetic(301);
    const error = refusedError();
    const service = throwingService(error);
    const h = harness({ service });
    const stop = stopOf(await send(h.ctx, itemsOf(301)));
    expect(stop).toStrictEqual({ outcome: 'failed', message: refusedMessage(401) });
    expect(service.count()).toBe(1);
    expectNoSecretIn([stop.message ?? '', ...h.lines], error.message);
    expectCounters(h, service.count());
  });

  it('a persistent sync rate limit is retried like a rejection: 3 calls, rate_limited', async () => {
    await seedSynthetic(301);
    const service = throwingService(rateLimitError());
    const h = harness({ service });
    expect(await send(h.ctx, itemsOf(301))).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'rate_limited', message: RATE_LIMITED_MESSAGE },
    });
    expect(service.count()).toBe(3);
    expect(sleepsMs(h.clock)).toStrictEqual(WAITS_MS);
    expectCounters(h, service.count());
  });
});
