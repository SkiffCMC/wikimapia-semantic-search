# AL3 Routing: hydration, U4 "Crawl repository: write steps of a Run"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U4 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md`, section "4. Implementation Units", "U4".
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **U1 is done and verified:** the Schema Setup step `20261022_01_create_crawl_progress`, `src/db/crawl-tables.ts` (`CRAWL_TABLES`, `CRAWL_REGION_LOCK_CLASS`), `undoLast()` and the extended `emptyStore()`.
- **U2 is done and verified:** `src/crawl/types.ts`, `tile-plan.ts`, `config.ts`, `report.ts`. This unit does not touch `src/crawl/`.
- **U3 is done and verified:**
  - the crawl row schemas in `src/db/rows.ts`, including `IdRowSchema` for `nextval`;
  - the row types, `PassState`, `CurrentPass` and `DueQuery` in `src/db/types.ts`;
  - `validatePlacesDueInput` and `validateCrawlProgressInput`;
  - `src/db/places-due.ts` (`selectPlacesDue`, `countPlacesDue`);
  - `src/db/crawl-progress.ts` with `readProgressView` and the exported `readCurrentPass(trx, regionName)`;
  - the public `src/db/crawl-store.ts`.
- **Baseline:** `pnpm exec tsc --noEmit` reports exactly 2 TS2307 errors, both in `contracts/hydration.test.ts`, for `src/crawl/command` and `src/crawl/run-crawl`. Both stay until U6 and U7. `pnpm exec eslint src tests` is clean. Do not create stubs for `command` or `run-crawl`.
- **What this unit adds:** the **write side** of Crawl Progress, plus the internal repository that `src/crawl/` will use in U6. The repository is not a public entry point, and no contract test imports it. All SQL stays in `src/db/` and uses bindings only.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:

