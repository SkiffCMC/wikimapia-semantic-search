# AL4 Design: Hydration Jobs (the Crawl)

- **Feature:** `hydration` (Stage 1, substep 3)
- **AL7 source:** `docs/al7-intent/20261022-hydration-al7.md`
- **AL6 source:** `docs/al6-requirements/20261022-hydration-al6.md` (revision 2, AC-1 .. AC-71, R1 .. R4, decisions Q1 .. Q10)
- **AL5 sources:** `contracts/hydration.schema.ts` (entry points, constants, schemas, `toMoment`, `cellsCovering`, `findTilePlanIssues`, `compareDetailsOrder`, `exitCodeFor`, labels), `contracts/hydration.test.ts` (behaviour, black box, Test Database), `contracts/hydration.schema.test.ts` (schema-only, green before AL2), `contracts/hydration.support.ts` (Simulated Wikimapia, Simulated Clock, test Regions). Edited prior contracts: `contracts/storage.schema.ts` (`SchemaSetup.undoLast()`, `emptyStore()` also clears Crawl Progress and Run Records), `contracts/storage.test.ts` (storage AC-5 narrowed to embeddings/vectors).
- **Builds on:** `docs/al4-design/20261020-wikimapia-client-al4.md` (`src/wikimapia/`, unchanged), `docs/al4-design/20261021-storage-al4.md` (`src/db/`, extended).
- **Binding rules:** `.agrules` sections 1 (offline ingestion: idempotent, resumable, paced, backs off), 2 (Zod at every boundary), 3 (all SQL in `src/db/`, parameterized, versioned migrations), 4 (licensing, no secrets, no Commenter IPs, no live calls in tests, strict types), 5 (extensionless imports, `unknown` only where allowed, types in `types.ts`).
- **Status:** Ready for AL3 Routing

## 0. Scope and Fixed Points

This feature adds the **Crawl**: a command (`pnpm crawl --region <name>`) that walks a configured Region's Tile Plan through the existing Wikimapia Client (Listing Phase, `box`) and then fetches Place Details for every Place Due for Details (Details Phase, `place.getbyid`), saving everything through the Place Store. Progress (Listing Passes, Finished Pages, Run Records) is kept in the database by a new Schema Setup step, so a Run that stops for any reason resumes without repeating Finished Pages. A Run is paced (Minimum Request Interval), capped (Request Budget), stops cleanly on Rate Limit Exhausted, budget or interrupt, and ends with an exact Run Summary.

Fixed by AL5, not to be changed by AL3/AL2:

| Item | Value |
|---|---|
| Entry point 1 | `src/crawl/run-crawl.ts` exports `runCrawl: RunCrawlFn` |
| Entry point 2 | `src/crawl/tile-plan.ts` exports `planTiles: PlanTilesFn` |
| Entry point 3 | `src/crawl/command.ts` exports `runCrawlCommand: RunCrawlCommandFn` |
| Entry point 4 | `src/db/crawl-store.ts` exports `createCrawlStore: CreateCrawlStoreFn` |
| Script | `package.json` `scripts.crawl` starts with `tsx ` (`CRAWL_SCRIPT`) |
| Schema Setup | `SchemaSetup.undoLast()` added to `src/db/schema-setup.ts`; `emptyStore()` also clears Crawl Progress and Run Records |
| Env vars | `WIKIMAPIA_API_KEY` (`API_KEY_ENV`), `DATABASE_URL` (`DATABASE_URL_ENV`), tests: `TEST_DATABASE_URL` |
| Constants | `DEFAULT_CRAWL_CONFIGURATION` (Regions `belgrade`, `belgrade-small`), `DEFAULT_*`, `CONNECTION_RETRY_WAITS_SECONDS` = [30, 60], `ABANDONMENT_AGE_SECONDS` = 3600, `MAX_HEARTBEAT_INTERVAL_SECONDS` = 900, `CONFIGURATION_SETTING_KEYS`, `CRAWL_COMMAND_OPTIONS`, `SUMMARY_LABELS`, `OUTCOME_LABELS`, `ITEM_FAILURE_LABELS` |
| Helpers to reuse (never re-implement) | `toMoment`, `cellsCovering`, `exitCodeFor`, `compareDetailsOrder` (unit tests only), `CrawlRequestSchema`, `CrawlConfigurationSchema`, `TilePlanSchema`, `RunCountsSchema`, `RunReportSchema`, `PlacesDueInputSchema`, `PlacesDueValueSchema`, `CrawlProgressInputSchema`, `CrawlProgressViewSchema`, `ZERO_RUN_COUNTS`; from storage: `storeResultSchema`, `WriteHook`, `StoreConfigSchema`; from the client: `createWikimapiaClient`, `createFetchTransport` |

**Approved contract decisions (stakeholder), designed in as-is:** the Wikimapia Client is not changed; `runCrawl` wraps the injected transport and clock to count requests (Client retries included) and Rate-Limit Waits and applies pacing and budget there; Listing Save + Finished Page record are one atomic database step; long waits are chunked to at most 15 minutes with a Last Activity renewal between chunks; a Request Budget of 0 is valid (Run ends Budget Reached after 0 requests, with a Run Record); summary labels are fixed by `SUMMARY_LABELS`/`OUTCOME_LABELS`/`ITEM_FAILURE_LABELS`; configuration-error messages name the configuration key.

**Single source of truth.** `src/crawl/*` imports schemas, types and helpers from `../../contracts/hydration.schema`, `../../contracts/storage.schema` and `../../contracts/wikimapia-client.schema`; `src/db/*` from `../../contracts/...` (migrations from `../../../contracts/...`). AL2 never copies or redefines them. Contract `z.infer` types are imported with `import type`, never re-exported.

**Code style (`.agrules` section 5).** Extensionless relative imports. Every type alias/interface declared in `src/crawl/` lives in `src/crawl/types.ts`; every one declared in `src/db/` lives in `src/db/types.ts`; both imported with top-level `import type`. `unknown` only for caught errors (and `cause`), raw Knex/pg results parsed with Zod on the next line, and validator parameters for untrusted input.

**HTTP framework:** not needed (the Crawl is a command, no server). The open decision in `CLAUDE.md` stays open.

**Current red state resolved by the units:** `pnpm exec tsc --noEmit` fails in `src/db/schema-setup.ts` (the contract `SchemaSetup` now requires `undoLast`; fixed by U1), and `contracts/hydration.test.ts` cannot resolve `src/crawl/command`, `src/crawl/run-crawl`, `src/crawl/tile-plan`, `src/db/crawl-store` (the 4 lint errors and the matching tsc errors; fixed as the modules appear in U2, U3, U6, U7).

### 0.1 Decisions made by this design (for the orchestrator to record in `CLAUDE.md`)

| Decision | Choice |
|---|---|
| Crawl command | `pnpm crawl --region <name> [--dry-run] [--relist] [--budget <n>] [--min-interval <seconds>] [--refresh-age <days>]`, script `tsx scripts/crawl.ts`; reads `.env` (shell wins); scheduled by OS cron / Task Scheduler, no in-process scheduler |
| Crawl Progress storage | One new Schema Setup step `20261022_01_create_crawl_progress` with tables `crawl_runs`, `crawl_passes`, `crawl_finished_pages` (section 2); no Objection models for them (Knex builder + Zod row schemas) |
| One live Run per Region | Region advisory lock (two-key form) during Run start + partial unique index on `crawl_runs (region_name) WHERE status = 'in_progress'`; Last Activity renewed at most every 60 s of activity and before every wait chunk of at most 840 s, so silence never exceeds 900 s |
| Current Listing Pass | The newest pass of the Region. `--relist` always starts a new pass; an incomplete older pass then stays in history as superseded (never resumed) |
| Write-hook numbering | One Run-wide counter shared by every database write of the Run (start step, Last Activity, Listing step, Details Saves, finish) |
| HTTP framework | Still open (not needed here) |

## 1. Architecture & Subsystems

### 1.1 Module map

Files lower in each table depend only on files above them (and on `src/wikimapia/`, `src/db/` public or internal modules as noted).

