# AL3 Routing: crawl-run1-fixes, U2 "Schema Setup step 6, `emptyStore`, old Run Records"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U2 of 7 (attempt 1). It depends on nothing beyond the existing schema. U1 is done (`docs/al3-routing/20261022-crawl-run1-fixes-01-client-al3.md`).
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section "4. Implementation Units", "U2. Schema Setup step 6, `emptyStore`, old Run Records"
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2)
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `src/db/` has 5 Schema Setup steps. The newest is `20261022_01_create_crawl_progress` (`crawl_runs`, `crawl_passes`, `crawl_finished_pages`). Its `crawl_runs_status_valid` CHECK does **not** allow `quota_exhausted` yet. The amended `RunRecordStatusSchema` in `contracts/hydration.schema.ts` does.
- The amended `RunCountsSchema` requires `placesParkedThisRun`, `placesParked` and `placesReleased`, with the refine `placesParkedThisRun <= placesParked`. `src/db/rows.ts` `RunRowSchema.counts` still uses `RunCountsSchema` directly. Run Records stored before this feature therefore fail the read gate.
- `tests/db/crawl-store.db.test.ts` fails to load: `NONZERO_COUNTS` (line 205) is built with `RunCountsSchema.parse` and lacks the three new counts, so a ZodError is thrown at import.
- `pnpm exec tsc --noEmit` currently reports exactly three errors, and **none of them belongs to U2**: `contracts/crawl-run1-fixes.test.ts:156` (`CreateFailureAwareCrawlStoreFn`, U3), `src/crawl/requests.ts:65` (U5), `tests/crawl/report.test.ts:38` (U5).
- `tests/db/schema-setup.db.test.ts` and `tests/db/crawl-schema.db.test.ts` are currently green with 5 steps. Several of their cases iterate `Object.values(CRAWL_TABLES)` and assume that object holds exactly the three hydration tables. Once `CRAWL_TABLES` gains three entries, those cases change meaning (section 2.1).

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, **extensionless** relative imports, `unknown` only where `.agrules` section 5 allows it, types in `src/db/types.ts`, no `console`. Match the style of the existing `src/db/` and `tests/db/` files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly section 3 (all SQL in `src/db/`, parameterized, versioned migrations), section 4 (no secrets, synthetic data) and section 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | The design. Read only: "0. Scope and Fixed Points" (incl. "0.1 Design decisions" row 5 and "0.2 AL5 inconsistency (resolved)"); "1.1 Module map", the Database table rows `crawl-tables.ts`, the migration, `migrations/index.ts`, `schema-setup.ts`, `rows.ts`; "1.4.9 Schema Setup `emptyStore()`"; "1.4.12 Reading old Run Records"; "1.5 Transaction boundaries", row "Schema step 6"; "2. Data Model Design", 2.1 to 2.4 (2.5 only the `RunRowSchema.counts` bullet); "4. Implementation Units / U2"; "5. AL2 Guidance", bullet "`unknown`" and the last bullet. Skip everything else. |
| 4 | `contracts/crawl-run1-fixes.schema.ts` | Only `CRAWL_ITEM_FAILURES_TABLE`, `CRAWL_ITEM_FAILURES_COLUMNS` (with `page_no`), `FAILED_AT_UDT_NAME` (around lines 95-113). |
| 5 | `contracts/hydration.schema.ts` | Only `RegionNameSchema` (around line 153), `ItemFailureKindSchema` (line 448), `RunCountsSchema` and `ZERO_RUN_COUNTS` (lines ~470-555), `RunRecordStatusSchema` (line 846). |
| 6 | `contracts/crawl-run1-fixes.test.ts` | Reference only: the lifecycle block (lines ~181-231) and "AC-41 Schema Setup for Failure Records" (lines ~1529-1593). The first AC-41 case must turn green in this unit. |
| 7 | `contracts/hydration.test.ts` | Reference only: "3.9 Schema Setup for Crawl Progress", AC-55 to AC-57 (lines ~1908-1988). They must turn green. Note that AC-56 now undoes newest-first until the hydration tables are gone. |
| 8 | `contracts/storage.test.ts` | Reference only: AC-1 to AC-6 and AC-14 (lines ~296-410, ~599). They must stay green. AC-14 is the reason the page column is `page_no`. |
| 9 | `contracts/storage.schema.ts`, `contracts/storage.support.ts` | `SchemaSetup`, `SchemaStepsResultSchema`, `EmptyResultSchema`, `STORE_TABLES`; `requireTestDatabaseUrl`. |
| 10 | `src/db/crawl-tables.ts` | File to change. |
| 11 | `src/db/migrations/20261022_01_create_crawl_progress.ts` | Style reference for the new migration (named constraints, `table.check`, `knex.raw` for constant DDL, imports from `../crawl-tables`). It also holds the current `crawl_runs_status_valid` text. Do not modify it. |
| 12 | `src/db/migrations/index.ts` | File to change (append the 6th step). |
| 13 | `src/db/schema-setup.ts` | File to change (`emptyStore`). |
| 14 | `src/db/rows.ts` | File to change (`RunRowSchema.counts` only). |
| 15 | `src/db/crawl-progress.ts` | Read only around line 90 (`RunResultSchema` uses `RunRowSchema`). This is the read path that the legacy-record fix serves. Do not modify it. |
| 16 | `tests/db/schema-setup.db.test.ts`, `tests/db/crawl-schema.db.test.ts`, `tests/db/crawl-store.db.test.ts` | Test files to update (test-writer). |
| 17 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read anything under `src/wikimapia/` or `src/crawl/`, the AL6 document, or the other `src/db/` files (`crawl-repository.ts`, `crawl-store.ts`, `places-due.ts`, `validate.ts`, `types.ts`, save paths). U2 touches none of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

