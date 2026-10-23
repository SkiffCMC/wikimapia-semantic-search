# AL4 Design: Crawl Run 1 Fixes

- **Feature:** `crawl-run1-fixes` (Stage 1, a change to substeps 1 and 3)
- **AL6 source:** `docs/al6-requirements/20261022-crawl-run1-fixes-al6.md` (AC-1 .. AC-46, rules 1 .. 10, stakeholder decisions Q1 .. Q11)
- **AL5 sources:** `contracts/crawl-run1-fixes.schema.ts` (Failure Record, Explicit Retry, `FailureRecordStore`, `CreateFailureAwareCrawlStoreFn`, `PARKING_THRESHOLD`, `PARKING_COUNTED_KINDS`, `countResetOf`, `countedFailures`, `parkingKindOf`, `isParkedPlace`, `CRAWL_ITEM_FAILURES_TABLE`, `CRAWL_ITEM_FAILURES_COLUMNS`, `FAILED_AT_UDT_NAME`), `contracts/crawl-run1-fixes.test.ts` (behaviour, Test Database), `contracts/crawl-run1-fixes.schema.test.ts` (schema-only, green before AL2). Amended: `contracts/wikimapia-client.schema.ts` (`tags` nullish, `RawDebugResponseSchema.debug.code`, `KEY_QUOTA_CODE`, `KeyQuotaExhaustedFailureSchema`, `classifyDebugResponse`), `contracts/wikimapia-client.support.ts` (`keyQuotaAnswer`, `keyQuotaVariant`, `KEY_QUOTA_BODY`), `contracts/hydration.schema.ts` (`quota_exhausted`, the three parking counts, `retryParked` / `--retry-parked`, `parkedPlacesInRegion`, `SUMMARY_LABELS.wikimapiaMessage`), `contracts/hydration.schema.test.ts`, `contracts/hydration.test.ts` (AC-56 undo loop). Fixtures `getbyid-1391132-no-tags.json`, `getbyid-8918979-no-tags.json`, `debug-key-quota.json`, `README.md`.
- **Amends:** `docs/al4-design/20261020-wikimapia-client-al4.md` (`src/wikimapia/`), `docs/al4-design/20261022-hydration-al4.md` (`src/crawl/`, crawl part of `src/db/`). `docs/al4-design/20261021-storage-al4.md` is unchanged (only its Details Save moment `details_fetched_at` is reused as "most recent successful Details Save").
- **Binding rules:** `.agrules` sections 1 (offline, idempotent, resumable; no requests wasted on a used-up Key Quota), 2 (Zod at every boundary), 3 (all SQL in `src/db/`, parameterized, versioned migrations), 4 (no secrets, no Commenter IPs, recorded fixtures, no live calls), 5 (extensionless imports, `unknown` only where allowed, types in `types.ts`).
- **Status:** **Ready for AL3 Routing.** The AL5 inconsistency of attempt 1 (section 0.2) was resolved by the stakeholder with option A: the page column is `page_no`.

## 0. Scope and Fixed Points

The feature fixes the three problems from Run 1 of `belgrade-small`:

- **A (Client):** a missing or `null` `tags` item reads as an empty list of Tags.
- **B (Client and Crawl):** a `debug` answer with code 1004 is the new Client Failure `key_quota_exhausted`, which is never retried or waited for. The Crawl stops at once with Run Outcome `quota_exhausted`, a Clean Stop with exit status 0.
- **C (Crawl and Store):** every Item Failure of a non-Dry Run is kept as a Failure Record. A Place with 3 Counted Failures of one kind is Parked and is no longer due. `--retry-parked` releases the Parked Places of the Region at Run start and records an Explicit Retry.

Fixed by AL5, not to be changed by AL3/AL2:

| Item | Value |
|---|---|
| Entry points (all existing) | `createWikimapiaClient` (`src/wikimapia/client.ts`), `runCrawl` (`src/crawl/run-crawl.ts`), `runCrawlCommand` (`src/crawl/command.ts`), `createCrawlStore` (`src/db/crawl-store.ts`), which is now typed `CreateFailureAwareCrawlStoreFn` (adds `readFailureRecords`, `readExplicitRetries`), and `createSchemaSetup` (`src/db/schema-setup.ts`). Its newest step adds this storage, and `emptyStore()` also clears it. |
| Table / columns | `crawl_item_failures` with at least `CRAWL_ITEM_FAILURES_COLUMNS`. `failed_at` is `timestamptz` (`FAILED_AT_UDT_NAME`). |
| Constants and helpers to reuse (never re-implement) | `KEY_QUOTA_CODE`, `classifyDebugResponse`, `PARKING_THRESHOLD`, `PARKING_COUNTED_KINDS`, `countResetOf`, `parkingKindOf`, `FailureRecordSchema`, `FailureRecordsInputSchema`, `FailureRecordsValueSchema`, `ExplicitRetriesInputSchema`, `ExplicitRetriesValueSchema`, `RunCountsSchema`, `ZERO_RUN_COUNTS`, `SUMMARY_LABELS`, `OUTCOME_LABELS`, `ITEM_FAILURE_LABELS`, `CLEAN_STOP_OUTCOMES`, `exitCodeFor`, `CRAWL_COMMAND_OPTIONS.retryParked`, `toMoment` |
| Unchanged | Pacing defaults (6 s, budget 500), Rate-Limit handling, Connection Failure back-off, Listing Pass logic, Place Store Details/Listing Save semantics |

**Single source of truth** (as in the hydration AL4): `src/**` imports schemas, constants and pure helpers from `contracts/`. Contract `z.infer` types are imported with `import type` and never re-exported. Parking is decided **only** by the contract's `countResetOf` + `parkingKindOf`. SQL loads the inputs, and TypeScript applies the contract function (1.4.6). No SQL `HAVING count(*) >= 3` copy of the rule exists.

**Current red state and where it is resolved:**

| Red item | Resolved by |
|---|---|
| `tsc`: `src/wikimapia/normalize.ts:157` (tags nullish), `src/wikimapia/redact.ts:53` (new kind), `tests/wikimapia/normalize.test.ts:566` | U1 |
| `tsc`: `src/crawl/requests.ts:65` (new kind), `tests/crawl/report.test.ts:38` (new counts); `tests/crawl/report.test.ts` (2 fails) | U5 |
| `tests/db/crawl-store.db.test.ts` ZodError at load (line 205) | U2 (fixture counts) |
| `contracts/crawl-run1-fixes.test.ts` 52 fails | U1 (AC-1 .. AC-14), U2 (AC-41 newest step, AC-42), U3/U4 (store reads), U6 (Crawl), U7 (command) |
| `contracts/crawl-run1-fixes.test.ts` type check of `createCrawl: CreateFailureAwareCrawlStoreFn = createCrawlStore` (if `tsc` reports it) | U3 |

### 0.1 Design decisions (proposed by the contracts agent, settled here)

| # | Decision | Settled as |
|---|---|---|
| 1 | Dry Run with `--retry-parked` | **Confirmed.** Counts stay `ZERO_RUN_COUNTS`. `report.parkedPlacesInRegion` = number of Parked Region Places. Nothing is written. This Dry Run opens the database **read-only** (a Dry Run without the option still opens none). If that read fails, the Run ends Failed with the store's message, because the Operator asked for a number that cannot be given. |
| 2 | Same-second Count Reset | **Confirmed:** a record counts when `failedAt >= countReset` (contract `countedFailures`). |
| 3 | Explicit Retry storage | **Confirmed:** every non-Dry Run with the option keeps one Explicit Retry, also with 0 released. Storage: two tables in the same new Schema Setup step as `crawl_item_failures`. `crawl_explicit_retries` has one row per retrying Run. `crawl_place_releases` has one row per released Place, holding the per-Place Count Reset. Both are written inside the Run start transaction (1.4.5). |
| 4 | `Wikimapia message:` line | **Confirmed:** present exactly when the reported outcome is `quota_exhausted`. The value is Wikimapia's (redacted) message with whitespace runs collapsed to one space and trimmed. If that is empty, the value is `(empty)`, so the line still matches hydration AC-54's `^[A-Z][^:{}[\]"]*: \S.*$`. |
| 5 | Old Run Records without the three counts | **Read path, no data migration.** `rows.ts` reads `crawl_runs.counts` through a preprocess that fills a missing `placesParkedThisRun`, `placesParked` or `placesReleased` with 0 before `RunCountsSchema`. Stored rows are never rewritten. This keeps AC-41 "every Run Record is unchanged" literally true, and avoids a data step in `up`/`down`. The next renewal or finish of an in-progress record writes full counts anyway. |