**Database side (`src/db/`, all SQL of the feature):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/db/crawl-tables.ts` | constants | Table names of Crawl Progress and the Region lock class. | `CRAWL_TABLES` (`runs: 'crawl_runs'`, `passes: 'crawl_passes'`, `finishedPages: 'crawl_finished_pages'`), `CRAWL_REGION_LOCK_CLASS` (= `20261022`, int4) |
| `src/db/migrations/20261022_01_create_crawl_progress.ts` | migration | The three tables, checks, indexes (section 2). | `up`, `down` |
| `src/db/migrations/index.ts` | migration source | Append the new step as the 5th entry of `MIGRATIONS`. | unchanged names |
| `src/db/schema-setup.ts` | factory (**public**, changed) | Adds `undoLast()`; `emptyStore()` also truncates the crawl tables when they exist; `notConfiguredSetup()` gains `undoLast`. | `createSchemaSetup`, `isTestDatabaseName` |
| `src/db/rows.ts` | Zod (internal, extended) | Row schemas for crawl queries. | adds `RunRowSchema`, `PassRowSchema`, `FinishedPageRowSchema`, `PassTileRowSchema`, `DuePlaceRowSchema`, `CountRowSchema`, `IdRowSchema` |
| `src/db/validate.ts` | pure (extended) | Validators for the Crawl Store inputs. | adds `validatePlacesDueInput`, `validateCrawlProgressInput` |
| `src/db/places-due.ts` | SQL (read) | R1 query: Places Due for Details of a bbox, in Details Order; and its count. | `selectPlacesDue`, `countPlacesDue` |
| `src/db/crawl-progress.ts` | SQL (read + write steps) | Crawl Progress reads (`readProgressView`, pass state) and the write steps of a Run (start, renew, listing step, finish). | `readProgressView`, `beginRunStep`, `renewActivityStep`, `listingPageStep`, `finishRunStep` |
| `src/db/save-listing.ts` | SQL (write, refactored) | Extract the in-transaction body of the Listing Save so the listing step can reuse it inside its own transaction. Behaviour of `saveListing` unchanged. | `saveListing`, **new** `writeListingPage` |
| `src/db/crawl-repository.ts` | factory (internal) | The Run's database handle: one Knex pool, the Run-wide write hook, every call guarded, never rejects. Used only by `src/crawl/`. | `openCrawlRepository` |
| `src/db/crawl-store.ts` | factory (**public**) | `createCrawlStore`: `listPlacesDueForDetails`, `readCrawlProgress`, `close`. | `createCrawlStore` |

**Crawl side (`src/crawl/`, no SQL, no direct network):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/crawl/types.ts` | types only | Every type alias/interface of `src/crawl/`. | section 1.3 |
| `src/crawl/tile-plan.ts` | pure (**public**) | Tile Plan of a Region. | `planTiles` |
| `src/crawl/config.ts` | pure | Validates the request and the Crawl Configuration, applies overrides, resolves the Region, builds failure messages that name the setting key. | `resolveRun`, `knownRegionNames`, `usageMessage`, `isMissingApiKey` |
| `src/crawl/report.ts` | pure | Run tally (counters, distinct Places listed, Item Failures), counts snapshot, summary text, report builders. | `createTally`, `formatSummaryText`, `buildReport`, `failedReport`, `plannedReport`, `formatPlanLines` |
| `src/crawl/runtime.ts` | I/O defaults | Real-time `CrawlClock` whose `sleep` ends early on abort; default transport. | `createSystemCrawlClock`, `defaultTransport` |
| `src/crawl/gateway.ts` | I/O wrapper (no DB) | Wraps the injected transport and clock: budget, pacing, interrupt, request and Rate-Limit Wait counting, chunked waits with Last Activity renewal. Hands the wrapped pair to the Client. | `createGateway`, `WAIT_CHUNK_MS`, `RENEW_AFTER_MS` |
| `src/crawl/requests.ts` | orchestration helper | One Client call with Connection Failure back-off and classification into ok / Item Failure / stop. | `requestWithBackoff` |
| `src/crawl/listing-phase.ts` | orchestration | Listing Phase over the current pass. | `runListingPhase` |
| `src/crawl/details-phase.ts` | orchestration | Details Phase over the Places Due for Details. | `runDetailsPhase` |
| `src/crawl/run-crawl.ts` | factory (**public**) | The Run: validation, Dry Run, start step, phases, end, report. Never rejects. | `runCrawl` |
| `src/crawl/command.ts` | CLI core (**public**) | Argument parsing, env, output lines, exit code. Never rejects. | `runCrawlCommand`, `parseCrawlArgs` |
| `scripts/crawl.ts` | script (`tsx`) | Loads `.env`, wires `process.argv`, `process.env`, stdout, SIGINT/SIGTERM, `process.exitCode`. | none |

Unit tests: `tests/crawl/<module>.test.ts` (pure, Simulated Clock/Wikimapia from `contracts/hydration.support.ts`), `tests/crawl/<topic>.db.test.ts` and `tests/db/crawl-*.db.test.ts` (need the Test Database; they apply Schema Setup in `beforeAll`, `emptyStore()` in `beforeEach`, and never issue SQL themselves). Tests never edit `contracts/`.

### 1.2 Run flow

```
runCrawl(request, deps)                                         (never rejects; outer try/catch -> failedReport 'internal error')
  clock = deps.clock ?? createSystemCrawlClock(deps.signal); startMs = clock.now(); startedAt = toMoment(startMs)
  1. resolveRun(request, deps.configuration ?? DEFAULT_CRAWL_CONFIGURATION)   pure; no DB, no request
       invalid request/config -> Failed (message names the key, AC-6)
       regionName absent/blank -> Failed usage (AC-60); unknown Region -> Failed listing known names (AC-5)
  2. dryRun -> plannedReport(plan)                                              no DB, no key needed (AC-8 .. AC-10, AC-68)
  3. API Key absent/blank -> Failed 'Wikimapia API key is missing ...' (AC-7, AC-48)
  4. repo = openCrawlRepository({ connectionString, onWrite: deps.onWrite })    try { ... } finally { repo.close() }
       (the repository owns the single Run-wide write counter; runCrawl adds none)
  5. repo.beginRun(...)    one transaction: Region lock, live-run check, pass check, abandon, insert Run Record, new pass
       store failure -> Failed (no runId); live Run -> Failed 'already in progress' (AC-62);
       definition changed -> Failed with relist hint (AC-25); nothing written in these cases
  6. gateway = createGateway(...); client = createWikimapiaClient({ apiKey, transport: gateway.transport, clock: gateway.clock })
     signal already aborted -> gateway.stop('interrupted')                       (AC-46 second case: Run Record kept, 0 requests)
  7. pass defined and not stopped -> runListingPhase                             (AC-11 .. AC-24)
  8. not stopped -> runDetailsPhase                                              (AC-19, AC-28 .. AC-38)
  9. outcome = gateway.stopped?.reason ?? 'completed'
     placesStillDue = repo.countPlacesDue(region bbox, dueBefore)                (fallback estimate if the store fails)
     repo.finishRun(runId, outcome, endedAt, counts)   failure -> outcome 'failed' + one best-effort finishRun('failed')
 10. buildReport -> gated with RunReportSchema (a failing gate yields failedReport 'internal error')
```

### 1.3 Component contracts (signatures)

```ts
// ---------------------------------------------------------------- src/crawl/types.ts (types only)
import type { BoundingBox, Clock, ClientFailure, ListingPage, PlaceDetails, WikimapiaTransport }
  from '../../contracts/wikimapia-client.schema';
import type { CrawlClock, CrawlConfiguration, CrawlRequest, FailedItem, ItemFailureKind, ItemFailureReport,
  Region, RunCounts, RunOutcome, RunReport, TilePlan } from '../../contracts/hydration.schema';

export type StopReason = Exclude<RunOutcome, 'completed' | 'planned'>;    // budget_reached | rate_limited | interrupted | failed
export interface Stop { reason: StopReason; message?: string }
export type RequestKind = 'listing' | 'details';

export interface ResolvedRun {
  regionName: string; region: Region; configuration: CrawlConfiguration;  // overrides applied, validated
  plan: TilePlan; dryRun: boolean; relist: boolean;
}
export type Resolution =
  | { ok: true; run: ResolvedRun }
  | { ok: false; message: string; regionName?: string };                  // regionName: the name asked for, if any

export type HeartbeatOutcome = { ok: true } | { ok: false; message: string };
export interface GatewayOptions {
  transport: WikimapiaTransport; clock: CrawlClock; signal: AbortSignal | undefined;
  minRequestIntervalSeconds: number; requestBudget: number;
  heartbeat: () => Promise<HeartbeatOutcome>;                            // renews Last Activity
  lastRenewalMs: number;                                                  // the Run start (Run Record insert)
}
export interface GatewayCounts { listingRequests: number; detailsRequests: number; rateLimitWaits: number; rateLimitWaitMs: number }
export interface Gateway {
  readonly transport: WikimapiaTransport;                                 // handed to the Client
  readonly clock: CrawlClock;                                             // handed to the Client; its sleep = Rate-Limit Wait
  setKind(kind: RequestKind): void;
  stop(reason: StopReason, message?: string): void;                       // first stop wins
  readonly stopped: Stop | undefined;
  readonly requestsSent: number;
  counts(): GatewayCounts;
  wait(ms: number): Promise<number>;                                      // crawl's own wait (back-off); ms actually waited
}

export type Requested<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'item_failure'; failureKind: ItemFailureKind; message: string }
  | { kind: 'stopped' };
export type ClientCall<T> = () => Promise<{ ok: true; value: T } | { ok: false; failure: ClientFailure }>;

export interface Tally {
  pageSaved(placeIds: readonly number[], createdCount: number, tileFinished: boolean): void;
  detailsSaved(changed: boolean): void;
  itemFailure(item: FailedItem, failureKind: ItemFailureKind, message: string): void;
  readonly failures: readonly ItemFailureReport[];
  snapshot(gateway: GatewayCounts, extra: { tilesUnfinished: number; placesStillDue: number }): RunCounts;
}
export interface PassCursor { passNumber: number; tileCount: number; finishedTiles: Set<number>; lastFinishedPage: Map<number, number> }
export interface RunContext {                                             // shared by the two phases
  run: ResolvedRun; runId: number; startMs: number; dueBefore: string;
  gateway: Gateway; client: WikimapiaClient;                              // contract type, built by createWikimapiaClient
  repo: CrawlRepository; tally: Tally; clock: CrawlClock; signal: AbortSignal | undefined;
  progress: (line: string) => void;
}

// ---------------------------------------------------------------- src/crawl/*.ts
export const planTiles: PlanTilesFn;                                                  // tile-plan.ts
export function resolveRun(request: CrawlRequest, configuration: CrawlConfiguration): Resolution;   // config.ts
export function knownRegionNames(configuration: CrawlConfiguration): string[];
export function usageMessage(names: readonly string[]): string;
export function isMissingApiKey(apiKey: string | undefined): boolean;                // undefined, '' or blank
export function createTally(): Tally;                                                 // report.ts
export function formatSummaryText(summary: RunSummary): string;
export function buildReport(input: { outcome: RunOutcome; message?: string; regionName?: string; startedAt: string;
  endedAt: string; counts: RunCounts; failures: readonly ItemFailureReport[]; runId?: number; plan?: TilePlan }): RunReport;
export function failedReport(message: string, regionName: string | undefined, at: string): RunReport;   // zero counts
export function plannedReport(plan: TilePlan, at: string): RunReport;
export function formatPlanLines(plan: TilePlan): string[];
export function createSystemCrawlClock(signal?: AbortSignal): CrawlClock;             // runtime.ts
export const defaultTransport: () => WikimapiaTransport;                              // = createFetchTransport()
export function createGateway(options: GatewayOptions): Gateway;                      // gateway.ts
export const WAIT_CHUNK_MS = 840_000;   // (MAX_HEARTBEAT_INTERVAL_SECONDS - 60) * 1000
export const RENEW_AFTER_MS = 60_000;
export function requestWithBackoff<T>(gateway: Gateway, kind: RequestKind, signal: AbortSignal | undefined,
  call: ClientCall<T>): Promise<Requested<T>>;                                        // requests.ts
export function runListingPhase(ctx: RunContext, pass: PassCursor): Promise<void>;    // listing-phase.ts
export function runDetailsPhase(ctx: RunContext): Promise<{ dueLoaded: number }>;     // details-phase.ts
export const runCrawl: RunCrawlFn;                                                     // run-crawl.ts
export function parseCrawlArgs(argv: readonly string[]):                               // command.ts
  { ok: true; request: CrawlRequest } | { ok: false; problem: string };
export const runCrawlCommand: RunCrawlCommandFn;

// ---------------------------------------------------------------- src/db/types.ts (additions)
import type { DuePlace, Moment, PlacesDueInput, RunCounts, RunRecordStatus, TileSize }
  from '../../contracts/hydration.schema';
export type RunRow = z.infer<typeof RunRowSchema>;   // and PassRow, FinishedPageRow, PassTileRow, DuePlaceRow, CountRow, IdRow
export interface PassState { passNumber: number; tileCount: number; finishedTiles: number[]; lastFinishedPage: [number, number][] }
export interface BeginRunInput {
  regionName: string; bbox: BoundingBox; tileSize: TileSize; tileCount: number; relist: boolean;
  startedAt: Moment; abandonBefore: Moment; counts: RunCounts;
}
export type BeginRunValue =
  | { kind: 'started'; runId: number; pass?: PassState; abandonedRunIds: number[] }  // key omitted (complete pass) = no Listing Phase
  | { kind: 'run_in_progress'; runId: number; lastActivity: Moment }
  | { kind: 'region_changed'; passNumber: number };
export interface RenewInput { runId: number; at: Moment; counts: RunCounts }
export interface ListingStepInput {
  runId: number; regionName: string; passNumber: number; tileNumber: number; page: number;
  listing: ListingPage; short: boolean; finishedAt: Moment;
}
export type ListingStepValue = { kind: 'saved'; report: SaveReport } | { kind: 'taken_over' };
export type FinalRunStatus = Exclude<RunRecordStatus, 'in_progress' | 'abandoned'>;
export interface FinishInput { runId: number; status: FinalRunStatus; endedAt: Moment; counts: RunCounts }
export interface DueQuery extends PlacesDueInput { limit?: number }
export interface CrawlRepositoryOptions { connectionString: string; onWrite?: WriteHook }
export interface CrawlRepository {                                         // every method resolves, never rejects
  beginRun(input: BeginRunInput): Promise<StoreResult<BeginRunValue>>;
  renewActivity(input: RenewInput): Promise<StoreResult<{ alive: boolean }>>;
  recordListingPage(input: ListingStepInput): Promise<StoreResult<ListingStepValue>>;
  saveDetails(input: SavePlaceDetailsInput): Promise<StoreResult<SaveReport>>;
  listPlacesDue(query: DueQuery): Promise<StoreResult<DuePlace[]>>;
  countPlacesDue(input: PlacesDueInput): Promise<StoreResult<number>>;
  finishRun(input: FinishInput): Promise<StoreResult<{ updated: boolean }>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- src/db/*.ts (additions)
export function writeListingPage(trx: Knex.Transaction, places: readonly PlaceSummary[], writer: Writer): Promise<SaveReport>;  // save-listing.ts
export function selectPlacesDue(db: Knex | Knex.Transaction, query: DueQuery): Promise<DuePlace[]>;                         // places-due.ts
export function countPlacesDue(db: Knex | Knex.Transaction, input: PlacesDueInput): Promise<number>;
export function readProgressView(trx: Knex.Transaction, regionName: string): Promise<CrawlProgressView>;                  // crawl-progress.ts
export function beginRunStep(db: Knex, input: BeginRunInput, onWrite: WriteHook | undefined): Promise<BeginRunValue>;
export function renewActivityStep(db: Knex, input: RenewInput, onWrite: WriteHook | undefined): Promise<{ alive: boolean }>;
export function listingPageStep(db: Knex, input: ListingStepInput, onWrite: WriteHook | undefined): Promise<ListingStepValue>;
export function finishRunStep(db: Knex, input: FinishInput, onWrite: WriteHook | undefined): Promise<{ updated: boolean }>;
export function openCrawlRepository(options: CrawlRepositoryOptions): CrawlRepository;                                     // crawl-repository.ts
export const createCrawlStore: CreateCrawlStoreFn;                                                                          // crawl-store.ts
export function validatePlacesDueInput(input: unknown): Validated<PlacesDueInput>;                                         // validate.ts
export function validateCrawlProgressInput(input: unknown): Validated<CrawlProgressInput>;
```

