# AL3 Routing: crawl-run1-fixes, U6 "The Run: Failure Records, Parking, Explicit Retry, Dry Run count"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U6 of 7 (attempt 1). Depends on U4 and U5. U1 .. U5 are done (routing prompts `docs/al3-routing/20261022-crawl-run1-fixes-0{1..5}-*-al3.md`).
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section "4. Implementation Units", "U6. The Run: Failure Records, Parking, Explicit Retry, Dry Run count"
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2)
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `pnpm exec tsc --noEmit`: 0 errors. `pnpm exec eslint src tests`: clean. All of `tests/` passes (2184 tests, including the regression contract suites). `contracts/hydration.test.ts`: 94/94.
- `contracts/crawl-run1-fixes.test.ts`: 38 pass, 24 fail. The 24 are the end-to-end Run cases. U6 turns all of them green except **AC-19, AC-40 and AC-46**, which belong to U7 (command flag and whole-file check).
- The store side is complete (U3, U4): `repo.recordItemFailure` (returns `recorded` with an optional `parked`, or `taken_over`), `repo.listParkedPlaces({ bbox })`, `repo.regionTotals({ bbox, dueBefore })`, `repo.listPlacesDue` already excludes Parked Places, and `repo.beginRun` takes `retryParked` and returns `started.placesReleased`.
- The pure crawl side is complete (U5): the `quota_exhausted` stop, `Stop.wikimapiaMessage`, `Gateway.stop(reason, message?, wikimapiaMessage?)`, `Tally.placeParked()` / `parkedThisRun`, the widened `snapshot` extras, `oneLine`, the summary lines, `buildReport({ ..., wikimapiaMessage?, parkedPlacesInRegion? })`, `plannedReport(plan, at, parkedPlacesInRegion?)`.
- **Placeholders that U6 must replace:**
  1. `src/crawl/run-crawl.ts` passes `retryParked: false` to `repo.beginRun` (~line 235).
  2. `src/crawl/run-crawl.ts` calls `repo.countPlacesDue` at Run end (~line 169). The repository adapter `countPlacesDue` (`src/db/crawl-repository.ts` ~207-215, `src/db/types.ts` ~336-337) exists only for this call. Remove it and switch to `regionTotals`.
  3. `run-crawl.ts` does not forward `gateway.stopped.wikimapiaMessage` to `buildReport`.
  4. The local `snapshot` closure in `run-crawl.ts` (~102-108) uses interim values `placesParked: tally.parkedThisRun` and a caller-supplied `placesStillDue`. U6 replaces them with the AL4 1.2 values.

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, **extensionless** relative imports, `unknown` only where `.agrules` section 5 allows it, types in `src/crawl/types.ts`, no `console`, no SQL or Knex in `src/crawl/` (`.agrules` section 3). Match the style of the existing `src/crawl/` and `tests/crawl/` files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 1 (resumable, no wasted requests), 3 (no SQL outside `src/db/`), 4 (no secrets, no live calls) and 5. |
| 2 | `CLAUDE.md` | Stack, commands, decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | The design. Read: "0. Scope and Fixed Points" (fixed-points table, "Single source of truth"); "0.1" decisions 1, 3, 4 and the "Parking" and "Places Due for Details" rows; "1.1 Module map", Crawl table; **"1.2 Run flow"** in full, including the "Heartbeat snapshots" paragraph; "1.3", the `src/crawl/types.ts` block, `concludeItemFailure`, `runDetailsPhase`, and the `CrawlRepository` interface in the `src/db/types.ts` block; **"1.4.3"** (the Run-level points); **"1.4.4"**; "1.4.5" (only to understand `placesReleased` and the moment rule); "1.4.6" last paragraph (`placesParkedThisRun` vs `placesParked`); "1.4.7" last bullet (AC-35); "1.5" (the "Region totals" and "Parked count (Dry Run)" rows); "4. Implementation Units / U6"; "5. AL2 Guidance". Skip everything else. |
| 4 | `contracts/hydration.schema.ts` | `toMoment` (~148); `CrawlRequestSchema` with `retryParked` (~359-370); `RunCountsSchema` with its `placesParkedThisRun <= placesParked` refine, `ZERO_RUN_COUNTS` (~484-540); `ITEM_FAILURE_LABELS`, `FailedItemSchema` (~615-640); `RunReportSchema` with `parkedPlacesInRegion` and its Planned-only refine (~655-695); `CRAWL_COMMAND_OPTIONS.retryParked` (~710-720). |
| 5 | `contracts/crawl-run1-fixes.schema.ts` | `PARKING_THRESHOLD` (~82), `FailureRecordSchema` / `FailureRecord` (~124-131). Never re-implement the Parking rule. |
| 6 | `contracts/crawl-run1-fixes.test.ts` | The full net. Read the harness at the top (~1-520: `crawlAt`, `crawlRuns`, `failureRecords`, `explicitRetries`, `summaryLines`, `progress`) and the cases AC-6, AC-15 .. AC-18, AC-20 .. AC-39, AC-41 (second case), AC-42. |
| 7 | `contracts/hydration.support.ts` | Test doubles (`SimulatedCrawlClock`, `CrawlWikimapia`, `scripted`, `UNREACHABLE`, `wikimapiaErrorAnswer`, `testConfiguration`, `REGION_T1`, `REGION_FAR`, `RUN_START`, `SECOND`, `HOUR`, `at`). |
| 8 | `contracts/wikimapia-client.support.ts` | `keyQuotaAnswer`, `KEY_QUOTA_BODY` (~105-130) for the quota Run tests. |
| 9 | `contracts/storage.support.ts` (only the exports `tests/crawl/run-crawl.db.test.ts` already imports) | `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`, `expectNoSecrets`-style helpers. |
| 10 | `src/crawl/types.ts` | File to change (`ResolvedRun.retryParked`, `DetailsPhaseResult`, `RunContext`). |
| 11 | `src/crawl/config.ts` | File to change (`resolveRun`, `usageMessage`). |
| 12 | `src/crawl/listing-phase.ts` | File to change (Item Failures, `takenOverMessage` moves out). |
| 13 | `src/crawl/details-phase.ts` | File to change (Item Failures, parked count at start). |
| 14 | `src/crawl/run-crawl.ts` | File to change (1.2 steps 2, 5, 9, 10; heartbeat snapshot). |
| 15 | `src/crawl/failures.ts` | **New** file (`concludeItemFailure`, `takenOverMessage`). |
| 16 | `src/crawl/report.ts`, `src/crawl/gateway.ts`, `src/crawl/requests.ts` | Read only (U5 output you call). |
| 17 | `src/db/types.ts` (~236-340) and `src/db/crawl-repository.ts` (~110-225) | Read the repository API. The **only** permitted edit is removing the `countPlacesDue` adapter (section 2.2 step 7). |
| 18 | `tests/crawl/run-crawl.db.test.ts` | Test file to extend. Reuse its harness (`startCrawl`, `crawlRegion`, `exactScenario`, `emptyAll`, `progress`, `read`, `storedCounts`, `AC51_COUNTS`). |
| 19 | `tests/crawl/config.test.ts` | Test file to extend (the `resolveRun` describe, and the `usageMessage` literal at ~312-317). |
| 20 | `tests/db/crawl-repository.db.test.ts` | Test file with the adapter's callers: `DueCountResultSchema` (~183), `everyCall` entry (~1230-1231), the two `toHaveLength(10)` (~1248, ~1264), F.5 assertion (~1405-1408), header comment (~25-30). |
| 21 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read `src/wikimapia/`, the other `src/db/` files, the migrations, the AL6 document or `src/crawl/command.ts`. U6 changes none of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

