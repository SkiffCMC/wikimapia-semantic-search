/**
 * AL5 CONTRACT: Hydration jobs, the Crawl (feature `hydration`, Stage 1 substep 3).
 *
 * Layer:    AL5 (Contracts). Source of truth for AL4 design and AL2 implementation.
 * Derives:  docs/al6-requirements/20261022-hydration-al6.md (revision 2, AC-1 .. AC-71,
 *           R1 .. R4, stakeholder decisions Q1 .. Q10), intent docs/al7-intent/20261022-hydration-al7.md;
 *           amended by docs/al6-requirements/20261022-crawl-run1-fixes-al6.md section 5.2 (Run
 *           Outcome Quota Exhausted, parked / skipped / released counts, the Explicit Retry option
 *           `retryParked` / `--retry-parked`). Failure Records, Parking and Explicit Retry
 *           storage are contracted in ./crawl-run1-fixes.schema.ts.
 * Enforces: .agrules section 1 "Offline Ingestion" (idempotent, resumable, paced, backs off on
 *           errors), section 2 (every input and every stored or reported shape is checked with
 *           Zod; invalid configuration is a handled failure), section 3 (all SQL, including the
 *           Places Due for Details query and Crawl Progress, lives in `src/db/`; the new table is
 *           created by a versioned Schema Setup step), section 4 "No Commenter IPs", "No Data or
 *           Secrets in Git", "Recorded API Fixtures", "No Live External Calls in Tests" and
 *           "Strict Types Only" (all I/O typed through `z.infer`).
 *
 * Reuses the Client shapes from ./wikimapia-client.schema (BoundingBox, Clock, transport) and
 * the Place Store shapes from ./storage.schema (moments, WriteHook, results).
 *
 * Public entry points (black box for ./hydration.test.ts):
 * - `src/crawl/run-crawl.ts`  exports `runCrawl: RunCrawlFn`                 (ENTRY_POINT)
 * - `src/crawl/tile-plan.ts`  exports `planTiles: PlanTilesFn`               (TILE_PLAN_ENTRY_POINT)
 * - `src/crawl/command.ts`    exports `runCrawlCommand: RunCrawlCommandFn`   (CRAWL_COMMAND_ENTRY_POINT)
 * - `src/db/crawl-store.ts`   exports `createCrawlStore: CreateCrawlStoreFn` (CRAWL_STORE_ENTRY_POINT)
 * - `package.json` script `crawl` runs the command through `tsx` (CRAWL_SCRIPT, AC-59).
 *
 * How the gaps of the finished substeps are closed (AL6 section 0 and section 5):
 * - G1 / R4 (counting requests and waits): the Client is NOT changed. `runCrawl` builds its own
 *   Client with the real `createWikimapiaClient`, handing it a transport and a clock that wrap
 *   the injected ones. Every call of the wrapped transport is one Wikimapia Request (Client
 *   retries included); pacing (Minimum Request Interval) and the Request Budget are applied
 *   there, before the injected transport is called, so they cover the Client's retries too.
 *   Every `sleep` the Client makes on its clock is one Rate-Limit Wait of that many seconds
 *   (fallback waits included, AC-52). The crawl's own waits (pacing, Connection Failure
 *   back-off) are not Rate-Limit Waits. Tests check the counts against what Simulated Wikimapia
 *   received and what the Simulated Clock was asked to wait.
 * - G2 / R1 (Places Due for Details): `CrawlStore.listPlacesDueForDetails`, a new Place Store
 *   query in `src/db/` (Region Places by Centre Point inside a Bounding Box, edges included,
 *   Summary-Only or with Details Fetched At strictly before a given moment, in Details Order).
 *   The storage contract's `PlaceStore` interface is left unchanged.
 * - G3 / R2 (Crawl Progress): a new Schema Setup step, the newest, holds Crawl Progress and Run
 *   Records. Storage AC-5 is narrowed in ./storage.test.ts to "no place for embeddings or
 *   vectors of any kind". `SchemaSetup.emptyStore()` (Test Database reset) also removes all
 *   Crawl Progress and Run Records, and `SchemaSetup.undoLast()` undoes only the newest step
 *   (both documented in ./storage.schema.ts, AC-56, AC-57).
 * - G4 / R3 (page saved together with its progress): the Listing Save of a page and the
 *   recording of that page as a Finished Page are ONE all-or-nothing database step. Observable
 *   through the `onWrite` fault-injection seam of `runCrawl` (AC-14, AC-47).
 *
 * Every Crawl entry point resolves (never rejects): `runCrawl` and `runCrawlCommand` to a
 * `RunReport` whose `outcome` is the Run Outcome; `CrawlStore` calls to a Store result.
 *
 * Data saved by the Crawl is Wikimapia data, CC BY-NC-SA 3.0, non-commercial only.
 */
import { z } from 'zod';
import {
  DetailsFetchedAtSchema,
  storeResultSchema,
  type StoreConfig,
  type WriteHook,
} from './storage.schema';
import {
  BoundingBoxSchema,
  MAX_PAGE_SIZE,
  PlaceIdSchema,
  type BoundingBox,
  type Clock,
  type WikimapiaTransport,
} from './wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Module path that must export the Run (the Crawl itself). */
export const ENTRY_POINT = {
  module: 'src/crawl/run-crawl.ts',
  export: 'runCrawl',
} as const;

/** Module path that must export the pure Tile Plan function. */
export const TILE_PLAN_ENTRY_POINT = {
  module: 'src/crawl/tile-plan.ts',
  export: 'planTiles',
} as const;

