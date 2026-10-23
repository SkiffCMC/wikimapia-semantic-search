# AL3 Routing: crawl-run1-fixes, U3 "Failure Record step and public reads"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U3 of 7 (attempt 1). Depends on U2 (done: `docs/al3-routing/20261022-crawl-run1-fixes-02-schema-al3.md`). U1 is done as well.
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section "4. Implementation Units", "U3. Failure Record step and public reads"
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2)
- **Status:** Routing to AL2 Agents

## 0. Starting state

- Schema Setup step 6 (`src/db/migrations/20261022_02_create_item_failures.ts`) exists and is applied on the Test Database. It creates `crawl_item_failures`, `crawl_explicit_retries` and `crawl_place_releases`. `src/db/crawl-tables.ts` has `CRAWL_TABLES.itemFailures`, `CRAWL_TABLES.explicitRetries`, `CRAWL_TABLES.placeReleases` and `ITEM_FAILURE_PAGE_COLUMN = 'page_no'`. `src/db/rows.ts` has `StoredRunCountsSchema`. Nothing writes or reads the three new tables yet.
- `src/db/crawl-store.ts` exports `createCrawlStore: CreateCrawlStoreFn`. It has no `readFailureRecords` or `readExplicitRetries`. The repository (`src/db/crawl-repository.ts`) has no `recordItemFailure`. `lockLiveRun` in `src/db/crawl-progress.ts` (line ~248) is module-private.
- `pnpm exec tsc --noEmit` reports exactly three errors: `contracts/crawl-run1-fixes.test.ts:156` (the `CreateFailureAwareCrawlStoreFn` assignment, **this unit clears it**), `src/crawl/requests.ts:65` and `tests/crawl/report.test.ts:38` (both U5, not yours).
- `tests/db`, `tests/wikimapia` and the storage/schema contract suites pass (1470 tests). They must stay green.
- The contract cases AC-21, AC-25, AC-26 and AC-28 in `contracts/crawl-run1-fixes.test.ts` drive a whole Run (`runCrawl`). U3 delivers only their store side. They stay red until U6. That is expected.

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, **extensionless** relative imports, `unknown` only where `.agrules` section 5 allows it, types in `src/db/types.ts`, no `console`. Match the style of the existing `src/db/` and `tests/db/` files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly section 2 (Zod at every boundary), section 3 (all SQL in `src/db/`, parameterized), section 4 (no secrets, synthetic data, Test Database only) and section 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | The design. Read only: "0. Scope and Fixed Points" (the "Single source of truth" paragraph); "1.1 Module map", the Database rows `rows.ts`, `validate.ts`, `failure-records.ts`, `crawl-repository.ts`, `crawl-store.ts`, `types.ts`; "1.3 Component contracts", the `src/db/types.ts` block and the `failureStep` / `selectFailureRecords` / `selectExplicitRetries` / `validate*` / `createCrawlStore` signatures; "1.4.8 Failure Record write step and reads"; "1.5 Transaction boundaries", rows "Failure Record (`failureStep`)" and "Public reads"; "2.2", "2.3" and "2.5" (only `FailureRowSchema` and `RetryRowSchema`); "4. Implementation Units / U3"; "5. AL2 Guidance", bullets "Never copy error text", "`exactOptionalPropertyTypes`", "`unknown`". Skip everything else. |
| 4 | `contracts/crawl-run1-fixes.schema.ts` | `FailureRecordSchema`, `FailureRecordsInputSchema`, `FailureRecordsValueSchema`, `FailureRecordsResultSchema`, `isOldestFirst`, `ExplicitRetrySchema`, `ExplicitRetriesInputSchema`, `ExplicitRetriesValueSchema`, `ExplicitRetriesResultSchema`, `FailureRecordStore`, `CreateFailureAwareCrawlStoreFn` (lines ~115-214). Ignore the parking functions (U4). |
| 5 | `contracts/hydration.schema.ts` | Only `MomentSchema` / `toMoment` (~140-150), `RegionNameSchema`, `RunIdSchema` (~153-160), `ItemFailureKindSchema` (~448), `FailedItemSchema` (~624), `CrawlStore` and `CrawlStoreOptions` (~894-903). |
| 6 | `contracts/storage.schema.ts`, `contracts/storage.support.ts` | `StoreFailure`, `WriteHook`, `InvalidDataFailureSchema`; `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`. |
| 7 | `contracts/crawl-run1-fixes.test.ts` | Reference only: lines 152-158 (the type check at line 156), the lifecycle block (~181-245) and AC-21, AC-25, AC-26, AC-28 (~953-992, ~1133-1177, ~1208-1240). They show how the reads are used. Do not expect them to pass in U3. |
| 8 | `src/db/crawl-progress.ts` | File to change (export `lockLiveRun`). Style reference for a write step: `InvalidListingError`, `listingPageStep`, `createWriter`, `to_char` moment projections. |
| 9 | `src/db/crawl-repository.ts` | File to change (`recordItemFailure`). Note `guarded`, `unchecked`, `listingFailure`, `runWideHook`. |
| 10 | `src/db/crawl-store.ts` | File to change (two reads, new type). Note `guarded`, `readFailure`. |
| 11 | `src/db/rows.ts` | File to change (`FailureRowSchema`, `RetryRowSchema`). Note `BigintSchema` and the existing row style. |
| 12 | `src/db/validate.ts` | File to change (three validators via `plain`). |
| 13 | `src/db/types.ts` | File to change (section 2.2 step 2). |
| 14 | `src/db/crawl-tables.ts`, `src/db/writer.ts`, `src/db/failures.ts`, `src/db/connection.ts` | Read only: table and column constants, `createWriter`, `invalidData` / `storeUnavailable` / `unavailableFrom`, `createDb` / `destroyQuietly`. |
| 15 | `tests/db/crawl-repository.db.test.ts` | Test file to update. Reuse its helpers (`openRepo`, `startRun`, `beginInput`, `finishResult`, `recorder`, `expectNoSecrets`, `everyCall`). |
| 16 | `tests/db/crawl-store.db.test.ts` | Test file to update. Note `create` (line 74), `trackStore`, `INVALID_CALLS`, the "not-configured" and "unreachable" groups (~606-683), `testDb()`. |
| 17 | `tests/db/validate.test.ts` | Test file to update (style of existing validator cases). |
| 18 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read anything under `src/wikimapia/` or `src/crawl/`, the AL6 document, the migrations, or the other `src/db/` files (`places-due.ts`, `schema-setup.ts`, save paths). U3 touches none of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

