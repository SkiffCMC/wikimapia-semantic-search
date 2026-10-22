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
  ABANDONMENT_AGE_SECONDS,
  CrawlProgressResultSchema,
  OUTCOME_LABELS,
  RunReportSchema,
  TilePlanSchema,
  ZERO_RUN_COUNTS,
  type CrawlConfiguration,
  type CrawlProgressView,
  type CrawlRequest,
  type CrawlStore,
  type Region,
  type RunCounts,
  type RunCrawlFn,
  type RunReport,
  type Tile,
} from '../../contracts/hydration.schema';
import {
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
  wikimapiaErrorAnswer,
  type Responder,
  type Script,
  type WikimapiaCall,
} from '../../contracts/hydration.support';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
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

// Compile-time check: the entry point has the contract's signature.
const run: RunCrawlFn = runCrawl;

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
let crawlStore: CrawlStore;
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
  crawlStore = createCrawlStore({ connectionString: testUrl });
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