Further decisions made by this design (for the orchestrator to record in `CLAUDE.md`):

| Decision | Choice |
|---|---|
| Crawl command | `pnpm crawl --region <name> [--dry-run] [--relist] [--retry-parked] [--budget <n>] [--min-interval <seconds>] [--refresh-age <days>]` |
| Key Quota | Code 1004 is Client Failure `key_quota_exhausted`: no retry, no wait. The Crawl stops with Run Outcome `quota_exhausted` (exit 0). No memory between Runs, so each Run spends exactly 1 request to find out. |
| Failure storage | Schema Setup step 6 `20261022_02_create_item_failures`: `crawl_item_failures`, `crawl_explicit_retries`, `crawl_place_releases`, plus `crawl_runs` status check widened by `quota_exhausted`. Append-only history, never deleted by the Crawl. |
| Parking | Place-level, across Runs and Regions. Count Reset = latest of `places.details_fetched_at` and the Place's latest `crawl_place_releases.released_at`. Released only by `--retry-parked`. |
| Places Due for Details | Parked Places are excluded everywhere: the Run's due list, `placesStillDue`, and the public `listPlacesDueForDetails` (amended glossary "Place Due for Details"). |
| Item Failure messages | A Wikimapia Error's Item Failure message now carries Wikimapia's (Client-redacted) message text: `<item>: Wikimapia reported an error: <text>`. This is required by AC-22 and amends hydration AL4 1.4.4 "the crawl never adds `wikimapiaMessage`". |

### 0.2 AL5 inconsistency (resolved)

- **Issue (attempt 1):** `CRAWL_ITEM_FAILURES_COLUMNS` required a column named `page_number` in `crawl_item_failures`. `contracts/storage.test.ts` AC-14 inspects every base table of the schema and fails on any column matching `/^(page|page_?size|page_?number|count|found|total_?found|total)$/i`. So `crawl-run1-fixes` AC-41 and storage AC-14 could not both be green.
- **Decision:** the stakeholder chose option A. The page column of `crawl_item_failures` is **`page_no`**, the name already used by `crawl_finished_pages`. AL5 was updated: `contracts/crawl-run1-fixes.schema.ts` (`CRAWL_ITEM_FAILURES_COLUMNS`) and `contracts/crawl-run1-fixes.schema.test.ts`. `contracts/storage.test.ts` is unchanged, and its AC-14 must stay green in every unit.

## 1. Architecture & Subsystems

### 1.1 Module map (changes only)

**Client (`src/wikimapia/`, part A and B):**

| File | Change |
|---|---|
| `src/wikimapia/types.ts` | `Interpretation<T>` gains `{ kind: 'key_quota'; message: string }`. |
| `src/wikimapia/interpret.ts` | The `debug` branch uses the contract's `classifyDebugResponse` (code 1004 first, then the message rule). It replaces the direct `parseRateLimitMessage` call. |
| `src/wikimapia/execute.ts` | New `case 'key_quota'`: returns `key_quota_exhausted` at once (no sleep, no retry, any attempt number). |
| `src/wikimapia/redact.ts` | New `case 'key_quota_exhausted'`: redacts `message` and `wikimapiaMessage`. |
| `src/wikimapia/normalize.ts` | `tags: (raw.tags ?? []).map(...)`. |

**Database (`src/db/`, part B and C):**

| File | Kind | Change / responsibility |
|---|---|---|
| `src/db/crawl-tables.ts` | constants | `CRAWL_TABLES` gains `itemFailures` (= contract `CRAWL_ITEM_FAILURES_TABLE`), `explicitRetries: 'crawl_explicit_retries'`, `placeReleases: 'crawl_place_releases'`. New `ITEM_FAILURE_PAGE_COLUMN = 'page_no'` (0.2), so a later rename touches one constant plus the migration. |
| `src/db/migrations/20261022_02_create_item_failures.ts` | migration (**new**) | Section 2. |
| `src/db/migrations/index.ts` | migration source | Appends the step as the 6th, newest entry. |
| `src/db/schema-setup.ts` | public factory | `emptyStore()` also truncates the three new tables when they exist (1.4.9). |
| `src/db/rows.ts` | Zod rows | `RunRowSchema.counts` reads through `StoredRunCountsSchema` (decision 5). New `FailureRowSchema`, `ParkingRowSchema`, `RetryRowSchema`. |
| `src/db/validate.ts` | pure | New `validateFailureRecord`, `validateFailureRecordsInput`, `validateExplicitRetriesInput` (contract schemas through `plain`). |
| `src/db/parking.ts` | SQL read + pure (**new**) | Loads Parking inputs for a bbox or one Place. Decides Parked Places with the contract functions. Writes the releases of an Explicit Retry inside a given transaction. |
| `src/db/failure-records.ts` | SQL (**new**) | The Failure Record write step. The public reads of Failure Records and Explicit Retries. |
| `src/db/places-due.ts` | SQL read | `selectPlacesDue` / `countPlacesDue` take an `excludePlaceIds` list (the Parked Places). |
| `src/db/crawl-progress.ts` | SQL steps | `beginRunStep` performs the Explicit Retry (releases + retry row) in its transaction when asked. |
| `src/db/crawl-repository.ts` | internal factory | New `recordItemFailure`, `listParkedPlaces`, `regionTotals`. `listPlacesDue` excludes Parked Places. `countPlacesDue` is replaced by `regionTotals`. |
| `src/db/crawl-store.ts` | public factory | Typed `CreateFailureAwareCrawlStoreFn`. New `readFailureRecords`, `readExplicitRetries`. `listPlacesDueForDetails` excludes Parked Places. |
| `src/db/types.ts` | types | Section 1.3. |

**Crawl (`src/crawl/`, part B and C):**

| File | Change |
|---|---|
| `src/crawl/types.ts` | `Stop.wikimapiaMessage?`, `Gateway.stop(reason, message?, wikimapiaMessage?)`, `ResolvedRun.retryParked`, `Tally.placeParked()`, wider `Tally.snapshot` extras, `SummaryNotes`, `DetailsPhaseResult` (1.3). |
| `src/crawl/gateway.ts` | `stop` keeps the optional `wikimapiaMessage` (first stop wins, as before). |
| `src/crawl/requests.ts` | `key_quota_exhausted` stops the Gateway with `quota_exhausted`. A Wikimapia Error's item message carries the Wikimapia text. |
| `src/crawl/failures.ts` (**new**) | `concludeItemFailure`: writes the Failure Record, then tallies and prints the Item Failure, and reports a newly Parked Place. |
| `src/crawl/listing-phase.ts`, `src/crawl/details-phase.ts` | Item Failures go through `concludeItemFailure`. The Details Phase reports the parked count it started with. |
| `src/crawl/config.ts` | `resolveRun` sets `retryParked`. The usage message lists `[--retry-parked]`. |
| `src/crawl/report.ts` | Parking counts in the tally and summary. `Wikimapia message:` line. `plannedReport` takes `parkedPlacesInRegion`. |
| `src/crawl/run-crawl.ts` | Dry Run with the option. `retryParked` passed to the start step. End-of-run totals from `regionTotals`. |
| `src/crawl/command.ts` | `--retry-parked` flag. One extra output line for a Dry Run with the option. |

### 1.2 Run flow (amends hydration AL4 1.2; unchanged steps elided)

```
runCrawl(request, deps)
  1. resolveRun -> ResolvedRun { ..., retryParked: request.retryParked === true }
  2. dryRun:
       !retryParked -> plannedReport(plan, startedAt)                                  (no DB, unchanged)
       retryParked  -> repo = openCrawlRepository({ connectionString })                 (no hook; read only)
                       try { p = await repo.listParkedPlaces({ bbox: region.bbox })
                             !p.ok -> failedReport(p.failure.message, regionName, startedAt)
                             -> plannedReport(plan, startedAt, p.value.length) }        (AC-40, decision 1)
                       finally repo.close()
  3. API Key check (unchanged)
  4. repo = openCrawlRepository(...)
  5. repo.beginRun({ ..., retryParked: run.retryParked })
       started.placesReleased = n (0 without the option)
       progress: retryParked -> `Explicit retry: released ${n} parked places of region ${name}`
  6..8. gateway, client, Listing Phase, Details Phase (Item Failures -> concludeItemFailure, 1.4.4)
  9. outcome = gateway.stopped?.reason ?? 'completed'
     t = await repo.regionTotals({ bbox: region.bbox, dueBefore })                       (one read transaction)
       ok  -> placesStillDue = t.placesDue; placesParked = max(t.placesParked, tally.parkedThisRun)
       !ok -> placesStillDue = max(0, dueLoaded - detailsSaved)                          (fallback, as before)
              placesParked   = parkedAtDetailsStart + tally.parkedThisRun
     counts = tally.snapshot(gateway.counts(), { tilesUnfinished, placesStillDue, placesParked, placesReleased })
     finishRun (unchanged)
 10. buildReport({ ..., wikimapiaMessage: outcome === 'quota_exhausted' ? stopped.wikimapiaMessage : undefined })
```