**Line endings:** every file you create or change must keep **LF** line endings. A previous coder rewrote files as CRLF. Do not rewrite whole files with a tool that converts line endings. Check with the guard in 2.3 step 9.

## 2. Execution Directives

### 2.1 add-test-writer

All DB tests run against the **Test Database** only (`requireTestDatabaseUrl()`, as in the existing file), with `SimulatedCrawlClock`, `CrawlWikimapia` (scripted, recorded fixtures), `testConfiguration(...)` and `TEST_API_KEY`. Global `fetch` stays a rejecting spy. Read Failure Records and Explicit Retries only through `createCrawlStore(...).readFailureRecords` / `readExplicitRetries`, and Run Records through `readCrawlProgress`. Parse every report with `RunReportSchema`. The contract file is the full net, so write a focused subset. Expand AL4 U6 "Unit tests must cover" as follows.

**A. `tests/crawl/run-crawl.db.test.ts`: Failure Records (AL4 1.4.4)**

1. A Run with one Wikimapia Error for a Place (e.g. the existing `exactScenario` with 164369) keeps exactly one Failure Record: `runId` = the report's `runId`, item `{ kind: 'place_details', placeId }`, kind `wikimapia_error`, `message` strictly equal to `report.itemFailures[0].message` (which now contains `Invalid API key.`), and `failedAt` = the simulated receive moment of that request. The AC-51 counts are unchanged.
2. A Listing Page failure (`listing: { 1: [wikimapiaErrorAnswer()], ... }`) keeps one record with `{ kind: 'listing_page', tileNumber: 1, page: 1 }`. The Run continues with the next Tile.
3. A Connection Failure with its back-off tries keeps exactly one `connection` record, at the moment of the last try.
4. When the Failure Record write fails (an `onWrite` that throws once a flag is set by the failing answer's `effect`, as in contract AC-28): the Run ends `failed`, `report.itemFailures` is empty and `itemFailures` is 0, no record exists for the Place, no further Wikimapia request is sent, and the hook's text (with the connection URL) appears in neither the report nor the progress lines.
5. No record is kept for a Run that stops for Rate Limit Exhausted, Key Quota, budget, interrupt, or for a Dry Run.

**B. Parking end to end (AL4 1.2 step 9, 1.4.6 last paragraph, 1.4.7)**

1. Three Runs in which Place 900 fails with a Wikimapia Error: the first two report `placesParkedThisRun` 0 and `placesParked` 0. The third reports `placesParkedThisRun` 1, `placesParked` 1 and `placesStillDue` 0, and its progress lines contain `Place 900: parked after 3 failures (<ITEM_FAILURE_LABELS.wikimapia_error>)` (build the expected line from the contract constants). A fourth Run sends no `place.getbyid` request for 900.
2. A Region whose only due Place is Parked: no details request, outcome `completed`, `placesStillDue` 0, `placesParked` 1.
3. The Run Record of each Run (`readCrawlProgress`) holds counts strictly equal to the report's counts.

**C. Explicit Retry through `runCrawl` (AL4 1.2 step 5)**

1. After B.1, a Run with `request.retryParked: true` reports `placesReleased` 1, requests 900 in Details Order among the other due Places, and keeps exactly one Explicit Retry `{ runId, regionName, retriedAt: report.summary.startedAt, placesReleased: 1 }`. Its progress lines contain `Explicit retry: released 1 parked places of region <name>`.
2. A Run with `retryParked: true` and nothing Parked reports `placesReleased` 0 and still keeps one Explicit Retry with `placesReleased` 0.
3. A Run without the option keeps no Explicit Retry and shows no `Explicit retry:` progress line.

**D. Dry Run with the option (AL4 0.1 decision 1, 1.2 step 2)**

1. After B.1, `{ dryRun: true, retryParked: true }`: outcome `planned`, `parkedPlacesInRegion` 1, counts strictly `ZERO_RUN_COUNTS`, 0 Wikimapia calls, no Explicit Retry kept, Place 900 still Parked (a following plain Run does not request it), and no write hook call (pass an `onWrite` spy and expect 0 calls).
2. `{ dryRun: true, retryParked: true }` with `connectionString: UNREACHABLE_DATABASE_URL`: outcome `failed`, a message, no `UNREACHABLE_PASSWORD` and no `postgres://` in the report or progress lines.
3. `{ dryRun: true }` without the option and with `connectionString: UNREACHABLE_DATABASE_URL` (and with an empty `connectionString`): outcome `planned`, no `parkedPlacesInRegion` key. This proves no database is opened.
4. A Dry Run with the option needs no API Key (no `apiKey` given still gives `planned`).

**E. Key Quota Run (AL4 1.4.3, 1.2 step 10)**

1. A Details Phase answered by `keyQuotaAnswer()`: outcome `quota_exhausted`, `report.message` contains `Key limit has been reached` and never `TEST_API_KEY`, `summaryText` ends with `Wikimapia message: Key limit has been reached` (label from `SUMMARY_LABELS.wikimapiaMessage`), the Run Record has status `quota_exhausted` and an `endedAt`, the progress lines contain `Stopping: <OUTCOME_LABELS.quota_exhausted>`, and no Failure Record is kept.
2. A completed Run's `summaryText` has no `Wikimapia message` line.

**F. Run end fallback (AL4 1.2 step 9 `!ok` branch)** — optional, only if it can be provoked through the public harness without editing production code (e.g. a store that becomes unreachable only after the Details Phase is not possible with `onWrite`, since `regionTotals` writes nothing). If it cannot be provoked, skip it; do not stub production modules.

**G. `tests/crawl/config.test.ts`**

1. `resolveRun`: `retryParked` is `false` when absent, `true` when given, `false` when given as `false`. It combines with `dryRun`, `relist` and `requestBudget`.
2. Update the `usageMessage` literal (~315) so `[--retry-parked]` follows `[--relist]`. Build that token from `CRAWL_COMMAND_OPTIONS.retryParked`. This is the only existing expectation in this file you may change.

**H. `tests/db/crawl-repository.db.test.ts` (adapter removal only)**

Remove the `countPlacesDue` entry from `everyCall`, change the two `toHaveLength(10)` to `9`, delete the F.5 adapter assertion (~1405-1408) and `DueCountResultSchema` if it becomes unused, and update the header comment ("the adapter stays until U6" becomes "U6 removed it"). Change nothing else in this file.

Run the new and changed files once and confirm that the new cases fail only because the implementation is missing. Do not stub production modules.

### 2.2 add-coder

Implement exactly AL4 1.2, 1.4.4 and the Run-level points of 1.4.3, using the U6 rows of 1.1 and 1.3. Use only contract labels and constants; never retype a label text, the threshold, or a kind list. Never decide Parking in `src/crawl/`: the store's `parked` flag and `listParkedPlaces` / `regionTotals` are the only sources.

1. **`src/crawl/types.ts`.** `ResolvedRun` gains `retryParked: boolean`. Add `DetailsPhaseResult { dueLoaded: number; parkedAtStart: number }`. Add to `RunContext` a mutable field `parkedAtDetailsStart: number` (initially 0), so the heartbeat can show the AL4 1.2 interim value while the Details Phase runs (see step 6). Update the file header comment.
2. **`src/crawl/config.ts`.** `resolveRun` sets `retryParked: r.data.retryParked === true`. `usageMessage` lists `[${CRAWL_COMMAND_OPTIONS.retryParked}]` right after `[--relist]`. Nothing else changes.
3. **`src/crawl/failures.ts` (new).** Move `takenOverMessage` here from `listing-phase.ts` unchanged (this avoids an import cycle between `failures.ts` and `listing-phase.ts`; update the imports in `listing-phase.ts` and `run-crawl.ts`). Implement `concludeItemFailure(ctx, item, failureKind, message): Promise<boolean>` exactly as the AL4 1.4.4 pseudo-code:
   - `failedAt = toMoment(ctx.clock.now())` as the **first** statement, before any `await`.
   - `ctx.repo.recordItemFailure({ runId: ctx.runId, item, failureKind, message, failedAt })`.
   - `!r.ok` (any failure kind, including `invalid_data`): `ctx.gateway.stop('failed', r.failure.message)`, return `false`. Not tallied, no progress line.
   - `taken_over`: `ctx.gateway.stop('failed', takenOverMessage(ctx.run.regionName))`, return `false`.
   - Otherwise `ctx.tally.itemFailure(item, failureKind, message)`, `ctx.progress(\`Item failure: ${message}\`)`. When `r.value.parked` is present: `ctx.tally.placeParked()` and `ctx.progress(\`Place ${id}: parked after ${PARKING_THRESHOLD} failures (${ITEM_FAILURE_LABELS[parked.failureKind]})\`)`. Return `true`.
   - Never copy store or error text other than `r.failure.message` (already sanitized by the repository).
4. **`src/crawl/listing-phase.ts`.** Both Item Failure sites (Client failure, `invalid_data` page rejection) call `concludeItemFailure` with the same item and message as today. `true` means `break` (next Tile); `false` means `return`. The phases call it directly after the failing call returns, with no other `await` in between.
5. **`src/crawl/details-phase.ts`.** Return `DetailsPhaseResult`.
   - After a successful `repo.listPlacesDue`, call `repo.listParkedPlaces({ bbox: run.region.bbox })`. On success set `ctx.parkedAtDetailsStart` and `parkedAtStart` to its length. On failure, treat it like a failed due list: `gateway.stop('failed', failure.message)` and return `{ dueLoaded: 0, parkedAtStart: 0 }` (routing decision: AL4 does not name this case; a store that cannot answer this read cannot answer the due list either).
   - Both Item Failure sites (Client failure, `invalid_data` save rejection) call `concludeItemFailure`. `true` means `continue`; `false` means `break`.
6. **`src/crawl/run-crawl.ts`.** Follow AL4 1.2:
   - **Step 2.** `run.dryRun && !run.retryParked`: `plannedReport(run.plan, startedAt)` as today (no database). `run.dryRun && run.retryParked`: open `openCrawlRepository({ connectionString: deps.connectionString })` **without** the hook; in `try`, `p = await repo.listParkedPlaces({ bbox: run.region.bbox })`; `!p.ok` gives `failedReport(p.failure.message, run.regionName, startedAt)`; otherwise `plannedReport(run.plan, startedAt, p.value.length)`; `finally await repo.close()`. No API Key check on this path.
   - **Step 5.** Pass `retryParked: run.retryParked` to `repo.beginRun`. After the `Run N started ...` line, when `run.retryParked` is true, print `Explicit retry: released ${n} parked places of region ${run.regionName}` with `n = value.placesReleased`.
   - **Heartbeat snapshot.** Interim values: `placesStillDue: 0`, `placesParked: ctx.parkedAtDetailsStart + tally.parkedThisRun` (0 before the Details Phase), `placesReleased: started.placesReleased`. Use a holder so the closure sees the context once it exists.
   - **Step 9.** `t = await repo.regionTotals({ bbox: run.region.bbox, dueBefore })`. `t.ok`: `placesStillDue = t.value.placesDue`, `placesParked = Math.max(t.value.placesParked, tally.parkedThisRun)`. `!t.ok`: `placesStillDue = Math.max(0, dueLoaded - detailsSaved)`, `placesParked = parkedAtStart + tally.parkedThisRun`. Then `counts = tally.snapshot(gateway.counts(), { tilesUnfinished, placesStillDue, placesParked, placesReleased: started.placesReleased })`. `finishRun` and its failure path are unchanged.
   - **Step 10.** Pass `wikimapiaMessage: stopped.wikimapiaMessage` to `buildReport` (conditional spread) only when the **final** outcome is `quota_exhausted` and the message is defined. If `finishRun` turned the outcome into `failed`, pass nothing.
   - Update the header comment.
7. **Adapter removal (the only `src/db/` edit).** Delete the `countPlacesDue` member from the `CrawlRepository` interface in `src/db/types.ts` (~336-337) and its implementation and comment in `src/db/crawl-repository.ts` (~207-215). Keep the `countPlacesDue` **SQL function** in `src/db/places-due.ts` and its import in `crawl-repository.ts` (`totalsOf` uses it). Nothing else in `src/db/` changes.
8. Do not change `src/crawl/report.ts`, `gateway.ts`, `requests.ts`, `command.ts`, `src/wikimapia/`, `scripts/` or `package.json`. If any of them seems to need a change, stop and report it.
9. **Stop and report, do not work around:** a contract case of the U6 set that contradicts AL4 1.2 or 1.4.4; an existing `tests/` or `contracts/hydration.test.ts` case that breaks because an Item Failure now writes a Failure Record (e.g. a write-hook numbering assumption); any need to edit `contracts/`.
10. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. **Use the Test Database only.** Never migrate or write the Development Database, never run `pnpm db:migrate` or `pnpm crawl`, and never set `DATABASE_URL`.

Before you change any file, record two baselines: `pnpm exec vitest run --no-color tests` (all pass) and `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts` (38 pass / 24 fail; note the names).

1. `pnpm exec vitest run --no-color tests/crawl tests/db` passes (no failures, no skipped or todo tests).
2. `pnpm exec vitest run --no-color tests` passes (all of `tests/`).
3. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-([1-9]|1[0-8]|[23][0-9]|4[12]) "` passes. This is every case except AC-19, AC-40 and AC-46: AC-1 .. AC-5 and AC-7 .. AC-14 (U1), AC-41 first case (U2) and AC-39 Dry Run (U5) stay green; **AC-6, AC-15 .. AC-18, AC-20 .. AC-39, AC-41 second case and AC-42 turn green in U6.**
4. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts` (whole file): the only failures allowed are in **AC-19** (Crawl Command exit status), **AC-40** (`--retry-parked` command option) and **AC-46** (whole-file network check). They stay red for U7. List the failing test names in your report.
5. `pnpm exec vitest run --no-color contracts/hydration.test.ts` passes: **94/94**, all green.
6. Contract regression: `pnpm exec vitest run --no-color contracts/hydration.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/storage.test.ts contracts/storage.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
7. `pnpm exec eslint src tests` reports no problems.
8. `pnpm exec tsc --noEmit` reports **0 errors**.
9. Guards. Each returns nothing (or `False` for the line-ending check):
   - `Select-String -Path src/crawl/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/crawl/*.ts -Pattern "knex|\.raw\(|SELECT |INSERT |count\(\*\)"` (no SQL in the crawl)
   - `Select-String -Path src/crawl/*.ts, src/db/types.ts, src/db/crawl-repository.ts -Pattern "repo\.countPlacesDue|countPlacesDue\(input|retryParked: false"` (placeholders gone)
   - `Select-String -Path src/crawl/*.ts -Pattern "'Places parked|'Wikimapia message|parked after 3"` (labels and the threshold come from the contracts)
   - Line endings: `foreach ($f in 'src/crawl/types.ts','src/crawl/config.ts','src/crawl/failures.ts','src/crawl/listing-phase.ts','src/crawl/details-phase.ts','src/crawl/run-crawl.ts','src/db/types.ts','src/db/crawl-repository.ts','tests/crawl/run-crawl.db.test.ts','tests/crawl/config.test.ts','tests/db/crawl-repository.db.test.ts') { "$f " + ((Get-Content -Raw $f) -match "`r") }` prints `False` for every file.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`, the `*.support.ts` files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test or existing `tests/` case. The only existing expectations you may change are the `usageMessage` literal (2.1 G.2) and the adapter cases in `tests/db/crawl-repository.db.test.ts` (2.1 H).
- Files you may change: `src/crawl/types.ts`, `src/crawl/config.ts`, `src/crawl/failures.ts` (new), `src/crawl/listing-phase.ts`, `src/crawl/details-phase.ts`, `src/crawl/run-crawl.ts`, `src/db/types.ts` and `src/db/crawl-repository.ts` (adapter removal only), and the tests `tests/crawl/run-crawl.db.test.ts`, `tests/crawl/config.test.ts`, `tests/db/crawl-repository.db.test.ts` (2.1 H only). Nothing else.
- Keep LF line endings in every file you touch.
- Use the Test Database only. Never migrate or write the Development Database, and never set `DATABASE_URL`.
- Never open, write or print `.env`. Never put a real API key, password or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.
- If a contract, the AL4 spec or this prompt looks wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing).

## 4. Out of Scope

Do not implement any of the following now:

- **U7:** the `--retry-parked` flag in `parseCrawlArgs` / `FLAG_OPTIONS` (`src/crawl/command.ts`), the Dry Run output line `Parked places that --retry-parked would release: n` in `writeReport`, `tests/crawl/command.test.ts` and `tests/crawl/command.db.test.ts`, turning AC-19, AC-40 and AC-46 green, the whole-suite run, `pnpm lint`, and the Development Database checks (`pnpm crawl --dry-run --retry-parked`).
- Any change to the store side (U2 .. U4): Parking SQL, `failureStep`, `beginRunStep`, releases, `regionTotals`, `listParkedPlaces`, migrations, `emptyStore`. Only the adapter removal of 2.2 step 7 is allowed.
- Any change to the pure crawl parts (U5): `report.ts`, `gateway.ts`, `requests.ts`, summary lines, item message rules.
- Anything in `src/wikimapia/` (U1).
- Any Development Database migration or write.
