/**
 * AL2 unit tests: `src/crawl/run-crawl.ts` (`runCrawl`) with `src/crawl/listing-phase.ts` and
 * `src/crawl/details-phase.ts` behind it (AL4 hydration 1.2 Run flow, 1.4.5 Run start, 1.4.6
 * Listing Phase, 1.4.7 Details Phase, 1.4.8 Run end and progress lines, 1.4.9 write hook and
 * store failures). AL3 routing 20261022-hydration-06-run, section 2.1 A .. E.
 *
 * A small subset of `contracts/hydration.test.ts` (the full net, which cannot load before U7).
 * Runs against the Test Database (`requireTestDatabaseUrl()`), with the contract doubles
 * `SimulatedCrawlClock` and `CrawlWikimapia` (scripted answers, recorded fixtures through the
 * support helpers), `testConfiguration(...)` and `TEST_API_KEY`. Global `fetch` is a rejecting
 * spy: nothing reaches the network. Every report is parsed with `RunReportSchema`. State is read
 * only through the public stores (`createCrawlStore`, `createPlaceStore`); the single exception
 * is the `pg_stat_activity` count of group E, read through the test's own `testDb()` handle.
 *
 * Extended by feature `crawl-run1-fixes` (AL4 crawl-run1-fixes 1.2, 1.4.3, 1.4.4, 1.4.6, 1.4.7;
 * AL3 routing 20261022-crawl-run1-fixes-06-run, section 2.1 A .. E): groups F .. J cover Failure
 * Records, Parking, the Explicit Retry, the Dry Run with `retryParked` and the Key Quota Run.
 * Failure Records and Explicit Retries are read only through `createCrawlStore(...)`
 * (`readFailureRecords`, `readExplicitRetries`). Routing case F (the `regionTotals` fallback) is
 * not covered: it cannot be provoked through the public harness without stubbing production code.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { MISSING_API_KEY_MESSAGE } from '../../src/crawl/config';
import { runCrawl } from '../../src/crawl/run-crawl';
import { planTiles } from '../../src/crawl/tile-plan';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import {
  ExplicitRetriesResultSchema,
  FailureRecordsResultSchema,
  PARKING_THRESHOLD,
  type CreateFailureAwareCrawlStoreFn,
  type ExplicitRetry,
  type FailureRecord,
  type FailureRecordsInput,
} from '../../contracts/crawl-run1-fixes.schema';
import {
  ABANDONMENT_AGE_SECONDS,
  CrawlProgressResultSchema,
  ITEM_FAILURE_LABELS,
  OUTCOME_LABELS,
  RunReportSchema,
  SUMMARY_LABELS,
  TilePlanSchema,
  ZERO_RUN_COUNTS,
  toMoment,
  type CrawlConfiguration,
  type CrawlProgressView,
  type CrawlRequest,
  type Region,
  type RunCounts,
  type RunCrawlFn,
  type RunReport,
  type Tile,
} from '../../contracts/hydration.schema';
import {
  CENTRAL_BELGRADE_POINT,
  CrawlWikimapia,
  DAY,
  Gate,
  HOUR,
  REGION_FAR,
  REGION_T1,
  REGION_T2,
  REGION_T4,
  RUN_START,
  SECOND,
  SMALL_BBOX,
  SimulatedCrawlClock,
  T1_TILES,
  T2_TILES,
  T4_TILES,
  FAR_TILES,
  TEST_API_KEY,
  UNREACHABLE,
  at,
  belgradePage1,
  detailsAnswer,
  listingAnswer,
  rateLimitAnswer,
  rateLimitForever,
  scripted,
  syntheticBoxPlace,
  syntheticDetailsAnswer,
  syntheticPlacesIn,
  testConfiguration,
  tileNumberOf,
  unexpectedAnswer,
  wikimapiaErrorAnswer,
  type Responder,
  type Script,
  type WikimapiaCall,
} from '../../contracts/hydration.support';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
  type StoredPlace,
  type WriteHook,
} from '../../contracts/storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import type { PlaceSummary } from '../../contracts/wikimapia-client.schema';
import { keyQuotaAnswer } from '../../contracts/wikimapia-client.support';

// Compile-time check: the entry point has the contract's signature.
const run: RunCrawlFn = runCrawl;
const createFailureAwareCrawlStore: CreateFailureAwareCrawlStoreFn = createCrawlStore;

const T0 = Date.parse(RUN_START);
const UNREACHABLE_TIMEOUT_MS = 60_000;
const FAILURE_LOOP_TIMEOUT_MS = 180_000;
const POOL_LOOP_TIMEOUT_MS = 120_000;
const MAX_FAIL_AT = 80;

const EMPTY_COUNTS = { places: 0, comments: 0, tags: 0, placeTagLinks: 0 };
const TEST_REGION_NAMES = [REGION_T1.name, REGION_T2.name, REGION_T4.name, REGION_FAR.name];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let placeStore: PlaceStore;
let crawlStore: ReturnType<CreateFailureAwareCrawlStoreFn>;
const knexes: Knex[] = [];
const fetchSpy = vi.fn((input: unknown) =>
  Promise.reject(new Error(`network is disabled in run-crawl tests: ${String(input)}`)),
);

/** The test's own Knex handle, used only for the `pg_stat_activity` count (group E). */
function testDb(): Knex {
  const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
  knexes.push(db);
  return db;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  expect(applied.ok).toBe(true);
  placeStore = createPlaceStore({ connectionString: testUrl });
  crawlStore = createFailureAwareCrawlStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  await emptyAll();
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
});

