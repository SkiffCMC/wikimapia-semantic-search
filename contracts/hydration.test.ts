/**
 * AL5 CONTRACT TESTS: Hydration jobs, the Crawl (behaviour, black box, Test Database).
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261022-hydration-al6.md (revision 2; one describe per AC,
 *           plus R1 for the Places Due for Details query)
 * Enforces: .agrules section 1 (offline, idempotent, resumable, paced crawl that backs off on
 *           errors), section 2 (every result parsed with its Zod schema), section 3 (Crawl
 *           Progress created by Schema Setup), section 4 (no Commenter IPs, no secrets in output,
 *           recorded fixtures, no live network, Test Database only, strict types).
 *
 * Subjects under test, never doubled: `runCrawl` (src/crawl/run-crawl.ts), `planTiles`
 * (src/crawl/tile-plan.ts), `runCrawlCommand` (src/crawl/command.ts), `createCrawlStore`
 * (src/db/crawl-store.ts), and the finished `createPlaceStore` / `createSchemaSetup`
 * (src/db/) with the Schema Setup step this feature adds. The Wikimapia Client inside the Crawl
 * is the real one. Only the transport (Simulated Wikimapia answering from
 * contracts/fixtures/wikimapia/ or small synthetic pages) and the clock (Simulated Clock) are
 * test doubles. Until AL2 exists this file fails to import: that is the expected red state.
 *
 * Schema-only and validator checks live in ./hydration.schema.test.ts and pass before AL2.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { runCrawlCommand } from '../src/crawl/command';
import { runCrawl } from '../src/crawl/run-crawl';
import { planTiles } from '../src/crawl/tile-plan';
import { createCrawlStore } from '../src/db/crawl-store';
import { createPlaceStore } from '../src/db/place-store';
import { createSchemaSetup } from '../src/db/schema-setup';
import {
  ABANDONMENT_AGE_SECONDS,
  BELGRADE_REGION,
  BELGRADE_SMALL_REGION,
  CONNECTION_RETRY_WAITS_SECONDS,
  COORDINATE_TOLERANCE,
  CRAWL_COMMAND_OPTIONS,
  CRAWL_QUOTA_SHARE,
  CRAWL_SCRIPT,
  CrawlCommandResultSchema,
  CrawlProgressResultSchema,
  DEFAULT_LISTING_PAGE_SIZE,
  DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
  ITEM_FAILURE_LABELS,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  OUTCOME_LABELS,
  PlacesDueResultSchema,
  RunReportSchema,
  SUMMARY_LABELS,
  TilePlanSchema,
  ZERO_RUN_COUNTS,
  findPacingIssues,
  findTilePlanIssues,
  type CrawlConfiguration,
  type CrawlProgressView,
  type CrawlRequest,
  type CrawlStore,
  type CreateCrawlStoreFn,
  type DuePlace,
  type PlanTilesFn,
  type Region,
  type RunCounts,
  type RunCrawlCommandFn,
  type RunCrawlFn,
  type RunReport,
  type Tile,
  type TilePlan,
} from './hydration.schema';
import {
  CENTRAL_BELGRADE_POINT,
  CrawlWikimapia,
  DAY,
  FAR_TILES,
  Gate,
  HOUR,
  REGION_FAR,
  REGION_T1,
  REGION_T2,
  REGION_T4,
  RUN_START,
  SECOND,
  SMALL_BBOX,
  SYNTHETIC_IPS,
  SimulatedCrawlClock,
  T1_TILES,
  T2_TILES,
  T4_TILES,
  TEST_API_KEY,
  UNREACHABLE,
  addCommenterIps,
  at,
  belgradePage1,
  detailsAnswer,
  emptyRecordedPage,
  iso,
  listingAnswer,
  rateLimitAnswer,
  rateLimitForever,
  rawDetails,
  rawDetailsAnswer,
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
} from './hydration.support';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
  STORE_TABLES,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  StoreStructureResultSchema,
  type CreatePlaceStoreFn,
  type CreateSchemaSetupFn,
  type DetailedPlace,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
  type StoreStructure,
  type StoredPlace,
  type WriteHook,
} from './storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  clientDetails,
  clientListing,
  requireTestDatabaseUrl,
  summaryOf,
} from './storage.support';
import {
  DEFAULT_FALLBACK_WAIT_SECONDS,
  type BoundingBox,
  type PlaceDetails,
  type PlaceSummary,
} from './wikimapia-client.schema';

// Compile-time check: the entry points have the contract's signatures.
const run: RunCrawlFn = runCrawl;
const plan: PlanTilesFn = planTiles;
const command: RunCrawlCommandFn = runCrawlCommand;
const createCrawl: CreateCrawlStoreFn = createCrawlStore;
const createStore: CreatePlaceStoreFn = createPlaceStore;
const createSetup: CreateSchemaSetupFn = createSchemaSetup;

const T0 = Date.parse(RUN_START);

// ---------------------------------------------------------------------------
// Lifecycle: one Test Database, every Schema Setup step applied, emptied (Places, Crawl
// Progress and Run Records) before every test (AC-57, AC-64)
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let store: PlaceStore;
let crawlStore: CrawlStore;
/** Every attempted global `fetch` (Wikimapia, OpenAI, anything): must stay empty (AC-63). */
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in hydration contract tests'));
  });
  testUrl = requireTestDatabaseUrl();
  setup = createSetup({ connectionString: testUrl });
  okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  store = createStore({ connectionString: testUrl });
  crawlStore = createCrawl({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  await emptyAll();
});