/** Module path that must export the Crawl Command (argument parsing, env, output, exit code). */
export const CRAWL_COMMAND_ENTRY_POINT = {
  module: 'src/crawl/command.ts',
  export: 'runCrawlCommand',
} as const;

/** Module path that must export the Crawl Progress and Places-Due store (all SQL in src/db/). */
export const CRAWL_STORE_ENTRY_POINT = {
  module: 'src/db/crawl-store.ts',
  export: 'createCrawlStore',
} as const;

/** AC-59: `pnpm crawl --region belgrade` runs the Crawl Command through `tsx`. */
export const CRAWL_SCRIPT = { name: 'crawl', runner: 'tsx' } as const;

/** Environment variables the Crawl Command reads (`.agrules` section 4, AL6 rule 11). */
export const API_KEY_ENV = 'WIKIMAPIA_API_KEY';
export const DATABASE_URL_ENV = 'DATABASE_URL';

// ---------------------------------------------------------------------------
// Constants (AL6 glossary, business rules, stakeholder decisions)
// ---------------------------------------------------------------------------

/** Coordinates are compared to within this many degrees (AL6 section 3 preamble). */
export const COORDINATE_TOLERANCE = 0.000001;

/** Q2: default Tile Size, degrees of longitude (width) and latitude (height). */
export const DEFAULT_TILE_SIZE = { width: 0.005, height: 0.005 } as const;
/** Glossary "Listing Page Size": 100, the largest Wikimapia allows. */
export const DEFAULT_LISTING_PAGE_SIZE = 100;
/** Q5: Refresh Age. */
export const DEFAULT_REFRESH_AGE_DAYS = 30;
/** Q7, rule 8: 6 s between request starts = at most 50 requests per 5 minutes. */
export const DEFAULT_MIN_REQUEST_INTERVAL_SECONDS = 6;
/** Q7, rule 7: Request Budget per Run. */
export const DEFAULT_REQUEST_BUDGET = 500;
/** Glossary "Wikimapia Quota" (stakeholder statement) and the half of it the Crawl may use. */
export const WIKIMAPIA_QUOTA = { requests: 100, windowSeconds: 300 } as const;
export const CRAWL_QUOTA_SHARE = { requests: 50, windowSeconds: 300 } as const;
/** Rule 6, Q8: Connection Failures get 2 extra tries, after waits of 30 then 60 seconds. */
export const CONNECTION_RETRY_WAITS_SECONDS = [30, 60] as const;
/** Q10, glossary "Abandonment Age": more than this without Last Activity = abandoned. */
export const ABANDONMENT_AGE_SECONDS = 3600;
/** Q10, AC-70: a live Run renews its Last Activity at least this often. */
export const MAX_HEARTBEAT_INTERVAL_SECONDS = 900;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A UTC moment to the second, ISO 8601 with `Z` (same form as Details Fetched At). */
export const MomentSchema = DetailsFetchedAtSchema;
export type Moment = z.infer<typeof MomentSchema>;

/**
 * The moment a Clock reading stands for: truncated to the whole second, UTC, e.g.
 * `2026-10-22T09:00:05Z`. Details Fetched At, Run start and end moments and Last Activity are
 * all taken this way (AC-28, AC-29).
 */