afterAll(async () => {
  for (const db of knexes.splice(0)) await destroyQuietly(db);
  await crawlStore.close();
  await placeStore.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers (public APIs only; every result parsed with its contract schema)
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

async function emptyAll(): Promise<void> {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
}

async function progress(regionName: string): Promise<CrawlProgressView> {
  return okValue(
    CrawlProgressResultSchema.parse(await crawlStore.readCrawlProgress({ regionName })),
  );
}

async function storedCounts() {
  return okValue(StoreCountsResultSchema.parse(await placeStore.countStored()));
}

async function read(placeId: number): Promise<StoredPlace | undefined> {
  const value = okValue(ReadPlaceResultSchema.parse(await placeStore.readPlace({ placeId })));
  return value.found ? value.place : undefined;
}

async function expectDatabaseUntouched(): Promise<void> {
  expect(await storedCounts()).toStrictEqual(EMPTY_COUNTS);
  for (const regionName of TEST_REGION_NAMES) {
    expect(await progress(regionName)).toStrictEqual({ regionName, passes: [], runs: [] });
  }
}

function counts0(overrides: Partial<RunCounts>): RunCounts {
  return { ...ZERO_RUN_COUNTS, ...overrides };
}

interface CrawlSetup {
  request: CrawlRequest;
  responder?: Responder;
  configuration?: CrawlConfiguration;
  clock?: SimulatedCrawlClock;
  /** `null` = no API Key at all. */
  apiKey?: string | null;
  signal?: AbortSignal;
  onWrite?: WriteHook;
  connectionString?: string;
}

function startCrawl(s: CrawlSetup) {
  const clock = s.clock ?? new SimulatedCrawlClock();
  const wikimapia = new CrawlWikimapia(clock, s.responder ?? scripted({ tiles: [] }));
  const progressLines: string[] = [];
  const promise = run(s.request, {
    connectionString: s.connectionString ?? testUrl,
    transport: wikimapia.transport,
    clock,
    configuration: s.configuration ?? testConfiguration(),
    onProgress: (line) => {
      progressLines.push(line);
    },
    ...(s.apiKey === null ? {} : { apiKey: s.apiKey ?? TEST_API_KEY }),
    ...(s.signal === undefined ? {} : { signal: s.signal }),
    ...(s.onWrite === undefined ? {} : { onWrite: s.onWrite }),
  });
  return { promise, wikimapia, clock, progressLines };
}

async function crawl(s: CrawlSetup) {
  const started = startCrawl(s);
  const report: RunReport = RunReportSchema.parse(await started.promise);
  return { ...started, report };
}

function tilesOf(region: Region): readonly Tile[] {
  if (region === REGION_T1) return T1_TILES;
  if (region === REGION_T2) return T2_TILES;
  if (region === REGION_T4) return T4_TILES;
  if (region === REGION_FAR) return FAR_TILES;
  throw new Error(`no expected tiles for ${region.name}`);
}

/** Run one Region with a script (tiles default to the Region's expected Tile Plan). */
function crawlRegion(
  region: Region,
  script: Omit<Script, 'tiles'> & { tiles?: readonly Tile[] },
  extra: Omit<CrawlSetup, 'request' | 'responder'> & {
    request?: Omit<CrawlRequest, 'regionName'>;
  } = {},
) {
  const tiles = script.tiles ?? tilesOf(region);
  const { request, ...rest } = extra;
  return crawl({
    request: { regionName: region.name, ...request },
    responder: scripted({ ...script, tiles }),
    ...rest,
  });
}

function listingPages(calls: readonly WikimapiaCall[], tiles: readonly Tile[]): string[] {
  return calls
    .filter((c) => c.fn === 'box')
    .map((c) => `tile ${String(tileNumberOf(tiles, c.bbox))} page ${String(c.page)}`);
}

function finishedPageKeys(view: CrawlProgressView, passIndex = 0): string[] {
  const pass = view.passes[passIndex];
  return (pass?.finishedPages ?? []).map(
    (p) => `tile ${String(p.tileNumber)} page ${String(p.page)}`,
  );
}

/** A synthetic `box` answer with `places` summaries (ids from `firstId`) echoing page size 3. */
function fullPage(firstId: number, places = 3) {
  return listingAnswer(syntheticPlacesIn(SMALL_BBOX, places, firstId), 1, 3);
}

/** The AL6 AC-51 scenario: recorded page, 1381893 ok, 62587 after a 7 s wait, 164369 error. */
function exactScenario(): Responder {
  return scripted({
    tiles: T1_TILES,
    listing: { 1: [belgradePage1()] },
    details: {
      1381893: detailsAnswer('getbyid-1381893.json'),
      62587: [rateLimitAnswer(7), detailsAnswer('getbyid-62587.json')],
      164369: wikimapiaErrorAnswer(),
    },
  });
}

const AC51_COUNTS: RunCounts = counts0({
  wikimapiaRequests: 5,
  listingRequests: 1,
  detailsRequests: 4,
  rateLimitWaits: 1,
  rateLimitWaitSeconds: 7,
  listingPagesSaved: 1,
  tilesFinished: 1,
  tilesUnfinished: 0,
  placesListed: 3,
  placesNewlyStored: 3,
  detailsSaved: 2,
  detailsChanged: 2,
  placesStillDue: 1,
  itemFailures: 1,
  itemFailuresByKind: { ...ZERO_RUN_COUNTS.itemFailuresByKind, wikimapia_error: 1 },
});

/** The paging scenario of AC-12: pages of 3, 3 and 1 Places with Listing Page Size 3. */
const PAGING_CONFIGURATION = testConfiguration({ listingPageSize: 3 });
const PAGING_SCRIPT = { listing: { 1: [fullPage(9100), fullPage(9200), fullPage(9300, 1)] } };
const PAGE_FIRST_IDS: Readonly<Record<number, number>> = { 1: 9100, 2: 9200, 3: 9300 };

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toMatch(/[?&]key=/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
}

const ActivityCountSchema = z.array(z.strictObject({ n: z.coerce.number().int().nonnegative() }));

/** Connections of the Test Database as Postgres sees them. */
async function connectionCount(db: Knex): Promise<number> {
  const rows = ActivityCountSchema.parse(
    await db('pg_stat_activity')
      .where('datname', db.raw('current_database()'))
      .count({ n: '*' }),
  );
  return at(rows, 0).n;
}

async function realPause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ===========================================================================
// A. Pre-start paths (AL4 1.2 steps 1 to 3; AC-5 .. AC-10, AC-48, AC-60)
// ===========================================================================

describe('A. Pre-start paths', () => {
  it('A1: an unknown Region fails naming it and the known Regions; no runId, no call, no Crawl Progress', async () => {
    const { report, wikimapia } = await crawl({ request: { regionName: 'nowhere' } });
    expect(report.outcome).toBe('failed');
    expect(report.message).toContain('nowhere');
    for (const name of TEST_REGION_NAMES) expect(report.message).toContain(name);
    expect(report.runId).toBeUndefined();
    expect(report.summary.regionName).toBe('nowhere');
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched();
  });

  for (const [label, request] of [
    ['absent', {}],
    ['blank', { regionName: '   ' }],
  ] as const) {
    it(`A2: a ${label} regionName fails with a usage message naming --region and no summary Region`, async () => {
      const { report, wikimapia } = await crawl({ request });
      expect(report.outcome).toBe('failed');
      expect(report.message).toContain('--region');
      expect(report.summary.regionName).toBeUndefined();
      expect(report.runId).toBeUndefined();
      expect(wikimapia.calls).toHaveLength(0);
      await expectDatabaseUntouched();
    });
  }

  it('A3: an invalid override (requestBudget -3) fails naming requestBudget; the database is untouched', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T1.name, requestBudget: -3 },
    });
    expect(report.outcome).toBe('failed');
    expect(report.message).toContain('requestBudget');
    expect(report.runId).toBeUndefined();
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched();
  });

  it('A4: a Dry Run needs neither database nor key: Planned with the Tile Plan, zero counts, no call', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T4.name, dryRun: true },
      connectionString: UNREACHABLE_DATABASE_URL,
      apiKey: null,
    });
    expect(report.outcome).toBe('planned');
    expect(report.plan).toStrictEqual(TilePlanSchema.parse(planTiles(REGION_T4)));
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(report.runId).toBeUndefined();
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched();
  });

  for (const [label, apiKey] of [
    ['absent', null],
    ['empty', ''],
    ['blank', ' \t '],
  ] as const) {
    it(`A5: an ${label} API key fails with exactly the missing-key message, no call, no Run Record`, async () => {
      const { report, wikimapia } = await crawl({
        request: { regionName: REGION_T1.name },
        apiKey,
      });
      expect(report.outcome).toBe('failed');
      expect(report.message).toBe(MISSING_API_KEY_MESSAGE);
      expect(report.runId).toBeUndefined();
      expect(wikimapia.calls).toHaveLength(0);
      await expectDatabaseUntouched();
    });
  }

  it(
    'A6: an unreachable store fails without runId or call, and the report shows no connection secrets',
    async () => {
      const { report, wikimapia, progressLines } = await crawl({
        request: { regionName: REGION_T1.name },
        connectionString: UNREACHABLE_DATABASE_URL,
      });
      expect(report.outcome).toBe('failed');
      expect(report.message).toBeDefined();
      expect(report.runId).toBeUndefined();
      expect(wikimapia.calls).toHaveLength(0);
      const shown = [JSON.stringify(report), report.summaryText, ...progressLines].join('\n');
      expect(shown).not.toContain('postgres://');
      expect(shown).not.toContain(UNREACHABLE_PASSWORD);
      expectNoSecrets(shown);
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ===========================================================================
// B. Start step outcomes (AL4 1.4.5; AC-24, AC-25, AC-53, AC-62, AC-69)
// ===========================================================================

describe('B. Start step outcomes', () => {
  it('B1: budget 0 ends Budget Reached with a kept Run Record and 0 requests', async () => {
    const { report, wikimapia } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      { request: { requestBudget: 0 } },
    );
    expect(report.outcome).toBe('budget_reached');
    expect(report.runId).toBeDefined();
    expect(wikimapia.calls).toHaveLength(0);
    expect(report.summary.counts.wikimapiaRequests).toBe(0);
    const runs = (await progress(REGION_T1.name)).runs;
    expect(runs.map((r) => [r.runId, r.status])).toStrictEqual([[report.runId, 'budget_reached']]);
    expect(await storedCounts()).toStrictEqual(EMPTY_COUNTS);
  });

  it('B2: a signal aborted before the start ends Interrupted, keeps the Run Record, sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const { report, wikimapia } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      { signal: controller.signal },
    );
    expect(report.outcome).toBe('interrupted');
    expect(report.runId).toBeDefined();
    expect(wikimapia.calls).toHaveLength(0);
    const runs = (await progress(REGION_T1.name)).runs;
    expect(runs.map((r) => [r.runId, r.status])).toStrictEqual([[report.runId, 'interrupted']]);
  });

  it('B3: a live Run blocks a second Run of the same Region (no call, nothing changed) but not another Region', async () => {
    const gate = new Gate();
    const first = startCrawl({
      request: { regionName: REGION_T1.name },
      responder: scripted({ tiles: T1_TILES, listing: { 1: [{ gate }] } }),
    });
    await gate.reached;
    const before = await progress(REGION_T1.name);

    const second = await crawl({
      request: { regionName: REGION_T1.name },
      responder: scripted({ tiles: T1_TILES }),
      clock: new SimulatedCrawlClock(
        first.clock.nowMilliseconds + ABANDONMENT_AGE_SECONDS * SECOND,
      ),
    });
    expect(second.report.outcome).toBe('failed');
    expect(second.report.message).toMatch(/already in progress/i);
    expect(second.report.message).toContain(REGION_T1.name);
    expect(second.report.runId).toBeUndefined();
    expect(second.wikimapia.calls).toHaveLength(0);
    expect(await progress(REGION_T1.name)).toStrictEqual(before);

    const other = await crawlRegion(REGION_FAR, {});
    expect(other.report.outcome).toBe('completed');

    gate.open(listingAnswer([]));
    const finished = RunReportSchema.parse(await first.promise);
    expect(finished.outcome).toBe('completed');
  });

  it('B4: a Run silent for longer than the Abandonment Age is taken over and marked abandoned', async () => {
    const gate = new Gate();
    const killed = new AbortController();
    const zombie = startCrawl({
      request: { regionName: REGION_T1.name },
      signal: killed.signal,
      responder: scripted({ tiles: T1_TILES, listing: { 1: [{ gate }] } }),
    });
    await gate.reached;
    const silentSince = zombie.clock.nowMilliseconds;
    const zombieRecord = at((await progress(REGION_T1.name)).runs, 0);
    expect(zombieRecord.status).toBe('in_progress');

    const takeover = await crawl({
      request: { regionName: REGION_T1.name },
      responder: scripted({ tiles: T1_TILES, listing: { 1: [belgradePage1()] } }),
      clock: new SimulatedCrawlClock(silentSince + ABANDONMENT_AGE_SECONDS * SECOND + SECOND),
    });
    expect(takeover.report.outcome).toBe('completed');
    expect(listingPages(takeover.wikimapia.calls, T1_TILES)).toStrictEqual(['tile 1 page 1']);
    expect(takeover.progressLines).toContain(
      `Marked run ${String(zombieRecord.runId)} as abandoned`,
    );
    const old = (await progress(REGION_T1.name)).runs.find((r) => r.runId === zombieRecord.runId);
    expect(old?.status).toBe('abandoned');
    expect(old?.counts).toStrictEqual(zombieRecord.counts);

    killed.abort();
    gate.open(UNREACHABLE);
    await zombie.promise;
  });

  it('B5: a changed Region definition over an incomplete pass fails with a relist hint; relist starts pass 2', async () => {
    await crawlRegion(REGION_T2, {}, { request: { requestBudget: 1 } });
    const before = await progress(REGION_T2.name);
    expect(at(before.passes, 0).complete).toBe(false);

    const changed: Region = { ...REGION_T2, tileSize: { width: 0.005, height: 0.02 } };
    const changedConfiguration = testConfiguration({ regions: [changed] });
    const refused = await crawl({
      request: { regionName: REGION_T2.name },
      configuration: changedConfiguration,
      responder: scripted({ tiles: [] }),
      clock: new SimulatedCrawlClock(T0 + DAY),
    });
    expect(refused.report.outcome).toBe('failed');
    expect(refused.report.message).toMatch(/changed/i);
    expect(refused.report.message).toMatch(/relist|new listing pass/i);
    expect(refused.report.runId).toBeUndefined();
    expect(refused.wikimapia.calls).toHaveLength(0);
    expect(await progress(REGION_T2.name)).toStrictEqual(before);

    const relisted = await crawl({
      request: { regionName: REGION_T2.name, relist: true },
      configuration: changedConfiguration,
      responder: scripted({ tiles: planTiles(changed).tiles }),
      clock: new SimulatedCrawlClock(T0 + 2 * DAY),
    });
    expect(relisted.report.outcome).toBe('completed');
    expect(at(relisted.wikimapia.calls, 0).fn).toBe('box');
    const view = await progress(REGION_T2.name);
    expect(view.passes).toHaveLength(2);
    expect(at(view.passes, 0)).toStrictEqual(at(before.passes, 0));
    expect(at(view.passes, 1).passNumber).toBe(2);
    expect(at(view.passes, 1).complete).toBe(true);
  });

  it('B6: a complete pass without relist and no Places due sends nothing and ends Completed', async () => {
    const first = await crawlRegion(REGION_T1, {
      listing: { 1: [belgradePage1()] },
      details: {
        62587: detailsAnswer('getbyid-62587.json'),
        1381893: detailsAnswer('getbyid-1381893.json'),
      },
    });
    expect(first.report.outcome).toBe('completed');
    expect(first.report.summary.counts.placesStillDue).toBe(0);

    const second = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      { clock: new SimulatedCrawlClock(T0 + DAY) },
    );
    expect(second.wikimapia.calls).toHaveLength(0);
    expect(second.report.outcome).toBe('completed');
    expect(second.report.summary.counts.wikimapiaRequests).toBe(0);
    expect(second.report.summary.counts.tilesUnfinished).toBe(0);
    expect(second.report.runId).toBeDefined();
  });
});