afterAll(async () => {
  await crawlStore.close();
  await store.close();
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

function failureOf<T>(result: Result<T>): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

async function emptyAll(): Promise<void> {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
}

async function progress(regionName: string): Promise<CrawlProgressView> {
  return okValue(
    CrawlProgressResultSchema.parse(await crawlStore.readCrawlProgress({ regionName })),
  );
}

async function counts() {
  return okValue(StoreCountsResultSchema.parse(await store.countStored()));
}

async function inspect(): Promise<StoreStructure> {
  return okValue(StoreStructureResultSchema.parse(await setup.inspect()));
}

async function read(placeId: number): Promise<StoredPlace | undefined> {
  const value = okValue(ReadPlaceResultSchema.parse(await store.readPlace({ placeId })));
  return value.found ? value.place : undefined;
}

async function readDetailed(placeId: number): Promise<DetailedPlace> {
  const place = await read(placeId);
  if (place?.status !== 'detailed') throw new Error(`place ${String(placeId)} is not detailed`);
  return place;
}

async function due(bbox: BoundingBox, dueBefore: string): Promise<DuePlace[]> {
  return okValue(
    PlacesDueResultSchema.parse(await crawlStore.listPlacesDueForDetails({ bbox, dueBefore })),
  ).places;
}

const EMPTY_COUNTS = { places: 0, comments: 0, tags: 0, placeTagLinks: 0 };
const TEST_REGION_NAMES = [REGION_T1.name, REGION_T2.name, REGION_T4.name, REGION_FAR.name];

/** Nothing stored and no Crawl Progress or Run Record for the given Regions. */
async function expectDatabaseUntouched(regionNames: readonly string[]): Promise<void> {
  expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  for (const regionName of regionNames) {
    expect(await progress(regionName)).toStrictEqual({ regionName, passes: [], runs: [] });
  }
}

function expectBbox(actual: BoundingBox | undefined, expected: BoundingBox): void {
  expect(actual).toBeDefined();
  if (actual === undefined) return;
  for (const side of ['west', 'south', 'east', 'north'] as const) {
    expect(Math.abs(actual[side] - expected[side])).toBeLessThanOrEqual(COORDINATE_TOLERANCE);
  }
}

function counts0(overrides: Partial<RunCounts>): RunCounts {
  return { ...ZERO_RUN_COUNTS, ...overrides };
}

interface CrawlSetup {
  request: CrawlRequest;
  responder?: Responder;
  /** `'default'` = pass no configuration (DEFAULT_CRAWL_CONFIGURATION). */
  configuration?: CrawlConfiguration | 'default';
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
    onProgress: (line) => {
      progressLines.push(line);
    },
    ...(s.apiKey === null ? {} : { apiKey: s.apiKey ?? TEST_API_KEY }),
    ...(s.configuration === 'default'
      ? {}
      : { configuration: s.configuration ?? testConfiguration() }),
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

/** Run one Region with a script and an optional Crawl Configuration override. */
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

function tilesOf(region: Region): readonly Tile[] {
  if (region === REGION_T1) return T1_TILES;
  if (region === REGION_T2) return T2_TILES;
  if (region === REGION_T4) return T4_TILES;
  if (region === REGION_FAR) return FAR_TILES;
  throw new Error(`no expected tiles for ${region.name}`);
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

/** A Place Summary as the Client returns it (synthetic, point-sized). */
function summary(placeId: number, lon: number, lat: number): PlaceSummary {
  return {
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic-place-${String(placeId)}`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

/** Place Details as the Client returns them (synthetic, point-sized). */
function syntheticPlaceDetails(placeId: number, lon: number, lat: number): PlaceDetails {
  return {
    placeId,
    title: `Synthetic place ${String(placeId)}`,
    description: `Synthetic description ${String(placeId)}.`,
    tags: [],
    isBuilding: false,
    isRegion: false,
    isDeleted: false,
    outline: [],
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    comments: [],
  };
}

async function seedSummaries(...places: PlaceSummary[]): Promise<void> {
  okValue(
    SaveResultSchema.parse(
      await store.saveListingPage({ page: 1, pageSize: 10, totalFound: places.length, places }),
    ),
  );
}

async function seedRecordedSummaries(...ids: number[]): Promise<void> {
  const page = await clientListing('box-belgrade-page1.json');
  await seedSummaries(...ids.map((id) => summaryOf(page, id)));
}

async function seedDetails(details: PlaceDetails, fetchedAt: string): Promise<void> {
  okValue(SaveResultSchema.parse(await store.savePlaceDetails({ details, fetchedAt })));
}

/**
 * A synthetic `box` answer with `places` summaries (ids from `firstId`) inside the small bbox,
 * echoing the requested page size 3 as Wikimapia does. Fewer than 3 places = a Short Page.
 */
function fullPage(firstId: number, places = 3) {
  return listingAnswer(syntheticPlacesIn(SMALL_BBOX, places, firstId), 1, 3);
}

/** Everything a Run made visible as text (report, progress lines, Crawl Progress). */
async function everythingShown(
  report: RunReport,
  progressLines: readonly string[],
  regionName: string,
): Promise<string> {
  return [
    JSON.stringify(report),
    report.summaryText,
    ...progressLines,
    JSON.stringify(await progress(regionName)),
  ].join('\n');
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toMatch(/[?&]key=/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  expect(text).not.toMatch(/user_?ip/i);
  for (const ip of SYNTHETIC_IPS) expect(text).not.toContain(String(ip));
}

/** The Tile Plan of `belgrade-small` stated by AC-2. */
const BELGRADE_SMALL_TILES: readonly Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.457, north: 44.819 } },
  { tileNumber: 2, bbox: { west: 20.457, south: 44.814, east: 20.462, north: 44.819 } },
  { tileNumber: 3, bbox: { west: 20.452, south: 44.819, east: 20.457, north: 44.82 } },
  { tileNumber: 4, bbox: { west: 20.457, south: 44.819, east: 20.462, north: 44.82 } },
];

function expectTiles(actual: TilePlan, expected: readonly Tile[]): void {
  expect(actual.tiles).toHaveLength(expected.length);
  expected.forEach((tile, i) => {
    const got = at(actual.tiles, i);
    expect(got.tileNumber).toBe(tile.tileNumber);
    expectBbox(got.bbox, tile.bbox);
  });
}

function planOf(region: Region): TilePlan {
  return TilePlanSchema.parse(plan(region));
}

function commandIO(
  wikimapia: CrawlWikimapia,
  clock: SimulatedCrawlClock,
  extra: { env?: Record<string, string>; signal?: AbortSignal } = {},
) {
  const output: string[] = [];
  return {
    output,
    io: {
      env: extra.env ?? { WIKIMAPIA_API_KEY: TEST_API_KEY, DATABASE_URL: testUrl },
      write: (line: string) => {
        output.push(line);
      },
      transport: wikimapia.transport,
      clock,
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    },
  };
}

async function runCommand(
  argv: readonly string[],
  responder: Responder,
  extra: { env?: Record<string, string>; signal?: AbortSignal; clock?: SimulatedCrawlClock } = {},
) {
  const clock = extra.clock ?? new SimulatedCrawlClock();
  const wikimapia = new CrawlWikimapia(clock, responder);
  const { output, io } = commandIO(wikimapia, clock, extra);
  const result = CrawlCommandResultSchema.parse(await command(argv, io));
  return { result, output, wikimapia };
}

const smallScript = (s: Omit<Script, 'tiles'> = {}): Responder =>
  scripted({ ...s, tiles: BELGRADE_SMALL_TILES });

// ===========================================================================
// 3.1 Regions and the Tile Plan (US-1, US-2, US-7)
// ===========================================================================

describe('AC-1 Belgrade Regions defined', () => {
  it('a Dry Run of each default Region reports its Bounding Box and Tile Size 0.005 x 0.005', async () => {
    const expected = [
      { name: 'belgrade', bbox: { west: 20.15, south: 44.65, east: 20.75, north: 44.98 } },
      { name: 'belgrade-small', bbox: { west: 20.452, south: 44.814, east: 20.462, north: 44.82 } },
    ];
    for (const region of expected) {
      const { report } = await crawl({
        request: { regionName: region.name, dryRun: true },
        configuration: 'default',
      });
      expect(report.outcome).toBe('planned');
      const reported = TilePlanSchema.parse(report.plan);
      expect(reported.regionName).toBe(region.name);
      expectBbox(reported.bbox, region.bbox);
      expect(reported.tileSize.width).toBeCloseTo(0.005, 9);
      expect(reported.tileSize.height).toBeCloseTo(0.005, 9);
    }
  });

  it('an unknown Region lists exactly the two default Region Names', async () => {
    const { report } = await crawl({
      request: { regionName: 'nowhere' },
      configuration: 'default',
    });
    expect(report.outcome).toBe('failed');
    const names = report.message?.match(/\bbelgrade(?:-[a-z0-9-]+)?\b/g) ?? [];
    expect([...new Set(names)].sort()).toStrictEqual(['belgrade', 'belgrade-small']);
  });
});

describe('AC-2 Grid covers the Region', () => {
  it('belgrade-small has exactly 4 Tiles, in plan order, top row cut back to 44.820', () => {
    const tilePlan = planOf(BELGRADE_SMALL_REGION);
    expect(tilePlan.columns).toBe(2);
    expect(tilePlan.rows).toBe(2);
    expectTiles(tilePlan, BELGRADE_SMALL_TILES);
    expect(findTilePlanIssues(BELGRADE_SMALL_REGION, tilePlan)).toStrictEqual([]);
  });
});

describe('AC-66 Big Belgrade Tile Plan', () => {
  it('has 120 columns x 66 rows = 7,920 Tiles, none cut back, no thin edge Tile', () => {
    const tilePlan = planOf(BELGRADE_REGION);
    expect(tilePlan.columns).toBe(120);
    expect(tilePlan.rows).toBe(66);
    expect(tilePlan.tiles).toHaveLength(7920);
    expectBbox(at(tilePlan.tiles, 0).bbox, {
      west: 20.15,
      south: 44.65,
      east: 20.155,
      north: 44.655,
    });
    expectBbox(at(tilePlan.tiles, 119).bbox, {
      west: 20.745,
      south: 44.65,
      east: 20.75,
      north: 44.655,
    });
    expectBbox(at(tilePlan.tiles, 120).bbox, {
      west: 20.15,
      south: 44.655,
      east: 20.155,
      north: 44.66,
    });
    expectBbox(at(tilePlan.tiles, 7919).bbox, {
      west: 20.745,
      south: 44.975,
      east: 20.75,
      north: 44.98,
    });
    for (const tile of tilePlan.tiles) {
      expect(Math.abs(tile.bbox.east - tile.bbox.west - 0.005)).toBeLessThanOrEqual(
        COORDINATE_TOLERANCE,
      );
      expect(Math.abs(tile.bbox.north - tile.bbox.south - 0.005)).toBeLessThanOrEqual(
        COORDINATE_TOLERANCE,
      );
    }
    expect(findTilePlanIssues(BELGRADE_REGION, tilePlan)).toStrictEqual([]);
  });
});

describe('AC-3 Region smaller than a Tile', () => {
  it('gives exactly 1 Tile equal to the Region', () => {
    const region: Region = {
      name: 'tiny',
      bbox: { west: 20.456, south: 44.816, east: 20.458, north: 44.817 },
      tileSize: { width: 0.005, height: 0.005 },
    };
    const tilePlan = planOf(region);
    expect(tilePlan.tiles).toHaveLength(1);
    expectBbox(at(tilePlan.tiles, 0).bbox, region.bbox);
    expect(at(tilePlan.tiles, 0).tileNumber).toBe(1);
    expect(findTilePlanIssues(region, tilePlan)).toStrictEqual([]);
  });
});

describe('AC-4 Plan is stable', () => {
  it('the same Region gives the identical Tile Plan every time', () => {
    const first = planOf(BELGRADE_SMALL_REGION);
    expect(planOf(BELGRADE_SMALL_REGION)).toStrictEqual(first);
    expect(planOf(structuredClone(BELGRADE_SMALL_REGION))).toStrictEqual(first);
  });
});

describe('AC-67 Tile Size is per Region', () => {
  it('each Region of one Crawl Configuration is planned with its own Tile Size', async () => {
    const a: Region = {
      name: 'region-a',
      bbox: SMALL_BBOX,
      tileSize: { width: 0.005, height: 0.005 },
    };
    const b: Region = {
      name: 'region-b',
      bbox: SMALL_BBOX,
      tileSize: { width: 0.01, height: 0.01 },
    };
    const configuration = testConfiguration({ regions: [a, b] });
    const planA = await crawl({ request: { regionName: 'region-a', dryRun: true }, configuration });
    const planB = await crawl({ request: { regionName: 'region-b', dryRun: true }, configuration });
    const pa = TilePlanSchema.parse(planA.report.plan);
    const pb = TilePlanSchema.parse(planB.report.plan);
    expect(pa.tileSize).toStrictEqual(a.tileSize);
    expect(pb.tileSize).toStrictEqual(b.tileSize);
    expect(pa.tiles).toHaveLength(4);
    expect(pb.tiles).toHaveLength(1);
    expect(findTilePlanIssues(a, pa)).toStrictEqual([]);
    expect(findTilePlanIssues(b, pb)).toStrictEqual([]);
  });
});

describe('AC-5 Unknown Region', () => {
  it('ends Failed naming the Region and the known Region Names; sends nothing, changes nothing', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: 'atlantis' },
      configuration: 'default',
    });
    expect(report.outcome).toBe('failed');
    expect(report.message).toContain('atlantis');
    expect(report.message).toContain('belgrade');
    expect(report.message).toContain('belgrade-small');
    expect(wikimapia.calls).toHaveLength(0);
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    await expectDatabaseUntouched(['atlantis', 'belgrade', 'belgrade-small']);
  });
});

describe('AC-6 Invalid configuration', () => {
  const bad: {
    setting: string;
    configuration?: CrawlConfiguration;
    request?: Partial<CrawlRequest>;
  }[] = [
    {
      setting: 'bbox',
      configuration: testConfiguration({
        regions: [
          { ...REGION_T1, bbox: { west: 20.462, south: 44.814, east: 20.452, north: 44.82 } },
        ],
      }),
    },
    {
      setting: 'tileSize',
      configuration: testConfiguration({
        regions: [{ ...REGION_T1, tileSize: { width: 0, height: 0.005 } }],
      }),
    },
    { setting: 'listingPageSize', configuration: testConfiguration({ listingPageSize: 0 }) },
    { setting: 'listingPageSize', configuration: testConfiguration({ listingPageSize: 101 }) },
    { setting: 'refreshAgeDays', configuration: testConfiguration({ refreshAgeDays: -1 }) },
    {
      setting: 'minRequestIntervalSeconds',
      configuration: testConfiguration({ minRequestIntervalSeconds: Number.NaN }),
    },
    { setting: 'requestBudget', configuration: testConfiguration({ requestBudget: -3 }) },
    { setting: 'requestBudget', request: { requestBudget: Number.NaN } },
    { setting: 'refreshAgeDays', request: { refreshAgeDays: -0.5 } },
  ];

  for (const [i, c] of bad.entries()) {
    it(`case ${String(i + 1)}: an invalid ${c.setting} ends Failed naming it, before any request or change`, async () => {
      const { report, wikimapia } = await crawl({
        request: { regionName: REGION_T1.name, ...c.request },
        responder: scripted({ tiles: T1_TILES }),
        ...(c.configuration === undefined ? {} : { configuration: c.configuration }),
      });
      expect(report.outcome).toBe('failed');
      expect(report.message).toContain(c.setting);
      expect(wikimapia.calls).toHaveLength(0);
      await expectDatabaseUntouched(TEST_REGION_NAMES);
    });
  }
});

describe('AC-7 Missing API Key', () => {
  for (const apiKey of [null, '', '   '] as const) {
    it(`ends Failed saying the API Key is missing (key ${JSON.stringify(apiKey)}); nothing sent or changed`, async () => {
      const { report, wikimapia } = await crawlRegion(REGION_T1, {}, { apiKey });
      expect(report.outcome).toBe('failed');
      expect(report.message).toMatch(/api key/i);
      expect(report.message).toMatch(/missing|not (?:set|configured)|empty/i);
      expect(wikimapia.calls).toHaveLength(0);
      await expectDatabaseUntouched(TEST_REGION_NAMES);
    });
  }
});

// ===========================================================================
// 3.2 Dry Run (US-7)
// ===========================================================================

describe('AC-8 Dry Run plans only', () => {
  it('reports belgrade-small with its 4 Tiles, ends Planned, sends nothing, keeps nothing', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: 'belgrade-small', dryRun: true },
      configuration: 'default',
    });
    expect(report.outcome).toBe('planned');
    expect(report.summary.regionName).toBe('belgrade-small');
    const reported = TilePlanSchema.parse(report.plan);
    expect(reported.regionName).toBe('belgrade-small');
    expectBbox(reported.bbox, BELGRADE_SMALL_REGION.bbox);
    expectTiles(reported, BELGRADE_SMALL_TILES);
    expect(report.runId).toBeUndefined();
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched(['belgrade-small']);
  });
});

describe('AC-68 Dry Run of Big Belgrade', () => {
  it('reports 7,920 Tiles as in AC-66, ends Planned, sends nothing, keeps nothing', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: 'belgrade', dryRun: true },
      configuration: 'default',
    });
    expect(report.outcome).toBe('planned');
    const reported = TilePlanSchema.parse(report.plan);
    expect(reported.tiles).toHaveLength(7920);
    expect(findTilePlanIssues(BELGRADE_REGION, reported)).toStrictEqual([]);
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched(['belgrade']);
  });
});

describe('AC-9 Dry Run needs no key', () => {
  it('succeeds without an API Key', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: 'belgrade-small', dryRun: true },
      configuration: 'default',
      apiKey: null,
    });
    expect(report.outcome).toBe('planned');
    expectTiles(TilePlanSchema.parse(report.plan), BELGRADE_SMALL_TILES);
    expect(wikimapia.calls).toHaveLength(0);
  });
});

describe('AC-10 Dry Run summary', () => {
  it('shows all-zero counts', async () => {
    const { report } = await crawl({
      request: { regionName: 'belgrade-small', dryRun: true },
      configuration: 'default',
    });
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(report.itemFailures).toStrictEqual([]);
  });
});

// ===========================================================================
// 3.3 Listing Phase (US-1, US-2, US-4)
// ===========================================================================

describe('AC-11 Single Short Page finishes a Tile', () => {
  it('asks once (page 1, size 100, the Tile bbox), stores 3 Summary-Only Places, finishes the Tile', async () => {
    const { wikimapia } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      { request: { requestBudget: 1 } },
    );
    expect(wikimapia.listingCalls).toHaveLength(1);
    const call = at(wikimapia.listingCalls, 0);
    expect(call.page).toBe(1);
    expect(call.count).toBe(DEFAULT_LISTING_PAGE_SIZE);
    expectBbox(call.bbox, at(T1_TILES, 0).bbox);
    for (const id of [1381893, 62587, 164369])
      expect((await read(id))?.status).toBe('summary_only');
    const view = await progress(REGION_T1.name);
    expect(finishedPageKeys(view)).toStrictEqual(['tile 1 page 1']);
    expect(at(view.passes, 0).finishedTiles).toStrictEqual([1]);
    expect(at(view.passes, 0).complete).toBe(true);
  });
});

describe('AC-12 Paging until a Short Page', () => {
  it('asks pages 1, 2, 3 in order with size 3, stores all 7 Places, never asks page 4', async () => {
    const { wikimapia, report } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [fullPage(9100), fullPage(9200), fullPage(9300, 1)] } },
      { configuration: testConfiguration({ listingPageSize: 3 }) },
    );
    expect(listingPages(wikimapia.calls, T1_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
      'tile 1 page 3',
    ]);
    for (const c of wikimapia.listingCalls) expect(c.count).toBe(3);
    expect((await counts()).places).toBe(7);
    expect(report.summary.counts.listingPagesSaved).toBe(3);
    expect(at((await progress(REGION_T1.name)).passes, 0).finishedTiles).toStrictEqual([1]);
  });
});

describe('AC-13 Empty page ends a Tile', () => {
  it('records the recorded empty page as Finished Page 2 with no Places and asks no page 3', async () => {
    const { wikimapia } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [fullPage(9100), emptyRecordedPage()] } },
      { configuration: testConfiguration({ listingPageSize: 3 }) },
    );
    expect(listingPages(wikimapia.calls, T1_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
    ]);
    const pass = at((await progress(REGION_T1.name)).passes, 0);
    const page2 = pass.finishedPages.find((p) => p.page === 2);
    expect(page2).toMatchObject({ tileNumber: 1, page: 2, placeCount: 0, short: true });
    expect(pass.finishedTiles).toStrictEqual([1]);
  });
});

describe('AC-14 Page and progress together', () => {
  it('for every injected store failure, a page is saved exactly when it is recorded as finished', async () => {
    let cleanRun = false;
    let sawFailedBeforePage = false;
    let sawFailedAfterPage = false;
    for (let failAt = 1; failAt <= 60 && !cleanRun; failAt += 1) {
      await emptyAll();
      const seen = { injected: false, writes: 0 };
      const { report } = await crawlRegion(
        REGION_T1,
        { listing: { 1: [belgradePage1()] } },
        {
          onWrite: (n) => {
            seen.writes = Math.max(seen.writes, n);
            if (n === failAt) {
              seen.injected = true;
              throw new Error('injected store failure');
            }
          },
        },
      );
      const view = await progress(REGION_T1.name);
      const finished = view.passes.some((p) =>
        p.finishedPages.some((fp) => fp.tileNumber === 1 && fp.page === 1),
      );
      const stored = (await counts()).places;
      expect({ failAt, finished, stored }).toStrictEqual({
        failAt,
        finished,
        stored: finished ? 3 : 0,
      });
      if (seen.injected) {
        expect(report.outcome).toBe('failed');
        if (finished) sawFailedAfterPage = true;
        else sawFailedBeforePage = true;
      } else {
        expect(report.outcome).toBe('completed');
        expect(seen.writes).toBeGreaterThan(0);
        cleanRun = true;
      }
    }
    expect(cleanRun).toBe(true);
    expect(sawFailedBeforePage).toBe(true);
    expect(sawFailedAfterPage).toBe(true);
  }, 180_000);
});

describe('AC-15 All Tiles in plan order', () => {
  it('lists Tiles 1..4 in order, one request each, and finishes all four', async () => {
    const { wikimapia } = await crawlRegion(REGION_T4, {
      listing: {
        1: [listingAnswer(syntheticPlacesIn(at(T4_TILES, 0).bbox, 1, 9401))],
        2: [listingAnswer(syntheticPlacesIn(at(T4_TILES, 1).bbox, 1, 9402))],
        3: [listingAnswer(syntheticPlacesIn(at(T4_TILES, 2).bbox, 1, 9403))],
        4: [listingAnswer(syntheticPlacesIn(at(T4_TILES, 3).bbox, 1, 9404))],
      },
    });
    expect(listingPages(wikimapia.calls, T4_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 2 page 1',
      'tile 3 page 1',
      'tile 4 page 1',
    ]);
    const pass = at((await progress(REGION_T4.name)).passes, 0);
    expect(pass.finishedTiles).toStrictEqual([1, 2, 3, 4]);
    expect(pass.complete).toBe(true);
  });
});

describe('AC-16 Place in two Tiles', () => {
  it('stores Place 62587 once and counts it once in Places listed, without failure', async () => {
    const square = syntheticBoxPlace(62587, 20.4603516, 44.8161006);
    const { report } = await crawlRegion(REGION_T2, {
      listing: { 1: [listingAnswer([square])], 2: [listingAnswer([square])] },
      details: { 62587: detailsAnswer('getbyid-62587.json') },
    });
    expect((await counts()).places).toBe(1);
    expect(report.summary.counts.placesListed).toBe(1);
    expect(report.summary.counts.placesNewlyStored).toBe(1);
    expect(report.summary.counts.itemFailures).toBe(0);
    expect(report.outcome).toBe('completed');
  });
});

describe('AC-17 Failed Listing Page', () => {
  it('tries a Connection Failure 1 + 2 times (waits 30 s, 60 s), counts one Item Failure, goes on', async () => {
    const { report, wikimapia, clock } = await crawlRegion(
      REGION_T2,
      {
        listing: {
          1: [UNREACHABLE],
          2: [listingAnswer(syntheticPlacesIn(at(T2_TILES, 1).bbox, 1, 9501))],
        },
      },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 0 }) },
    );
    const tile1 = wikimapia.listingCalls.filter((c) => tileNumberOf(T2_TILES, c.bbox) === 1);
    expect(tile1).toHaveLength(1 + CONNECTION_RETRY_WAITS_SECONDS.length);
    expect(at(tile1, 1).startedAtMs - at(tile1, 0).startedAtMs).toBe(30 * SECOND);
    expect(at(tile1, 2).startedAtMs - at(tile1, 1).startedAtMs).toBe(60 * SECOND);
    expect(report.summary.counts.itemFailuresByKind.connection).toBe(1);
    expect(report.summary.counts.itemFailures).toBe(1);
    expect(at(report.itemFailures, 0).item).toStrictEqual({
      kind: 'listing_page',
      tileNumber: 1,
      page: 1,
    });
    expect(listingPages(wikimapia.calls, T2_TILES)).toContain('tile 2 page 1');
    expect(at((await progress(REGION_T2.name)).passes, 0).finishedTiles).toStrictEqual([2]);

    const later = await crawlRegion(
      REGION_T2,
      { listing: { 1: [listingAnswer([])] } },
      { clock: new SimulatedCrawlClock(clock.nowMilliseconds + HOUR) },
    );
    expect(listingPages(later.wikimapia.calls, T2_TILES)).toStrictEqual(['tile 1 page 1']);
  });
});

describe('AC-18 Wikimapia Error or Unexpected Response on a page', () => {
  for (const [kind, answerFor] of [
    ['wikimapia_error', wikimapiaErrorAnswer],
    ['unexpected_response', unexpectedAnswer],
  ] as const) {
    it(`a ${kind} is not retried, counts one Item Failure, and the next Tile is listed`, async () => {
      const { report, wikimapia } = await crawlRegion(REGION_T2, {
        listing: { 1: [answerFor()], 2: [listingAnswer([])] },
      });
      expect(listingPages(wikimapia.calls, T2_TILES)).toStrictEqual([
        'tile 1 page 1',
        'tile 2 page 1',
      ]);
      expect(report.summary.counts.itemFailuresByKind[kind]).toBe(1);
      expect(report.summary.counts.itemFailures).toBe(1);
      const pass = at((await progress(REGION_T2.name)).passes, 0);
      expect(pass.finishedTiles).toStrictEqual([2]);
      expect(pass.complete).toBe(false);
    });
  }
});

describe('AC-19 Details Phase follows listing failures', () => {
  it('runs the Details Phase in the same Run although a Tile stayed unfinished', async () => {
    const places = syntheticPlacesIn(at(T2_TILES, 1).bbox, 2, 9601);
    const { report, wikimapia } = await crawlRegion(REGION_T2, {
      listing: { 1: [wikimapiaErrorAnswer()], 2: [listingAnswer(places)] },
    });
    expect(wikimapia.detailsIds).toStrictEqual([9601, 9602]);
    expect(report.summary.counts.detailsSaved).toBe(2);
  });
});

// ===========================================================================
// 3.4 Resuming and repeating (US-4, US-5)
// ===========================================================================

describe('AC-20 Resume after a stop, mid-Tile', () => {
  it('a new Run starts at page 3 and never asks pages 1 or 2 again', async () => {
    const script = { listing: { 1: [fullPage(9100), fullPage(9200), fullPage(9300, 1)] } };
    const configuration = testConfiguration({ listingPageSize: 3 });
    const first = await crawlRegion(REGION_T1, script, {
      configuration,
      request: { requestBudget: 2 },
    });
    expect(first.report.outcome).toBe('budget_reached');
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
    ]);
    const second = await crawlRegion(REGION_T1, script, {
      configuration,
      clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR),
    });
    expect(listingPages(second.wikimapia.calls, T1_TILES)).toStrictEqual(['tile 1 page 3']);
  });
});

describe('AC-21 Resume skips Finished Tiles', () => {
  it('sends nothing for Tiles 1 and 2 finished earlier and continues with Tile 3', async () => {
    const first = await crawlRegion(REGION_T4, {}, { request: { requestBudget: 2 } });
    expect(at((await progress(REGION_T4.name)).passes, 0).finishedTiles).toStrictEqual([1, 2]);
    const second = await crawlRegion(
      REGION_T4,
      {},
      { clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR) },
    );
    expect(listingPages(second.wikimapia.calls, T4_TILES)).toStrictEqual([
      'tile 3 page 1',
      'tile 4 page 1',
    ]);
  });
});

describe('AC-22 Crash between pages', () => {
  it('after a killed Run, page 3 (in flight, not saved) is asked again and page 2 is not', async () => {
    const configuration = testConfiguration({ listingPageSize: 3 });
    const gate = new Gate();
    const killed = new AbortController();
    const crashed = startCrawl({
      request: { regionName: REGION_T1.name },
      configuration,
      signal: killed.signal,
      responder: scripted({
        tiles: T1_TILES,
        listing: { 1: [fullPage(9100), fullPage(9200), { gate }] },
      }),
    });
    await gate.reached;
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
    ]);

    // The killed Run never renews its Last Activity again: more than the Abandonment Age later
    // a new Run takes over (AC-69) and resumes.
    const resumed = await crawlRegion(
      REGION_T1,
      { listing: { 1: [fullPage(9100), fullPage(9200), fullPage(9300, 1)] } },
      {
        configuration,
        clock: new SimulatedCrawlClock(
          crashed.clock.nowMilliseconds + ABANDONMENT_AGE_SECONDS * SECOND + SECOND,
        ),
      },
    );
    expect(listingPages(resumed.wikimapia.calls, T1_TILES)).toStrictEqual(['tile 1 page 3']);
    expect(resumed.report.outcome).toBe('completed');

    killed.abort();
    gate.open(UNREACHABLE);
    await crashed.promise;
  });
});

describe('AC-23 Finished Crawl does only refresh work', () => {
  it('a complete pass with fresh details sends nothing and ends Completed with 0 requests', async () => {
    const first = await crawlRegion(REGION_T1, {
      listing: { 1: [belgradePage1()] },
      details: {
        62587: detailsAnswer('getbyid-62587.json'),
        1381893: detailsAnswer('getbyid-1381893.json'),
      },
    });
    expect(first.report.outcome).toBe('completed');
    const second = await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      { clock: new SimulatedCrawlClock(T0 + DAY) },
    );
    expect(second.wikimapia.calls).toHaveLength(0);
    expect(second.report.outcome).toBe('completed');
    expect(second.report.summary.counts.wikimapiaRequests).toBe(0);
  });
});

describe('AC-24 When listing is done again', () => {
  it('no Listing Phase after a complete pass unless relist is asked; relist starts a separate pass at Tile 1 page 1', async () => {
    const script = { listing: { 1: [belgradePage1()] } };
    const first = await crawlRegion(REGION_T1, script);
    const pass1 = at((await progress(REGION_T1.name)).passes, 0);

    const old = await crawlRegion(REGION_T1, script, {
      clock: new SimulatedCrawlClock(T0 + 400 * DAY),
    });
    expect(old.wikimapia.listingCalls).toHaveLength(0);

    const relisted = await crawlRegion(REGION_T1, script, {
      clock: new SimulatedCrawlClock(T0 + 401 * DAY),
      request: { relist: true },
    });
    expect(at(relisted.wikimapia.calls, 0).fn).toBe('box');
    expect(listingPages(relisted.wikimapia.calls, T1_TILES)).toStrictEqual(['tile 1 page 1']);
    const view = await progress(REGION_T1.name);
    expect(view.passes).toHaveLength(2);
    expect(at(view.passes, 0)).toStrictEqual(pass1);
    const pass2 = at(view.passes, 1);
    expect(pass2.passNumber).toBeGreaterThan(pass1.passNumber);
    expect(pass2.finishedPages.map((p) => p.runId)).toStrictEqual([relisted.report.runId]);
    expect(first.report.runId).not.toBe(relisted.report.runId);
  });
});

describe('AC-25 Region definition changed', () => {
  it('an incomplete pass of an older Tile Plan makes the Run fail with a hint to relist; nothing sent or changed', async () => {
    await crawlRegion(REGION_T2, {}, { request: { requestBudget: 1 } });
    const before = await progress(REGION_T2.name);
    const countsBefore = await counts();
    expect(at(before.passes, 0).complete).toBe(false);

    const changed: Region = { ...REGION_T2, tileSize: { width: 0.005, height: 0.02 } };
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T2.name },
      configuration: testConfiguration({ regions: [changed] }),
      responder: scripted({ tiles: [] }),
      clock: new SimulatedCrawlClock(T0 + DAY),
    });
    expect(report.outcome).toBe('failed');
    expect(report.message).toMatch(/changed/i);
    expect(report.message).toMatch(/relist|new listing pass/i);
    expect(wikimapia.calls).toHaveLength(0);
    expect(await progress(REGION_T2.name)).toStrictEqual(before);
    expect(await counts()).toStrictEqual(countsBefore);
  });
});

describe('AC-26 Regions are independent', () => {
  it('each Region keeps its own progress; Places are shared by Centre Point', async () => {
    const b: Region = {
      name: 'test-b',
      bbox: { west: 20.455, south: 44.812, east: 20.465, north: 44.818 },
      tileSize: { width: 0.02, height: 0.02 },
    };
    const bTiles: Tile[] = [{ tileNumber: 1, bbox: b.bbox }];
    const configuration = testConfiguration({ regions: [REGION_T1, b] });

    await crawlRegion(
      REGION_T1,
      { listing: { 1: [belgradePage1()] } },
      {
        configuration,
        request: { requestBudget: 1 },
      },
    );
    const progressA = await progress(REGION_T1.name);
    expect(await progress('test-b')).toStrictEqual({ regionName: 'test-b', passes: [], runs: [] });

    const runB = await crawl({
      request: { regionName: 'test-b' },
      configuration,
      responder: scripted({ tiles: bTiles }),
      clock: new SimulatedCrawlClock(T0 + HOUR),
    });
    expect(at(runB.wikimapia.calls, 0).fn).toBe('box');
    expect(listingPages(runB.wikimapia.calls, bTiles)).toStrictEqual(['tile 1 page 1']);
    // 62587 and 164369 lie in B; 1381893 (lat 44.8195) does not.
    expect(runB.wikimapia.detailsIds).toStrictEqual([62587, 164369]);
    expect(await progress(REGION_T1.name)).toStrictEqual(progressA);
    expect(at((await progress('test-b')).passes, 0).finishedTiles).toStrictEqual([1]);
  });
});

describe('AC-27 Re-running a Run is safe', () => {
  it('repeating the same work duplicates nothing and every save is Unchanged', async () => {
    const script = {
      listing: { 1: [belgradePage1()] },
      details: {
        62587: detailsAnswer('getbyid-62587.json'),
        1381893: detailsAnswer('getbyid-1381893.json'),
      },
    };
    const first = await crawlRegion(REGION_T1, script);
    expect(first.report.outcome).toBe('completed');
    const before = await counts();
    const second = await crawlRegion(REGION_T1, script, {
      clock: new SimulatedCrawlClock(T0 + DAY),
      request: { relist: true, refreshAgeDays: 0 },
    });
    expect(second.report.outcome).toBe('completed');
    expect(second.report.summary.counts.placesNewlyStored).toBe(0);
    expect(second.report.summary.counts.detailsSaved).toBe(3);
    expect(second.report.summary.counts.detailsChanged).toBe(0);
    expect(await counts()).toStrictEqual(before);
    expect((await readDetailed(62587)).detailsFetchedAt > iso(T0)).toBe(true);
  });
});

// ===========================================================================
// 3.5 Details Phase (US-1, US-3)
// ===========================================================================

describe('AC-28 Details for Summary-Only Places', () => {
  it('requests 62587 then 1381893 and stamps each with the moment its details were received', async () => {
    await seedRecordedSummaries(1381893, 62587);
    const { wikimapia } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: {
        62587: detailsAnswer('getbyid-62587.json'),
        1381893: detailsAnswer('getbyid-1381893.json'),
      },
    });
    expect(wikimapia.detailsIds).toStrictEqual([62587, 1381893]);
    for (const call of wikimapia.detailsCalls) {
      const place = await readDetailed(call.placeId ?? 0);
      expect(place.detailsFetchedAt).toBe(iso(Math.floor(call.startedAtMs / SECOND) * SECOND));
    }
  });
});

describe('AC-29 Details Fetched At is the receive moment', () => {
  it('after a 5-second Rate-Limit Wait the save carries 2026-10-22T09:00:05Z', async () => {
    await seedRecordedSummaries(62587);
    await crawlRegion(
      REGION_T1,
      {
        listing: { 1: [listingAnswer([])] },
        details: { 62587: [rateLimitAnswer(5), detailsAnswer('getbyid-62587.json')] },
      },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 0 }) },
    );
    expect((await readDetailed(62587)).detailsFetchedAt).toBe('2026-10-22T09:00:05Z');
  });
});

describe('AC-30 Fresh details skipped', () => {
  it('details fetched 21 days ago are not requested again', async () => {
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-10-01T09:00:00Z');
    const { wikimapia } = await crawlRegion(REGION_T1, { listing: { 1: [listingAnswer([])] } });
    expect(wikimapia.detailsIds).not.toContain(62587);
  });
});

describe('AC-31 Stale details refreshed', () => {
  it('older than 30 days is requested; exactly 30 days is not', async () => {
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-09-22T08:59:59Z');
    await seedDetails(await clientDetails('getbyid-1381893.json'), '2026-09-22T09:00:00Z');
    const { wikimapia } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: { 62587: detailsAnswer('getbyid-62587.json') },
    });
    expect(wikimapia.detailsIds).toStrictEqual([62587]);
    expect((await readDetailed(62587)).detailsFetchedAt > '2026-10-22').toBe(true);
  });
});

describe('AC-32 Configured Refresh Age', () => {
  it('with Refresh Age 0 every Place fetched before the Run start is due', async () => {
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-10-22T08:59:59Z');
    await seedDetails(await clientDetails('getbyid-1381893.json'), '2026-10-22T09:00:00Z');
    const { wikimapia } = await crawlRegion(
      REGION_T1,
      {
        listing: { 1: [listingAnswer([])] },
        details: { 62587: detailsAnswer('getbyid-62587.json') },
      },
      { request: { refreshAgeDays: 0 } },
    );
    expect(wikimapia.detailsIds).toStrictEqual([62587]);
  });
});

describe('AC-33 Details Order', () => {
  it('requests 300, 900, 1381893, 62587', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(summary(900, p.lon, p.lat), summary(300, p.lon, p.lat));
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-08-01T00:00:00Z');
    await seedDetails(await clientDetails('getbyid-1381893.json'), '2026-07-01T00:00:00Z');
    const { wikimapia } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: {
        62587: detailsAnswer('getbyid-62587.json'),
        1381893: detailsAnswer('getbyid-1381893.json'),
      },
    });
    expect(wikimapia.detailsIds).toStrictEqual([300, 900, 1381893, 62587]);
  });
});

describe('AC-34 Only Region Places', () => {
  it('requests Places whose Centre Point is inside or on the edge, not outside', async () => {
    await seedSummaries(
      summary(9701, 20.457, 44.817),
      summary(9702, 20.47, 44.817),
      summary(9703, 20.452, 44.817),
      summary(9704, 20.462, 44.82),
    );
    const { wikimapia } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: {
        9701: syntheticDetailsAnswer(9701, { lon: 20.457, lat: 44.817 }),
        9703: syntheticDetailsAnswer(9703, { lon: 20.452, lat: 44.817 }),
        9704: syntheticDetailsAnswer(9704, { lon: 20.462, lat: 44.82 }),
      },
    });
    expect(wikimapia.detailsIds).toStrictEqual([9701, 9703, 9704]);
  });
});

describe('R1 Place Store: Places Due for Details of a Region (gap G2)', () => {
  it('lists Summary-Only first by Place ID, then Detailed by oldest fetch, edges included', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(
      summary(900, p.lon, p.lat),
      summary(300, 20.452, 44.82),
      summary(950, 20.47, 44.817),
    );
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-08-01T00:00:00Z');
    await seedDetails(await clientDetails('getbyid-1381893.json'), '2026-07-01T00:00:00Z');
    await seedDetails(syntheticPlaceDetails(700, p.lon, p.lat), '2026-07-01T00:00:00Z');
    await seedDetails(syntheticPlaceDetails(800, p.lon, p.lat), '2026-09-22T09:00:00Z');

    expect(await due(SMALL_BBOX, '2026-09-22T09:00:00Z')).toStrictEqual([
      { placeId: 300 },
      { placeId: 900 },
      { placeId: 700, detailsFetchedAt: '2026-07-01T00:00:00Z' },
      { placeId: 1381893, detailsFetchedAt: '2026-07-01T00:00:00Z' },
      { placeId: 62587, detailsFetchedAt: '2026-08-01T00:00:00Z' },
    ]);
    expect((await due(SMALL_BBOX, '2026-09-22T09:00:01Z')).map((d) => d.placeId)).toContain(800);
    expect(await due(REGION_FAR.bbox, '2026-10-22T09:00:00Z')).toStrictEqual([]);
  });

  it('invalid input is Invalid Data; an unreachable store is Store Unavailable without secrets', async () => {
    const invalid = failureOf(
      PlacesDueResultSchema.parse(
        await crawlStore.listPlacesDueForDetails({ bbox: SMALL_BBOX, dueBefore: 'yesterday' }),
      ),
    );
    expect(invalid.kind).toBe('invalid_data');
    const unreachable = createCrawl({ connectionString: UNREACHABLE_DATABASE_URL });
    try {
      const failure = failureOf(
        PlacesDueResultSchema.parse(
          await unreachable.listPlacesDueForDetails({ bbox: SMALL_BBOX, dueBefore: RUN_START }),
        ),
      );
      expect(failure.kind).toBe('store_unavailable');
      expectNoSecrets(JSON.stringify(failure));
      const progressFailure = failureOf(
        CrawlProgressResultSchema.parse(
          await unreachable.readCrawlProgress({ regionName: 'test-one' }),
        ),
      );
      expect(progressFailure.kind).toBe('store_unavailable');
    } finally {
      await unreachable.close();
    }
  }, 60_000);
});

describe('AC-35 Details Phase without a complete Listing Pass', () => {
  it('covers the Places stored so far', async () => {
    await seedRecordedSummaries(62587);
    const { wikimapia } = await crawlRegion(REGION_T2, {
      listing: { 1: [wikimapiaErrorAnswer()], 2: [listingAnswer([])] },
      details: { 62587: detailsAnswer('getbyid-62587.json') },
    });
    expect(at((await progress(REGION_T2.name)).passes, 0).complete).toBe(false);
    expect(wikimapia.detailsIds).toStrictEqual([62587]);
    expect((await read(62587))?.status).toBe('detailed');
  });
});

describe('AC-36 Failed Place Details', () => {
  it('a Wikimapia Error counts one Item Failure, the Place stays due, the next Place is saved', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(summary(900, p.lon, p.lat));
    await seedRecordedSummaries(62587);
    const { report, wikimapia } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: { 900: wikimapiaErrorAnswer(), 62587: detailsAnswer('getbyid-62587.json') },
    });
    expect(wikimapia.detailsIds).toStrictEqual([900, 62587]);
    expect(report.summary.counts.itemFailuresByKind.wikimapia_error).toBe(1);
    expect(at(report.itemFailures, 0).item).toStrictEqual({ kind: 'place_details', placeId: 900 });
    expect((await read(62587))?.status).toBe('detailed');
    expect((await due(SMALL_BBOX, RUN_START)).map((d) => d.placeId)).toStrictEqual([900]);
    expect(report.summary.counts.placesStillDue).toBe(1);
  });

  it('a Connection Failure gets the same bounded tries and waits as AC-17', async () => {
    const p = CENTRAL_BELGRADE_POINT;
    await seedSummaries(summary(900, p.lon, p.lat));
    await seedRecordedSummaries(62587);
    const { report, wikimapia } = await crawlRegion(
      REGION_T1,
      {
        listing: { 1: [listingAnswer([])] },
        details: { 900: UNREACHABLE, 62587: detailsAnswer('getbyid-62587.json') },
      },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 0 }) },
    );
    const tries = wikimapia.detailsCalls.filter((c) => c.placeId === 900);
    expect(tries).toHaveLength(3);
    expect(at(tries, 1).startedAtMs - at(tries, 0).startedAtMs).toBe(30 * SECOND);
    expect(at(tries, 2).startedAtMs - at(tries, 1).startedAtMs).toBe(60 * SECOND);
    expect(report.summary.counts.itemFailuresByKind.connection).toBe(1);
    expect((await read(62587))?.status).toBe('detailed');
  });
});

describe('AC-37 Deleted Place saved', () => {
  it('details marked deleted are saved and count as a detail saved, not a failure', async () => {
    await seedRecordedSummaries(1381893);
    const deleted = rawDetails('getbyid-1381893.json');
    deleted.is_deleted = true;
    const { report } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: { 1381893: rawDetailsAnswer(deleted) },
    });
    expect((await readDetailed(1381893)).isDeleted).toBe(true);
    expect(report.summary.counts.detailsSaved).toBe(1);
    expect(report.summary.counts.itemFailures).toBe(0);
  });
});

describe('AC-38 Rejected by the Place Store', () => {
  it('Invalid Data counts one Item Failure naming the Place and reason, without Commenter IPs', async () => {
    await seedRecordedSummaries(62587, 1381893);
    const nested = addCommenterIps(rawDetails('getbyid-62587-nested-replies.json'));
    const { report, progressLines, wikimapia } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: { 62587: rawDetailsAnswer(nested), 1381893: detailsAnswer('getbyid-1381893.json') },
    });
    expect(wikimapia.detailsIds).toStrictEqual([62587, 1381893]);
    expect(report.summary.counts.itemFailuresByKind.invalid_data).toBe(1);
    const failure = at(report.itemFailures, 0);
    expect(failure.item).toStrictEqual({ kind: 'place_details', placeId: 62587 });
    expect(failure.failureKind).toBe('invalid_data');
    expect(failure.message).toContain('62587');
    expect(failure.message).toMatch(/comment|repl|place 55/i);
    expect((await read(62587))?.status).toBe('summary_only');
    expect((await read(1381893))?.status).toBe('detailed');
    expect((await due(SMALL_BBOX, RUN_START)).map((d) => d.placeId)).toStrictEqual([62587]);
    expectNoSecrets(await everythingShown(report, progressLines, REGION_T1.name));
  });
});

// ===========================================================================
// 3.6 Pacing, Request Budget and rate limiting (US-6)
// ===========================================================================

describe('AC-39 Minimum Request Interval', () => {
  it('every request starts at least 2 s after the previous one, retries included; the first is not delayed', async () => {
    const places = syntheticPlacesIn(SMALL_BBOX, 4, 9801);
    const { wikimapia } = await crawlRegion(
      REGION_T1,
      {
        listing: { 1: [listingAnswer(places)] },
        details: { 9801: [rateLimitAnswer(0), syntheticDetailsAnswer(9801)] },
      },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 2 }) },
    );
    expect(wikimapia.calls).toHaveLength(6);
    expect(at(wikimapia.calls, 0).startedAtMs).toBe(T0);
    expect(findPacingIssues(wikimapia.startTimes, 2)).toStrictEqual([]);
  });
});

describe('AC-71 Default pacing is half the Wikimapia Quota', () => {
  it('60 requests (with 0-second rate-limit retries): >= 6 s apart, never more than 50 in 5 minutes', async () => {
    const places = syntheticPlacesIn(SMALL_BBOX, 50, 9900);
    const details: Record<number, readonly ReturnType<typeof syntheticDetailsAnswer>[]> = {};
    for (const place of places.slice(0, 9)) {
      const id = Number(place.id);
      details[id] = [rateLimitAnswer(0), syntheticDetailsAnswer(id)];
    }
    const { wikimapia, report } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer(places)] },
      details,
    });
    expect(wikimapia.calls).toHaveLength(60);
    expect(report.summary.counts.wikimapiaRequests).toBe(60);
    expect(
      findPacingIssues(wikimapia.startTimes, DEFAULT_MIN_REQUEST_INTERVAL_SECONDS, {
        windowSeconds: CRAWL_QUOTA_SHARE.windowSeconds,
        maxPerWindow: CRAWL_QUOTA_SHARE.requests,
      }),
    ).toStrictEqual([]);
  }, 60_000);
});

describe('AC-40 Interval and slow answers', () => {
  it('counts the interval from the start of the previous request: a 3-second answer adds no delay', async () => {
    const place = syntheticBoxPlace(9811, 20.457, 44.817);
    const { wikimapia } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [{ delayMs: 3 * SECOND, then: listingAnswer([place]) }] } },
      { configuration: testConfiguration({ minRequestIntervalSeconds: 2 }) },
    );
    expect(wikimapia.calls).toHaveLength(2);
    expect(at(wikimapia.calls, 1).startedAtMs - at(wikimapia.calls, 0).startedAtMs).toBe(
      3 * SECOND,
    );
  });
});

describe('AC-41 Request Budget reached', () => {
  it('sends exactly 3 requests, ends Budget Reached, keeps the work, and the next Run continues', async () => {
    const pages = [
      fullPage(9100),
      fullPage(9200),
      fullPage(9300),
      fullPage(9400),
      fullPage(9500, 1),
    ];
    const configuration = testConfiguration({ listingPageSize: 3 });
    const first = await crawlRegion(
      REGION_T1,
      { listing: { 1: pages } },
      {
        configuration,
        request: { requestBudget: 3 },
      },
    );
    expect(first.wikimapia.calls).toHaveLength(3);
    expect(first.report.outcome).toBe('budget_reached');
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 2',
      'tile 1 page 3',
    ]);
    expect((await counts()).places).toBe(9);
    const next = await crawlRegion(
      REGION_T1,
      { listing: { 1: pages } },
      {
        configuration,
        clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR),
      },
    );
    expect(at(listingPages(next.wikimapia.calls, T1_TILES), 0)).toBe('tile 1 page 4');
  });
});

describe('AC-42 Budget counts Client retries', () => {
  it('a Rate-Limit retry is a request: 3 in total, the first two for the same page', async () => {
    const { wikimapia, report } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [[rateLimitAnswer(1), fullPage(9100)], fullPage(9200), fullPage(9300, 1)] } },
      { configuration: testConfiguration({ listingPageSize: 3 }), request: { requestBudget: 3 } },
    );
    expect(listingPages(wikimapia.calls, T1_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 1 page 1',
      'tile 1 page 2',
    ]);
    expect(wikimapia.calls).toHaveLength(3);
    expect(report.outcome).toBe('budget_reached');
    expect(report.summary.counts.wikimapiaRequests).toBe(3);
    expect(report.summary.counts.rateLimitWaits).toBe(1);
  });
});

describe('AC-43 Budget stops inside a retried request', () => {
  it('no further request; the unfinished page is neither saved nor an Item Failure', async () => {
    const { wikimapia, report } = await crawlRegion(
      REGION_T1,
      { listing: { 1: [fullPage(9100), [rateLimitAnswer(1), fullPage(9200)], fullPage(9300, 1)] } },
      { configuration: testConfiguration({ listingPageSize: 3 }), request: { requestBudget: 2 } },
    );
    expect(wikimapia.calls).toHaveLength(2);
    expect(report.outcome).toBe('budget_reached');
    expect(report.summary.counts.itemFailures).toBe(0);
    expect(report.summary.counts.listingPagesSaved).toBe(1);
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual(['tile 1 page 1']);
    expect((await counts()).places).toBe(3);
  });
});

describe('AC-44 Rate Limit Exhausted stops cleanly', () => {
  it('on a Listing Page: no further request, Rate Limited, nothing half-saved, next Run resumes there', async () => {
    const first = await crawlRegion(REGION_T2, {
      listing: { 1: [rateLimitForever()], 2: [listingAnswer([])] },
    });
    expect(first.report.outcome).toBe('rate_limited');
    expect(first.wikimapia.calls.every((c) => tileNumberOf(T2_TILES, c.bbox) === 1)).toBe(true);
    expect(first.wikimapia.calls.length).toBeGreaterThan(1);
    expect(first.report.summary.counts.itemFailures).toBe(0);
    expect(finishedPageKeys(await progress(REGION_T2.name))).toStrictEqual([]);
    const next = await crawlRegion(
      REGION_T2,
      {},
      { clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR) },
    );
    expect(at(listingPages(next.wikimapia.calls, T2_TILES), 0)).toBe('tile 1 page 1');
  });

  it('on Place Details: earlier work kept, the Place is not saved, the next Run starts with it', async () => {
    await seedRecordedSummaries(62587, 1381893);
    const first = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: { 62587: rateLimitForever(), 1381893: detailsAnswer('getbyid-1381893.json') },
    });
    expect(first.report.outcome).toBe('rate_limited');
    expect(first.wikimapia.detailsIds.every((id) => id === 62587)).toBe(true);
    expect(first.report.summary.counts.itemFailures).toBe(0);
    expect((await read(62587))?.status).toBe('summary_only');
    expect(at((await progress(REGION_T1.name)).passes, 0).finishedTiles).toStrictEqual([1]);
    const next = await crawlRegion(
      REGION_T1,
      { details: { 62587: detailsAnswer('getbyid-62587.json') } },
      { clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR) },
    );
    expect(next.wikimapia.listingCalls).toHaveLength(0);
    expect(at(next.wikimapia.detailsIds, 0)).toBe(62587);
  });
});

describe('AC-45 Clean stops are not failures of the command', () => {
  it('Budget Reached and Rate Limited exit with success and state the outcome', async () => {
    const budget = await runCommand(['--region', 'belgrade-small', '--budget', '1'], smallScript());
    expect(budget.result.report.outcome).toBe('budget_reached');
    expect(budget.result.exitCode).toBe(0);
    expect(budget.output.join('\n')).toContain(
      `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.budget_reached}`,
    );

    await emptyAll();
    const limited = await runCommand(['--region', 'belgrade-small'], () => rateLimitForever());
    expect(limited.result.report.outcome).toBe('rate_limited');
    expect(limited.result.exitCode).toBe(0);
    expect(limited.output.join('\n')).toContain(
      `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.rate_limited}`,
    );
  });
});

// ===========================================================================
// 3.7 Interruption and failures of the whole Run (US-4)
// ===========================================================================

describe('AC-46 Operator interrupt', () => {
  it('starts no new request, keeps the page in hand whole or not at all, ends Interrupted; the next Run continues', async () => {
    const controller = new AbortController();
    const configuration = testConfiguration({ listingPageSize: 3 });
    const first = await crawlRegion(
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
      { configuration, signal: controller.signal },
    );
    expect(first.wikimapia.calls).toHaveLength(2);
    expect(first.report.outcome).toBe('interrupted');
    const finished = finishedPageKeys(await progress(REGION_T1.name));
    const page2Finished = finished.includes('tile 1 page 2');
    expect(finished.includes('tile 1 page 1')).toBe(true);
    expect((await counts()).places).toBe(page2Finished ? 6 : 3);

    const next = await crawlRegion(
      REGION_T1,
      { listing: { 1: [fullPage(9100), fullPage(9200), fullPage(9300, 1)] } },
      { configuration, clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR) },
    );
    expect(at(listingPages(next.wikimapia.calls, T1_TILES), 0)).toBe(
      page2Finished ? 'tile 1 page 3' : 'tile 1 page 2',
    );
  });

  it('a Run interrupted before it starts sends nothing and ends Interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { report, wikimapia } = await crawlRegion(REGION_T1, {}, { signal: controller.signal });
    expect(report.outcome).toBe('interrupted');
    expect(wikimapia.calls).toHaveLength(0);
  });
});

describe('AC-47 Place Store unavailable', () => {
  it('a store failure mid-Run stops requests, ends Failed, and the failed page is not recorded', async () => {
    let storeDown = false;
    const configuration = testConfiguration({ listingPageSize: 3 });
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
        configuration,
        onWrite: () => {
          if (storeDown) throw new Error(`connection to ${UNREACHABLE_DATABASE_URL} lost`);
        },
      },
    );
    expect(report.outcome).toBe('failed');
    expect(wikimapia.calls).toHaveLength(2);
    expect(finishedPageKeys(await progress(REGION_T1.name))).toStrictEqual(['tile 1 page 1']);
    expect((await counts()).places).toBe(3);
    expect(report.summaryText.length).toBeGreaterThan(0);
    expectNoSecrets([JSON.stringify(report), ...progressLines].join('\n'));
  });

  it('an unreachable Place Store ends Failed at once, with a summary and no secrets; the command reports failure', async () => {
    const { report, wikimapia } = await crawlRegion(
      REGION_T1,
      {},
      {
        connectionString: UNREACHABLE_DATABASE_URL,
      },
    );
    expect(report.outcome).toBe('failed');
    expect(wikimapia.calls).toHaveLength(0);
    expectNoSecrets(JSON.stringify(report));

    const viaCommand = await runCommand(['--region', 'belgrade-small'], smallScript(), {
      env: { WIKIMAPIA_API_KEY: TEST_API_KEY, DATABASE_URL: UNREACHABLE_DATABASE_URL },
    });
    expect(viaCommand.result.exitCode).toBe(1);
    expect(viaCommand.wikimapia.calls).toHaveLength(0);
    expectNoSecrets(viaCommand.output.join('\n'));
  }, 60_000);
});

describe('AC-48 Configuration Failure from the Client', () => {
  it('a key the Client cannot use ends the Run Failed without requests', async () => {
    const { report, wikimapia } = await crawlRegion(REGION_T1, {}, { apiKey: ' \t ' });
    expect(report.outcome).toBe('failed');
    expect(wikimapia.calls).toHaveLength(0);
  });
});

describe('AC-49 No secrets in output', () => {
  it('reports, progress lines, Crawl Progress and command output carry no key, key URL, password or Commenter IP', async () => {
    await seedRecordedSummaries(1381893);
    const square = addCommenterIps(rawDetails('getbyid-62587.json'));
    const responder = scripted({
      tiles: T1_TILES,
      listing: { 1: [belgradePage1()] },
      details: {
        62587: rawDetailsAnswer(square),
        1381893: UNREACHABLE,
        164369: wikimapiaErrorAnswer(),
      },
    });
    const { report, progressLines } = await crawl({
      request: { regionName: REGION_T1.name },
      responder,
      configuration: testConfiguration({ minRequestIntervalSeconds: 0 }),
    });
    expect(report.summary.counts.itemFailures).toBe(2);
    expectNoSecrets(await everythingShown(report, progressLines, REGION_T1.name));

    const viaCommand = await runCommand(
      ['--region', 'belgrade-small', '--relist'],
      () => UNREACHABLE,
    );
    expectNoSecrets(viaCommand.output.join('\n'));
    expectNoSecrets(JSON.stringify(viaCommand.result));
  });
});

// ===========================================================================
// 3.8 Run Summary (US-8)
// ===========================================================================

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

describe('AC-50 Summary contents', () => {
  it('a Run Summary carries every item, also for a Run that failed after it started', async () => {
    const { report } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    expect(report.summary.regionName).toBe(REGION_T1.name);
    expect(report.summary.startedAt).toBe(RUN_START);
    expect(Date.parse(report.summary.endedAt)).toBeGreaterThanOrEqual(T0);

    await emptyAll();
    const failed = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
      onWrite: (n) => {
        if (n >= 3) throw new Error('injected');
      },
    });
    expect(failed.report.outcome).toBe('failed');
    expect(failed.report.summary.counts.wikimapiaRequests).toBe(failed.wikimapia.calls.length);
  });
});

describe('AC-51 Counts are exact', () => {
  it('shows exactly the numbers of the AL6 scenario', async () => {
    const { report, wikimapia } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    expect(wikimapia.calls).toHaveLength(5);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts).toStrictEqual(
      counts0({
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
      }),
    );
  });
});

describe('AC-52 Waits from fallback', () => {
  it('a Rate-Limit Response without readable seconds counts the Fallback Wait Time actually waited', async () => {
    await seedRecordedSummaries(62587);
    const { report } = await crawlRegion(REGION_T1, {
      listing: { 1: [listingAnswer([])] },
      details: { 62587: [rateLimitAnswer('a few'), detailsAnswer('getbyid-62587.json')] },
    });
    expect(report.summary.counts.rateLimitWaits).toBe(1);
    expect(report.summary.counts.rateLimitWaitSeconds).toBe(DEFAULT_FALLBACK_WAIT_SECONDS);
  });
});

describe('AC-53 Summary kept', () => {
  it('the Run Record keeps Region, moments, outcome and every summary number', async () => {
    const { report } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    const view = await progress(REGION_T1.name);
    expect(view.runs).toHaveLength(1);
    const record = at(view.runs, 0);
    expect(record.runId).toBe(report.runId);
    expect(record.regionName).toBe(REGION_T1.name);
    expect(record.status).toBe('completed');
    expect(record.startedAt).toBe(report.summary.startedAt);
    expect(record.endedAt).toBe(report.summary.endedAt);
    expect(record.counts).toStrictEqual(report.summary.counts);
  });

  it('a Budget Reached Run is kept as well, and a Dry Run is not', async () => {
    const stopped = await crawlRegion(REGION_T1, {}, { request: { requestBudget: 0 } });
    await crawlRegion(REGION_T1, {}, { request: { dryRun: true } });
    const runs = (await progress(REGION_T1.name)).runs;
    expect(runs.map((r) => [r.runId, r.status])).toStrictEqual([
      [stopped.report.runId, 'budget_reached'],
    ]);
  });
});

describe('AC-54 Summary is readable', () => {
  it('is plain text, one labelled item per line, with every AC-50 item', async () => {
    const { report } = await crawl({
      request: { regionName: REGION_T1.name },
      responder: exactScenario(),
    });
    const lines = report.summaryText.split(/\r?\n/).filter((l) => l.trim() !== '');
    for (const line of lines) expect(line).toMatch(/^[A-Z][^:{}[\]"]*: \S.*$/);
    const text = report.summaryText;
    const c = report.summary.counts;
    expect(text).toContain(`${SUMMARY_LABELS.regionName}: ${REGION_T1.name}`);
    expect(text).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.completed}`);
    expect(text).toContain(`${SUMMARY_LABELS.startedAt}: ${report.summary.startedAt}`);
    expect(text).toContain(`${SUMMARY_LABELS.endedAt}: ${report.summary.endedAt}`);
    const numeric = [
      'wikimapiaRequests',
      'listingRequests',
      'detailsRequests',
      'rateLimitWaits',
      'rateLimitWaitSeconds',
      'listingPagesSaved',
      'tilesFinished',
      'tilesUnfinished',
      'placesListed',
      'placesNewlyStored',
      'detailsSaved',
      'detailsChanged',
      'placesStillDue',
      'itemFailures',
    ] as const;
    for (const key of numeric) expect(lines).toContain(`${SUMMARY_LABELS[key]}: ${String(c[key])}`);
    for (const [kind, label] of Object.entries(ITEM_FAILURE_LABELS)) {
      const n = c.itemFailuresByKind[kind as keyof typeof c.itemFailuresByKind];
      expect(lines).toContain(`${SUMMARY_LABELS.itemFailures} (${label}): ${String(n)}`);
    }
  });
});