All DB tests run against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Close every `SchemaSetup` and `Knex` handle in `afterEach`/`afterAll`. Every case that undoes steps must restore all steps with `apply` in `afterEach`, so later files start from a fully migrated database. Seed synthetic rows with the Knex query builder through the file's own `testDb()` handle. Do not write raw SQL strings in tests. Expand AL4 U2 "Unit tests must cover" as follows.

**A. `tests/db/schema-setup.db.test.ts`** (keep everything not listed here)

1. `STEP_NAMES` gains `'20261022_02_create_item_failures'` as the 6th entry. Add a constant for it (e.g. `FAILURES_STEP`) next to `CRAWL_STEP`. Update the titles and expectations that mean "all steps": `MIGRATIONS` list, `apply` from nothing returns 6 in order, `undoAll` returns 6 newest first, all 6 pending after `undoAll`. `undoAll` also removes the three new tables.
2. Split the use of `CRAWL_TABLES`: the existing cases mean the three **hydration** tables. Define local lists for the hydration tables (`runs`, `passes`, `finishedPages`) and for the new tables (`itemFailures`, `explicitRetries`, `placeReleases`). Use them so that each case states which tables it means.
3. `undoLast` group (AL4 U2):
   - `undoLast` returns exactly `[FAILURES_STEP]`. Afterwards `inspect` shows 5 applied and `[FAILURES_STEP]` pending. None of the three new tables exist, while the three hydration tables and all `STORE_TABLES` remain. A synthetic store row (the existing `TagModel` row) and a synthetic `crawl_runs` row seeded before the undo are unchanged afterwards.
   - A second `undoLast` returns exactly `[CRAWL_STEP]` and removes the hydration tables. A third returns `['20261021_04_create_comments']`. `apply` then re-applies all of them in order (rework the existing "second undoLast" case accordingly).
   - After `undoAll`, `undoLast` returns `{ steps: [] }` (existing case, with 6 pending).
   - After `undoLast` of step 6, an existing `crawl_runs` row with status `quota_exhausted` (and `ended_at` set) does not make the undo fail, and the row is still readable. Seed it before the undo. Then show that a **new** `quota_exhausted` insert is rejected while step 6 is undone (the `NOT VALID` check still guards new writes), and that `apply` succeeds with the old row still present.