// ===========================================================================
// C. Phases and counts (AL4 1.4.6 .. 1.4.8; AC-11 .. AC-19, AC-28, AC-29, AC-33, AC-36, AC-51)
// ===========================================================================

describe('C. Phases and counts', () => {
  it('C1: the AC-51 scenario gives exactly its counts, Completed, and one details Item Failure', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    expect(wikimapia.calls).toHaveLength(5);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts).toStrictEqual(AC51_COUNTS);
    expect(report.summary.regionName).toBe(REGION_T1.name);
    expect(report.summary.startedAt).toBe(RUN_START);
    expect(report.itemFailures).toHaveLength(1);
    const failure = at(report.itemFailures, 0);
    expect(failure.item).toStrictEqual({ kind: 'place_details', placeId: 164369 });
    expect(failure.failureKind).toBe('wikimapia_error');
    expect(failure.message.startsWith('Place 164369: ')).toBe(true);
    expect(wikimapia.detailsIds).toStrictEqual([62587, 62587, 164369, 1381893]);

    const record = at((await progress(REGION_T1.name)).runs, 0);
    expect(record.runId).toBe(report.runId);
    expect(record.status).toBe('completed');
    expect(record.counts).toStrictEqual(report.summary.counts);
    expect(record.endedAt).toBe(report.summary.endedAt);
  });

  it('C2: paging asks pages 1, 2, 3 of tile 1, records them as Finished Pages and finishes the Tile', async () => {
    const { report, wikimapia } = await crawlRegion(REGION_T1, PAGING_SCRIPT, {
      configuration: PAGING_CONFIGURATION,
    });
    expect(listingPages(wikimapia.calls, T1_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
      'tile 1 page 3',
    ]);
    for (const c of wikimapia.listingCalls) expect(c.count).toBe(3);
    const pass = at((await progress(REGION_T1.name)).passes, 0);
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
      'tile 1 page 3',
    ]);
    expect(pass.finishedTiles).toStrictEqual([1]);
    expect(pass.complete).toBe(true);
    expect((await storedCounts()).places).toBe(7);
    expect(report.summary.counts.listingPagesSaved).toBe(3);
    expect(report.summary.counts.tilesFinished).toBe(1);
    expect(report.summary.counts.placesListed).toBe(7);
    expect(report.summary.counts.placesNewlyStored).toBe(7);
  });

  it('C3: a failed listing page is one Item Failure; the next Tile is listed and the Details Phase still runs', async () => {
    const places = syntheticPlacesIn(at(T2_TILES, 1).bbox, 2, 9601);
    const { report, wikimapia } = await crawlRegion(REGION_T2, {
      listing: { 1: [wikimapiaErrorAnswer()], 2: [listingAnswer(places)] },
    });
    expect(report.outcome).toBe('completed');
    expect(listingPages(wikimapia.calls, T2_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 2 page 1',
    ]);
    expect(report.itemFailures).toHaveLength(1);
    const failure = at(report.itemFailures, 0);
    expect(failure.item).toStrictEqual({ kind: 'listing_page', tileNumber: 1, page: 1 });
    expect(failure.failureKind).toBe('wikimapia_error');
    expect(failure.message.startsWith('Tile 1 page 1: ')).toBe(true);
    expect(wikimapia.detailsIds).toStrictEqual([9601, 9602]);
    expect(report.summary.counts.detailsSaved).toBe(2);
    expect(report.summary.counts.tilesFinished).toBe(1);
    expect(report.summary.counts.tilesUnfinished).toBe(1);
    const pass = at((await progress(REGION_T2.name)).passes, 0);
    expect(pass.finishedTiles).toStrictEqual([2]);
    expect(pass.complete).toBe(false);
  });

  it('C4: Details Fetched At is the receive moment after a 5 s Rate-Limit Wait', async () => {
    const square = syntheticBoxPlace(62587, 20.4603516, 44.8161006);
    const { report } = await crawlRegion(
      REGION_T1,
      {
        listing: { 1: [listingAnswer([square])] },
        details: { 62587: [rateLimitAnswer(5), detailsAnswer('getbyid-62587.json')] },
      },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 0 }) },
    );
    expect(report.outcome).toBe('completed');
    const place = await read(62587);
    expect(place?.status).toBe('detailed');
    if (place?.status !== 'detailed') return;
    expect(place.detailsFetchedAt).toBe('2026-10-22T09:00:05Z');
  });

  it('C5: progress lines name the Run start, saved pages, saved details and Item Failures', async () => {
    const { report, progressLines } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    const runId = String(report.runId);
    expect(
      progressLines.some((l) => l.startsWith(`Run ${runId} started for region ${REGION_T1.name}`)),
    ).toBe(true);
    expect(progressLines).toContain('Tile 1 page 1: 3 places saved, tile finished');
    expect(
      progressLines.some((l) => /^Place 1381893: details saved \((created|updated)\)$/.test(l)),
    ).toBe(true);
    expect(
      progressLines.some((l) => /^Place 62587: details saved \((created|updated)\)$/.test(l)),
    ).toBe(true);
    expect(progressLines.some((l) => l.startsWith('Item failure: Place 164369: '))).toBe(true);
    expect(progressLines.some((l) => l.startsWith('Stopping: '))).toBe(false);
  });

  it('C5: a page that is not short is reported without "tile finished"', async () => {
    const { progressLines } = await crawlRegion(REGION_T1, PAGING_SCRIPT, {
      configuration: PAGING_CONFIGURATION,
    });
    expect(progressLines).toContain('Tile 1 page 1: 3 places saved');
    expect(progressLines).toContain('Tile 1 page 2: 3 places saved');
    expect(progressLines).toContain('Tile 1 page 3: 1 places saved, tile finished');
  });

  it('C5: a stopped Run also reports the stop with its outcome label', async () => {
    const { report, progressLines } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      { request: { requestBudget: 0 } },
    );
    expect(report.outcome).toBe('budget_reached');
    expect(progressLines).toContain(`Stopping: ${OUTCOME_LABELS.budget_reached}`);
  });
});