- Node ESM; TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Top-level `import type`. Relative imports have no file extension.
- `unknown` only where `.agrules` 5 allows it.
- Every type alias or interface in `src/db/` goes in `src/db/types.ts`.
- No `console`. Vitest globals are on.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 1 (idempotent, resumable), 2, 3, 4 and 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read only these parts: "0. Scope and Fixed Points" (the table, "Single source of truth", "Code style"); "0.1" (row "Write-hook numbering"); "1.1 Module map" (rows `crawl-progress.ts`, `save-listing.ts`, `crawl-repository.ts`); "1.3 Component contracts" (the `src/db/types.ts` block from `BeginRunInput` to `CrawlRepository`, the `writeListingPage`, `*Step` and `openCrawlRepository` signatures, and the paragraph under the code block); "1.4.5 Run start"; "1.4.6", from "`listingPageStep(db, input, hook)`" to the end of its bullet list; "1.4.7", only the last paragraph ("The details Place Store call ..."); "1.4.8", only the `finishRun` bullet; "1.4.9 Write hook and store failures"; "1.5 Transaction boundaries"; "2.1" to "2.4"; "4. Implementation Units", "U4"; "5. AL2 Guidance" (bullets "Never copy error messages", "Close every pool", "No transaction across waits", "`exactOptionalPropertyTypes`", "Imports", "`unknown`", "Do not edit `contracts/`"). |
| 4 | `contracts/hydration.schema.ts` | Lines 100 to 170 (`COORDINATE_TOLERANCE`, `ABANDONMENT_AGE_SECONDS`, `MomentSchema`, `toMoment`, `RegionNameSchema`, `RunIdSchema`, `TileSizeSchema`); `RunCountsSchema`, `RunCounts`, `ZERO_RUN_COUNTS` (lines 467 to 530); `RunOutcomeSchema` (line 409); `PlacesDueInput`, `DuePlace` (lines 715 to 735); `RunRecordStatusSchema`, `RunRecordSchema`, `CrawlProgressViewSchema` and the Crawl Store result schemas (lines 800 to 861). |
| 5 | `contracts/storage.schema.ts` | `WriteHook` (lines 125 to 136, read its doc comment), `SaveListingPageInput` (line 149), `SavePlaceDetailsInput` (line 214), `SaveReportSchema` (line 242), `StoreConfigSchema` (line 120), the failure schemas and `storeResultSchema` (lines 474 to 505). |
| 6 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`, `clientListing`, `clientDetails`, `listingOf`, `summaryOf`. |
| 7 | `contracts/hydration.support.ts` | Only `RUN_START` (line 41) and the "Test Regions" block (lines 432 to 477). |
| 8 | `contracts/hydration.test.ts` | Read only. Lines 809 to 854 (AC-14: the hook number must be Run-wide), 1091 to 1112 (AC-25), 2127 to 2194 (AC-62, AC-69). These are the end-to-end checks this repository must support later (they run in U7). Do not run this file. |
| 9 | `src/db/save-listing.ts` | File to refactor (extract `writeListingPage`). |
| 10 | `src/db/save-details.ts` | Lines 61 to 72 only: the `saveDetails(db, input, onWrite)` signature. Do not modify it. |
| 11 | `src/db/crawl-progress.ts` | File to extend. Reuse `readCurrentPass`, `PASS_COLUMNS` and the `to_char` moment form. |
| 12 | `src/db/types.ts` | File to extend (`StoreResult`, `Validated`, `Writer`, `PassState`, `CurrentPass`, `DueQuery`). |
| 13 | `src/db/rows.ts` | Lines 120 to 181: the crawl row schemas, including `IdRowSchema` and `RunRowSchema`. Use them; do not change them unless a new read shape needs a new schema. |
| 14 | `src/db/writer.ts` | `createWriter`: numbers writes per Writer and awaits the hook after each statement. Do not modify it. |
| 15 | `src/db/crawl-store.ts` | The factory pattern to copy (`openDb`, `guarded`, `fail`, fixed messages). Do not modify it. |
| 16 | `src/db/connection.ts`, `src/db/failures.ts` | `createDb`, `destroyQuietly`, `POOL_MAX_STORE`, `POOL_MAX_SETUP`; `storeUnavailable`, `unavailableFrom`, `invalidData`. |
| 17 | `src/db/validate.ts` | Signatures of `validateListingInput`, `validateDetailsInput` and `validatePlacesDueInput` only. Do not modify it. |
| 18 | `src/db/places-due.ts` | Signatures of `selectPlacesDue` and `countPlacesDue`. Do not modify it. |
| 19 | `src/db/crawl-tables.ts`, `src/db/migrations/20261022_01_create_crawl_progress.ts` | Table names, lock class, and the exact columns and CHECKs. |
| 20 | `tests/db/crawl-store.db.test.ts` | Lines 1 to 160 only: header comment, imports, the lifecycle (`beforeAll`, `beforeEach`, `afterEach`, `afterAll`, `testDb()`), and the `progress` helper. Copy this pattern. |
| 21 | `tests/db/listing.db.test.ts` | Lines 1 to 80 and lines 160 to 180: the lifecycle and how `box-belgrade-page1.json` is loaded. It is the regression net for the extraction. Do not modify it. |

Do not read the rest of `src/db/` (mappers, plan, read, models, geometry, schema-setup, inspect), `src/crawl/` or `src/wikimapia/`. This unit does not need them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

Write one new file: `tests/db/crawl-repository.db.test.ts`. Its subject is `openCrawlRepository` from `src/db/crawl-repository`. You may also call the four `*Step` functions directly where a case needs it (cases F and G).

Ground rules:

- **Database:** the Test Database only (`requireTestDatabaseUrl()`). In `beforeAll`, apply Schema Setup. In `beforeEach`, call `emptyStore()`. In `afterEach`/`afterAll`, close every repository, store, setup and Knex handle.
- **Observing state:** read it through the public stores only:
  - Crawl Progress: `createCrawlStore(...).readCrawlProgress`, parsed with `CrawlProgressResultSchema`;
  - Place counts: `createPlaceStore(...).countStored`.
- **Seeding:** create all state through the repository itself. Pass `startedAt` and `abandonBefore` explicitly to create old or live Runs. Use the Knex builder on a `testDb()` handle only if a case cannot be reached through the repository; write no raw SQL.
- **Parsing results:**
  - every `StoreResult` with `storeResultSchema(...)` or the contract failure schemas before asserting;
  - every `SaveReport` with `SaveReportSchema`;
  - every view with `CrawlProgressViewSchema`.
- **Data:**
  - Listing data: `clientListing('box-belgrade-page1.json')` (3 Places) and `'box-belgrade-empty-page.json'`, or small synthetic pages built with `listingOf`/`summaryOf`.
  - Details: `clientDetails('getbyid-62587.json')`.
  - Moments: fixed whole-second text only (`RUN_START` and literals). Counts: `ZERO_RUN_COUNTS` and one non-zero variant that passes `RunCountsSchema`.
  - Regions: the test Regions or literal names such as `test-one`.
- **Helper:** build `BeginRunInput` with one helper, defaulting to bbox `SMALL_BBOX`, tile size `{ width: 0.005, height: 0.005 }`, `tileCount` 1, `relist: false`, `startedAt` `RUN_START`, `abandonBefore` = `RUN_START` minus `ABANDONMENT_AGE_SECONDS`, and `ZERO_RUN_COUNTS`.

**A. Run start** (AL4 1.4.5; AC-24, AC-25, AC-53, AC-62, AC-69 store side)

1. On an empty store, `beginRun` gives `started` with a positive `runId`, `pass` = `{ passNumber: 1, tileCount, finishedTiles: [], lastFinishedPage: [] }` and `abandonedRunIds: []`.
   - The view shows one `in_progress` Run with `startedAt` = `lastActivity` = the input moment, no `endedAt`, and `counts` equal to `ZERO_RUN_COUNTS`.
   - The view shows pass 1 with the input bbox, tile size and tile count.
2. **Live Run refused.** A second `beginRun` for the same Region whose `abandonBefore` equals the first Run's Last Activity (the "exactly 1 hour" case) gives `run_in_progress` with the first `runId` and its `lastActivity`. The view before and after is `toStrictEqual`.
3. **Takeover.** The same second `beginRun` with `abandonBefore` one second later:
   - gives `started` with a new `runId` and `abandonedRunIds` = `[first runId]`;
   - the first Run is now `abandoned`, with no `endedAt`, and its `counts` and `lastActivity` unchanged (renew it first with non-zero counts so that "kept" is meaningful);
   - the new Run resumes pass 1 (same `passNumber`, no new pass).
4. **Definition changed.** Finish the first Run and leave its pass incomplete (`tileCount` 2, one short page). Then a `beginRun` with a different tile size gives `region_changed` with `passNumber` 1 and changes nothing (view and Place counts `toStrictEqual`). The same call with `relist: true` gives `started` with pass 2 carrying the new definition, and pass 1 stays in the view.
   - Also: a bbox side that differs by no more than `COORDINATE_TOLERANCE` counts as the same definition. A different `tileCount` counts as changed.
5. **Resume an incomplete pass.** After a page of Tile 1 (not short) and a short page of Tile 2 in pass 1 with `tileCount` 3, finish the Run. The next `beginRun` gives `pass` with `finishedTiles: [2]` and `lastFinishedPage: [[1, 1], [2, 1]]`.
6. **Complete pass.** With every tile finished (`tileCount` 1, one short page) and the Run finished, `beginRun` without relist gives `started` with **no** `pass` value (`pass === undefined`). With `relist: true` it gives a new pass whose `passNumber` is one higher.
7. **Regions are independent.** A live Run of `test-one` does not stop `beginRun` for `test-two`.

**B. Listing step** (AL4 1.4.6 step; AC-14, AC-20 .. AC-22 store side)

1. `recordListingPage` with the recorded Belgrade page (`short: false`, page 1, Tile 1) gives `saved`. Its `report.places` has 3 `created` outcomes. Then:
   - `countStored().places` is 3;
   - the view shows one Finished Page `{ tileNumber: 1, page: 1, runId, placeCount: 3, short: false, totalFound }` with `totalFound` equal to the page's `totalFound`;
   - Tile 1 is not in `finishedTiles`.
2. Repeating the same page (page 2, `short: true`) gives `unchanged` outcomes and no new Place. Tile 1 is now finished.
3. An empty page (`short: true`) stores no Place and exactly one Finished Page with `placeCount: 0`.
4. A page with a duplicate Place ID is deduplicated exactly as the Listing Save does (compare with `saveListing` on a separate empty store, or assert the report directly).
5. **Invalid listing.** A listing that fails `ListingPageSchema` (for example `pageSize: 0` or a Place with a bad id) resolves `invalid_data` and writes nothing: no Finished Page, no Place, hook not called.
6. **Unknown Run.** `recordListingPage` with a `runId` that does not exist resolves `taken_over` and writes nothing.

**C. Renewal and finish** (AL4 1.4.8 finish bullet, 1.5)

1. `renewActivity` on a live Run gives `{ alive: true }`. The view's `lastActivity` and `counts` equal the input, and `status` stays `in_progress`.
2. `finishRun` with each final status (`completed`, `budget_reached`, `rate_limited`, `interrupted`, `failed`) gives `{ updated: true }`. Then:
   - the view has that status, `endedAt` = the input moment, `lastActivity` = `endedAt`, and the input counts;
   - a second `finishRun` on the same Run gives `{ updated: false }` and changes nothing.
3. **Counts are checked.** Counts that fail `RunCountsSchema`, passed with a type cast **in the test only**, resolve `store_unavailable` and write nothing.

**D. Taken over** (AL4 1.4.6 bullet 2; AC-69 store side). Take over Run A with a second `beginRun` (as in A.3). Then, on Run A:

- `recordListingPage` gives `taken_over`;
- `renewActivity` gives `{ alive: false }`;
- `finishRun` gives `{ updated: false }`.

The view (`toStrictEqual` before and after) and `countStored` are unchanged, and the hook is not called by any of the three.

**E. Write hook and failures** (AL4 1.4.9; AC-14, AC-47 store side)

1. **Run-wide numbering.** Open one repository with a hook that records the numbers it receives. Run a whole sequence: `beginRun` (new pass) → `recordListingPage` (Belgrade page) → `renewActivity` → `saveDetails` (62587) → `finishRun`. The recorded numbers are exactly `1, 2, ..., n` with no gap and no restart, where n is the total number of writes. Also assert that n is at least 1 + 1 + 4 + 1 + 1 (Run insert, pass insert, 3 Places plus 1 Finished Page, renewal, details, finish).
2. **Failure at each write in turn.** For `failAt = 1, 2, ...`, until a pass of the loop sees no injected failure:
   - Start on an empty store. Open a repository whose hook throws `new Error('injected postgres://user:secret@host/db')` when its number equals `failAt`.
   - Run `beginRun` and then `recordListingPage(Belgrade page, short: true)`.
   - Assert all of the following:
     - The first step to hit the failure resolves `store_unavailable`. Its `JSON.stringify` contains neither `injected`, `secret` nor `postgres://`.
     - A failed `beginRun` leaves no Run Record and no pass.
     - A failed listing step leaves no Place and no Finished Page: "places stored = 3" holds exactly when "page 1 of Tile 1 is finished".
   - Over the loop you must see a failure inside `beginRun`, a failure inside the listing step before the Finished Page insert, and a failure on the Finished Page insert itself.
