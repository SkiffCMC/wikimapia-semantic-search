/**
 * AL5 CONTRACT TESTS: Hydration (schemas, pure validators and test doubles).
 *
 * Layer:    AL5 (Contracts). These tests do not import the Crawl and pass before AL2.
 * Derives:  docs/al6-requirements/20261022-hydration-al6.md (AC-1 default Regions, the Tile Plan
 *           geometry of AC-2 / AC-3 / AC-66, AC-6 configuration rules, Details Order of AC-33,
 *           pacing rule of AC-39 / AC-71, exit statuses of AC-45 / AC-61, summary rules of
 *           AC-50, AC-63 / AC-65 test doubles and fixtures)
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (recorded fixtures read through
 *           the real, finished Client; no live network; no Commenter IPs).
 *
 * The finished Wikimapia Client (`createWikimapiaClient`) is used here only to prove that the
 * synthetic and recorded answers of ./hydration.support.ts are what the Crawl's Client accepts.
 */
import { createWikimapiaClient } from '../src/wikimapia/client';
import {
  BELGRADE_REGION,
  BELGRADE_SMALL_REGION,
  CRAWL_QUOTA_SHARE,
  CrawlConfigurationSchema,
  DEFAULT_CRAWL_CONFIGURATION,
  DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
  DEFAULT_REQUEST_BUDGET,
  ENTRY_POINT,
  CRAWL_COMMAND_ENTRY_POINT,
  CRAWL_STORE_ENTRY_POINT,
  TILE_PLAN_ENTRY_POINT,
  PlacesDueValueSchema,
  RunCountsSchema,
  RunReportSchema,
  TilePlanSchema,
  WIKIMAPIA_QUOTA,
  ZERO_RUN_COUNTS,
  cellsCovering,
  compareDetailsOrder,
  exitCodeFor,
  findPacingIssues,
  findTilePlanIssues,
  isInsideBoundingBox,
  toMoment,
  type Region,
  type RunOutcome,
  type Tile,
  type TilePlan,
} from './hydration.schema';
import {
  CrawlWikimapia,
  Gate,
  REGION_T1,
  REGION_T2,
  REGION_T4,
  SimulatedCrawlClock,
  T1_TILES,
  T2_TILES,
  T4_TILES,
  TEST_API_KEY,
  UNREACHABLE,
  at,
  belgradePage1,
  listingAnswer,
  rateLimitAnswer,
  scripted,
  settle,
  syntheticDetailsAnswer,
  syntheticPlacesIn,
  testConfiguration,
} from './hydration.support';

function planFrom(region: Region, columns: number, rows: number, tiles: readonly Tile[]): TilePlan {
  return TilePlanSchema.parse({
    regionName: region.name,
    bbox: region.bbox,
    tileSize: region.tileSize,
    columns,
    rows,
    tiles,
  });
}

/** The 4 Tiles AC-2 states for belgrade-small. */
const AC2_TILES: Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.457, north: 44.819 } },
  { tileNumber: 2, bbox: { west: 20.457, south: 44.814, east: 20.462, north: 44.819 } },
  { tileNumber: 3, bbox: { west: 20.452, south: 44.819, east: 20.457, north: 44.82 } },
  { tileNumber: 4, bbox: { west: 20.457, south: 44.819, east: 20.462, north: 44.82 } },
];

describe('Entry points', () => {
  it('names the modules AL2 must create', () => {
    expect(ENTRY_POINT).toStrictEqual({ module: 'src/crawl/run-crawl.ts', export: 'runCrawl' });
    expect(TILE_PLAN_ENTRY_POINT.module).toBe('src/crawl/tile-plan.ts');
    expect(CRAWL_COMMAND_ENTRY_POINT.module).toBe('src/crawl/command.ts');
    expect(CRAWL_STORE_ENTRY_POINT.module).toBe('src/db/crawl-store.ts');
  });
});