All DB tests run against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Empty the store (`createSchemaSetup(...).emptyStore()`) before each test, as the existing DB files do. Close every repository, store, `SchemaSetup` and `Knex` handle. Create Runs through the repository (`beginRun`). Seed `crawl_explicit_retries` rows with the Knex query builder on the file's own `testDb()` handle (table names from `CRAWL_TABLES`, no raw SQL strings), because nothing writes them until U4. All data is synthetic. Expand AL4 U3 "Unit tests must cover" as follows.

**A. `tests/db/failure-records.db.test.ts` (new)**: the write step through the repository's `recordItemFailure`, read back through the public `createCrawlStore(...).readFailureRecords` / `readExplicitRetries`.

1. Round trip (AC-21, AC-26). With one in-progress Run, record a Place item (`{ kind: 'place_details', placeId }`) and a listing item (`{ kind: 'listing_page', tileNumber, page }`). Each `recordItemFailure` resolves `{ ok: true, value: { kind: 'recorded' } }`, with **no** `parked` key (U4 adds it). Reading by `placeId` returns exactly `[placeRecord]`. Reading by `runId` returns both. Every returned record is `toStrictEqual` to the input `FailureRecord`. Parse every result with `FailureRecordsResultSchema`.
2. Every `ItemFailureKindSchema` option round-trips. A message with spaces, punctuation and non-ASCII text round-trips unchanged.
3. Order (AC-26). Records with out-of-order `failedAt` inserts come back oldest first. Records with the **same** `failedAt` come back in insertion order. By Place, records from two different Runs (the first Run finished, a second started) are both returned, oldest first.
4. Isolation. Records of another Place and of another Run are not returned. A Place or Run with nothing gives `{ records: [] }`.
5. Append-only (AC-25). A second record for the same Place and Run adds a row. Earlier records are unchanged after it, after the Run is finished, and after a later Run records more.
6. Taken over. A Run that is no longer `in_progress` (abandoned by a later start, and separately a finished Run) gives `{ kind: 'taken_over' }`. No row is written (count `crawl_item_failures` through `testDb()`). The hook is not called.
7. Unknown `runId` (no such Run) gives `taken_over` and writes nothing.
8. Write hook (AC-28). One record is exactly one write: with a recording hook, `recordItemFailure` adds exactly one hook call, numbered one higher than the last call made by the preceding `beginRun`. A hook that throws on that write (with a message that contains a `postgres://` URL and `UNREACHABLE_PASSWORD`) resolves `store_unavailable`. The failure contains neither the hook's text, nor `postgres://`, nor the password. No row is left.
9. Invalid records give `invalid_data` and write nothing (hook not called, no row): empty `message`; sub-second `failedAt` (e.g. `...T10:00:00.500Z`); `failureKind: 'key_quota_exhausted'`; extra key on the record; `item` with both shapes' keys; `placeId` 0; `runId` 0. Check each with `InvalidDataFailureSchema`.
10. Explicit Retries (AC-37 store side). Seed two `crawl_explicit_retries` rows for one Region (out of order by `retried_at`, one with `places_released` 0) and one for another Region. `readExplicitRetries({ regionName })` returns the two, oldest first, `toStrictEqual` to the `ExplicitRetry` objects. The other Region gets only its own. A Region with none gets `{ retries: [] }`. Parse with `ExplicitRetriesResultSchema`.