The `*Step` functions throw on any DB or hook error (the transaction rolls back); `crawl-repository.ts` maps that with `unavailableFrom(error, '<action>')` from `src/db/failures.ts` (never copies an error message).

### 1.4 Detailed behaviour per subsystem

#### 1.4.1 Resolving the Run (`config.ts`; AC-1, AC-5, AC-6, AC-7, AC-59, AC-60, AC-67)

```
resolveRun(request, configuration):
  r = CrawlRequestSchema.safeParse(request)          -> fail settingMessage(first issue)        (e.g. requestBudget NaN)
  merged = { ...configuration, + each override present in r.data (requestBudget, minRequestIntervalSeconds, refreshAgeDays) }
  c = CrawlConfigurationSchema.safeParse(merged)     -> fail settingMessage(first issue)
  names = c.data.regions.map(name)
  regionName = r.data.regionName?.trim(); empty/absent -> fail usageMessage(names)               (AC-60)
  region = find by exact name; none -> fail `Unknown region "${regionName}". Known regions: ${names.join(', ')}.`  (AC-5)
  plan = planTiles(region)
  ok { regionName, region, configuration: c.data, plan, dryRun: r.data.dryRun === true, relist: r.data.relist === true }

settingMessage(issue, merged): key = first element of issue.path found in CONFIGURATION_SETTING_KEYS
  (paths look like ['regions', 0, 'bbox', 'east'], ['regions', 0, 'tileSize', 'width'], ['listingPageSize'], ['requestBudget'])
  key found:   `Invalid crawl configuration: setting "${key}"${regionPart}: ${issue.message}`   regionPart = ` of region "${name}"` when path[0]==='regions' and the region's name is a string
  key missing: `Invalid crawl configuration: ${formatIssuePath(issue.path)}: ${issue.message}`
usageMessage(names) = `No region given. Usage: pnpm crawl ${CRAWL_COMMAND_OPTIONS.region} <name> [--dry-run] [--relist] [--budget <n>] [--min-interval <seconds>] [--refresh-age <days>]. Known regions: ${names.join(', ')}.`
```

- Only Zod issue messages and paths are used, never input values (no secrets can leak).
- The unknown-Region message must contain exactly the known names and the asked name; AC-1 matches `/\bbelgrade(?:-[a-z0-9-]+)?\b/g` on it, so no other `belgrade-*` word may appear.
- Invalid configuration fails even for a Dry Run (validation comes first); no database is opened before step 4 of 1.2 (AC-6 "database unchanged").
- `isMissingApiKey(k)` = `k === undefined || k.trim() === ''`. Message: `Wikimapia API key is missing: set ${API_KEY_ENV}.` (never a value; AC-7, AC-49). A blank key such as `' \t '` is therefore reported as missing before the Client is built (AC-48 also holds). A Client `configuration` failure later is still handled (1.4.4).

#### 1.4.2 Tile Plan (`tile-plan.ts`; AC-2, AC-3, AC-4, AC-66, AC-67)

```
planTiles(region):
  { west, south, east, north } = region.bbox; { width, height } = region.tileSize
  columns = cellsCovering(east - west, width); rows = cellsCovering(north - south, height)   (contract helper)
  for r in 0..rows-1, for c in 0..columns-1:                         rows south to north, west to east within a row
     tw = round9(west + c*width);  te = c === columns-1 ? east  : round9(west + (c+1)*width)
     ts = round9(south + r*height); tn = r === rows-1    ? north : round9(south + (r+1)*height)
     tiles.push({ tileNumber: r*columns + c + 1, bbox: { west: tw, south: ts, east: te, north: tn } })
  return { regionName: region.name, bbox: { ...region.bbox }, tileSize: { ...region.tileSize }, columns, rows, tiles }
round9(x) = Math.round(x * 1e9) / 1e9          (removes float noise such as 20.745000000000001 so Wikimapia URLs carry clean numbers)
```

Pure and deterministic (AC-4). The first column/row edge is the Region edge itself (no rounding), the last is cut back to the Region edge exactly. `cellsCovering` guarantees no thin extra column/row (AC-66). Big Belgrade: 120 x 66 = 7,920 Tiles. The plan is the input of the Listing Phase and is recomputed on every Run (cheap; it is never stored, only its inputs are, section 2.2).

#### 1.4.3 Gateway: counting, pacing, budget, interrupt, Last Activity (`gateway.ts`; G1/R4, AC-39 .. AC-43, AC-46, AC-50 .. AC-52, AC-70, AC-71)

The Client is built per Run with the Gateway's `transport` and `clock`. Every call of `gateway.transport` is one Wikimapia Request (Client retries included); every `gateway.clock.sleep` with `ms > 0` is one Rate-Limit Wait (the Client sleeps only after Rate-Limit Responses, fallback waits included). The Crawl's own waits (pacing, Connection Failure back-off) go through the internal `waitChunked` and are never counted as Rate-Limit Waits.