export function toMoment(date: Date): Moment {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Region Name: lower-case letters, digits and hyphens (glossary). */
export const RegionNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected lower-case letters, digits and hyphens');
export type RegionName = z.infer<typeof RegionNameSchema>;

const CountSchema = z.number().int().nonnegative();
export const RunIdSchema = z.number().int().positive();
export const TileNumberSchema = z.number().int().min(1);
export const PageNumberSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------
// Crawl Configuration (AC-1, AC-6, AC-67)
// ---------------------------------------------------------------------------

/** Tile Size: both above zero (AC-6). */
export const TileSizeSchema = z.strictObject({
  width: z.number().positive(),
  height: z.number().positive(),
});
export type TileSize = z.infer<typeof TileSizeSchema>;

/** Region: Region Name, optional human label, Bounding Box (as defined by the Client), Tile Size. */
export const RegionSchema = z.strictObject({
  name: RegionNameSchema,
  label: z.string().min(1).exactOptional(),
  bbox: BoundingBoxSchema,
  tileSize: TileSizeSchema,
});
export type Region = z.infer<typeof RegionSchema>;

/**
 * Crawl Configuration (glossary). An invalid one makes a Run end Failed with a message that
 * contains the offending setting's key (`bbox`, `tileSize`, `listingPageSize`, `refreshAgeDays`,
 * `minRequestIntervalSeconds` or `requestBudget`), before any request or database change (AC-6).
 * `z.number()` already rejects NaN and infinities ("not a number").
 */
export const CrawlConfigurationSchema = z.strictObject({
  regions: z
    .array(RegionSchema)
    .min(1)
    .refine((regions) => new Set(regions.map((r) => r.name)).size === regions.length, {
      message: 'Region Names must be unique',
    }),
  listingPageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
  refreshAgeDays: z.number().nonnegative(),
  minRequestIntervalSeconds: z.number().nonnegative(),
  requestBudget: z.number().int().nonnegative(),
});
export type CrawlConfiguration = z.infer<typeof CrawlConfigurationSchema>;

/** The setting keys an AC-6 failure message names. */
export const CONFIGURATION_SETTING_KEYS = [
  'bbox',
  'tileSize',
  'listingPageSize',
  'refreshAgeDays',
  'minRequestIntervalSeconds',
  'requestBudget',
] as const;

/** AC-1, Q1: `belgrade` (Big Belgrade). */
export const BELGRADE_REGION: Region = {
  name: 'belgrade',
  label: 'Big Belgrade',
  bbox: { west: 20.15, south: 44.65, east: 20.75, north: 44.98 },
  tileSize: { ...DEFAULT_TILE_SIZE },
};

/** AC-1, Q1: `belgrade-small`, the central Belgrade bbox probed on 2026-10-20. */
export const BELGRADE_SMALL_REGION: Region = {
  name: 'belgrade-small',
  label: 'Central Belgrade (small test area)',
  bbox: { west: 20.452, south: 44.814, east: 20.462, north: 44.82 },
  tileSize: { ...DEFAULT_TILE_SIZE },
};

/**
 * The default Crawl Configuration (AC-1, AC-59). A Run given no `configuration` uses exactly
 * this; the Crawl Command always uses it, with command-line overrides applied per Run.
 */
export const DEFAULT_CRAWL_CONFIGURATION: CrawlConfiguration = {
  regions: [BELGRADE_REGION, BELGRADE_SMALL_REGION],
  listingPageSize: DEFAULT_LISTING_PAGE_SIZE,
  refreshAgeDays: DEFAULT_REFRESH_AGE_DAYS,
  minRequestIntervalSeconds: DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
  requestBudget: DEFAULT_REQUEST_BUDGET,
};

// ---------------------------------------------------------------------------
// Tile Plan (AC-2, AC-3, AC-4, AC-66, AC-67)
// ---------------------------------------------------------------------------

export const TileSchema = z.strictObject({
  tileNumber: TileNumberSchema,
  bbox: BoundingBoxSchema,
});
export type Tile = z.infer<typeof TileSchema>;

/**
 * Tile Plan: `columns` x `rows` Tiles, west to east within a row, rows south to north, Tile
 * Numbers 1..n in that order. `findTilePlanIssues` states the geometry exactly.
 */
export const TilePlanSchema = z
  .strictObject({
    regionName: RegionNameSchema,
    bbox: BoundingBoxSchema,
    tileSize: TileSizeSchema,
    columns: z.number().int().min(1),
    rows: z.number().int().min(1),
    tiles: z.array(TileSchema).min(1),
  })
  .refine((p) => p.tiles.length === p.columns * p.rows, {
    message: 'a Tile Plan has columns x rows Tiles',
    path: ['tiles'],
  })
  .refine((p) => p.tiles.every((t, i) => t.tileNumber === i + 1), {
    message: 'Tile Numbers run 1..n in plan order',
    path: ['tiles'],
  });
export type TilePlan = z.infer<typeof TilePlanSchema>;

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/** Smallest count of `step`-wide cells that covers `span`, ignoring float noise below `tolerance`. */
export function cellsCovering(
  span: number,
  step: number,
  tolerance = COORDINATE_TOLERANCE,
): number {
  let cells = Math.max(1, Math.ceil(span / step));
  while (cells > 1 && (cells - 1) * step >= span - tolerance) cells -= 1;
  while (cells * step < span - tolerance) cells += 1;
  return cells;
}

/**
 * Pure validator of the Tile Plan rules (glossary "Tile Plan", AC-2, AC-3, AC-66): returns one
 * message per broken rule, empty when `plan` is exactly the plan of `region`.
 * - Same Region Name, Bounding Box and Tile Size as the Region.
 * - The fewest columns and rows of Tile Size that cover the Region; no extra thin column or row
 *   caused by rounding (a column or row narrower than `tolerance`).
 * - Tile (c, r) spans west + c*width .. min(west + (c+1)*width, east), and likewise for latitude:
 *   the last column and row are cut back to the Region's edge; together the Tiles cover the
 *   Region exactly with no gaps and no overlaps beyond shared edges.
 * - Order: west to east within a row, rows south to north; Tile Numbers 1..n.
 */
export function findTilePlanIssues(
  region: Region,
  plan: TilePlan,
  tolerance = COORDINATE_TOLERANCE,
): string[] {
  const issues: string[] = [];
  const { bbox, tileSize } = region;
  if (plan.regionName !== region.name) issues.push('regionName differs from the Region');
  for (const side of ['west', 'south', 'east', 'north'] as const) {
    if (!near(plan.bbox[side], bbox[side], tolerance)) issues.push(`bbox.${side} differs`);
  }
  if (
    !near(plan.tileSize.width, tileSize.width, tolerance) ||
    !near(plan.tileSize.height, tileSize.height, tolerance)
  ) {
    issues.push('tileSize differs from the Region');
  }
  const columns = cellsCovering(bbox.east - bbox.west, tileSize.width, tolerance);
  const rows = cellsCovering(bbox.north - bbox.south, tileSize.height, tolerance);
  if (plan.columns !== columns) issues.push(`expected ${String(columns)} columns`);
  if (plan.rows !== rows) issues.push(`expected ${String(rows)} rows`);
  if (plan.tiles.length !== columns * rows) {
    issues.push(`expected ${String(columns * rows)} tiles`);
    return issues;
  }
  plan.tiles.forEach((tile, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const expected = {
      west: bbox.west + column * tileSize.width,
      east: Math.min(bbox.west + (column + 1) * tileSize.width, bbox.east),
      south: bbox.south + row * tileSize.height,
      north: Math.min(bbox.south + (row + 1) * tileSize.height, bbox.north),
    };
    if (column === columns - 1) expected.east = bbox.east;
    if (row === rows - 1) expected.north = bbox.north;
    if (tile.tileNumber !== index + 1) issues.push(`tile ${String(index + 1)}: wrong Tile Number`);
    for (const side of ['west', 'south', 'east', 'north'] as const) {
      if (!near(tile.bbox[side], expected[side], tolerance)) {
        issues.push(`tile ${String(index + 1)}: ${side} should be ${String(expected[side])}`);
      }
    }
  });
  return issues;
}

/** Pure Tile Plan function, exported as `planTiles` from `src/crawl/tile-plan.ts`. Input is a valid Region. */
export type PlanTilesFn = (region: Region) => TilePlan;

// ---------------------------------------------------------------------------
// Run request and injected collaborators
// ---------------------------------------------------------------------------

/**
 * What the Operator asks for in one Run (AC-59). `regionName` absent = usage failure (AC-60).
 * Overrides replace the Crawl Configuration's value for this Run only and are validated with it
 * (AC-6). `relist` starts a new Listing Pass (AC-24). `dryRun` plans only (AC-8).
 */
export const CrawlRequestSchema = z.strictObject({
  regionName: z.string().exactOptional(),
  dryRun: z.boolean().exactOptional(),
  relist: z.boolean().exactOptional(),
  /**
   * Explicit Retry (crawl-run1-fixes AC-37, AC-40, decision Q5): at the start of this Run, release
   * every Parked Place among the Region Places. No Place ID: always the whole Region.
   */
  retryParked: z.boolean().exactOptional(),
  requestBudget: z.number().exactOptional(),
  minRequestIntervalSeconds: z.number().exactOptional(),
  refreshAgeDays: z.number().exactOptional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequestSchema>;

/**
 * Time collaborator of the Crawl ("Simulated Clock" in tests). A superset of the Client's
 * `Clock`: the Crawl reads `now()` for moments (Run start, Details Fetched At, Last Activity,
 * pacing) and does every wait through `sleep`, including the Client's own Rate-Limit Waits
 * (the Crawl hands the Client a clock that delegates to this one; it may split one long wait
 * into several shorter `sleep` calls to renew Last Activity, AC-70). Nothing waits on real time.
 */
export interface CrawlClock extends Clock {
  now(): Date;
}

/**
 * Collaborators and settings of one Run.
 * - `connectionString`: the database holding the Place Store and Crawl Progress.
 * - `apiKey`: Wikimapia API Key; absent, empty or blank = missing (AC-7). Not needed for a Dry Run.
 * - `configuration`: defaults to DEFAULT_CRAWL_CONFIGURATION; validated by the Run (AC-6).
 * - `transport`, `clock`: default to real HTTPS and real time; tests always inject both (AC-63).
 * - `signal`: Operator interrupt (Ctrl+C, scheduler stop). Once aborted, no new Wikimapia
 *   Request is started and the Run ends Interrupted as a Clean Stop (AC-46). If already
 *   aborted when the Run starts, it sends nothing.
 * - `onWrite`: fault-injection seam, same meaning as the Place Store's `WriteHook`: called after
 *   every write statement the Run executes in the database (Listing Save + Finished Page step,
 *   Details Save, Run Record and Last Activity writes) with the 1-based number of that write
 *   within the Run. If it throws or rejects, the step that write belongs to is rolled back as a
 *   whole and the Place Store counts as unavailable: the Run sends no further request and ends
 *   Failed (AC-14, AC-47). Production code never passes it.
 * - `onProgress`: receives progress lines while the Run works (never secrets, AC-49).
 */
export interface CrawlDependencies {
  connectionString: string;
  apiKey?: string | undefined;
  configuration?: CrawlConfiguration;
  transport?: WikimapiaTransport;
  clock?: CrawlClock;
  signal?: AbortSignal;
  onWrite?: WriteHook;
  onProgress?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Run Outcome, Item Failures, Run Summary (AC-50 .. AC-54)
// ---------------------------------------------------------------------------

/** Run Outcome as a Run reports it (glossary). `abandoned` only ever appears on Run Records. */
export const RunOutcomeSchema = z.enum([
  'completed',
  'budget_reached',
  'rate_limited',
  /** crawl-run1-fixes AC-15 .. AC-20: the Client reported Key Quota Exhausted. A Clean Stop. */
  'quota_exhausted',
  'interrupted',
  'planned',
  'failed',
]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Clean Stops (glossary): every Finished Page and Details Save kept, summary shown. */
export const CLEAN_STOP_OUTCOMES: readonly RunOutcome[] = [
  'budget_reached',
  'rate_limited',
  'quota_exhausted',
  'interrupted',
];

/**
 * Exit status of the Crawl Command (AC-45, AC-61): success (0) for Completed, Budget Reached,
 * Rate Limited, Quota Exhausted (crawl-run1-fixes AC-19, decision Q7) and Planned; failure (1)
 * for Failed and Interrupted.
 */
export function exitCodeFor(outcome: RunOutcome): 0 | 1 {
  return outcome === 'failed' || outcome === 'interrupted' ? 1 : 0;
}

/** Item Failure kinds (glossary): Client Failures other than Rate Limit Exhausted and Configuration, plus Invalid Data. */
export const ItemFailureKindSchema = z.enum([
  'connection',
  'wikimapia_error',
  'unexpected_response',
  'invalid_request',
  'invalid_data',
]);
export type ItemFailureKind = z.infer<typeof ItemFailureKindSchema>;

export const ItemFailureCountsSchema = z.strictObject({
  connection: CountSchema,
  wikimapia_error: CountSchema,
  unexpected_response: CountSchema,
  invalid_request: CountSchema,
  invalid_data: CountSchema,
});
export type ItemFailureCounts = z.infer<typeof ItemFailureCountsSchema>;

/**
 * Run Summary numbers (AC-50). Exact, not estimated (rule 9).
 * - `wikimapiaRequests` = `listingRequests` + `detailsRequests`, Client retries included.
 * - `rateLimitWaits` / `rateLimitWaitSeconds`: waits the Client made after Rate-Limit Responses
 *   and their seconds as actually waited (fallback included, AC-52). Back-off and pacing waits
 *   are not counted here.
 * - `tilesFinished`: Tiles that became Finished Tiles in this Run; `tilesUnfinished`: Tiles of
 *   the current Listing Pass still unfinished at the end (0 when there was no Listing Phase).
 * - `placesListed`: distinct Place IDs in the Listing Pages saved in this Run (AC-16);
 *   `placesNewlyStored`: Places those saves reported Created.
 * - `detailsSaved`: successful Details Saves; `detailsChanged`: those reported Created or Updated.
 * - `placesStillDue`: Places Due for Details of the Region at the end (same cutoff as the Run).
 * - `itemFailures` = sum of `itemFailuresByKind`.
 * - crawl-run1-fixes AC-39 (Parking, 0 for a Dry Run): `placesParkedThisRun`: Places that became
 *   Parked Places in this Run; `placesParked`: Region Places that are Parked (and therefore
 *   skipped, not counted in `placesStillDue`) at the end of the Run; `placesReleased`: Places
 *   released by the Explicit Retry of this Run (0 without the option).
 */
export const RunCountsSchema = z
  .strictObject({
    wikimapiaRequests: CountSchema,
    listingRequests: CountSchema,
    detailsRequests: CountSchema,
    rateLimitWaits: CountSchema,
    rateLimitWaitSeconds: z.number().nonnegative(),
    listingPagesSaved: CountSchema,
    tilesFinished: CountSchema,
    tilesUnfinished: CountSchema,
    placesListed: CountSchema,
    placesNewlyStored: CountSchema,
    detailsSaved: CountSchema,
    detailsChanged: CountSchema,
    placesStillDue: CountSchema,
    itemFailures: CountSchema,
    itemFailuresByKind: ItemFailureCountsSchema,
    placesParkedThisRun: CountSchema,
    placesParked: CountSchema,
    placesReleased: CountSchema,
  })
  .refine((c) => c.placesParkedThisRun <= c.placesParked, {
    message: 'Places parked in this Run are still Parked at its end',
    path: ['placesParkedThisRun'],
  })
  .refine((c) => c.wikimapiaRequests === c.listingRequests + c.detailsRequests, {
    message: 'wikimapiaRequests = listingRequests + detailsRequests',
    path: ['wikimapiaRequests'],
  })
  .refine(
    (c) => c.itemFailures === Object.values(c.itemFailuresByKind).reduce((a, b) => a + b, 0),
    { message: 'itemFailures = sum of itemFailuresByKind', path: ['itemFailures'] },
  )
  .refine((c) => c.detailsChanged <= c.detailsSaved, {
    message: 'detailsChanged <= detailsSaved',
    path: ['detailsChanged'],
  })
  .refine((c) => c.placesNewlyStored <= c.placesListed, {
    message: 'placesNewlyStored <= placesListed',
    path: ['placesNewlyStored'],
  });
export type RunCounts = z.infer<typeof RunCountsSchema>;

/** All-zero counts (Dry Run, AC-10; Runs that failed before any work). */
export const ZERO_RUN_COUNTS: RunCounts = {
  wikimapiaRequests: 0,
  listingRequests: 0,
  detailsRequests: 0,
  rateLimitWaits: 0,
  rateLimitWaitSeconds: 0,
  listingPagesSaved: 0,
  tilesFinished: 0,
  tilesUnfinished: 0,
  placesListed: 0,
  placesNewlyStored: 0,
  detailsSaved: 0,
  detailsChanged: 0,
  placesStillDue: 0,
  itemFailures: 0,
  itemFailuresByKind: {
    connection: 0,
    wikimapia_error: 0,
    unexpected_response: 0,
    invalid_request: 0,
    invalid_data: 0,
  },
  placesParkedThisRun: 0,
  placesParked: 0,
  placesReleased: 0,
};

/**
 * Run Summary (AC-50). `regionName` is absent only when the Run was not given one (AC-60);
 * for an unknown Region it is the name asked for.
 */
export const RunSummarySchema = z
  .strictObject({
    regionName: z.string().min(1).exactOptional(),
    outcome: RunOutcomeSchema,
    startedAt: MomentSchema,
    endedAt: MomentSchema,
    counts: RunCountsSchema,
  })
  .refine((s) => Date.parse(s.endedAt) >= Date.parse(s.startedAt), {
    message: 'endedAt is not before startedAt',
    path: ['endedAt'],
  });
export type RunSummary = z.infer<typeof RunSummarySchema>;

/**
 * Labels of the plain-text Run Summary (AC-54): `summaryText` has one `Label: value` line per
 * item, in this order, values as plain decimal numbers, moments as `MomentSchema` text and the
 * outcome as its OUTCOME_LABELS text. Per-kind failures appear as
 * `Item failures (<ITEM_FAILURE_LABELS[kind]>): n`, one line per kind. A Quota Exhausted Run
 * also shows `Wikimapia message: <text>` (crawl-run1-fixes AC-18).
 */
export const SUMMARY_LABELS = {
  regionName: 'Region',
  outcome: 'Run outcome',
  startedAt: 'Started at',
  endedAt: 'Ended at',
  wikimapiaRequests: 'Wikimapia requests',
  listingRequests: 'Listing page requests',
  detailsRequests: 'Place details requests',
  rateLimitWaits: 'Rate-limit waits',
  rateLimitWaitSeconds: 'Seconds waited for rate limits',
  listingPagesSaved: 'Listing pages saved',
  tilesFinished: 'Tiles finished in this run',
  tilesUnfinished: 'Tiles still unfinished',
  placesListed: 'Places listed',
  placesNewlyStored: 'Places newly stored',
  detailsSaved: 'Details saved',
  detailsChanged: 'Details changed',
  placesStillDue: 'Places still due for details',
  itemFailures: 'Item failures',
  placesParkedThisRun: 'Places parked in this run',
  placesParked: 'Places parked (skipped)',
  placesReleased: 'Places released by explicit retry',
  wikimapiaMessage: 'Wikimapia message',
} as const;

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  completed: 'Completed',
  budget_reached: 'Budget Reached',
  rate_limited: 'Rate Limited',
  quota_exhausted: 'Quota Exhausted',
  interrupted: 'Interrupted',
  planned: 'Planned',
  failed: 'Failed',
};

export const ITEM_FAILURE_LABELS: Record<ItemFailureKind, string> = {
  connection: 'connection failure',
  wikimapia_error: 'Wikimapia error',
  unexpected_response: 'unexpected response',
  invalid_request: 'invalid request',
  invalid_data: 'invalid data',
};

/** The item an Item Failure was met on: a Listing Page (by requested page number) or a Place. */
export const FailedItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('listing_page'),
    tileNumber: TileNumberSchema,
    page: PageNumberSchema,
  }),
  z.strictObject({ kind: z.literal('place_details'), placeId: PlaceIdSchema }),
]);
export type FailedItem = z.infer<typeof FailedItemSchema>;