**B. `tests/db/crawl-repository.db.test.ts`**

1. `everyCall` gains `['recordItemFailure', ...]` with a valid record for Run 1. Update the `toHaveLength(7)` assertions in F.1 and F.2 to 8. A not-configured repository resolves the fixed not-configured message, and an unreachable one resolves `store_unavailable` without secrets.
2. In group E (write hook), add one case: `beginRun` then `recordItemFailure` numbers the hook calls continuously (the record's write is the next number). Keep every existing numbering case unchanged.

**C. `tests/db/crawl-store.db.test.ts`**

1. Retype `create` (line 74) as `CreateFailureAwareCrawlStoreFn` from the contract, and widen `trackStore` to the returned type. Do not change any existing expectation.
2. `INVALID_CALLS` gains (each `invalid_data`, on all three stores: Test Database, unreachable, not configured): `readFailureRecords({})`, `{ placeId: 0 }`, `{ runId: -1 }`, `{ placeId: 1, runId: 1 }`, `{ placeId: 1.5 }`, an extra key; `readExplicitRetries({ regionName: 'Test-One' })` (uppercase), `{ regionName: '' }`, `{}`, an extra key. The failure does not echo the bad values.
3. Not configured: both new methods give `{ kind: 'store_unavailable', message: NOT_CONFIGURED_MESSAGE }`.
4. Unreachable: both new methods give `store_unavailable` without password or `postgres://` (reuse the existing timeout).
5. Contract keys only: a successful read returns only the contract keys (`records` / `retries`, and per item only the `FailureRecordSchema` / `ExplicitRetrySchema` keys). No `failure_id`, no `*_text`, no snake_case key.

**D. `tests/db/validate.test.ts`**

`validateFailureRecord`, `validateFailureRecordsInput`, `validateExplicitRetriesInput`: a valid value returns `{ ok: true, value }` equal to the parsed input. Each invalid input of A.9 and C.2 returns `invalid_data` with issue paths (e.g. `['message']`, `['failedAt']`, `['failureKind']`). Inputs that are not objects (`null`, a string, an array) return `invalid_data` and never throw. The failure never contains the input values.

Run the four files once and confirm that the new cases fail only because the implementation is missing. Do not stub production modules.

### 2.2 add-coder

Implement exactly AL4 1.4.8, 2.5 (`FailureRowSchema`, `RetryRowSchema`) and the U3 rows of 1.1 and 1.3. **Do not set `parked`** in this unit. No parking read or parking logic exists yet (U4).

1. **`src/db/rows.ts`.** Add `FailureRowSchema` (`run_id`, `place_id` nullable, `tile_number` nullable, `page_no` nullable, `failure_kind` as `ItemFailureKindSchema`, `message`, `failed_at_text`) and `RetryRowSchema` (`run_id`, `region_name`, `retried_at_text`, `places_released`). Non-strict `z.object`, `BigintSchema` for `bigint` columns, as the existing rows. Do not add `ParkingRowSchema` (U4).
2. **`src/db/types.ts`.** Add `FailureRow`, `RetryRow` (`z.infer` of the row schemas), and the `ParkedPlace` interface and `FailureStepValue` type exactly as in AL4 1.3. `ParkedPlace` is needed now only because `FailureStepValue.parked?` refers to it. Add `recordItemFailure(record: FailureRecord): Promise<StoreResult<FailureStepValue>>` to `CrawlRepository`. Import `FailureRecord` and `ItemFailureKind` with `import type` from the contracts. Do not re-export contract types. Do not add `ParkingScope`, `ReleaseInput`, `RegionTotals`, `excludePlaceIds`, `retryParked` or `placesReleased` (U4).
3. **`src/db/validate.ts`.** Add `validateFailureRecord`, `validateFailureRecordsInput`, `validateExplicitRetriesInput` through `plain` with the contract schemas and a shape message each. They never throw.
4. **`src/db/crawl-progress.ts`.** Export `lockLiveRun` unchanged. Change nothing else.
5. **`src/db/failure-records.ts`** (new, AL4 1.4.8):
   - `InvalidFailureRecordError` (same pattern as `InvalidListingError`: carries the `invalid_data` failure).
   - `failureStep(db, record, onWrite)`: validate first (throw `InvalidFailureRecordError` before any database access). Then one READ COMMITTED transaction: `lockLiveRun` -> `taken_over` when false. Otherwise one `writer.run(...)` insert into `CRAWL_TABLES.itemFailures`: Place item -> `place_id`, tile and page null; listing item -> `place_id` null, `tile_number`, and the page column named by `ITEM_FAILURE_PAGE_COLUMN`; plus `run_id`, `failure_kind`, `message`, `failed_at` (the whole-second moment text). Return `{ kind: 'recorded' }`.
   - `selectFailureRecords(db, input)`: one parameterized query builder statement. `where place_id = ?` or `where run_id = ?`, `order by failed_at, failure_id`. Project `failed_at` with the same `to_char(... at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as failed_at_text` fragment as the other modules (constant text in `knex.raw`, no interpolation). Parse rows with `z.array(FailureRowSchema)`. Map each row to a `FailureRecord`: `item` is `place_details` when `place_id` is set, otherwise `listing_page` from `tile_number` and `page_no`. A row that fits neither throws (it becomes `store_unavailable`).
   - `selectExplicitRetries(db, input)`: `where region_name = ?`, `order by retried_at, run_id`, `retried_at` via `to_char`. Parse with `RetryRowSchema` and map to `ExplicitRetry`.
   - Import nothing from `src/crawl/`. No `update` or `delete` statement on any of the three tables (append-only, AC-25).
6. **`src/db/crawl-repository.ts`.** Add `recordItemFailure` through `guarded(db, unchecked(record), (conn, value) => failureStep(conn, value, hook), ...)` with a failure mapper like `listingFailure`: `InvalidFailureRecordError` -> its `failure`; anything else -> `unavailableFrom(error, 'item failure record')`. Never copy error text. Use the Run-wide `hook`. Leave every other method unchanged (including `countPlacesDue`, which U4 replaces).
7. **`src/db/crawl-store.ts`.** Type `createCrawlStore` as `CreateFailureAwareCrawlStoreFn` (and `buildStore`'s return as `CrawlStore & FailureRecordStore`). Add `readFailureRecords` and `readExplicitRetries` with the existing `guarded` pattern: validate (`validateFailureRecordsInput` / `validateExplicitRetriesInput`) -> not configured -> read (`selectFailureRecords` / `selectExplicitRetries`, single statement on `conn`, no transaction needed) -> gate (`FailureRecordsValueSchema.parse({ records })`, `ExplicitRetriesValueSchema.parse({ retries })`) -> `readFailure('read failure records')` / `readFailure('read explicit retries')`. A gate `ZodError` resolves the existing read-back message. Return only contract keys. This must clear the `contracts/crawl-run1-fixes.test.ts:156` tsc error.
8. Do not change `src/crawl/`, `tests/crawl/`, `scripts/`, `package.json`, the migrations, `schema-setup.ts`, `places-due.ts` or `inspect.ts`.
9. **Stop and report, do not work around:** if the `CreateFailureAwareCrawlStoreFn` assignment still fails after step 7 for a reason outside `src/db/`; if a contract type or test contradicts AL4 1.4.8 / 2.5; if adding `recordItemFailure` to `CrawlRepository` breaks a `src/crawl/` file.
10. Run every Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise). `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. **Only the Test Database is used.** Do not migrate, write to or set `DATABASE_URL` for the Development Database (the stakeholder has not approved it).

1. `pnpm exec vitest run --no-color tests/db/failure-records.db.test.ts tests/db/validate.test.ts tests/db/crawl-store.db.test.ts tests/db/crawl-repository.db.test.ts` passes (no failures, no skipped or todo tests).
2. Regression: `pnpm exec vitest run --no-color tests/db tests/wikimapia` passes.
3. Contract regression: `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
4. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-([1-5]|[7-9]|1[0-4]|41 .*the newest step) "` passes (U1 cases and the first AC-41 case stay green). The other cases of that file, including AC-21, AC-25, AC-26 and AC-28, need the Run (U6) and stay red. That is expected.
5. `pnpm exec vitest run --no-color contracts/hydration.test.ts -t "^AC-5[5-7] "` passes.
6. `pnpm exec eslint src/db tests/db` reports no problems.
7. `pnpm exec tsc --noEmit` reports **exactly** these two errors and no others: `src/crawl/requests.ts:65` and `tests/crawl/report.test.ts:38` (both U5, not yours). The error at `contracts/crawl-run1-fixes.test.ts:156` is gone. Any other error is yours.
8. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/db/failure-records.ts -Pattern "\.update\(|\.del\(|\.delete\(|from '\.\./crawl|count\(\*\)"`
   - `Select-String -Path src/db/failure-records.ts, src/db/crawl-store.ts, src/db/crawl-repository.ts -Pattern "parked:"` (no `parked` value is produced in U3)

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`, the `*.support.ts` files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test or existing `tests/db` case.
- Files you may change: `src/db/failure-records.ts` (new), `src/db/rows.ts`, `src/db/validate.ts`, `src/db/types.ts`, `src/db/crawl-progress.ts` (the `lockLiveRun` export only), `src/db/crawl-repository.ts`, `src/db/crawl-store.ts`, and the tests `tests/db/failure-records.db.test.ts` (new), `tests/db/validate.test.ts`, `tests/db/crawl-store.db.test.ts`, `tests/db/crawl-repository.db.test.ts`. Nothing else.
- Never edit an applied migration. Never touch the Development Database.
- Never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.
- If a contract, the AL4 spec or this prompt looks wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing).

## 4. Out of Scope

Do not implement any of the following now:

- **U4:** Parking. `src/db/parking.ts`, `ParkingRowSchema`, `selectParkingRows`, `parkedPlacesFrom`, `selectParkedPlaces`, the `parked` flag of `failureStep`, `releaseParkedPlaces` and any write to `crawl_explicit_retries` / `crawl_place_releases`, `beginRunStep` changes (`retryParked`, `placesReleased`), `excludePlaceIds` in `places-due.ts`, `listParkedPlaces`, `regionTotals`, removal of `countPlacesDue`, the Parked-Place exclusion of `listPlacesDueForDetails`. AL4 1.4.5 to 1.4.7.
- **U5:** everything in `src/crawl/` and `tests/crawl/`, including the `requests.ts:65` and `report.test.ts:38` tsc errors.
- **U6:** `concludeItemFailure` (`src/crawl/failures.ts`), the phases' use of `recordItemFailure`, Run orchestration, and turning AC-21 to AC-28 green end to end.
- **U7:** the `--retry-parked` command option and the whole-suite check.
- Any Development Database migration or write.