```
state: stopped?: Stop; sent = 0; byKind = { listing: 0, details: 0 }; kind = 'listing'
       lastStartMs?: number; lastRenewalMs = options.lastRenewalMs; rateLimitWaits = 0; rateLimitWaitMs = 0
REFUSED = () => new Error('request not sent by the crawl')      (no cause; the Client maps it to a connection failure,
                                                                   which the crawl ignores because `stopped` is set)
transport(request):
  if stopped                         -> throw REFUSED()
  if signal?.aborted                 -> stop('interrupted'); throw REFUSED()
  if sent >= requestBudget           -> stop('budget_reached', `Request Budget of ${budget} used up.`); throw REFUSED()
  if lastStartMs !== undefined:
     dueMs = lastStartMs + minRequestIntervalSeconds*1000 - clock.now().getTime()
     if dueMs > 0: await waitChunked(dueMs)
     if stopped -> throw REFUSED(); if signal?.aborted -> stop('interrupted'); throw REFUSED()
  await renewIfDue(); if stopped -> throw REFUSED()
  lastStartMs = clock.now().getTime(); sent += 1; byKind[kind] += 1
  return inner.transport(request)    (rejections pass through unchanged; the Client turns them into connection failures)

clock.now()      = inner.now()
clock.sleep(ms)  : if ms <= 0 return; rateLimitWaits += 1; rateLimitWaitMs += await waitChunked(ms)

waitChunked(ms): slept = 0; remaining = ms
  while remaining > 0:
    if stopped or signal?.aborted: break
    await renewIfDue(); if stopped: break
    chunk = min(remaining, WAIT_CHUNK_MS)
    before = clock.now(); await inner.sleep(chunk); actual = clock.now() - before (bounded to [0, chunk])
    slept += actual; remaining -= chunk
  return slept
wait(ms) = waitChunked(ms)                                         (back-off)

renewIfDue(): if clock.now() - lastRenewalMs < RENEW_AFTER_MS return
  r = await options.heartbeat()                                    (writes Last Activity + counts snapshot)
  if r.ok: lastRenewalMs = clock.now() else stop('failed', r.message)
```

- **Pacing** counts from the start of the previous request (AC-40), applies to Client retries and across both phases (AC-39, AC-71); the first request of a Run is not delayed. Default 6 s gives at most 50 starts in any 300 s window.
- **Budget** is checked before pacing (no pointless wait) and is a hard limit including retries (AC-41 .. AC-43). Budget 0 refuses the first request (Budget Reached, 0 requests, AC-53).
- **Interrupt**: no new request starts after abort; the real clock's `sleep` resolves early on abort (`runtime.ts`), so Ctrl+C does not wait out a long chunk. With the Simulated Clock the chunk loop checks the signal between chunks.
- **Rate-Limit Wait seconds** are the time actually waited (AC-52); `actual` is measured on the clock (equal to `chunk` on the Simulated Clock; shorter when aborted). `rateLimitWaitSeconds = rateLimitWaitMs / 1000`.
- **Last Activity guarantee (AC-70):** renewal happens before every request and before every wait chunk once 60 s have passed since the last renewal; chunks are at most 840 s. Silence therefore never exceeds 60 + 840 = 900 s (strictly less), within the contract tolerance (`MAX_HEARTBEAT_INTERVAL_SECONDS` + 1 s, moments truncated to seconds). The Run Record insert counts as the first renewal (`lastRenewalMs` = Run start).
- **Write load:** at most one Last Activity write per minute of Run time, plus at most one per wait chunk.
- `counts()` returns `{ listingRequests, detailsRequests, rateLimitWaits, rateLimitWaitMs }`; `wikimapiaRequests` = their sum (= `sent`).

#### 1.4.4 One Client call with back-off and classification (`requests.ts`; AC-17, AC-18, AC-36, AC-38, AC-43, AC-44, AC-48)

```
requestWithBackoff(gateway, kind, signal, call):
  gateway.setKind(kind)
  for attempt = 0; ; attempt += 1:
    result = await call()
    if gateway.stopped                            -> { kind: 'stopped' }      (refusals, store failure in renewal, ...)
    if result.ok                                  -> { kind: 'ok', value }     (saved even if the signal was aborted meanwhile, AC-46)
    f = result.failure
    switch f.kind:
      'rate_limit_exhausted' -> gateway.stop('rate_limited', `Wikimapia kept answering with its rate limit after ${f.attempts} attempts.`) -> stopped
      'configuration'        -> gateway.stop('failed', f.message) -> stopped                                     (AC-48)
      'connection':
          if signal?.aborted -> gateway.stop('interrupted') -> stopped
          if attempt < CONNECTION_RETRY_WAITS_SECONDS.length:
              await gateway.wait(CONNECTION_RETRY_WAITS_SECONDS[attempt] * 1000)
              if gateway.stopped -> stopped; if signal?.aborted -> gateway.stop('interrupted') -> stopped
              continue                                                                                         (AC-17: 30 s, then 60 s)
          -> { kind: 'item_failure', failureKind: 'connection', message: f.message }
      'wikimapia_error' | 'unexpected_response' | 'invalid_request'
          -> { kind: 'item_failure', failureKind: f.kind, message: f.message }                                 (no retry, AC-18)
```

The Client's failure messages are already redacted (no key, no URL); the crawl never adds the request address or `wikimapiaMessage`. A request in progress when the budget runs out inside the Client's retry loop ends `stopped` and is neither saved nor counted as an Item Failure (AC-43); likewise for Rate Limit Exhausted (AC-44).

#### 1.4.5 Run start, one Run per Region, abandonment (`crawl-progress.ts` `beginRunStep`; AC-24, AC-25, AC-53, AC-62, AC-69)

`abandonBefore = toMoment(new Date(Date.parse(startedAt) - ABANDONMENT_AGE_SECONDS * 1000))`. One READ COMMITTED transaction, writes through a Writer created with the Run-wide hook:

```
await trx.raw('select pg_advisory_xact_lock(?::int4, hashtext(?))', [CRAWL_REGION_LOCK_CLASS, regionName])
live = select run_id, last_activity (as text) from crawl_runs where region_name = ? and status = 'in_progress' order by run_id for update
if some live row has last_activity >= abandonBefore -> return { kind: 'run_in_progress', runId, lastActivity }    (no write; AC-62)
current = newest crawl_passes row of the Region + per-tile aggregates (1.4.6 PassState query)
if !relist and current and !complete(current) and !sameDefinition(current, input) -> return { kind: 'region_changed', passNumber }  (AC-25)
-- from here on, writes:
for each live row (all abandoned now): writer.run(update crawl_runs set status = 'abandoned' where run_id = ?)   (counts, last_activity kept; AC-69)
runId = (select nextval(pg_get_serial_sequence('crawl_runs', 'run_id')))   read; returns int8 -> number
writer.run(insert crawl_runs (run_id, region_name, status 'in_progress', started_at, last_activity = started_at, counts = ZERO_RUN_COUNTS))
if relist or !current: passNumber = (current?.pass_number ?? 0) + 1
   writer.run(insert crawl_passes (region_name, pass_number, bbox_*, tile_width, tile_height, tile_count, started_by_run_id = runId, started_at))
   pass = { passNumber, tileCount, finishedTiles: [], lastFinishedPage: [] }
else if !complete(current): pass = PassState of current
else pass = undefined                                                                  (complete pass, no relist: no Listing Phase, AC-23, AC-24)
return { kind: 'started', runId, pass, abandonedRunIds }
```

- `sameDefinition`: every bbox side and both tile sizes within `COORDINATE_TOLERANCE`, and `tile_count` equal to the new plan's count.
- A live-Run refusal and a definition change write nothing; the transaction ends without changes (AC-25, AC-62 "changes no Crawl Progress").
- "Exactly 1 hour ago is not abandoned": `last_activity >= abandonBefore` keeps it live (AC-62, AC-69).
- `relist` while the current pass is incomplete starts a new pass; the old one is superseded (kept, never resumed). A changed definition plus `relist` starts a new pass with the new definition (the AC-25 hint).
- The partial unique index (2.1) is a backstop: two concurrent starts are already serialized by the Region lock.
- Different Regions take different lock keys and never block each other (AC-26, AC-62).

#### 1.4.6 Listing Phase (`listing-phase.ts`, `crawl-progress.ts` `listingPageStep`; AC-11 .. AC-22, AC-26, AC-27)

PassState query (inside the start transaction): `select tile_number, max(page_no) as last_page, bool_or(is_short) as finished from crawl_finished_pages where region_name = ? and pass_number = ? group by tile_number`. `complete(pass)` = number of finished tiles = `tile_count`.

```
runListingPhase(ctx, pass):
  for tile of ctx.run.plan.tiles (Tile Number order):                                       (AC-15, AC-21)
    if pass.finishedTiles.has(tile.tileNumber) continue
    page = (pass.lastFinishedPage.get(tile.tileNumber) ?? 0) + 1                             (AC-20, AC-22)
    loop:
      if ctx.gateway.stopped return
      r = await requestWithBackoff(gateway, 'listing', signal,
            () => client.listPlaces({ bbox: tile.bbox, page, pageSize: configuration.listingPageSize }))
      'stopped'      -> return
      'item_failure' -> tally.itemFailure({ kind: 'listing_page', tileNumber, page }, kind, `Tile ${n} page ${page}: ${message}`); break
      'ok':
        short = r.value.places.length < configuration.listingPageSize                        (Short Page rule, AC-12, AC-13)
        s = await repo.recordListingPage({ runId, regionName, passNumber, tileNumber, page, listing: r.value, short,
                                           finishedAt: toMoment(clock.now()) })
        !s.ok and invalid_data      -> item failure 'invalid_data' `Tile ${n} page ${page}: the Place Store rejected the page: ${failure.message}`; break
        !s.ok (store_unavailable)   -> gateway.stop('failed', failure.message); return                      (AC-47)
        taken_over                  -> gateway.stop('failed', `This Run for region "${name}" was taken over by a newer Run.`); return
        saved -> tally.pageSaved(ids, created count, short); pass.lastFinishedPage.set(n, page)
                 if short: pass.finishedTiles.add(n); break  else page += 1
```

`listingPageStep(db, input, hook)` = the atomic step of gap G4 (AC-14):

```
v = validateListingInput(input.listing)               invalid -> throw a typed InvalidData carrier caught by the repository -> invalid_data
db.transaction(async trx => {
  alive = select 1 from crawl_runs where run_id = ? and status = 'in_progress' for update      (not a write)
  if !alive return { kind: 'taken_over' }                                                         (no write)
  writer = createWriter(hook)
  places = dedupeListing(v.places)
  report = places.length === 0 ? { places: [] } : await writeListingPage(trx, places, writer)      (same statements as a Listing Save)
  await writer.run(trx(CRAWL_TABLES.finishedPages).insert({ region_name, pass_number, tile_number, page_no: page, run_id,
                   place_count: v.places.length, is_short: short, reported_total: v.totalFound, finished_at }))
  return { kind: 'saved', report }
})
```

