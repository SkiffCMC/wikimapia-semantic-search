/**
 * AL2 unit tests: the Embedding Run, `runEmbedding` (`src/embed/run-embedding.ts`), against the
 * Test Database.
 *
 * Design refs: AL4 embeddings 1.2 (Run flow), 1.4.2 (scan-and-send loop and its rules), 1.4.7
 * (counts, report, progress lines), 1.5 (transaction boundaries), section 3 (idempotency and
 * resumability), U6 "Unit tests must cover", section 5 (close every pool, no secrets). AL3
 * routing 20261023-embeddings-06-run, section 2.1, cases 1 .. 12. A small subset of
 * `contracts/embeddings.test.ts` (the full net, which cannot load before U7).
 *
 * Real Embedding Store, Place Store and Schema Setup; the Embedding Service and the clock are the
 * contract's Simulated ones. Every `runEmbedding` call goes through `startEmbed` / `embed`, which
 * always inject `embeddingService`: the real Voyage adapter is never built. Global `fetch` is a
 * rejecting spy. Synthetic key `TEST_VOYAGE_API_KEY` only. Test Database only
 * (`requireTestDatabaseUrl()`). Vectors come only from `fakeEmbedding` (no vector literal).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { buildPlaceDocument } from '../../src/embed/place-document';
import { runEmbedding } from '../../src/embed/run-embedding';
import {
  DEFAULT_EMBEDDING_LIMIT,
  EMBEDDING_MODEL,
  EMBEDDING_OUTCOME_LABELS,
  EMBED_SUMMARY_LABELS,
  EmbeddingRunReportSchema,
  EmbeddingServiceRequestSchema,
  EmbeddingStoreCountsResultSchema,
  FAILED_PLACE_LABELS,
  ReadEmbeddingRecordResultSchema,
  SaveEmbeddingRecordsResultSchema,
  VOYAGE_API_KEY_ENV,
  ZERO_EMBEDDING_COUNTS,
  documentFingerprint,
  estimateDocumentTokens,
} from '../../contracts/embeddings.schema';
import type {
  EmbeddingRecord,
  EmbeddingRunOutcome,
  EmbeddingRunReport,
  EmbeddingRunRequest,
  EmbeddingStore,
  EmbeddingStoreCounts,
  RunEmbeddingFn,
} from '../../contracts/embeddings.schema';
import {
  NORMAL,
  ServiceGate,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  TEST_VOYAGE_API_KEY,
  fail,
  fakeEmbedding,
  holdsPlace,
  normal,
  raw,
  rateLimitError,
  refusedError,
  syntheticDetails,
  syntheticName,
} from '../../contracts/embeddings.support';
import type { ServiceResponder } from '../../contracts/embeddings.support';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  buildWikimapiaLink,
} from '../../contracts/storage.schema';
import type {
  DetailedPlace,
  PlaceStore,
  SchemaSetup,
  StoreFailure,
  WriteHook,
} from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  LATER_FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  at,
  listingOf,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import type { PlaceDetails, PlaceSummary } from '../../contracts/wikimapia-client.schema';

// Compile-time check: the entry point has the contract's signature.
const run: RunEmbeddingFn = runEmbedding;

const BULK_TIMEOUT_MS = 180_000;
const POOL_LOOP_TIMEOUT_MS = 120_000;
const UNREACHABLE_TIMEOUT_MS = 60_000;
const RATE_LIMITED_MESSAGE =
  'The Embedding Service kept answering with its rate limit after 3 tries.';
const HOOK_TEXT = `hook ${TEST_VOYAGE_API_KEY}`;
const INVALID_EMPTY_ANSWER = raw({ data: [], usage: { totalTokens: 0 } });
const STOPPING = 'Stopping:';

// ---------------------------------------------------------------------------
// Lifecycle: Test Database migrated once, emptied before every test
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;
const knexes: Knex[] = [];
const fetchSpy = vi.fn((input: unknown) =>
  Promise.reject(new Error(`network is disabled in run-embedding tests: ${String(input)}`)),
);

/** The test's own Knex handle, used only for the `pg_stat_activity` count (case 10). */
function testDb(): Knex {
  const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
  knexes.push(db);
  return db;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect(SchemaStepsResultSchema.parse(await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
  embeddings = createEmbeddingStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterEach(async () => {
  for (const db of knexes.splice(0)) await destroyQuietly(db);
});

afterAll(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  await embeddings.close();
  await places.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers (every result is parsed with its contract schema before use)
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

async function saveDetails(details: PlaceDetails, fetchedAt: string = FETCHED_AT): Promise<void> {
  okValue(SaveResultSchema.parse(await places.savePlaceDetails({ details, fetchedAt })));
}

async function seedSynthetic(...ids: number[]): Promise<void> {
  for (const id of ids) await saveDetails(await syntheticDetails(id));
}

/** Synthetic Places `first` .. `first + count - 1` from one template (fast seeding). */
async function seedManySynthetic(first: number, count: number): Promise<void> {
  const template = await syntheticDetails(first);
  for (let id = first; id < first + count; id += 1) {
    await saveDetails({
      ...template,
      placeId: id,
      title: syntheticName(id),
      description: `Synthetic description ${String(id)}.`,
    });
  }
}

/** A synthetic Place Summary (Listing Save only: the Place stays Summary-Only). */
function syntheticSummary(placeId: number): PlaceSummary {
  const lon = 20.457;
  const lat = 44.817;
  return {
    placeId,
    name: syntheticName(placeId),
    url: buildWikimapiaLink(placeId),
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

async function seedSummaryOnly(...ids: number[]): Promise<void> {
  okValue(
    SaveResultSchema.parse(await places.saveListingPage(listingOf(...ids.map(syntheticSummary)))),
  );
}

async function readDetailed(placeId: number): Promise<DetailedPlace> {
  const value = okValue(ReadPlaceResultSchema.parse(await places.readPlace({ placeId })));
  if (!value.found || value.place.status !== 'detailed') {
    throw new Error(`place ${String(placeId)} is not a stored Detailed Place`);
  }
  return value.place;
}

async function documentOf(placeId: number): Promise<string> {
  return buildPlaceDocument(await readDetailed(placeId));
}

/** A Batch Token Limit that fits exactly `n` Place Documents of the size of `document`. */
function limitFor(document: string, n: number): number {
  return estimateDocumentTokens(document) * n;
}

async function recordOf(placeId: number): Promise<EmbeddingRecord | undefined> {
  const value = okValue(
    ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId })),
  );
  return value.found ? value.record : undefined;
}

async function embedCounts(): Promise<EmbeddingStoreCounts> {
  return okValue(EmbeddingStoreCountsResultSchema.parse(await embeddings.countEmbeddingStore()));
}

/** Keeps a `voyage-4` record whose fingerprint matches the Place's current document (Unchanged). */
async function keepCurrentRecord(placeId: number): Promise<EmbeddingRecord> {
  const document = await documentOf(placeId);
  const record: EmbeddingRecord = {
    placeId,
    embedding: fakeEmbedding(`old ${document}`),
    model: EMBEDDING_MODEL,
    documentFingerprint: documentFingerprint(document),
    embeddedAt: '2026-10-01T00:00:00Z',
  };
  okValue(
    SaveEmbeddingRecordsResultSchema.parse(
      await embeddings.saveEmbeddingRecords({ records: [record] }),
    ),
  );
  return record;
}

/** Expects the complete record this Run would keep for `placeId` from a normal answer. */
async function expectFreshRecord(placeId: number): Promise<void> {
  const document = await documentOf(placeId);
  const record = await recordOf(placeId);
  expect(record).toBeDefined();
  expect(record?.model).toBe(EMBEDDING_MODEL);
  expect(record?.documentFingerprint).toBe(documentFingerprint(document));
  expect(record?.embedding).toStrictEqual(fakeEmbedding(document));
}

function firstLines(texts: readonly string[]): string[] {
  return texts.map((t) => t.split('\n')[0] ?? '');
}

interface EmbedSetup {
  request?: EmbeddingRunRequest;
  responder?: ServiceResponder;
  clock?: SimulatedEmbeddingClock;
  /** `null` = no key at all. */
  apiKey?: string | null;
  signal?: AbortSignal;
  onWrite?: WriteHook;
  batchTokenLimit?: number;
  connectionString?: string;
}

/** Starts one Run. Always injects the Simulated Embedding Service (never the Voyage adapter). */
function startEmbed(s: EmbedSetup = {}) {
  const clock = s.clock ?? new SimulatedEmbeddingClock();
  const service = new SimulatedEmbeddingService(clock, s.responder);
  const progressLines: string[] = [];
  const promise = run(s.request ?? {}, {
    connectionString: s.connectionString ?? testUrl,
    embeddingService: service,
    clock,
    onProgress: (line) => {
      progressLines.push(line);
    },
    ...(s.apiKey === null ? {} : { apiKey: s.apiKey ?? TEST_VOYAGE_API_KEY }),
    ...(s.signal === undefined ? {} : { signal: s.signal }),
    ...(s.onWrite === undefined ? {} : { onWrite: s.onWrite }),
    ...(s.batchTokenLimit === undefined ? {} : { batchTokenLimit: s.batchTokenLimit }),
  });
  return { promise, service, clock, progressLines };
}

async function finish(started: ReturnType<typeof startEmbed>) {
  const report: EmbeddingRunReport = EmbeddingRunReportSchema.parse(await started.promise);
  for (const call of started.service.calls) EmbeddingServiceRequestSchema.parse(call.request);
  return { ...started, report };
}

async function embed(s: EmbedSetup = {}) {
  return finish(startEmbed(s));
}

function stoppingLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(STOPPING));
}

function stoppingLine(outcome: EmbeddingRunOutcome): string {
  return `${STOPPING} ${EMBEDDING_OUTCOME_LABELS[outcome]}`;
}

/** The lines `expected` appear in `lines` in this order (other lines may come between). */
function expectInOrder(lines: readonly string[], expected: readonly string[]): void {
  let from = 0;
  for (const line of expected) {
    const found = lines.indexOf(line, from);
    expect(found, `progress line "${line}" in order`).toBeGreaterThanOrEqual(0);
    from = found + 1;
  }
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  const password = decodeURIComponent(new URL(testUrl).password);
  if (password !== '') expect(text).not.toContain(password);
}

function everyOutput(report: EmbeddingRunReport, lines: readonly string[]): string {
  return [JSON.stringify(report), report.summaryText, ...lines].join('\n');
}

function expectBeforeStartReport(report: EmbeddingRunReport): void {
  expect(report.outcome).toBe('failed');
  expect(report.summary.counts).toStrictEqual(ZERO_EMBEDDING_COUNTS);
  expect(report.failedPlaces).toStrictEqual([]);
}

const ActivityCountSchema = z.array(z.strictObject({ n: z.coerce.number().int().nonnegative() }));

/** Connections of the Test Database as Postgres sees them. */
async function connectionCount(db: Knex): Promise<number> {
  const rows = ActivityCountSchema.parse(
    await db('pg_stat_activity').where('datname', db.raw('current_database()')).count({ n: '*' }),
  );
  return at(rows, 0).n;
}

async function realPause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Three due Places 301 .. 303 and a Batch Token Limit of one Place Document per Batch. */
async function threeOnePerBatch(): Promise<number> {
  await seedSynthetic(301, 302, 303);
  return limitFor(await documentOf(301), 1);
}

// ===========================================================================
// 1. Counts are exact (AC-47 pattern, 1.4.7)
// ===========================================================================

describe('1. Counts are exact', () => {
  it('2 due kept (40 tokens), 1 invalid, 1 Unchanged, 1 Summary-Only: exact counts and progress lines', async () => {
    await seedSummaryOnly(5001);
    await seedSynthetic(301, 302, 303, 304);
    await keepCurrentRecord(304);
    const d301 = await documentOf(301);
    const d302 = await documentOf(302);
    const d303 = await documentOf(303);

    const { report, service, progressLines } = await embed({
      batchTokenLimit: limitFor(d301, 2),
      responder: (call) =>
        call.request.input.includes(d303) ? INVALID_EMPTY_ANSWER : normal(40),
    });

    expect(service.inputs).toStrictEqual([[d301, d302], [d303]]);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts).toStrictEqual({
      detailedPlacesConsidered: 4,
      placesEmbedded: 2,
      unchangedSkipped: 1,
      summaryOnlySkipped: 1,
      emptyDocumentsSkipped: 0,
      failedPlaces: 1,
      failedPlacesByKind: { connection: 0, invalid_answer: 1, invalid_data: 0 },
      placesStillDue: 1,
      batchesSent: 2,
      embeddingRequests: 2,
      tokensUsed: 40,
    });
    expect(report.failedPlaces.map((f) => [f.placeId, f.failureKind])).toStrictEqual([
      [303, 'invalid_answer'],
    ]);
    expect(at(report.failedPlaces, 0).message.startsWith('Place 303: ')).toBe(true);
    expectInOrder(progressLines, [
      'Embedding run started: 1 summary-only places skipped',
      'Batch 1: sending 2 places',
      'Batch 1: kept 2 embeddings (40 tokens)',
      'Batch 2: sending 1 places',
      `Batch 2: 1 failed places (${FAILED_PLACE_LABELS.invalid_answer})`,
    ]);
    expect(stoppingLines(progressLines)).toStrictEqual([]);
    await expectFreshRecord(301);
    await expectFreshRecord(302);
    expect(await recordOf(303)).toBeUndefined();
  });
});

