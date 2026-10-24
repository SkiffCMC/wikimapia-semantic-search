# AL3 Routing: embeddings, U1 "Embedding storage schema step, `emptyStore` extension, existing schema tests"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U1 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U1".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md` (stakeholder-approved).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `src/db/` holds the finished storage, hydration and crawl-run1-fixes work: 6 Schema Setup steps in `src/db/migrations/index.ts` (newest `20261022_02_create_item_failures`), `createSchemaSetup` with `apply`, `undoAll`, `undoLast`, `inspect`, `emptyStore`. The `vector` extension is already enabled by step 1.
- AL5 has amended three contracts for this feature:
  - `contracts/storage.test.ts` "AC-5 Vectors only in the Embedding Record of a Place" now requires exactly one `vector` column, `place_embeddings.embedding`. It **fails today** (no such column). This unit makes it green. The file imports only constants from `./embeddings.schema`, so it loads now.
  - `contracts/storage.schema.ts` `SchemaSetup.emptyStore` doc: emptying also removes every Embedding Record.
  - `contracts/crawl-run1-fixes.test.ts` AC-41 now undoes newest-first until `crawl_item_failures` is gone, so it tolerates a newer step 7.
- `contracts/embeddings.test.ts` imports four modules that do not exist yet (`src/db/embedding-store`, `src/embed/command`, `src/embed/place-document`, `src/embed/run-embedding`). Those unresolved-import errors in `tsc` and the matching 4 lint errors are the expected baseline until U2, U3, U6, U7 (AL4 section 4, "Baseline caveat"). Do not create stubs for them, and do not run that file as a gate.
- `tests/db/schema-setup.db.test.ts` and `tests/db/crawl-schema.db.test.ts` assume step 6 is the newest step and that there is no vector column. They will fail as soon as step 7 exists, so they must be updated (section 2.1).
- The Postgres service from `docker-compose.yml` is running on `127.0.0.1:5433` (image `postgis/postgis:16-3.6` plus `postgresql-16-pgvector`, which supports HNSW). `.env.test` exists.

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, extensionless relative imports, `unknown` only where `.agrules` 5 allows it (raw `trx.raw` results parsed with Zod on the next line), types in `src/db/types.ts`, no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 2 (one model per column, 1024 dims), 3 (SQL only in `src/db/`, parameterized, migrations), 4 and 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only: "0. Scope and Fixed Points" (rows "Schema Setup", "Storage names"; "Code style"; "Current red state"); "0.1 Decisions" (row "Embedding storage"); "1.1 Module map" (rows for the migration, `migrations/index.ts`, `schema-setup.ts`, and the "Unit tests" paragraph below the second table); "1.4.9 Schema Setup change"; "1.5 Transaction boundaries" (rows "Schema step 7", "`emptyStore`"); "2.1 `place_embeddings`" and "2.2 Migration"; "4. Implementation Units" intro, "Baseline caveat" and "U1"; "5. AL2 Guidance" (bullets "Test files", "Imports", "`unknown`", last bullet). |
| 4 | `contracts/embeddings.schema.ts` | Only the storage constants around lines 30-160: `EMBEDDING_TABLE`, `EMBEDDING_COLUMN`, `EMBEDDING_COLUMNS`, `EMBEDDED_AT_UDT_NAME`, `SIMILARITY_INDEX`, `EMBEDDING_DIMENSIONS`, and the module doc comment describing the storage. Tests may import these; the migration must not (frozen literals). |
| 5 | `contracts/embeddings.support.ts` | Only to see `fakeEmbedding` / vector helpers, if any are exported, for generating 1024-value test vectors in code. Do not use the Simulated Embedding Service here. |
| 6 | `contracts/embeddings.test.ts` | Read only "AC-53" to "AC-58" (around lines 1696-1816). These are the end-to-end checks your schema must satisfy later (they run in U7). Do not run this file. |
| 7 | `contracts/storage.schema.ts` | `SchemaSetup` (the `emptyStore` doc around line 584), `SchemaStepsResultSchema`, `EmptyResultSchema`, `STORE_TABLES`, `StoreStructureResultSchema`. |
| 8 | `contracts/storage.test.ts` | Read only the lifecycle block, AC-1 to AC-6 (AC-5 at line ~386-408), AC-14, AC-61. Must be green after this unit. |
| 9 | `contracts/crawl-run1-fixes.test.ts` | Read only AC-41 and AC-42 (lines ~1529-1620). Must stay green. |
| 10 | `src/db/schema-setup.ts` | File to change (`emptyStore`). |
| 11 | `src/db/migrations/index.ts` | File to change (append the 7th step). |
| 12 | `src/db/migrations/20261022_02_create_item_failures.ts` | Style reference for a migration (named PK/FK/CHECKs, `MOMENT`, constant `knex.raw` DDL). |
| 13 | `src/db/types.ts` | `NamedMigration`; where any new type alias must go. |
| 14 | `src/db/crawl-tables.ts` | `CRAWL_TABLES` (used by tests and the existing `emptyStore`). |
| 15 | `tests/db/schema-setup.db.test.ts` | Test file to update (test-writer). |
| 16 | `tests/db/crawl-schema.db.test.ts` | Test file to update (test-writer), the case at line ~485. |
| 17 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD` (tests). |

Do not read the rest of `src/db/` (read/save paths, mappers, crawl store, repository), `src/crawl/` or `src/wikimapia/`. They are not touched by this unit.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's API keys.

## 2. Execution Directives

### 2.1 add-test-writer

Tests run against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Close every `SchemaSetup` and `Knex` handle in `afterEach`/`afterAll`. `afterAll` (and every `afterEach` after an undo) must re-apply all steps, so later files start from a fully migrated database. Synthetic values only. Never paste a vector as a literal list of numbers (contract AC-59 scans `tests/` for runs of 1024 numbers and for files over 512 KB): build the `'[v1,...,vN]'` text in code (e.g. `Array.from({ length: n }, ...)`), and do not import `src/db/vector.ts` (it does not exist until U2).

**A. Update `tests/db/schema-setup.db.test.ts`** (AL4 U1, "Existing tests to update"; keep everything not listed here):
1. `STEP_NAMES` gains `'20261023_01_create_place_embeddings'` as the 7th entry. Add `EMBEDDINGS_STEP` and `UP_TO_FAILURES_STEPS = STEP_NAMES.slice(0, 6)`. Test titles that say "six" meaning all steps say "seven".
2. Every `undoLast` sequence first undoes `EMBEDDINGS_STEP`: "undoes exactly step 6 ..." becomes "undoes exactly step 7, then step 6 ..."; the "a second / third undoLast" case gains one leading step; the "quota_exhausted Run Record ... undo of step 6" case gets one extra leading `undoLast`; the `emptyStore` cases "after undoLast of step 6" and "after two undoLast" get one extra leading `undoLast`. `after.pendingSteps` expectations gain `EMBEDDINGS_STEP` (e.g. `[FAILURES_STEP, EMBEDDINGS_STEP]`, `[CRAWL_STEP, FAILURES_STEP, EMBEDDINGS_STEP]`), and `apply` after those undos returns the undone steps oldest first.
3. Replace the "AC-5: no vector or embedding table or column" case with the contract's replaced AC-5: `vector` stays enabled; the only column with udt `vector` is `place_embeddings.embedding`; no other table or column name matches `/embedding|vector/i`. AC-6 and AC-14 cases stay as they are and now also cover `place_embeddings`.
4. `EXPECTED_COLUMNS` gains `place_embeddings`: `place_id int8`, `embedding vector`, `embedding_model text`, `document_fingerprint text`, `embedded_at timestamptz`, in that order.
5. Data seeding in this file stays through the models (its existing rule); do not add SQL here. Embedding rows are seeded only in the new file (C).

**B. Update `tests/db/crawl-schema.db.test.ts`** (line ~485): "step 6 is the newest applied step ..." becomes "step 6 is applied directly after step 5 ...", asserting `appliedSteps.indexOf(FAILURES_STEP) === appliedSteps.indexOf(CRAWL_STEP) + 1` (add a `CRAWL_STEP` constant if missing) and no longer asserting it is the last. Nothing else changes.

**C. Create `tests/db/embedding-schema.db.test.ts`** (AL4 2.1, 2.2, 1.4.9; AL4 U1 "Unit tests must cover"). Use the constants from `contracts/embeddings.schema.ts` and `STORE_TABLES` / `CRAWL_TABLES` for names. Seed Places, Tags, Comments and a crawl Run row with the Knex query builder or models through a `testDb()` handle; embedding rows are inserted through the same handle with `embedding` bound as `trx.raw('?::vector', [text])` (a binding, never interpolated). Cases:
1. `apply` after `undoAll` returns the 7 steps in order.
2. `undoLast` returns exactly `['20261023_01_create_place_embeddings']`; afterwards `place_embeddings` is absent, no column anywhere has udt `vector`, every other table remains, and a stored Place, Tag, Comment and crawl Run row are unchanged. Re-`apply` returns that step only. (Restore with `apply` in `afterEach`.)
3. Structure via `setup.inspect()`: the columns of item A.4; `embedded_at` udt equals `EMBEDDED_AT_UDT_NAME`.
4. Accepted: one row with a 1024-value vector, a non-empty model and a 64-char lower-case hex fingerprint for a stored Place.
5. Rejected (each with a valid control row accepted): 1023 values; a Place ID not in `places` (FK); `embedding_model = ''`; an upper-case fingerprint; a 63-char fingerprint; a second row for the same Place (PK). Assert only that the insert rejects (optionally by SQLSTATE: `23503`, `23514`, `23505`; dimension mismatch is a pgvector error, assert rejection only). Never assert on driver message text.
6. FK cascade: deleting the stored Place removes its embedding row (AL4 2.1 `ON DELETE CASCADE`).
7. `emptyStore` removes the embedding row together with the Place (all store tables and `place_embeddings` empty), and still resolves `{ ok: true, value: {} }` and clears the store tables after `undoLast` of step 7.
8. Index: reading `pg_indexes` through `testDb()` (parameterized `where tablename = ?`) shows `place_embeddings_embedding_hnsw_idx` whose definition uses `hnsw` and `vector_cosine_ops`, and it has no `WHERE` clause.

The new and changed tests are expected to fail until `add-coder` has finished. Do not stub production modules.

### 2.2 add-coder

1. **`src/db/migrations/20261023_01_create_place_embeddings.ts`** (new; AL4 2.1, 2.2). Same style as step 6: `import type { Knex }`; table and column names as frozen string literals (do not import from `contracts/`).
   - `up`: `createTable('place_embeddings')` with `bigInteger('place_id')`, `specificType('embedding', 'vector(1024)')`, `text('embedding_model')`, `text('document_fingerprint')`, `timestamp('embedded_at', { useTz: true, precision: 0 })`, all not null, in that column order. Named constraints exactly as AL4 2.1: `place_embeddings_pkey` on `place_id`; `place_embeddings_place_id_fkey` -> `places(place_id)` `ON DELETE CASCADE`; checks `place_embeddings_embedding_model_not_empty` and `place_embeddings_document_fingerprint_valid`. Then the constant `knex.raw` `CREATE INDEX place_embeddings_embedding_hnsw_idx ON place_embeddings USING hnsw (embedding vector_cosine_ops)` (no build parameters, not partial).
   - `down`: `dropTable('place_embeddings')`.
   - Touch no earlier table. Create no extension (step 1 has it). No Objection model.
2. **`src/db/migrations/index.ts`**: import the module and append `{ name: '20261023_01_create_place_embeddings', up, down }` as the 7th `MIGRATIONS` entry. Change nothing else.
3. **`src/db/schema-setup.ts`** `emptyStore()` (AL4 1.4.9): keep the `_test` guard and the single transaction. Inside it, **before** the store truncate, probe `place_embeddings` with the existing `TABLE_EXISTS` text and a binding (parse with `TableExistsResultSchema` on the next line). If present run a new constant `TRUNCATE TABLE place_embeddings, place_tags, comments, tags, places`; otherwise the existing `TRUNCATE_STORE_TABLES`. The crawl-table part is unchanged. The table name used for the binding is a local constant in `src/db/` (e.g. alongside the other names in `schema-setup.ts`); do not add a runtime import of `contracts/embeddings.schema` to `src/db/schema-setup.ts` unless you keep it to constants only. No other method changes: `apply`, `undoAll`, `undoLast`, `inspect` pick up the step from `MIGRATIONS`.
4. Keep the factory and methods non-throwing and non-rejecting; never copy a driver error message. Any new type alias goes in `src/db/types.ts` (none should be needed).
5. Do not change `scripts/`, `package.json` (no `pgvector` or `voyageai` yet; that is U2/U5), `docker-compose.yml`, `docker/`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`.
6. **Stop and report, do not work around:** if the Docker image's pgvector cannot build an HNSW index, if `undoAll` fails because step 1's `DROP EXTENSION vector` is blocked, if `specificType('embedding', 'vector(1024)')` does not appear in `inspect()` as udt `vector`, or if a contract test contradicts AL4 2.1/2.2.
7. Run every Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise). `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.

1. `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts tests/db/crawl-schema.db.test.ts tests/db/embedding-schema.db.test.ts contracts/storage.test.ts contracts/storage.schema.test.ts contracts/crawl-run1-fixes.test.ts contracts/hydration.test.ts` passes: no failures, no skipped or todo tests. `contracts/storage.test.ts` "AC-5 Vectors only in the Embedding Record of a Place" is among the passing tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/crawl tests/wikimapia contracts/embeddings.schema.test.ts contracts/hydration.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
3. `pnpm db:status --test` exits 0 and lists 7 applied steps, none pending.
4. Development Database (the value is the local default from `.env.example`, not a secret):
   - `$env:DATABASE_URL = 'postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia'`
   - `pnpm db:migrate` exits 0 and applies exactly one new step, `20261023_01_create_place_embeddings` (if the Development Database was behind, report which steps it applied).
   - A second `pnpm db:migrate` applies none.
   - `pnpm db:status` lists 7 applied, none pending.
   - `Remove-Item Env:DATABASE_URL`
   - None of these outputs contains `postgres://` or `wikimapia_local`.
