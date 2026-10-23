# AL3 Routing: crawl-run1-fixes, U4 "Parking, Explicit Retry release, due exclusion"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U4 of 7 (attempt 1). Depends on U3 (done: `docs/al3-routing/20261022-crawl-run1-fixes-03-failure-records-al3.md`). U1 and U2 are done as well.
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section "4. Implementation Units", "U4. Parking, Explicit Retry release, due exclusion"
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2)
- **Status:** Routing to AL2 Agents

## 0. Starting state

- Schema Setup step 6 is applied on the Test Database: `crawl_item_failures`, `crawl_explicit_retries`, `crawl_place_releases` exist. `CRAWL_TABLES.itemFailures` / `.explicitRetries` / `.placeReleases` and `ITEM_FAILURE_PAGE_COLUMN` are in `src/db/crawl-tables.ts`.
- U3 delivered `src/db/failure-records.ts` (`failureStep`, `selectFailureRecords`, `selectExplicitRetries`, `InvalidFailureRecordError`), `FailureRowSchema` / `RetryRowSchema` in `src/db/rows.ts`, `ParkedPlace` / `FailureStepValue` in `src/db/types.ts`, `recordItemFailure` on the repository, `readFailureRecords` / `readExplicitRetries` on the store, and the exported `lockLiveRun` in `src/db/crawl-progress.ts`. `failureStep` never sets `parked` yet. **This unit adds it.** U3 also added union-issue narrowing in `validateFailureRecordsInput` (Zod 4 reports `invalid_union` at path `[]`). Leave it as it is.
- Nothing writes `crawl_explicit_retries` or `crawl_place_releases` yet. `beginRunStep` has no `retryParked`. `selectPlacesDue` / `countPlacesDue` have no `excludePlaceIds`. The repository still has `countPlacesDue`, and it has no `listParkedPlaces` or `regionTotals`.
- `src/crawl/run-crawl.ts` calls `repo.countPlacesDue(...)` (line ~167) and `repo.beginRun({...})` (line ~224). No file in `tests/crawl/` implements a fake `CrawlRepository`.
- `pnpm exec tsc --noEmit` reports exactly two errors, both U5 (not yours): `src/crawl/requests.ts:65` and `tests/crawl/report.test.ts:38`.
- `tests/db`, `tests/wikimapia` and the storage, schema and client contract suites pass (1713 tests). They must stay green.
- The contract cases AC-29 .. AC-38 and AC-42 in `contracts/crawl-run1-fixes.test.ts` drive whole Runs (`runCrawl`). U4 delivers only their store side, so they stay red until U6. That is expected.

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, **extensionless** relative imports, `unknown` only where `.agrules` section 5 allows it, types in `src/db/types.ts`, no `console`. Match the style of the existing `src/db/` and `tests/db/` files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly section 2 (Zod at every boundary), section 3 (all SQL in `src/db/`, parameterized only), section 4 (no secrets, synthetic data) and section 5. |
| 2 | `CLAUDE.md` | Stack and decisions ("Crawl progress storage"). Do not edit it. |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | The design. Read only these parts: "0. Scope and Fixed Points" (the "Single source of truth" paragraph); "0.1" decision 3 and the "Parking" and "Places Due for Details" rows; "1.1 Module map", the Database rows for `parking.ts`, `places-due.ts`, `crawl-progress.ts`, `crawl-repository.ts`, `crawl-store.ts`, `rows.ts`, `types.ts`; "1.3 Component contracts", the `src/db/types.ts` block and the `src/db/*.ts` signatures; "1.4.5", "1.4.6", "1.4.7"; "1.4.8" (only the `parked` lines of `failureStep`); "1.5 Transaction boundaries"; "2.4"; "2.5" (`ParkingRowSchema`); "4. Implementation Units / U4"; "5. AL2 Guidance". Skip everything else. |
| 4 | `contracts/crawl-run1-fixes.schema.ts` | `FailureRecord`, `PARKING_THRESHOLD`, `PARKING_COUNTED_KINDS`, `countResetOf`, `countedFailures`, `parkingKindOf`, `isParkedPlace` (lines ~81-93, ~124-131, ~216-286), `ExplicitRetrySchema` (~169). |
| 5 | `contracts/crawl-run1-fixes.schema.test.ts` | Reference only: the "Parking rules (pure)" describe (~511-594). `parkedPlacesFrom` must agree with these cases. |
| 6 | `contracts/hydration.schema.ts` | `MomentSchema` / `toMoment`, `ItemFailureKindSchema`, `FailedItemSchema`, `PlacesDueInputSchema` (~766), `PlacesDueValueSchema` (~800), `CrawlStore` (~894), `isInsideBoundingBox` (~913). |
| 7 | `contracts/storage.schema.ts`, `contracts/storage.support.ts` | `StoreFailure`, `WriteHook`; `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`. |
| 8 | `contracts/crawl-run1-fixes.test.ts` | Reference only: AC-29 .. AC-38 (~1242-1447) and AC-42 (~1595-1608). They show the scenarios your store side must support. Do not expect them to pass in U4. |
| 9 | `src/db/parking.ts` | **New file** (does not exist yet). |
| 10 | `src/db/failure-records.ts` | File to change (`parked` flag in `failureStep`). |
| 11 | `src/db/crawl-progress.ts` | File to change (`beginRunStep`, lines ~256-340). Note `createWriter`, the write order and both `started` returns. |
| 12 | `src/db/places-due.ts` | File to change (`excludePlaceIds`). Its R1 Centre Point filter is also the bbox filter for the parking read. |
| 13 | `src/db/crawl-repository.ts` | File to change (`listPlacesDue`, `listParkedPlaces`, `regionTotals`, `countPlacesDue` adapter). Note `guarded`, `unchecked`, `failureFor`. |
| 14 | `src/db/crawl-store.ts` | File to change (`listPlacesDueForDetails`). Note `guarded`, `readFailure`. |
| 15 | `src/db/rows.ts`, `src/db/types.ts` | Files to change (`ParkingRowSchema`; the U4 types). |
| 16 | `src/db/place-store.ts` (only `READ_TRANSACTION_CONFIG`, line ~49), `src/db/crawl-tables.ts`, `src/db/writer.ts`, `src/db/failures.ts`, `src/db/validate.ts` | Read only. |
| 17 | `src/crawl/run-crawl.ts` | Read only, except for the single permitted edit in section 2.2 step 9. |
| 18 | `tests/db/places-due.db.test.ts` | Test file to update. Reuse `summary`, `seedSummaries`, `seedDetails`, `seedR1`, `CUTOFF`. |
| 19 | `tests/db/crawl-repository.db.test.ts` | Test file to update. Reuse `openRepo`, `beginInput`, `startRun`, `failureRecordFor`, `failureResult`, `recorder`, `expectNoSecrets`, `everyCall` (~1181), group F. |
| 20 | `tests/db/failure-records.db.test.ts`, `tests/db/crawl-store.db.test.ts` | Test files to update (the `parked` expectations, the `beginRun` input, the due-list exclusion). |
| 21 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read anything under `src/wikimapia/`, the rest of `src/crawl/`, the AL6 document, the migrations, or the save paths (`save-details.ts`, `save-listing.ts`, `plan.ts`). U4 touches none of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