4. `emptyStore` groups (AL4 1.4.9):
   - With one synthetic row in **every** store and crawl table, `emptyStore` clears all of them: 4 store tables + 6 crawl tables = 10. Extend `seedCrawlRows` (or add a helper) to seed one `crawl_item_failures` row (a Place item), one `crawl_explicit_retries` row and one `crawl_place_releases` row, respecting the FK chain `crawl_runs` -> `crawl_explicit_retries` -> `crawl_place_releases`. (AL4 U2 says "nine". The correct count is 10 = 4 `STORE_TABLES` + 6 `CRAWL_TABLES`, so assert 10.)
   - After `undoLast` of step 6 (new tables absent, hydration tables present), `emptyStore` resolves `{ ok: true, value: {} }` and still clears the store tables and the hydration tables.
   - After two `undoLast` (all crawl tables absent), it still resolves `{ ok: true, value: {} }` (rework the existing case, which today undoes only one step).
   - After `undoAll` it still resolves `store_unavailable` (existing case, keep it).
5. The "Forbidden columns (AC-5, AC-6, AC-14)" tests stay as they are. They now also cover the new tables. Do not weaken them.

**B. `tests/db/crawl-schema.db.test.ts`** (AL4 2.1 to 2.4)

1. Constants: `CRAWL_TABLES` equals the six names `{ runs, passes, finishedPages, itemFailures: 'crawl_item_failures', explicitRetries: 'crawl_explicit_retries', placeReleases: 'crawl_place_releases' }`. `CRAWL_TABLES.itemFailures` equals the contract's `CRAWL_ITEM_FAILURES_TABLE`. `ITEM_FAILURE_PAGE_COLUMN` is `'page_no'`. `CRAWL_REGION_LOCK_CLASS` is unchanged.
2. Exact columns, in order, as `[name, udtName]` pairs (`bigserial`/`bigint` is `int8`, `integer` is `int4`, `timestamptz(0)` is `timestamptz`):
   - `crawl_item_failures`: `failure_id`, `run_id`, `place_id`, `tile_number`, `page_no`, `failure_kind`, `message`, `failed_at` (AL4 2.2).
   - `crawl_explicit_retries`: `run_id`, `region_name`, `retried_at`, `places_released` (AL4 2.3).
   - `crawl_place_releases`: `run_id`, `place_id`, `released_at` (AL4 2.4).
   - Also assert that every name in `CRAWL_ITEM_FAILURES_COLUMNS` is present and that `failed_at` has `udt_name` `FAILED_AT_UDT_NAME`.
3. Column rules. **Keep the existing regex set for the three hydration tables unchanged.** It includes `message`, which those tables must still not have. For the three new tables apply the AL4 2.1 set instead: the AC-41 regex `/description|comment|title|author|user_?ip|outline|polygon/i` (no `message`: Failure Records hold the Item Failure message by design), `/embedding|vector/i`, `/user_?ip|commenter_?ip/i` and the AC-14 total regex `/^(page|page_?size|page_?number|count|found|total_?found|total)$/i`. No udt may be `geometry`, `geography`, `inet`, `cidr` or `vector`.
4. Constraints. Each insert below is rejected, and a valid control row is accepted:
   - `crawl_runs`: status `quota_exhausted` with `ended_at` set is **accepted**. `quota_exhausted` with `ended_at` null is rejected (existing end-moment rule). Every value of `RunRecordStatusSchema.options` is accepted by the status check.
   - `crawl_item_failures`: both item forms set (Place and tile/page); neither set; a listing item with only `tile_number` or only `page_no`; empty `message`; unknown `failure_kind` (e.g. `'key_quota_exhausted'`, which is not an Item Failure kind); `place_id` 0; `tile_number` 0; `page_no` 0; an unknown `run_id` (FK). Every `ItemFailureKindSchema.options` value is accepted. A Place item and a listing item are both accepted as control rows.
   - `crawl_explicit_retries`: negative `places_released`; uppercase Region Name; a second row for the same `run_id` (PK); an unknown `run_id`. `places_released` 0 is accepted.
   - `crawl_place_releases`: `place_id` 0; a row whose `run_id` has no `crawl_explicit_retries` row (FK); a duplicate `(place_id, run_id)`. Two releases of the same Place by two different retries are accepted.
   - `ON DELETE` rules: deleting a `crawl_explicit_retries` row cascades to its `crawl_place_releases` rows. Deleting a `crawl_runs` row that has a Failure Record is rejected (`RESTRICT`).
