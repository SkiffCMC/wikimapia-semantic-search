/**
 * AL2 unit tests: `src/db/crawl-repository.ts` (internal `openCrawlRepository`) and the write
 * steps of `src/db/crawl-progress.ts` behind it, against the Test Database (AL4 hydration 1.3
 * repository types, 1.4.5 Run start, 1.4.6 listing step, 1.4.7 details save, 1.4.8 finish,
 * 1.4.9 write hook and store failures, 1.5 transaction boundaries). AL3 routing
 * 20261022-hydration-04-repository, section 2.1 A .. G.
 *
 * Store-side stand-in for contract AC-14, AC-20 .. AC-25, AC-47, AC-53, AC-62 and AC-69 until
 * `contracts/hydration.test.ts` can load (U7). Section H (Listing Save unchanged) is covered by
 * `tests/db/listing.db.test.ts` and `contracts/storage.test.ts`, which this file does not touch.
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`) and the contract's unreachable
 * URL. All state is created through the repository itself (explicit `startedAt` and
 * `abandonBefore` give old or live Runs); no SQL is issued here. State is observed only through
 * the public stores: Crawl Progress with `createCrawlStore(...).readCrawlProgress` and Place
 * totals with `createPlaceStore(...).countStored`. Every repository result is parsed with
 * `storeResultSchema(...)` around a test-local value schema of the AL4 1.3 types, every report
 * with `SaveReportSchema`, every view with `CrawlProgressViewSchema`. Every repository, store
 * and setup is closed in `afterEach`/`afterAll`.
 *
 * Extended by feature `crawl-run1-fixes` (AL4 crawl-run1-fixes 1.3, 1.4.8; AL3 routing
 * 20261022-crawl-run1-fixes-03-failure-records, section 2.1 B): `recordItemFailure` joins the
 * guards of section F and the Run-wide write numbering of section E (E.5).
 *
 * Extended by feature `crawl-run1-fixes` (AL4 crawl-run1-fixes 1.3, 1.4.5 .. 1.4.7; AL3 routing
 * 20261022-crawl-run1-fixes-04-parking, section 2.1 D): every `beginRun` input carries
 * `retryParked: false` and every started value `placesReleased: 0`; `recordItemFailure` may
 * carry `parked`; `listParkedPlaces` and `regionTotals` join the guards of section F; the due
 * count moves from `countPlacesDue` to `regionTotals` (F.3 .. F.5). The `countPlacesDue` adapter
 * stayed in `everyCall` until U6; U6 removed it (AL3 routing 20261022-crawl-run1-fixes-06-run,
 * section 2.1 H).
 */
import { z } from 'zod';
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import type {
  BeginRunInput,
  CrawlRepository,
  FinalRunStatus,
  FinishInput,
  ListingStepInput,
  RenewInput,
} from '../../src/db/types';
import {
  EmptyResultSchema,
  InvalidDataFailureSchema,
  ReadPlaceResultSchema,
  SaveReportSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  StoreUnavailableFailureSchema,
  storeResultSchema,
  type PlaceStore,
  type SaveReport,
  type SavePlaceDetailsInput,
  type SchemaSetup,
  type StoreCounts,
  type StoreFailure,
  type WriteHook,
} from '../../contracts/storage.schema';
import {
  ABANDONMENT_AGE_SECONDS,
  COORDINATE_TOLERANCE,
  CrawlProgressResultSchema,
  CrawlProgressViewSchema,
  DuePlaceSchema,
  ItemFailureKindSchema,
  MomentSchema,
  RunCountsSchema,
  RunIdSchema,
  ZERO_RUN_COUNTS,
  toMoment,
  type CrawlProgressView,
  type CrawlStore,
  type Moment,
  type RunCounts,
  type RunRecord,
} from '../../contracts/hydration.schema';
import { RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  at,
  clientDetails,
  clientListing,
  listingOf,
  requireTestDatabaseUrl,
  summaryOf,
} from '../../contracts/storage.support';
import type { ListingPage } from '../../contracts/wikimapia-client.schema';
import type { FailureRecord } from '../../contracts/crawl-run1-fixes.schema';

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const UNREACHABLE_TIMEOUT_MS = 60_000;
const FAILURE_LOOP_TIMEOUT_MS = 180_000;
const MAX_FAIL_AT = 60;

const REGION = 'test-one';
const OTHER_REGION = 'test-two';
const TILE_SIZE = { width: 0.005, height: 0.005 } as const;

// ---------------------------------------------------------------------------
// Moments and counts (fixed, whole seconds)
// ---------------------------------------------------------------------------

function plusSeconds(moment: Moment, seconds: number): Moment {
  return toMoment(new Date(Date.parse(moment) + seconds * 1000));
}

/** The Run start minus the Abandonment Age, as AL4 1.4.5 computes it. */
function abandonBeforeFor(startedAt: Moment): Moment {
  return plusSeconds(startedAt, -ABANDONMENT_AGE_SECONDS);
}

/** A non-zero `RunCounts` that passes the contract's refinements. */
const SOME_COUNTS: RunCounts = RunCountsSchema.parse({
  ...ZERO_RUN_COUNTS,
  wikimapiaRequests: 5,
  listingRequests: 3,
  detailsRequests: 2,
  rateLimitWaits: 1,
  rateLimitWaitSeconds: 12,
  listingPagesSaved: 3,
  tilesFinished: 1,
  tilesUnfinished: 1,
  placesListed: 3,
  placesNewlyStored: 2,
  detailsSaved: 2,
  detailsChanged: 1,
  placesStillDue: 1,
  itemFailures: 1,
  itemFailuresByKind: { ...ZERO_RUN_COUNTS.itemFailuresByKind, connection: 1 },
});

/** Type-correct counts that break `RunCountsSchema` (refinement, then a negative count). */
const BAD_COUNTS: readonly RunCounts[] = [
  { ...ZERO_RUN_COUNTS, wikimapiaRequests: 1 },
  { ...ZERO_RUN_COUNTS, placesListed: -1 },
];

// ---------------------------------------------------------------------------
// Test-local value schemas of the AL4 1.3 repository types (not contract schemas)
// ---------------------------------------------------------------------------

const PassStateSchema = z.strictObject({
  passNumber: z.number().int().min(1),
  tileCount: z.number().int().min(1),
  finishedTiles: z.array(z.number().int().min(1)),
  lastFinishedPage: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)])),
});

const BeginRunValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('started'),
    runId: RunIdSchema,
    pass: PassStateSchema.optional(),
    abandonedRunIds: z.array(RunIdSchema),
    placesReleased: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('run_in_progress'),
    runId: RunIdSchema,
    lastActivity: MomentSchema,
  }),
  z.strictObject({ kind: z.literal('region_changed'), passNumber: z.number().int().min(1) }),
]);
type BeginRunParsed = z.infer<typeof BeginRunValueSchema>;
type Started = Extract<BeginRunParsed, { kind: 'started' }>;

const ListingStepValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), report: SaveReportSchema }),
  z.strictObject({ kind: z.literal('taken_over') }),
]);

const BeginRunResultSchema = storeResultSchema(BeginRunValueSchema);
const ListingStepResultSchema = storeResultSchema(ListingStepValueSchema);
const RenewResultSchema = storeResultSchema(z.strictObject({ alive: z.boolean() }));
const FinishResultSchema = storeResultSchema(z.strictObject({ updated: z.boolean() }));
const DueListResultSchema = storeResultSchema(z.array(DuePlaceSchema));
const ParkedPlaceSchema = z.strictObject({
  placeId: z.number().int().positive(),
  failureKind: ItemFailureKindSchema,
});
/** `FailureStepValue` (AL4 1.3): `parked` only for a Place that is Parked after the record. */
const FailureStepResultSchema = storeResultSchema(
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('recorded'), parked: ParkedPlaceSchema.optional() }),
    z.strictObject({ kind: z.literal('taken_over') }),
  ]),
);
const ParkedListResultSchema = storeResultSchema(z.array(ParkedPlaceSchema));
const RegionTotalsResultSchema = storeResultSchema(
  z.strictObject({
    placesDue: z.number().int().nonnegative(),
    placesParked: z.number().int().nonnegative(),
  }),
);

type Parsed<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
let placeStore: PlaceStore;
let crawlStore: CrawlStore;
const repositories: CrawlRepository[] = [];

/** Opens a repository on the Test Database (or `connectionString`), closed in `afterEach`. */
function openRepo(onWrite?: WriteHook, connectionString = requireTestDatabaseUrl()): CrawlRepository {
  const repo = openCrawlRepository({
    connectionString,
    ...(onWrite === undefined ? {} : { onWrite }),
  });
  repositories.push(repo);
  return repo;
}

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: url });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  expect(applied.ok).toBe(true);
  placeStore = createPlaceStore({ connectionString: url });
  crawlStore = createCrawlStore({ connectionString: url });
});

beforeEach(async () => {
  await emptyAll();
});

afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
});