// ===========================================================================
// 3.9 Schema Setup for Crawl Progress (US-4)
// ===========================================================================

/**
 * The Crawl Progress tables. Matched by name so that extension-owned tables reported by
 * inspect() (e.g. PostGIS's `spatial_ref_sys`) are not mistaken for crawl storage.
 */
const CRAWL_TABLE_NAMES: readonly string[] = ['crawl_runs', 'crawl_passes', 'crawl_finished_pages'];

function crawlTables(structure: StoreStructure) {
  return structure.tables.filter((t) => CRAWL_TABLE_NAMES.includes(t.name));
}

describe('AC-55 New step, earlier steps untouched', () => {
  it('all steps applied, Crawl Progress storage exists, and applying it kept every stored Place', async () => {
    const structure = await inspect();
    expect(structure.pendingSteps).toStrictEqual([]);
    expect(structure.appliedSteps.length).toBeGreaterThanOrEqual(5);
    expect(crawlTables(structure).length).toBeGreaterThan(0);

    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-10-21T10:00:00Z');
    const before = { counts: await counts(), place: await read(62587) };
    const undone = okValue(SchemaStepsResultSchema.parse(await setup.undoLast())).steps;
    expect(undone).toHaveLength(1);
    expect(okValue(SchemaStepsResultSchema.parse(await setup.apply())).steps).toStrictEqual(undone);
    expect({ counts: await counts(), place: await read(62587) }).toStrictEqual(before);
  });
});