5. `emptyStore` resets identity for the new `bigserial`: after `emptyStore`, a new `crawl_item_failures` row inserted without `failure_id` gets `failure_id` 1. The existing `crawl_runs` identity case stays.

**C. `tests/db/crawl-store.db.test.ts`**

1. Fix `NONZERO_COUNTS` (line 205): add `placesParkedThisRun`, `placesParked` and `placesReleased` with values that satisfy the refine (e.g. 1, 2, 1). Use non-zero values so that a read that silently defaulted them to 0 would fail the existing round-trip assertions. Keep the rest unchanged.
2. New legacy-record group (AL4 1.4.12, decision 5), through the public `readCrawlProgress`:
   - A `crawl_runs` row whose `counts` JSON is a complete hydration-era object **without** the three keys reads back with all three as 0, and every other count is unchanged.
   - A row that has only some of the three keys (e.g. `placesReleased: 2` only) keeps the stored value and defaults the others to 0.
   - Stored values win: a complete new-style record reads back exactly as stored.
   - Defaults do not hide bad data: a legacy row that is otherwise malformed (negative count, or the existing sum-mismatch cases at lines ~804-807 with the three keys removed) still resolves `store_unavailable`. So does a stored `placesParkedThisRun: 1, placesParked: 0` (the refine is still applied after the defaults). The existing malformed-counts cases stay.
   - Reading does not rewrite the stored row. The raw `counts` jsonb, read back with the test's own Knex handle, is still the legacy object.

Run the three files once and confirm that the new cases fail only because the implementation is missing. Do not stub production modules.

### 2.2 add-coder

Implement exactly AL4 1.1 (the five `src/db/` rows listed in the manifest), 1.4.9, 1.4.12 and 2.1 to 2.4.

