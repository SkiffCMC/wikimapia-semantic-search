# AL3 Routing: hydration, U3 "Crawl Store read side (public `createCrawlStore`)"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U3 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md`, section "4. Implementation Units", "U3".
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 is done and verified. The Schema Setup step `20261022_01_create_crawl_progress` (tables `crawl_runs`, `crawl_passes`, `crawl_finished_pages`), `src/db/crawl-tables.ts`, `undoLast()` and the extended `emptyStore()` all exist.
- U2 is done and verified: `src/crawl/types.ts`, `tile-plan.ts`, `config.ts` and `report.ts`. This unit does not touch `src/crawl/`.
- Baseline: `pnpm exec tsc --noEmit` reports exactly 3 TS2307 errors, all in `contracts/hydration.test.ts`, for the modules `src/crawl/command`, `src/crawl/run-crawl` and `src/db/crawl-store`. After this unit the `src/db/crawl-store` error must be gone. The other 2 stay until U6 and U7. Do not create stubs for `command` or `run-crawl`.
- This unit is **read side only**. It adds no write statement to `src/db/` and no Run logic. All SQL goes in `src/db/`, with bindings only.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:

- Node ESM; TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Top-level `import type`. Relative imports have no file extension.
- `unknown` only where `.agrules` 5 allows it.
- Every type alias or interface in `src/db/` goes in `src/db/types.ts`.
- No `console`. Vitest globals are on.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 2, 3, 4 and 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read only these parts: "0. Scope and Fixed Points" (the table, "Single source of truth", "Code style"); "1.1 Module map" (rows `rows.ts`, `validate.ts`, `places-due.ts`, `crawl-progress.ts`, `crawl-store.ts`); "1.3 Component contracts" (the `src/db/types.ts` block, only the row types, `PassState` and `DueQuery`; the `places-due.ts`, `readProgressView`, `createCrawlStore` and validator signatures); "1.4.6", only the "PassState query" paragraph; "1.4.7", from "`selectPlacesDue(db, ...)`" to the end of that section; "1.4.11 Public Crawl Store"; "1.5 Transaction boundaries" (rows "Reads" and "Places due list/count"); "2.1" to "2.4"; "4. Implementation Units", "U3"; "5. AL2 Guidance" (bullets "Never copy error messages", "Close every pool", "`exactOptionalPropertyTypes`", "Imports", "`unknown`", "Do not edit `contracts/`"). |
| 4 | `contracts/hydration.schema.ts` | Lines 130 to 160 (`MomentSchema`, `toMoment`, `RegionNameSchema`, `RunIdSchema`, `TileNumberSchema`, `PageNumberSchema`); `RunCountsSchema`, `ZERO_RUN_COUNTS` (around lines 467 to 530); lines 715 to 861 (`PlacesDueInputSchema` to `CreateCrawlStoreFn`, including `compareDetailsOrder`, `isInDetailsOrder`, `PlacesDueValueSchema`, `FinishedPageSchema`, `ListingPassSchema`, `RunRecordStatusSchema`, `RunRecordSchema`, `CrawlProgressViewSchema`, `CrawlProgressInputSchema`, the result schemas, `CrawlStore`, `CrawlStoreOptions`). |
| 5 | `contracts/storage.schema.ts` | `DetailsFetchedAtSchema` (line 101, `precision: 0`), `StoreConfigSchema` (line 120), `InvalidDataFailureSchema`, `StoreUnavailableFailureSchema`, `StoreFailureSchema` (lines 474 to 497), `storeResultSchema` (line 498), `EmptyResultSchema`, `SchemaStepsResultSchema`, `SaveResultSchema`, and the `PlaceStore` method signatures used for seeding. |
| 6 | `contracts/hydration.support.ts` | Only `RUN_START` (line 41), `CENTRAL_BELGRADE_POINT` (line 394) and the "Test Regions" block (lines 432 to 477: `SMALL_BBOX`, `REGION_T1`, `REGION_FAR`). |
| 7 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`, `clientDetails`. |
| 8 | `contracts/hydration.test.ts` | Read only. Lines 207 to 251 (helpers `progress`, `due`, `expectDatabaseUntouched`); lines 343 to 385 (`summary`, `syntheticPlaceDetails`, `seedSummaries`, `seedDetails`, the synthetic shapes your tests may mirror); lines 1286 to 1336 ("R1 Place Store"); lines 1843 to 1868 (AC-53); lines 1981 to 2014 (AC-58). These are the end-to-end checks your store must satisfy later (they run in U7). Do not run this file. |
| 9 | `src/db/place-store.ts` | The pattern to follow: `openDb`, `guarded`, `readFailure`, `READ_TRANSACTION_CONFIG`, fixed messages. Do not modify it. |
| 10 | `src/db/validate.ts` | File to extend (`plain` helper). |
| 11 | `src/db/rows.ts` | File to extend (`BigintSchema`, style of row schemas). |
| 12 | `src/db/types.ts` | File to extend (`StoreResult`, `Validated`, row type style). |
| 13 | `src/db/read.ts` | Only `FETCHED_AT_TEXT_SQL` (line 84). Use the same `to_char` form for every moment. |
| 14 | `src/db/connection.ts`, `src/db/failures.ts` | `createDb`, `destroyQuietly`, `POOL_MAX_STORE`, `POOL_MAX_SETUP`, the int8 parser note; `storeUnavailable`, `unavailableFrom`, `invalidData`. |
| 15 | `src/db/crawl-tables.ts` | `CRAWL_TABLES`, which supplies the table names. |
| 16 | `src/db/migrations/20261022_01_create_crawl_progress.ts` | Exact column names and types of the three crawl tables. |
| 17 | `tests/db/schema-setup.db.test.ts` | Lines 130 to 160: the `testDb()` and cleanup pattern to copy. |
| 18 | `tests/db/validate.test.ts` | File to extend; header, `invalidOf`, `issueAt`. |
| 19 | `tests/db/details.db.test.ts` | Lines 1 to 90 only: header comment and import layout of a DB test. |

Do not read the rest of `src/db/` (save paths, mappers, plan, writer, models, schema-setup), `src/crawl/` or `src/wikimapia/`. This unit does not touch them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

Tests run against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`.