All DB tests run against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Empty the store (`createSchemaSetup(...).emptyStore()`) before each test. Close every repository, store, `SchemaSetup` and `Knex` handle. All data is synthetic. Seed Places through the Place Store, as `places-due.db.test.ts` does (`seedSummaries`, `seedDetails`). Seed Runs through `beginRun` and Failure Records through `recordItemFailure`. **The parking read joins `places`, so a Place that is not in `places` is never Parked. Seed the Place before you expect Parking.** Use moments in whole seconds. Use only the Knex query builder for direct row checks, never raw SQL strings. Expand AL4 U4 "Unit tests must cover" as follows.

**A. `tests/db/parking.test.ts` (new, pure, no database)**: `parkedPlacesFrom(rows)` with `ParkingRow`s built by hand.

1. Agreement with the contract. For each case of the "Parking rules (pure)" describe in `contracts/crawl-run1-fixes.schema.test.ts` (AC-29, AC-30, AC-31, AC-32, AC-33 / AC-38 reset, AC-38 same second), build the equivalent rows and assert that `parkedPlacesFrom` returns the Place exactly when `isParkedPlace` is true, with `failureKind` equal to `parkingKindOf`. Compute the expected values with the contract functions; do not hard-code a copy of the rule.
2. Reset sources. The reset is taken from `details_fetched_at_text` alone, from `released_at_text` alone, and from the later of the two when both are set (one direction each). Records strictly before the reset do not count. A record in the same second as a release counts.
3. Several Places in one row list: the result is ascending by `placeId`, and each Place is judged only on its own rows.
4. Rows of only `connection` records give no Parked Place. An empty list gives `[]`.