/**
 * One Item Failure as reported (AC-17, AC-18, AC-36, AC-38). `message` names the item (Tile and
 * page, or Place ID) and the reason (for Invalid Data: the Place Store's reason). Never an API
 * Key, request address with the key, password or Commenter IP (AC-49).
 */
export const ItemFailureReportSchema = z.strictObject({
  item: FailedItemSchema,
  failureKind: ItemFailureKindSchema,
  message: z.string().min(1),
});
export type ItemFailureReport = z.infer<typeof ItemFailureReportSchema>;

/**
 * What a Run resolves to.
 * - `outcome` equals `summary.outcome`.
 * - `message`: present for `failed` (names the reason: unknown Region with the known Region
 *   Names, offending setting, missing API Key, Region definition changed with a hint to relist,
 *   a Run already in progress, Place Store unavailable, Client Configuration Failure, usage);
 *   may be present for other outcomes.
 * - `plan`: present exactly for `planned` (AC-8, AC-68).
 * - `itemFailures`: every Item Failure of the Run, in the order met (`summary.counts.itemFailures` of them).
 * - `runId`: present when the Run kept a Run Record (AC-53).
 * - `summaryText`: the plain-text Run Summary (AC-54, SUMMARY_LABELS).
 * - `message` of a Quota Exhausted Run contains Wikimapia's message text (crawl-run1-fixes AC-18).
 * - `parkedPlacesInRegion`: present for a Dry Run with `retryParked` (crawl-run1-fixes AC-40):
 *   the number of Region Places that are Parked and that the option would release. The Dry Run's
 *   counts stay all zero (AC-39) and nothing is changed in the database.
 */
