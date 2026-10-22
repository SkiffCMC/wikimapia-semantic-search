# AL3 Routing: hydration, U1 "Crawl Progress schema step, `undoLast`, `emptyStore` extension"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U1 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md`, section "4. Implementation Units", "U1".
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `src/db/` is the finished storage feature (`createPlaceStore`, `createSchemaSetup`, 4 migration steps). `contracts/storage.schema.ts` has been extended by AL5: the `SchemaSetup` interface now requires `undoLast()`. As a result, `pnpm exec tsc --noEmit` currently fails in `src/db/schema-setup.ts`. This unit fixes that error.
- `contracts/hydration.test.ts` imports four modules that do not exist yet (`src/crawl/command`, `src/crawl/run-crawl`, `src/crawl/tile-plan`, `src/db/crawl-store`). Those TS2307 errors and their 4 lint errors are the expected baseline until U7 (AL4 section 4, "Baseline caveat"). Do not create stubs for them.
- `contracts/storage.test.ts` can load (its entry point `src/db/place-store.ts` exists). Its AC-5 check has already been narrowed by AL5 to "no embeddings or vectors", so it allows crawl tables.
- `tests/db/schema-setup.db.test.ts` still has the old, wider AC-5 check (it forbids table names matching `crawl|progress|...`). It will fail as soon as the new step exists, so it must be updated (section 2.1).

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, extensionless relative imports, `unknown` only where `.agrules` 5 allows it, types in `src/db/types.ts`, no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 3, 4 and 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read only these sections: "0. Scope and Fixed Points" (table row "Schema Setup", "Single source of truth", "Code style"); "1.1 Module map" (rows `src/db/crawl-tables.ts`, the migration, `migrations/index.ts`, `schema-setup.ts`); "1.4.12 Schema Setup changes"; "1.5 Transaction boundaries" (row "Schema step"); "2. Data Model Design" (2.1 to 2.5); "4. Implementation Units", "U1"; "5. AL2 Guidance" (bullets "Imports", "`unknown`", "Do not edit `contracts/`"). |
| 4 | `contracts/storage.schema.ts` | `SchemaSetup` (with `undoLast`, `emptyStore` doc), `SchemaStepsResultSchema`, `EmptyResultSchema`, `STORE_TABLES`, `TEST_DATABASE_NAME_SUFFIX`. |
| 5 | `contracts/storage.test.ts` | Read only the lifecycle block (around "Lifecycle: one Test Database") and AC-1 to AC-6, AC-14, AC-61. Must stay green. |
| 6 | `contracts/hydration.test.ts` | Read only "3.9 Schema Setup for Crawl Progress" (AC-55 to AC-58, around line 1908). These are the end-to-end checks your schema must satisfy later (they run in U7). |
| 7 | `contracts/hydration.schema.ts` | Only `RunRecordStatusSchema` and `RegionNameSchema` (the status list and Region Name rule the CHECKs must match). |
| 8 | `src/db/schema-setup.ts` | File to change. |
| 9 | `src/db/migrations/index.ts` | File to change (append the 5th step). |
| 10 | `src/db/migrations/20261021_03_create_tags.ts` | Style reference for a migration (named constraints, `table.check`, imports). |
| 11 | `src/db/inspect.ts` | `readAppliedSteps` (private today), `currentDatabaseName`. |
| 12 | `src/db/connection.ts`, `src/db/failures.ts` | `createDb`, `destroyQuietly`, `POOL_MAX_SETUP`; `storeUnavailable`, `unavailableFrom`. |
| 13 | `src/db/types.ts` | `NamedMigration`; where any new type alias must go. |
| 14 | `tests/db/schema-setup.db.test.ts` | Test file to update (test-writer). |
| 15 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD` (tests). |

Do not read the rest of `src/db/` (save paths, mappers, plan, place store) or anything under `src/wikimapia/`. They are not touched by this unit.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

Tests run against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Create every `SchemaSetup` and `Knex` handle so it is closed in `afterEach`/`afterAll`. `afterAll` must re-apply all steps, so later files start from a fully migrated database. Seed data with the Knex query builder through a `testDb()` handle (as the existing file does). Do not use raw SQL strings. Use synthetic values only.

**A. Update `tests/db/schema-setup.db.test.ts`** (keep everything not listed here):
1. `STEP_NAMES` gains `'20261022_01_create_crawl_progress'` as the 5th entry. Change the test titles and expectations from "four" to five where they mean all steps (`MIGRATIONS` list, `apply` from nothing returns 5 in order, `undoAll` returns 5 newest first, all 5 pending after `undoAll`). `undoAll` must also remove the three crawl tables.
2. Narrow the "Forbidden columns" AC-5 test to the contract's narrowed AC-5 (`contracts/storage.test.ts`, "AC-5 No embeddings or vectors of any kind"). Table and column names must not match `/embedding|vector/i`, and no `vector` udt is allowed. Drop the `crawl|progress|visit|...` table-name check and the `visited|crawled|progress|cursor` column check. The AC-6 and AC-14 tests stay as they are and now also cover the crawl tables.
3. `allFailures` also covers `undoLast` (parsed with `SchemaStepsResultSchema`). The empty-string and unreachable-URL tests then assert `store_unavailable` without secrets for `undoLast` too.
4. New `undoLast` cases (restore with `apply` in `afterEach`):
   - `undoLast` returns exactly `['20261022_01_create_crawl_progress']`. Afterwards `inspect` shows 4 applied steps and 1 pending, none of `crawl_runs`, `crawl_passes`, `crawl_finished_pages` exist, and all four `STORE_TABLES` remain. A Place seeded before the undo (via `PlaceModel`, or a `TagModel` row as the existing test does) is unchanged afterwards.
   - A second `undoLast` returns exactly `['20261021_04_create_comments']`, then `apply` re-applies both.
   - After `undoAll`, `undoLast` returns `{ steps: [] }`.
5. New `emptyStore` cases:
   - With one synthetic row in each crawl table plus one store row, `emptyStore` clears all seven tables. Use the `CRAWL_TABLES` names from `src/db/crawl-tables`.
   - After `undoLast` (crawl tables absent), `emptyStore` resolves `{ ok: true, value: {} }`.
   - After `undoAll`, it still resolves `store_unavailable` (the existing test, keep it).

**B. Create `tests/db/crawl-schema.db.test.ts`** (AL4 2.1 to 2.5):
1. `CRAWL_TABLES` equals `{ runs: 'crawl_runs', passes: 'crawl_passes', finishedPages: 'crawl_finished_pages' }`, and `CRAWL_REGION_LOCK_CLASS` is `20261022`.
2. Exact columns of the three tables, in order, as `[name, udtName]` pairs per AL4 2.2 to 2.4 (`bigserial` is `int8`, `timestamptz(0)` is `timestamptz`, `double precision` is `float8`, `jsonb`, `bool`).
3. Column rules for every crawl column. No name may match the AL4 2.1 regexes: `/embedding|vector/i`, `/user_?ip|commenter_?ip/i`, `/^(page|page_?size|page_?number|count|found|total_?found|total)$/i`, `/description|message|comment|title|author|user_?ip|outline|polygon/i`. No udt may be `geometry`, `geography`, `inet`, `cidr` or `vector`.
4. Constraints. Each of these inserts is rejected, and a valid control row is accepted:
   - a `crawl_runs` row with status `'running'`;
   - `in_progress` with a non-null `ended_at`;
   - `completed` with a null `ended_at`;
   - `ended_at` before `started_at`;
   - `last_activity` before `started_at`;
   - a Region Name `'Belgrade'` (uppercase);
   - a second `in_progress` row for the same Region (a second one for another Region is accepted, and so is a second `completed` row for the same Region);
   - a `crawl_passes` row with `bbox_west >= bbox_east`, with `tile_width = 0`, or with `tile_count = 0`;
   - a `crawl_finished_pages` row with `page_no = 0`, or with an unknown `(region_name, pass_number)`;
   - a second `is_short = true` row for the same tile of a pass (a second non-short page of that tile is accepted).
5. `emptyStore` resets identity: after `emptyStore`, a new `crawl_runs` row inserted without `run_id` gets `run_id` 1 (`RESTART IDENTITY`).

The new tests are expected to fail until `add-coder` has finished. Do not stub the production modules.

### 2.2 add-coder

1. **`src/db/crawl-tables.ts`** (new). Add the constants `CRAWL_TABLES` (`as const`) and `CRAWL_REGION_LOCK_CLASS = 20261022`, exactly as listed in AL4 1.1. Do not import anything from `src/crawl/`.
2. **`src/db/migrations/20261022_01_create_crawl_progress.ts`** (new). Use the style of the existing steps: import `type { Knex }` and the table names from `../crawl-tables`.
   - `up` creates `crawl_runs`, `crawl_passes`, `crawl_finished_pages` with exactly the columns, nullability, PKs, FKs (with their `ON DELETE` rules), CHECKs and indexes of AL4 2.2 to 2.4. Give every constraint and index an explicit name (`<table>_<rule>`). The partial unique index on runs is named `crawl_runs_one_live_per_region`. Region Name CHECKs use the AL4 2.1 regex.
   - Use `knex.raw` only for constant DDL text (partial unique indexes, CHECKs the builder cannot express).
   - `down` drops `crawl_finished_pages`, `crawl_passes`, `crawl_runs`, in that order.
   - Touch no storage table. Add no `vector` column, no extension and no Objection model.
3. **`src/db/migrations/index.ts`**. Append `{ name: '20261022_01_create_crawl_progress', up, down }` as the 5th `MIGRATIONS` entry. Change nothing else.
4. **`src/db/schema-setup.ts`** (AL4 1.4.12):
   - `undoLast()`: read the applied step names first. If none are applied (including when the migration table does not exist), resolve `{ ok: true, value: { steps: [] } }` without calling Knex's migrator. Otherwise call `db.migrate.down(MIGRATION_CONFIG)` into a `const result: unknown` and parse it with the existing `MigrateResultSchema`. Return `{ steps }` (exactly the newest step). Catch errors and map them with `unavailableFrom(error, 'schema setup undo last')`.
   - To read the applied steps, export the existing `readAppliedSteps` from `src/db/inspect.ts`. Make no behaviour change there; this export is the only allowed edit to `inspect.ts`. Do not duplicate its SQL.
   - `emptyStore()`: keep the `_test` guard. Then, in one transaction, run the existing `TRUNCATE TABLE place_tags, comments, tags, places`. After that, check whether `crawl_runs` exists with a parameterized `select to_regclass(?) is not null` (bind the table name from `CRAWL_TABLES`). Parse the raw result with a small Zod schema on the next line. If the table exists, run `TRUNCATE TABLE crawl_finished_pages, crawl_passes, crawl_runs RESTART IDENTITY`. Both TRUNCATE texts are constants. If the store tables are missing, the result stays `store_unavailable`; if the crawl tables are missing, skip them silently.
   - `notConfiguredSetup()` gains `undoLast` that resolves the not-configured failure.
   - Keep the factory and methods non-throwing and non-rejecting. Never copy a driver error message.
   - Any new type alias goes in `src/db/types.ts`. A local Zod schema next to `MigrateResultSchema` is fine. Do not add the U3 row schemas (`RunRowSchema` and the others) to `rows.ts`.
5. Do not change `scripts/db-migrate.ts`, `scripts/db-status.ts` or `package.json`. They pick up the new step through `MIGRATIONS`.
6. **Stop and report, do not work around:** stop and report if `db.migrate.down` with the static `migrationSource` does not undo exactly the newest step, if Knex cannot express a required constraint without non-constant SQL, or if a contract test contradicts AL4 2.2 to 2.4.
7. Run every Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise). `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.

