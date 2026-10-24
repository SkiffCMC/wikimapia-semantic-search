# AL3 Routing: embeddings, U2 "Embedding Store (public `createEmbeddingStore`)"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U2 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U2".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md` (stakeholder-approved).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 is done and verified: Schema Setup step 7 `src/db/migrations/20261023_01_create_place_embeddings.ts` (table `place_embeddings`, HNSW cosine index) is registered as the 7th entry of `MIGRATIONS`. `emptyStore()` also truncates `place_embeddings`. All tests are green. `tests/db/embedding-schema.db.test.ts` exists and seeds embedding rows through its own `testDb()` handle.
- `pnpm exec tsc --noEmit` shows exactly 4 errors today: the unresolved modules `src/db/embedding-store`, `src/embed/command`, `src/embed/place-document`, `src/embed/run-embedding` in `contracts/embeddings.test.ts`. After this unit, the `src/db/embedding-store` error must be gone and the other 3 remain (AL4 section 4, "Baseline caveat").
- `contracts/embeddings.test.ts` still cannot load (3 entry modules remain missing until U3, U6, U7). Do not run it as a gate, and do not stub the missing modules.
- `pgvector` is not installed yet. `voyageai` is not installed and must not be (U5).
- The Postgres service from `docker-compose.yml` runs on `127.0.0.1:5433`. `.env.test` exists. The Test Database has all 7 steps applied.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:
- Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Top-level `import type`; extensionless relative imports.
- `unknown` only where `.agrules` 5 and AL4 section 5 "`unknown`" allow it.
- Every new type alias or interface goes in `src/db/types.ts`.
- No `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Mainly section 2 (1024 dims, model recorded per vector), section 3 (SQL only in `src/db/`, bindings only), section 4 (no secrets, no live calls, strict types) and section 5. |
| 2 | `CLAUDE.md` | Stack and decisions ("Database access": Knex plus the `pgvector` npm package). Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only these parts. "0. Scope and Fixed Points": the Entry point 4 row, the "Helpers to reuse" row, "Single source of truth", "Code style". "0.1 Decisions": the rows "Embedding storage", "Vector encoding", "Write-hook numbering". "1.1 Module map": the first table (database side) and the "Unit tests" paragraph. "1.3 Component contracts": the `src/db/*.ts (additions)` and `src/db/types.ts (additions)` blocks, plus the `InvalidDataError` paragraph below them. "1.4.8 Embedding Store" in full, including the `vector.ts` paragraph at its end. "1.5 Transaction boundaries". "2.1 `place_embeddings`". "4. Implementation Units": the intro, "Baseline caveat" and "U2". "5. AL2 Guidance": the bullets "Never copy error messages", "No transaction across requests or waits", "`exactOptionalPropertyTypes`", "Close every pool", "Test files", "Imports", "`unknown`". |
| 4 | `contracts/embeddings.schema.ts` | Lines ~130-160 (storage constants, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MODEL`). Lines ~250-300: `EmbeddingSchema`, `DocumentFingerprintSchema`, `EmbeddingRecordSchema`. Lines ~783-926, "Embedding Store": every input, value and result schema, `EmbeddingStoreOptions`, `EmbeddingStore`, `CreateEmbeddingStoreFn`. Import these and do not redefine them. |
| 5 | `contracts/embeddings.support.ts` | `fakeEmbedding`, `fakeVector`, `syntheticDetails`, `syntheticName`, `SYNTHETIC_TAG`, `storedComments` / `commentsFrom` (for the nested Replies / Gone Comment case). No Simulated Embedding Service in this unit. |
| 6 | `contracts/embeddings.test.ts` | Read only these. Helpers at lines ~187-300: `keepRecord`, `recordOf`, `embedCounts`, `seedSynthetic`, `saveRecordedListing`, and `storageInfo` at ~1690. "AC-39" (~1165-1232). "AC-53" to "AC-58" (~1696-1816). "R2 Embedding Store read" (~1822-1875). These are the black-box checks that U7 runs against your store. Mirror them in unit tests; do not run this file. |
| 7 | `contracts/storage.schema.ts` | `storeResultSchema`, `StoreConfigSchema`, `WriteHook`, `StoreFailure`/issue shapes, `DetailedPlaceSchema`, `STORE_TABLES`, `PlaceStore.readPlace`. |
| 8 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`, `clientDetails`, `clientListing`, `FETCHED_AT`, `LATER_FETCHED_AT`, `EVEN_LATER_FETCHED_AT`, `nestedDetails`. |
| 9 | `src/db/place-store.ts` | The pattern to copy: `openDb`, `guarded`, `readFailure` / `saveFailure`, `READ_TRANSACTION_CONFIG`, messages, `close`. |
| 10 | `src/db/read.ts` | File to change. It already has `PLACE_COLUMNS`, `FETCHED_AT_TEXT_SQL`, `TAG_LINKS_OF_PLACE_SQL` and the single-Place loaders. |
| 11 | `src/db/mappers.ts` | `toDetailedPlace`, `orderStoredTags`, `buildStoredComments`. Reuse them; do not change them. |
| 12 | `src/db/rows.ts` | File to change. It holds the existing row schemas (`PlaceRowSchema`, `CommentRowSchema`, `TagLinkRowSchema`, int8 handling). |
| 13 | `src/db/types.ts` | File to change. It holds `StoreResult`, `Validated`, the row types and `Writer`. |
| 14 | `src/db/validate.ts` | File to change. Follow the existing validator style (`validatePlaceRef`, issue mapping). |
| 15 | `src/db/writer.ts` | File to change (`createRunWideHook`). |
| 16 | `src/db/crawl-repository.ts` | Refactor only: replace the private `runWideHook` at line ~140 with `createRunWideHook`. |
| 17 | `src/db/connection.ts`, `src/db/failures.ts` | `createDb`, `POOL_MAX_STORE`, `destroyQuietly`; `storeUnavailable`, `unavailableFrom`, and how `invalid_data` failures are built. |
| 18 | `src/db/save-details.ts` | Style reference for a write step in a transaction using `createWriter(hook)`. |
| 19 | `tests/db/writer.test.ts`, `tests/db/validate.test.ts` | Test files to extend (test-writer). |
| 20 | `tests/db/embedding-schema.db.test.ts` | Reference for Test Database setup, `testDb()` and seeding in this feature. |
| 21 | `tests/db/details.db.test.ts` | Reference for seeding through `createPlaceStore` and comparing with `readPlace`. |
| 22 | `tests/db/crawl-repository.db.test.ts` | Must stay green after the hook refactor. Read it only if it fails. |
| 23 | `package.json` | `pgvector` is added through `pnpm add` (coder). |

Do not read `src/crawl/`, `src/wikimapia/`, the migrations or `schema-setup.ts`. U2 does not touch them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's API keys.

## 2. Execution Directives

### 2.1 add-test-writer

General rules:
- Every DB test runs against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Apply Schema Setup in `beforeAll`, call `emptyStore()` in `beforeEach`, and close every store, setup and `Knex` handle in `afterEach`/`afterAll`.
- A test that runs `undoLast` must re-`apply` in `afterEach`.
- Seed Places only through `createPlaceStore` (`saveListingPage`, `savePlaceDetails`) with the recorded fixtures (`clientDetails('getbyid-62587.json')`, `'getbyid-1381893.json'`, the recorded listing via `clientListing`) and `syntheticDetails`.
- Seed Embedding Records through the store under test, not raw SQL.
- Vectors come only from `fakeEmbedding` / `fakeVector`. No literal number lists (contract AC-59). No file over 512 KB. Synthetic values only.
- Assert on failure `kind`, issue `path` and the absence of secrets. Never assert on driver message text.

**A. `tests/db/vector.test.ts`** (new, pure; covers AL4 1.4.8 `vector.ts`):
- `parseVectorText(toVectorLiteral(fakeEmbedding('x')))` equals `fakeEmbedding('x')` exactly.
- `toVectorLiteral` yields text that starts with `[` and ends with `]` and holds 1024 comma-separated values.
- `parseVectorText` of a short literal (e.g. 3 values built in code) returns those numbers.

**B. `tests/db/writer.test.ts`** (add cases; keep the existing ones): `createRunWideHook`.
- `undefined` in gives `undefined` out.
- One run-wide hook shared by two `createWriter` writers sees 1, 2, 3 across both writers, in order.
- A throwing inner hook makes that `run` reject.
- Two separate `createRunWideHook` calls number independently.

**C. `tests/db/validate.test.ts`** (add cases).
- `validateEmbeddingCandidatesInput`:
  - Accepts `{ limit: 1 }`, `{ limit: 1000 }` and `{ afterPlaceId: 1, limit: 5 }`.
  - Gives `invalid_data` for `limit` 0, 1001 and 1.5, for `afterPlaceId` -1 and 0, for an extra key, and for a non-object.
- `validateSaveEmbeddingRecordsInput`:
  - Accepts one valid record.
  - Gives `invalid_data` with an issue path starting `['records', i, ...]` for each AC-39 bad record: 1023 / 1025 / 1536 values, NaN, -Infinity, empty model, missing fingerprint, empty fingerprint.
  - Gives `invalid_data` for an empty `records` array, for 1001 records and for a duplicated Place ID.
  - Never puts input values into the messages.

**D. `tests/db/embedding-store.db.test.ts`** (new; AL4 U2 "Unit tests must cover", 1.4.8, 1.5, 2.1):
1. **R2 data set.** Seed the recorded listing, details 1381893, synthetic 300, details 62587, then one kept record for 62587.
   - `listEmbeddingCandidates({ limit: 1000 })` lists `[300, 62587, 1381893]`, and each `place` `toStrictEqual`s `PlaceStore.readPlace` of that Place.
   - Only 62587 has `embeddingRecord`, and it is `toStrictEqual` to the saved record. The others have no `embeddingRecord` key at all (`exactOptionalPropertyTypes`).
   - `{ afterPlaceId: 300, limit: 1 }` gives `[62587]`, and the Summary-Only listing Place is never listed.
2. **Read-back equality.** A Place with Gone Tags, nested Replies and a Gone Comment (seed by saving details twice, the second time without the Tag/Comment) is read back identically to `readPlace`.
3. **Invalid reads.** `limit` 0 / 1001 and `afterPlaceId` -1 give `invalid_data`, including on a store built with `UNREACHABLE_DATABASE_URL`, which proves no DB access.
4. **Unreachable store.** On `UNREACHABLE_DATABASE_URL`, every method resolves `store_unavailable`, the serialized failure contains neither `UNREACHABLE_PASSWORD` nor `postgres://`, and `close()` resolves twice. An unusable connection string (e.g. `''`) gives `store_unavailable` "not configured" and does not throw.
5. **Replace.** Saving one record, then a second for the same Place with different values, keeps 1 row (`countEmbeddingStore().embeddingRecords === 1`), and `readEmbeddingRecord` returns the second record's values. `embeddedAt` round-trips as the whole-second `...Z` text.
6. **AC-39.** Each bad record from C gives `invalid_data`, and the earlier record of 62587 is unchanged. One bad record among good ones keeps nothing (the good Place still has no record).
7. **Not a Detailed Place.** A record for the Summary-Only listing Place, or for an unknown Place ID (e.g. 777777), gives `invalid_data` with issue path `['records', i, 'placeId']` (check `i` with the bad record at index 1 of 2), and nothing is kept.
8. **Hook failure.** An `onWrite` hook that throws at write 1 (with a message containing a fake secret) rolls the Batch back, so no row exists. The result is `store_unavailable`, and the message does not contain the hook's text.
9. **Chunking.** 250 records for 250 synthetic Detailed Places are written in 3 statements: the hook sees 1, 2, 3, and `saved` is 250. The store-wide numbering continues across calls on the same store: a second save of 1 record calls the hook with 4.
10. **AC-56.** After a kept record for 62587, a Listing Save and two Details Saves (`LATER_FETCHED_AT`, then a changed description at `EVEN_LATER_FETCHED_AT`) leave `readEmbeddingRecord(62587)` unchanged.
11. **Reads and counts.**
    - `readEmbeddingRecord` gives `{ found: false, placeId }` for a Place without a record, and `invalid_data` for placeId 0.
    - `countEmbeddingStore` returns `{ summaryOnlyPlaces, detailedPlaces, embeddingRecords }` with exact numbers for a seeded mix, and all zeros on an empty store.
12. **Storage inspection.**
    - `inspectEmbeddingStorage` returns `table` `place_embeddings`, `column` `embedding`, dimensions 1024, `onePerPlace` true, and exactly one vector index: `place_embeddings_embedding_hnsw_idx`, method `hnsw`, operator class `vector_cosine_ops`, `partial` false.
    - After `setup.undoLast()` (step 7), it resolves `store_unavailable` without secrets. Re-apply in `afterEach`.
13. **Pool closed.** After `close()`, a method call resolves (does not reject).

The new tests are expected to fail until `add-coder` finishes. Do not stub production modules.

### 2.2 add-coder

Implement AL4 1.4.8 exactly. Import every schema, type and constant from `../../contracts/embeddings.schema` and `../../contracts/storage.schema`, using `import type` for types. Never copy or redefine them.

1. **Dependency.** Run `pnpm add pgvector` (runtime `dependencies`; keep whatever version specifier `pnpm add` writes). Do not add `voyageai`. Check that the installed package ships its own TypeScript declarations, and check the import form (`import pgvector from 'pgvector'` or named `toSql` / `fromSql`) under both Vitest and `tsx`. If it has no declarations, stop and report. Do not add `declare module`, `any` or `require`.
2. **`src/db/vector.ts`** (new): `toVectorLiteral(embedding: Embedding): string` via `toSql`, and `parseVectorText(text: string): number[]` via `fromSql`. If `fromSql`'s declared return type is not `number[]`, narrow it with a Zod array-of-numbers parse; never cast. This is the only module that knows the pgvector text format.
3. **`src/db/rows.ts`**: add `EmbeddingRowSchema`, `EmbeddingCountsRowSchema`, `TypmodRowSchema`, `KeyColumnRowSchema` and `VectorIndexRowSchema` with the columns in AL4 2.1 and 1.4.8. Counts are int8: parse them the way the existing count rows do.
4. **`src/db/types.ts`**: add the `z.infer` row types, `EmbeddingRowColumns` (AL4 1.3), and the `InvalidDataError` type if it is exported.
5. **`src/db/writer.ts`**: add `createRunWideHook` by moving `runWideHook` from `crawl-repository.ts` unchanged. **`src/db/crawl-repository.ts`**: delete the private function and use `createRunWideHook`. Behaviour must not change.
6. **`src/db/read.ts`**:
   - Export the existing `PLACE_COLUMNS` and `FETCHED_AT_TEXT_SQL`.
   - Add `selectTagLinksOfPlaces` (the `TAG_LINKS_OF_PLACE_SQL` select with `= any(?)` and the id array as one binding, or the query builder with `whereIn`) and `selectCommentRowsOfPlaces` (`whereIn place_id`, order by `place_id, num`).
   - Parse both through the existing row schemas. Leave every existing function unchanged.
7. **`src/db/validate.ts`**: add `validateEmbeddingCandidatesInput` and `validateSaveEmbeddingRecordsInput` (parameter `unknown`), using `EmbeddingCandidatesInputSchema` / `SaveEmbeddingRecordsInputSchema` and the existing issue mapping, so that paths are kept as `['records', i, ...]`.
8. **`src/db/embedding-read.ts`** (new): `selectEmbeddingCandidates`, `selectEmbeddingRecord`, `countEmbeddingStoreRows`, `readEmbeddingStorageInfo`, exactly as in AL4 1.4.8.
   - Every value travels as a binding: ids, limit, and table and column names for `to_regclass(?)` / `attname = ?`.
   - Group rows by `place_id` in TS, and map Places with `toDetailedPlace`.
   - Add `embeddingRecord` with a conditional spread only when a row exists.
   - Gate every value with its contract schema (`.parse`).
   - A missing table must throw, e.g. when `to_regclass` returns null or the typmod row is absent.
9. **`src/db/embedding-save.ts`** (new): `saveEmbeddingRecordsStep` and `InvalidDataError`, per AL4 1.4.8.
   - Use one READ COMMITTED transaction.
   - Check first that every Place is a Detailed Place; a missing Place throws `InvalidDataError` with path `['records', i, 'placeId']`.
   - Then upsert in chunks of 100, in input order, through `createWriter(hook)`. Write `embedding` as `trx.raw('?::vector', [toVectorLiteral(...)])` and use `onConflict('place_id').merge([...four columns])`.
   - Return `{ saved }`.
10. **`src/db/embedding-store.ts`** (new): `export const createEmbeddingStore: CreateEmbeddingStoreFn`, following the pattern of `place-store.ts` (AL4 1.4.8 table).
    - The factory never throws, and no method ever rejects.
    - Every method validates first. With no db, the result is `store_unavailable` "not configured".
    - A `ZodError` maps to "stored data failed the read-back check", `InvalidDataError` to `invalid_data` with its issues, and anything else to `unavailableFrom(error, '<action>')`.
    - `listEmbeddingCandidates` runs in one `READ_TRANSACTION_CONFIG` transaction.
    - The store holds one `createRunWideHook(options.onWrite)` per instance.
    - `close()` = `destroyQuietly`, idempotent.
    - Messages are this module's own text and never copy a driver or hook message. Use "Embedding Store" wording, consistent with the Place Store.
11. Do not change `src/db/place-store.ts`, `save-listing.ts`, `save-details.ts`, `mappers.ts`, the migrations or `schema-setup.ts`. Do not touch `src/embed/`, `scripts/`, `.env.example`, config or docker files. In `package.json`, change only the `pgvector` dependency (no scripts).
12. **Stop and report, do not work around**, if any of these happens:
    - A contract schema contradicts AL4 1.4.8.
    - `readPlace` and the candidates read cannot be made identical without changing `mappers.ts`.
    - `pgvector` cannot be imported with types.
    - `atttypmod` does not equal 1024 for `vector(1024)`.
13. Run every check in 2.3 in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. **Use only the Test Database.**
- Do not set `DATABASE_URL`.
- Do not run `pnpm db:migrate`, `pnpm db:status` without `--test`, `pnpm crawl` or anything else against the Development Database.

1. `pnpm exec vitest run --no-color tests/db` passes, with no failures and no skipped or todo tests. This includes `tests/db/vector.test.ts`, `tests/db/embedding-store.db.test.ts`, the extended `writer.test.ts` / `validate.test.ts`, and the unchanged `tests/db/crawl-repository.db.test.ts`.
2. Regression: `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts contracts/hydration.test.ts contracts/crawl-run1-fixes.test.ts contracts/embeddings.schema.test.ts tests/crawl` passes.
3. `pnpm db:status --test` exits 0 and lists 7 applied steps, none pending.
4. `pnpm exec eslint src/db tests/db` reports no problems.
5. `pnpm exec tsc --noEmit` reports exactly 3 errors: the unresolved modules `src/embed/command`, `src/embed/place-document` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. The `src/db/embedding-store` error is gone. `pnpm lint` reports problems only in `contracts/embeddings.test.ts`, and only those caused by the same 3 missing modules.
6. `package.json` `dependencies` contains `pgvector`, and contains no `voyageai`.
7. Guards. Each of these must return nothing:
   - `Select-String -Path src/db/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|declare module"`
   - `Select-String -Path src/db/embedding-*.ts, src/db/vector.ts -Pattern '\$\{'` (no template interpolation into SQL; if a non-SQL message legitimately uses one, report the line instead of removing it)
   - `Select-String -Path tests/db/*.ts -Pattern "(-?\d+(\.\d+)?\s*,\s*){50}"` (no pasted vector literal)
   - `Select-String -Path src/db/crawl-repository.ts -Pattern "function runWideHook"`
   - `Test-Path src/embed` is `False`.

Do not run `contracts/embeddings.test.ts` or `pnpm test:db` as a gate: the contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test. Do not change existing test cases except to add the new ones in 2.1 B and C.
- Files you may change: exactly those in AL4 U2 "Files":
  - `package.json` (`pgvector` only)
  - `src/db/vector.ts`, `rows.ts`, `types.ts`, `validate.ts`, `read.ts`, `writer.ts`, `crawl-repository.ts`, `embedding-read.ts`, `embedding-save.ts`, `embedding-store.ts`
  - `tests/db/vector.test.ts`, `writer.test.ts`, `validate.test.ts`, `embedding-store.db.test.ts`
  - plus the lockfile that `pnpm add` updates.
- Never open, write or print `.env`. Never put a real password, API key or non-default connection string in code, tests or output. Never touch the Development Database.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U3:** `src/embed/place-document.ts`, `src/embed/types.ts`.
- **U4:** settings, Batch cutting (`cutBatch`), tally, summary and report.
- **U5:** the `voyageai` dependency, `src/embed/voyage-service.ts`, `src/embed/send-batch.ts` (including the mapping of `invalid_data` / `store_unavailable` save results to Failed Places or stops).
- **U6:** `runEmbedding` and the scan-and-send loop (paging through `listEmbeddingCandidates`, `isEmbeddingDue`).
- **U7:** `src/embed/command.ts`, `scripts/embed.ts`, the `embed` and extended `test:db` scripts, `.env.example`, and making `contracts/embeddings.test.ts` green.
- No Objection model for `place_embeddings`, no Stage 2 similarity query (`<=>`, `hnsw.ef_search`), and no change to the migration or `emptyStore`.
- Recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator does this).