export const RunReportSchema = z
  .strictObject({
    outcome: RunOutcomeSchema,
    message: z.string().min(1).exactOptional(),
    summary: RunSummarySchema,
    summaryText: z.string().min(1),
    plan: TilePlanSchema.exactOptional(),
    itemFailures: z.array(ItemFailureReportSchema),
    runId: RunIdSchema.exactOptional(),
    parkedPlacesInRegion: CountSchema.exactOptional(),
  })
  .refine((r) => r.outcome === r.summary.outcome, {
    message: 'outcome equals summary.outcome',
    path: ['outcome'],
  })
  .refine((r) => (r.plan !== undefined) === (r.outcome === 'planned'), {
    message: 'a plan is reported exactly for a Dry Run',
    path: ['plan'],
  })
  .refine((r) => r.outcome !== 'failed' || r.message !== undefined, {
    message: 'a Failed Run says why',
    path: ['message'],
  })
  .refine((r) => r.itemFailures.length === r.summary.counts.itemFailures, {
    message: 'one report per Item Failure',
    path: ['itemFailures'],
  })
  .refine((r) => r.parkedPlacesInRegion === undefined || r.outcome === 'planned', {
    message: 'the parked count is reported for a Dry Run only',
    path: ['parkedPlacesInRegion'],
  });