// ===========================================================================
// 2. Embedding Limit (AC-29 .. AC-32, 1.4.2 rules)
// ===========================================================================

describe('2. Embedding Limit', () => {
  it('(a) 5 due, limit 3: Limit Reached, first 3 in 1 request, 2 still due; the next Run sends 2 and completes', async () => {
    await seedSynthetic(301, 302, 303, 304, 305);
    const first = await embed({ request: { embeddingLimit: 3 } });
    expect(first.report.outcome).toBe('limit_reached');
    expect(first.service.calls).toHaveLength(1);
    expect(firstLines(at(first.service.inputs, 0))).toStrictEqual(
      [301, 302, 303].map(syntheticName),
    );
    expect(first.report.summary.counts.placesEmbedded).toBe(3);
    expect(first.report.summary.counts.placesStillDue).toBe(2);
    expect(stoppingLines(first.progressLines)).toStrictEqual([]);
    for (const id of [301, 302, 303]) await expectFreshRecord(id);
    expect(await recordOf(304)).toBeUndefined();

    const second = await embed();
    expect(second.service.calls).toHaveLength(1);
    expect(firstLines(at(second.service.inputs, 0))).toStrictEqual([304, 305].map(syntheticName));
    expect(second.report.outcome).toBe('completed');
    expect(second.report.summary.counts.unchangedSkipped).toBe(3);
  });

  it('(b) exactly 3 due with limit 3: Completed, not Limit Reached', async () => {
    await seedSynthetic(301, 302, 303);
    const { report, service } = await embed({ request: { embeddingLimit: 3 } });
    expect(service.texts).toHaveLength(3);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.placesStillDue).toBe(0);
  });

  it('(c) Failed Places count towards the limit: limit 3, first Batch of 3 invalid, a 4th due: 1 request, Limit Reached', async () => {
    await seedSynthetic(301, 302, 303, 304);
    const { report, service } = await embed({
      request: { embeddingLimit: 3 },
      responder: () => INVALID_EMPTY_ANSWER,
    });
    expect(service.calls).toHaveLength(1);
    expect(at(service.calls, 0).request.input).toHaveLength(3);
    expect(report.summary.counts.failedPlaces).toBe(3);
    expect(report.summary.counts.placesStillDue).toBe(4);
    expect(report.outcome).toBe('limit_reached');
  });

  it('(d) Unchanged Places do not use up the limit: 2 Unchanged and 2 due with limit 2 give Completed, 2 embedded', async () => {
    await seedSynthetic(301, 302);
    expect((await embed()).report.outcome).toBe('completed');
    await seedSynthetic(303, 304);
    const { report, service } = await embed({ request: { embeddingLimit: 2 } });
    expect(firstLines(service.texts)).toStrictEqual([303, 304].map(syntheticName));
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.placesEmbedded).toBe(2);
    expect(report.summary.counts.unchangedSkipped).toBe(2);
  });
});