5. `pnpm exec eslint src/db tests/db` reports no problems.
6. `pnpm exec tsc --noEmit` reports only the unresolved-module errors in `contracts/embeddings.test.ts` for `src/db/embedding-store`, `src/embed/command`, `src/embed/place-document`, `src/embed/run-embedding`. `pnpm lint` reports problems only in `contracts/embeddings.test.ts`, and only those that follow from the same four missing modules.
7. Guards. Each returns nothing:
   - `Select-String -Path src/db/*.ts, src/db/migrations/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/db/migrations/20261023_01_create_place_embeddings.ts -Pattern "contracts/|CREATE EXTENSION|inet|cidr|user_ip|description|message"`
   - `Select-String -Path tests/db/embedding-schema.db.test.ts -Pattern "(-?\d+(\.\d+)?\s*,\s*){50}"` (no pasted vector literal)
   - `Test-Path src/embed` is `False`, and `Test-Path src/db/embedding-store.ts` is `False`.

Do not run `contracts/embeddings.test.ts` or `pnpm test:db` as a gate: the contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the `*.support.ts` files).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test. The only test changes allowed in existing files are those in 2.1 A and B, which mirror the AL5 amendments.
- Files you may change: exactly those in AL4 U1 "Files" (`src/db/migrations/20261023_01_create_place_embeddings.ts`, `src/db/migrations/index.ts`, `src/db/schema-setup.ts`, `tests/db/schema-setup.db.test.ts`, `tests/db/crawl-schema.db.test.ts`, `tests/db/embedding-schema.db.test.ts`). Nothing else in `src/`, `scripts/`, `package.json`, `.env.example`, config or docker files.
- Never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U2:** `pgvector` dependency, `src/db/vector.ts`, embedding row schemas in `rows.ts`, `types.ts` additions, `validate.ts` validators, `read.ts` exports and multi-Place loaders, `createRunWideHook` in `writer.ts` and its use in `crawl-repository.ts`, `embedding-read.ts`, `embedding-save.ts`, `embedding-store.ts` (`createEmbeddingStore`, `inspectEmbeddingStorage`, `countEmbeddingStore`).
- **U3:** `src/embed/place-document.ts`, `src/embed/types.ts`.
- **U4 to U6:** settings, Batch cutting, tally and summary, the Voyage adapter (`voyageai` dependency), `sendBatch`, `runEmbedding`.
- **U7:** `src/embed/command.ts`, `scripts/embed.ts`, the `embed` and extended `test:db` scripts in `package.json`, `.env.example` lines; making `contracts/embeddings.test.ts` green.
- Recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator does this).
