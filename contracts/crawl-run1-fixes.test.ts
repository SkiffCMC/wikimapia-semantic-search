/**
 * AL5 CONTRACT TESTS: Crawl Run 1 fixes (behaviour, black box, Test Database).
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261022-crawl-run1-fixes-al6.md (one describe per AC; AC-43,
 *           AC-44 fixture checks live in ./crawl-run1-fixes.schema.test.ts; AC-45 is this file's
 *           red state before AL2)
 * Enforces: .agrules section 0 "Triggered Bugfixing" (failing tests from the Run 1 recordings
 *           first), section 1 (no requests wasted on a used-up Key Quota; resumable), section 2
 *           (every result parsed with its Zod schema), section 3 (Failure Record storage created
 *           by Schema Setup), section 4 (no Commenter IPs, no secrets, recorded fixtures, no live
 *           network, Test Database only, strict types).
 *
 * Subjects under test, never doubled: `createWikimapiaClient` (src/wikimapia/client.ts),
 * `runCrawl` (src/crawl/run-crawl.ts), `runCrawlCommand` (src/crawl/command.ts),
 * `createCrawlStore` (src/db/crawl-store.ts, with the FailureRecordStore reads this feature adds),
 * `createPlaceStore` and `createSchemaSetup` (src/db/). Only the transport (Simulated Wikimapia
 * answering from contracts/fixtures/wikimapia/ or small synthetic answers) and the clock
 * (Simulated Clock) are test doubles.
 *
 * Red state before AL2 (AC-45): the Client reports Places without Tags as Unexpected Responses
 * and the Key Quota Response as a Wikimapia Error; the Crawl knows no Quota Exhausted outcome,
 * no parking counts and no Explicit Retry; `createCrawlStore` has no `readFailureRecords` /
 * `readExplicitRetries` (calls fail with "is not a function").
 */
import { runCrawlCommand } from '../src/crawl/command';
import { runCrawl } from '../src/crawl/run-crawl';
import { createCrawlStore } from '../src/db/crawl-store';
import { createPlaceStore } from '../src/db/place-store';
import { createSchemaSetup } from '../src/db/schema-setup';
import { createWikimapiaClient } from '../src/wikimapia/client';
import {
  CRAWL_ITEM_FAILURES_COLUMNS,
  CRAWL_ITEM_FAILURES_TABLE,
  ExplicitRetriesResultSchema,
  FAILED_AT_UDT_NAME,
  FailureRecordsResultSchema,
  type CreateFailureAwareCrawlStoreFn,
  type ExplicitRetry,
  type FailureRecord,
  type FailureRecordsInput,
} from './crawl-run1-fixes.schema';
import {
  BELGRADE_SMALL_REGION,
  CLEAN_STOP_OUTCOMES,
  CRAWL_COMMAND_OPTIONS,
  CrawlCommandResultSchema,
  CrawlProgressResultSchema,
  DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
  OUTCOME_LABELS,
  PlacesDueResultSchema,
  RunReportSchema,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
  toMoment,
  type CrawlConfiguration,
  type CrawlProgressView,
  type CrawlRequest,
  type Region,
  type RunCounts,
  type RunCrawlCommandFn,
  type RunCrawlFn,
  type RunReport,
  type Tile,
} from './hydration.schema';
import {
  CENTRAL_BELGRADE_POINT,
  CrawlWikimapia,
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
  T2_TILES,
  UNREACHABLE,
  addCommenterIps,
  listingAnswer,
  rateLimitAnswer,
  rateLimitForever,
  rawDetails,
  rawDetailsAnswer,
  syntheticDetailsAnswer,
  syntheticPlacesIn,
  testConfiguration,
  tileNumberOf,
  unexpectedAnswer,
  wikimapiaErrorAnswer,
  type Responder,
  type SimulatedAnswer,
  type WikimapiaCall,
} from './hydration.support';
import {
  EmptyResultSchema,
  PlaceTagLinksResultSchema,
  ReadPlaceResultSchema,
  STORE_TABLES,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  StoreStructureResultSchema,
  TagCatalogueResultSchema,
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
  FETCHED_AT,
  LATER_FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  clientDetails,
  clientListing,
  requireTestDatabaseUrl,
  summaryOf,
} from './storage.support';
import {
  ListPlacesResultSchema,
  PlaceDetailsResultSchema,
  type BoundingBox,
  type ClientFailure,
  type CreateWikimapiaClientFn,
  type ListPlacesResult,
  type PlaceDetails,
  type PlaceDetailsResult,
  type PlaceSummary,
  type RawPlaceDetails,
  type WikimapiaClientOptions,
} from './wikimapia-client.schema';
import {
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  answer,
  at,
  fixtureAnswer,
  keyQuotaAnswer,
  keyQuotaVariant,
  type SimulatedAnswer as ClientAnswer,
} from './wikimapia-client.support';

// Compile-time check: the entry points have the contract's (amended) signatures.
const createClient: CreateWikimapiaClientFn = createWikimapiaClient;
const run: RunCrawlFn = runCrawl;
const command: RunCrawlCommandFn = runCrawlCommand;
const createCrawl: CreateFailureAwareCrawlStoreFn = createCrawlStore;
const createStore: CreatePlaceStoreFn = createPlaceStore;
const createSetup: CreateSchemaSetupFn = createSchemaSetup;

const T0 = Date.parse(RUN_START);
const KEY_QUOTA_MESSAGE = 'Key limit has been reached';

/** Central Belgrade, the bbox of the recorded `box` page. */
const BELGRADE = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 } as const;

/** Centre Points of the Run 1 recordings (AL6 section 0 "Evidence"). */
const KOLARAC = { placeId: 1391132, lon: 20.456339, lat: 44.8191407 } as const;
const ZORAN = { placeId: 8918979, lon: 20.4612287, lat: 44.8164264 } as const;

/** A point inside REGION_FAR (south-west outskirts). */
const FAR_POINT = { lon: 20.305, lat: 44.705 } as const;