// ===========================================================================
// 3. Pages and the default limit (1.4.2, AC-27)
// ===========================================================================

describe('3. Pages and the default limit', () => {
  const FIRST = 20_001;
  const COUNT = DEFAULT_EMBEDDING_LIMIT + 1;

  it(
    '(a) 1,001 small Places with the default limit: 1 request of 1,000, Limit Reached, 1 still due, 1,001 considered',
    async () => {
      await seedManySynthetic(FIRST, COUNT);
      const { report, service } = await embed();
      expect(report.outcome).toBe('limit_reached');
      expect(service.calls).toHaveLength(1);
      expect(at(service.calls, 0).request.input).toHaveLength(DEFAULT_EMBEDDING_LIMIT);
      expect(report.summary.counts.placesEmbedded).toBe(DEFAULT_EMBEDDING_LIMIT);
      expect(report.summary.counts.placesStillDue).toBe(1);
      expect(report.summary.counts.detailedPlacesConsidered).toBe(COUNT);
      expect(await recordOf(FIRST + COUNT - 1)).toBeUndefined();
    },
    BULK_TIMEOUT_MS,
  );

  it(
    '(b) a Batch open at a page boundary is not closed by it: the last of page 1 and the first of page 2 go in 1 request',
    async () => {
      await seedManySynthetic(FIRST, COUNT);
      const all = await embed({ request: { embeddingLimit: 2000 } });
      expect(all.report.outcome).toBe('completed');
      expect((await embedCounts()).embeddingRecords).toBe(COUNT);

      const lastOfPage1 = FIRST + DEFAULT_EMBEDDING_LIMIT - 1;
      const firstOfPage2 = FIRST + DEFAULT_EMBEDDING_LIMIT;
      const template = await syntheticDetails(FIRST);
      for (const id of [lastOfPage1, firstOfPage2]) {
        await saveDetails(
          {
            ...template,
            placeId: id,
            title: syntheticName(id),
            description: `Changed synthetic description ${String(id)}.`,
          },
          LATER_FETCHED_AT,
        );
      }
      const expected = [await documentOf(lastOfPage1), await documentOf(firstOfPage2)];

      const next = await embed();
      expect(next.service.calls).toHaveLength(1);
      expect(next.service.inputs).toStrictEqual([expected]);
      expect(next.report.outcome).toBe('completed');
      expect(next.report.summary.counts.unchangedSkipped).toBe(COUNT - 2);
      expect(next.report.summary.counts.placesEmbedded).toBe(2);
    },
    BULK_TIMEOUT_MS,
  );
});