3. **Hook failure in renewal or finish.** A hook that throws on the renewal write leaves `lastActivity` unchanged and resolves `store_unavailable`. The same holds for `finishRun`: the Run stays `in_progress` with no `endedAt`.
4. **Hook only for writes.** A refused `beginRun` (`run_in_progress`, `region_changed`) and a `taken_over` step call the hook zero times.

**F. Repository guards** (AL4 1.4.9 bullet 3)

1. `openCrawlRepository({ connectionString: '' })`: every method resolves `store_unavailable` with the not-configured text. `close()` resolves twice.
2. `openCrawlRepository({ connectionString: UNREACHABLE_DATABASE_URL })`:
   - `beginRun`, `renewActivity`, `recordListingPage`, `saveDetails`, `listPlacesDue`, `countPlacesDue` and `finishRun` all resolve (never reject) `store_unavailable`;
   - no `JSON.stringify(failure)` contains `UNREACHABLE_PASSWORD` or `postgres://`;
   - set the timeout to 60 s.
3. `saveDetails` with invalid details resolves `invalid_data`. `listPlacesDue` and `countPlacesDue` with an invalid `dueBefore` resolve `invalid_data`. None of these touches the database (same result on the unreachable repository).
4. `listPlacesDue` with `limit: 1` returns at most one Place. `countPlacesDue` agrees with the unlimited list (seed two Summary-Only Places via `recordListingPage` inside `SMALL_BBOX`).