**B. `tests/db/parking.db.test.ts` (new)**: `selectParkingRows`, `selectParkedPlaces`, `releaseParkedPlaces` and the `parked` flag, through the repository where possible.

1. Three `wikimapia_error` records for a seeded Place (from one Run or from three Runs) park it. The first two `recordItemFailure` calls resolve `{ kind: 'recorded' }` with **no** `parked` key. The third resolves `{ kind: 'recorded', parked: { placeId, failureKind: 'wikimapia_error' } }` (AC-29). A fourth also returns `parked`, because the Place is still Parked after the record.
2. Three `connection` records do not park (AC-32). Three `invalid_data` records do. Two plus two alternating kinds do not park, and a fifth of either kind does (AC-31).
3. Listing records (`listing_page`) never park and are never returned by `selectParkingRows` (AC-34).
4. Two errors, then a Details Save with a later `fetchedAt`, then one error: not Parked (AC-33). A Place parked while Summary-Only stays Parked until it is released.
5. Scope. `selectParkedPlaces(db, { bbox })` returns only Places whose Centre Point is inside the bbox (edges included). A Parked Place outside it is absent. `{ placeId }` returns the one Place or `[]`.
6. Release through `beginRun` with `retryParked: true` (AC-37 store side). Seed Parked Places 900 and 901 inside the Region bbox and 902 outside. The started value has `placesReleased: 2`. `readExplicitRetries` returns one retry `{ runId, regionName, retriedAt: startedAt, placesReleased: 2 }`. `crawl_place_releases` has rows for 900 and 901 with `released_at` = `startedAt`, and none for 902. After the start, 900 and 901 are no longer Parked, and 902 still is.
7. After the release, new failures count again from `startedAt` (AC-38). One or two new errors do not park. The third does. The old records are still returned by `readFailureRecords`.
8. `retryParked: true` with no Parked Place keeps one retry row with `placesReleased: 0` and writes no release row. `retryParked: false` keeps no retry row and returns `placesReleased: 0`.
9. A refused start (`run_in_progress`, and separately `region_changed`) with `retryParked: true` keeps no retry row and no release row, and the Places stay Parked.
10. Write hook. With a recording hook, a `beginRun` with `retryParked: true` and 2 Parked Places makes exactly 2 more writes than the same start without the option. With 0 Parked Places it makes exactly 1 more. A hook that throws on the retry-row write rolls the whole start back: the result is `store_unavailable` without the hook's text, `postgres://` or `UNREACHABLE_PASSWORD`. There is no Run Record, no retry row and no release row, and the Places stay Parked.
11. A Place that is in two Regions' bboxes is released by a retry of either Region (AC-36).

**C. `tests/db/places-due.db.test.ts`**

1. `excludePlaceIds` omitted and `[]` give exactly the current results (keep every existing case unchanged).
2. Excluding ids removes exactly those Places. The rest keep Details Order. `limit` applies after the exclusion (excluding the first due Place with `limit: 1` returns the second). Ids that are not due or not in the bbox change nothing.
3. `countPlacesDue` with `excludePlaceIds` equals the length of the matching unlimited list and ignores `limit`.

**D. `tests/db/crawl-repository.db.test.ts`**