Heartbeat snapshots (Last Activity renewal) use interim values `placesStillDue: 0`, `placesParked: parkedAtDetailsStart + tally.parkedThisRun` (0 before the Details Phase), and `placesReleased`. These always satisfy the `placesParkedThisRun <= placesParked` refine.

### 1.3 Component contracts (signatures)

```ts
// ---------------------------------------------------------------- src/wikimapia/types.ts
export type Interpretation<T> =
  | { kind: 'data'; value: T }
  | { kind: 'rate_limit'; waitSeconds: number | undefined }
  | { kind: 'key_quota'; message: string }                       // NEW: code 1004, message as sent
  | { kind: 'wikimapia_error'; message: string }
  | { kind: 'unexpected'; issues: FailureIssue[] };

// ---------------------------------------------------------------- src/db/types.ts (additions / changes)
import type { FailureRecord } from '../../contracts/crawl-run1-fixes.schema';
import type { ItemFailureKind } from '../../contracts/hydration.schema';
export type FailureRow = z.infer<typeof FailureRowSchema>;
export type ParkingRow = z.infer<typeof ParkingRowSchema>;
export type RetryRow = z.infer<typeof RetryRowSchema>;
export type ParkingScope = { bbox: BoundingBox } | { placeId: number };
export interface ParkedPlace { placeId: number; failureKind: ItemFailureKind }       // the kind that parks it
export type FailureStepValue =
  | { kind: 'recorded'; parked?: ParkedPlace }                   // `parked` only for a Place that is Parked after this record
  | { kind: 'taken_over' };
export interface BeginRunInput { /* existing fields */ retryParked: boolean }
export type BeginRunValue =
  | { kind: 'started'; runId: number; pass?: PassState; abandonedRunIds: number[]; placesReleased: number }
  | { kind: 'run_in_progress'; runId: number; lastActivity: Moment }
  | { kind: 'region_changed'; passNumber: number };
export interface DueQuery extends PlacesDueInput { limit?: number; excludePlaceIds?: readonly number[] }
export interface RegionTotals { placesDue: number; placesParked: number }
export interface ReleaseInput { runId: number; regionName: string; bbox: BoundingBox; at: Moment }
export interface CrawlRepository {
  beginRun(input: BeginRunInput): Promise<StoreResult<BeginRunValue>>;
  renewActivity(input: RenewInput): Promise<StoreResult<{ alive: boolean }>>;
  recordListingPage(input: ListingStepInput): Promise<StoreResult<ListingStepValue>>;
  recordItemFailure(record: FailureRecord): Promise<StoreResult<FailureStepValue>>;   // NEW
  saveDetails(input: SavePlaceDetailsInput): Promise<StoreResult<SaveReport>>;
  listPlacesDue(query: DueQuery): Promise<StoreResult<DuePlace[]>>;                  // now excludes Parked Places itself
  listParkedPlaces(input: { bbox: BoundingBox }): Promise<StoreResult<ParkedPlace[]>>; // NEW (Dry Run, Details Phase start)
  regionTotals(input: PlacesDueInput): Promise<StoreResult<RegionTotals>>;           // NEW, replaces countPlacesDue
  finishRun(input: FinishInput): Promise<StoreResult<{ updated: boolean }>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- src/db/*.ts (new / changed functions)
export function selectParkingRows(db: Knex | Knex.Transaction, scope: ParkingScope): Promise<ParkingRow[]>;   // parking.ts
export function parkedPlacesFrom(rows: readonly ParkingRow[]): ParkedPlace[];        // pure, ascending placeId
export function selectParkedPlaces(db: Knex | Knex.Transaction, scope: ParkingScope): Promise<ParkedPlace[]>;
export function releaseParkedPlaces(trx: Knex.Transaction, writer: Writer, input: ReleaseInput): Promise<number>;
export function failureStep(db: Knex, record: FailureRecord, onWrite: WriteHook | undefined): Promise<FailureStepValue>;  // failure-records.ts
export function selectFailureRecords(db: Knex | Knex.Transaction, input: FailureRecordsInput): Promise<FailureRecord[]>;
export function selectExplicitRetries(db: Knex | Knex.Transaction, input: ExplicitRetriesInput): Promise<ExplicitRetry[]>;
export function selectPlacesDue(db: Knex | Knex.Transaction, query: DueQuery): Promise<DuePlace[]>;           // places-due.ts
export function countPlacesDue(db: Knex | Knex.Transaction, query: DueQuery): Promise<number>;              // `limit` ignored
export function validateFailureRecord(input: unknown): Validated<FailureRecord>;                             // validate.ts
export function validateFailureRecordsInput(input: unknown): Validated<FailureRecordsInput>;
export function validateExplicitRetriesInput(input: unknown): Validated<ExplicitRetriesInput>;
export const createCrawlStore: CreateFailureAwareCrawlStoreFn;                                               // crawl-store.ts

// ---------------------------------------------------------------- src/crawl/types.ts (changes)
export interface Stop { reason: StopReason; message?: string; wikimapiaMessage?: string }   // StopReason now includes 'quota_exhausted'
export interface Gateway { /* ... */ stop(reason: StopReason, message?: string, wikimapiaMessage?: string): void }
export interface ResolvedRun { /* ... */ retryParked: boolean }
export interface Tally {
  /* existing */
  placeParked(): void;                                          // NEW
  readonly parkedThisRun: number;                               // NEW
  snapshot(gateway: GatewayCounts, extra: { tilesUnfinished: number; placesStillDue: number;
           placesParked: number; placesReleased: number }): RunCounts;
}
export interface SummaryNotes { wikimapiaMessage?: string }    // present only for quota_exhausted
export interface DetailsPhaseResult { dueLoaded: number; parkedAtStart: number }

// ---------------------------------------------------------------- src/crawl/*.ts (new / changed)
export function concludeItemFailure(ctx: RunContext, item: FailedItem, failureKind: ItemFailureKind,
  message: string): Promise<boolean>;                           // failures.ts; false = Run stopped
export function oneLine(text: string): string;                  // report.ts: whitespace runs -> ' ', trimmed
export function formatSummaryText(summary: RunSummary, notes?: SummaryNotes): string;
export function buildReport(input: { /* existing */ wikimapiaMessage?: string; parkedPlacesInRegion?: number }): RunReport;
export function plannedReport(plan: TilePlan, at: string, parkedPlacesInRegion?: number): RunReport;
export function runDetailsPhase(ctx: RunContext): Promise<DetailsPhaseResult>;
```

### 1.4 Detailed behaviour per subsystem

#### 1.4.1 Missing or null Tags (`normalize.ts`; AC-1 .. AC-7)

The contract wire schema already admits `tags` missing, `null` or a valid list, and still rejects text, numbers and malformed Tags with an issue path starting with `tags` (AC-4, through the existing `unexpected_response` path). `normalizePlaceDetails` maps `raw.tags ?? []`. So missing, `null` and `[]` produce identical `PlaceDetails` (AC-3). Nothing else becomes optional (AC-5). The Place Store needs no change: an empty `tags` list already marks every stored link Gone (AC-7). Recorded 1391132 has `wikipedia: ''`, which is already reported as absent by `presentText` (AC-1).

#### 1.4.2 Key Quota in the Client (`interpret.ts`, `execute.ts`, `redact.ts`; AC-8 .. AC-14)