describe('AC-56 Step can be undone', () => {
  afterEach(async () => {
    okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  });

  // Amended by crawl-run1-fixes AC-41: that feature adds a newer step (Failure Records and
  // Explicit Retries), so the Crawl Progress step is reached by undoing newest-first, one step at
  // a time, until the Crawl Progress storage is gone.
  it('undoing it removes the Crawl Progress storage only; applying it again succeeds', async () => {
    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-10-21T10:00:00Z');
    const before = { counts: await counts(), place: await read(62587) };
    const applied = (await inspect()).appliedSteps;
    const undone: string[] = [];
    while (crawlTables(await inspect()).length > 0 && undone.length < applied.length) {
      const steps = okValue(SchemaStepsResultSchema.parse(await setup.undoLast())).steps;
      expect(steps).toStrictEqual([at(applied, applied.length - 1 - undone.length)]);
      undone.push(...steps);
    }
    const after = await inspect();
    expect(after.appliedSteps).toStrictEqual(applied.slice(0, applied.length - undone.length));
    expect(crawlTables(after)).toStrictEqual([]);
    for (const table of Object.values(STORE_TABLES)) {
      expect(after.tables.map((t) => t.name)).toContain(table);
    }
    expect({ counts: await counts(), place: await read(62587) }).toStrictEqual(before);

    expect(okValue(SchemaStepsResultSchema.parse(await setup.apply())).steps).toStrictEqual(
      [...undone].reverse(),
    );
    expect(crawlTables(await inspect()).length).toBeGreaterThan(0);
    expect(await progress(REGION_T1.name)).toStrictEqual({
      regionName: REGION_T1.name,
      passes: [],
      runs: [],
    });
  });
});