describe('AC-1 Belgrade Regions defined (default configuration)', () => {
  it('has exactly belgrade and belgrade-small, both 0.005 x 0.005, with the stated boxes', () => {
    const config = CrawlConfigurationSchema.parse(DEFAULT_CRAWL_CONFIGURATION);
    expect(config.regions.map((r) => r.name)).toStrictEqual(['belgrade', 'belgrade-small']);
    expect(BELGRADE_REGION.bbox).toStrictEqual({
      west: 20.15,
      south: 44.65,
      east: 20.75,
      north: 44.98,
    });
    expect(BELGRADE_SMALL_REGION.bbox).toStrictEqual({
      west: 20.452,
      south: 44.814,
      east: 20.462,
      north: 44.82,
    });
    for (const region of config.regions) {
      expect(region.tileSize).toStrictEqual({ width: 0.005, height: 0.005 });
    }
  });

  it('defaults: page size 100, Refresh Age 30 days, 6 s interval, budget 500 (AC-41, AC-71)', () => {
    expect(DEFAULT_CRAWL_CONFIGURATION.listingPageSize).toBe(100);
    expect(DEFAULT_CRAWL_CONFIGURATION.refreshAgeDays).toBe(30);
    expect(DEFAULT_CRAWL_CONFIGURATION.minRequestIntervalSeconds).toBe(6);
    expect(DEFAULT_REQUEST_BUDGET).toBe(500);
    // Half the Wikimapia Quota: one request per 6 s is at most 50 per 300 s.
    expect(CRAWL_QUOTA_SHARE.requests * 2).toBe(WIKIMAPIA_QUOTA.requests);
    expect(CRAWL_QUOTA_SHARE.windowSeconds / DEFAULT_MIN_REQUEST_INTERVAL_SECONDS).toBe(
      CRAWL_QUOTA_SHARE.requests,
    );
  });
});

describe('AC-6 Invalid configuration (schema)', () => {
  const valid = testConfiguration();
  const cases: [string, unknown][] = [
    [
      'bbox',
      { ...valid, regions: [{ ...REGION_T1, bbox: { west: 21, south: 44, east: 20, north: 45 } }] },
    ],
    ['tileSize', { ...valid, regions: [{ ...REGION_T1, tileSize: { width: 0, height: 1 } }] }],
    ['tileSize', { ...valid, regions: [{ ...REGION_T1, tileSize: { width: 0.1, height: -1 } }] }],
    ['listingPageSize', { ...valid, listingPageSize: 0 }],
    ['listingPageSize', { ...valid, listingPageSize: 101 }],
    ['listingPageSize', { ...valid, listingPageSize: 2.5 }],
    ['refreshAgeDays', { ...valid, refreshAgeDays: -1 }],
    ['refreshAgeDays', { ...valid, refreshAgeDays: Number.NaN }],
    ['minRequestIntervalSeconds', { ...valid, minRequestIntervalSeconds: -0.1 }],
    ['requestBudget', { ...valid, requestBudget: Number.NaN }],
    ['requestBudget', { ...valid, requestBudget: -1 }],
  ];
  for (const [setting, config] of cases) {
    it(`rejects a bad ${setting} with an issue path naming it`, () => {
      const parsed = CrawlConfigurationSchema.safeParse(config);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((i) => i.path.map(String).includes(setting))).toBe(true);
    });
  }

  it('accepts the test configuration and a Refresh Age of 0', () => {
    expect(CrawlConfigurationSchema.safeParse(valid).success).toBe(true);
    expect(CrawlConfigurationSchema.safeParse({ ...valid, refreshAgeDays: 0 }).success).toBe(true);
  });

  it('rejects Region Names that are not lower-case letters, digits and hyphens, and duplicates', () => {
    expect(
      CrawlConfigurationSchema.safeParse({
        ...valid,
        regions: [{ ...REGION_T1, name: 'Belgrade' }],
      }).success,
    ).toBe(false);
    expect(
      CrawlConfigurationSchema.safeParse({ ...valid, regions: [REGION_T1, REGION_T1] }).success,
    ).toBe(false);
  });
});