- The page's Listing Save and its Finished Page row commit or roll back together; a hook failure at any write of the step rolls all of it back (AC-14, AC-47).
- The run-row lock serializes a zombie Run's late page step with a takeover (the takeover's `abandoned` update waits for it, then reads the committed pages), so a Finished Page is never inserted twice. A duplicate primary key would be a bug and surfaces as `store_unavailable`.
- `writeListingPage` is the body of today's `saveListing` transaction (advisory locks per place, `loadListingState`, `planListingSave`, writes); `saveListing` becomes `dedupe -> empty? -> db.transaction(trx => writeListingPage(trx, places, createWriter(onWrite)))`. Statements, order and write counts of the storage feature are unchanged.
- Places listed counts distinct Place IDs of saved pages (a Place in two Tiles counts once, AC-16); Places newly stored counts `created` outcomes.
- The Details Phase runs after the Listing Phase even when Tiles stayed unfinished because of Item Failures (AC-19, AC-35).

#### 1.4.7 Details Phase (`details-phase.ts`, `places-due.ts`; R1, AC-28 .. AC-38, AC-44)

```
dueBefore = toMoment(new Date(startMs - refreshAgeDays * 86_400_000))                     (Run start minus Refresh Age, AC-30 .. AC-32)
limit = max(1, requestBudget - gateway.requestsSent + 1)   each Place needs >= 1 request; +1 so an exhausted budget is still detected (AC-41)
due = await repo.listPlacesDue({ bbox: region.bbox, dueBefore, limit })   store failure -> gateway.stop('failed', message)
for place of due (Details Order):
  if gateway.stopped break
  r = await requestWithBackoff(gateway, 'details', signal, () => client.getPlaceDetails({ placeId: place.placeId }))
  'stopped' -> break
  'item_failure' -> tally.itemFailure({ kind: 'place_details', placeId }, kind, `Place ${id}: ${message}`); continue  (AC-36)
  'ok' -> fetchedAt = toMoment(clock.now())                                          (receive moment, after any waits; AC-28, AC-29)
          s = await repo.saveDetails({ details: r.value, fetchedAt })
          ok -> tally.detailsSaved(outcome === 'created' || outcome === 'updated')   (deleted Places included, AC-37)
          invalid_data -> item failure 'invalid_data' `Place ${id}: the Place Store rejected the details: ${failure.message}`  (AC-38)
          store_unavailable -> gateway.stop('failed', failure.message); break
return { dueLoaded: due.length }
```

`selectPlacesDue(db, { bbox, dueBefore, limit })`, one parameterized statement:

```sql
SELECT place_id,
       to_char(details_fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS details_fetched_at_text
FROM places
WHERE centre_point && ST_MakeEnvelope(?, ?, ?, ?, 4326)            -- GIST prefilter (west, south, east, north)
  AND location_lon BETWEEN ? AND ? AND location_lat BETWEEN ? AND ? -- exact, edges included (AC-34)
  AND (details_fetched_at IS NULL OR details_fetched_at < ?::timestamptz)
ORDER BY (details_fetched_at IS NOT NULL), details_fetched_at, place_id     -- Details Order (AC-33)
[LIMIT ?]
```

The numeric `location_lon/lat` columns hold the exact doubles the Centre Point was built from, so the inclusive comparison is exact; the envelope test only uses the index. `countPlacesDue` is the same filter with `count(*)`. Rows are parsed with `DuePlaceRowSchema`; `detailsFetchedAt` is attached only when not null. The public `listPlacesDueForDetails` (no limit) gates its value with `PlacesDueValueSchema`.

The details Place Store call is the internal `saveDetails(db, value, hook)` after `validateDetailsInput` (same pool as the repository), so it numbers writes with the Run-wide hook.

#### 1.4.8 Run end, Run Summary, report (`run-crawl.ts`, `report.ts`; AC-45, AC-50 .. AC-54)

- `outcome = gateway.stopped?.reason ?? 'completed'`. Item Failures never change the outcome (AC-51).
- `tilesUnfinished = pass ? pass.tileCount - pass.finishedTiles.size : 0` (0 when there was no Listing Phase).
- `placesStillDue = repo.countPlacesDue({ bbox: region.bbox, dueBefore })` (same cutoff as the Run). If that read fails, use the estimate `max(0, dueLoaded - detailsSaved)` (`dueLoaded` = 0 when the Details Phase did not run). A failed read does not change the outcome by itself; the finish write below decides.
- `counts = tally.snapshot(gateway.counts(), { tilesUnfinished, placesStillDue })`; must satisfy `RunCountsSchema` (sums are consistent by construction).
- `finishRun({ runId, status: outcome, endedAt: toMoment(clock.now()), counts })`; `finishRunStep` locks the row `for update` where `status = 'in_progress'`; if the row is no longer in progress (taken over), it writes nothing (`updated: false`) and the outcome stays as is. A store failure here turns the outcome into `failed` (message from the failure) and one best-effort `finishRun` with `status: 'failed'` follows; its result is ignored (AC-14: an injected failure on the last write still ends Failed).
- `buildReport`: `summary = { regionName?, outcome, startedAt, endedAt, counts }`, `summaryText = formatSummaryText(summary)`, `itemFailures = tally.failures`, `runId` when the Run Record was inserted, `message` = stop message (required for `failed`), `plan` only for `planned`. Gate with `RunReportSchema.safeParse`; on failure return `failedReport('Crawl failed: internal error (report check)', regionName, endedAt)`.
- `failedReport` (before start): zero counts, `startedAt = endedAt = toMoment(clock.now())`, no `runId`.

`formatSummaryText(summary)`: lines joined with `\n`, one `Label: value` per line, in this order (labels from `SUMMARY_LABELS`):

```
Region: <name>                              (omitted when absent, AC-60)
Run outcome: <OUTCOME_LABELS[outcome]>
Started at: <moment>
Ended at: <moment>
Wikimapia requests: n
Listing page requests: n
Place details requests: n
Rate-limit waits: n
Seconds waited for rate limits: n
Listing pages saved: n
Tiles finished in this run: n
Tiles still unfinished: n
Places listed: n
Places newly stored: n
Details saved: n
Details changed: n
Places still due for details: n
Item failures: n
Item failures (<ITEM_FAILURE_LABELS[kind]>): n     one line per kind in ItemFailureKindSchema order
```

Numbers with `String(n)`. No line other than these (the failure message is reported separately, never inside `summaryText`), so every line matches AC-54's `^[A-Z][^:{}[\]"]*: \S.*$`.

**Progress lines** (`deps.onProgress`, also printed by the command): `Run <id> started for region <name> (pass <p>, <k> of <n> tiles finished)`, `Marked run <id> as abandoned`, `Tile <n> page <p>: <k> places saved[, tile finished]`, `Place <id>: details saved (<outcome>)`, `Item failure: <message>`, `Stopping: <outcome label>`. Never a URL, key, connection string or Commenter IP; Place names and descriptions are not printed either (keeps output small).

#### 1.4.9 Write hook and store failures (`run-crawl.ts`, `crawl-repository.ts`; AC-14, AC-47, AC-50)

- The single Run-wide write-hook counter lives in the crawl repository (`src/db/crawl-repository.ts`): `openCrawlRepository` builds one wrapper `runWideHook(options.onWrite)` per repository (and the repository is opened once per Run). It exists only when `onWrite` is given: `let n = 0; hook = async () => { n += 1; await onWrite(n); }`, and it ignores the per-step number the Writer passes. Every step (`beginRunStep`, `renewActivityStep`, `listingPageStep`, `finishRunStep`) and `saveDetails` receive that wrapper, so every write statement of the Run (start-step writes, Last Activity, listing step place writes + Finished Page, Details Saves, finish) is numbered 1, 2, 3, ... across the whole Run.
- `runCrawl` (U6) must NOT add a second counter: it passes `deps.onWrite` unchanged as `onWrite` in the repository options.
- Every write step is its own transaction, so a hook failure rolls back exactly that step and the repository resolves `store_unavailable` (`unavailableFrom`, fixed text + safe code only). The Run then stops (`failed`) and sends no further request (AC-47). Failures raised in a renewal inside the Gateway stop the Run the same way, without throwing into the Client.
- `openCrawlRepository` follows the `place-store.ts` pattern: `StoreConfigSchema` on the connection string, `createDb(connectionString, POOL_MAX_STORE)`, every method wrapped so it never rejects; a not-configured repository resolves `store_unavailable` "Place Store is not configured ...". `close()` = `destroyQuietly`, idempotent. `runCrawl` closes it in `finally` on every path (the contract tests start dozens of Runs; an unclosed pool would exhaust Postgres connections).
- No DB transaction or row lock is ever held across a Wikimapia request or a clock wait (each step is short); this keeps `emptyStore()`'s `TRUNCATE` and parallel Runs from blocking on a gated Run (AC-22, AC-62, AC-69 tests).

#### 1.4.10 Crawl Command and script (`command.ts`, `scripts/crawl.ts`; AC-45, AC-47, AC-49, AC-59 .. AC-61)

```
parseCrawlArgs(argv):
  tokens = argv; drop one leading '--' (pnpm passthrough)
  flags: --dry-run, --relist (no value); valued: --region, --budget, --min-interval, --refresh-age (next token is the value, even if it starts with '-')
  unknown option, missing value, or an option given twice -> { ok: false, problem: `unknown option "--x"` | `missing value for --budget` | ... }
  numbers: /^-?\d+(?:\.\d+)?$/ -> Number(text), otherwise NaN (so '', 'abc', '1e3' are invalid and runCrawl names the setting)
  -> CrawlRequest { regionName?, dryRun?, relist?, requestBudget?, minRequestIntervalSeconds?, refreshAgeDays? } (keys only when given)

runCrawlCommand(argv, io):                                            never rejects (try/catch -> failedReport, exit 1)
  parsed = parseCrawlArgs(argv)
  !ok -> report = failedReport(`${problem}. ${usageMessage(known names of DEFAULT_CRAWL_CONFIGURATION)}`, undefined, now)
  ok  -> report = await runCrawl(parsed.request, { connectionString: io.env.DATABASE_URL ?? '', apiKey: io.env.WIKIMAPIA_API_KEY,
                                                  transport: io.transport, clock: io.clock, signal: io.signal, onProgress: io.write })
         (configuration omitted: DEFAULT_CRAWL_CONFIGURATION; keys passed only when defined, exactOptionalPropertyTypes)
  write: report.message (if any) as one line; for planned: `Region <name>: <n> tiles` and formatPlanLines (one line per Tile:
         `Tile <n>: west <w>, south <s>, east <e>, north <n>`); then each summaryText line
  return { exitCode: exitCodeFor(report.outcome), report }
```