// ===========================================================================
// D. Stops and store failures (AL4 1.4.9; AC-14, AC-41, AC-44, AC-46, AC-47)
// ===========================================================================

describe('D. Stops and store failures', () => {
  it('D1: budget 3 over a 4-tile Region ends Budget Reached after 3 requests; the next Run resumes', async () => {
    const first = await crawlRegion(REGION_T4, {}, { request: { requestBudget: 3 } });
    expect(first.report.outcome).toBe('budget_reached');
    expect(first.wikimapia.calls).toHaveLength(3);
    expect(first.report.summary.counts.wikimapiaRequests).toBe(3);
    expect(first.report.summary.counts.tilesUnfinished).toBe(1);
    expect(at((await progress(REGION_T4.name)).passes, 0).finishedTiles).toStrictEqual([1, 2, 3]);

    const second = await crawlRegion(
      REGION_T4,
      {},
      { clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR) },
    );
    expect(listingPages(second.wikimapia.calls, T4_TILES)).toStrictEqual(['tile 4 page 1']);
    expect(second.report.outcome).toBe('completed');
  });

  it('D2: Rate Limit Exhausted on a listing page ends Rate Limited; the page is not kept; the next Run asks it first', async () => {
    const first = await crawlRegion(REGION_T2, {
      listing: { 1: [rateLimitForever()], 2: [listingAnswer([])] },
    });
    expect(first.report.outcome).toBe('rate_limited');
    expect(first.wikimapia.calls.length).toBeGreaterThan(1);
    expect(first.wikimapia.calls.every((c) => tileNumberOf(T2_TILES, c.bbox) === 1)).toBe(true);
    expect(first.report.summary.counts.itemFailures).toBe(0);
    expect(finishedPageKeys(await progress(REGION_T2.name))).toStrictEqual([]);
    expect((await storedCounts()).places).toBe(0);

    const next = await crawlRegion(
      REGION_T2,
      {},
      { clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR) },
    );
    expect(at(listingPages(next.wikimapia.calls, T2_TILES), 0)).toBe('tile 1 page 1');
  });

  it('D3: an onWrite that throws on write 1 ends Failed without runId, Run Record or stored Place', async () => {
    const { report, wikimapia } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      {
        onWrite: (n) => {
          if (n === 1) throw new Error('injected store failure');
        },
      },
    );
    expect(report.outcome).toBe('failed');
    expect(report.message).toBeDefined();
    expect(report.message).not.toContain('injected');
    expect(report.runId).toBeUndefined();
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched();
  });

  it('D4: the write hook sees exactly 1, 2, ..., N across start, listing, details and finish', async () => {
    const seen: number[] = [];
    const callsAtWrite: number[] = [];
    // The hook reads the call count through the startCrawl handle, which exists before any
    // write: the Run's first write needs a database round trip, so it cannot happen
    // synchronously inside `startCrawl` (`handle` is assigned before the first `await`).
    const handle = startCrawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
      onWrite: (n) => {
        seen.push(n);
        callsAtWrite.push(handle.wikimapia.calls.length);
      },
    });
    const { wikimapia } = handle;
    const report: RunReport = RunReportSchema.parse(await handle.promise);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts).toStrictEqual(AC51_COUNTS);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen).toStrictEqual(Array.from({ length: seen.length }, (_, i) => i + 1));
    // Start-step writes come before the first request, the finish write after the last one.
    expect(at(callsAtWrite, 0)).toBe(0);
    expect(at(callsAtWrite, callsAtWrite.length - 1)).toBe(wikimapia.calls.length);
  });

  it('D5: a store failure mid-Run ends Failed after 2 calls; only page 1 is kept; no secrets shown', async () => {
    let storeDown = false;
    const { report, wikimapia, progressLines } = await crawlRegion(
      REGION_T1,
      {
        listing: {
          1: [
            fullPage(9100),
            {
              effect: () => {
                storeDown = true;
              },
              then: fullPage(9200),
            },
            fullPage(9300, 1),
          ],
        },
      },
      {
        configuration: PAGING_CONFIGURATION,
        onWrite: () => {
          if (storeDown) throw new Error(`connection to ${UNREACHABLE_DATABASE_URL} lost`);
        },
      },
    );
    expect(report.outcome).toBe('failed');
    expect(report.message).toBeDefined();
    expect(wikimapia.calls).toHaveLength(2);
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual(['tile 1 page 1']);
    expect((await storedCounts()).places).toBe(3);
    expect(report.summaryText.length).toBeGreaterThan(0);
    expectNoSecrets([JSON.stringify(report), report.summaryText, ...progressLines].join('\n'));
  });

  it(
    'D6: for every injected write failure of the paging scenario, a page is stored exactly when it is finished',
    async () => {
      let cleanRun = false;
      let injections = 0;
      for (let failAt = 1; failAt <= MAX_FAIL_AT && !cleanRun; failAt += 1) {
        await emptyAll();
        const seen = { injected: false };
        const { report } = await crawlRegion(REGION_T1, PAGING_SCRIPT, {
          configuration: PAGING_CONFIGURATION,
          onWrite: (n) => {
            if (n === failAt) {
              seen.injected = true;
              throw new Error('injected store failure');
            }
          },
        });
        const finished = finishedPageKeys(await progress(REGION_T1.name));
        for (const page of [1, 2, 3]) {
          const isFinished = finished.includes(`tile 1 page ${String(page)}`);
          const firstId = PAGE_FIRST_IDS[page] ?? 0;
          const isStored = (await read(firstId)) !== undefined;
          expect({ failAt, page, isFinished, isStored }).toStrictEqual({
            failAt,
            page,
            isFinished,
            isStored: isFinished,
          });
        }
        if (seen.injected) {
          injections += 1;
          expect(report.outcome).toBe('failed');
        } else {
          expect(report.outcome).toBe('completed');
          cleanRun = true;
        }
      }
      expect(cleanRun).toBe(true);
      expect(injections).toBeGreaterThan(0);
    },
    FAILURE_LOOP_TIMEOUT_MS,
  );

  it('D7: an abort from inside an answer ends Interrupted with no further request; the page in hand is whole or absent', async () => {
    const controller = new AbortController();
    const { report, wikimapia } = await crawlRegion(
      REGION_T1,
      {
        listing: {
          1: [
            fullPage(9100),
            {
              effect: () => {
                controller.abort();
              },
              then: fullPage(9200),
            },
            fullPage(9300, 1),
          ],
        },
      },
      { configuration: PAGING_CONFIGURATION, signal: controller.signal },
    );
    expect(report.outcome).toBe('interrupted');
    expect(wikimapia.calls).toHaveLength(2);
    const finished = finishedPageKeys(await progress(REGION_T1.name));
    expect(finished).toContain('tile 1 page 1');
    const page2Finished = finished.includes('tile 1 page 2');
    expect((await storedCounts()).places).toBe(page2Finished ? 6 : 3);
    expect((await read(9200)) !== undefined).toBe(page2Finished);
  });
});