describe('AC-57 Test starting state', () => {
  it('every test starts with all steps applied, nothing stored and no Crawl Progress or Run Records', async () => {
    expect((await inspect()).pendingSteps).toStrictEqual([]);
    await expectDatabaseUntouched([...TEST_REGION_NAMES, 'belgrade', 'belgrade-small']);
  });

  it('emptying the Test Database also removes Crawl Progress and Run Records', async () => {
    await crawl({ request: { regionName: REGION_T1.name }, responder: exactScenario() });
    expect((await progress(REGION_T1.name)).runs.length).toBeGreaterThan(0);
    await emptyAll();
    await expectDatabaseUntouched([REGION_T1.name]);
  });
});

describe('AC-58 No Wikimapia content in progress', () => {
  it('Crawl Progress holds names, plans, pages, moments and counts only', async () => {
    const nested = addCommenterIps(rawDetails('getbyid-62587.json'));
    await crawl({
      request: { regionName: REGION_T1.name },
      responder: scripted({
        tiles: T1_TILES,
        listing: { 1: [belgradePage1()] },
        details: { 62587: rawDetailsAnswer(nested) },
      }),
    });
    const text = JSON.stringify(await progress(REGION_T1.name));
    for (const content of [
      'Square of the Republic',
      'University Park',
      'National Theatre',
      'wikimapia.org',
      at(nested.comments, 0).message.slice(0, 20),
      at(nested.comments, 0).name,
      nested.description.slice(0, 20),
    ]) {
      expect(text).not.toContain(content);
    }
    expectNoSecrets(text);
    for (const table of crawlTables(await inspect())) {
      for (const column of table.columns) {
        expect(column.name).not.toMatch(
          /description|message|comment|title|author|user_?ip|outline|polygon/i,
        );
        expect(['geometry', 'geography', 'inet', 'cidr']).not.toContain(column.udtName);
      }
    }
  });
});