// ===========================================================================
// 4. Persistent rate limit on Batch 2 of 3 (AC-36, approved decision 1)
// ===========================================================================

describe('4. Persistent rate limit on Batch 2 of 3', () => {
  it('Rate Limited with the sendBatch message; 4 requests, none for Place 303; Batch 1 kept; 2 still due', async () => {
    const tokenLimit = await threeOnePerBatch();
    const limited = syntheticName(302);
    const { report, service, progressLines } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => (holdsPlace(call, limited) ? fail(rateLimitError()) : NORMAL),
    });
    expect(report.outcome).toBe('rate_limited');
    expect(report.message).toBe(RATE_LIMITED_MESSAGE);
    expect(service.calls).toHaveLength(4);
    expect(service.calls.filter((c) => holdsPlace(c, limited))).toHaveLength(3);
    expect(service.calls.some((c) => holdsPlace(c, syntheticName(303)))).toBe(false);
    await expectFreshRecord(301);
    expect(await recordOf(302)).toBeUndefined();
    expect(await recordOf(303)).toBeUndefined();
    expect(report.summary.counts.placesStillDue).toBe(2);
    expect(report.summary.counts.failedPlaces).toBe(0);
    expect(report.summary.counts.detailedPlacesConsidered).toBe(3);
    expect(stoppingLines(progressLines)).toStrictEqual([stoppingLine('rate_limited')]);
  });
});