// ===========================================================================
// E. Resources and secrets
// ===========================================================================

describe('E. Resources and secrets', () => {
  it(
    'E1: 30 non-dry Runs leave no open pool behind',
    async () => {
      const db = testDb();
      const before = await connectionCount(db);
      for (let i = 0; i < 30; i += 1) {
        const { report } = await crawlRegion(REGION_T1, { listing: { 1: [listingAnswer([])] } });
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

  it('E2: reports, progress lines and Crawl Progress show no key, key=, password or postgres://', async () => {
    const places = syntheticPlacesIn(SMALL_BBOX, 3, 9700);
    const { report, progressLines } = await crawlRegion(
      REGION_T1,
      {
        listing: { 1: [listingAnswer(places)] },
        details: {
          9700: UNREACHABLE,
          9701: wikimapiaErrorAnswer(),
          9702: [rateLimitAnswer('a few'), syntheticDetailsAnswer(9702)],
        },
      },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 0 }) },
    );
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.itemFailuresByKind.connection).toBe(1);
    expect(report.summary.counts.itemFailuresByKind.wikimapia_error).toBe(1);
    expect(report.summary.counts.rateLimitWaits).toBe(1);
    const shown = [
      JSON.stringify(report),
      report.summaryText,
      ...progressLines,
      JSON.stringify(await progress(REGION_T1.name)),
    ].join('\n');
    expectNoSecrets(shown);
  });
});

// ===========================================================================
// crawl-run1-fixes helpers (Failure Records, Explicit Retries, seeding)
// ===========================================================================

/** Wikimapia's text of the Key Quota answer (`contracts/fixtures/wikimapia/debug-key-quota.json`). */
const KEY_QUOTA_MESSAGE = 'Key limit has been reached';

async function failureRecords(input: FailureRecordsInput): Promise<FailureRecord[]> {
  return okValue(FailureRecordsResultSchema.parse(await crawlStore.readFailureRecords(input)))
    .records;
}

async function explicitRetries(regionName: string): Promise<ExplicitRetry[]> {
  return okValue(
    ExplicitRetriesResultSchema.parse(await crawlStore.readExplicitRetries({ regionName })),
  ).retries;
}

function runIdOf(report: RunReport): number {
  if (report.runId === undefined) {
    throw new Error(`Run ended ${report.outcome} without a Run Record`);
  }
  return report.runId;
}