export type RunReport = z.infer<typeof RunReportSchema>;

/**
 * The Run, exported as `runCrawl` from `src/crawl/run-crawl.ts`. Never rejects: every way a Run
 * can end is a `RunReport` (AC-5 .. AC-7, AC-47, AC-48, AC-60, AC-62).
 */
export type RunCrawlFn = (request: CrawlRequest, deps: CrawlDependencies) => Promise<RunReport>;

// ---------------------------------------------------------------------------
// Crawl Command (AC-59 .. AC-61)
// ---------------------------------------------------------------------------

/**
 * Command-line options. Values follow the option as the next argument
 * (`--region belgrade-small --budget 20`). `--min-interval` is in seconds, `--refresh-age` in
 * days. An unparsable value is an invalid setting (AC-6).
 */
export const CRAWL_COMMAND_OPTIONS = {
  region: '--region',
  dryRun: '--dry-run',
  relist: '--relist',
  budget: '--budget',
  minInterval: '--min-interval',
  refreshAge: '--refresh-age',
  /** crawl-run1-fixes AC-40: the Explicit Retry option; takes no value. */
  retryParked: '--retry-parked',
} as const;

/**
 * What the command reads and writes. `env` stands for `process.env` (only WIKIMAPIA_API_KEY and
 * DATABASE_URL are read). `write` receives every output line (progress, failure message and the
 * plain-text Run Summary). The command needs no input from a person (AC-61).
 */