1. Every `beginRun` input gains `retryParked: false` (in `beginInput`). Every existing `started` expectation gains `placesReleased: 0`. Keep all other expectations unchanged, including every hydration hook numbering case.
2. Callers of `countPlacesDue` move to `regionTotals`. F.4 becomes: `regionTotals(query).placesDue` equals the length of the unlimited `listPlacesDue(query)`, and `placesParked` is 0 without failures. Add a case with one Parked Place in the bbox: `listPlacesDue` omits it, `regionTotals` gives `placesDue` one lower than without Parking and `placesParked: 1`, and `listParkedPlaces({ bbox })` returns `[{ placeId, failureKind }]`.
3. `everyCall` gains `listParkedPlaces` and `regionTotals`. Keep `countPlacesDue` while the adapter exists (section 2.2 step 7). Update the `toHaveLength(8)` assertions in F.1 and F.2 to the new count. A not-configured repository resolves the fixed not-configured message. An unreachable one resolves `store_unavailable` without secrets. An invalid `regionTotals` input (bad bbox or sub-second `dueBefore`) gives `invalid_data` without DB access, the same as `listPlacesDue`.

**E. `tests/db/failure-records.db.test.ts` and `tests/db/crawl-store.db.test.ts`**

1. Widen the U3 "never a `parked` key" schemas and helpers so that they accept `parked` as AL4 1.3 defines it. Keep every existing case that records fewer than 3 same-kind counted failures for a seeded Place asserting **no** `parked` key. If an existing case records 3 or more for a Place that is in `places`, expect `parked` on the third and later records.
2. `beginRun` inputs gain `retryParked: false`.
3. `listPlacesDueForDetails` omits a Parked Place of the input bbox. The rest keep Details Order. The result still passes `PlacesDueResultSchema`. A Region whose only due Place is Parked gives `{ places: [] }` (AC-35 store side).

Run the new and changed files once and confirm that the new cases fail only because the implementation is missing. Do not stub production modules.

### 2.2 add-coder

Implement exactly AL4 1.4.5, 1.4.6, 1.4.7, the `parked` part of 1.4.8, 2.5 (`ParkingRowSchema`) and the U4 rows of 1.1 and 1.3. **The Parking rule lives only in the contract.** Never write `count(*)`, `HAVING`, a kind list, the threshold or a reset comparison in SQL or in TypeScript. Load the inputs and call `countResetOf` + `parkingKindOf`.

1. **`src/db/rows.ts`.** Add `ParkingRowSchema` (AL4 2.5): `run_id`, `place_id` (not null), `failure_kind` (`ItemFailureKindSchema`), `message`, `failed_at_text`, `details_fetched_at_text` (nullable), `released_at_text` (nullable). Use a non-strict `z.object` and `BigintSchema`, as the existing rows do.
2. **`src/db/types.ts`.** Add `ParkingRow`, `ParkingScope`, `ReleaseInput` and `RegionTotals` exactly as in AL4 1.3. Add `excludePlaceIds?: readonly number[]` to `DueQuery`, `retryParked: boolean` to `BeginRunInput`, and `placesReleased: number` to the `started` variant of `BeginRunValue`. Add `listParkedPlaces` and `regionTotals` to `CrawlRepository`. Keep `countPlacesDue` on it (step 7). Do not re-export contract types.
3. **`src/db/parking.ts` (new, AL4 1.4.6).** It imports nothing from `crawl-progress.ts`, `failure-records.ts` or `src/crawl/`, so no import cycle is possible.
   - `selectParkingRows(db, scope)`: one parameterized statement as in the AL4 SQL. The bbox scope repeats the R1 Centre Point filter of `places-due.ts` on `p` (envelope `&&` plus inclusive lon/lat `between`), with no due cutoff. The `placeId` scope is `f.place_id = ?`. Use the `to_char(... AT TIME ZONE 'UTC', ...)` projections, `ORDER BY f.place_id, f.failed_at, f.failure_id`, constant SQL text with `?` bindings only, and table names from `CRAWL_TABLES` where you build text from constants. Parse the result with `ParkingRowSchema` (the `db.raw` result is `unknown` and is parsed on the next line).
   - `parkedPlacesFrom(rows)` (pure): group the rows by `place_id`, build the `FailureRecord[]` with `item: { kind: 'place_details', placeId }`, call `countResetOf` with `lastDetailsSaveAt` / `lastExplicitRetryAt` added by conditional spreads only when the text is not null, then call `parkingKindOf`. The result is ascending by `placeId`.
   - `selectParkedPlaces(db, scope)` = `parkedPlacesFrom(await selectParkingRows(db, scope))`.
   - `releaseParkedPlaces(trx, writer, input)`: `selectParkedPlaces(trx, { bbox })`. Then one `writer.run` insert into `CRAWL_TABLES.explicitRetries` (`run_id`, `region_name`, `retried_at = at`, `places_released`). Then, only when at least one Place is Parked, one `writer.run` multi-row insert into `CRAWL_TABLES.placeReleases` (`run_id`, `place_id`, `released_at = at`), ascending. Return the count.