**G. Concurrency backstop** (AL4 1.5, lock order)

1. Two `beginRun` calls for the same Region started together with `Promise.all`, on two repositories: exactly one gives `started` and the other gives `run_in_progress`. No error, and one `in_progress` Run in the view.

**H. Regression.** `tests/db/listing.db.test.ts` and `contracts/storage.test.ts` must stay green, unchanged. They prove `saveListing` behaves as before.

Use fixed moments only. The new tests are expected to fail until `add-coder` has finished. Do not stub production modules.

### 2.2 add-coder

1. **`src/db/save-listing.ts`** (refactor, no behaviour change; AL4 1.4.6 last bullets)
   - Export `writeListingPage(trx: Knex.Transaction, places: readonly PlaceSummary[], writer: Writer): Promise<SaveReport>`. It holds the current body of the `saveListing` transaction:
     1. ascending `pg_advisory_xact_lock(?::bigint)` per distinct id;
     2. `loadListingState`;
     3. `planListingSave`;
     4. one `runListingWrite` per planned write;
     5. return `{ places: plan.outcomes }`.
   - `saveListing` becomes: `dedupeListing` → empty? `{ places: [] }` → `db.transaction(trx => writeListingPage(trx, places, createWriter(onWrite)))`.
   - Statements, their order and the write count stay identical. Update the module header comment. Change nothing else.