- **Lifecycle:** In `beforeAll`, apply Schema Setup (`createSchemaSetup(...).apply()`). In `beforeEach`, call `emptyStore()`. Close every store, setup and Knex handle in `afterEach`/`afterAll`.
- **Seeding Places:** go through the public Place Store (`createPlaceStore(...).saveListingPage` / `.savePlaceDetails`), as the contract's `seedSummaries` / `seedDetails` do. Build small synthetic `PlaceSummary` / `PlaceDetails` values with the same shape as the contract test's `summary()` and `syntheticPlaceDetails()`. You may copy those two helpers into the test file. The recorded `clientDetails('getbyid-62587.json')` and `'getbyid-1381893.json'` are allowed too.
- **Seeding Crawl Progress:** use the Knex query builder on a `testDb()` handle (`createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP)`, tracked and destroyed as in `tests/db/schema-setup.db.test.ts`). Take table names from `CRAWL_TABLES`. No raw SQL strings.
- **Values:** synthetic only. Parse every store result with its contract result schema (`PlacesDueResultSchema`, `CrawlProgressResultSchema`) before asserting.

**A. `tests/db/places-due.db.test.ts`** (`selectPlacesDue`, `countPlacesDue` from `src/db/places-due`, run on a `createDb(..., POOL_MAX_STORE)` handle; AL4 1.4.7; R1, AC-30 to AC-34)

1. **R1 data set.** Seed exactly as the contract's R1 test:
   - Summary-Only Places: 900 at `CENTRAL_BELGRADE_POINT`, 300 at (20.452, 44.82) (on the corner of `SMALL_BBOX`), 950 at (20.47, 44.817) (outside).
   - Detailed Places: 62587 fetched `2026-08-01T00:00:00Z`; 1381893 fetched `2026-07-01T00:00:00Z`; 700 at `CENTRAL_BELGRADE_POINT` fetched `2026-07-01T00:00:00Z`; 800 at `CENTRAL_BELGRADE_POINT` fetched `2026-09-22T09:00:00Z`.

   Expected results:
   - `dueBefore` `2026-09-22T09:00:00Z` gives `toStrictEqual` `[{300}, {900}, {700, '2026-07-01T00:00:00Z'}, {1381893, '2026-07-01T00:00:00Z'}, {62587, '2026-08-01T00:00:00Z'}]`. Summary-Only entries have **no** `detailsFetchedAt` key.
   - The result passes `PlacesDueValueSchema` and `isInDetailsOrder`.