`scripts/crawl.ts`: `applyEnvDefaults(readEnvFile(<repo>/.env))` (shell and scheduler env win); `const controller = new AbortController()`; `process.once('SIGINT', abort)`, `process.once('SIGTERM', abort)` (a second Ctrl+C falls back to Node's default and kills the process; a crash is safe by design); `write = line => process.stdout.write(line + '\n')`; `const result = await runCrawlCommand(process.argv.slice(2), { env: { WIKIMAPIA_API_KEY, DATABASE_URL } from process.env, write, signal })`; remove the signal listeners; `process.exitCode = result.exitCode`. No `console.*`. The default transport and real clock are used (no injection).

`package.json` scripts: `"crawl": "tsx scripts/crawl.ts"`; `"test:db"` extended to `vitest run --no-color contracts/storage.test.ts contracts/hydration.test.ts tests/db tests/crawl`.

#### 1.4.11 Public Crawl Store (`crawl-store.ts`; R1, AC-53, AC-58, AC-69)

Same pattern as `place-store.ts`: factory never throws; each method validates input first (`validatePlacesDueInput`, `validateCrawlProgressInput`: contract schemas via the existing `plain` helper; invalid input never reaches the database), then `store_unavailable` if not configured, then the operation, mapped errors, gated output (`PlacesDueValueSchema`, `CrawlProgressViewSchema`; a gate failure -> `store_unavailable` "stored data failed the read-back check").

`readProgressView(trx, regionName)` in one read-only REPEATABLE READ transaction:
- passes: `select * from crawl_passes where region_name = ? order by pass_number` (moments via `to_char`).
- finished pages of those passes ordered by `pass_number, tile_number, page_no`; `finishedTiles` = tile numbers with `is_short`, ascending; `complete` = `finishedTiles.length === tile_count`.
- runs: `select ... from crawl_runs where region_name = ? order by run_id`; `endedAt` only when not null; `counts` parsed with `RunCountsSchema` (via the view gate).
- FinishedPage: `{ tileNumber, page: page_no, runId, placeCount, short: is_short, totalFound: reported_total (only when not null) }`.
- A Region with nothing stored returns `{ regionName, passes: [], runs: [] }`.

#### 1.4.12 Schema Setup changes (`schema-setup.ts`; AC-55 .. AC-57)

- `undoLast()`: `applied = select name from knex_migrations order by id` (empty when the table does not exist -> `{ steps: [] }` without calling Knex); otherwise `const result: unknown = await db.migrate.down(MIGRATION_CONFIG)`, parse with `MigrateResultSchema`, return `{ steps }` (exactly the newest step). Errors -> `unavailableFrom(error, 'schema setup undo last')`.
- `emptyStore()`: unchanged guard (`current_database()` must end in `_test`). Then one transaction: `TRUNCATE TABLE place_tags, comments, tags, places`; and, when `select to_regclass(?) is not null` is true for `crawl_runs`, `TRUNCATE TABLE crawl_finished_pages, crawl_passes, crawl_runs RESTART IDENTITY`. Both SQL texts are constants; only the table name for `to_regclass` is a binding. Missing store tables still give `store_unavailable` (existing behaviour after `undoAll`); missing crawl tables (after `undoLast`) are simply skipped.
- `notConfiguredSetup()` gains `undoLast` resolving the not-configured failure.

### 1.5 Transaction boundaries

| Operation | Boundary | Isolation / locking | On failure |
|---|---|---|---|
| Run start (`beginRunStep`) | one transaction: abandon updates, Run Record insert, new pass insert | READ COMMITTED; `pg_advisory_xact_lock(CRAWL_REGION_LOCK_CLASS, hashtext(region))`; live rows `FOR UPDATE` | full rollback; Run ends Failed without a Run Record |
| Refused start (live Run, definition changed) | same transaction, no writes | same | nothing changed (AC-25, AC-62) |
| Listing step (`listingPageStep`) | one transaction: Listing Save writes + Finished Page insert | READ COMMITTED; own `crawl_runs` row `FOR UPDATE`, then per-place advisory locks (ascending) | full rollback: page neither saved nor finished (AC-14, AC-47) |
| Details Save | one transaction per Place (existing `saveDetails`) | as in the storage design | full rollback; Place stays due |
| Last Activity renewal | one transaction: row `FOR UPDATE` where in progress, one `UPDATE` (last_activity, counts) | READ COMMITTED | rollback; Run stops Failed |
| Run finish | one transaction: row `FOR UPDATE` where in progress, one `UPDATE` (status, ended_at, last_activity, counts) | READ COMMITTED | outcome becomes Failed; one best-effort retry with status `failed` |
| Reads (`readCrawlProgress`) | one read-only transaction | REPEATABLE READ | `store_unavailable` |
| Places due list/count | single statement | | `store_unavailable` |
| Schema step | one transaction (Knex default) | Knex migration lock | `store_unavailable` |

Lock order is always: Region advisory lock -> `crawl_runs` rows (start step); `crawl_runs` row -> place advisory locks (listing step). No step takes them in the opposite order, so no deadlock. The Region lock uses the two-key advisory form, distinct from the storage feature's single-`bigint` place keys.

## 2. Data Model Design (Declarative)

### 2.1 General rules

- Crawl Progress holds Region Names, Tile Plan inputs, page numbers, moments and counts only: no Place names, descriptions, comments, URLs, outlines or Commenter IPs; no geometry, `inet` or `cidr` columns (AC-58).
- Column names must not match: storage AC-5 (`embedding|vector`), storage AC-6 (`user_?ip|commenter_?ip`), storage AC-14 (exact `page`, `page_size`, `page_number`, `count`, `found`, `total_found`, `total`), hydration AC-58 (`description|message|comment|title|author|user_?ip|outline|polygon`). The names below satisfy all of them (hence `page_no`, `reported_total`, `counts`).
- Moments are `timestamptz(0)`, written as the contract's whole-second ISO text and read back with `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` (same as `details_fetched_at`).
- Region Names carry `CHECK (region_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$')` (same rule as `RegionNameSchema`).
- No Objection models: these tables are written by a handful of fixed statements through the Knex builder and read through Zod row schemas in `rows.ts`; no relation graph is needed. All values are bindings.

### 2.2 `crawl_runs` (Run Records)

| Column | Type | Null | Rule |
|---|---|---|---|
| `run_id` | `bigserial` (`bigIncrements`) | PK | Run id; taken with `nextval` before the insert (1.4.5) |
| `region_name` | `text` | not null | Region Name check |
| `status` | `text` | not null | `CHECK (status IN ('in_progress','completed','budget_reached','rate_limited','interrupted','failed','abandoned'))` (= `RunRecordStatusSchema`) |
| `started_at` | `timestamptz(0)` | not null | Run start moment |
| `ended_at` | `timestamptz(0)` | null | `CHECK ((status IN ('in_progress','abandoned')) = (ended_at IS NULL))`, `CHECK (ended_at IS NULL OR ended_at >= started_at)` |
| `last_activity` | `timestamptz(0)` | not null | Last Activity; `CHECK (last_activity >= started_at)` |
| `counts` | `jsonb` | not null | Run Summary numbers (`RunCounts`), written as `JSON.stringify(counts)` with `?::jsonb` after `RunCountsSchema.parse`; updated at every renewal and at finish ("numbers as last recorded", AC-69) |

Indexes: `btree (region_name, run_id)`; `UNIQUE (region_name) WHERE status = 'in_progress'` (`crawl_runs_one_live_per_region`).

### 2.3 `crawl_passes` (Listing Passes)

| Column | Type | Null | Rule |
|---|---|---|---|
| `region_name` | `text` | not null | Region Name check |
| `pass_number` | `integer` | not null | `CHECK (pass_number >= 1)`; per Region, `max + 1` |
| `bbox_west`, `bbox_south`, `bbox_east`, `bbox_north` | `double precision` | not null | Region bbox at pass start; `CHECK (bbox_west < bbox_east AND bbox_south < bbox_north)` |
| `tile_width`, `tile_height` | `double precision` | not null | `CHECK (> 0)` |
| `tile_count` | `integer` | not null | `CHECK (tile_count >= 1)` |
| `started_by_run_id` | `bigint` | not null | FK -> `crawl_runs(run_id)` `ON DELETE RESTRICT` |
| `started_at` | `timestamptz(0)` | not null | |

PK `(region_name, pass_number)`. The newest pass of a Region is its current pass (1.4.5). "Complete" is derived (finished tiles = `tile_count`), never stored.

### 2.4 `crawl_finished_pages` (Finished Pages)

| Column | Type | Null | Rule |
|---|---|---|---|
| `region_name`, `pass_number` | `text`, `integer` | not null | FK `(region_name, pass_number)` -> `crawl_passes` `ON DELETE CASCADE` |
| `tile_number` | `integer` | not null | `CHECK (tile_number >= 1)` |
| `page_no` | `integer` | not null | page number the Crawl asked for; `CHECK (page_no >= 1)` |
| `run_id` | `bigint` | not null | FK -> `crawl_runs(run_id)` `ON DELETE RESTRICT`; the Run that finished it |
| `place_count` | `integer` | not null | Place Summaries on the page; `CHECK (>= 0)` |
| `is_short` | `boolean` | not null | Short Page (the Tile is finished) |
| `reported_total` | `bigint` | null | Total Found as reported, information only (AC-58); `CHECK (>= 0)` |
| `finished_at` | `timestamptz(0)` | not null | moment of the listing step |

PK `(region_name, pass_number, tile_number, page_no)`. `UNIQUE (region_name, pass_number, tile_number) WHERE is_short` (one Short Page per Tile). The PK index serves the PassState aggregate.

### 2.5 Migration (Schema Setup step 5)

| Step name | Up | Down |
|---|---|---|
| `20261022_01_create_crawl_progress` | create `crawl_runs`, `crawl_passes`, `crawl_finished_pages` with checks and indexes (2.2 .. 2.4) | drop `crawl_finished_pages`, `crawl_passes`, `crawl_runs` (in that order) |

Knex schema builder plus `knex.raw` for named checks and the partial unique indexes (constant DDL text). The step touches no storage table, so applying or undoing it leaves every Place, Comment, Tag and Place-Tag Link unchanged (AC-55, AC-56). It is appended to `MIGRATIONS` as the 5th, newest step. No vector column is added (storage AC-5 as narrowed).

## 3. Batch & External Calls

The Crawl is an offline batch job calling the Wikimapia API only (no OpenAI). All waits run on the injected clock (Simulated Clock in tests; nothing waits on real time in tests, AC-63).

| External call | Unit of work | Pacing / rate limit | Timeout | Retry / back-off | Stop conditions |
|---|---|---|---|---|---|
| `box` (Listing Page) | one page of one Tile, `pageSize` = Listing Page Size (default 100) | Minimum Request Interval between request starts (default 6 s = 50 per 5 min, half the stated 100/5 min quota), applied to every request incl. Client retries | 30 s per HTTP request (`createFetchTransport` default) | Rate-Limit Response: Client waits the stated seconds (fallback 60 s) and retries up to 5 times (unchanged Client); waits chunked to 840 s with Last Activity renewal. Connection Failure (incl. non-2xx): 2 extra tries after 30 s then 60 s. Wikimapia Error / Unexpected Response / Invalid Request: no retry, Item Failure | Request Budget (default 500, hard, retries included); Rate Limit Exhausted; interrupt; store unavailable; taken over |
| `place.getbyid` (Place Details) | one Place | same | same | same | same |

**Batch shape per Run:** Listing Phase over unfinished Tiles in Tile Number order (one `box` per page until a Short Page), then Details Phase over the Places Due for Details in Details Order (limited to remaining budget + 1 rows). Database unit of work: one transaction per Listing Page (+ its Finished Page row), one per Details Save.

**Idempotency and resumability:**
- A Finished Page is recorded in the same transaction as its Listing Save, so after any crash it is either saved and finished or neither; a new Run continues at the first unfinished page of each unfinished Tile and never asks a Finished Page again in the same pass (AC-14, AC-20 .. AC-22).
- Listing and Details Saves are idempotent upserts (storage design): repeating the same work duplicates nothing and reports `unchanged` (AC-16, AC-27).
- The Details Phase is resumable by construction: "due" is computed from stored state (Summary-Only or older than the Refresh Age), so a Place that failed or was not reached stays due for the next Run (AC-36, AC-44).
- A finished pass with fresh details sends nothing (AC-23); a new pass only starts with `--relist` (AC-24).
- A killed Run's Run Record is taken over after 1 hour of silence (AC-69); a live Run renews its Last Activity at least every 15 minutes, also during long waits (AC-70).
- No embeddings are computed (substep 4).

**Operator sizing (from AL6 rule 13, not tested):** `belgrade-small` about 300 requests, one Run at default budget (at least ~30 min). `belgrade` at least 7,920 listing requests, at least 16 Runs at the default budget before details. The Run Summaries measure the real quota.

## 4. Implementation Units

Units are ordered by dependency; each fits one AL3 -> AL2 iteration. `contracts/hydration.test.ts` imports all four entry points, so it can only run once U7 exists; the ACs listed for U1 .. U6 are the ones each unit implements, and U7 verifies them end to end. `contracts/hydration.schema.test.ts`, `contracts/storage.schema.test.ts`, `contracts/wikimapia-client*.test.ts` and all existing `tests/` must stay green in every unit.

**Baseline caveat:** until U7, `pnpm exec tsc --noEmit` and `pnpm lint` report only the unresolved-import errors of `contracts/hydration.test.ts` for the entry modules that do not exist yet (`src/crawl/command`, `src/crawl/run-crawl`, `src/crawl/tile-plan`, `src/db/crawl-store`; 4 lint errors at the start). "No new errors" below means only those. **DB precondition** for every unit: `pnpm db:up` has been run and `.env.test` exists.

### U1. Crawl Progress schema step, `undoLast`, `emptyStore` extension

- **Scope:** the new migration step, its registration, Schema Setup `undoLast()` and the extended `emptyStore()`; fixes the current tsc error in `src/db/schema-setup.ts`.
- **Files:** `src/db/crawl-tables.ts`, `src/db/migrations/20261022_01_create_crawl_progress.ts`, `src/db/migrations/index.ts`, `src/db/schema-setup.ts`, `tests/db/schema-setup.db.test.ts` (STEP_NAMES gains the 5th step; `allFailures` covers `undoLast`; new cases below), `tests/db/crawl-schema.db.test.ts`
- **Design refs:** 1.4.12, 2.1 .. 2.5
- **Implements ACs:** AC-55, AC-56, AC-57 (schema side), AC-58 (column rules); keeps storage AC-1 .. AC-6, AC-14, AC-61 green
- **Unit tests must cover:** `apply` from nothing returns 5 steps in order; `undoLast` returns exactly `['20261022_01_create_crawl_progress']`, removes the three crawl tables and leaves the four store tables and a stored Place unchanged; a second `undoLast` undoes `20261021_04_create_comments` (then re-apply); `undoLast` with nothing applied returns `[]`; `emptyStore` clears rows of all seven tables (seed one synthetic row per crawl table with Knex through the test's own `testDb()` handle, as the existing schema test does for `tags`), succeeds after `undoLast` (crawl tables absent), still fails after `undoAll`; crawl columns: no name matches the regexes of 2.1, no `geometry`/`geography`/`inet`/`cidr`/`vector` type; CHECKs reject a bad status, `ended_at` with `in_progress`, a second `in_progress` row for one Region, a second Short Page for one Tile; the not-configured Schema Setup resolves `store_unavailable` for `undoLast`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts tests/db/crawl-schema.db.test.ts contracts/storage.test.ts contracts/storage.schema.test.ts` passes
  - `pnpm db:migrate` on the Development Database applies one new step; `pnpm db:status` lists 5 applied
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `schema-setup.ts` error is gone)

### U2. Pure crawl core: Tile Plan, configuration, tally and summary

- **Scope:** everything of `src/crawl/` that needs neither database nor network.
- **Files:** `src/crawl/types.ts` (parts these modules need), `src/crawl/tile-plan.ts`, `src/crawl/config.ts`, `src/crawl/report.ts`, `tests/crawl/tile-plan.test.ts`, `tests/crawl/config.test.ts`, `tests/crawl/report.test.ts`
- **Design refs:** 1.3, 1.4.1, 1.4.2, 1.4.8 (summary text, report builders)
- **Implements ACs:** AC-1 .. AC-6, AC-60 (message), AC-66, AC-67; AC-10, AC-50, AC-54 (formatting side)
- **Unit tests must cover:** `belgrade-small` = the 4 Tiles of AC-2; `belgrade` = 120 x 66, Tiles 1, 120, 121, 7920 as in AC-66, every Tile 0.005 wide/high within tolerance, `findTilePlanIssues` empty; a Region smaller than a Tile = 1 Tile equal to the Region; `REGION_T2`/`REGION_T4` give `T2_TILES`/`T4_TILES` of the support file; repeated calls `toStrictEqual`; `resolveRun` failures name `bbox`, `tileSize`, `listingPageSize` (0 and 101), `refreshAgeDays` (-1 and override -0.5), `minRequestIntervalSeconds` (NaN), `requestBudget` (-3 and override NaN); unknown Region message contains the asked name and exactly `belgrade`, `belgrade-small`; missing/blank region -> usage containing `--region`; `isMissingApiKey` for undefined, '', '   ', ' \t '; tally keeps distinct Places listed (same id twice counts once) and `RunCountsSchema` holds for snapshots; `formatSummaryText` of the AC-51 numbers produces exactly the lines of 1.4.8 and each matches the AC-54 regex; `buildReport` passes `RunReportSchema` for completed, failed (with message) and planned (with plan); `failedReport` has zero counts and no `runId`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/crawl/tile-plan.test.ts tests/crawl/config.test.ts tests/crawl/report.test.ts contracts/hydration.schema.test.ts` passes
  - `pnpm exec eslint src/crawl tests/crawl` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `src/crawl/tile-plan` import error is gone)

### U3. Crawl Store read side (public `createCrawlStore`)

- **Scope:** R1 query, Crawl Progress read-back, public Crawl Store factory.
- **Files:** `src/db/rows.ts` (crawl row schemas), `src/db/types.ts` (row types, `DueQuery`), `src/db/validate.ts` (two validators), `src/db/places-due.ts`, `src/db/crawl-progress.ts` (`readProgressView` and the PassState query only), `src/db/crawl-store.ts`, `tests/db/places-due.db.test.ts`, `tests/db/crawl-store.db.test.ts`, `tests/db/validate.test.ts` (new cases)
- **Depends on:** U1
- **Design refs:** 1.4.7 (query), 1.4.11, 2.2 .. 2.4
- **Implements ACs:** R1, AC-30 .. AC-34 (query side), AC-53, AC-58 (read side)
- **Unit tests must cover:** the R1 data set of the contract (Summary-Only 300 on the edge and 900, outside 950, Detailed 700 / 1381893 / 62587 / 800) gives exactly the contract order for `dueBefore` `2026-09-22T09:00:00Z`; 800 appears at `...09:00:01Z`; `REGION_FAR` bbox gives `[]`; `limit` truncates in Details Order; `countPlacesDue` agrees with the list length; invalid input (`dueBefore: 'yesterday'`, bad bbox, bad Region Name) -> `invalid_data` without DB access; unreachable URL -> `store_unavailable` without password or `postgres://`; `readCrawlProgress` of an empty Region = `{ regionName, passes: [], runs: [] }`; with synthetic Crawl Progress rows seeded through a `testDb()` Knex handle in the test (as `tests/db/schema-setup.db.test.ts` does): finished pages and tiles ordered, `complete` derived, `totalFound` only when not null, `endedAt` absent for `in_progress`, counts round-trip, and a row with malformed `counts` jsonb resolves `store_unavailable` (read-back gate).
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db/places-due.db.test.ts tests/db/crawl-store.db.test.ts tests/db/validate.test.ts` passes
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `src/db/crawl-store` import error is gone)

### U4. Crawl repository: write steps of a Run

- **Scope:** Run start (lock, live check, abandonment, pass), Last Activity renewal, the atomic listing step, finish, details save with the Run-wide hook; the `writeListingPage` extraction.
- **Files:** `src/db/save-listing.ts` (extract `writeListingPage`, no behaviour change), `src/db/crawl-progress.ts` (`beginRunStep`, `renewActivityStep`, `listingPageStep`, `finishRunStep`), `src/db/crawl-repository.ts`, `src/db/types.ts` (repository types), `tests/db/crawl-repository.db.test.ts`
- **Depends on:** U3
- **Design refs:** 1.4.5, 1.4.6 (step), 1.4.8 (finish), 1.4.9, 1.5
- **Implements ACs:** AC-14, AC-20 .. AC-25, AC-47 (store side), AC-53, AC-62, AC-69 (store side)
- **Unit tests must cover:** first `beginRun` creates Run 1 and pass 1; a second `beginRun` with `abandonBefore` <= the first's `last_activity` returns `run_in_progress` and changes nothing; with `abandonBefore` one second later marks the first `abandoned` (counts kept) and starts; an incomplete pass with a different tile size returns `region_changed` and writes nothing, the same with `relist` starts pass 2; a complete pass without relist returns `pass: undefined`; `recordListingPage` of the recorded Belgrade page stores 3 Summary-Only Places and one Finished Page; an empty page stores only the Finished Page; a hook throwing at each write number in turn leaves "places stored" and "page finished" consistent (both or neither) and resolves `store_unavailable` without the hook's message; after the Run is marked abandoned, `recordListingPage`, `renewActivity` and `finishRun` report `taken_over` / `alive: false` / `updated: false` and write nothing; `finishRun` sets status, `ended_at`, counts; write numbers passed to the hook are 1, 2, 3 ... across steps when one hook closure counts them; `tests/db/listing.db.test.ts` and `contracts/storage.test.ts` stay green (Listing Save unchanged).
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db/crawl-repository.db.test.ts tests/db/listing.db.test.ts contracts/storage.test.ts` passes
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U5. Gateway, request classification, runtime defaults

- **Scope:** wrapped transport and clock (budget, pacing, interrupt, counting, chunked waits, renewal), Connection Failure back-off, real clock and transport defaults.
- **Files:** `src/crawl/types.ts` (gateway and request types), `src/crawl/gateway.ts`, `src/crawl/requests.ts`, `src/crawl/runtime.ts`, `tests/crawl/gateway.test.ts`, `tests/crawl/requests.test.ts`, `tests/crawl/runtime.test.ts`
- **Depends on:** U2
- **Design refs:** 1.4.3, 1.4.4, section 3
- **Implements ACs:** AC-17, AC-18, AC-39 .. AC-44, AC-46 (request side), AC-48, AC-51, AC-52, AC-70, AC-71 (counting and pacing side)
- **Unit tests must cover** (real `createWikimapiaClient` over the Gateway, `SimulatedCrawlClock` and `CrawlWikimapia` from `contracts/hydration.support.ts`, a fake heartbeat that records calls): interval 2 s and 5 instant answers -> starts 2 s apart, first at the clock start; a 3 s answer adds no delay; budget 3 -> 3 transport calls then `budget_reached`; a 1 s Rate-Limit Response is a request and a wait (`rateLimitWaits` 1, 1 s); fallback wait counts 60 s; a 3-hour Rate-Limit Wait is slept in chunks of at most 840 s with a heartbeat before every chunk after the first minute (no sleep ends more than 900 s after the last heartbeat); a failing heartbeat stops `failed` and the next request is not sent; abort before a request -> `interrupted`, no call; `requestWithBackoff` on an always-unreachable answer makes 3 calls 30 s and 60 s apart and returns `item_failure` `connection` whose message has no `key=` and no API key; Wikimapia Error / Unexpected Response -> one call, matching kind; Rate Limit Exhausted -> `stopped` with `rate_limited`; `createSystemCrawlClock(signal).sleep(10_000)` resolves promptly after abort (fake timers or a short real delay).
- **Done when:**
  - `pnpm exec vitest run --no-color tests/crawl/gateway.test.ts tests/crawl/requests.test.ts tests/crawl/runtime.test.ts tests/wikimapia` passes
  - `pnpm exec eslint src/crawl tests/crawl` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U6. The Run: `runCrawl` with Listing and Details Phases

- **Scope:** orchestration of 1.2: resolution, Dry Run, key check, start, phases, end, report, passing `deps.onWrite` to `openCrawlRepository` (the Run-wide counter is the repository's, U4; no second counter here), resource cleanup.
- **Files:** `src/crawl/listing-phase.ts`, `src/crawl/details-phase.ts`, `src/crawl/run-crawl.ts`, `src/crawl/types.ts` (`RunContext`, `PassCursor`), `tests/crawl/run-crawl.db.test.ts`
- **Depends on:** U2, U4, U5
- **Design refs:** 1.2, 1.4.5 .. 1.4.9
- **Implements ACs:** AC-5 .. AC-38, AC-41 .. AC-44, AC-46 .. AC-53, AC-62, AC-69, AC-70 (end to end through `runCrawl`)
- **Unit tests must cover** (Test Database, Simulated Wikimapia and Clock, `REGION_T1`/`T2`/`T4` of the support file; a small subset, the contract file is the full net): the AC-51 scenario gives exactly its counts and `Completed`; a Dry Run opens no database (unreachable connection string still ends Planned); budget 0 keeps a `budget_reached` Run Record with 0 requests; a Run whose `onWrite` throws on write 1 ends Failed without `runId` and stores nothing; a gated first Run blocks a second Run for the same Region but not for another; an abandoned Run is taken over; every Run closes its pool (run 30 Runs in a loop and check `pg_stat_activity` count for the test database stays bounded, via a `src/db` read helper or by the test's own `testDb()` query); progress lines and the JSON report contain no API key, `key=`, password or `postgres://`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/crawl tests/db` passes
  - `pnpm exec eslint src/crawl tests/crawl` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `src/crawl/run-crawl` import error is gone)

### U7. Crawl Command, script and contract green

- **Scope:** argument parsing, output, exit codes, the `tsx` script and package scripts; full contract verification.
- **Files:** `src/crawl/command.ts`, `scripts/crawl.ts`, `package.json` (`crawl`, extended `test:db`), `tests/crawl/command.test.ts`
- **Depends on:** U6
- **Design refs:** 1.4.10, 0.1
- **Implements ACs:** AC-45, AC-47 (command), AC-49 (command), AC-59, AC-60, AC-61; all ACs end to end
- **Unit tests must cover** (`parseCrawlArgs` pure; `runCrawlCommand` with Simulated Wikimapia/Clock): every option form, a leading `--` ignored, `--refresh-age -1` read as a value, `--budget abc` / `--budget ''` -> NaN -> Failed naming `requestBudget`, unknown option and missing value -> Failed usage listing `belgrade`, `belgrade-small` and `--region`, exit 1, nothing sent; `--dry-run` prints one line per Tile; outputs of Completed/Budget Reached/Rate Limited/Planned exit 0, Failed/Interrupted exit 1 (`exitCodeFor`); env without `DATABASE_URL` and without `--dry-run` ends Failed without secrets.
- **Done when:**
  - `pnpm exec vitest run --no-color contracts/hydration.test.ts contracts/hydration.schema.test.ts contracts/storage.test.ts` passes
  - `pnpm exec vitest run --no-color` (whole suite: `contracts/` and `tests/`) passes
  - `pnpm crawl --region belgrade-small --dry-run` prints 4 Tiles and `Run outcome: Planned`, exits 0, and needs neither an API key nor a database
  - `pnpm crawl` (no region) prints the usage line and exits 1; `pnpm db:status` on the Development Database is unchanged by the test run (AC-64)
  - `pnpm exec tsc --noEmit` reports **0 errors**
  - `pnpm lint` reports **0 problems**

## 5. AL2 Guidance (pitfalls)

- **Never change the Client** (`src/wikimapia/`). Counting, pacing and budget live only in `gateway.ts`. Do not parse request URLs to classify requests; use `gateway.setKind`.
- **Never copy error messages** from Knex, pg, the hook or a transport rejection into a failure, message or progress line (the Simulated Wikimapia's rejection text contains the request URL with the API key; AC-47's hook throws a connection URL). Use `unavailableFrom` and the Client's own redacted failure messages.
- **Close every pool**: `runCrawl` opens exactly one repository per non-dry Run and closes it in `finally`; `createCrawlStore().close()` is idempotent.
- **No transaction across waits or requests.** Each database step opens and commits its own short transaction.
- **Moments:** always `toMoment(clock.now())` (whole seconds, `Z`); never `new Date()` directly in `src/crawl` except inside `runtime.ts`.
- **`exactOptionalPropertyTypes`:** build `CrawlDependencies`, `CrawlRequest`, `RunSummary.regionName`, `FinishedPage.totalFound`, `RunRecord.endedAt`, `DuePlace.detailsFetchedAt` with conditional spreads; never assign `undefined`.
- **Imports:** `import knex from 'knex'` + `import type { Knex } from 'knex'`, `import pg from 'pg'` as in the storage design; relative imports extensionless; check `pnpm crawl --dry-run` and `pnpm db:status` under `tsx` (Vitest interop hides ESM import problems).
- **`unknown`:** only for caught errors, raw Knex/pg results parsed on the next line (`nextval`, `to_regclass`, aggregates, `migrate.down`), and the two new validators' parameters.
- **Output:** `process.stdout.write` only (ESLint `no-console`); the command prints the summary and plan through `io.write`.
- Do not edit `contracts/` or its fixtures. If a contract looks wrong, stop and report it (`.agrules` section 0).