// ===========================================================================
// 3.10 Command line and scheduling (US-1, US-5)
// ===========================================================================

describe('AC-59 Command form', () => {
  it('package.json has a `crawl` script run through tsx', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    expect(scripts[CRAWL_SCRIPT.name]).toMatch(new RegExp(`^${CRAWL_SCRIPT.runner}\\s`));
  });

  it('--region with --dry-run plans the default Region', async () => {
    const { result, wikimapia } = await runCommand(
      [CRAWL_COMMAND_OPTIONS.region, 'belgrade-small', CRAWL_COMMAND_OPTIONS.dryRun],
      smallScript(),
    );
    expect(result.report.outcome).toBe('planned');
    expectTiles(TilePlanSchema.parse(result.report.plan), BELGRADE_SMALL_TILES);
    expect(result.exitCode).toBe(0);
    expect(wikimapia.calls).toHaveLength(0);
  });

  it('--budget, --min-interval and --relist apply to that Run with the default Region', async () => {
    const first = await runCommand(
      ['--region', 'belgrade-small', '--budget', '2', '--min-interval', '1'],
      smallScript(),
    );
    expect(first.wikimapia.calls).toHaveLength(2);
    expect(listingPages(first.wikimapia.calls, BELGRADE_SMALL_TILES)).toStrictEqual([
      'tile 1 page 1',
      'tile 2 page 1',
    ]);
    expect(at(first.wikimapia.calls, 0).count).toBe(DEFAULT_LISTING_PAGE_SIZE);
    expect(
      at(first.wikimapia.calls, 1).startedAtMs - at(first.wikimapia.calls, 0).startedAtMs,
    ).toBe(SECOND);
    await runCommand(['--region', 'belgrade-small', '--budget', '10'], smallScript(), {
      clock: new SimulatedCrawlClock(T0 + HOUR),
    });
    const relisted = await runCommand(
      ['--region', 'belgrade-small', '--relist', '--budget', '1'],
      smallScript(),
      { clock: new SimulatedCrawlClock(T0 + 2 * HOUR) },
    );
    expect(listingPages(relisted.wikimapia.calls, BELGRADE_SMALL_TILES)).toStrictEqual([
      'tile 1 page 1',
    ]);
    expect((await progress('belgrade-small')).passes).toHaveLength(2);
  });

  it('--refresh-age overrides the Refresh Age; an invalid value fails naming it', async () => {
    const bad = await runCommand(
      ['--region', 'belgrade-small', '--refresh-age', '-1'],
      smallScript(),
    );
    expect(bad.result.report.outcome).toBe('failed');
    expect(bad.result.report.message).toMatch(/refresh-age|refreshAgeDays/);
    expect(bad.wikimapia.calls).toHaveLength(0);

    await seedDetails(await clientDetails('getbyid-62587.json'), '2026-10-22T08:00:00Z');
    const fresh = await runCommand(
      ['--region', 'belgrade-small', '--refresh-age', '0', '--budget', '10'],
      smallScript({ details: { 62587: detailsAnswer('getbyid-62587.json') } }),
    );
    expect(fresh.wikimapia.detailsIds).toStrictEqual([62587]);
  });
});