// ===========================================================================
// 5. Refused on Batch 2 (AC-37)
// ===========================================================================

describe('5. Refused on Batch 2', () => {
  it('Failed saying the service refused; 2 requests; Batch 1 kept; 2 still due; full counts; Stopping printed once', async () => {
    const tokenLimit = await threeOnePerBatch();
    const { report, service, progressLines } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => (call.index === 1 ? fail(refusedError()) : NORMAL),
    });
    expect(report.outcome).toBe('failed');
    expect(report.message).toMatch(/Embedding Service refused/i);
    expect(service.calls).toHaveLength(2);
    await expectFreshRecord(301);
    expect(await recordOf(302)).toBeUndefined();
    expect(await recordOf(303)).toBeUndefined();
    expect(report.summary.counts.placesStillDue).toBe(2);
    expect(report.summary.counts.detailedPlacesConsidered).toBe(3);
    expect(report.summary.counts.failedPlaces).toBe(0);
    expect(stoppingLines(progressLines)).toStrictEqual([stoppingLine('failed')]);
  });
});

// ===========================================================================
// 6. Store failure while keeping Batch 2 (AC-42 second case, AC-45)
// ===========================================================================

describe('6. Store failure while keeping Batch 2', () => {
  it('Failed after exactly 2 requests; Batch 1 kept, 302 and 303 not; no hook text or key in the output', async () => {
    const tokenLimit = await threeOnePerBatch();
    const seen: { service?: SimulatedEmbeddingService } = {};
    const started = startEmbed({
      batchTokenLimit: tokenLimit,
      onWrite: () => {
        if ((seen.service?.calls.length ?? 0) >= 2) throw new Error(HOOK_TEXT);
      },
    });
    seen.service = started.service;
    const { report, service, progressLines } = await finish(started);
    expect(report.outcome).toBe('failed');
    expect(service.calls).toHaveLength(2);
    await expectFreshRecord(301);
    expect(await recordOf(302)).toBeUndefined();
    expect(await recordOf(303)).toBeUndefined();
    const output = everyOutput(report, progressLines);
    expect(output).not.toContain(HOOK_TEXT);
    expectNoSecrets(output);
  });
});