```
interpretAnswer(body, rawSchema, normalize):
  json; debug = RawDebugResponseSchema.safeParse(json)
  debug.success:
    c = classifyDebugResponse(debug.data.debug)                     (contract; code 1004 wins, also "1004" as text)
    c.kind 'key_quota'       -> { kind: 'key_quota', message: c.message }
    c.kind 'rate_limit'      -> { kind: 'rate_limit', waitSeconds: c.waitSeconds }
    c.kind 'wikimapia_error' -> { kind: 'wikimapia_error', message: c.message }
  (rest unchanged)

run(...) loop, new case:
  'key_quota' -> return { ok: false, failure: { kind: 'key_quota_exhausted',
                   message: keyQuotaMessage(interpretation.message), wikimapiaMessage: interpretation.message,
                   code: KEY_QUOTA_CODE } }
keyQuotaMessage(m) = m.trim() === '' ? 'Wikimapia key quota exhausted (code 1004)'
                                     : `Wikimapia key quota exhausted (code 1004): ${m}`
```

- Returned on any attempt, before the Retry Limit check and without sleeping. A Rate-Limit Response followed by a Key Quota Response gives exactly 1 wait and 2 requests (AC-11). `retryLimit` 0/5/10 make no difference (AC-10).
- `executeRequest` redacts every failure as before. The new `redactFailure` case applies `redactSecrets` to `message` and `wikimapiaMessage` (AC-14). The `code` literal is kept.
- `debug` without code 1004 behaves exactly as before: `debug-error.json`, code 1003, or code removed give `wikimapia_error`. `debug-rate-limit.json` gives a wait and a retry (AC-13).
- `parseRateLimitMessage` stays exported and unchanged. `interpret.ts` simply stops calling it directly.

#### 1.4.3 Key Quota in the Crawl (`requests.ts`, `gateway.ts`; AC-15 .. AC-20, AC-24)

New case in `requestWithBackoff`, placed with the other stopping kinds:

```
'key_quota_exhausted' -> gateway.stop('quota_exhausted', f.message, f.wikimapiaMessage); return STOPPED
```

- The item in progress is neither saved, nor tallied, nor recorded (AC-15, AC-16, AC-24). In the Listing Phase the page is not finished and no Details Phase follows (the existing `gateway.stopped` checks). The next Run resumes at the same page (AC-16).
- A Key Quota answer to a Connection Failure retry ends the back-off loop and the Run. No further try is made (AC-20).
- The quota request has already passed through the Gateway's transport, so it counts in `wikimapiaRequests`, in its kind, and against the budget (AC-18).
- No state persists between Runs. Each Run spends exactly 1 request and stops (AC-17). No wait is ever scheduled for the quota.
- `'quota_exhausted'` is a `StopReason` automatically (`Exclude<RunOutcome, ...>`). `finishRun` writes it as the Run Record status (requires the widened check, 2.1). `exitCodeFor` maps it to 0 (AC-19). Progress line: `Stopping: Quota Exhausted`.
- `report.message` = the stop message = the Client's `message`, which contains Wikimapia's text (AC-18).

Wikimapia Error item messages (AC-22, AC-27): in the `wikimapia_error` case,

```
message = oneLine(f.wikimapiaMessage) === '' ? f.message : `${f.message}: ${oneLine(f.wikimapiaMessage)}`
```