export interface CrawlCommandIO {
  env: Readonly<Partial<Record<typeof API_KEY_ENV | typeof DATABASE_URL_ENV, string>>>;
  write: (line: string) => void;
  transport?: WikimapiaTransport;
  clock?: CrawlClock;
  signal?: AbortSignal;
}

export const CrawlCommandResultSchema = z
  .strictObject({
    exitCode: z.union([z.literal(0), z.literal(1)]),
    report: RunReportSchema,
  })
  .refine((r) => r.exitCode === exitCodeFor(r.report.outcome), {
    message: 'exit code follows the Run Outcome',
    path: ['exitCode'],
  });
export type CrawlCommandResult = z.infer<typeof CrawlCommandResultSchema>;

/**
 * The Crawl Command, exported as `runCrawlCommand` from `src/crawl/command.ts`. Uses
 * DEFAULT_CRAWL_CONFIGURATION with the options' overrides, the Run of `runCrawl`, and the Place
 * Store at `env.DATABASE_URL`. Never rejects. `scripts` of package.json carries
 * `crawl: tsx <script>` calling it with `process.argv.slice(2)`, `process.env`, console output,
 * a SIGINT/SIGTERM AbortSignal, and `process.exitCode = result.exitCode`.
 */
export type RunCrawlCommandFn = (
  argv: readonly string[],
  io: CrawlCommandIO,
) => Promise<CrawlCommandResult>;

// ---------------------------------------------------------------------------
// Crawl Store: Places Due for Details (R1) and Crawl Progress read-back (AC-53, AC-58, AC-69)
// ---------------------------------------------------------------------------

/**
 * R1: Region Places (Centre Point inside `bbox`, edges included) that are Summary-Only or whose
 * Details Fetched At is strictly earlier than `dueBefore`. The Run passes its start moment minus
 * the Refresh Age (AC-30 .. AC-32).
 */
export const PlacesDueInputSchema = z.strictObject({
  bbox: BoundingBoxSchema,
  dueBefore: MomentSchema,
});
export type PlacesDueInput = z.infer<typeof PlacesDueInputSchema>;

/** One Place Due for Details; `detailsFetchedAt` absent for a Summary-Only Place. */
export const DuePlaceSchema = z.strictObject({
  placeId: PlaceIdSchema,
  detailsFetchedAt: MomentSchema.exactOptional(),
});
export type DuePlace = z.infer<typeof DuePlaceSchema>;

/**
 * Details Order (glossary): Summary-Only Places first by ascending Place ID, then Detailed
 * Places by oldest Details Fetched At, ties by ascending Place ID. Pure comparator.
 */
export function compareDetailsOrder(a: DuePlace, b: DuePlace): number {
  if (a.detailsFetchedAt === undefined && b.detailsFetchedAt !== undefined) return -1;
  if (a.detailsFetchedAt !== undefined && b.detailsFetchedAt === undefined) return 1;
  if (a.detailsFetchedAt !== undefined && b.detailsFetchedAt !== undefined) {
    const byMoment = Date.parse(a.detailsFetchedAt) - Date.parse(b.detailsFetchedAt);
    if (byMoment !== 0) return byMoment;
  }
  return a.placeId - b.placeId;
}

export function isInDetailsOrder(places: readonly DuePlace[]): boolean {
  return places.every((p, i) => {
    const previous = places[i - 1];
    return previous === undefined || compareDetailsOrder(previous, p) < 0;
  });
}

export const PlacesDueValueSchema = z
  .strictObject({ places: z.array(DuePlaceSchema) })
  .refine((v) => isInDetailsOrder(v.places), {
    message: 'Places are listed once each, in Details Order',
    path: ['places'],
  });
export type PlacesDueValue = z.infer<typeof PlacesDueValueSchema>;

/** One Finished Page (glossary), by the page number the Crawl asked for (not Wikimapia's echo). */
export const FinishedPageSchema = z.strictObject({
  tileNumber: TileNumberSchema,
  page: PageNumberSchema,
  /** The Run that finished it. */
  runId: RunIdSchema,
  /** Place Summaries on the page; fewer than the Listing Page Size asked for = Short Page. */
  placeCount: CountSchema,
  /** True when the page was the Tile's Short Page (the Tile is then a Finished Tile). */
  short: z.boolean(),
  /** Total Found reported by Wikimapia, kept for information only (AC-58). */
  totalFound: CountSchema.exactOptional(),
});
export type FinishedPage = z.infer<typeof FinishedPageSchema>;