afterAll(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  await crawlStore.close();
  await placeStore.close();
  await setup.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emptyAll(): Promise<void> {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
}

/** Fails the test explicitly if the call rejects; otherwise yields its resolved value. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await expect(promise).resolves.toBeDefined();
  return promise;
}

function okValue<T>(result: Parsed<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

function failureOf<T>(result: Parsed<T>): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

function expectUnavailable<T>(result: Parsed<T>): StoreFailure {
  const failure = failureOf(result);
  StoreUnavailableFailureSchema.parse(failure);
  return failure;
}

function expectNoSecrets(failure: StoreFailure): void {
  const text = JSON.stringify(failure);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain('injected');
  expect(text).not.toContain('secret');
}

function beginInput(overrides: Partial<BeginRunInput> = {}): BeginRunInput {
  return {
    regionName: REGION,
    bbox: SMALL_BBOX,
    tileSize: TILE_SIZE,
    tileCount: 1,
    relist: false,
    startedAt: RUN_START,
    abandonBefore: abandonBeforeFor(RUN_START),
    counts: ZERO_RUN_COUNTS,
    retryParked: false,
    ...overrides,
  };
}

async function beginResult(repo: CrawlRepository, input: BeginRunInput) {
  return BeginRunResultSchema.parse(await settle(repo.beginRun(input)));
}

async function begin(repo: CrawlRepository, overrides: Partial<BeginRunInput> = {}) {
  return okValue(await beginResult(repo, beginInput(overrides)));
}

/** Every start in this file is without `retryParked`, so it releases nothing. */
function started(value: BeginRunParsed): Started {
  if (value.kind !== 'started') throw new Error(`expected started, got ${value.kind}`);
  expect(value.placesReleased).toBe(0);
  return value;
}

async function startRun(repo: CrawlRepository, overrides: Partial<BeginRunInput> = {}): Promise<Started> {
  return started(await begin(repo, overrides));
}

function pageInput(
  runId: number,
  listing: ListingPage,
  overrides: Partial<ListingStepInput> = {},
): ListingStepInput {
  return {
    runId,
    regionName: REGION,
    passNumber: 1,
    tileNumber: 1,
    page: 1,
    listing,
    short: false,
    finishedAt: plusSeconds(RUN_START, 10),
    ...overrides,
  };
}

async function recordResult(repo: CrawlRepository, input: ListingStepInput) {
  return ListingStepResultSchema.parse(await settle(repo.recordListingPage(input)));
}

async function recordSaved(repo: CrawlRepository, input: ListingStepInput): Promise<SaveReport> {
  const value = okValue(await recordResult(repo, input));
  if (value.kind !== 'saved') throw new Error(`expected saved, got ${value.kind}`);
  return SaveReportSchema.parse(value.report);
}

function failureRecordFor(runId: number, failedAt: Moment = plusSeconds(RUN_START, 15)): FailureRecord {
  return {
    runId,
    item: { kind: 'place_details', placeId: 900 },
    failureKind: 'wikimapia_error',
    message: 'Place 900: Wikimapia error: synthetic failure',
    failedAt,
  };
}

async function failureResult(repo: CrawlRepository, record: FailureRecord) {
  return FailureStepResultSchema.parse(await settle(repo.recordItemFailure(record)));
}

async function renewResult(repo: CrawlRepository, input: RenewInput) {
  return RenewResultSchema.parse(await settle(repo.renewActivity(input)));
}

async function finishResult(repo: CrawlRepository, input: FinishInput) {
  return FinishResultSchema.parse(await settle(repo.finishRun(input)));
}

async function progress(regionName: string = REGION): Promise<CrawlProgressView> {
  const result = CrawlProgressResultSchema.parse(
    await settle(crawlStore.readCrawlProgress({ regionName })),
  );
  return CrawlProgressViewSchema.parse(okValue(result));
}

async function counts(): Promise<StoreCounts> {
  return okValue(StoreCountsResultSchema.parse(await settle(placeStore.countStored())));
}

function runOf(view: CrawlProgressView, runId: number): RunRecord {
  const run = view.runs.find((r) => r.runId === runId);
  if (run === undefined) throw new Error(`view has no run ${String(runId)}`);
  return run;
}

function recorder(): { hook: WriteHook; numbers: number[] } {
  const numbers: number[] = [];
  return {
    numbers,
    hook: (n) => {
      numbers.push(n);
    },
  };
}

function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

async function belgradePage(): Promise<ListingPage> {
  return clientListing('box-belgrade-page1.json');
}

async function emptyPage(): Promise<ListingPage> {
  return clientListing('box-belgrade-empty-page.json');
}

/**
 * Seeds Run 1 with pass 1 of `tileCount` 2 (default definition) where only Tile 1 is finished
 * (one empty Short Page), then finishes the Run. The pass stays incomplete.
 */
async function seedIncompletePass(repo: CrawlRepository): Promise<number> {
  const run = await startRun(repo, { tileCount: 2 });
  await recordSaved(repo, pageInput(run.runId, await emptyPage(), { short: true }));
  const finished = okValue(
    await finishResult(repo, {
      runId: run.runId,
      status: 'completed',
      endedAt: plusSeconds(RUN_START, 120),
      counts: ZERO_RUN_COUNTS,
    }),
  );
  expect(finished).toStrictEqual({ updated: true });
  return run.runId;
}

/** A Run started a day after RUN_START (no live Run left by the seeding). */
const NEXT_DAY = plusSeconds(RUN_START, 86_400);
function nextDay(overrides: Partial<BeginRunInput> = {}): Partial<BeginRunInput> {
  return { startedAt: NEXT_DAY, abandonBefore: abandonBeforeFor(NEXT_DAY), ...overrides };
}

// ===========================================================================
// A. Run start (AL4 1.4.5; AC-24, AC-25, AC-53, AC-62, AC-69 store side)
// ===========================================================================

describe('A. beginRun', () => {
  it('A.1 on an empty store starts Run 1 with pass 1 and an in-progress Run Record', async () => {
    const repo = openRepo();
    const value = await begin(repo);
    const run = started(value);
    expect(run.runId).toBeGreaterThan(0);
    expect(run.pass).toStrictEqual({
      passNumber: 1,
      tileCount: 1,
      finishedTiles: [],
      lastFinishedPage: [],
    });
    expect(run.abandonedRunIds).toStrictEqual([]);
    expect(run.placesReleased).toBe(0);

    const view = await progress();
    expect(view.runs).toStrictEqual([
      {
        runId: run.runId,
        regionName: REGION,
        status: 'in_progress',
        startedAt: RUN_START,
        lastActivity: RUN_START,
        counts: ZERO_RUN_COUNTS,
      },
    ]);
    expect(view.passes).toStrictEqual([
      {
        passNumber: 1,
        regionName: REGION,
        bbox: SMALL_BBOX,
        tileSize: TILE_SIZE,
        tileCount: 1,
        complete: false,
        finishedTiles: [],
        finishedPages: [],
      },
    ]);
  });

  it('A.2 refuses a second start while the first Run is live (Last Activity exactly 1 hour old) and changes nothing', async () => {
    const repo = openRepo();
    const first = await startRun(repo);
    const before = await progress();
    const countsBefore = await counts();

    const second = plusSeconds(RUN_START, ABANDONMENT_AGE_SECONDS);
    const value = await begin(repo, { startedAt: second, abandonBefore: RUN_START });
    expect(value).toStrictEqual({
      kind: 'run_in_progress',
      runId: first.runId,
      lastActivity: RUN_START,
    });
    expect(await progress()).toStrictEqual(before);
    expect(await counts()).toStrictEqual(countsBefore);
  });

  it('A.3 takes over a Run silent for more than 1 hour: marks it abandoned (counts kept) and resumes its pass', async () => {
    const repo = openRepo();
    const first = await startRun(repo);
    const renewedAt = plusSeconds(RUN_START, 60);
    expect(
      okValue(await renewResult(repo, { runId: first.runId, at: renewedAt, counts: SOME_COUNTS })),
    ).toStrictEqual({ alive: true });

    const secondStart = plusSeconds(renewedAt, ABANDONMENT_AGE_SECONDS + 1);
    const second = started(
      await begin(repo, { startedAt: secondStart, abandonBefore: plusSeconds(renewedAt, 1) }),
    );
    expect(second.runId).not.toBe(first.runId);
    expect(second.abandonedRunIds).toStrictEqual([first.runId]);
    expect(second.placesReleased).toBe(0);
    expect(second.pass).toStrictEqual({
      passNumber: 1,
      tileCount: 1,
      finishedTiles: [],
      lastFinishedPage: [],
    });

    const view = await progress();
    expect(runOf(view, first.runId)).toStrictEqual({
      runId: first.runId,
      regionName: REGION,
      status: 'abandoned',
      startedAt: RUN_START,
      lastActivity: renewedAt,
      counts: SOME_COUNTS,
    });
    expect(runOf(view, second.runId)).toStrictEqual({
      runId: second.runId,
      regionName: REGION,
      status: 'in_progress',
      startedAt: secondStart,
      lastActivity: secondStart,
      counts: ZERO_RUN_COUNTS,
    });
    expect(view.passes.map((p) => p.passNumber)).toStrictEqual([1]);
  });

  describe('A.4 definition of an incomplete pass', () => {
    it('a different Tile Size gives region_changed with the pass number and changes nothing', async () => {
      const repo = openRepo();
      await seedIncompletePass(repo);
      const before = await progress();
      const countsBefore = await counts();

      const value = await begin(
        repo,
        nextDay({ tileCount: 2, tileSize: { width: 0.006, height: 0.005 } }),
      );
      expect(value).toStrictEqual({ kind: 'region_changed', passNumber: 1 });
      expect(await progress()).toStrictEqual(before);
      expect(await counts()).toStrictEqual(countsBefore);
    });

    it('the same change with relist starts pass 2 with the new definition and keeps pass 1', async () => {
      const repo = openRepo();
      await seedIncompletePass(repo);
      const before = await progress();
      const newSize = { width: 0.006, height: 0.005 };

      const run = started(await begin(repo, nextDay({ tileCount: 2, tileSize: newSize, relist: true })));
      expect(run.pass).toStrictEqual({
        passNumber: 2,
        tileCount: 2,
        finishedTiles: [],
        lastFinishedPage: [],
      });
      expect(run.abandonedRunIds).toStrictEqual([]);

      const view = await progress();
      expect(view.passes).toHaveLength(2);
      expect(at(view.passes, 0)).toStrictEqual(at(before.passes, 0));
      expect(at(view.passes, 1)).toStrictEqual({
        passNumber: 2,
        regionName: REGION,
        bbox: SMALL_BBOX,
        tileSize: newSize,
        tileCount: 2,
        complete: false,
        finishedTiles: [],
        finishedPages: [],
      });
    });

    it('a bbox side within COORDINATE_TOLERANCE is the same definition: the pass is resumed', async () => {
      const repo = openRepo();
      await seedIncompletePass(repo);
      const nudged = { ...SMALL_BBOX, east: SMALL_BBOX.east + COORDINATE_TOLERANCE / 2 };

      const run = started(await begin(repo, nextDay({ tileCount: 2, bbox: nudged })));
      expect(run.pass).toStrictEqual({
        passNumber: 1,
        tileCount: 2,
        finishedTiles: [1],
        lastFinishedPage: [[1, 1]],
      });
      expect((await progress()).passes).toHaveLength(1);
    });

    it('a different tile count is a changed definition', async () => {
      const repo = openRepo();
      await seedIncompletePass(repo);
      const before = await progress();

      const value = await begin(repo, nextDay({ tileCount: 3 }));
      expect(value).toStrictEqual({ kind: 'region_changed', passNumber: 1 });
      expect(await progress()).toStrictEqual(before);
    });
  });

  it('A.5 resumes an incomplete pass with its finished tiles and last finished pages', async () => {
    const repo = openRepo();
    const run = await startRun(repo, { tileCount: 3 });
    await recordSaved(repo, pageInput(run.runId, await belgradePage(), { tileNumber: 1, short: false }));
    await recordSaved(repo, pageInput(run.runId, await emptyPage(), { tileNumber: 2, short: true }));
    okValue(
      await finishResult(repo, {
        runId: run.runId,
        status: 'budget_reached',
        endedAt: plusSeconds(RUN_START, 60),
        counts: ZERO_RUN_COUNTS,
      }),
    );

    const next = started(await begin(repo, nextDay({ tileCount: 3 })));
    expect(next.pass).toStrictEqual({
      passNumber: 1,
      tileCount: 3,
      finishedTiles: [2],
      lastFinishedPage: [
        [1, 1],
        [2, 1],
      ],
    });
    expect(next.abandonedRunIds).toStrictEqual([]);
  });

  it('A.6 a complete pass gives no pass without relist, and a new pass with relist', async () => {
    const repo = openRepo();
    const first = await startRun(repo);
    await recordSaved(repo, pageInput(first.runId, await emptyPage(), { short: true }));
    okValue(
      await finishResult(repo, {
        runId: first.runId,
        status: 'completed',
        endedAt: plusSeconds(RUN_START, 60),
        counts: ZERO_RUN_COUNTS,
      }),
    );

    const second = started(await begin(repo, nextDay()));
    expect(second.pass).toBeUndefined();
    expect((await progress()).passes).toHaveLength(1);
    okValue(
      await finishResult(repo, {
        runId: second.runId,
        status: 'completed',
        endedAt: plusSeconds(NEXT_DAY, 60),
        counts: ZERO_RUN_COUNTS,
      }),
    );

    const thirdStart = plusSeconds(NEXT_DAY, 86_400);
    const third = started(
      await begin(repo, {
        startedAt: thirdStart,
        abandonBefore: abandonBeforeFor(thirdStart),
        relist: true,
      }),
    );
    expect(third.pass).toStrictEqual({
      passNumber: 2,
      tileCount: 1,
      finishedTiles: [],
      lastFinishedPage: [],
    });
    expect((await progress()).passes.map((p) => p.passNumber)).toStrictEqual([1, 2]);
  });

  it('A.7 a live Run of one Region does not stop a start for another Region', async () => {
    const repo = openRepo();
    await startRun(repo, { regionName: REGION });
    const other = started(await begin(repo, { regionName: OTHER_REGION }));
    expect(other.pass?.passNumber).toBe(1);
    expect((await progress(OTHER_REGION)).runs.map((r) => r.status)).toStrictEqual(['in_progress']);
    expect((await progress(REGION)).runs.map((r) => r.status)).toStrictEqual(['in_progress']);
  });
});

// ===========================================================================
// B. Listing step (AL4 1.4.6 step; AC-14, AC-20 .. AC-22 store side)
// ===========================================================================

describe('B. recordListingPage', () => {
  it('B.1 saves the recorded Belgrade page and one Finished Page in one step', async () => {
    const repo = openRepo();
    const run = await startRun(repo);
    const listing = await belgradePage();

    const report = await recordSaved(repo, pageInput(run.runId, listing));
    expect(report.places).toStrictEqual(
      listing.places.map((p) => ({ placeId: p.placeId, outcome: 'created' })),
    );
    expect(report.places).toHaveLength(3);
    expect((await counts()).places).toBe(3);

    const pass = at((await progress()).passes, 0);
    expect(pass.finishedPages).toStrictEqual([
      {
        tileNumber: 1,
        page: 1,
        runId: run.runId,
        placeCount: 3,
        short: false,
        totalFound: listing.totalFound,
      },
    ]);
    expect(pass.finishedTiles).toStrictEqual([]);
  });

  it('B.2 repeating the page as a Short Page reports unchanged, stores no new Place and finishes the Tile', async () => {
    const repo = openRepo();
    const run = await startRun(repo);
    const listing = await belgradePage();
    await recordSaved(repo, pageInput(run.runId, listing));

    const report = await recordSaved(repo, pageInput(run.runId, listing, { page: 2, short: true }));
    expect(report.places).toStrictEqual(
      listing.places.map((p) => ({ placeId: p.placeId, outcome: 'unchanged' })),
    );
    expect((await counts()).places).toBe(3);

    const pass = at((await progress()).passes, 0);
    expect(pass.finishedTiles).toStrictEqual([1]);
    expect(pass.complete).toBe(true);
    expect(pass.finishedPages.map((p) => [p.page, p.short])).toStrictEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('B.3 an empty Short Page stores no Place and exactly one Finished Page with placeCount 0', async () => {
    const repo = openRepo();
    const run = await startRun(repo);
    const listing = await emptyPage();

    const report = await recordSaved(repo, pageInput(run.runId, listing, { short: true }));
    expect(report).toStrictEqual({ places: [] });
    expect((await counts()).places).toBe(0);

    const pass = at((await progress()).passes, 0);
    expect(pass.finishedPages).toStrictEqual([
      {
        tileNumber: 1,
        page: 1,
        runId: run.runId,
        placeCount: 0,
        short: true,
        totalFound: listing.totalFound,
      },
    ]);
    expect(pass.finishedTiles).toStrictEqual([1]);
  });

  it('B.4 a page with a duplicate Place ID is deduplicated exactly as the Listing Save does', async () => {
    const belgrade = await belgradePage();
    const first = at(belgrade.places, 0);
    const second = at(belgrade.places, 1);
    const listing = listingOf(first, second, { ...first, name: `${first.name} (renamed)` });

    const repo = openRepo();
    const run = await startRun(repo);
    const report = await recordSaved(repo, pageInput(run.runId, listing));
    const storedViaStep = okValue(
      StoreCountsResultSchema.parse(await settle(placeStore.countStored())),
    );
    const readViaStep = ReadPlaceResultSchema.parse(
      await settle(placeStore.readPlace({ placeId: first.placeId })),
    );
    const pass = at((await progress()).passes, 0);
    expect(at(pass.finishedPages, 0).placeCount).toBe(3);

    await emptyAll();
    const viaSave = SaveResultSchema.parse(await settle(placeStore.saveListingPage(listing)));
    expect(report).toStrictEqual(okValue(viaSave));
    expect(storedViaStep).toStrictEqual(await counts());
    expect(readViaStep).toStrictEqual(
      ReadPlaceResultSchema.parse(await settle(placeStore.readPlace({ placeId: first.placeId }))),
    );
  });

  describe('B.5 an invalid listing resolves invalid_data and writes nothing', () => {
    const cases: [string, (page: ListingPage) => ListingPage][] = [
      ['pageSize 0', (page) => ({ ...page, pageSize: 0 })],
      [
        'a Place with a bad id',
        (page) => ({ ...page, places: [{ ...at(page.places, 0), placeId: -1 }] }),
      ],
    ];
    it.each(cases)('%s', async (_name, spoil) => {
      const rec = recorder();
      const repo = openRepo(rec.hook);
      const run = await startRun(repo);
      const before = await progress();
      const callsBefore = rec.numbers.length;

      const result = await recordResult(repo, pageInput(run.runId, spoil(await belgradePage())));
      InvalidDataFailureSchema.parse(failureOf(result));
      expect(rec.numbers).toHaveLength(callsBefore);
      expect(await progress()).toStrictEqual(before);
      expect((await counts()).places).toBe(0);
    });
  });

  it('B.6 an unknown Run resolves taken_over and writes nothing', async () => {
    const rec = recorder();
    const repo = openRepo(rec.hook);
    const run = await startRun(repo);
    const before = await progress();
    const callsBefore = rec.numbers.length;

    const value = okValue(
      await recordResult(repo, pageInput(run.runId + 1000, await belgradePage())),
    );
    expect(value).toStrictEqual({ kind: 'taken_over' });
    expect(rec.numbers).toHaveLength(callsBefore);
    expect(await progress()).toStrictEqual(before);
    expect((await counts()).places).toBe(0);
  });
});

// ===========================================================================
// C. Renewal and finish (AL4 1.4.8 finish bullet, 1.5)
// ===========================================================================

describe('C. renewActivity and finishRun', () => {
  it('C.1 renewActivity on a live Run updates Last Activity and counts', async () => {
    const repo = openRepo();
    const run = await startRun(repo);
    const renewedAt = plusSeconds(RUN_START, 30);

    const value = okValue(
      await renewResult(repo, { runId: run.runId, at: renewedAt, counts: SOME_COUNTS }),
    );
    expect(value).toStrictEqual({ alive: true });
    expect(runOf(await progress(), run.runId)).toStrictEqual({
      runId: run.runId,
      regionName: REGION,
      status: 'in_progress',
      startedAt: RUN_START,
      lastActivity: renewedAt,
      counts: SOME_COUNTS,
    });
  });

  const FINAL_STATUSES: FinalRunStatus[] = [
    'completed',
    'budget_reached',
    'rate_limited',
    'interrupted',
    'failed',
  ];

  it.each(FINAL_STATUSES)(
    'C.2 finishRun with %s sets status, endedAt, Last Activity and counts once',
    async (status) => {
      const repo = openRepo();
      const run = await startRun(repo);
      const endedAt = plusSeconds(RUN_START, 300);

      const value = okValue(
        await finishResult(repo, { runId: run.runId, status, endedAt, counts: SOME_COUNTS }),
      );
      expect(value).toStrictEqual({ updated: true });
      const after = await progress();
      expect(runOf(after, run.runId)).toStrictEqual({
        runId: run.runId,
        regionName: REGION,
        status,
        startedAt: RUN_START,
        endedAt,
        lastActivity: endedAt,
        counts: SOME_COUNTS,
      });

      const again = okValue(
        await finishResult(repo, {
          runId: run.runId,
          status: status === 'failed' ? 'completed' : 'failed',
          endedAt: plusSeconds(endedAt, 60),
          counts: ZERO_RUN_COUNTS,
        }),
      );
      expect(again).toStrictEqual({ updated: false });
      expect(await progress()).toStrictEqual(after);
    },
  );

  describe('C.3 counts that fail RunCountsSchema resolve store_unavailable and write nothing', () => {
    it.each(BAD_COUNTS.map((c, i) => [i, c] as const))('finishRun, bad counts #%i', async (_i, bad) => {
      const repo = openRepo();
      const run = await startRun(repo);
      const before = await progress();

      const result = await finishResult(repo, {
        runId: run.runId,
        status: 'completed',
        endedAt: plusSeconds(RUN_START, 60),
        counts: bad,
      });
      expectUnavailable(result);
      expect(await progress()).toStrictEqual(before);
    });

    it.each(BAD_COUNTS.map((c, i) => [i, c] as const))('renewActivity, bad counts #%i', async (_i, bad) => {
      const repo = openRepo();
      const run = await startRun(repo);
      const before = await progress();

      const result = await renewResult(repo, {
        runId: run.runId,
        at: plusSeconds(RUN_START, 60),
        counts: bad,
      });
      expectUnavailable(result);
      expect(await progress()).toStrictEqual(before);
    });

    it.each(BAD_COUNTS.map((c, i) => [i, c] as const))('beginRun, bad counts #%i', async (_i, bad) => {
      const repo = openRepo();
      const result = await beginResult(repo, beginInput({ counts: bad }));
      expectUnavailable(result);
      expect(await progress()).toStrictEqual({ regionName: REGION, passes: [], runs: [] });
    });
  });
});

// ===========================================================================
// D. Taken over (AL4 1.4.6 bullet 2; AC-69 store side)
// ===========================================================================

describe('D. a Run that was taken over', () => {
  it('gets taken_over / alive: false / updated: false, and nothing is written or hooked', async () => {
    const seeder = openRepo();
    const runA = await startRun(seeder);
    const takeoverAt = plusSeconds(RUN_START, ABANDONMENT_AGE_SECONDS + 1);
    const runB = started(
      await begin(seeder, { startedAt: takeoverAt, abandonBefore: plusSeconds(RUN_START, 1) }),
    );
    expect(runB.abandonedRunIds).toStrictEqual([runA.runId]);

    const rec = recorder();
    const repo = openRepo(rec.hook);
    const before = await progress();
    const countsBefore = await counts();

    const step = okValue(
      await recordResult(
        repo,
        pageInput(runA.runId, await belgradePage(), { finishedAt: plusSeconds(takeoverAt, 5) }),
      ),
    );
    expect(step).toStrictEqual({ kind: 'taken_over' });
    const renewed = okValue(
      await renewResult(repo, {
        runId: runA.runId,
        at: plusSeconds(takeoverAt, 6),
        counts: SOME_COUNTS,
      }),
    );
    expect(renewed).toStrictEqual({ alive: false });
    const finished = okValue(
      await finishResult(repo, {
        runId: runA.runId,
        status: 'failed',
        endedAt: plusSeconds(takeoverAt, 7),
        counts: SOME_COUNTS,
      }),
    );
    expect(finished).toStrictEqual({ updated: false });

    expect(await progress()).toStrictEqual(before);
    expect(await counts()).toStrictEqual(countsBefore);
    expect(rec.numbers).toStrictEqual([]);
  });
});

// ===========================================================================
// E. Write hook and failures (AL4 1.4.9; AC-14, AC-47 store side)
// ===========================================================================

describe('E. write hook', () => {
  it('E.1 numbers every write of the Run 1, 2, ..., n across all steps of one repository', async () => {
    const rec = recorder();
    const repo = openRepo(rec.hook);

    const run = await startRun(repo);
    const afterBegin = rec.numbers.length;
    await recordSaved(repo, pageInput(run.runId, await belgradePage(), { short: true }));
    const afterListing = rec.numbers.length;
    okValue(
      await renewResult(repo, {
        runId: run.runId,
        at: plusSeconds(RUN_START, 20),
        counts: ZERO_RUN_COUNTS,
      }),
    );
    const afterRenewal = rec.numbers.length;
    const details: SavePlaceDetailsInput = {
      details: await clientDetails('getbyid-62587.json'),
      fetchedAt: plusSeconds(RUN_START, 30),
    };
    okValue(SaveResultSchema.parse(await settle(repo.saveDetails(details))));
    const afterDetails = rec.numbers.length;
    okValue(
      await finishResult(repo, {
        runId: run.runId,
        status: 'completed',
        endedAt: plusSeconds(RUN_START, 40),
        counts: ZERO_RUN_COUNTS,
      }),
    );
    const n = rec.numbers.length;

    expect(rec.numbers).toStrictEqual(oneTo(n));
    // Run insert + pass insert; 3 Place inserts + Finished Page; renewal; >= 1 details write; finish.
    expect(afterBegin).toBe(2);
    expect(afterListing - afterBegin).toBe(4);
    expect(afterRenewal - afterListing).toBe(1);
    expect(afterDetails - afterRenewal).toBeGreaterThanOrEqual(1);
    expect(n - afterDetails).toBe(1);
    expect(n).toBeGreaterThanOrEqual(1 + 1 + 4 + 1 + 1 + 1);
  });

  it(
    'E.2 a failure injected at each write in turn rolls back exactly its step (page saved iff finished)',
    async () => {
      let cleanTotal: number | undefined;
      const beginFailures: number[] = [];
      const listingFailures: number[] = [];

      for (let failAt = 1; failAt <= MAX_FAIL_AT && cleanTotal === undefined; failAt += 1) {
        await emptyAll();
        const seen = { injected: false, max: 0 };
        const repo = openRepo((n) => {
          seen.max = Math.max(seen.max, n);
          if (n === failAt) {
            seen.injected = true;
            throw new Error('injected postgres://user:secret@host/db');
          }
        });

        const begun = await beginResult(repo, beginInput());
        if (!begun.ok) {
          expect(seen.injected).toBe(true);
          expectNoSecrets(expectUnavailable(begun));
          expect(await progress()).toStrictEqual({ regionName: REGION, passes: [], runs: [] });
          expect((await counts()).places).toBe(0);
          beginFailures.push(failAt);
          await repo.close();
          continue;
        }
        const run = started(begun.value);

        const step = await recordResult(
          repo,
          pageInput(run.runId, await belgradePage(), { short: true }),
        );
        const view = await progress();
        const finished = view.passes.some((p) =>
          p.finishedPages.some((fp) => fp.tileNumber === 1 && fp.page === 1),
        );
        const stored = (await counts()).places;
        expect({ failAt, finished, stored }).toStrictEqual({
          failAt,
          finished,
          stored: finished ? 3 : 0,
        });

        if (step.ok) {
          expect(seen.injected).toBe(false);
          expect(step.value.kind).toBe('saved');
          expect(finished).toBe(true);
          cleanTotal = seen.max;
        } else {
          expect(seen.injected).toBe(true);
          expectNoSecrets(expectUnavailable(step));
          expect(finished).toBe(false);
          listingFailures.push(failAt);
        }
        await repo.close();
      }

      expect(cleanTotal).toBeDefined();
      expect(beginFailures.length).toBeGreaterThan(0);
      // The Finished Page insert is the last write of the step, hence of the clean sequence.
      expect(listingFailures).toContain(cleanTotal);
      expect(listingFailures.some((f) => f < (cleanTotal ?? 0))).toBe(true);
    },
    FAILURE_LOOP_TIMEOUT_MS,
  );

  it('E.3a a hook failure on the renewal write leaves Last Activity unchanged', async () => {
    let armed = false;
    const repo = openRepo(() => {
      if (armed) throw new Error('injected postgres://user:secret@host/db');
    });
    const run = await startRun(repo);
    const before = await progress();

    armed = true;
    const result = await renewResult(repo, {
      runId: run.runId,
      at: plusSeconds(RUN_START, 30),
      counts: SOME_COUNTS,
    });
    expectNoSecrets(expectUnavailable(result));
    expect(await progress()).toStrictEqual(before);
    expect(runOf(before, run.runId).lastActivity).toBe(RUN_START);
  });

  it('E.3b a hook failure on the finish write leaves the Run in progress with no endedAt', async () => {
    let armed = false;
    const repo = openRepo(() => {
      if (armed) throw new Error('injected postgres://user:secret@host/db');
    });
    const run = await startRun(repo);
    const before = await progress();

    armed = true;
    const result = await finishResult(repo, {
      runId: run.runId,
      status: 'completed',
      endedAt: plusSeconds(RUN_START, 30),
      counts: SOME_COUNTS,
    });
    expectNoSecrets(expectUnavailable(result));
    const after = await progress();
    expect(after).toStrictEqual(before);
    const record = runOf(after, run.runId);
    expect(record.status).toBe('in_progress');
    expect(record.endedAt).toBeUndefined();
  });

  it('E.5 beginRun then recordItemFailure numbers the hook calls continuously (the record is the next number)', async () => {
    const rec = recorder();
    const repo = openRepo(rec.hook);
    const run = await startRun(repo);
    const afterBegin = rec.numbers.length;
    expect(afterBegin).toBe(2);

    expect(await failureResult(repo, failureRecordFor(run.runId))).toStrictEqual({
      ok: true,
      value: { kind: 'recorded' },
    });
    expect(rec.numbers).toStrictEqual(oneTo(afterBegin + 1));

    await recordSaved(repo, pageInput(run.runId, await emptyPage(), { short: true }));
    const afterListing = rec.numbers.length;
    expect(await failureResult(repo, failureRecordFor(run.runId, plusSeconds(RUN_START, 25)))).toStrictEqual({
      ok: true,
      value: { kind: 'recorded' },
    });
    expect(rec.numbers).toStrictEqual(oneTo(afterListing + 1));
  });

  describe('E.4 the hook is called only for writes', () => {
    it('a refused start (run_in_progress) calls it zero times', async () => {
      await startRun(openRepo());
      const rec = recorder();
      const repo = openRepo(rec.hook);
      const value = await begin(repo, {
        startedAt: plusSeconds(RUN_START, 10),
        abandonBefore: abandonBeforeFor(plusSeconds(RUN_START, 10)),
      });
      expect(value.kind).toBe('run_in_progress');
      expect(rec.numbers).toStrictEqual([]);
    });

    it('a refused start (region_changed) calls it zero times', async () => {
      await seedIncompletePass(openRepo());
      const rec = recorder();
      const repo = openRepo(rec.hook);
      const value = await begin(repo, nextDay({ tileCount: 3 }));
      expect(value.kind).toBe('region_changed');
      expect(rec.numbers).toStrictEqual([]);
    });

    it('a taken_over listing step calls it zero times', async () => {
      const run = await startRun(openRepo());
      const rec = recorder();
      const repo = openRepo(rec.hook);
      const value = okValue(
        await recordResult(repo, pageInput(run.runId + 1000, await belgradePage())),
      );
      expect(value.kind).toBe('taken_over');
      expect(rec.numbers).toStrictEqual([]);
    });
  });
});

// ===========================================================================
// F. Repository guards (AL4 1.4.9 bullet 3)
// ===========================================================================

/** One valid call of every method except `close`, keyed by method name. */
async function everyCall(
  repo: CrawlRepository,
): Promise<[string, Parsed<unknown>][]> {
  const listing = await belgradePage();
  const details: SavePlaceDetailsInput = {
    details: await clientDetails('getbyid-62587.json'),
    fetchedAt: plusSeconds(RUN_START, 30),
  };
  const due = { bbox: SMALL_BBOX, dueBefore: RUN_START };
  return [
    ['beginRun', await beginResult(repo, beginInput())],
    [
      'renewActivity',
      await renewResult(repo, { runId: 1, at: RUN_START, counts: ZERO_RUN_COUNTS }),
    ],
    ['recordListingPage', await recordResult(repo, pageInput(1, listing))],
    ['recordItemFailure', await failureResult(repo, failureRecordFor(1))],
    ['saveDetails', SaveResultSchema.parse(await settle(repo.saveDetails(details)))],
    ['listPlacesDue', DueListResultSchema.parse(await settle(repo.listPlacesDue(due)))],
    [
      'listParkedPlaces',
      ParkedListResultSchema.parse(await settle(repo.listParkedPlaces({ bbox: SMALL_BBOX }))),
    ],
    ['regionTotals', RegionTotalsResultSchema.parse(await settle(repo.regionTotals(due)))],
    [
      'finishRun',
      await finishResult(repo, {
        runId: 1,
        status: 'completed',
        endedAt: RUN_START,
        counts: ZERO_RUN_COUNTS,
      }),
    ],
  ];
}

describe('F. repository guards', () => {
  it('F.1 a not-configured repository resolves store_unavailable for every method; close resolves twice', async () => {
    const repo = openRepo(undefined, '');
    const results = await everyCall(repo);
    expect(results.map(([name]) => name)).toHaveLength(9);
    for (const [name, result] of results) {
      expect({ name, failure: failureOf(result) }).toStrictEqual({
        name,
        failure: { kind: 'store_unavailable', message: NOT_CONFIGURED_MESSAGE },
      });
    }
    await expect(repo.close()).resolves.toBeUndefined();
    await expect(repo.close()).resolves.toBeUndefined();
  });

  it(
    'F.2 an unreachable database resolves store_unavailable for every method, without secrets',
    async () => {
      const repo = openRepo(undefined, UNREACHABLE_DATABASE_URL);
      const results = await everyCall(repo);
      expect(results).toHaveLength(9);
      for (const [name, result] of results) {
        const failure = failureOf(result);
        expect({ name, kind: failure.kind }).toStrictEqual({ name, kind: 'store_unavailable' });
        expectNoSecrets(failure);
      }
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it(
    'F.3 invalid details and an invalid dueBefore resolve invalid_data without touching the database',
    async () => {
      const real = openRepo();
      const unreachable = openRepo(undefined, UNREACHABLE_DATABASE_URL);
      const details = await clientDetails('getbyid-62587.json');
      const badDetails: SavePlaceDetailsInput = { details, fetchedAt: 'yesterday' };
      const badDue = { bbox: SMALL_BBOX, dueBefore: 'yesterday' };

      for (const repo of [real, unreachable]) {
        InvalidDataFailureSchema.parse(
          failureOf(SaveResultSchema.parse(await settle(repo.saveDetails(badDetails)))),
        );
        InvalidDataFailureSchema.parse(
          failureOf(DueListResultSchema.parse(await settle(repo.listPlacesDue(badDue)))),
        );
        InvalidDataFailureSchema.parse(
          failureOf(RegionTotalsResultSchema.parse(await settle(repo.regionTotals(badDue)))),
        );
      }
      expect(SaveResultSchema.parse(await real.saveDetails(badDetails))).toStrictEqual(
        SaveResultSchema.parse(await unreachable.saveDetails(badDetails)),
      );
      expect(DueListResultSchema.parse(await real.listPlacesDue(badDue))).toStrictEqual(
        DueListResultSchema.parse(await unreachable.listPlacesDue(badDue)),
      );
      expect(RegionTotalsResultSchema.parse(await real.regionTotals(badDue))).toStrictEqual(
        RegionTotalsResultSchema.parse(await unreachable.regionTotals(badDue)),
      );
      expect((await counts()).places).toBe(0);
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it(
    'F.3b an invalid regionTotals input (bad bbox, sub-second dueBefore) is invalid_data without database access, like listPlacesDue',
    async () => {
      const real = openRepo();
      const unreachable = openRepo(undefined, UNREACHABLE_DATABASE_URL);
      const reversed = {
        west: SMALL_BBOX.east,
        south: SMALL_BBOX.south,
        east: SMALL_BBOX.west,
        north: SMALL_BBOX.north,
      };
      const badInputs = [
        { bbox: reversed, dueBefore: RUN_START },
        { bbox: { ...SMALL_BBOX, north: 91 }, dueBefore: RUN_START },
        { bbox: SMALL_BBOX, dueBefore: '2026-10-22T09:00:00.500Z' },
      ];
      for (const bad of badInputs) {
        const onReal = RegionTotalsResultSchema.parse(await settle(real.regionTotals(bad)));
        const onUnreachable = RegionTotalsResultSchema.parse(
          await settle(unreachable.regionTotals(bad)),
        );
        InvalidDataFailureSchema.parse(failureOf(onReal));
        expect(onUnreachable).toStrictEqual(onReal);
        const listed = DueListResultSchema.parse(await settle(unreachable.listPlacesDue(bad)));
        expect(failureOf(listed).kind).toBe('invalid_data');
      }
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it('F.4 listPlacesDue honours limit and regionTotals agrees with the unlimited list', async () => {
    const repo = openRepo();
    const run = await startRun(repo);
    const belgrade = await belgradePage();
    const two = listingOf(
      summaryOf(belgrade, at(belgrade.places, 0).placeId),
      summaryOf(belgrade, at(belgrade.places, 1).placeId),
    );
    await recordSaved(repo, pageInput(run.runId, two, { short: true }));
    const query = { bbox: SMALL_BBOX, dueBefore: plusSeconds(RUN_START, 60) };

    const all = okValue(DueListResultSchema.parse(await settle(repo.listPlacesDue(query))));
    expect(all.map((p) => p.placeId).sort((a, b) => a - b)).toStrictEqual(
      two.places.map((p) => p.placeId).sort((a, b) => a - b),
    );
    const limited = okValue(
      DueListResultSchema.parse(await settle(repo.listPlacesDue({ ...query, limit: 1 }))),
    );
    expect(limited).toHaveLength(1);
    expect(limited).toStrictEqual(all.slice(0, 1));
    const totals = okValue(RegionTotalsResultSchema.parse(await settle(repo.regionTotals(query))));
    expect(totals).toStrictEqual({ placesDue: all.length, placesParked: 0 });
    expect(okValue(ParkedListResultSchema.parse(await settle(repo.listParkedPlaces({ bbox: SMALL_BBOX }))))).toStrictEqual([]);
  });

  it('F.5 a Parked Place of the bbox: listPlacesDue omits it, regionTotals counts it as parked, listParkedPlaces returns it', async () => {
    const repo = openRepo();
    const run = await startRun(repo);
    const belgrade = await belgradePage();
    const ids = belgrade.places.map((p) => p.placeId);
    await recordSaved(repo, pageInput(run.runId, belgrade, { short: true }));
    const query = { bbox: SMALL_BBOX, dueBefore: plusSeconds(RUN_START, 60) };

    const before = okValue(DueListResultSchema.parse(await settle(repo.listPlacesDue(query))));
    expect(before.map((p) => p.placeId).sort((a, b) => a - b)).toStrictEqual(
      [...ids].sort((a, b) => a - b),
    );
    const totalsBefore = okValue(
      RegionTotalsResultSchema.parse(await settle(repo.regionTotals(query))),
    );
    expect(totalsBefore).toStrictEqual({ placesDue: before.length, placesParked: 0 });

    const parkedId = at(before, 0).placeId;
    for (const s of [20, 25, 30]) {
      const value = okValue(
        await failureResult(repo, {
          ...failureRecordFor(run.runId, plusSeconds(RUN_START, s)),
          item: { kind: 'place_details', placeId: parkedId },
        }),
      );
      expect(value.kind).toBe('recorded');
    }

    const after = okValue(DueListResultSchema.parse(await settle(repo.listPlacesDue(query))));
    expect(after).toStrictEqual(before.filter((p) => p.placeId !== parkedId));
    expect(
      okValue(DueListResultSchema.parse(await settle(repo.listPlacesDue({ ...query, limit: 1 })))),
    ).toStrictEqual(after.slice(0, 1));
    const totalsAfter = okValue(RegionTotalsResultSchema.parse(await settle(repo.regionTotals(query))));
    expect(totalsAfter).toStrictEqual({
      placesDue: totalsBefore.placesDue - 1,
      placesParked: 1,
    });
    expect(totalsAfter.placesDue).toBe(after.length);
    expect(
      okValue(ParkedListResultSchema.parse(await settle(repo.listParkedPlaces({ bbox: SMALL_BBOX })))),
    ).toStrictEqual([{ placeId: parkedId, failureKind: 'wikimapia_error' }]);
  });
});

// ===========================================================================
// G. Concurrency backstop (AL4 1.5, lock order)
// ===========================================================================

describe('G. concurrent starts', () => {
  it('two starts for one Region at once: exactly one starts, the other sees the live Run', async () => {
    const one = openRepo();
    const two = openRepo();
    const [a, b] = await Promise.all([
      beginResult(one, beginInput()),
      beginResult(two, beginInput()),
    ]);
    const kinds = [okValue(a).kind, okValue(b).kind].sort();
    expect(kinds).toStrictEqual(['run_in_progress', 'started']);

    const view = await progress();
    expect(view.runs.filter((r) => r.status === 'in_progress')).toHaveLength(1);
    expect(view.runs).toHaveLength(1);
    expect(view.passes).toHaveLength(1);
  });
});