2. Exactly at the cutoff the Place is not due: 800 is absent at `...09:00:00Z` and present (last) at `...09:00:01Z`.
3. `REGION_FAR.bbox` gives `[]`, and `countPlacesDue` gives 0.
4. Edges are included: a Place on each of the four bbox edges is due (300 covers the north-west corner; add one on the east edge and one on the south edge). A Place 0.000001 degrees outside an edge is not due.
5. `limit`: with `limit: 2` the result equals the first 2 entries of the unlimited list. With `limit` larger than the count you get the full list. Without `limit` you get the full list.
6. `countPlacesDue` equals the length of the unlimited list for both cutoffs in 1 and 2.
7. Both functions also work inside a transaction (`db.transaction(trx => ...)`).

**B. `tests/db/crawl-store.db.test.ts`** (`createCrawlStore` from `src/db/crawl-store`, plus the exported current-pass read of `src/db/crawl-progress`; AL4 1.4.11, 1.4.6 PassState; R1, AC-53, AC-58 read side)

1. **Compile-time check:** `const create: CreateCrawlStoreFn = createCrawlStore;`.
2. **`listPlacesDueForDetails`:** it returns the R1 order of A.1 for the same seed (smaller is fine: 300, 900, 700, 62587). Its value has exactly the key `places`.
3. **Invalid input gives `invalid_data` and never touches the database.** Each case passes `InvalidDataFailureSchema`:
   - `dueBefore: 'yesterday'`;
   - `dueBefore` with milliseconds (`'2026-10-22T09:00:00.000Z'`; `MomentSchema` is `z.iso.datetime({ precision: 0 })`, so it is rejected);
   - a reversed bbox (`west > east`);
   - a missing bbox;
   - an extra key;
   - for `readCrawlProgress`: Region Names `'Belgrade'`, `''` and `'a b'`, and an extra key.

   To show that validation comes first, run the same invalid inputs on a store created with `UNREACHABLE_DATABASE_URL` and with `''`. Both still give `invalid_data`.
4. **Not configured.** `createCrawlStore({ connectionString: '' })` with valid input gives `store_unavailable` for both methods. `close()` resolves twice.
5. **Unreachable database.** With `UNREACHABLE_DATABASE_URL`, both methods give `store_unavailable`. `JSON.stringify(failure)` contains neither `UNREACHABLE_PASSWORD` nor `postgres://`. Set the test timeout to 60 s.
6. **Empty Region.** `readCrawlProgress({ regionName: 'test-one' })` with nothing stored gives `toStrictEqual` `{ regionName: 'test-one', passes: [], runs: [] }`.
7. **Seeded Crawl Progress** (rows in `crawl_runs`, `crawl_passes`, `crawl_finished_pages`; all moments whole-second UTC; counts are `JSON.stringify` of valid `RunCounts`, e.g. `ZERO_RUN_COUNTS` and one non-zero variant that passes `RunCountsSchema`):
   - **Runs**, for Region `test-one`: Run 1 `completed` with `ended_at`; Run 2 `abandoned` with no `ended_at`; Run 3 `in_progress`. Also one Run for `test-two`.
   - **Passes:** pass 1 of `test-one` with `tile_count` 2, both tiles finished (one with pages 1 and 2, the short one on page 2; the other with a short page 1); pass 2 of `test-one` with `tile_count` 4 and one tile finished.
   - **Finished pages:** insert them deliberately out of order. Give one page `reported_total` null and the others a number.

   Expected `readCrawlProgress({ regionName: 'test-one' })`:
   - It passes `CrawlProgressViewSchema`.
   - `runs` are in `runId` order and contain only `test-one` Runs. `endedAt` is absent (no key) for `in_progress` and `abandoned` and present for `completed`. `startedAt` and `lastActivity` are whole-second `Z` text. `counts` are `toStrictEqual` to what was inserted.
   - `passes` are in `passNumber` order and carry `regionName`, `bbox` (equal to the inserted doubles), `tileSize`, `tileCount`.
   - `finishedPages` are ordered by tile and then page. Each has the keys `tileNumber`, `page`, `runId`, `placeCount`, `short`, plus `totalFound` only when not null.
   - `finishedTiles` are the tiles with a short page, ascending.
   - `complete` is `true` for pass 1 and `false` for pass 2.
   - `readCrawlProgress({ regionName: 'test-two' })` shows only its own Run.