2. **`src/db/types.ts`** (extend). Add exactly the AL4 1.3 types:
   - `BeginRunInput`, `BeginRunValue`, `RenewInput`, `ListingStepInput`, `ListingStepValue`, `FinalRunStatus`, `FinishInput`, `CrawlRepositoryOptions`, `CrawlRepository`;
   - import `BoundingBox`, `ListingPage` and the contract `Moment`, `RunCounts`, `RunRecordStatus`, `TileSize`, `DuePlace`, `PlacesDueInput`, `SaveReport`, `SavePlaceDetailsInput`, `WriteHook` with `import type`;
   - also add a type for the `run_in_progress` live-row read if you need one (for example a row type inferred from a new row schema in `rows.ts`);
   - change no existing type.
3. **`src/db/crawl-progress.ts`** (extend with the four write steps; keep `readProgressView` and `readCurrentPass` unchanged).
   - **General rules:**
     - Each step opens its own `db.transaction(...)` (READ COMMITTED, Knex default).
     - Every write goes through one `createWriter(onWrite)` per step (`writer.run(...)`).
     - Every value is a binding, and every SQL text is a constant with no `${...}`.
     - Moments are written as the ISO text binding, and read back with the `to_char` form already in this file.
     - Counts are written as `JSON.stringify(RunCountsSchema.parse(counts))` with `?::jsonb`.
     - Raw results are typed `unknown` and parsed on the next line with a row schema.
     - Steps throw on any error and never catch.
   - **`beginRunStep(db, input, onWrite)`**: AL4 1.4.5, line by line.
     1. `select pg_advisory_xact_lock(?::int4, hashtext(?))` with `[CRAWL_REGION_LOCK_CLASS, regionName]`.
     2. The live rows: `in_progress` for the Region, ordered by `run_id`, `for update`, with `last_activity` as text.
     3. Return `run_in_progress` when one has `last_activity >= abandonBefore`. Compare as instants: either in SQL, or with `Date.parse` on both whole-second texts.
     4. Read the current pass with the existing `readCurrentPass(trx, regionName)`. Do not duplicate its query.
     5. Return `region_changed` when the pass is not relisted, incomplete, and not the same definition. "Same definition" means every bbox side and both tile sizes within `COORDINATE_TOLERANCE`, and an equal `tile_count`.
     6. Then the writes:
        - one `update ... set status = 'abandoned'` per live row (only `status` changes);
        - `select nextval(pg_get_serial_sequence('crawl_runs', 'run_id')) as id`, parsed with `IdRowSchema`;
        - the Run Record insert (`status = 'in_progress'`, `last_activity = started_at`, `counts` = `input.counts` after `RunCountsSchema.parse`; U6 passes `ZERO_RUN_COUNTS`, as AL4 1.4.5 states);
        - the pass insert when relisting or when there is no pass (`pass_number = current + 1` or 1, `started_by_run_id = runId`, `started_at`).
     7. Return `started` with `pass` per AL4: a new pass, the current incomplete pass's `PassState`, or no `pass` key at all for a complete pass. Use a conditional spread; never assign `undefined`.
   - **`renewActivityStep(db, input, onWrite)`**:
     1. Select the Run row `where run_id = ? and status = 'in_progress' for update`.
     2. If there is none, return `{ alive: false }` with no write.
     3. Otherwise make one `update` of `last_activity` and `counts`, and return `{ alive: true }`.
   - **`listingPageStep(db, input, onWrite)`**: AL4 1.4.6 step.
     1. **Before** opening the transaction, validate `input.listing` with `validateListingInput`. On failure throw an instance of a small exported error class (for example `InvalidListingError`, declared in this file and carrying the `StoreFailure`). The repository maps it to that `invalid_data` failure.
     2. In the transaction, select the Run row `for update` where it is in progress. If there is none, return `taken_over` with no write.
     3. `dedupeListing`, then `writeListingPage(trx, places, writer)` unless the page is empty.
     4. One Finished Page insert through the same writer: `place_count` = the number of Places on the input page before dedupe (`v.places.length`), `is_short`, `reported_total` = `totalFound`, `finished_at`.
     5. Return `saved` with the report.
   - **`finishRunStep(db, input, onWrite)`**:
     1. Select the Run row `for update` where it is in progress.
     2. If there is none, return `{ updated: false }`.
     3. Otherwise make one `update` of `status`, `ended_at`, `last_activity = ended_at` and `counts`, and return `{ updated: true }`.
   - **Lock order:** Region advisory lock, then `crawl_runs` rows (start step); `crawl_runs` row, then place advisory locks (listing step). Never the reverse.
