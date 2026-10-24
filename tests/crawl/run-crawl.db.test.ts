/**
 * AL2 unit tests: `runCrawl` (`src/crawl/run-crawl.ts`, `details-phase.ts`, `failures.ts`) with
 * the Test Database. The hydration contract tests cover the Run flow end to end; this keeps only
 * the crawl-run1-fixes paths they never reach (AL4 crawl-run1-fixes 1.2, 1.4.3 .. 1.4.7): Failure
 * Records, a Failure Record that cannot be written, Parking, the Explicit Retry, the parked count
 * of a Dry Run and the Key Quota stop. Contract doubles for clock and Wikimapia; no network.
 */
import { runCrawl } from '../../src/crawl/run-crawl';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import type { FailureRecord, FailureRecordsInput } from '../../contracts/crawl-run1-fixes.schema';
import {
  OUTCOME_LABELS,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
  toMoment,
  type CrawlRequest,
  type RunReport,
} from '../../contracts/hydration.schema';
import {
  CENTRAL_BELGRADE_POINT,
  CrawlWikimapia,
  HOUR,
  REGION_T1,
  REGION_T2,
  RUN_START,
  SimulatedCrawlClock,
  T1_TILES,
  T2_TILES,
  TEST_API_KEY,
  at,
  listingAnswer,
  scripted,
  syntheticPlacesIn,
  testConfiguration,
  wikimapiaErrorAnswer,
  type Script,
} from '../../contracts/hydration.support';
import type {
  PlaceStore,
  SchemaSetup,
  StoreFailure,
  WriteHook,
} from '../../contracts/storage.schema';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';
import { keyQuotaAnswer } from '../../contracts/wikimapia-client.support';

const T0 = Date.parse(RUN_START);

let testUrl = '';
let setup: SchemaSetup;
let placeStore: PlaceStore;
let crawlStore: ReturnType<typeof createCrawlStore>;

beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect((await setup.apply()).ok).toBe(true);
  placeStore = createPlaceStore({ connectionString: testUrl });
  crawlStore = createCrawlStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  await crawlStore.close();
  await placeStore.close();
  await setup.close();
});

function okValue<T>(result: { ok: true; value: T } | { ok: false; failure: StoreFailure }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.failure.message}`);
  return result.value;
}

async function failureRecords(input: FailureRecordsInput): Promise<FailureRecord[]> {
  return okValue(await crawlStore.readFailureRecords(input)).records;
}

/** Stores Summary-Only Places at the centre of Region T1 (due for details at once). */
async function seedCentral(...ids: number[]): Promise<void> {
  const { lon, lat } = CENTRAL_BELGRADE_POINT;
  okValue(
    await placeStore.saveListingPage({
      page: 1,
      pageSize: 100,
      totalFound: ids.length,
      places: ids.map((placeId) => ({
        placeId,
        name: `Synthetic place ${String(placeId)}`,
        url: `http://wikimapia.org/${String(placeId)}/Synthetic`,
        location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
        outline: [],
      })),
    }),
  );
}

/** One Run of `region` whose Simulated Clock starts `hours` after RUN_START. */
async function crawl(
  hours: number,
  script: Omit<Script, 'tiles'> = {},
  extra: { request?: Omit<CrawlRequest, 'regionName'>; onWrite?: WriteHook; t2?: boolean } = {},
) {
  const clock = new SimulatedCrawlClock(T0 + hours * HOUR);
  const region = extra.t2 === true ? REGION_T2 : REGION_T1;
  const tiles = extra.t2 === true ? T2_TILES : T1_TILES;
  const wikimapia = new CrawlWikimapia(clock, scripted({ ...script, tiles }));
  const progressLines: string[] = [];
  const report: RunReport = await runCrawl(
    { regionName: region.name, ...extra.request },
    {
      connectionString: testUrl,
      apiKey: TEST_API_KEY,
      transport: wikimapia.transport,
      clock,
      configuration: testConfiguration(),
      onProgress: (line) => {
        progressLines.push(line);
      },
      ...(extra.onWrite === undefined ? {} : { onWrite: extra.onWrite }),
    },
  );
  return { report, wikimapia, progressLines };
}

/** Three Runs in which Place 900 fails with a Wikimapia Error: the third parks it. */
async function park900() {
  await seedCentral(900);
  const runs = [];
  for (const hours of [0, 1, 2])
    runs.push(await crawl(hours, { details: { 900: wikimapiaErrorAnswer() } }));
  return runs;
}