4. **`src/db/failure-records.ts`.** In `failureStep`, after the insert and inside the same transaction, a `place_details` record runs `selectParkedPlaces(trx, { placeId })`. When it finds the Place, return `{ kind: 'recorded', parked }`. Otherwise return `{ kind: 'recorded' }`, with no `undefined` key. Listing records return `{ kind: 'recorded' }` as before. The write count stays one.
5. **`src/db/crawl-progress.ts`.** In `beginRunStep`, right after the Run Record insert and before the pass handling, when `input.retryParked` is true: `placesReleased = await releaseParkedPlaces(trx, writer, { runId, regionName: input.regionName, bbox: input.bbox, at: input.startedAt })`. Otherwise `placesReleased` is 0. Add `placesReleased` to **both** `started` returns. Refused starts return before this point and write nothing. Change nothing else in the file.
6. **`src/db/places-due.ts`.** Add the constant fragment `and not (place_id = any(?::bigint[]))` to `DUE_FILTER_SQL` and bind `excludePlaceIds ?? []` as a JS array in the right position, so that both the select and the count use it. `countPlacesDue` takes a `DueQuery` and ignores `limit`. Order and limit are unchanged. Never interpolate ids.
7. **`src/db/crawl-repository.ts`.**
   - `listPlacesDue(query)`: one READ COMMITTED transaction that runs `selectParkedPlaces(trx, { bbox })`, then `selectPlacesDue(trx, { ...validated, limit (conditional spread), excludePlaceIds })`.
   - `regionTotals(input)`: validated with `validatePlacesDueInput`. One transaction with `READ_TRANSACTION_CONFIG` (REPEATABLE READ, read only): parked = `selectParkedPlaces`, `placesDue = countPlacesDue(trx, { ...value, excludePlaceIds })`, `placesParked = parked.length`.
   - `listParkedPlaces({ bbox })`: one read with `selectParkedPlaces(conn, { bbox })`, and the input passed through `unchecked`, as `beginRun` does.
   - Keep `countPlacesDue` as a **thin adapter** that resolves `regionTotals(...)`'s `placesDue`, with a comment saying it is removed in U6 (AL4 U4 "Done when"). It exists only because `src/crawl/run-crawl.ts` still calls it.
   - Map every failure with `failureFor(...)` and a fixed action name. Never copy error text.
8. **`src/db/crawl-store.ts`.** `listPlacesDueForDetails`: one transaction with `READ_TRANSACTION_CONFIG` that runs `selectParkedPlaces(trx, { bbox })`, then `selectPlacesDue(trx, { bbox, dueBefore, excludePlaceIds })` with no limit. Gate the result with `PlacesDueValueSchema` as now. Nothing else changes.
9. **Single permitted edit outside `src/db/`:** in `src/crawl/run-crawl.ts`, add `retryParked: false` to the object passed to `repo.beginRun(...)`. That is the only change, and it keeps the current behaviour (U6 replaces it with `run.retryParked`). Make no other edit in `src/crawl/` or `tests/crawl/`. If any other `src/crawl/` or `tests/crawl/` file stops compiling because of the type changes, stop and report it.
10. Do not change `src/wikimapia/`, `scripts/`, `package.json`, the migrations, `schema-setup.ts`, `validate.ts`, `inspect.ts` or the save paths.
11. **Stop and report, do not work around:** a contract type or test that contradicts AL4 1.4.5 .. 1.4.7; a hydration contract case (AC-28 .. AC-34) that changes behaviour; a need to put the parking rule in SQL.
12. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. **Use the Test Database only.** Do not migrate, write to or set `DATABASE_URL` for the Development Database.

Before you change any file, record a baseline: `pnpm exec vitest run --no-color tests/crawl` (note the failing test names; the 2 known `tests/crawl/report.test.ts` failures belong to U5).