4. **`src/db/crawl-repository.ts`** (new, internal). Export `openCrawlRepository(options: CrawlRepositoryOptions): CrawlRepository`. Follow `crawl-store.ts`:
   - **Opening:** `StoreConfigSchema` on the connection string, then `createDb(..., POOL_MAX_STORE)`. Any failure gives a not-configured repository, with the same not-configured text as the stores. Never throws.
   - **One write-hook counter for the whole Run.** When `options.onWrite` is given, build a single wrapper: one `let n = 0` per repository, and each call does `n += 1; await options.onWrite(n)`. It ignores the per-Writer number it receives. Pass this wrapper (never `options.onWrite` itself) to every step and to `saveDetails`. The number the caller's hook receives is therefore the repository-wide write count 1, 2, 3, ... across all steps (AC-14 relies on this). This matches AL4 0.1 and 1.4.9: a `runCrawl` wrapper that counts its own calls sees the same numbers. Without `onWrite`, pass `undefined`.
   - **Methods:**
     - `beginRun` → `beginRunStep`;
     - `renewActivity` → `renewActivityStep`;
     - `recordListingPage` → `listingPageStep` (map `InvalidListingError` to its `invalid_data` failure);
     - `saveDetails` → `validateDetailsInput`, then the internal `saveDetails(db, value, wrapper)`;
     - `listPlacesDue` → `validatePlacesDueInput({ bbox, dueBefore })`, then `selectPlacesDue(db, { ...value, limit })` (a conditional spread for `limit`);
     - `countPlacesDue` → `validatePlacesDueInput`, then `countPlacesDue`;
     - `finishRun` → `finishRunStep`;
     - `close` → `destroyQuietly`, idempotent.
   - **Error mapping:** every method is wrapped so it never rejects, and every other throw becomes `unavailableFrom(error, '<action>')`. Use the actions `'run start'`, `'last activity renewal'`, `'listing step'`, `'details save'`, `'list places due'`, `'count places due'` and `'run finish'`. Never copy an error message.
   - **Private helpers:** write `openDb`, `guarded` and `fail` locally, as `crawl-store.ts` does. Do not export helpers from `place-store.ts` or `crawl-store.ts`.