async function recordsOfRun(report: RunReport): Promise<FailureRecord[]> {
  return failureRecords({ runId: runIdOf(report) });
}

/** A point-sized Place Summary at the centre of Region T1, as the Client returns it. */
function centralSummary(placeId: number): PlaceSummary {
  const { lon, lat } = CENTRAL_BELGRADE_POINT;
  return {
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic-place-${String(placeId)}`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

/** Stores Summary-Only Places inside Region T1 (due for details at once). */
async function seedCentral(...ids: number[]): Promise<void> {
  okValue(
    SaveResultSchema.parse(
      await placeStore.saveListingPage({
        page: 1,
        pageSize: 100,
        totalFound: ids.length,
        places: ids.map(centralSummary),
      }),
    ),
  );
}

/** One Run of Region T1 whose Simulated Clock starts `hours` after RUN_START. */
function crawlT1(
  hours: number,
  script: Omit<Script, 'tiles'> = {},
  extra: Omit<CrawlSetup, 'request' | 'responder' | 'clock'> & {
    request?: Omit<CrawlRequest, 'regionName'>;
  } = {},
) {
  return crawlRegion(REGION_T1, script, {
    clock: new SimulatedCrawlClock(T0 + hours * HOUR),
    ...extra,
  });
}

/** The Run Record of `report`, read through Crawl Progress. */
async function runRecordOf(report: RunReport) {
  const runId = runIdOf(report);
  const record = (await progress(REGION_T1.name)).runs.find((r) => r.runId === runId);
  if (record === undefined) throw new Error(`no Run Record for run ${String(runId)}`);
  return record;
}

const PARKED_900_LINE = `Place 900: parked after ${String(PARKING_THRESHOLD)} failures (${ITEM_FAILURE_LABELS.wikimapia_error})`;

/** Three Runs (hours 0, 1, 2) in which Place 900 fails with a Wikimapia Error: 900 is Parked. */
async function park900() {
  await seedCentral(900);
  const results = [];
  for (const hours of [0, 1, 2]) {
    results.push(await crawlT1(hours, { details: { 900: wikimapiaErrorAnswer() } }));
  }
  return results;
}

function shownText(report: RunReport, progressLines: readonly string[]): string {
  return [JSON.stringify(report), report.summaryText, ...progressLines].join('\n');
}

/** The store failure of contract AC-28: every write fails once the failing answer arrived. */
function storeDownAfter900() {
  const state = { down: false };
  const hookText = `connection to ${UNREACHABLE_DATABASE_URL} lost`;
  const script: Omit<Script, 'tiles'> = {
    details: {
      900: {
        effect: () => {
          state.down = true;
        },
        then: wikimapiaErrorAnswer(),
      },
    },
  };
  const onWrite: WriteHook = () => {
    if (state.down) throw new Error(hookText);
  };
  return { script, onWrite, hookText };
}

// ===========================================================================
// F. Failure Records (crawl-run1-fixes AL4 1.4.4; AC-21 .. AC-24, AC-28)
// ===========================================================================

describe('F. Failure Records', () => {
  it('F1: the AC-51 scenario keeps exactly one record for 164369 with the report message and the receive moment', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts).toStrictEqual(AC51_COUNTS);
    const shown = at(report.itemFailures, 0);
    expect(shown.message).toContain('Invalid API key.');
    const call = at(
      wikimapia.detailsCalls.filter((c) => c.placeId === 164369),
      0,
    );
    const expected: FailureRecord = {
      runId: runIdOf(report),
      item: { kind: 'place_details', placeId: 164369 },
      failureKind: 'wikimapia_error',
      message: shown.message,
      failedAt: toMoment(new Date(call.startedAtMs)),
    };
    expect(await recordsOfRun(report)).toStrictEqual([expected]);
    expect(await failureRecords({ placeId: 164369 })).toStrictEqual([expected]);
    expect(await failureRecords({ placeId: 62587 })).toStrictEqual([]);
    expect(await failureRecords({ placeId: 1381893 })).toStrictEqual([]);
  });

  it('F1: failedAt is the moment the failing answer was received, not the moment it was sent', async () => {
    await seedCentral(900);
    const { report, wikimapia } = await crawlT1(0, {
      details: { 900: { delayMs: 2500, then: wikimapiaErrorAnswer() } },
    });
    const call = at(wikimapia.detailsCalls, 0);
    expect(call.placeId).toBe(900);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([
      {
        runId: runIdOf(report),
        item: { kind: 'place_details', placeId: 900 },
        failureKind: 'wikimapia_error',
        message: at(report.itemFailures, 0).message,
        failedAt: toMoment(new Date(call.startedAtMs + 2500)),
      },
    ]);
  });

  it('F2: a Listing Page failure keeps one record with Tile and page; the Run continues with the next Tile', async () => {
    const places = syntheticPlacesIn(at(T2_TILES, 1).bbox, 2, 9601);
    const { report, wikimapia } = await crawlRegion(REGION_T2, {
      listing: { 1: [wikimapiaErrorAnswer()], 2: [listingAnswer(places)] },
    });
    expect(report.outcome).toBe('completed');
    expect(listingPages(wikimapia.calls, T2_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 2 page 1',
    ]);
    expect(await recordsOfRun(report)).toStrictEqual([
      {
        runId: runIdOf(report),
        item: { kind: 'listing_page', tileNumber: 1, page: 1 },
        failureKind: 'wikimapia_error',
        message: at(report.itemFailures, 0).message,
        failedAt: toMoment(new Date(at(wikimapia.listingCalls, 0).startedAtMs)),
      },
    ]);
  });

  it('F3: a Connection Failure with its back-off tries keeps one connection record at the last try', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T2.name },
      responder: (call) =>
        call.fn === 'box' && tileNumberOf(T2_TILES, call.bbox) === 1
          ? UNREACHABLE
          : listingAnswer([], call.page ?? 1, call.count ?? 100),
      configuration: testConfiguration({ minRequestIntervalSeconds: 0 }),
    });
    const tries = wikimapia.listingCalls.filter((c) => tileNumberOf(T2_TILES, c.bbox) === 1);
    expect(tries).toHaveLength(3);
    const last = at(tries, tries.length - 1);
    expect(await recordsOfRun(report)).toStrictEqual([
      {
        runId: runIdOf(report),
        item: { kind: 'listing_page', tileNumber: 1, page: 1 },
        failureKind: 'connection',
        message: at(report.itemFailures, 0).message,
        failedAt: toMoment(new Date(last.startedAtMs)),
      },
    ]);
  });

  it('F4: when the Failure Record cannot be written the Run ends Failed, untallied, unrecorded, with no further request and no hook text', async () => {
    await seedCentral(900, 901);
    const { script, onWrite, hookText } = storeDownAfter900();
    const { report, wikimapia, progressLines } = await crawlT1(0, script, { onWrite });
    expect(report.outcome).toBe('failed');
    expect(report.message).toBeDefined();
    expect(report.itemFailures).toStrictEqual([]);
    expect(report.summary.counts.itemFailures).toBe(0);
    expect(wikimapia.detailsIds).toStrictEqual([900]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
    expect(progressLines.some((l) => l.startsWith('Item failure:'))).toBe(false);
    const shown = shownText(report, progressLines);
    expect(shown).not.toContain(hookText);
    expect(shown).not.toContain(' lost');
    expectNoSecrets(shown);
  });

  it('F5: Rate Limit Exhausted keeps no record', async () => {
    await seedCentral(900);
    const { report } = await crawlT1(0, { details: { 900: rateLimitForever() } });
    expect(report.outcome).toBe('rate_limited');
    expect(await recordsOfRun(report)).toStrictEqual([]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
  });

  it('F5: Key Quota Exhausted keeps no record', async () => {
    await seedCentral(900);
    const { report } = await crawlT1(0, { details: { 900: keyQuotaAnswer() } });
    expect(report.outcome).toBe('quota_exhausted');
    expect(await recordsOfRun(report)).toStrictEqual([]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
  });

  it('F5: the Request Budget reached during a request keeps no record', async () => {
    await seedCentral(900);
    const { report } = await crawlT1(
      0,
      { details: { 900: [rateLimitAnswer(1), wikimapiaErrorAnswer()] } },
      { request: { requestBudget: 2 } },
    );
    expect(report.outcome).toBe('budget_reached');
    expect(await recordsOfRun(report)).toStrictEqual([]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
  });

  it('F5: an Operator interrupt keeps no record', async () => {
    await seedCentral(900, 901);
    const controller = new AbortController();
    const { report } = await crawlT1(
      0,
      {
        details: {
          900: {
            effect: () => {
              controller.abort();
            },
            then: syntheticDetailsAnswer(900),
          },
        },
      },
      { signal: controller.signal },
    );
    expect(report.outcome).toBe('interrupted');
    expect(await recordsOfRun(report)).toStrictEqual([]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
  });

  it('F5: an in-flight Item Failure that completes after an interrupt is recorded once', async () => {
    await seedCentral(900, 901);
    const controller = new AbortController();
    const { report } = await crawlT1(
      0,
      {
        details: {
          900: {
            effect: () => {
              controller.abort();
            },
            then: wikimapiaErrorAnswer(),
          },
        },
      },
      { signal: controller.signal },
    );
    expect(report.outcome).toBe('interrupted');
    expect(await recordsOfRun(report)).toHaveLength(1);
    expect(await failureRecords({ placeId: 900 })).toHaveLength(1);
    expect(await failureRecords({ placeId: 901 })).toStrictEqual([]);
  });

  it('F5: a Dry Run keeps no record and sends nothing', async () => {
    await seedCentral(900);
    const { report, wikimapia } = await crawlT1(0, {}, { request: { dryRun: true } });
    expect(report.outcome).toBe('planned');
    expect(wikimapia.calls).toHaveLength(0);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
  });
});

// ===========================================================================
// G. Parking end to end (crawl-run1-fixes AL4 1.2 step 9, 1.4.6, 1.4.7; AC-29, AC-35, AC-39)
// ===========================================================================

describe('G. Parking', () => {
  it('G1: the third failing Run parks 900 and says so; the first two do not; a fourth Run skips 900', async () => {
    const [first, second, third] = await park900();
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('expected three Runs');
    }
    for (const earlier of [first, second]) {
      expect(earlier.wikimapia.detailsIds).toStrictEqual([900]);
      expect(earlier.report.summary.counts.placesParkedThisRun).toBe(0);
      expect(earlier.report.summary.counts.placesParked).toBe(0);
      expect(earlier.report.summary.counts.placesStillDue).toBe(1);
      expect(earlier.progressLines).not.toContain(PARKED_900_LINE);
    }
    expect(third.wikimapia.detailsIds).toStrictEqual([900]);
    expect(third.report.outcome).toBe('completed');
    expect(third.report.summary.counts.placesParkedThisRun).toBe(1);
    expect(third.report.summary.counts.placesParked).toBe(1);
    expect(third.report.summary.counts.placesStillDue).toBe(0);
    expect(third.report.summary.counts.itemFailures).toBe(1);
    expect(third.progressLines).toContain(PARKED_900_LINE);
    expect(third.progressLines.some((l) => l.startsWith('Item failure: Place 900: '))).toBe(true);
    expect(await failureRecords({ placeId: 900 })).toHaveLength(3);

    const fourth = await crawlT1(3, { details: { 900: wikimapiaErrorAnswer() } });
    expect(fourth.wikimapia.detailsIds).not.toContain(900);
    expect((await read(900))?.status).toBe('summary_only');
  });

  it('G2: a Region whose only due Place is Parked sends nothing and ends Completed with 1 parked, 0 still due', async () => {
    await park900();
    const { report, wikimapia, progressLines } = await crawlT1(3);
    expect(wikimapia.calls).toHaveLength(0);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.placesStillDue).toBe(0);
    expect(report.summary.counts.placesParked).toBe(1);
    expect(report.summary.counts.placesParkedThisRun).toBe(0);
    expect(progressLines).not.toContain(PARKED_900_LINE);
  });

  it('G2: a Parked Place is counted as parked, not as still due, beside another due Place', async () => {
    await park900();
    await seedCentral(300);
    const { report, wikimapia } = await crawlT1(3);
    expect(wikimapia.detailsIds).toStrictEqual([300]);
    expect(report.summary.counts.detailsSaved).toBe(1);
    expect(report.summary.counts.placesParked).toBe(1);
    expect(report.summary.counts.placesStillDue).toBe(0);
    expect(report.summary.counts.placesParkedThisRun).toBe(0);
  });

  it('G3: the Run Record of each Run holds exactly the reported counts', async () => {
    const runs = await park900();
    const after = await crawlT1(3);
    for (const { report } of [...runs, after]) {
      expect((await runRecordOf(report)).counts).toStrictEqual(report.summary.counts);
    }
  });

  it('G3: unparked failures of two kinds leave placesParked 0 and keep one record each', async () => {
    await seedCentral(900, 901);
    const { report } = await crawlT1(0, {
      details: { 900: wikimapiaErrorAnswer(), 901: unexpectedAnswer() },
    });
    expect(report.summary.counts.itemFailures).toBe(2);
    expect(report.summary.counts.placesParkedThisRun).toBe(0);
    expect(report.summary.counts.placesParked).toBe(0);
    expect(report.summary.counts.placesStillDue).toBe(2);
    expect((await runRecordOf(report)).counts).toStrictEqual(report.summary.counts);
    expect((await recordsOfRun(report)).map((r) => r.item)).toStrictEqual([
      { kind: 'place_details', placeId: 900 },
      { kind: 'place_details', placeId: 901 },
    ]);
  });
});

// ===========================================================================
// H. Explicit Retry through runCrawl (crawl-run1-fixes AL4 1.2 step 5, 1.4.5; AC-37, AC-38)
// ===========================================================================

describe('H. Explicit Retry', () => {
  it('H1: retryParked releases 900, requests it in Details Order and keeps one Explicit Retry', async () => {
    await park900();
    await seedCentral(300, 950);
    const { report, wikimapia, progressLines } = await crawlT1(
      3,
      {},
      { request: { retryParked: true } },
    );
    expect(report.outcome).toBe('completed');
    expect(wikimapia.detailsIds).toStrictEqual([300, 900, 950]);
    expect(report.summary.counts.placesReleased).toBe(1);
    expect(report.summary.counts.placesParked).toBe(0);
    expect(report.summary.counts.placesParkedThisRun).toBe(0);
    expect(report.summary.counts.placesStillDue).toBe(0);
    expect((await read(900))?.status).toBe('detailed');
    expect(await explicitRetries(REGION_T1.name)).toStrictEqual([
      {
        runId: runIdOf(report),
        regionName: REGION_T1.name,
        retriedAt: report.summary.startedAt,
        placesReleased: 1,
      },
    ]);
    const retryLine = `Explicit retry: released 1 parked places of region ${REGION_T1.name}`;
    expect(progressLines).toContain(retryLine);
    const startIndex = progressLines.findIndex((l) =>
      l.startsWith(`Run ${String(report.runId)} started for region ${REGION_T1.name}`),
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(progressLines.indexOf(retryLine)).toBe(startIndex + 1);
    expect((await runRecordOf(report)).counts).toStrictEqual(report.summary.counts);
    expect(await failureRecords({ placeId: 900 })).toHaveLength(3);
  });

  it('H2: retryParked with nothing Parked releases 0 and still keeps one Explicit Retry', async () => {
    await seedCentral(900);
    const { report, progressLines } = await crawlT1(0, {}, { request: { retryParked: true } });
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.placesReleased).toBe(0);
    expect(await explicitRetries(REGION_T1.name)).toStrictEqual([
      {
        runId: runIdOf(report),
        regionName: REGION_T1.name,
        retriedAt: report.summary.startedAt,
        placesReleased: 0,
      },
    ]);
    expect(progressLines).toContain(
      `Explicit retry: released 0 parked places of region ${REGION_T1.name}`,
    );
  });

  it('H3: a Run without the option keeps no Explicit Retry and shows no Explicit retry line', async () => {
    await park900();
    const { report, progressLines } = await crawlT1(3);
    expect(report.summary.counts.placesReleased).toBe(0);
    expect(await explicitRetries(REGION_T1.name)).toStrictEqual([]);
    expect(progressLines.some((l) => l.startsWith('Explicit retry:'))).toBe(false);
  });
});

// ===========================================================================
// I. Dry Run with retryParked (crawl-run1-fixes AL4 0.1 decision 1, 1.2 step 2; AC-40)
// ===========================================================================

describe('I. Dry Run with retryParked', () => {
  it('I1: reports the parked count with zero counts; sends, writes and releases nothing', async () => {
    await park900();
    const runsBefore = (await progress(REGION_T1.name)).runs;
    const onWrite = vi.fn<WriteHook>();
    const { report, wikimapia } = await crawlT1(
      3,
      {},
      { request: { dryRun: true, retryParked: true }, onWrite },
    );
    expect(report.outcome).toBe('planned');
    expect(report.parkedPlacesInRegion).toBe(1);
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(report.plan).toStrictEqual(TilePlanSchema.parse(planTiles(REGION_T1)));
    expect(report.runId).toBeUndefined();
    expect(wikimapia.calls).toHaveLength(0);
    expect(onWrite).not.toHaveBeenCalled();
    expect(await explicitRetries(REGION_T1.name)).toStrictEqual([]);
    expect((await progress(REGION_T1.name)).runs).toStrictEqual(runsBefore);

    const plain = await crawlT1(4);
    expect(plain.wikimapia.detailsIds).not.toContain(900);
    expect(plain.report.summary.counts.placesParked).toBe(1);
  });

  it('I1: with nothing Parked the count is 0', async () => {
    await seedCentral(900);
    const { report, wikimapia } = await crawlT1(
      0,
      {},
      { request: { dryRun: true, retryParked: true } },
    );
    expect(report.outcome).toBe('planned');
    expect(report.parkedPlacesInRegion).toBe(0);
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(wikimapia.calls).toHaveLength(0);
  });

  it(
    'I2: with an unreachable database it ends Failed with a message and no secrets',
    async () => {
      const { report, wikimapia, progressLines } = await crawlT1(
        0,
        {},
        {
          request: { dryRun: true, retryParked: true },
          connectionString: UNREACHABLE_DATABASE_URL,
        },
      );
      expect(report.outcome).toBe('failed');
      expect(report.message).toBeDefined();
      expect(report).not.toHaveProperty('parkedPlacesInRegion');
      expect(report.runId).toBeUndefined();
      expect(wikimapia.calls).toHaveLength(0);
      const shown = shownText(report, progressLines);
      expect(shown).not.toContain(UNREACHABLE_PASSWORD);
      expect(shown).not.toContain('postgres://');
      expectNoSecrets(shown);
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  for (const [label, connectionString] of [
    ['an unreachable', UNREACHABLE_DATABASE_URL],
    ['an empty', ''],
  ] as const) {
    it(`I3: without the option and with ${label} connection string it is Planned without a parked count`, async () => {
      const { report, wikimapia } = await crawlT1(
        0,
        {},
        { request: { dryRun: true }, connectionString },
      );
      expect(report.outcome).toBe('planned');
      expect(report).not.toHaveProperty('parkedPlacesInRegion');
      expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
      expect(wikimapia.calls).toHaveLength(0);
    });
  }

  it('I4: needs no API Key', async () => {
    await park900();
    const { report, wikimapia } = await crawlT1(
      3,
      {},
      { request: { dryRun: true, retryParked: true }, apiKey: null },
    );
    expect(report.outcome).toBe('planned');
    expect(report.parkedPlacesInRegion).toBe(1);
    expect(wikimapia.calls).toHaveLength(0);
  });
});

// ===========================================================================
// J. Key Quota Run (crawl-run1-fixes AL4 1.4.3, 1.2 step 10; AC-15, AC-18)
// ===========================================================================

describe('J. Key Quota Run', () => {
  it('J1: a Details Phase answered with the Key Quota ends Quota Exhausted with the Wikimapia line and a kept Run Record', async () => {
    await seedCentral(300, 900);
    const { report, wikimapia, progressLines } = await crawlT1(0, {
      details: { 900: keyQuotaAnswer() },
    });
    expect(wikimapia.detailsIds).toStrictEqual([300, 900]);
    expect(report.outcome).toBe('quota_exhausted');
    expect(report.message).toContain(KEY_QUOTA_MESSAGE);
    expect(report.message).not.toContain(TEST_API_KEY);
    const lines = report.summaryText.split(/\r?\n/).filter((l) => l.trim() !== '');
    expect(at(lines, lines.length - 1)).toBe(
      `${SUMMARY_LABELS.wikimapiaMessage}: ${KEY_QUOTA_MESSAGE}`,
    );
    expect(lines).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`);
    expect(progressLines).toContain(`Stopping: ${OUTCOME_LABELS.quota_exhausted}`);
    expect(report.summary.counts.itemFailures).toBe(0);
    const record = await runRecordOf(report);
    expect(record.status).toBe('quota_exhausted');
    expect(record.endedAt).toBe(report.summary.endedAt);
    expect(record.counts).toStrictEqual(report.summary.counts);
    expect(await recordsOfRun(report)).toStrictEqual([]);
    expectNoSecrets(shownText(report, progressLines));
  });

  it('J2: a Completed Run shows no Wikimapia message line', async () => {
    const { report } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    expect(report.outcome).toBe('completed');
    const lines = report.summaryText.split(/\r?\n/);
    expect(lines.some((l) => l.startsWith(`${SUMMARY_LABELS.wikimapiaMessage}:`))).toBe(false);
  });

  it('J2: a Run that ends Failed on a store failure shows no Wikimapia message line', async () => {
    await seedCentral(900);
    const { script, onWrite } = storeDownAfter900();
    const { report } = await crawlT1(0, script, { onWrite });
    expect(report.outcome).toBe('failed');
    const lines = report.summaryText.split(/\r?\n/);
    expect(lines.some((l) => l.startsWith(`${SUMMARY_LABELS.wikimapiaMessage}:`))).toBe(false);
  });
});