/**
 * One Listing Pass of a Region (glossary), with the Tile Plan inputs it was worked out from
 * (AC-25). `finishedPages` ascending by Tile Number then page; `finishedTiles` ascending.
 * `complete` when every Tile is a Finished Tile.
 */
export const ListingPassSchema = z
  .strictObject({
    passNumber: z.number().int().min(1),
    regionName: RegionNameSchema,
    bbox: BoundingBoxSchema,
    tileSize: TileSizeSchema,
    tileCount: z.number().int().min(1),
    complete: z.boolean(),
    finishedTiles: z.array(TileNumberSchema),
    finishedPages: z.array(FinishedPageSchema),
  })
  .refine((p) => p.complete === (p.finishedTiles.length === p.tileCount), {
    message: 'a pass is complete exactly when every Tile is finished',
    path: ['complete'],
  });
export type ListingPass = z.infer<typeof ListingPassSchema>;

/** Status of a Run Record: a Run Outcome other than Planned, `abandoned` (AC-69) or still `in_progress`. */
export const RunRecordStatusSchema = z.enum([
  'in_progress',
  'completed',
  'budget_reached',
  'rate_limited',
  'quota_exhausted',
  'interrupted',
  'failed',
  'abandoned',
]);
export type RunRecordStatus = z.infer<typeof RunRecordStatusSchema>;

/** Run Record (glossary, AC-53, AC-69): `endedAt` absent while in progress or when abandoned. */
export const RunRecordSchema = z.strictObject({
  runId: RunIdSchema,
  regionName: RegionNameSchema,
  status: RunRecordStatusSchema,
  startedAt: MomentSchema,
  endedAt: MomentSchema.exactOptional(),
  lastActivity: MomentSchema,
  counts: RunCountsSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * Crawl Progress of one Region as kept in the database: Listing Passes oldest first, Run Records
 * oldest first. Region Names, Tile Plans, page numbers, moments and counts only (AC-58).
 */
export const CrawlProgressViewSchema = z.strictObject({
  regionName: RegionNameSchema,
  passes: z.array(ListingPassSchema),
  runs: z.array(RunRecordSchema),
});
export type CrawlProgressView = z.infer<typeof CrawlProgressViewSchema>;

export const CrawlProgressInputSchema = z.strictObject({ regionName: RegionNameSchema });
export type CrawlProgressInput = z.infer<typeof CrawlProgressInputSchema>;

export const PlacesDueResultSchema = storeResultSchema(PlacesDueValueSchema);
export type PlacesDueResult = z.infer<typeof PlacesDueResultSchema>;

export const CrawlProgressResultSchema = storeResultSchema(CrawlProgressViewSchema);
export type CrawlProgressResult = z.infer<typeof CrawlProgressResultSchema>;

/**
 * The Crawl Store. Calls never reject; invalid input is `invalid_data` and never reaches the
 * database; an unreachable database is `store_unavailable` without secrets.
 */
export interface CrawlStore {
  /** R1, gap G2: Places Due for Details of a Bounding Box, in Details Order. */
  listPlacesDueForDetails(input: PlacesDueInput): Promise<PlacesDueResult>;
  /** Crawl Progress and Run Records of one Region (read only; empty lists when none). */
  readCrawlProgress(input: CrawlProgressInput): Promise<CrawlProgressResult>;
  /** Releases the connection pool. Never rejects. */
  close(): Promise<void>;
}

export type CrawlStoreOptions = StoreConfig;

/** Exported as `createCrawlStore` from `src/db/crawl-store.ts`. Never throws. */
export type CreateCrawlStoreFn = (options: CrawlStoreOptions) => CrawlStore;

// ---------------------------------------------------------------------------
// Pure validators used by the contract tests
// ---------------------------------------------------------------------------

/** True when `point` lies inside `bbox`, edges included (glossary "Region Place"). */
export function isInsideBoundingBox(
  point: { lon: number; lat: number },
  bbox: BoundingBox,
): boolean {
  return (
    point.lon >= bbox.west &&
    point.lon <= bbox.east &&
    point.lat >= bbox.south &&
    point.lat <= bbox.north
  );
}

/**
 * Pacing check (AC-39, AC-71): given request start times in milliseconds, returns one message
 * per pair of consecutive starts closer than `minIntervalSeconds`, and per window of
 * `windowSeconds` (end excluded) holding more than `maxPerWindow` starts.
 */
export function findPacingIssues(
  startsMs: readonly number[],
  minIntervalSeconds: number,
  window?: { windowSeconds: number; maxPerWindow: number },
): string[] {
  const issues: string[] = [];
  startsMs.forEach((start, i) => {
    const previous = startsMs[i - 1];
    if (previous !== undefined && start - previous < minIntervalSeconds * 1000) {
      issues.push(
        `request ${String(i + 1)} started ${String(start - previous)} ms after the previous`,
      );
    }
    if (window !== undefined) {
      const inWindow = startsMs.filter(
        (s) => s >= start && s < start + window.windowSeconds * 1000,
      );
      if (inWindow.length > window.maxPerWindow) {
        issues.push(
          `${String(inWindow.length)} requests start within ${String(window.windowSeconds)} s of request ${String(i + 1)}`,
        );
      }
    }
  });
  return issues;
}