describe('AC-2, AC-3, AC-66 Tile Plan geometry (validator)', () => {
  it('cellsCovering ignores float noise: 0.6 / 0.005 = 120, 0.33 / 0.005 = 66, 0.01 / 0.005 = 2', () => {
    expect(cellsCovering(0.75 - 0.15, 0.005)).toBe(120);
    expect(cellsCovering(44.98 - 44.65, 0.005)).toBe(66);
    expect(cellsCovering(20.462 - 20.452, 0.005)).toBe(2);
    expect(cellsCovering(44.82 - 44.814, 0.005)).toBe(2);
    expect(cellsCovering(0.002, 0.005)).toBe(1);
  });

  it('accepts the AL6 plan of belgrade-small and rejects broken variants', () => {
    expect(
      findTilePlanIssues(BELGRADE_SMALL_REGION, planFrom(BELGRADE_SMALL_REGION, 2, 2, AC2_TILES)),
    ).toStrictEqual([]);
    const reordered = [at(AC2_TILES, 0), at(AC2_TILES, 2), at(AC2_TILES, 1), at(AC2_TILES, 3)].map(
      (t, i) => ({ ...t, tileNumber: i + 1 }),
    );
    expect(
      findTilePlanIssues(BELGRADE_SMALL_REGION, planFrom(BELGRADE_SMALL_REGION, 2, 2, reordered))
        .length,
    ).toBeGreaterThan(0);
    const uncut = AC2_TILES.map((t) =>
      t.tileNumber > 2 ? { ...t, bbox: { ...t.bbox, north: 44.824 } } : t,
    );
    expect(
      findTilePlanIssues(BELGRADE_SMALL_REGION, planFrom(BELGRADE_SMALL_REGION, 2, 2, uncut))
        .length,
    ).toBeGreaterThan(0);
  });

  it('a Region smaller than a Tile is 1 Tile equal to the Region', () => {
    const tiny: Region = {
      name: 'tiny',
      bbox: { west: 20.456, south: 44.816, east: 20.458, north: 44.817 },
      tileSize: { width: 0.005, height: 0.005 },
    };
    expect(
      findTilePlanIssues(tiny, planFrom(tiny, 1, 1, [{ tileNumber: 1, bbox: tiny.bbox }])),
    ).toStrictEqual([]);
  });

  it('the support Tile lists of the test Regions are their exact Tile Plans', () => {
    expect(findTilePlanIssues(REGION_T1, planFrom(REGION_T1, 1, 1, T1_TILES))).toStrictEqual([]);
    expect(findTilePlanIssues(REGION_T2, planFrom(REGION_T2, 2, 1, T2_TILES))).toStrictEqual([]);
    expect(findTilePlanIssues(REGION_T4, planFrom(REGION_T4, 2, 2, T4_TILES))).toStrictEqual([]);
  });

  it('a plan with Tile Numbers out of sequence fails the schema', () => {
    const bad = {
      ...planFrom(REGION_T1, 1, 1, T1_TILES),
      tiles: [{ tileNumber: 2, bbox: REGION_T1.bbox }],
    };
    expect(TilePlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe('AC-28, AC-29 Moments', () => {
  it('toMoment truncates to the second, UTC, with Z', () => {
    expect(toMoment(new Date('2026-10-22T09:00:05.987Z'))).toBe('2026-10-22T09:00:05Z');
  });
});

describe('AC-33, AC-34 Details Order and Region Places (validators)', () => {
  it('orders Summary-Only by id, then Detailed by oldest fetch, ties by id', () => {
    const places = [
      { placeId: 62587, detailsFetchedAt: '2026-08-01T00:00:00Z' },
      { placeId: 900 },
      { placeId: 1381893, detailsFetchedAt: '2026-07-01T00:00:00Z' },
      { placeId: 300 },
      { placeId: 700, detailsFetchedAt: '2026-07-01T00:00:00Z' },
    ];
    expect([...places].sort(compareDetailsOrder).map((p) => p.placeId)).toStrictEqual([
      300, 900, 700, 1381893, 62587,
    ]);
    expect(PlacesDueValueSchema.safeParse({ places }).success).toBe(false);
    expect(
      PlacesDueValueSchema.safeParse({ places: [...places].sort(compareDetailsOrder) }).success,
    ).toBe(true);
  });

  it('edges are inside', () => {
    const bbox = BELGRADE_SMALL_REGION.bbox;
    expect(isInsideBoundingBox({ lon: 20.452, lat: 44.817 }, bbox)).toBe(true);
    expect(isInsideBoundingBox({ lon: 20.462, lat: 44.82 }, bbox)).toBe(true);
    expect(isInsideBoundingBox({ lon: 20.47, lat: 44.817 }, bbox)).toBe(false);
  });
});

describe('AC-39, AC-71 Pacing (validator)', () => {
  it('flags starts closer than the interval and windows over the limit', () => {
    expect(findPacingIssues([0, 2000, 4000], 2)).toStrictEqual([]);
    expect(findPacingIssues([0, 1999], 2)).toHaveLength(1);
    const every6s = Array.from({ length: 60 }, (_, i) => i * 6000);
    expect(findPacingIssues(every6s, 6, { windowSeconds: 300, maxPerWindow: 50 })).toStrictEqual(
      [],
    );
    const every5s = Array.from({ length: 60 }, (_, i) => i * 5000);
    expect(
      findPacingIssues(every5s, 5, { windowSeconds: 300, maxPerWindow: 50 }).length,
    ).toBeGreaterThan(0);
  });
});

describe('AC-45, AC-61 Exit status', () => {
  it('success for Completed, Budget Reached, Rate Limited, Planned; failure for Failed, Interrupted', () => {
    const expected: Record<RunOutcome, 0 | 1> = {
      completed: 0,
      budget_reached: 0,
      rate_limited: 0,
      planned: 0,
      failed: 1,
      interrupted: 1,
    };
    for (const [outcome, code] of Object.entries(expected)) {
      expect(exitCodeFor(outcome as RunOutcome)).toBe(code);
    }
  });
});

describe('AC-50 Run Summary rules (schema)', () => {
  it('requests and failures must add up', () => {
    expect(RunCountsSchema.safeParse(ZERO_RUN_COUNTS).success).toBe(true);
    expect(RunCountsSchema.safeParse({ ...ZERO_RUN_COUNTS, wikimapiaRequests: 1 }).success).toBe(
      false,
    );
    expect(RunCountsSchema.safeParse({ ...ZERO_RUN_COUNTS, itemFailures: 1 }).success).toBe(false);
    expect(
      RunCountsSchema.safeParse({
        ...ZERO_RUN_COUNTS,
        itemFailures: 1,
        itemFailuresByKind: { ...ZERO_RUN_COUNTS.itemFailuresByKind, connection: 1 },
      }).success,
    ).toBe(true);
  });

  it('a Failed report must say why; a plan only for a Dry Run', () => {
    const summary = {
      regionName: 'test-one',
      outcome: 'failed' as const,
      startedAt: '2026-10-22T09:00:00Z',
      endedAt: '2026-10-22T09:00:00Z',
      counts: ZERO_RUN_COUNTS,
    };
    const base = {
      outcome: 'failed' as const,
      summary,
      summaryText: 'Run outcome: Failed',
      itemFailures: [],
    };
    expect(RunReportSchema.safeParse(base).success).toBe(false);
    expect(RunReportSchema.safeParse({ ...base, message: 'Unknown region' }).success).toBe(true);
    expect(
      RunReportSchema.safeParse({
        ...base,
        message: 'x',
        plan: planFrom(REGION_T1, 1, 1, T1_TILES),
      }).success,
    ).toBe(false);
  });
});

describe('AC-63 Test doubles and fixtures work with the real Client, offline', () => {
  it('scripted answers are routed by Tile, page and Place and read by the Client', async () => {
    const clock = new SimulatedCrawlClock();
    const wikimapia = new CrawlWikimapia(
      clock,
      scripted({
        tiles: T2_TILES,
        listing: { 2: [listingAnswer(syntheticPlacesIn(at(T2_TILES, 1).bbox, 2, 9001))] },
        details: { 9001: [rateLimitAnswer(4), syntheticDetailsAnswer(9001)] },
      }),
    );
    const client = createWikimapiaClient({
      apiKey: TEST_API_KEY,
      transport: wikimapia.transport,
      clock,
    });
    const page = await client.listPlaces({ bbox: at(T2_TILES, 1).bbox, page: 1, pageSize: 3 });
    expect(page.ok && page.value.places.map((p) => p.placeId)).toStrictEqual([9001, 9002]);
    const empty = await client.listPlaces({ bbox: at(T2_TILES, 0).bbox, page: 1 });
    expect(empty.ok && empty.value.places).toStrictEqual([]);
    const details = await client.getPlaceDetails({ placeId: 9001 });
    expect(details.ok && details.value.placeId).toBe(9001);
    expect(clock.now().toISOString()).toBe('2026-10-22T09:00:04.000Z');
    expect(wikimapia.calls.map((c) => [c.fn, c.attempt])).toStrictEqual([
      ['box', 1],
      ['box', 1],
      ['place.getbyid', 1],
      ['place.getbyid', 2],
    ]);
    const recorded = new CrawlWikimapia(clock, () => belgradePage1());
    const recordedClient = createWikimapiaClient({
      apiKey: TEST_API_KEY,
      transport: recorded.transport,
      clock,
    });
    const belgrade = await recordedClient.listPlaces({ bbox: BELGRADE_SMALL_REGION.bbox, page: 1 });
    expect(belgrade.ok && belgrade.value.places.map((p) => p.placeId)).toStrictEqual([
      1381893, 62587, 164369,
    ]);
  });

  it('an unreachable answer rejects with the key-bearing address, and a gate holds a request', async () => {
    const clock = new SimulatedCrawlClock();
    const gate = new Gate();
    const wikimapia = new CrawlWikimapia(clock, (call) =>
      call.attempt === 1 ? { gate } : UNREACHABLE,
    );
    const url = `https://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=1`;
    let settled = false;
    const held = wikimapia.transport({ url }).then(() => {
      settled = true;
    });
    await gate.reached;
    await settle();
    expect(settled).toBe(false);
    gate.open(listingAnswer([]));
    await held;
    await expect(wikimapia.transport({ url })).rejects.toThrow(TEST_API_KEY);
  });
});