5. **Do not change:** `place-store.ts`, `crawl-store.ts`, `save-details.ts`, `writer.ts`, `read.ts`, `plan.ts`, `validate.ts`, `places-due.ts`, `schema-setup.ts`, `crawl-tables.ts`, migrations, `src/crawl/`, `src/wikimapia/`, `scripts/`, `package.json` or config files. In `rows.ts`, you may only **add** a row schema if a new read needs one (for example the live-row read); change no existing schema.
6. **Stop and report, do not work around**, if:
   - the extraction changes the write numbers or the outcomes seen by `tests/db/listing.db.test.ts` or `contracts/storage.test.ts`;
   - a CHECK of AL4 2.2 to 2.4 rejects a write that AL4 1.4.5 or 1.4.8 prescribes;
   - `nextval(pg_get_serial_sequence('crawl_runs', 'run_id'))` returns no sequence;
   - the AL4 1.3 types cannot express a case the tests need.
7. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (run `pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.

1. `pnpm exec vitest run --no-color tests/db/crawl-repository.db.test.ts tests/db/listing.db.test.ts contracts/storage.test.ts` passes, with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/crawl tests/wikimapia contracts/storage.schema.test.ts contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly 2 errors, both TS2307 in `contracts/hydration.test.ts`, for `src/crawl/command` and `src/crawl/run-crawl`. No new error.
5. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/save-listing.ts, src/db/crawl-progress.ts, src/db/crawl-repository.ts, src/db/types.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|\.js'"`
   - `Select-String -Path src/db/crawl-progress.ts, src/db/crawl-repository.ts -Pattern '\$\{'` (no interpolation in SQL text or messages built from errors)
   - `Select-String -Path src/db/crawl-repository.ts -Pattern "\.message|String\(error|\.raw\("` (no copied error text; no SQL in the repository)
   - `Get-ChildItem src -Recurse -Filter *.ts | Where-Object Name -ne 'crawl-repository.ts' | Select-String -Pattern 'openCrawlRepository'` (only tests import it in this unit)

Do not run `contracts/hydration.test.ts` or `pnpm test:db` as a gate. The contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
  - Do not skip, weaken or `.todo` any contract test or any existing test in `tests/db/`.
  - Do not copy or redefine contract schemas, constants or helpers (`RunCountsSchema`, `ZERO_RUN_COUNTS`, `COORDINATE_TOLERANCE`, `ABANDONMENT_AGE_SECONDS`, `toMoment`, `WriteHook`, ...) in `src/` or `tests/`. Test-only synthetic data builders are fine.
- **Files you may create or change:**
  - the files listed in AL4 U4 "Files": `src/db/save-listing.ts`, `src/db/crawl-progress.ts`, `src/db/crawl-repository.ts`, `src/db/types.ts`, `tests/db/crawl-repository.db.test.ts`;
  - `src/db/rows.ts`, for additions only, as allowed in 2.2 step 5.

  Nothing else.
- **SQL:** all SQL stays in `src/db/` with bindings only. Tests issue no raw SQL.
- **Secrets:** never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- **Protected files:** do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U5:** `gateway.ts`, `requests.ts`, `runtime.ts`, including the heartbeat that calls `renewActivity`, `WAIT_CHUNK_MS` and `RENEW_AFTER_MS`.
- **U6:**
  - `listing-phase.ts`, `details-phase.ts`, `run-crawl.ts`, and the `RunContext`/`PassCursor` types in `src/crawl/types.ts`;
  - computing `abandonBefore` from the Run start;
  - the user-facing messages for `run_in_progress` ("already in progress"), `region_changed` (relist hint) and `taken_over`;
  - progress lines;
  - the best-effort second `finishRun`;
  - `placesStillDue`, `dueBefore` and `limit`;
  - closing the repository in `finally`.
- **U7:** `command.ts`, `scripts/crawl.ts`, `package.json` scripts; making `contracts/hydration.test.ts` green.
- **Orchestrator:** recording the AL4 0.1 decisions in `CLAUDE.md`.