1. `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts tests/db/crawl-schema.db.test.ts contracts/storage.test.ts contracts/storage.schema.test.ts` passes: no failures, no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/wikimapia contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
3. `pnpm db:status --test` exits 0 and lists 5 applied steps, none pending.
4. Development Database (the value is the local default from `.env.example`, not a secret):
   - `$env:DATABASE_URL = 'postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia'`
   - `pnpm db:migrate` exits 0 and applies exactly one new step, `20261022_01_create_crawl_progress`. If the Development Database had no steps before, it applies all 5; report which case applied.
   - A second `pnpm db:migrate` applies none.
   - `pnpm db:status` lists 5 applied, none pending.
   - `Remove-Item Env:DATABASE_URL`
   - None of these outputs contains `postgres://` or `wikimapia_local`.
5. `pnpm exec eslint src/db tests/db` reports no problems.
6. `pnpm exec tsc --noEmit` reports only TS2307 (unresolved module) errors in `contracts/hydration.test.ts` for `src/crawl/command`, `src/crawl/run-crawl`, `src/crawl/tile-plan` and `src/db/crawl-store`. The `src/db/schema-setup.ts` error is gone. `pnpm lint` reports problems only in `contracts/hydration.test.ts`, and only those that follow from the same four missing modules.
7. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/*.ts, src/db/migrations/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/db/migrations/20261022_01_create_crawl_progress.ts -Pattern "vector|geometry|geography|inet|cidr|user_ip|places|comments|tags"`
   - `Test-Path src/crawl` is `False`, and `Test-Path src/db/crawl-store.ts` is `False`.

Do not run `contracts/hydration.test.ts` or `pnpm test:db` as a gate. The contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the `*.support.ts` files).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test. The only test weakening allowed is the AC-5 narrowing in `tests/db/schema-setup.db.test.ts` described in 2.1 A.2, which mirrors the AL5 change.
- Files you may change: those listed in AL4 U1 "Files", plus the single `readAppliedSteps` export in `src/db/inspect.ts`. Nothing else in `src/db/`, `scripts/`, `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or docker files.
- Never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, anything under `src/wikimapia/`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U2:** `src/crawl/` entirely (`types.ts`, `tile-plan.ts`, `config.ts`, `report.ts`).
- **U3:** crawl row schemas in `rows.ts`, crawl types in `src/db/types.ts`, `validate.ts` additions, `places-due.ts`, `crawl-progress.ts`, `crawl-store.ts` (`createCrawlStore`, `readCrawlProgress`).
- **U4:** `beginRunStep` and the other write steps, `crawl-repository.ts`, the `writeListingPage` extraction in `save-listing.ts`, use of `CRAWL_REGION_LOCK_CLASS` in advisory locks.
- **U5 to U7:** gateway, requests, runtime, phases, `runCrawl`, the command, `scripts/crawl.ts`, and the `crawl` and `test:db` scripts in `package.json`.
- Making `contracts/hydration.test.ts` green (U7). Recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator does this).