8. **Read-back gate.** A `crawl_runs` row whose `counts` jsonb is malformed (e.g. `{}`, or a negative count) makes `readCrawlProgress` resolve `store_unavailable` with the message `Place Store unavailable: stored data failed the read-back check`. It must not reject.
9. **No content (AC-58 read side).** For the seeded Region, `JSON.stringify(view)` has no key other than the contract keys. The full set of keys found by a recursive walk equals the union of the `ListingPassSchema`, `FinishedPageSchema`, `RunRecordSchema`, `RunCountsSchema` and view keys.
10. **Current-pass read** (the exported helper of `src/db/crawl-progress.ts`, see 2.2 step 5; call it inside `testDb().transaction(...)`):
    - A Region with no pass gives `undefined`.
    - With the seed of 7, `test-one` gives pass 2 (the newest).
    - Its `PassState` has `passNumber` 2, `tileCount` 4, `finishedTiles` = the one short tile, and `lastFinishedPage` as ascending `[tile, lastPage]` pairs that cover every tile with a finished page, including tiles that are not yet finished.
    - A check of pass 1 (seed only pass 1) gives `finishedTiles` of length 2 = `tileCount`.

**C. `tests/db/validate.test.ts`** (append; keep all existing cases)

1. `validatePlacesDueInput`:
   - A valid `{ bbox: SMALL_BBOX, dueBefore: RUN_START }` returns `ok` with a value equal to the input. The value is a fresh object: mutating it does not change the input.
   - These fail with `invalid_data`, with an issue at the exact path: `dueBefore: 'yesterday'` at `['dueBefore']`; a reversed bbox at a path under `['bbox', ...]`; a missing `bbox` at `['bbox']`; an extra key; `null`, `undefined`, a number, an array.
   - No failure message contains the rejected value (`'yesterday'`).