1. **`src/db/crawl-tables.ts`.** Add `itemFailures` (the value is the contract's `CRAWL_ITEM_FAILURES_TABLE`, imported, not retyped), `explicitRetries: 'crawl_explicit_retries'` and `placeReleases: 'crawl_place_releases'` to `CRAWL_TABLES` (keep `as const` and the literal types). Add `export const ITEM_FAILURE_PAGE_COLUMN = 'page_no'`. Import nothing from `src/crawl/`.
2. **`src/db/migrations/20261022_02_create_item_failures.ts`** (new). Use the style of `20261022_01_create_crawl_progress.ts`: `import type { Knex }`, table names from `../crawl-tables`, explicit names for every constraint and index (`<table>_<rule>`).
   - `up`, in this order (AL4 2.1): (1) drop and re-add `crawl_runs_status_valid` with the 8 statuses of `RunRecordStatusSchema` (incl. `quota_exhausted`), as a constant `knex.raw`; (2) create `crawl_item_failures` (AL4 2.2: columns, nullability, FK `ON DELETE RESTRICT`, the per-column CHECKs, `crawl_item_failures_one_item`, the partial index `crawl_item_failures_place_idx` and `crawl_item_failures_run_idx`); (3) create `crawl_explicit_retries` (AL4 2.3, incl. the Region Name CHECK with the same regex as step 5 and `crawl_explicit_retries_region_idx`); (4) create `crawl_place_releases` (AL4 2.4, PK `(place_id, run_id)`, FK to `crawl_explicit_retries(run_id)` `ON DELETE CASCADE`).
   - Write the status list and the `failure_kind` list as **constant literals** in the migration, equal to `RunRecordStatusSchema.options` and `ItemFailureKindSchema.options`. A migration is frozen history, so do not build its DDL from the live contract enums. The tests pin the equality.
   - `down`, in this order: drop `crawl_place_releases`, `crawl_explicit_retries`, `crawl_item_failures`, then drop and re-add `crawl_runs_status_valid` with the 7 hydration statuses (without `quota_exhausted`) **`NOT VALID`** (AL4 2.1 Down, step 2).
   - The page column name comes from `ITEM_FAILURE_PAGE_COLUMN`. No FK to `places`. No geometry, `inet`, `cidr` or vector column, no extension, no Objection model. Touch no Place, Comment, Tag, Place-Tag Link, Crawl Progress or Run Record row.
   - `knex.raw` only with constant DDL text (the status `ALTER`, the partial index, any CHECK the builder cannot express). Never interpolate values.
3. **`src/db/migrations/index.ts`.** Import the step and append `{ name: '20261022_02_create_item_failures', up, down }` as the 6th, newest `MIGRATIONS` entry. Change nothing else.
4. **`src/db/schema-setup.ts`** (AL4 1.4.9). Inside the existing `emptyStore` transaction, after `TRUNCATE_STORE_TABLES` and the existing `crawl_runs` probe: if `crawl_runs` is present, probe `CRAWL_TABLES.itemFailures` with the same parameterized `TABLE_EXISTS` statement and `TableExistsResultSchema`. If present, run the new constant `TRUNCATE_ALL_CRAWL_TABLES` (the exact table list and order of AL4 1.4.9, `RESTART IDENTITY`, one statement because of the FKs). Otherwise run the existing `TRUNCATE_CRAWL_TABLES`. Keep the `_test` guard, the non-throwing contract and the `unavailableFrom(error, 'empty store')` mapping. Change no other method.
5. **`src/db/rows.ts`** (AL4 1.4.12). Add `PARKING_COUNT_DEFAULTS`, the pre-step `withParkingCounts(value: unknown): unknown` (spread the defaults under a plain, non-null, non-array object; return anything else unchanged) and `StoredRunCountsSchema = z.preprocess(withParkingCounts, RunCountsSchema)`. Set `RunRowSchema.counts` to `StoredRunCountsSchema`. `unknown` is allowed here only because this is a validator pre-step over untrusted database JSON (`.agrules` section 5). Use a type guard, not a cast, to detect the plain object. Add **no** other row schemas (`FailureRowSchema`, `ParkingRowSchema`, `RetryRowSchema` belong to U3/U4). No stored row is ever rewritten. There is no data step in `up`/`down`.
6. Make sure the `RunRow` type in `src/db/types.ts` still infers the full `RunCounts` shape (it is `z.infer<typeof RunRowSchema>`, so the output type is unchanged). Do not edit `types.ts` unless `tsc` requires it.
7. Do not change `scripts/`, `package.json`, `src/db/inspect.ts`, `src/db/crawl-progress.ts`, `src/db/crawl-store.ts` or `src/db/crawl-repository.ts`. Scripts pick up the new step through `MIGRATIONS`.
8. **Stop and report, do not work around:** if `db.migrate.down` does not undo exactly step 6, if the `NOT VALID` down cannot be expressed as constant DDL, if a contract test contradicts AL4 2.1 to 2.4, or if `contracts/hydration.test.ts` AC-55 to AC-57 fail for a reason outside the schema (e.g. in `src/crawl/`).
9. Run every Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise). `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.

1. `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts tests/db/crawl-schema.db.test.ts tests/db/crawl-store.db.test.ts` passes (no failures, no skipped or todo tests).
2. `pnpm exec vitest run --no-color contracts/hydration.test.ts -t "^AC-5[5-7] "` passes.
3. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-41 .*the newest step"` passes (the first AC-41 case). The second AC-41 case and AC-42 need a crawl that writes Failure Records and Explicit Retries (U3 to U6) and stay red. That is expected.
4. `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/hydration.schema.test.ts` passes (storage AC-1 to AC-6 and AC-14 included).
5. Regression: `pnpm exec vitest run --no-color tests/db tests/wikimapia` passes.
6. `pnpm db:status --test` exits 0 and lists 6 applied steps, none pending.
7. Development Database (the value is the local default from `.env.example`, not a secret):
   - `$env:DATABASE_URL = 'postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia'`
   - `pnpm db:migrate` exits 0 and applies exactly one new step, `20261022_02_create_item_failures`. A second `pnpm db:migrate` applies none.
   - `pnpm db:status` lists 6 applied, none pending.
   - `Remove-Item Env:DATABASE_URL`
   - `pnpm crawl --region belgrade-small --dry-run` still exits 0.
   - None of these outputs contains `postgres://` or `wikimapia_local`.