describe('AC-60 Missing Region option', () => {
  it('ends Failed with a usage message listing the known Region Names, and sends nothing', async () => {
    const { result, output, wikimapia } = await runCommand([], smallScript());
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    const text = [result.report.message ?? '', ...output].join('\n');
    expect(text).toContain(CRAWL_COMMAND_OPTIONS.region);
    expect(text).toContain('belgrade');
    expect(text).toContain('belgrade-small');
    expect(wikimapia.calls).toHaveLength(0);
    await expectDatabaseUntouched(['belgrade', 'belgrade-small']);
  });
});

describe('AC-61 Scheduler friendly', () => {
  it('exit status: success for Completed and Planned, failure for Failed and Interrupted', async () => {
    const completed = await runCommand(['--region', 'belgrade-small'], smallScript());
    expect(completed.result.report.outcome).toBe('completed');
    expect(completed.result.exitCode).toBe(0);

    const planned = await runCommand(['--region', 'belgrade-small', '--dry-run'], smallScript());
    expect(planned.result.exitCode).toBe(0);

    const failed = await runCommand(['--region', 'atlantis'], smallScript());
    expect(failed.result.report.outcome).toBe('failed');
    expect(failed.result.exitCode).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const interrupted = await runCommand(
      ['--region', 'belgrade-small', '--relist'],
      smallScript(),
      {
        signal: controller.signal,
      },
    );
    expect(interrupted.result.report.outcome).toBe('interrupted');
    expect(interrupted.result.exitCode).toBe(1);
  });
});