// ===========================================================================
// 7. Interrupt (AC-43, AC-44)
// ===========================================================================

describe('7. Interrupt', () => {
  it(
    '(a) already aborted at the start, unreachable database: Interrupted (no store opened), 0 requests, zero counts, startedAt = endedAt',
    async () => {
      const controller = new AbortController();
      controller.abort();
      const { report, service } = await embed({
        signal: controller.signal,
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expect(report.outcome).toBe('interrupted');
      expect(service.calls).toHaveLength(0);
      expect(report.summary.counts).toStrictEqual(ZERO_EMBEDDING_COUNTS);
      expect(report.failedPlaces).toStrictEqual([]);
      expect(report.summary.startedAt).toBe(report.summary.endedAt);
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it('(b) aborted during Batch 2: 2 requests, Interrupted, 301 kept, 302 whole or absent, 303 absent; the next Run continues', async () => {
    const tokenLimit = await threeOnePerBatch();
    const controller = new AbortController();
    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      signal: controller.signal,
      responder: (call) =>
        call.index === 1
          ? {
              effect: () => {
                controller.abort();
              },
              then: NORMAL,
            }
          : NORMAL,
    });
    expect(service.calls).toHaveLength(2);
    expect(report.outcome).toBe('interrupted');
    await expectFreshRecord(301);
    const second = await recordOf(302);
    if (second !== undefined) await expectFreshRecord(302);
    expect(await recordOf(303)).toBeUndefined();

    const next = await embed({ batchTokenLimit: tokenLimit });
    const expected = second === undefined ? [302, 303] : [303];
    expect(firstLines(next.service.texts)).toStrictEqual(expected.map(syntheticName));
    expect(next.report.outcome).toBe('completed');
  });

  it('(c) a Run stuck in Batch 2 blocks nothing: a concurrent Run sends 302 and 303; the stuck Run still reports', async () => {
    const tokenLimit = await threeOnePerBatch();
    const gate = new ServiceGate();
    const controller = new AbortController();
    const stuck = startEmbed({
      batchTokenLimit: tokenLimit,
      signal: controller.signal,
      responder: (call) => (call.index === 1 ? { gate } : NORMAL),
    });
    await gate.reached;
    await expectFreshRecord(301);

    const fresh = await embed({
      batchTokenLimit: tokenLimit,
      clock: new SimulatedEmbeddingClock('2026-10-22T10:00:00Z'),
    });
    expect(firstLines(fresh.service.texts)).toStrictEqual([302, 303].map(syntheticName));
    expect(fresh.report.summary.counts.unchangedSkipped).toBe(1);
    expect(fresh.report.outcome).toBe('completed');

    controller.abort();
    gate.open(raw('the process was killed'));
    const stuckReport = EmbeddingRunReportSchema.parse(await stuck.promise);
    expect(stuck.service.calls).toHaveLength(2);
    expect(stuckReport.summaryText.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 8. Before-start failures (1.2 steps 1, 2, 6)
// ===========================================================================

describe('8. Before-start failures', () => {
  it(
    '(a) embeddingLimit 0 with an unreachable database: Failed naming embeddingLimit, 0 requests',
    async () => {
      const { report, service } = await embed({
        request: { embeddingLimit: 0 },
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expectBeforeStartReport(report);
      expect(report.message).toContain('embeddingLimit');
      expect(service.calls).toHaveLength(0);
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it(
    '(a) settings are checked before the key: an invalid limit and no key names embeddingLimit',
    async () => {
      const { report, service } = await embed({
        request: { embeddingLimit: 0 },
        apiKey: null,
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expectBeforeStartReport(report);
      expect(report.message).toContain('embeddingLimit');
      expect(report.message).not.toContain(VOYAGE_API_KEY_ENV);
      expect(service.calls).toHaveLength(0);
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it('(b) batchTokenLimit 0: Failed naming batchTokenLimit, 0 requests, nothing kept', async () => {
    await seedSynthetic(301);
    const { report, service } = await embed({ batchTokenLimit: 0 });
    expectBeforeStartReport(report);
    expect(report.message).toContain('batchTokenLimit');
    expect(service.calls).toHaveLength(0);
    expect(await recordOf(301)).toBeUndefined();
  });

  it.each([
    ['no key', null],
    ['a blank key', '   '],
  ] as const)(
    '(c) %s with an injected service and an unreachable database: Failed naming VOYAGE_API_KEY, 0 requests',
    async (_, apiKey) => {
      const { report, service } = await embed({
        apiKey,
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expectBeforeStartReport(report);
      expect(report.message).toContain(VOYAGE_API_KEY_ENV);
      expect(service.calls).toHaveLength(0);
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it(
    '(d) a valid key and an unreachable database: Failed, 0 requests, summary shown, no secrets',
    async () => {
      const { report, service, progressLines } = await embed({
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expectBeforeStartReport(report);
      expect(service.calls).toHaveLength(0);
      expect(report.summaryText).toContain(
        `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS.failed}`,
      );
      const output = everyOutput(report, progressLines);
      expectNoSecrets(output);
      expect(output).not.toContain(UNREACHABLE_DATABASE_URL);
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ===========================================================================
// 9. Only Summary-Only Places (AC-17)
// ===========================================================================

describe('9. Only Summary-Only Places', () => {
  it('0 requests, Completed, every Summary-Only Place counted as skipped, 0 embedded', async () => {
    await seedSummaryOnly(5001, 5002);
    const { report, service, progressLines } = await embed();
    expect(service.calls).toHaveLength(0);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.summaryOnlySkipped).toBe(2);
    expect(report.summary.counts.placesEmbedded).toBe(0);
    expect(report.summary.counts.detailedPlacesConsidered).toBe(0);
    expect(progressLines).toContain('Embedding run started: 2 summary-only places skipped');
    expect((await embedCounts()).embeddingRecords).toBe(0);
  });
});

// ===========================================================================
// 10. Pool closed (1.2 step 5, AL4 5 "Close every pool")
// ===========================================================================

describe('10. Pool closed', () => {
  it(
    '30 Runs over 1 seeded Place leave no open pool behind',
    async () => {
      await seedSynthetic(301);
      const db = testDb();
      const before = await connectionCount(db);
      for (let i = 0; i < 30; i += 1) {
        const { report } = await embed();
        expect(report.outcome).toBe('completed');
      }
      let after = await connectionCount(db);
      for (let tries = 0; tries < 20 && after > before + 2; tries += 1) {
        await realPause(100);
        after = await connectionCount(db);
      }
      expect(after).toBeLessThanOrEqual(before + 2);
    },
    POOL_LOOP_TIMEOUT_MS,
  );
});

// ===========================================================================
// 11. No secrets, no document text (AC-51)
// ===========================================================================

describe('11. No secrets, no document text', () => {
  it('a Run with kept, failed and stopped Batches shows no key, Bearer, password, postgres:// or Place Document text', async () => {
    await seedSynthetic(301, 302, 303, 304);
    const documents = [
      await documentOf(301),
      await documentOf(302),
      await documentOf(303),
      await documentOf(304),
    ];
    const { report, service, progressLines } = await embed({
      batchTokenLimit: limitFor(at(documents, 0), 1),
      responder: (call) => {
        if (holdsPlace(call, syntheticName(302))) return INVALID_EMPTY_ANSWER;
        if (holdsPlace(call, syntheticName(303))) return fail(refusedError());
        return NORMAL;
      },
    });
    expect(report.outcome).toBe('failed');
    expect(service.calls).toHaveLength(3);
    expect(report.summary.counts.placesEmbedded).toBe(1);
    expect(report.summary.counts.failedPlaces).toBe(1);

    const output = everyOutput(report, progressLines);
    expectNoSecrets(output);
    for (const document of documents) expect(output).not.toContain(document);
    for (const id of [301, 302, 303, 304]) expect(output).not.toContain(syntheticName(id));
  });
});

// ===========================================================================
// 12. No network
// ===========================================================================

describe('12. No network', () => {
  it('global fetch was never called by any Run in this file', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