8. `pnpm exec eslint src/db tests/db` reports no problems.
9. `pnpm exec tsc --noEmit` reports **exactly** these three errors and no others: `contracts/crawl-run1-fixes.test.ts:156` (U3), `src/crawl/requests.ts:65` (U5), `tests/crawl/report.test.ts:38` (U5). They are not yours to fix. Do not touch `src/crawl/`, `tests/crawl/` or `src/db/crawl-store.ts` to silence them. Any other error is yours.
10. Guards. Each of these returns nothing:
    - `Select-String -Path src/db/*.ts, src/db/migrations/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
    - `Select-String -Path src/db/migrations/20261022_02_create_item_failures.ts -Pattern "vector|geometry|geography|inet|cidr|user_ip|'places'|'comments'|'tags'|'place_tags'|page_number"`

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`, the `*.support.ts` files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test. Do not weaken the existing hydration-table column rules in `tests/db/crawl-schema.db.test.ts`. The new tables get their own AL4 2.1 rule set (2.1 B.3).
- Files you may change: those listed in AL4 U2 "Files" (`src/db/crawl-tables.ts`, the new migration, `src/db/migrations/index.ts`, `src/db/schema-setup.ts`, `src/db/rows.ts`, and the three test files). Nothing else in `src/`, `scripts/`, `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or docker files.
- Never edit an applied migration (`20261021_*`, `20261022_01_*`). The status change goes only into the new step.
- Never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.
- If a contract, the AL4 spec or this prompt looks wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing).

## 4. Out of Scope

Do not implement any of the following now:

- **U3:** the Failure Record write step and public reads: `src/db/failure-records.ts`, `FailureRowSchema`, `RetryRowSchema`, `validate.ts` additions, `src/db/types.ts` additions, `lockLiveRun` export, `recordItemFailure`, `readFailureRecords`, `readExplicitRetries`, the `CreateFailureAwareCrawlStoreFn` typing (the `contracts/crawl-run1-fixes.test.ts:156` tsc error). AL4 1.4.8, 2.5.
- **U4:** Parking (`src/db/parking.ts`, `ParkingRowSchema`), Explicit Retry releases in `beginRunStep`, the Parked-Place exclusion in `places-due.ts`, `regionTotals`, `listParkedPlaces`. AL4 1.4.5 to 1.4.7.
- **U5:** everything in `src/crawl/` and `tests/crawl/`, including the `requests.ts:65` and `report.test.ts:38` tsc errors, tally parking counts and summary lines.
- **U6 / U7:** Run orchestration, `--retry-parked`, the Dry Run count, the command output, and the contract cases AC-6, AC-15 to AC-40, the second AC-41 case, AC-42 and AC-46.
- Any data migration of stored Run Records (decision 5: read path only). Recording the AL4 decisions in `CLAUDE.md` (the orchestrator does this).