describe('AC-62 One Run per Region at a time', () => {
  it('a second Run for a Region with a live Run fails at once and changes nothing; other Regions are not blocked', async () => {
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
    expect(second.wikimapia.calls).toHaveLength(0);
    expect(await progress(REGION_T1.name)).toStrictEqual(before);

    const other = await crawlRegion(REGION_FAR, {});
    expect(other.report.outcome).toBe('completed');

    gate.open(listingAnswer([]));
    const finished = RunReportSchema.parse(await first.promise);
    expect(finished.outcome).toBe('completed');
  });
});

describe('AC-69 Abandoned Run taken over', () => {
  it('a Run silent for more than 1 hour is marked Abandoned and a new Run goes ahead', async () => {
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

    const tooEarly = await crawl({
      request: { regionName: REGION_T1.name },
      responder: scripted({ tiles: T1_TILES }),
      clock: new SimulatedCrawlClock(silentSince + ABANDONMENT_AGE_SECONDS * SECOND),
    });
    expect(tooEarly.report.outcome).toBe('failed');

    const takeover = await crawl({
      request: { regionName: REGION_T1.name },
      responder: scripted({ tiles: T1_TILES, listing: { 1: [belgradePage1()] } }),
      clock: new SimulatedCrawlClock(silentSince + ABANDONMENT_AGE_SECONDS * SECOND + SECOND),
    });
    expect(takeover.report.outcome).toBe('completed');
    expect(listingPages(takeover.wikimapia.calls, T1_TILES)).toStrictEqual(['tile 1 page 1']);
    const old = (await progress(REGION_T1.name)).runs.find((r) => r.runId === zombieRecord.runId);
    expect(old?.status).toBe('abandoned');
    expect(old?.counts).toStrictEqual(zombieRecord.counts);

    killed.abort();
    gate.open(UNREACHABLE);
    await zombie.promise;
  });
});

describe('AC-70 A live Run is never mistaken for abandoned', () => {
  it('renews Last Activity at least every 15 minutes, also through a 3-hour Rate-Limit Wait', async () => {
    const violations: string[] = [];
    let takeoverTried = false;
    const clock = new SimulatedCrawlClock(RUN_START, {
      onSleep: async (atMs, ms) => {
        const view = await progress(REGION_T1.name);
        const live = view.runs.find((r) => r.status === 'in_progress');
        if (live === undefined) {
          violations.push(`no live Run Record at ${iso(atMs)}`);
          return;
        }
        const silence = atMs + ms - Date.parse(live.lastActivity);
        if (silence > MAX_HEARTBEAT_INTERVAL_SECONDS * SECOND + SECOND) {
          violations.push(`silent for ${String(silence / SECOND)} s at ${iso(atMs)}`);
        }
        if (!takeoverTried && atMs - T0 >= 2 * HOUR) {
          takeoverTried = true;
          const intruder = await crawl({
            request: { regionName: REGION_T1.name },
            responder: scripted({ tiles: T1_TILES }),
            clock: new SimulatedCrawlClock(atMs),
          });
          if (intruder.report.outcome !== 'failed' || intruder.wikimapia.calls.length > 0) {
            violations.push(`a Run at ${iso(atMs)} took over the live Run`);
          }
        }
      },
    });
    const { report } = await crawl({
      request: { regionName: REGION_T1.name },
      clock,
      responder: scripted({
        tiles: T1_TILES,
        listing: { 1: [[rateLimitAnswer(3 * 3600), listingAnswer([])]] },
      }),
    });
    expect(violations).toStrictEqual([]);
    expect(takeoverTried).toBe(true);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.rateLimitWaits).toBe(1);
    expect(report.summary.counts.rateLimitWaitSeconds).toBe(3 * 3600);
  }, 60_000);
});

// ===========================================================================
// 3.11 Tests (US-9, .agrules section 4)
// ===========================================================================

describe('AC-63 No live calls', () => {
  it('no test of this file attempted a global fetch (Wikimapia, OpenAI or other)', () => {
    expect(fetchCalls).toStrictEqual([]);
  });
});

describe('AC-64 Test Database only', () => {
  it('the tests use a database named *_test, never DATABASE_URL', () => {
    expect(() => requireTestDatabaseUrl()).not.toThrow();
    const dev = process.env.DATABASE_URL;
    if (dev !== undefined && dev !== '') expect(testUrl).not.toBe(dev);
  });
});

describe('AC-65 No bulk data', () => {
  it('the fixtures folder holds only the small trimmed recordings and its README', () => {
    const dir = new URL('./fixtures/wikimapia/', import.meta.url);
    for (const name of readdirSync(dir)) {
      expect(name).toMatch(/^(?:README\.md|(?:box|getbyid|debug)-[a-z0-9-]+\.json)$/);
      expect(statSync(new URL(name, dir)).size).toBeLessThan(64 * 1024);
    }
  });
});