/** Every test Region plus `belgrade-small` (for AC-36, AC-40). */
function configurationWithSmall(overrides: Partial<CrawlConfiguration> = {}): CrawlConfiguration {
  return testConfiguration({
    regions: [REGION_T1, REGION_T2, REGION_T4, REGION_FAR, BELGRADE_SMALL_REGION],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: one Test Database, every Schema Setup step applied, emptied before every test
// (AC-42, Hydration AC-57, AC-64)
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let store: PlaceStore;
let crawlStore: ReturnType<CreateFailureAwareCrawlStoreFn>;
/** Every attempted global `fetch` (Wikimapia, OpenAI, anything): must stay empty (AC-46). */
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in crawl-run1-fixes contract tests'));
  });
  testUrl = requireTestDatabaseUrl();
  setup = createSetup({ connectionString: testUrl });
  okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  store = createStore({ connectionString: testUrl });
  crawlStore = createCrawl({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  await crawlStore.close();
  await store.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers: Store reads (every result parsed with its contract schema)
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
  if (report.runId === undefined)
    throw new Error(`Run ended ${report.outcome} without a Run Record`);
  return report.runId;
}

async function recordsOfRun(report: RunReport): Promise<FailureRecord[]> {
  return failureRecords({ runId: runIdOf(report) });
}

async function progress(regionName: string): Promise<CrawlProgressView> {
  return okValue(
    CrawlProgressResultSchema.parse(await crawlStore.readCrawlProgress({ regionName })),
  );
}

async function inspect(): Promise<StoreStructure> {
  return okValue(StoreStructureResultSchema.parse(await setup.inspect()));
}

async function counts() {
  return okValue(StoreCountsResultSchema.parse(await store.countStored()));
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

async function dueIds(bbox: BoundingBox, dueBefore: string): Promise<number[]> {
  return okValue(
    PlacesDueResultSchema.parse(await crawlStore.listPlacesDueForDetails({ bbox, dueBefore })),
  ).places.map((p) => p.placeId);
}

/** A Place Summary as the Client returns it (synthetic, point-sized). */
function summary(placeId: number, point: { lon: number; lat: number }): PlaceSummary {
  const { lon, lat } = point;
  return {
    placeId,
    name: `Synthetic place ${String(placeId)}`,
    url: `http://wikimapia.org/${String(placeId)}/Synthetic-place-${String(placeId)}`,
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

/** Stores Summary-Only Places, at most 50 per Listing Save. */
async function seedSummaries(...places: PlaceSummary[]): Promise<void> {
  for (let i = 0; i < places.length; i += 50) {
    const chunk = places.slice(i, i + 50);
    okValue(
      SaveResultSchema.parse(
        await store.saveListingPage({
          page: 1,
          pageSize: 100,
          totalFound: chunk.length,
          places: chunk,
        }),
      ),
    );
  }
}

async function seedCentral(...ids: number[]): Promise<void> {
  await seedSummaries(...ids.map((id) => summary(id, CENTRAL_BELGRADE_POINT)));
}

async function seedRecordedSummaries(...ids: number[]): Promise<void> {
  const page = await clientListing('box-belgrade-page1.json');
  await seedSummaries(...ids.map((id) => summaryOf(page, id)));
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toMatch(/[?&]key=/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  expect(text).not.toMatch(/user_?ip/i);
  for (const ip of SYNTHETIC_IPS) expect(text).not.toContain(String(ip));
}

function summaryLines(report: RunReport): string[] {
  return report.summaryText.split(/\r?\n/).filter((l) => l.trim() !== '');
}

function counts0(overrides: Partial<RunCounts>): RunCounts {
  return { ...ZERO_RUN_COUNTS, ...overrides };
}

// ---------------------------------------------------------------------------
// Helpers: the Client (part A and B)
// ---------------------------------------------------------------------------

type ExtraClientOptions = Omit<WikimapiaClientOptions, 'apiKey' | 'transport' | 'clock'>;

function clientSetup(
  answers: readonly ClientAnswer[],
  options: ExtraClientOptions & { repeatLast?: boolean } = {},
) {
  const { repeatLast, ...clientOptions } = options;
  const wikimapia = new SimulatedWikimapia(answers, repeatLast === undefined ? {} : { repeatLast });
  const clock = new SimulatedClock();
  const client = createClient({
    apiKey: TEST_API_KEY,
    transport: wikimapia.transport,
    clock,
    ...clientOptions,
  });
  return { wikimapia, clock, client };
}

function okDetails(result: PlaceDetailsResult): PlaceDetails {
  const parsed = PlaceDetailsResultSchema.parse(result);
  if (!parsed.ok) throw new Error(`expected Place Details, got ${JSON.stringify(parsed.failure)}`);
  return parsed.value;
}

/** Asserts a strict failure result (no partial data) of the given kind and returns it. */
function clientFailure<K extends ClientFailure['kind']>(
  result: ListPlacesResult | PlaceDetailsResult,
  kind: K,
): Extract<ClientFailure, { kind: K }> {
  const parsed = PlaceDetailsResultSchema.or(ListPlacesResultSchema).parse(result);
  expect(result).not.toHaveProperty('value');
  if (parsed.ok) throw new Error(`expected a ${kind} failure, got data`);
  expect(parsed.failure.kind).toBe(kind);
  return parsed.failure as Extract<ClientFailure, { kind: K }>;
}

/** The Client's reading of one raw `place.getbyid` answer. */
async function clientReading(raw: RawPlaceDetails | string, placeId: number) {
  const { client } = clientSetup([answer(raw)]);
  return client.getPlaceDetails({ placeId });
}

// ---------------------------------------------------------------------------
// Helpers: the Crawl (parts A, B and C)
// ---------------------------------------------------------------------------

/** Answers for one Run: every `box` request gets `listing` (default: an empty page). */
interface Answers {
  listing?: SimulatedAnswer;
  /** Details answers by Place ID; others get `syntheticDetailsAnswer(id)`. */
  details?: Readonly<Record<number, SimulatedAnswer | readonly SimulatedAnswer[]>>;
}

function respond(a: Answers = {}): Responder {
  return (call: WikimapiaCall) => {
    if (call.fn === 'box') return a.listing ?? listingAnswer([], call.page ?? 1, call.count ?? 100);
    if (call.fn === 'place.getbyid') {
      const id = call.placeId ?? 0;
      const prepared = a.details?.[id];
      if (prepared === undefined) return syntheticDetailsAnswer(id);
      if (!Array.isArray(prepared)) return prepared as SimulatedAnswer;
      const list = prepared as readonly SimulatedAnswer[];
      return at(list, Math.min(call.attempt, list.length) - 1);
    }
    return answer('{"unexpected":true}');
  };
}

interface CrawlExtra {
  request?: Omit<CrawlRequest, 'regionName'>;
  configuration?: CrawlConfiguration;
  clock?: SimulatedCrawlClock;
  apiKey?: string;
  signal?: AbortSignal;
  onWrite?: WriteHook;
  connectionString?: string;
}

/** One Run of `regionName` whose Simulated Clock starts `hours` after RUN_START. */
async function crawlAt(
  region: Region | string,
  hours: number,
  answers: Answers | Responder = {},
  extra: CrawlExtra = {},
) {
  const regionName = typeof region === 'string' ? region : region.name;
  const clock = extra.clock ?? new SimulatedCrawlClock(T0 + hours * HOUR);
  const wikimapia = new CrawlWikimapia(
    clock,
    typeof answers === 'function' ? answers : respond(answers),
  );
  const progressLines: string[] = [];
  const report: RunReport = RunReportSchema.parse(
    await run(
      { regionName, ...extra.request },
      {
        connectionString: extra.connectionString ?? testUrl,
        apiKey: extra.apiKey ?? TEST_API_KEY,
        configuration: extra.configuration ?? configurationWithSmall(),
        transport: wikimapia.transport,
        clock,
        onProgress: (line) => {
          progressLines.push(line);
        },
        ...(extra.signal === undefined ? {} : { signal: extra.signal }),
        ...(extra.onWrite === undefined ? {} : { onWrite: extra.onWrite }),
      },
    ),
  );
  return { report, wikimapia, clock, progressLines };
}

/** A first Run that lists Region T1's only Tile (an empty page): the Listing Pass is complete. */
async function completeListingPass(region: Region = REGION_T1, hours = 0): Promise<void> {
  const { report } = await crawlAt(region, hours);
  expect(report.outcome).toBe('completed');
}

/** `runs` Runs of `region`, one per hour from `firstHour`, each answering `details`. */
async function crawlRuns(
  region: Region | string,
  firstHour: number,
  runs: number,
  answers: Answers,
  extra: CrawlExtra = {},
): Promise<RunReport[]> {
  const reports: RunReport[] = [];
  for (let i = 0; i < runs; i += 1) {
    reports.push((await crawlAt(region, firstHour + i, answers, extra)).report);
  }
  return reports;
}

function listingPages(calls: readonly WikimapiaCall[], tiles: readonly Tile[]): string[] {
  return calls
    .filter((c) => c.fn === 'box')
    .map((c) => `tile ${String(tileNumberOf(tiles, c.bbox))} page ${String(c.page)}`);
}

function finishedPageKeys(view: CrawlProgressView): string[] {
  return (view.passes[0]?.finishedPages ?? []).map(
    (p) => `tile ${String(p.tileNumber)} page ${String(p.page)}`,
  );
}

async function runCommand(argv: readonly string[], responder: Responder, hours: number) {
  const clock = new SimulatedCrawlClock(T0 + hours * HOUR);
  const wikimapia = new CrawlWikimapia(clock, responder);
  const output: string[] = [];
  const result = CrawlCommandResultSchema.parse(
    await command(argv, {
      env: { WIKIMAPIA_API_KEY: TEST_API_KEY, DATABASE_URL: testUrl },
      write: (line) => {
        output.push(line);
      },
      transport: wikimapia.transport,
      clock,
    }),
  );
  return { result, output, wikimapia };
}

/** The scenario of Hydration AC-51 (164369 answered with `debug-error.json`). */
function hydrationAc51Scenario(): Responder {
  return respond({
    listing: fixtureAnswer('box-belgrade-page1.json'),
    details: {
      1381893: fixtureAnswer('getbyid-1381893.json'),
      62587: [rateLimitAnswer(7), fixtureAnswer('getbyid-62587.json')],
      164369: wikimapiaErrorAnswer(),
    },
  });
}

// ===========================================================================
// 3.1 Part A: Places without Tags (Client) (US-1, US-7)
// ===========================================================================

describe('AC-1 Recorded Place without Tags, empty Wikipedia link', () => {
  it('returns 1391132 with no Tags, no Wikipedia link and the recorded values', async () => {
    const raw = rawDetails('getbyid-1391132-no-tags.json');
    const { client, wikimapia } = clientSetup([fixtureAnswer('getbyid-1391132-no-tags.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1391132 }));
    expect(wikimapia.requests).toHaveLength(1);
    expect(place.placeId).toBe(1391132);
    expect(place.title).toBe("Kolarac - Peoples' University and Concert Hall");
    expect(place.description).toBe(raw.description);
    expect(place.tags).toStrictEqual([]);
    expect([place.isBuilding, place.isRegion, place.isDeleted]).toStrictEqual([true, false, false]);
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place.outline).toHaveLength(16);
    expect(place.location.lon).toBe(KOLARAC.lon);
    expect(place.location.lat).toBe(KOLARAC.lat);
    expect(place.location.street).toBe('Studentski Trg');
    expect(place.comments).toStrictEqual([]);
  });
});

describe('AC-2 Recorded Place without Tags or Wikipedia item', () => {
  it('returns 8918979 with no Tags, no Wikipedia link and the title letters unchanged', async () => {
    const { client } = clientSetup([fixtureAnswer('getbyid-8918979-no-tags.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 8918979 }));
    expect(place.placeId).toBe(8918979);
    expect(place.title).toBe('Zoran Đinđić');
    expect(place.description).toBe('Monument in Belgrade.');
    expect(place.tags).toStrictEqual([]);
    expect([place.isBuilding, place.isRegion, place.isDeleted]).toStrictEqual([
      false,
      false,
      false,
    ]);
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place.outline).toHaveLength(4);
    expect(place.location.lon).toBe(ZORAN.lon);
    expect(place.location.lat).toBe(ZORAN.lat);
    expect(place.location.street).toBe('Trg Republike');
    expect(place.comments).toStrictEqual([]);
  });
});

describe('AC-3 Missing, null and empty Tags are the same', () => {
  it('the three variants of 8918979 give identical Place Details with an empty list of Tags', async () => {
    const missing = rawDetails('getbyid-8918979-no-tags.json');
    const empty = { ...rawDetails('getbyid-8918979-no-tags.json'), tags: [] };
    const nullTags = { ...rawDetails('getbyid-8918979-no-tags.json'), tags: null };
    const results = [
      okDetails(await clientReading(missing, 8918979)),
      okDetails(await clientReading(empty, 8918979)),
      okDetails(await clientReading(nullTags, 8918979)),
    ];
    for (const place of results) expect(place.tags).toStrictEqual([]);
    expect(at(results, 1)).toStrictEqual(at(results, 0));
    expect(at(results, 2)).toStrictEqual(at(results, 0));
  });
});

describe('AC-4 Tags still checked when present with a value', () => {
  it.each([
    ['text', 'no tags'],
    ['a number', 5],
    ['a Tag without a title', [{ id: 1 }]],
    ['a Tag with a non-whole id', [{ id: 1.5, title: 'x' }]],
  ])('Tags as %s: Unexpected Response naming `tags`', async (_, tags) => {
    const raw = { ...rawDetails('getbyid-8918979-no-tags.json'), tags };
    const f = clientFailure(
      await clientReading(JSON.stringify(raw), 8918979),
      'unexpected_response',
    );
    expect(f.issues.some((issue) => issue.path[0] === 'tags')).toBe(true);
  });
});

describe('AC-5 Other required items unchanged', () => {
  it('1391132 without its title: Unexpected Response naming the title only', async () => {
    const raw = rawDetails('getbyid-1391132-no-tags.json');
    Reflect.deleteProperty(raw, 'title');
    const f = clientFailure(await clientReading(raw, 1391132), 'unexpected_response');
    expect(f.issues.some((issue) => JSON.stringify(issue.path) === '["title"]')).toBe(true);
    expect(f.issues.some((issue) => issue.path[0] === 'tags')).toBe(false);
  });
});

// ===========================================================================
// 3.2 Part A: Places without Tags (Crawl) (US-1, US-7)
// ===========================================================================

describe('AC-6 Run 1 regression, details saved', () => {
  it('requests 1391132 then 8918979, saves both without Place-Tag Links, 2 saved, 0 failures, no Failure Record', async () => {
    await seedSummaries(summary(KOLARAC.placeId, KOLARAC), summary(ZORAN.placeId, ZORAN));
    const { report, wikimapia } = await crawlAt(REGION_T1, 0, {
      details: {
        [KOLARAC.placeId]: fixtureAnswer('getbyid-1391132-no-tags.json'),
        [ZORAN.placeId]: fixtureAnswer('getbyid-8918979-no-tags.json'),
      },
    });
    expect(wikimapia.detailsIds).toStrictEqual([KOLARAC.placeId, ZORAN.placeId]);
    const kolarac = await readDetailed(KOLARAC.placeId);
    const zoran = await readDetailed(ZORAN.placeId);
    expect(kolarac.tags).toStrictEqual([]);
    expect(zoran.tags).toStrictEqual([]);
    expect(kolarac).not.toHaveProperty('wikipediaUrl');
    expect(report.summary.counts.detailsSaved).toBe(2);
    expect(report.summary.counts.itemFailures).toBe(0);
    expect(await failureRecords({ placeId: KOLARAC.placeId })).toStrictEqual([]);
    expect(await failureRecords({ placeId: ZORAN.placeId })).toStrictEqual([]);
    expect(await recordsOfRun(report)).toStrictEqual([]);
  });
});

describe('AC-7 Tags disappearing become Gone', () => {
  it.each([
    ['removed', (raw: RawPlaceDetails) => Reflect.deleteProperty(raw, 'tags')],
    ['set to null', (raw: RawPlaceDetails) => Object.assign(raw, { tags: null })],
  ])(
    'Tags item %s: link to Tag 194 Gone, Tag kept in the catalogue, Updated',
    async (_, change) => {
      okValue(
        SaveResultSchema.parse(
          await store.savePlaceDetails({
            details: await clientDetails('getbyid-1381893.json'),
            fetchedAt: FETCHED_AT,
          }),
        ),
      );
      const variant = rawDetails('getbyid-1381893.json');
      change(variant);
      const details = okDetails(await clientReading(variant, 1381893));
      expect(details.tags).toStrictEqual([]);
      const saved = okValue(
        SaveResultSchema.parse(
          await store.savePlaceDetails({ details, fetchedAt: LATER_FETCHED_AT }),
        ),
      );
      expect(saved.places).toStrictEqual([{ placeId: 1381893, outcome: 'updated' }]);
      expect(
        okValue(PlaceTagLinksResultSchema.parse(await store.listPlaceTagLinks({ tagId: 194 }))),
      ).toStrictEqual([{ placeId: 1381893, tagId: 194, presence: 'gone' }]);
      expect(okValue(TagCatalogueResultSchema.parse(await store.listTags()))).toContainEqual({
        id: 194,
        title: 'park',
      });
      expect((await readDetailed(1381893)).tags).toStrictEqual([
        { id: 194, title: 'park', presence: 'gone' },
      ]);
    },
  );
});

// ===========================================================================
// 3.3 Part B: Key Quota (Client) (US-2, US-3, US-7)
// ===========================================================================

describe('AC-8 Key Quota recognised, Place Details', () => {
  it('reports Key Quota Exhausted with message and code 1004, after 1 request and no waiting', async () => {
    const { client, wikimapia, clock } = clientSetup([keyQuotaAnswer()], { repeatLast: true });
    const f = clientFailure(
      await client.getPlaceDetails({ placeId: 62587 }),
      'key_quota_exhausted',
    );
    expect(f.wikimapiaMessage).toBe(KEY_QUOTA_MESSAGE);
    expect(f.code).toBe(1004);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

describe('AC-9 Key Quota recognised, Listing Page', () => {
  it('reports Key Quota Exhausted for a Listing Page, after 1 request and no waiting', async () => {
    const { client, wikimapia, clock } = clientSetup([keyQuotaAnswer()], { repeatLast: true });
    const f = clientFailure(
      await client.listPlaces({ bbox: BELGRADE, page: 1 }),
      'key_quota_exhausted',
    );
    expect(f.wikimapiaMessage).toBe(KEY_QUOTA_MESSAGE);
    expect(f.code).toBe(1004);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

describe('AC-10 Not another kind', () => {
  it.each([0, 10])(
    'Retry Limit %i: never a rate limit, Wikimapia Error, Unexpected Response or data',
    async (retryLimit) => {
      const { client, wikimapia, clock } = clientSetup([keyQuotaAnswer()], {
        repeatLast: true,
        retryLimit,
      });
      const details = await client.getPlaceDetails({ placeId: 62587 });
      const listing = await client.listPlaces({ bbox: BELGRADE, page: 1 });
      for (const result of [details, listing]) clientFailure(result, 'key_quota_exhausted');
      expect(wikimapia.requests).toHaveLength(2);
      expect(clock.sleeps).toStrictEqual([]);
    },
  );
});

describe('AC-11 Key Quota during Rate-Limit Retries', () => {
  it('waits 7 s once, sends 2 requests, reports Key Quota Exhausted and retries no further', async () => {
    const { client, wikimapia, clock } = clientSetup([
      rateLimitAnswer(7),
      keyQuotaAnswer(),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    const f = clientFailure(
      await client.getPlaceDetails({ placeId: 62587 }),
      'key_quota_exhausted',
    );
    expect(f.wikimapiaMessage).toBe(KEY_QUOTA_MESSAGE);
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
  });
});

describe('AC-12 Recognised by the code', () => {
  it.each([
    ['an empty message', ''],
    [
      'the rate-limit wording',
      'You have reached the limit for this action. You need to wait for 7 seconds.',
    ],
  ])('code 1004 with %s is Key Quota Exhausted with the message as sent', async (_, message) => {
    const { client, wikimapia, clock } = clientSetup([keyQuotaVariant({ message })], {
      repeatLast: true,
    });
    const f = clientFailure(
      await client.getPlaceDetails({ placeId: 62587 }),
      'key_quota_exhausted',
    );
    expect(f.wikimapiaMessage).toBe(message);
    expect(f.code).toBe(1004);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

describe('AC-13 Other `debug` answers unchanged', () => {
  it.each([
    ['debug-error.json', fixtureAnswer('debug-error.json'), 'Invalid API key.'],
    ['the Key Quota fixture with code 1003', keyQuotaVariant({ code: 1003 }), KEY_QUOTA_MESSAGE],
    ['the Key Quota fixture without its code', keyQuotaVariant({ code: null }), KEY_QUOTA_MESSAGE],
  ])('%s: Wikimapia Error with the message text, not retried', async (_, prepared, message) => {
    const { client, wikimapia, clock } = clientSetup([prepared], { repeatLast: true });
    const f = clientFailure(await client.getPlaceDetails({ placeId: 62587 }), 'wikimapia_error');
    expect(f.wikimapiaMessage).toBe(message);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('debug-rate-limit.json (no code) is still waited for and retried', async () => {
    const { client, wikimapia, clock } = clientSetup([
      rateLimitAnswer(7),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
  });
});

describe('AC-14 No secrets', () => {
  it.each([
    ['Place Details, the key in the message', `Key ${TEST_API_KEY} limit has been reached`],
    [
      'a Listing Page, a request address in the message',
      `Limit reached for https://api.wikimapia.org/?function=box&key=${TEST_API_KEY}`,
    ],
  ])(
    '%s: the failure carries neither the API Key nor a request address with it',
    async (request, message) => {
      const { client } = clientSetup([keyQuotaVariant({ message })]);
      const outcome = request.startsWith('Place')
        ? await client.getPlaceDetails({ placeId: 62587 })
        : await client.listPlaces({ bbox: BELGRADE, page: 1 });
      const json = JSON.stringify(clientFailure(outcome, 'key_quota_exhausted'));
      expect(json).not.toContain(TEST_API_KEY);
      expect(json).not.toMatch(/[?&]key=/);
    },
  );
});

// ===========================================================================
// 3.4 Part B: Key Quota (Crawl) (US-2, US-3, US-7)
// ===========================================================================

describe('AC-15 Clean stop in the Details Phase', () => {
  it('2 requests (300, 900), 300 saved, 900 not saved, not failed, not recorded and still due; Quota Exhausted kept', async () => {
    await completeListingPass();
    await seedCentral(300, 900);
    await seedRecordedSummaries(1381893);
    const { report, wikimapia } = await crawlAt(REGION_T1, 1, {
      details: { 900: keyQuotaAnswer(), 1381893: keyQuotaAnswer() },
    });
    expect(wikimapia.listingCalls).toHaveLength(0);
    expect(wikimapia.detailsIds).toStrictEqual([300, 900]);
    expect((await read(300))?.status).toBe('detailed');
    expect((await read(900))?.status).toBe('summary_only');
    expect(report.outcome).toBe('quota_exhausted');
    expect(CLEAN_STOP_OUTCOMES).toContain(report.outcome);
    expect(report.summary.counts.itemFailures).toBe(0);
    expect(report.itemFailures).toStrictEqual([]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
    expect(await dueIds(SMALL_BBOX, RUN_START)).toStrictEqual([900, 1381893]);
    const record = (await progress(REGION_T1.name)).runs.find((r) => r.runId === report.runId);
    expect(record?.status).toBe('quota_exhausted');
    expect(record?.endedAt).toBe(report.summary.endedAt);
  });
});

describe('AC-16 Clean stop in the Listing Phase', () => {
  it('1 request, page not finished, no Tile 2, no Details Phase, no failure; the next Run starts at Tile 1 page 1', async () => {
    await seedCentral(900);
    const first = await crawlAt(REGION_T2, 0, { listing: keyQuotaAnswer() });
    expect(first.wikimapia.calls).toHaveLength(1);
    expect(listingPages(first.wikimapia.calls, T2_TILES)).toStrictEqual(['tile 1 page 1']);
    expect(first.wikimapia.detailsCalls).toHaveLength(0);
    expect(finishedPageKeys(await progress(REGION_T2.name))).toStrictEqual([]);
    expect(first.report.summary.counts.itemFailures).toBe(0);
    expect(await recordsOfRun(first.report)).toStrictEqual([]);
    expect(first.report.outcome).toBe('quota_exhausted');

    const next = await crawlAt(
      REGION_T2,
      0,
      {},
      {
        clock: new SimulatedCrawlClock(first.clock.nowMilliseconds + HOUR),
      },
    );
    expect(at(listingPages(next.wikimapia.calls, T2_TILES), 0)).toBe('tile 1 page 1');
  });
});

describe('AC-17 Run 1 regression, no wasted requests', () => {
  it('112 due Places, quota used up: each Run sends exactly 1 request, ends Quota Exhausted, waits for no reset', async () => {
    await completeListingPass();
    const places = syntheticPlacesIn(SMALL_BBOX, 112, 20001).map((p) =>
      summary(Number(p.id), p.location),
    );
    await seedSummaries(...places);
    expect(await dueIds(SMALL_BBOX, RUN_START)).toHaveLength(112);
    for (const hours of [1, 2]) {
      const { report, wikimapia, clock } = await crawlAt(REGION_T1, hours, () => keyQuotaAnswer());
      expect(wikimapia.calls).toHaveLength(1);
      expect(report.outcome).toBe('quota_exhausted');
      expect(report.summary.counts.itemFailures).toBe(0);
      expect(clock.sleeps.every((s) => s.ms <= DEFAULT_MIN_REQUEST_INTERVAL_SECONDS * SECOND)).toBe(
        true,
      );
    }
  });
});

describe('AC-18 Counted like any request', () => {
  it('the Key Quota request counts in the requests and the budget; the Summary states the outcome and Wikimapia message', async () => {
    await completeListingPass();
    await seedCentral(300, 900);
    const { report, wikimapia } = await crawlAt(
      REGION_T1,
      1,
      { details: { 900: keyQuotaAnswer() } },
      { request: { requestBudget: 2 } },
    );
    expect(wikimapia.calls).toHaveLength(2);
    expect(report.outcome).toBe('quota_exhausted');
    expect(report.summary.counts.wikimapiaRequests).toBe(2);
    expect(report.summary.counts.detailsRequests).toBe(2);
    const lines = summaryLines(report);
    expect(lines).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`);
    expect(lines).toContain(`${SUMMARY_LABELS.wikimapiaMessage}: ${KEY_QUOTA_MESSAGE}`);
    expect(report.message).toContain(KEY_QUOTA_MESSAGE);

    await emptyAll();
    const listing = await crawlAt(REGION_T2, 1, { listing: keyQuotaAnswer() });
    expect(listing.report.summary.counts.listingRequests).toBe(1);
    expect(listing.report.summary.counts.wikimapiaRequests).toBe(1);
  });
});

describe('AC-19 Reported as success to the scheduler', () => {
  it('the Crawl Command exits with success for Quota Exhausted', async () => {
    const { result, output, wikimapia } = await runCommand(
      [CRAWL_COMMAND_OPTIONS.region, 'belgrade-small'],
      () => keyQuotaAnswer(),
      0,
    );
    expect(wikimapia.calls).toHaveLength(1);
    expect(result.report.outcome).toBe('quota_exhausted');
    expect(result.exitCode).toBe(0);
    expect(output.join('\n')).toContain(
      `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`,
    );
  });
});

describe('AC-20 Interaction with other stops', () => {
  it('a Key Quota answer to a Connection Failure try ends the tries and the Run; Last Activity and Run Record written', async () => {
    await completeListingPass();
    await seedCentral(900, 901);
    const { report, wikimapia } = await crawlAt(REGION_T1, 1, {
      details: { 900: [UNREACHABLE, keyQuotaAnswer(), syntheticDetailsAnswer(900)] },
    });
    expect(wikimapia.detailsIds).toStrictEqual([900, 900]);
    expect(report.outcome).toBe('quota_exhausted');
    expect(report.summary.counts.itemFailures).toBe(0);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
    const record = (await progress(REGION_T1.name)).runs.find((r) => r.runId === report.runId);
    expect(record?.status).toBe('quota_exhausted');
    expect(record?.endedAt).toBe(report.summary.endedAt);
    expect(Date.parse(record?.lastActivity ?? '')).toBeGreaterThanOrEqual(
      Date.parse(report.summary.startedAt),
    );
  });
});

// ===========================================================================
// 3.5 Part C: Failure Records (US-4)
// ===========================================================================

describe('AC-21 One Failure Record per Item Failure', () => {
  it('a Place Details failure: Run, Place ID, kind, the message as shown, the moment it was concluded', async () => {
    await seedCentral(900);
    const { report, wikimapia } = await crawlAt(REGION_T1, 0, {
      details: { 900: { delayMs: 2500, then: wikimapiaErrorAnswer() } },
    });
    const call = at(wikimapia.detailsCalls, 0);
    const shown = at(report.itemFailures, 0);
    const expected: FailureRecord = {
      runId: runIdOf(report),
      item: { kind: 'place_details', placeId: 900 },
      failureKind: 'wikimapia_error',
      message: shown.message,
      failedAt: toMoment(new Date(call.startedAtMs + 2500)),
    };
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([expected]);
    expect(await recordsOfRun(report)).toStrictEqual([expected]);
  });

  it('a Listing Page failure: Tile Number and Page Number', async () => {
    const { report, wikimapia } = await crawlAt(REGION_T2, 0, {
      listing: wikimapiaErrorAnswer(),
    });
    expect(report.summary.counts.itemFailures).toBe(2);
    const records = await recordsOfRun(report);
    expect(records).toStrictEqual(
      report.itemFailures.map((f, i) => ({
        runId: runIdOf(report),
        item: f.item,
        failureKind: f.failureKind,
        message: f.message,
        failedAt: toMoment(new Date(at(wikimapia.listingCalls, i).startedAtMs)),
      })),
    );
    expect(records.map((r) => r.item)).toStrictEqual([
      { kind: 'listing_page', tileNumber: 1, page: 1 },
      { kind: 'listing_page', tileNumber: 2, page: 1 },
    ]);
  });
});

describe('AC-22 Hydration Run Summary scenario', () => {
  it('exactly 1 record: Place 164369, this Run, Wikimapia Error, message with "Invalid API key.", moment M; AC-51 numbers unchanged', async () => {
    const { report, wikimapia } = await crawlAt(REGION_T1, 0, hydrationAc51Scenario());
    const m = at(
      wikimapia.detailsCalls.filter((c) => c.placeId === 164369),
      0,
    ).startedAtMs;
    const records = await recordsOfRun(report);
    expect(records).toHaveLength(1);
    const record = at(records, 0);
    expect(record.item).toStrictEqual({ kind: 'place_details', placeId: 164369 });
    expect(record.runId).toBe(report.runId);
    expect(record.failureKind).toBe('wikimapia_error');
    expect(record.message).toContain('164369');
    expect(record.message).toContain('Invalid API key.');
    expect(record.failedAt).toBe(toMoment(new Date(m)));
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

describe('AC-23 Connection Failure tries are one record', () => {
  it('1 + 2 tries on Tile 1 page 1 give exactly 1 Connection Failure record at the moment of the last try', async () => {
    const { report, wikimapia } = await crawlAt(
      REGION_T2,
      0,
      (call) =>
        call.fn === 'box' && tileNumberOf(T2_TILES, call.bbox) === 1
          ? UNREACHABLE
          : listingAnswer([], call.page ?? 1, call.count ?? 100),
      { configuration: configurationWithSmall({ minRequestIntervalSeconds: 0 }) },
    );
    const tries = wikimapia.listingCalls.filter((c) => tileNumberOf(T2_TILES, c.bbox) === 1);
    expect(tries).toHaveLength(3);
    const records = await recordsOfRun(report);
    expect(records).toHaveLength(1);
    const record = at(records, 0);
    expect(record.item).toStrictEqual({ kind: 'listing_page', tileNumber: 1, page: 1 });
    expect(record.failureKind).toBe('connection');
    expect(record.failedAt).toBe(toMoment(new Date(at(tries, 2).startedAtMs)));
  });
});

describe('AC-24 What is not recorded', () => {
  const interruptAt900 = (): Parameters<typeof crawlAt> => {
    const controller = new AbortController();
    const interrupt = {
      effect: () => {
        controller.abort();
      },
      then: syntheticDetailsAnswer(900),
    };
    return [REGION_T1, 0, { details: { 900: interrupt } }, { signal: controller.signal }];
  };

  it.each<[string, () => Parameters<typeof crawlAt>, RunReport['outcome']]>([
    [
      'Rate Limit Exhausted',
      () => [REGION_T1, 0, { details: { 900: rateLimitForever() } }],
      'rate_limited',
    ],
    ['a Configuration Failure', () => [REGION_T1, 0, {}, { apiKey: ' \t ' }], 'failed'],
    [
      'the Request Budget reached during a request',
      () => [
        REGION_T1,
        0,
        { details: { 900: [rateLimitAnswer(1), wikimapiaErrorAnswer()] } },
        { request: { requestBudget: 2 } },
      ],
      'budget_reached',
    ],
    ['an Operator interrupt', interruptAt900, 'interrupted'],
    [
      'an unavailable Place Store',
      () => [REGION_T1, 0, {}, { connectionString: UNREACHABLE_DATABASE_URL }],
      'failed',
    ],
    ['a Dry Run', () => [REGION_T1, 0, {}, { request: { dryRun: true } }], 'planned'],
  ])(
    '%s keeps no Failure Record',
    async (_, args, outcome) => {
      await seedCentral(900, 901);
      const { report } = await crawlAt(...args());
      expect(report.outcome).toBe(outcome);
      expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
      if (report.runId !== undefined) expect(await recordsOfRun(report)).toStrictEqual([]);
    },
    60_000,
  );
});

describe('AC-25 Kept across Runs', () => {
  it('a later success, later Runs and an Explicit Retry leave earlier Failure Records unchanged', async () => {
    await seedCentral(900);
    await crawlAt(REGION_T1, 0, { details: { 900: wikimapiaErrorAnswer() } });
    const kept = await failureRecords({ placeId: 900 });
    expect(kept).toHaveLength(1);
    const saved = await crawlAt(REGION_T1, 1);
    expect(saved.report.summary.counts.detailsSaved).toBe(1);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual(kept);
    await crawlAt(REGION_T1, 2, { listing: keyQuotaAnswer() }, { request: { relist: true } });
    await crawlAt(REGION_T1, 3, {}, { request: { retryParked: true } });
    await crawlAt(REGION_T1, 31 * 24, { details: { 900: unexpectedAnswer() } });
    const later = await failureRecords({ placeId: 900 });
    expect(later).toHaveLength(2);
    expect(at(later, 0)).toStrictEqual(at(kept, 0));
  });
});

describe('AC-26 Readable afterwards', () => {
  it('by Place and by Run, with every item, oldest first', async () => {
    await seedCentral(900, 901);
    const first = await crawlAt(REGION_T1, 0, {
      details: { 900: wikimapiaErrorAnswer(), 901: unexpectedAnswer() },
    });
    const second = await crawlAt(REGION_T1, 1, { details: { 900: unexpectedAnswer() } });
    const of900 = await failureRecords({ placeId: 900 });
    expect(of900.map((r) => [r.runId, r.failureKind])).toStrictEqual([
      [first.report.runId, 'wikimapia_error'],
      [second.report.runId, 'unexpected_response'],
    ]);
    expect(Date.parse(at(of900, 0).failedAt)).toBeLessThan(Date.parse(at(of900, 1).failedAt));
    const ofFirst = await recordsOfRun(first.report);
    expect(ofFirst.map((r) => r.item)).toStrictEqual([
      { kind: 'place_details', placeId: 900 },
      { kind: 'place_details', placeId: 901 },
    ]);
    expect(ofFirst.map((r) => r.message)).toStrictEqual(
      first.report.itemFailures.map((f) => f.message),
    );
    expect((await recordsOfRun(second.report)).map((r) => r.item)).toStrictEqual([
      { kind: 'place_details', placeId: 900 },
    ]);
  });
});

describe('AC-27 No secrets or personal data', () => {
  it('records of Invalid Data with Commenter IPs, a message with the key and a Connection Failure carry no secrets', async () => {
    await seedRecordedSummaries(62587);
    await seedCentral(900, 901);
    const nested = addCommenterIps(rawDetails('getbyid-62587-nested-replies.json'));
    const { report } = await crawlAt(
      REGION_T1,
      0,
      {
        details: {
          62587: rawDetailsAnswer(nested),
          900: answer({ debug: { message: `Key ${TEST_API_KEY} is not valid` } }),
          901: UNREACHABLE,
        },
      },
      { configuration: configurationWithSmall({ minRequestIntervalSeconds: 0 }) },
    );
    const records = await recordsOfRun(report);
    expect(records.map((r) => [r.item, r.failureKind])).toStrictEqual([
      [{ kind: 'place_details', placeId: 900 }, 'wikimapia_error'],
      [{ kind: 'place_details', placeId: 901 }, 'connection'],
      [{ kind: 'place_details', placeId: 62587 }, 'invalid_data'],
    ]);
    const invalid = at(records, 2);
    expect(invalid.message).toContain('62587');
    expect(invalid.message).toMatch(/comment|repl|place 55/i);
    expectNoSecrets(JSON.stringify(records));
  });
});

describe('AC-28 Record and failure together', () => {
  it('when the Failure Record cannot be kept, the Run ends Failed and no record half-exists', async () => {
    await seedCentral(900, 901);
    let storeDown = false;
    const { report, wikimapia } = await crawlAt(
      REGION_T1,
      0,
      {
        details: {
          900: {
            effect: () => {
              storeDown = true;
            },
            then: wikimapiaErrorAnswer(),
          },
        },
      },
      {
        onWrite: () => {
          if (storeDown) throw new Error(`connection to ${UNREACHABLE_DATABASE_URL} lost`);
        },
      },
    );
    expect(report.outcome).toBe('failed');
    expect(wikimapia.detailsIds).toStrictEqual([900]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
    expectNoSecrets(JSON.stringify(report));
  });
});

// ===========================================================================
// 3.6 Part C: Parking and Explicit Retry (US-5, US-6)
// ===========================================================================

describe('AC-29 Third failure of the same kind parks the Place', () => {
  it('the third Wikimapia Error parks 900; the fourth Run sends no request for it', async () => {
    await seedCentral(900);
    const [, , third] = await crawlRuns(REGION_T1, 0, 3, {
      details: { 900: wikimapiaErrorAnswer() },
    });
    expect(await failureRecords({ placeId: 900 })).toHaveLength(3);
    expect(third?.summary.counts.placesParkedThisRun).toBe(1);
    expect(third?.summary.counts.placesParked).toBe(1);
    expect(third?.summary.counts.placesStillDue).toBe(0);
    const fourth = await crawlAt(REGION_T1, 3);
    expect(fourth.wikimapia.detailsIds).not.toContain(900);
    expect((await read(900))?.status).toBe('summary_only');
  });
});

describe('AC-30 Counting spans Runs', () => {
  it('failures in Runs of three different Regions park the Place for all of them', async () => {
    await seedCentral(900);
    for (const [i, region] of [REGION_T1, REGION_T4, REGION_T2].entries()) {
      const { wikimapia } = await crawlAt(region, i, { details: { 900: wikimapiaErrorAnswer() } });
      expect(wikimapia.detailsIds).toStrictEqual([900]);
    }
    const next = await crawlAt(REGION_T1, 3);
    expect(next.wikimapia.detailsIds).not.toContain(900);
  });
});

describe('AC-31 Same kind only, not necessarily consecutive', () => {
  it('2 + 2 alternating kinds do not park; the next failure of either kind does', async () => {
    await seedCentral(900);
    const alternating = [
      wikimapiaErrorAnswer(),
      unexpectedAnswer(),
      wikimapiaErrorAnswer(),
      unexpectedAnswer(),
    ];
    for (const [i, prepared] of alternating.entries()) {
      await crawlAt(REGION_T1, i, { details: { 900: prepared } });
    }
    const fifth = await crawlAt(REGION_T1, 4, { details: { 900: wikimapiaErrorAnswer() } });
    expect(fifth.wikimapia.detailsIds).toStrictEqual([900]);
    expect(fifth.report.summary.counts.placesParkedThisRun).toBe(1);
    const sixth = await crawlAt(REGION_T1, 5);
    expect(sixth.wikimapia.detailsIds).not.toContain(900);
  });
});

describe('AC-32 Connection Failures do not park', () => {
  it('3 Connection Failure records do not park; the records are kept', async () => {
    await seedCentral(900);
    await crawlRuns(
      REGION_T1,
      0,
      3,
      { details: { 900: UNREACHABLE } },
      { configuration: configurationWithSmall({ minRequestIntervalSeconds: 0 }) },
    );
    const records = await failureRecords({ placeId: 900 });
    expect(records.map((r) => r.failureKind)).toStrictEqual([
      'connection',
      'connection',
      'connection',
    ]);
    const fourth = await crawlAt(REGION_T1, 3);
    expect(fourth.wikimapia.detailsIds).toStrictEqual([900]);
  });

  it('Invalid Data does count', async () => {
    await seedRecordedSummaries(62587);
    const nested = rawDetails('getbyid-62587-nested-replies.json');
    await crawlRuns(REGION_T1, 0, 3, { details: { 62587: rawDetailsAnswer(nested) } });
    expect((await failureRecords({ placeId: 62587 })).map((r) => r.failureKind)).toStrictEqual([
      'invalid_data',
      'invalid_data',
      'invalid_data',
    ]);
    const fourth = await crawlAt(REGION_T1, 3);
    expect(fourth.wikimapia.detailsIds).not.toContain(62587);
  });
});

describe('AC-33 Success resets the count', () => {
  it('2 errors, a successful save, then 1 error after the Refresh Age: not Parked', async () => {
    await seedCentral(900);
    await crawlRuns(REGION_T1, 0, 2, { details: { 900: wikimapiaErrorAnswer() } });
    const saved = await crawlAt(REGION_T1, 2);
    expect(saved.report.summary.counts.detailsSaved).toBe(1);
    const stale = await crawlAt(REGION_T1, 31 * 24, { details: { 900: wikimapiaErrorAnswer() } });
    expect(stale.wikimapia.detailsIds).toStrictEqual([900]);
    expect(stale.report.summary.counts.placesParkedThisRun).toBe(0);
    const next = await crawlAt(REGION_T1, 31 * 24 + 1, {
      details: { 900: wikimapiaErrorAnswer() },
    });
    expect(next.wikimapia.detailsIds).toStrictEqual([900]);
    expect(await failureRecords({ placeId: 900 })).toHaveLength(4);
  });
});

describe('AC-34 Listing Pages are never parked', () => {
  it('Tile 1 page 1 with 3 Wikimapia Error records is still asked for', async () => {
    const reports = await crawlRuns(REGION_T1, 0, 3, { listing: wikimapiaErrorAnswer() });
    for (const report of reports) {
      expect((await recordsOfRun(report)).map((r) => r.item)).toStrictEqual([
        { kind: 'listing_page', tileNumber: 1, page: 1 },
      ]);
    }
    const fourth = await crawlAt(REGION_T1, 3);
    expect(at(fourth.wikimapia.calls, 0).fn).toBe('box');
    expect(at(fourth.wikimapia.calls, 0).page).toBe(1);
  });
});

describe('AC-35 Parked Places are not due', () => {
  it('only 300 is requested; 900 counts as parked, not as still due', async () => {
    await seedCentral(900);
    await crawlRuns(REGION_T1, 0, 3, { details: { 900: wikimapiaErrorAnswer() } });
    await seedCentral(300);
    const { report, wikimapia } = await crawlAt(REGION_T1, 3);
    expect(wikimapia.detailsIds).toStrictEqual([300]);
    expect(report.summary.counts.placesParked).toBe(1);
    expect(report.summary.counts.placesStillDue).toBe(0);
    expect(report.summary.counts.placesParkedThisRun).toBe(0);
  });

  it('when every due Place is Parked, no details request is sent and the Run ends Completed', async () => {
    await seedCentral(900);
    await crawlRuns(REGION_T1, 0, 3, { details: { 900: wikimapiaErrorAnswer() } });
    const { report, wikimapia } = await crawlAt(REGION_T1, 3);
    expect(wikimapia.calls).toHaveLength(0);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.placesParked).toBe(1);
  });
});

describe('AC-36 Parking belongs to the Place', () => {
  it('62587, Parked by Runs of other Regions that hold it, is not requested by a `belgrade-small` Run', async () => {
    await seedRecordedSummaries(62587);
    for (const [i, region] of [REGION_T1, REGION_T2, REGION_T4].entries()) {
      await crawlAt(region, i, { details: { 62587: wikimapiaErrorAnswer() } });
    }
    const { wikimapia, report } = await crawlAt(BELGRADE_SMALL_REGION.name, 3);
    expect(wikimapia.listingCalls.length).toBeGreaterThan(0);
    expect(wikimapia.detailsIds).not.toContain(62587);
    expect(report.summary.counts.placesParked).toBe(1);
  });
});

describe('AC-37 Explicit Retry releases the Region’s Parked Places', () => {
  it('releases 900 and 901 of Region T at the start, requests them, keeps 902 outside Parked, records the retry', async () => {
    await seedCentral(900, 901);
    await seedSummaries(summary(902, FAR_POINT));
    await crawlRuns(REGION_T1, 0, 3, {
      details: { 900: wikimapiaErrorAnswer(), 901: wikimapiaErrorAnswer() },
    });
    await crawlRuns(REGION_FAR, 3, 3, { details: { 902: wikimapiaErrorAnswer() } });
    await seedCentral(300);

    const retry = await crawlAt(REGION_T1, 6, {}, { request: { retryParked: true } });
    expect(retry.wikimapia.detailsIds).toStrictEqual([300, 900, 901]);
    expect(retry.report.summary.counts.placesReleased).toBe(2);
    expect(retry.report.summary.counts.placesParked).toBe(0);
    expect((await read(900))?.status).toBe('detailed');
    expect(await explicitRetries(REGION_T1.name)).toStrictEqual([
      {
        runId: runIdOf(retry.report),
        regionName: REGION_T1.name,
        retriedAt: retry.report.summary.startedAt,
        placesReleased: 2,
      },
    ]);
    expect(await explicitRetries(REGION_FAR.name)).toStrictEqual([]);

    const far = await crawlAt(REGION_FAR, 7);
    expect(far.wikimapia.detailsIds).not.toContain(902);
    expect(far.report.summary.counts.placesParked).toBe(1);
    expect(await failureRecords({ placeId: 900 })).toHaveLength(3);
  });
});

describe('AC-38 After an Explicit Retry the count starts again', () => {
  it('1 and 2 failures after the retry do not park; the third does; older records kept but not counted', async () => {
    await seedCentral(900);
    await crawlRuns(REGION_T1, 0, 3, { details: { 900: wikimapiaErrorAnswer() } });
    const failLater: Answers = {
      details: { 900: { delayMs: 2 * SECOND, then: wikimapiaErrorAnswer() } },
    };
    const retry = await crawlAt(REGION_T1, 3, failLater, { request: { retryParked: true } });
    expect(retry.wikimapia.detailsIds).toStrictEqual([900]);
    expect(retry.report.summary.counts.placesReleased).toBe(1);
    expect(retry.report.summary.counts.placesParkedThisRun).toBe(0);
    const second = await crawlAt(REGION_T1, 4, failLater);
    expect(second.wikimapia.detailsIds).toStrictEqual([900]);
    expect(second.report.summary.counts.placesParkedThisRun).toBe(0);
    const third = await crawlAt(REGION_T1, 5, failLater);
    expect(third.wikimapia.detailsIds).toStrictEqual([900]);
    expect(third.report.summary.counts.placesParkedThisRun).toBe(1);
    const after = await crawlAt(REGION_T1, 6);
    expect(after.wikimapia.detailsIds).not.toContain(900);
    expect(await failureRecords({ placeId: 900 })).toHaveLength(6);
  });
});

// ===========================================================================
// 3.7 Run Summary, command line and Crawl Progress (US-3 .. US-6)
// ===========================================================================

describe('AC-39 Summary additions', () => {
  it('parked, skipped and released Places are labelled lines, and the Run Record keeps them', async () => {
    await seedCentral(900, 901);
    const [, , third] = await crawlRuns(REGION_T1, 0, 3, {
      details: { 900: wikimapiaErrorAnswer() },
    });
    if (third === undefined) throw new Error('no third Run');
    const lines = summaryLines(third);
    expect(lines).toContain(`${SUMMARY_LABELS.placesParkedThisRun}: 1`);
    expect(lines).toContain(`${SUMMARY_LABELS.placesParked}: 1`);
    expect(lines).toContain(`${SUMMARY_LABELS.placesReleased}: 0`);
    const record = (await progress(REGION_T1.name)).runs.find((r) => r.runId === third.runId);
    expect(record?.counts).toStrictEqual(third.summary.counts);

    const retry = await crawlAt(REGION_T1, 3, {}, { request: { retryParked: true } });
    expect(summaryLines(retry.report)).toContain(`${SUMMARY_LABELS.placesReleased}: 1`);
    const retryRecord = (await progress(REGION_T1.name)).runs.find(
      (r) => r.runId === retry.report.runId,
    );
    expect(retryRecord?.counts.placesReleased).toBe(1);
  });

  it('a Dry Run shows 0 for each', async () => {
    const { report } = await crawlAt(REGION_T1, 0, {}, { request: { dryRun: true } });
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    const lines = summaryLines(report);
    for (const key of ['placesParkedThisRun', 'placesParked', 'placesReleased'] as const) {
      expect(lines).toContain(`${SUMMARY_LABELS[key]}: 0`);
    }
  });
});

describe('AC-40 Command option', () => {
  it('--retry-parked: with --dry-run it reports the Parked count and changes nothing; with --budget it releases', async () => {
    await seedRecordedSummaries(62587);
    const failing = respond({ details: { 62587: wikimapiaErrorAnswer() } });
    for (const hours of [0, 1, 2]) {
      await runCommand([CRAWL_COMMAND_OPTIONS.region, 'belgrade-small'], failing, hours);
    }
    const dry = await runCommand(
      [
        CRAWL_COMMAND_OPTIONS.region,
        'belgrade-small',
        CRAWL_COMMAND_OPTIONS.retryParked,
        CRAWL_COMMAND_OPTIONS.dryRun,
      ],
      respond(),
      3,
    );
    expect(dry.result.report.outcome).toBe('planned');
    expect(dry.result.report.parkedPlacesInRegion).toBe(1);
    expect(dry.result.report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(dry.wikimapia.calls).toHaveLength(0);
    expect(await explicitRetries('belgrade-small')).toStrictEqual([]);

    const stillParked = await runCommand(
      [CRAWL_COMMAND_OPTIONS.region, 'belgrade-small'],
      respond(),
      4,
    );
    expect(stillParked.wikimapia.detailsIds).not.toContain(62587);

    const released = await runCommand(
      [
        CRAWL_COMMAND_OPTIONS.region,
        'belgrade-small',
        CRAWL_COMMAND_OPTIONS.retryParked,
        CRAWL_COMMAND_OPTIONS.budget,
        '10',
      ],
      respond({ details: { 62587: fixtureAnswer('getbyid-62587.json') } }),
      5,
    );
    expect(released.result.exitCode).toBe(0);
    expect(released.wikimapia.detailsIds).toStrictEqual([62587]);
    expect(released.result.report.summary.counts.placesReleased).toBe(1);
    expect(await explicitRetries('belgrade-small')).toHaveLength(1);
  });
});

describe('AC-41 Schema Setup for Failure Records', () => {
  afterEach(async () => {
    okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  });

  it('the step holds `crawl_item_failures` with its columns and no Wikimapia content', async () => {
    const structure = await inspect();
    expect(structure.pendingSteps).toStrictEqual([]);
    const table = structure.tables.find((t) => t.name === CRAWL_ITEM_FAILURES_TABLE);
    expect(table).toBeDefined();
    const columns = table?.columns ?? [];
    for (const name of CRAWL_ITEM_FAILURES_COLUMNS) {
      expect(columns.map((c) => c.name)).toContain(name);
    }
    expect(columns.find((c) => c.name === 'failed_at')?.udtName).toBe(FAILED_AT_UDT_NAME);
    for (const column of columns) {
      expect(column.name).not.toMatch(/description|comment|title|author|user_?ip|outline|polygon/i);
      expect(['geometry', 'geography', 'inet', 'cidr']).not.toContain(column.udtName);
    }
  });

  it('undoing it removes only this storage; applying it again keeps every Place and Run Record', async () => {
    await seedCentral(900);
    await crawlAt(REGION_T1, 0, { details: { 900: wikimapiaErrorAnswer() } });
    await store.savePlaceDetails({
      details: await clientDetails('getbyid-62587.json'),
      fetchedAt: FETCHED_AT,
    });
    const before = {
      counts: await counts(),
      place: await read(62587),
      progress: await progress(REGION_T1.name),
    };
    const structure = await inspect();
    const applied = structure.appliedSteps;
    const tableNames = structure.tables.map((t) => t.name);

    // Amended by feature `embeddings` (AL6 20261023-embeddings-al6.md R1, AC-58): its Schema
    // Setup step is newer, so this step is reached by undoing newest-first, one step at a time,
    // until `crawl_item_failures` is gone (as Hydration AC-56 already does).
    const undone: string[] = [];
    while (
      (await inspect()).tables.some((t) => t.name === CRAWL_ITEM_FAILURES_TABLE) &&
      undone.length < applied.length
    ) {
      const steps = okValue(SchemaStepsResultSchema.parse(await setup.undoLast())).steps;
      expect(steps).toStrictEqual([at(applied, applied.length - 1 - undone.length)]);
      undone.push(...steps);
    }
    const after = await inspect();
    const afterNames = after.tables.map((t) => t.name);
    expect(afterNames).not.toContain(CRAWL_ITEM_FAILURES_TABLE);
    for (const name of [
      ...Object.values(STORE_TABLES),
      'crawl_runs',
      'crawl_passes',
      'crawl_finished_pages',
    ]) {
      expect(afterNames).toContain(name);
    }
    for (const name of afterNames) expect(tableNames).toContain(name);
    expect({ counts: await counts(), place: await read(62587) }).toStrictEqual({
      counts: before.counts,
      place: before.place,
    });

    expect(okValue(SchemaStepsResultSchema.parse(await setup.apply())).steps).toStrictEqual(
      [...undone].reverse(),
    );
    expect({
      counts: await counts(),
      place: await read(62587),
      progress: await progress(REGION_T1.name),
    }).toStrictEqual(before);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
  });
});

describe('AC-42 Test starting state', () => {
  it('emptying the Test Database also removes Failure Records and Explicit Retries', async () => {
    await seedCentral(900);
    const failed = await crawlAt(REGION_T1, 0, { details: { 900: wikimapiaErrorAnswer() } });
    await crawlAt(REGION_T1, 1, {}, { request: { retryParked: true } });
    expect(await failureRecords({ placeId: 900 })).toHaveLength(1);
    expect(await explicitRetries(REGION_T1.name)).toHaveLength(1);
    await emptyAll();
    expect((await inspect()).pendingSteps).toStrictEqual([]);
    expect(await failureRecords({ placeId: 900 })).toStrictEqual([]);
    expect(await recordsOfRun(failed.report)).toStrictEqual([]);
    expect(await explicitRetries(REGION_T1.name)).toStrictEqual([]);
  });
});

// ===========================================================================
// 3.8 Fixtures and tests (AC-43, AC-44 in ./crawl-run1-fixes.schema.test.ts)
// ===========================================================================

describe('AC-46 No live calls', () => {
  it('no test of this file reached the network', () => {
    expect(fetchCalls).toStrictEqual([]);
  });
});