describe('runCrawl: Failure Records', () => {
  it('a Listing Page failure keeps one record with Tile, page and the receive moment', async () => {
    const places = syntheticPlacesIn(at(T2_TILES, 1).bbox, 2, 9601);
    const { report, wikimapia } = await crawl(
      0,
      { listing: { 1: [wikimapiaErrorAnswer()], 2: [listingAnswer(places)] } },
      { t2: true },
    );
    expect(report.outcome).toBe('completed');
    expect(await failureRecords({ runId: report.runId ?? -1 })).toStrictEqual([
      {
        runId: report.runId,
        item: { kind: 'listing_page', tileNumber: 1, page: 1 },
        failureKind: 'wikimapia_error',
        message: at(report.itemFailures, 0).message,
        failedAt: toMoment(new Date(at(wikimapia.listingCalls, 0).startedAtMs)),
      },
    ]);
  });

  it('a Failure Record that cannot be written ends the Run Failed, untallied, with no further request', async () => {
    await seedCentral(900, 901);
    let down = false;
    const { report, wikimapia } = await crawl(
      0,
      {
        details: {
          900: {
            effect: () => {
              down = true;
            },
            then: wikimapiaErrorAnswer(),
          },
        },
      },
      {
        onWrite: () => {
          if (down) throw new Error('connection lost');
        },
      },
    );
    expect(report.outcome).toBe('failed');
    expect(report.itemFailures).toStrictEqual([]);
    expect(wikimapia.detailsIds).toStrictEqual([900]);
    expect(report.message).not.toContain('connection lost');
  });
});

describe('runCrawl: Parking and Explicit Retry', () => {
  it('the third failing Run parks 900 and says so; a later Run skips it', async () => {
    const runs = await park900();
    expect(runs.map((r) => r.report.summary.counts.placesParkedThisRun)).toStrictEqual([0, 0, 1]);
    expect(at(runs, 2).progressLines).toContain(
      'Place 900: parked after 3 failures (Wikimapia error)',
    );
    expect(await failureRecords({ placeId: 900 })).toHaveLength(3);

    const later = await crawl(3);
    expect(later.wikimapia.calls).toHaveLength(0);
    expect(later.report.summary.counts).toMatchObject({ placesParked: 1, placesStillDue: 0 });
  });

  it('retryParked releases 900, requests it again and says so after the start line', async () => {
    await park900();
    const { report, wikimapia, progressLines } = await crawl(
      3,
      {},
      { request: { retryParked: true } },
    );
    expect(wikimapia.detailsIds).toStrictEqual([900]);
    expect(report.summary.counts).toMatchObject({ placesReleased: 1, placesParked: 0 });
    const line = `Explicit retry: released 1 parked places of region ${REGION_T1.name}`;
    expect(progressLines[progressLines.indexOf(line) - 1]).toMatch(/^Run \d+ started for region /);
    expect(
      okValue(await crawlStore.readExplicitRetries({ regionName: REGION_T1.name })).retries,
    ).toStrictEqual([
      {
        runId: report.runId,
        regionName: REGION_T1.name,
        retriedAt: report.summary.startedAt,
        placesReleased: 1,
      },
    ]);

    const again = await crawl(4, {}, { request: { retryParked: true } });
    expect(again.report.summary.counts.placesReleased).toBe(0);
  });

  it('a retryParked Dry Run reports the parked count and sends, writes and releases nothing', async () => {
    await park900();
    const onWrite = vi.fn<WriteHook>();
    const { report, wikimapia } = await crawl(
      3,
      {},
      { request: { dryRun: true, retryParked: true }, onWrite },
    );
    expect(report.outcome).toBe('planned');
    expect(report.parkedPlacesInRegion).toBe(1);
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(wikimapia.calls).toHaveLength(0);
    expect(onWrite).not.toHaveBeenCalled();
  });
});

describe('runCrawl: Key Quota', () => {
  it('a Key Quota answer ends Quota Exhausted with the Wikimapia line and a kept Run Record', async () => {
    await seedCentral(300, 900);
    const { report, wikimapia } = await crawl(0, { details: { 900: keyQuotaAnswer() } });
    expect(wikimapia.detailsIds).toStrictEqual([300, 900]);
    expect(report.outcome).toBe('quota_exhausted');
    const lines = report.summaryText.split('\n');
    expect(lines).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`);
    expect(lines.at(-1)).toBe(`${SUMMARY_LABELS.wikimapiaMessage}: Key limit has been reached`);
    const view = okValue(await crawlStore.readCrawlProgress({ regionName: REGION_T1.name }));
    expect(view.runs.find((r) => r.runId === report.runId)?.status).toBe('quota_exhausted');
  });
});