1. `pnpm exec vitest run --no-color tests/db/parking.test.ts tests/db/parking.db.test.ts tests/db/places-due.db.test.ts tests/db/crawl-repository.db.test.ts tests/db/failure-records.db.test.ts tests/db/crawl-store.db.test.ts` passes (no failures, no skipped or todo tests).
2. `pnpm exec vitest run --no-color tests/db tests/wikimapia` passes.
3. Contract regression: `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
4. `pnpm exec vitest run --no-color contracts/hydration.test.ts -t "^AC-(2[89]|3[0-4]|5[5-7]) "` passes (R1 behaviour is unchanged without Parked Places, and the schema steps still work).
5. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-([1-5]|[7-9]|1[0-4]|41 .*the newest step) "` passes (the U1 cases and the first AC-41 case stay green). AC-29 .. AC-38 and AC-42 need the Run (U6) and stay red. That is expected.
6. `pnpm exec vitest run --no-color tests/crawl` shows no failure beyond the baseline.
7. `pnpm exec eslint src/db tests/db src/crawl/run-crawl.ts` reports no problems.
8. `pnpm exec tsc --noEmit` reports **exactly** two errors: `src/crawl/requests.ts:65` and `tests/crawl/report.test.ts:38`. Any other error is yours.
9. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/db/parking.ts, src/db/places-due.ts, src/db/failure-records.ts, src/db/crawl-progress.ts, src/db/crawl-repository.ts, src/db/crawl-store.ts -Pattern "having|PARKING_THRESHOLD|>= *3|'wikimapia_error'|'connection'"` (the rule is applied only through `parkingKindOf` / `countResetOf`)
   - `Select-String -Path src/db/parking.ts, src/db/failure-records.ts -Pattern "\.update\(|\.del\(|\.delete\(|from '\.\./crawl"` (append-only, no import from `src/crawl/`)
   - `Select-String -Path src/db/parking.ts, src/db/places-due.ts -Pattern '\$\{'` (no interpolated SQL)

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`, the `*.support.ts` files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test or existing `tests/db` case. The only existing expectations you may change are the ones listed in 2.1 D and E (`retryParked`, `placesReleased`, `countPlacesDue` -> `regionTotals`, the `everyCall` length, `parked` acceptance).
- Files you may change: `src/db/parking.ts` (new), `src/db/rows.ts`, `src/db/types.ts`, `src/db/places-due.ts`, `src/db/failure-records.ts`, `src/db/crawl-progress.ts`, `src/db/crawl-repository.ts`, `src/db/crawl-store.ts`, `src/crawl/run-crawl.ts` (only the edit in 2.2 step 9), and the tests `tests/db/parking.test.ts` (new), `tests/db/parking.db.test.ts` (new), `tests/db/places-due.db.test.ts`, `tests/db/crawl-repository.db.test.ts`, `tests/db/failure-records.db.test.ts`, `tests/db/crawl-store.db.test.ts`. Nothing else.
- Never edit an applied migration. Never touch the Development Database.
- Never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.
- If a contract, the AL4 spec or this prompt looks wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing).

## 4. Out of Scope

Do not implement any of the following now:

- **U5:** everything in `src/crawl/` and `tests/crawl/` apart from the one line in 2.2 step 9: the Key Quota stop, the Wikimapia Error item message, the Gateway `stop` with `wikimapiaMessage`, `Tally.placeParked` / `parkedThisRun`, the summary lines, `oneLine`, the report builders, and the `requests.ts:65` / `report.test.ts:38` tsc errors.
- **U6:** `concludeItemFailure` (`src/crawl/failures.ts`), the phases' use of `recordItemFailure` and `listParkedPlaces`, `ResolvedRun.retryParked`, passing `run.retryParked` to `beginRun`, the progress line `Explicit retry: released ...`, end-of-run `regionTotals` with its fallback, heartbeat counts, the Dry Run with `--retry-parked`, the removal of the repository `countPlacesDue` adapter, and turning AC-29 .. AC-38 and AC-42 green end to end.
- **U7:** the `--retry-parked` command flag, the Dry Run output line, the whole-suite check.
- Any Development Database migration or write.