2. `validateCrawlProgressInput`:
   - `{ regionName: 'test-one' }` is ok.
   - These fail with `invalid_data`: `'Belgrade'`, `''`, `'-a'`, `'a--b'` (all rejected by the `RegionNameSchema` regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`), a number, a missing key, an extra key, `null`.
3. Neither validator throws on hostile input: a getter that throws, or a `Proxy`. Copy the style of the existing "robustness" block.

Use fixed moments only (`RUN_START` or literal whole-second text). The new tests are expected to fail until `add-coder` has finished. Do not stub production modules.

### 2.2 add-coder

1. **`src/db/rows.ts`** (extend). Add the seven row schemas of AL4 1.1. Use non-strict `z.object`, snake_case keys and the existing `BigintSchema`. Moments come in as `*_text` aliases produced by the `to_char` form of `read.ts`.
   - `RunRowSchema`: `run_id`, `region_name`, `status` (`RunRecordStatusSchema`), `started_at_text`, `ended_at_text` (nullable), `last_activity_text`, `counts` (`RunCountsSchema`; node-pg returns jsonb already parsed).
   - `PassRowSchema`: `region_name`, `pass_number`, `bbox_west`, `bbox_south`, `bbox_east`, `bbox_north`, `tile_width`, `tile_height`, `tile_count`.
   - `FinishedPageRowSchema`: `pass_number`, `tile_number`, `page_no`, `run_id`, `place_count`, `is_short`, `reported_total` (nullable).
   - `PassTileRowSchema`: `tile_number`, `last_page`, `finished` (boolean).
   - `DuePlaceRowSchema`: `place_id`, `details_fetched_at_text` (nullable).
   - `CountRowSchema`: `count`.
   - `IdRowSchema`: `id` (used by U4 for `nextval`).

   Import contract schemas from `../../contracts/hydration.schema`. Do not copy them.
2. **`src/db/types.ts`** (extend). Add the seven `z.infer` row types, plus `PassState` and `DueQuery` exactly as in AL4 1.3. Also add one interface for the current-pass read: `CurrentPass { row: PassRow; state: PassState }`. Use `import type` for contract types. Do **not** add `BeginRunInput`, `BeginRunValue`, `RenewInput`, `ListingStepInput`/`Value`, `FinalRunStatus`, `FinishInput`, `CrawlRepositoryOptions` or `CrawlRepository` (U4).
3. **`src/db/validate.ts`** (extend). Add `validatePlacesDueInput(input: unknown): Validated<PlacesDueInput>` and `validateCrawlProgressInput(input: unknown): Validated<CrawlProgressInput>`. Each is a one-line use of the existing private `plain` helper with `PlacesDueInputSchema` / `CrawlProgressInputSchema` and a fixed shape message. Change nothing else in the file.
4. **`src/db/places-due.ts`** (new). Export `selectPlacesDue(db: Knex | Knex.Transaction, query: DueQuery): Promise<DuePlace[]>` and `countPlacesDue(db, input: PlacesDueInput): Promise<number>`, implementing the AL4 1.4.7 statement literally:
   - **Filter:** the envelope `&&` prefilter on `centre_point`, then inclusive `BETWEEN` on `location_lon` / `location_lat`, then `details_fetched_at IS NULL OR details_fetched_at < ?::timestamptz`.
   - **Order:** `ORDER BY (details_fetched_at IS NOT NULL), details_fetched_at, place_id`.
   - **Limit:** `LIMIT ?` only when `limit` is defined.
   - **Bindings:** every value is a binding (4 envelope + 4 between + `dueBefore` [+ limit]). The SQL text is built from constant fragments only, with no template-literal interpolation of values.
   - **Shared filter:** both functions use one private constant for the filter.
   - **Parsing:** parse raw rows with `DuePlaceRowSchema` / `CountRowSchema` (`unknown` only for the raw driver result, parsed on the next line). Map rows with a conditional spread so that `detailsFetchedAt` exists only when the text is not null.
   - No validation inside (the callers validate). No `compareDetailsOrder` in production code: the order comes from SQL.
5. **`src/db/crawl-progress.ts`** (new; read part only).
   - **`readProgressView(trx: Knex.Transaction, regionName: string): Promise<CrawlProgressView>`**, per AL4 1.4.11. Three queries on `CRAWL_TABLES`, each parameterized by `region_name`:
     - passes ordered by `pass_number`;
     - finished pages ordered by `pass_number, tile_number, page_no`;
     - runs ordered by `run_id`, with moments via `to_char`.

     Assemble the view:
     - group pages by pass;
     - `finishedTiles` = the ascending tile numbers whose page is short;
     - `complete` = `finishedTiles.length === tile_count`;
     - `FinishedPage` per AL4 1.4.11, with `totalFound` only when not null;
     - `RunRecord` with `endedAt` only when not null;
     - `bbox` `{ west, south, east, north }` and `tileSize` `{ width, height }` from the pass columns.

     Use conditional spreads; never assign `undefined`. Return the assembled value **without** gating it. The store gates it.
   - **`readCurrentPass(trx: Knex.Transaction, regionName: string): Promise<CurrentPass | undefined>`** (the "PassState query" of AL4 1.4.6, exported now so U4's `beginRunStep` can call it):
     - Read the newest `crawl_passes` row of the Region (`order by pass_number desc limit 1`). Return `undefined` if there is none.
     - Otherwise run `select tile_number, max(page_no) as last_page, bool_or(is_short) as finished from crawl_finished_pages where region_name = ? and pass_number = ? group by tile_number order by tile_number`.
     - Parse the rows with `PassTileRowSchema` and build `PassState`: `passNumber`, `tileCount`, `finishedTiles` ascending, `lastFinishedPage` as ascending `[tile, last_page]` pairs.
     - No row locks here (U4 adds `FOR UPDATE` where its start step needs them).
   - Do **not** write `beginRunStep`, `renewActivityStep`, `listingPageStep` or `finishRunStep` (U4).
6. **`src/db/crawl-store.ts`** (new, public). Export `createCrawlStore: CreateCrawlStoreFn`, following `place-store.ts`:
   - **Factory:** `StoreConfigSchema` on the connection string, then `createDb(..., POOL_MAX_STORE)`. Any failure gives a not-configured store. The factory never throws.
   - **`guarded` order:** validate (`validatePlacesDueInput` / `validateCrawlProgressInput`) → not configured (`store_unavailable`, the same not-configured text as the Place Store) → operation → map errors.
   - **Read-back gate:** a `z.ZodError` becomes `storeUnavailable('Place Store unavailable: stored data failed the read-back check')`. Any other error becomes `unavailableFrom(error, '<action>')`, with actions `'list places due'` and `'read crawl progress'`. Never copy an error message.
   - **`listPlacesDueForDetails`:** `selectPlacesDue(conn, value)` (no limit), then `PlacesDueValueSchema.parse({ places })`.
   - **`readCrawlProgress`:** `conn.transaction(trx => readProgressView(trx, value.regionName), READ_TRANSACTION_CONFIG)`, then `CrawlProgressViewSchema.parse(view)`. Import `READ_TRANSACTION_CONFIG` from `./place-store`.
   - **`close`:** `destroyQuietly(db)`, idempotent, never rejects.
   - The private helpers (`openDb`, `guarded`, `readFailure`) are re-written locally in `crawl-store.ts`. Do **not** edit `place-store.ts` to export them.
7. Never change `place-store.ts`, `save-listing.ts`, `save-details.ts`, `read.ts`, `schema-setup.ts`, `crawl-tables.ts`, migrations, `src/crawl/`, `src/wikimapia/`, `scripts/`, `package.json` or config files. Create no `crawl-repository.ts`.
8. **Stop and report, do not work around**, if:
   - the R1 data set does not come out in the contract order with the AL4 1.4.7 statement;
   - a moment read back with `to_char` is not accepted by `MomentSchema`;
   - `CrawlProgressViewSchema` or `ListingPassSchema` cannot be satisfied from the columns of AL4 2.2 to 2.4;
   - `CreateCrawlStoreFn` cannot be satisfied as AL4 1.4.11 describes.
9. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (run `pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.

1. `pnpm exec vitest run --no-color tests/db/places-due.db.test.ts tests/db/crawl-store.db.test.ts tests/db/validate.test.ts` passes, with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/crawl tests/wikimapia contracts/storage.test.ts contracts/storage.schema.test.ts contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly 2 errors, both TS2307 in `contracts/hydration.test.ts`, for `src/crawl/command` and `src/crawl/run-crawl`. The `src/db/crawl-store` error is gone. `pnpm lint` reports problems only in `contracts/hydration.test.ts`, and only problems that follow from those two missing modules.
5. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/rows.ts, src/db/types.ts, src/db/validate.ts, src/db/places-due.ts, src/db/crawl-progress.ts, src/db/crawl-store.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|\.js'"`
   - `Select-String -Path src/db/places-due.ts, src/db/crawl-progress.ts -Pattern '\$\{'` (no interpolation in SQL text)
   - `Select-String -Path src/db/crawl-progress.ts, src/db/crawl-store.ts, src/db/places-due.ts -Pattern "\.insert\(|\.update\(|\.del\(|\.delete\(|truncate|for update"`
   - `Select-String -Path src/db/crawl-progress.ts -Pattern "beginRunStep|renewActivityStep|listingPageStep|finishRunStep"`
   - `Test-Path src/db/crawl-repository.ts` is `False`.

Do not run `contracts/hydration.test.ts` or `pnpm test:db` as a gate. The contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
  - Do not skip, weaken or `.todo` any contract test or any existing test in `tests/db/validate.test.ts`.
  - Do not copy or redefine contract schemas, constants or helpers (`PlacesDueInputSchema`, `CrawlProgressViewSchema`, `RunCountsSchema`, `compareDetailsOrder`, `toMoment`, ...) in `src/` or `tests/`. Test-only synthetic data builders are fine.
- **Files you may create or change:** the files listed in AL4 U3 "Files" (`src/db/rows.ts`, `src/db/types.ts`, `src/db/validate.ts`, `src/db/places-due.ts`, `src/db/crawl-progress.ts`, `src/db/crawl-store.ts`, `tests/db/places-due.db.test.ts`, `tests/db/crawl-store.db.test.ts`, `tests/db/validate.test.ts`). Nothing else.
- **SQL:** all SQL stays in `src/db/` with bindings only. Tests issue no raw SQL; crawl rows are seeded through the Knex builder.
- **Secrets:** never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- **Protected files:** do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U4:**
  - the write steps `beginRunStep`, `renewActivityStep`, `listingPageStep`, `finishRunStep`;
  - row locks (`FOR UPDATE`), the Region advisory lock and `CRAWL_REGION_LOCK_CLASS` use;
  - `crawl-repository.ts` (`openCrawlRepository`, the Run-wide write hook, `saveDetails` through the repository);
  - the `writeListingPage` extraction in `save-listing.ts`;
  - the repository types in `src/db/types.ts`.
- **U5:** `gateway.ts`, `requests.ts`, `runtime.ts`.
- **U6:**
  - `listing-phase.ts`, `details-phase.ts`, `run-crawl.ts`;
  - the `dueBefore` / `limit` computation of the Details Phase;
  - `placesStillDue`.
- **U7:**
  - `command.ts`, `scripts/crawl.ts`, `package.json` scripts;
  - making `contracts/hydration.test.ts` green.
- **Orchestrator:** recording the AL4 0.1 decisions in `CLAUDE.md`.