Both parts are already redacted by the Client (AC-27's `Key <key> is not valid` arrives as `Key [key removed] is not valid`). The phases prefix the item as before: `Place 164369: Wikimapia reported an error: Invalid API key.`

#### 1.4.4 Concluding an Item Failure (`failures.ts`, phases; AC-21 .. AC-23, AC-28, AC-29)

```
concludeItemFailure(ctx, item, failureKind, message):
  failedAt = toMoment(ctx.clock.now())          concluded moment: receive moment of the last try / save attempt (AC-21, AC-23)
  r = await ctx.repo.recordItemFailure({ runId: ctx.runId, item, failureKind, message, failedAt })
  !r.ok               -> ctx.gateway.stop('failed', r.failure.message); return false       (AC-28: not tallied, no record)
  r.value taken_over  -> ctx.gateway.stop('failed', takenOverMessage(regionName)); return false
  ctx.tally.itemFailure(item, failureKind, message); ctx.progress(`Item failure: ${message}`)
  if r.value.parked: ctx.tally.placeParked()
     ctx.progress(`Place ${id}: parked after ${PARKING_THRESHOLD} failures (${ITEM_FAILURE_LABELS[kind]})`)
  return true
```

- The Listing Phase calls it where it called `tally.itemFailure` today. `true` means break to the next Tile, `false` means return. The Details Phase does the same: `true` means continue, `false` means break. Both the Client failure and the `invalid_data` save rejection go through it. `failedAt` is read **immediately** after the failing call returns, before any other await.
- Tally only after the record is kept: "an Item Failure is never counted without its Failure Record" (AC-28; the allowed exception is not used).
- Dry Runs never reach the phases, so they keep no records (AC-24).
- `message` is exactly the `ItemFailureReport.message` (AC-21, AC-26).

#### 1.4.5 Run start with Explicit Retry (`crawl-progress.ts` `beginRunStep`, `parking.ts`; AC-37, AC-38, AC-40, AC-42)

The steps of hydration AL4 1.4.5 are unchanged up to and including the Run Record insert. Then, still in the same transaction and with the same Writer:

```
placesReleased = 0
if input.retryParked:
  placesReleased = await releaseParkedPlaces(trx, writer, { runId, regionName, bbox, at: input.startedAt })
(pass handling unchanged)
return { kind: 'started', ..., placesReleased }

releaseParkedPlaces(trx, writer, { runId, regionName, bbox, at }):
  parked = await selectParkedPlaces(trx, { bbox })                       (1.4.6; Region Places only)
  writer.run(insert crawl_explicit_retries (run_id, region_name, retried_at = at, places_released = parked.length))
  if parked.length > 0:
     writer.run(insert crawl_place_releases (run_id, place_id, released_at = at) values ... one row per Place, ascending)
  return parked.length
```

- Refused starts (live Run, changed definition) return before this point and write nothing, so no Explicit Retry is kept for them.
- The Count Reset of each released Place becomes `startedAt`, the Run's start moment, because `released_at = startedAt` (AC-37). `retriedAt` equals `report.summary.startedAt`.
- Places outside the Region keep their Parking (AC-37, Place 902). A Place in two Regions is released by a retry of either (Parking belongs to the Place, AC-36).
- Released Places are due again at once (they are Summary-Only or stale) and appear in Details Order among the others (AC-37: `[300, 900, 901]`).
- Write-hook numbering: +1 write (the retry row) and +1 (the releases) only when the option is given. Hydration AC-14's numbering is unaffected.

#### 1.4.6 Deciding Parking (`parking.ts`; AC-29 .. AC-38)

`selectParkingRows(db, scope)` is one parameterized statement. It loads every Failure Record **about a Place** in scope, together with the inputs of that Place's Count Reset:

```sql
SELECT f.run_id, f.place_id, f.failure_kind, f.message,
       to_char(f.failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')          AS failed_at_text,
       to_char(p.details_fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS details_fetched_at_text,
       to_char(r.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')        AS released_at_text
FROM crawl_item_failures f
JOIN places p ON p.place_id = f.place_id
LEFT JOIN LATERAL (SELECT max(released_at) AS released_at FROM crawl_place_releases WHERE place_id = f.place_id) r ON true
WHERE f.place_id IS NOT NULL
  AND <scope>                                   -- bbox: the R1 Centre Point filter of places-due.ts (envelope && + inclusive lon/lat)
                                                -- placeId: f.place_id = ?
ORDER BY f.place_id, f.failed_at, f.failure_id
```

`parkedPlacesFrom(rows)` (pure) groups by `place_id`. For each Place it builds the `FailureRecord[]` (`item: { kind: 'place_details', placeId }`) and computes `reset = countResetOf({ lastDetailsSaveAt, lastExplicitRetryAt })` (keys only when the text is not null). It then calls `kind = parkingKindOf(records, placeId, reset)`. A Place is Parked when `kind !== undefined`. Result: ascending `placeId`.

- "Most recent successful Details Save" = `places.details_fetched_at`. Every successful Details Save sets it, including Unchanged saves (storage D3). A Place parked while Summary-Only has no Details Save, so only releases reset it (AC-29, AC-38).
- Listing Page records have `place_id` null and are never loaded (AC-34). Connection Failures are loaded, but the contract function never counts them (AC-32).
- Records from every Run and every Region count (AC-30). Records before the Count Reset are kept but not counted (AC-33, AC-38).
- Cost: Failure Records are rare (at most one per Place per Run), and the bbox filter uses the places GIST index plus the `(place_id, failed_at)` index of 2.2.

Uses:

| Caller | Scope | Purpose |
|---|---|---|
| `releaseParkedPlaces` (start step) | Region bbox | Places to release |
| `failureStep` | `{ placeId }` after the insert, same transaction | `parked` flag, which feeds `placesParkedThisRun` |
| `listPlacesDue` (repository), `listPlacesDueForDetails` (public) | Region / input bbox | `excludePlaceIds` for the R1 query |
| `regionTotals` | Region bbox | `placesParked` and `excludePlaceIds` for the due count |
| `listParkedPlaces` | Region bbox | Dry Run `parkedPlacesInRegion`; `parkedAtStart` of the Details Phase |

`placesParkedThisRun` counts Places whose own failure in this Run made them Parked (`failureStep`'s check). A Place that is not Parked at its failure, and a Place parked concurrently by another Region's Run, are not counted. `placesParked` at the end is the number of Parked Region Places (`regionTotals`).

#### 1.4.7 Places Due for Details (`places-due.ts`; amended R1, AC-35)

`DUE_FILTER_SQL` gains a constant fragment `AND NOT (place_id = ANY(?::bigint[]))`. Its binding is `excludePlaceIds ?? []` (an empty array excludes nothing). The order and limit are unchanged. Parked Places are therefore skipped without affecting Details Order or the `limit` (budget + 1) cut.

- Repository `listPlacesDue(query)`: one READ COMMITTED transaction. It runs `selectParkedPlaces(trx, { bbox })`, then `selectPlacesDue(trx, { ...query, excludePlaceIds })`.
- Repository `regionTotals({ bbox, dueBefore })`: one REPEATABLE READ read-only transaction. It returns `parked = selectParkedPlaces(...)`, `placesDue = countPlacesDue(trx, { bbox, dueBefore, excludePlaceIds: parked ids })`, and `placesParked = parked.length`.
- Public `listPlacesDueForDetails`: same as the repository list, without a limit, gated with `PlacesDueValueSchema`.
- A Region whose only due Places are Parked yields an empty list: no request, outcome Completed (AC-35).

#### 1.4.8 Failure Record write step and reads (`failure-records.ts`; AC-21, AC-25, AC-26, AC-28)

```
failureStep(db, record, hook):
  v = validateFailureRecord(record)          invalid -> throw InvalidFailureRecordError (repository maps to its invalid_data failure)
  db.transaction(async trx => {              READ COMMITTED
    if !(await lockLiveRun(trx, v.runId)) return { kind: 'taken_over' }          (reuse crawl-progress.ts helper; export it)
    writer = createWriter(hook)
    await writer.run(trx(CRAWL_TABLES.itemFailures).insert(columnsOf(v)))
       place item   -> place_id = placeId, tile_number = null, page_no = null
       listing item -> place_id = null, tile_number = tileNumber, page_no = page
       failure_kind, message, failed_at = failedAt
    if v.item.kind === 'place_details':
       parked = (await selectParkedPlaces(trx, { placeId })).at(0)
       return parked ? { kind: 'recorded', parked } : { kind: 'recorded' }
    return { kind: 'recorded' }
  })
```

- The crawl treats a repository `invalid_data` from `recordItemFailure` like any store failure (Run stops Failed). It indicates a programming error, because the crawl builds valid records.
- A hook or database failure rolls the insert back. The repository resolves `store_unavailable` through `unavailableFrom(error, 'item failure record')`, never copying error text (AC-28, AC-27).
- Append-only: no statement anywhere updates or deletes Failure Records, Explicit Retries or releases (AC-25). Only `emptyStore()` on the Test Database and the step's `down` remove them.

Reads (`selectFailureRecords`, `selectExplicitRetries`), single statements, moments via `to_char`:

- By Place: `WHERE place_id = ? ORDER BY failed_at, failure_id`. By Run: `WHERE run_id = ? ORDER BY failed_at, failure_id`. Rows are parsed with `FailureRowSchema` and mapped to `FailureRecord` (`item` from whichever item columns are set).
- Explicit Retries: `WHERE region_name = ? ORDER BY retried_at, run_id`, parsed with `RetryRowSchema`.
- Empty lists when there is nothing.

Public `createCrawlStore` (same `guarded` pattern as the existing methods): validate (`validateFailureRecordsInput` / `validateExplicitRetriesInput`; invalid input never reaches the DB), then not-configured, then the read, then the gate (`FailureRecordsValueSchema`, `ExplicitRetriesValueSchema`; a gate failure resolves `store_unavailable` "stored data failed the read-back check"), then error mapping.

#### 1.4.9 Schema Setup `emptyStore()` (`schema-setup.ts`; AC-42)

Inside the existing transaction, after `TRUNCATE_STORE_TABLES` and the `crawl_runs` probe:

```
if crawl_runs present:
   failuresPresent = to_regclass('crawl_item_failures') is not null     (binding = CRAWL_TABLES.itemFailures)
   failuresPresent ? TRUNCATE_ALL_CRAWL_TABLES : TRUNCATE_CRAWL_TABLES
TRUNCATE_ALL_CRAWL_TABLES = 'TRUNCATE TABLE crawl_place_releases, crawl_explicit_retries, crawl_item_failures,
                             crawl_finished_pages, crawl_passes, crawl_runs RESTART IDENTITY'
```

The tables must be in one `TRUNCATE` because of the foreign keys to `crawl_runs`. After `undoLast()` of this step, the old statement is used (hydration AC-56 loop, AC-41 undo test).

#### 1.4.10 Run Summary and report (`report.ts`; AC-18, AC-39, AC-40)

`formatSummaryText(summary, notes)` appends, after the per-kind Item Failure lines and in `SUMMARY_LABELS` order:

```
Places parked in this run: n
Places parked (skipped): n
Places released by explicit retry: n
Wikimapia message: <oneLine(text) || '(empty)'>          only when summary.outcome === 'quota_exhausted' and notes.wikimapiaMessage is given
```

- `buildReport` passes `{ wikimapiaMessage }` to `formatSummaryText` only for `quota_exhausted`. It sets `parkedPlacesInRegion` only when given (the contract allows it for Planned only).
- `failedReport` and `plannedReport` use zero counts, so the three lines show 0 (AC-39 Dry Run).
- `createTally`: `placeParked()` increments `parkedThisRun`. `snapshot` writes `placesParkedThisRun = parkedThisRun` and takes `placesParked` and `placesReleased` from `extra`.
- The Run Record keeps the counts through `finishRun` as before (AC-39).

Command output (`command.ts` `writeReport`): for a Planned report with `parkedPlacesInRegion` defined, one extra line after the plan lines: `Parked places that ${CRAWL_COMMAND_OPTIONS.retryParked} would release: n`. It is not part of `summaryText`.

#### 1.4.11 Command (`command.ts`, `config.ts`; AC-40)

- `FLAG_OPTIONS` gains `CRAWL_COMMAND_OPTIONS.retryParked`. The request gets `retryParked: true` when the flag is given; giving it twice is a usage failure, as for the other flags.
- `usageMessage` lists `[--retry-parked]` after `[--relist]`.
- The option combines with every other option (AC-40). With `--dry-run` it behaves as in 1.2 step 2.

#### 1.4.12 Reading old Run Records (`rows.ts`; decision 5)

```
PARKING_COUNT_DEFAULTS = { placesParkedThisRun: 0, placesParked: 0, placesReleased: 0 }
StoredRunCountsSchema = z.preprocess(withParkingCounts, RunCountsSchema)
withParkingCounts(value: unknown): unknown =
   plain object (not array, not null) -> { ...PARKING_COUNT_DEFAULTS, ...value }  else value unchanged
RunRowSchema.counts = StoredRunCountsSchema
```

`withParkingCounts` is a validator pre-step over untrusted database JSON, so `unknown` is allowed (`.agrules` section 5). Stored values win, so complete records are read unchanged. Anything else invalid still fails the gate.

### 1.5 Transaction boundaries (additions to hydration AL4 1.5)

| Operation | Boundary | Isolation / locking | On failure |
|---|---|---|---|
| Run start with Explicit Retry | the existing start transaction, plus the parked read, the retry row and the release rows | READ COMMITTED; Region advisory lock, then `crawl_runs` rows (unchanged order); parking reads take no locks | full rollback: no Run Record, no Explicit Retry, nothing released; Run ends Failed |
| Failure Record (`failureStep`) | one transaction: own `crawl_runs` row `FOR UPDATE`, one insert, one parking read for the Place | READ COMMITTED | rollback; Run stops Failed; the Item Failure is not tallied (AC-28) |
| Due list (Run) | one transaction: parked read + due select | READ COMMITTED, no locks | `store_unavailable`; Run stops Failed (unchanged) |
| Region totals (Run end) | one read-only transaction: parked read + due count | REPEATABLE READ | fallback estimates (1.2 step 9) |
| Parked count (Dry Run) | single read | | Run ends Failed (decision 1) |
| Public reads (`readFailureRecords`, `readExplicitRetries`, `listPlacesDueForDetails`) | single statement / one read-only transaction | REPEATABLE READ for the two-statement due list | `store_unavailable` |
| Schema step 6 | one transaction (Knex default) | Knex migration lock | `store_unavailable` |

The lock order is unchanged: Region lock, then `crawl_runs` row(s), then place advisory locks (listing step only). No new step takes a lock on `places`, so no deadlock is introduced. No transaction is held across a Wikimapia request or a wait.

## 2. Data Model Design (Declarative)

### 2.1 Schema Setup step 6: `20261022_02_create_item_failures`

| Up | Down |
|---|---|
| 1. `ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_status_valid, ADD CONSTRAINT crawl_runs_status_valid CHECK (status IN ('in_progress','completed','budget_reached','rate_limited','quota_exhausted','interrupted','failed','abandoned'))` (= `RunRecordStatusSchema.options`) | 1. drop `crawl_place_releases`, `crawl_explicit_retries`, `crawl_item_failures` (in that order) |
| 2. create `crawl_item_failures` (2.2) | 2. `ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_status_valid, ADD CONSTRAINT crawl_runs_status_valid CHECK (<the hydration list without 'quota_exhausted'>) NOT VALID`. `NOT VALID` keeps existing `quota_exhausted` records readable and the undo from failing; only new writes are checked. |
| 3. create `crawl_explicit_retries` (2.3) | |
| 4. create `crawl_place_releases` (2.4) | |

- Constant DDL through the Knex schema builder plus `knex.raw` for the `ALTER` and the partial index. Every constraint and index is named explicitly, as in step 5.
- The step does not touch any Place, Comment, Tag, Place-Tag Link, Crawl Progress or Run Record row (AC-41). Applying it again after `undoLast()` succeeds and restores empty tables (AC-41).
- It is appended to `MIGRATIONS` as the 6th, newest step. `hydration.test.ts` AC-55 (one `undoLast` + apply) and AC-56 (undo newest-first until the three hydration tables are gone) both work with it.
- General rules of hydration AL4 2.1 apply: `timestamptz(0)` moments written as contract whole-second text and read with `to_char(... AT TIME ZONE 'UTC', ...)`; the Region Name check; no geometry, `inet`, `cidr` or vector columns. Column names avoid `/description|comment|title|author|user_?ip|outline|polygon/i` (AC-41), `/embedding|vector/i` (storage AC-5), the IP patterns (storage AC-6) and the Listing Page total pattern (storage AC-14; hence `page_no`, 0.2).
- No Objection models: fixed Knex statements and Zod row schemas, as for the hydration tables.

### 2.2 `crawl_item_failures` (Failure Records)

| Column | Type | Null | Rule |
|---|---|---|---|
| `failure_id` | `bigserial` | PK | Insertion order; tie-breaker for "oldest first" |
| `run_id` | `bigint` | not null | FK -> `crawl_runs(run_id)` `ON DELETE RESTRICT` |
| `place_id` | `bigint` | null | `CHECK (place_id IS NULL OR place_id >= 1)`. No FK to `places`: records are history, and `emptyStore()` truncates `places` separately. |
| `tile_number` | `integer` | null | `CHECK (tile_number IS NULL OR tile_number >= 1)` |
| `page_no` | `integer` | null | `CHECK (page_no IS NULL OR page_no >= 1)` |
| `failure_kind` | `text` | not null | `CHECK (failure_kind IN ('connection','wikimapia_error','unexpected_response','invalid_request','invalid_data'))` (= `ItemFailureKindSchema.options`) |
| `message` | `text` | not null | `CHECK (message <> '')`; the Item Failure message as shown (redacted, no Wikimapia content beyond the Client's error text) |
| `failed_at` | `timestamptz(0)` | not null | concluded moment |

- Item shape check `crawl_item_failures_one_item`: `(place_id IS NOT NULL AND tile_number IS NULL AND page_no IS NULL) OR (place_id IS NULL AND tile_number IS NOT NULL AND page_no IS NOT NULL)`.
- Indexes: `crawl_item_failures_place_idx btree (place_id, failed_at) WHERE place_id IS NOT NULL` (by-Place reads, parking); `crawl_item_failures_run_idx btree (run_id, failed_at)` (by-Run reads).

### 2.3 `crawl_explicit_retries` (Explicit Retries)

| Column | Type | Null | Rule |
|---|---|---|---|
| `run_id` | `bigint` | PK | FK -> `crawl_runs(run_id)` `ON DELETE RESTRICT`; at most one Explicit Retry per Run |
| `region_name` | `text` | not null | Region Name check |
| `retried_at` | `timestamptz(0)` | not null | the Run's start moment |
| `places_released` | `integer` | not null | `CHECK (places_released >= 0)` |

Index: `crawl_explicit_retries_region_idx btree (region_name, retried_at)`.

### 2.4 `crawl_place_releases` (per-Place Count Resets)

| Column | Type | Null | Rule |
|---|---|---|---|
| `run_id` | `bigint` | not null | FK -> `crawl_explicit_retries(run_id)` `ON DELETE CASCADE` |
| `place_id` | `bigint` | not null | `CHECK (place_id >= 1)` |
| `released_at` | `timestamptz(0)` | not null | = the retry's `retried_at` |

PK `(place_id, run_id)`. It serves the `max(released_at)` lookup per Place.

### 2.5 Row schemas (`rows.ts`)

- `FailureRowSchema`: `run_id`, `place_id` (nullable), `tile_number` (nullable), `page_no` (nullable), `failure_kind` (`ItemFailureKindSchema`), `message`, `failed_at_text`.
- `ParkingRowSchema`: `run_id`, `place_id`, `failure_kind`, `message`, `failed_at_text`, `details_fetched_at_text` (nullable), `released_at_text` (nullable).
- `RetryRowSchema`: `run_id`, `region_name`, `retried_at_text`, `places_released`.
- `RunRowSchema.counts`: `StoredRunCountsSchema` (1.4.12).

All are non-strict objects with `bigint` values as numbers (existing int8 parser), the same as the existing row schemas.

## 3. Batch & External Calls

Only the Wikimapia API is called (no OpenAI). The hydration AL4 section 3 table holds, with these changes:

| External call | Change |
|---|---|
| `box`, `place.getbyid` | A Key Quota Response (code 1004) is never retried or waited for. The Run stops at once (`quota_exhausted`, Clean Stop, exit 0). The request counts against the Request Budget. Pacing (6 s), budget (500), timeout (30 s), Rate-Limit retries (up to 5, stated wait or 60 s fallback) and Connection Failure back-off (30 s, 60 s) are unchanged. |
| `place.getbyid` | Parked Places are not requested until released by `--retry-parked`. |

**Idempotency and resumability:**

- A Key Quota stop keeps every Finished Page and Details Save made before it. The item in progress stays unfinished or due, so the next Run resumes exactly there (AC-16). With an exhausted quota, each Run spends exactly 1 request (AC-17). Nothing waits for the unknown reset window.
- Failure Records are append-only, one per Item Failure. A crash after the failure but before its record leaves no record. The Place simply stays due and is retried, so its count can only be lower, never doubled. A crash after the record commits keeps it, and the next Run does not repeat that Run's attempt.
- An Explicit Retry is part of the Run start transaction: it either fully happens with its Run Record or not at all. Rerunning `--retry-parked` releases nothing new when nothing is Parked, but still keeps a 0-release retry record (decision 3).
- Parking state is derived, never stored as a flag. It is recomputed from records, saves and releases, so no Run can leave it inconsistent.
- No embeddings are computed.

## 4. Implementation Units

Units are ordered by dependency. Each fits one AL3 -> AL2 iteration. `contracts/crawl-run1-fixes.schema.test.ts`, `contracts/wikimapia-client*.test.ts`, `contracts/hydration.schema.test.ts` and every `tests/` file not reworked by a unit must stay green in every unit. `contracts/crawl-run1-fixes.test.ts` and `contracts/hydration.test.ts` import every entry point and can run from U1 on. The `-t` filters below select the describes a unit turns green (the names start with `AC-n `).

**DB precondition:** `pnpm db:up` has run and `.env.test` exists. **tsc baseline:** the five errors listed in section 0 at the start. "No new errors" means only the not-yet-resolved ones remain.

### U1. Client: missing/null Tags and Key Quota Exhausted

- **Scope:** part A and the Client side of part B.
- **Files:** `src/wikimapia/types.ts`, `src/wikimapia/interpret.ts`, `src/wikimapia/execute.ts`, `src/wikimapia/redact.ts`, `src/wikimapia/normalize.ts`. Tests: `tests/wikimapia/normalize.test.ts` (fix line 566: the fixture's `tags` is now optional, so use a local non-null list; new cases), `tests/wikimapia/interpret.test.ts`, `tests/wikimapia/execute.test.ts`, `tests/wikimapia/redact.test.ts`.
- **Design refs:** 1.4.1, 1.4.2
- **Turns green:** `contracts/crawl-run1-fixes.test.ts` AC-1 .. AC-5, AC-7 .. AC-14.
- **Unit tests must cover:** `normalizePlaceDetails` with `tags` missing / `null` / `[]` gives equal results with `tags: []`. `interpretAnswer` maps code 1004 (number and `"1004"`) to `key_quota` with the message as sent, including empty and rate-limit wording. Code 1003 and no code map to `wikimapia_error`. `debug-rate-limit.json` still maps to `rate_limit`. `executeRequest`: key quota on attempt 1 gives no sleep and 1 transport call; rate limit then key quota gives one 7000 ms sleep, 2 calls and `key_quota_exhausted`; `retryLimit` 0 behaves the same. `message` is `Wikimapia key quota exhausted (code 1004): <msg>`, or the bare prefix when the message is blank. `redactFailure` removes the key and keyed URLs from both `message` and `wikimapiaMessage` of the new kind, and keeps `code: 1004`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts` passes
  - `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-([1-5]|[7-9]|1[0-4]) "` passes
  - `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems
  - `pnpm exec tsc --noEmit`: the errors at `normalize.ts:157`, `redact.ts:53` and `normalize.test.ts:566` are gone. `requests.ts:65` and `report.test.ts:38` remain (U5).

### U2. Schema Setup step 6, `emptyStore`, old Run Records

- **Scope:** the migration, its registration, the `emptyStore()` extension, the widened status check, the read path for old counts, and the table constants.
- **Files:** `src/db/crawl-tables.ts`, `src/db/migrations/20261022_02_create_item_failures.ts`, `src/db/migrations/index.ts`, `src/db/schema-setup.ts`, `src/db/rows.ts` (`StoredRunCountsSchema` only). Tests: `tests/db/schema-setup.db.test.ts` (STEP_NAMES gains the 6th step), `tests/db/crawl-schema.db.test.ts`, `tests/db/crawl-store.db.test.ts` (fix `NONZERO_COUNTS` at line 205 with the three counts; add a legacy-record case).
- **Design refs:** 1.4.9, 1.4.12, 2.1 .. 2.4
- **Turns green:** `contracts/crawl-run1-fixes.test.ts` AC-41 (first case; the second needs U6), `contracts/hydration.test.ts` AC-55 .. AC-57. Keeps storage AC-1 .. AC-6 and AC-14 green.
- **Unit tests must cover:** `apply` from nothing returns 6 steps in order. `undoLast` returns exactly `['20261022_02_create_item_failures']`, removes only the three new tables, and a second `undoLast` removes the hydration tables. Re-apply works. `emptyStore` clears all nine crawl and store tables (one synthetic row per new table, seeded with the test's own Knex handle), and also succeeds after `undoLast` of step 6. The status check accepts `quota_exhausted` with `ended_at` set. After `undoLast`, an existing `quota_exhausted` row does not make the undo fail. CHECKs reject: a Failure Record with both item forms or neither, an empty message, an unknown kind, `place_id` 0, a negative `places_released`. `failed_at` has `udt_name` `timestamptz`, and no new column matches the AC-41 regex. `readCrawlProgress` of a `crawl_runs` row whose `counts` lacks the three keys returns them as 0. A row with other malformed counts still resolves `store_unavailable`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts tests/db/crawl-schema.db.test.ts tests/db/crawl-store.db.test.ts` passes
  - `pnpm exec vitest run --no-color contracts/hydration.test.ts -t "^AC-5[5-7] "` passes
  - `pnpm exec vitest run --no-color contracts/storage.test.ts` passes
  - `pnpm db:migrate` on the Development Database applies one new step. `pnpm db:status` lists 6 applied. `pnpm crawl --region belgrade-small --dry-run` still exits 0.
  - `pnpm exec eslint src/db tests/db` reports no problems. `pnpm exec tsc --noEmit` reports no new errors.

### U3. Failure Record step and public reads

- **Scope:** writing one Failure Record in its own transaction (without the parking flag yet: `parked` is never set until U4), reading Failure Records and Explicit Retries, and the `createCrawlStore` signature.
- **Files:** `src/db/failure-records.ts`, `src/db/rows.ts` (`FailureRowSchema`, `RetryRowSchema`), `src/db/validate.ts`, `src/db/types.ts` (`FailureRow`, `RetryRow`, `FailureStepValue`, repository `recordItemFailure`), `src/db/crawl-progress.ts` (export `lockLiveRun`), `src/db/crawl-repository.ts` (`recordItemFailure`), `src/db/crawl-store.ts`. Tests: `tests/db/failure-records.db.test.ts` (new), `tests/db/validate.test.ts` (new cases), `tests/db/crawl-store.db.test.ts` (new cases).
- **Depends on:** U2
- **Design refs:** 1.4.8, 1.5, 2.2, 2.3, 2.5
- **Turns green:** the store side of AC-21, AC-25, AC-26, AC-28 (verified end to end in U6).
- **Unit tests must cover:** recording a Place item and a listing item round-trips through `readFailureRecords` by Place and by Run, exactly equal to the input `FailureRecord`. The order is oldest first, with ties in insertion order. Records of other Places and Runs are not returned. A taken-over (abandoned) Run returns `taken_over` and writes nothing. A hook that throws rolls back and resolves `store_unavailable` without the hook's text. An invalid record (empty message, sub-second moment, `key_quota_exhausted` kind) is `invalid_data` without DB access. `readExplicitRetries` returns seeded rows oldest first and `[]` for another Region. Invalid inputs (`{}`, `{ placeId: 0 }`, a bad Region Name) give `invalid_data`. An unreachable URL gives `store_unavailable` without password or `postgres://`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db/failure-records.db.test.ts tests/db/validate.test.ts tests/db/crawl-store.db.test.ts tests/db/crawl-repository.db.test.ts` passes
  - `pnpm exec eslint src/db tests/db` reports no problems. `pnpm exec tsc --noEmit` reports no new errors (the `CreateFailureAwareCrawlStoreFn` assignment in `contracts/crawl-run1-fixes.test.ts` type-checks).

### U4. Parking, Explicit Retry release, due exclusion

- **Scope:** Parking inputs and decision, `parked` flag of the Failure Record step, releases in the start step, Parked-Place exclusion in due list and count, `regionTotals`, `listParkedPlaces`.
- **Files:** `src/db/parking.ts`, `src/db/rows.ts` (`ParkingRowSchema`), `src/db/types.ts` (`ParkingScope`, `ParkedPlace`, `ReleaseInput`, `RegionTotals`, `DueQuery.excludePlaceIds`, `BeginRunInput.retryParked`, `BeginRunValue.placesReleased`, repository methods), `src/db/places-due.ts`, `src/db/failure-records.ts` (parked flag), `src/db/crawl-progress.ts` (`beginRunStep`), `src/db/crawl-repository.ts`, `src/db/crawl-store.ts` (`listPlacesDueForDetails` exclusion). Tests: `tests/db/parking.test.ts` (pure `parkedPlacesFrom`), `tests/db/parking.db.test.ts` (new), `tests/db/places-due.db.test.ts`, `tests/db/crawl-repository.db.test.ts` (callers of the removed `countPlacesDue` move to `regionTotals`; the `beginRun` input gains `retryParked: false`).
- **Depends on:** U3
- **Design refs:** 1.4.5, 1.4.6, 1.4.7, 1.5, 2.4
- **Turns green:** store side of AC-29 .. AC-38, AC-42 (verified end to end in U6).
- **Unit tests must cover:** `parkedPlacesFrom` with records built by hand. It agrees with the contract `isParkedPlace` on the AC-29 .. AC-34 and AC-38 cases of `crawl-run1-fixes.schema.test.ts`. The reset is taken from `details_fetched_at` and from the latest release, and the same-second release counts. DB cases (synthetic places and records seeded through the repository): three `wikimapia_error` records park the Place, and the third `recordItemFailure` returns `parked`. Three `connection` records do not park. Listing records never park. A Details Save after two errors resets the count. A Place outside the bbox is not in `listParkedPlaces({ bbox })`. `beginRun` with `retryParked` releases exactly the Parked Region Places, keeps one retry row (also with 0 released) and returns `placesReleased`. After that the Place is no longer Parked. A refused start (`run_in_progress`) keeps no retry. `listPlacesDue` and `listPlacesDueForDetails` omit Parked Places, while Details Order and `limit` hold for the rest. `regionTotals` returns due and parked counts consistent with the lists.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db` passes
  - `pnpm exec vitest run --no-color contracts/hydration.test.ts -t "^AC-(2[89]|3[0-4]) "` passes (R1 behaviour unchanged without Parked Places)
  - `pnpm exec eslint src/db tests/db` reports no problems. `pnpm exec tsc --noEmit` reports no new errors (`src/crawl/run-crawl.ts` compiles against the changed repository only after U6. If the removed `countPlacesDue` breaks the build, keep a thin `countPlacesDue` adapter in the repository until U6 removes it).

### U5. Crawl core: quota stop, item messages, tally and summary

- **Scope:** the pure crawl parts: Key Quota stop, Wikimapia Error item message, Gateway `stop` with the Wikimapia message, tally parking counts, summary lines, report builders.
- **Files:** `src/crawl/types.ts` (`Stop`, `Gateway.stop`, `Tally`, `SummaryNotes`), `src/crawl/gateway.ts`, `src/crawl/requests.ts`, `src/crawl/report.ts`. Tests: `tests/crawl/report.test.ts` (fix the `RunCounts` literal at line 38 and the 2 failing cases; new cases), `tests/crawl/requests.test.ts`, `tests/crawl/gateway.test.ts`.
- **Depends on:** U1
- **Design refs:** 1.4.3, 1.4.10
- **Turns green:** pure side of AC-18, AC-39.
- **Unit tests must cover:** `requestWithBackoff` on a Key Quota answer stops with `quota_exhausted` and the Client message and Wikimapia text after 1 call. A Key Quota answer to the second Connection Failure try stops after 2 calls and one 30 s wait. A Wikimapia Error item message equals `Wikimapia reported an error: <redacted text>`, and only the bare message when the text is blank. The Gateway keeps the first stop with its `wikimapiaMessage`. `formatSummaryText` of a quota Run ends with the three parking lines and `Wikimapia message: Key limit has been reached`. A blank message gives `(empty)`, and a multi-line message gives one line. No other outcome shows that line. Every line matches the AC-54 regex. `buildReport` passes `RunReportSchema` for `quota_exhausted` (with message) and for Planned with `parkedPlacesInRegion`. The tally's `snapshot` satisfies `RunCountsSchema`, including `placesParkedThisRun <= placesParked`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/crawl/report.test.ts tests/crawl/requests.test.ts tests/crawl/gateway.test.ts contracts/hydration.schema.test.ts` passes
  - `pnpm exec eslint src/crawl tests/crawl` reports no problems
  - `pnpm exec tsc --noEmit`: the errors at `requests.ts:65` and `report.test.ts:38` are gone

### U6. The Run: Failure Records, Parking, Explicit Retry, Dry Run count

- **Scope:** orchestration changes of 1.2: `concludeItemFailure` in both phases, the parked count at Details Phase start, `retryParked` resolution and start, end-of-run totals, heartbeat counts, Dry Run with the option, quota report.
- **Files:** `src/crawl/failures.ts`, `src/crawl/listing-phase.ts`, `src/crawl/details-phase.ts`, `src/crawl/run-crawl.ts`, `src/crawl/config.ts` (`retryParked`, usage), `src/crawl/types.ts` (`ResolvedRun.retryParked`, `DetailsPhaseResult`). Tests: `tests/crawl/run-crawl.db.test.ts`, `tests/crawl/config.test.ts`.
- **Depends on:** U4, U5
- **Design refs:** 1.2, 1.4.3 .. 1.4.7
- **Turns green:** `contracts/crawl-run1-fixes.test.ts` AC-6, AC-15 .. AC-18, AC-20 .. AC-39, AC-41 (second case), AC-42. All of `contracts/hydration.test.ts`.
- **Unit tests must cover** (Test Database, Simulated Wikimapia and Clock; a subset, the contract file is the full net): a Run with one Wikimapia Error keeps one record whose message equals the report's and whose moment is the receive moment. When the record write fails (hook), the Run ends Failed, the failure is not tallied and no further request is sent. The third failing Run reports `placesParkedThisRun` 1 and `placesParked` 1, and a fourth sends no request for the Place. `--retry-parked` releases, requests the Place in Details Order and reports `placesReleased`. A Dry Run with `retryParked` reports `parkedPlacesInRegion` with zero counts and writes nothing. A Dry Run with `retryParked` and an unreachable database ends Failed without secrets. A Dry Run without the option still opens no database. A quota Run keeps a `quota_exhausted` Run Record with `endedAt` and shows the Wikimapia line.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/crawl tests/db` passes
  - `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-(6|1[5-8]|2[0-9]|3[0-9]|4[12]) "` passes
  - `pnpm exec vitest run --no-color contracts/hydration.test.ts` passes
  - `pnpm exec eslint src/crawl tests/crawl` reports no problems. `pnpm exec tsc --noEmit` reports no new errors.

### U7. Command option and full verification

- **Scope:** the `--retry-parked` flag, the Dry Run output line, and the whole-suite check.
- **Files:** `src/crawl/command.ts`, `tests/crawl/command.test.ts`, `tests/crawl/command.db.test.ts`.
- **Depends on:** U6
- **Design refs:** 1.4.10, 1.4.11, 0.1
- **Turns green:** `contracts/crawl-run1-fixes.test.ts` AC-19, AC-40, AC-46 and the whole file.
- **Unit tests must cover:** `parseCrawlArgs` with `--retry-parked` alone, combined with `--dry-run` and with `--budget 10`, and given twice (usage failure, exit 1, nothing sent). The usage message contains `--retry-parked`. A Dry Run with the option prints the extra parked line. A quota Run exits 0 and prints `Run outcome: Quota Exhausted` and the Wikimapia line.
- **Done when:**
  - `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/hydration.test.ts contracts/hydration.schema.test.ts` passes
  - `pnpm exec vitest run --no-color` (whole suite) passes
  - `pnpm crawl --region belgrade-small --dry-run --retry-parked` against the Development Database prints the plan and the parked line, exits 0, and changes nothing (`pnpm db:status` unchanged). `pnpm crawl --region belgrade-small --dry-run` still needs no database.
  - `pnpm exec tsc --noEmit` reports **0 errors**. `pnpm lint` reports **0 problems**.

## 5. AL2 Guidance (pitfalls)

- **Parking rule lives in the contract.** Never write `count(*) >= 3`, a kind list or a reset comparison in SQL or in `src/crawl`. Load the inputs (1.4.6) and call `countResetOf` + `parkingKindOf`.
- **Moments:** `failedAt` = `toMoment(ctx.clock.now())` taken right after the failing call or save returns. `released_at` = `retried_at` = the Run's `startedAt`, never a later clock read.
- **Never copy error text** from Knex, pg, the hook or a transport rejection (AC-28's hook message carries a connection URL). The Item Failure message is built only from the Client's redacted `message` and `wikimapiaMessage`.
- **Order inside the start transaction:** Run Record insert, then the retry row, then the releases (FK chain). Then the pass handling as before.
- **`exactOptionalPropertyTypes`:** `parked`, `parkedPlacesInRegion`, `wikimapiaMessage`, `lastDetailsSaveAt` and `lastExplicitRetryAt` are set with conditional spreads, never as `undefined`.
- **Array bindings:** pass `excludePlaceIds` as a JS array to `= ANY(?::bigint[])`. Never interpolate ids.
- **`unknown`:** only in `withParkingCounts`, caught errors, and raw `db.raw` results parsed on the next line.
- **Do not edit `contracts/` or its fixtures.** If a contract looks wrong (as in 0.2), stop and report it.
