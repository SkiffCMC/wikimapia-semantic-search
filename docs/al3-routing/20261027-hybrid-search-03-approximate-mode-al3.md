# AL3 Routing: hybrid-search, U3 "Approximate mode: statement, `hnsw.ef_search` = 100 session setting, plan guards"

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **Unit:** U3 of 5 (attempt 2; rewritten for AL4 revision 3)
- **AL4 source:** `docs/al4-design/20261027-hybrid-search-al4.md` (**revision 3**), section "4. Implementation Units", "U3"; decision D-EF (section 0.1); sections 1.4.9, **1.4.10** (`PLAN_FORCE_INDEX`) and **1.4.11** (HNSW cloud).
- **AL6 source (background only):** `docs/al6-requirements/20261027-hybrid-search-al6.md` (revision 2, approved 2026-10-29).
- **AL5 sources:** `contracts/hybrid-search.schema.ts`, `contracts/hybrid-search.support.ts`, `contracts/embeddings.schema.ts` (helper imports only), `contracts/hybrid-search.test.ts` (read only, not run in this unit), `contracts/hybrid-search.schema.test.ts` (run, must stay green).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **U1 and U2 are done and verified.** U3 does not touch `src/search/` or `src/embed/`.
- **U3 tests from attempt 1 already exist** and must be **revised, not rewritten**: `tests/db/search-session.test.ts`, `tests/db/place-search-approximate.db.test.ts`, `tests/db/place-search-plan.db.test.ts`, `tests/db/place-search-ef-search.db.test.ts`. Against U2's stub they currently give 11 failing / 22 passing. No U3 product code exists yet (`src/db/search-session.ts` is missing, `openSearchDb` is not exported).
- **Why attempt 2:** with revision 2, (a) the Approximate HNSW plan test could not pass with `enable_seqscan = off` alone, (b) the forced-plan ef_search test could not pass on the contract's orthogonal vectors (degenerate HNSW graph, 37 reachable tuples at any `ef_search`), and (c) a grep rule collided with the `searchSessionOptions` assertion. Revision 3 fixes all three (AL4 header "Revision 3", 1.4.10, 1.4.11, U3).
- **The Approximate stub to replace:** `buildPlaceSearchStatement` in `src/db/place-search.ts` returns the Exact statement for every mode (comment "U3 replaces it"). U3 replaces only the Approximate branch. The Exact text (`exactStatement`) stays byte for byte.
- **Pool today:** `src/db/search-store.ts` opens one pool eagerly in the factory. U3 makes it lazy and mode-specific (AL4 1.4.8 "From U3 on (D-EF)").
- **`createDb` today:** `src/db/connection.ts` takes `(connectionString, poolMax)`. U3 adds only an optional third parameter, so no existing caller changes.
- **Expected baseline (AL4 section 4, "Baseline caveat"):** `pnpm exec tsc --noEmit` and `pnpm lint` report only the two unresolved imports of `contracts/hybrid-search.test.ts` (`src/search/search-places`, `src/search/command`). **Do not create stubs** for those modules, and do not run `contracts/hybrid-search.test.ts`.
- **Test Database:** it is up (`pnpm db:up`; service `postgres` on `127.0.0.1:5433`, PG16 with pgvector and ICU). `.env.test` provides `TEST_DATABASE_URL`, and `vitest.config.ts` loads it. `fileParallelism` is `false`. DB tests get the URL only through `requireTestDatabaseUrl()`. Never use `DATABASE_URL`.

## 1. Context Manifest

Read these files, and only these. Follow `.agrules` (sections 1, 3, 4 and 5) and the stack in `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, Knex, ESLint `strictTypeChecked`. Use `import type` for types, extensionless relative imports, and `unknown` only for caught errors and raw `db.raw` results parsed with Zod on the next line. A new type alias or interface in `src/db/` goes in `src/db/types.ts`. No `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 1 (filters restrict, `<=>` ranks), 3 (all SQL in `src/db/`, parameterized only), 4 (synthetic data, no live calls), 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions ("Database access", "Embedding storage": HNSW index `place_embeddings_embedding_hnsw_idx`, pgvector defaults). Do not edit it. |
| 3 | `docs/al4-design/20261027-hybrid-search-al4.md` | Read only. Header "Revision 2" and **"Revision 3"**; "0.1" rows "One statement per search", "Exact mode", "Approximate mode", **"D-EF"**, "DB connections"; "1.1" "Database side" table and the paragraph after the "Search side" table (test seeding, `hnsw-cloud.ts` exception); "1.3" (the last four `src/db/*.ts` declarations); "1.4.3"; **"1.4.4"**; **"1.4.8"** ("From U3 on (D-EF)" block onwards); **"1.4.9"**, **"1.4.10"**, **"1.4.11"** in full; "1.5"; "2" (last "Indexing notes" bullet); "4" intro, "Baseline caveat" and **"U3"** in full; "5. AL2 Guidance" (bullets 1 to 5, "The Radius test is on the reported value", "Explicit casts", "`exactOptionalPropertyTypes`", "Tests"). Skip 1.2, 1.4.1, 1.4.2, 1.4.5 .. 1.4.7, U1, U2, U4, U5. |
| 4 | `docs/al6-requirements/20261027-hybrid-search-al6.md` | Background only. Glossary "Search Mode"; AC-4, AC-10, AC-14, AC-15, AC-23; section 3.10 (AC-63 .. AC-69); section 5 note that black-box Approximate tests must not require a particular count or Place. |
| 5 | `contracts/hybrid-search.schema.ts` | `MAX_RESULT_LIMIT`, `SIMILARITY_TOLERANCE`, `SearchModeSchema` / `SearchMode`, `tagTitlesMatch`, `compareRankingOrder`, `isInRankingOrder`, `wgs84DistanceMetres`, `DISTANCE_TOLERANCE_METRES`. |
| 6 | `contracts/hybrid-search.support.ts` | `queryEmbeddingQ` (~47), `embeddingWithSimilarity` (~51), `cosineSimilarity` (~60); `SyntheticSearchPlace` (~152); Search Set and oracles (~125-305); **`savePlace` (~369), `saveRecords` (~411)**, `seedPlaces`, `seedSearchSet`, `manyPlaces` (~424-466; `count` not a multiple of 7). |
| 7 | `contracts/embeddings.schema.ts` | Only `EMBEDDING_MODEL` (~154), `documentFingerprint` (~275), `EmbeddingRecord` (~297), `EmbeddingStore` (~910). |
| 8 | `contracts/storage.schema.ts` | Only `PlaceStore` (~539). |
| 9 | `contracts/hybrid-search.test.ts` | Read only, lines ~1330-1470 (`MODE_REQUESTS`, AC-63 .. AC-69). Do not run the file. |
| 10 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD`. |
| 11 | `src/db/connection.ts` | add-coder: optional third parameter of `createDb` only. |
| 12 | `src/db/place-search.ts` | add-coder: the Approximate branch of `buildPlaceSearchStatement`. Reuse its fragments, `StatementBuilder`, `addFilters`, `centreBindings`. |
| 13 | `src/db/search-store.ts` | add-coder: lazy per-mode pools, `openSearchDb`, the closed state. |
| 14 | `src/db/types.ts` | `PlaceSearchQuery`, `PlaceSearchStore`, `StoreResult`. |
| 15 | `src/db/failures.ts` | `storeUnavailable`, `unavailableFrom`. Do not change it. |
| 16 | `tests/db/search-session.test.ts`, `tests/db/place-search-approximate.db.test.ts`, `tests/db/place-search-plan.db.test.ts`, `tests/db/place-search-ef-search.db.test.ts` | The attempt-1 U3 tests to revise (add-test-writer) and make green (add-coder). |
| 17 | `tests/db/place-search.db.test.ts` | Style reference (setup/teardown, `otherBackends()`), and the U2 net that must stay green **unchanged**. Do not edit it. |

Other `src/db/` files are not needed. Use `createPlaceStore`, `createEmbeddingStore` and `createSchemaSetup` only through their public factories.

## 2. Execution Directives

### 2.1 add-test-writer

Revise the existing U3 files and add two new files. Keep everything in the attempt-1 files that AL4 revision 3 still asks for; change only what is listed below. Rules for every file: seed only through `seedSearchSet`, `seedPlaces`, `manyPlaces` or the new `seedHnswCloud`; generate vectors in code, never a 1024-number literal; never reach Voyage, Anthropic or Wikimapia; parse every `db.raw` / `EXPLAIN` result with Zod on the next line (recursive walk over `Plans`, InitPlans and SubPlans included). **Planner settings:** only `PLAN_FORCE_INDEX` (AL4 1.4.10), the two statements `SET LOCAL enable_seqscan = off` then `SET LOCAL enable_sort = off`, sent in that order inside a `handle.transaction(async (trx) => ...)` callback on a test-owned handle, and only in `place-search-plan.db.test.ts` and `place-search-hnsw-cloud.db.test.ts`. Write each file's own two `trx.raw` calls; do not move them into `hnsw-cloud.ts` or another shared module. Never set `hnsw.ef_search`, `hnsw.iterative_scan` or any other setting; never call `set_config`; never pass a third argument to `createDb`. Keep `SET LOCAL` and `set_config` out of comments too, so the section 2.3 greps stay mechanical.

1. **`tests/db/search-session.test.ts`**: no change. Its `'-c hnsw.ef_search=100'` expectation is now explicitly allowed (AL4 U3 "Done when", rule (b)). It must stay pure: no connection.

2. **`tests/db/place-search-approximate.db.test.ts`**: behaviour unchanged (AL4 U3 bullet "`place-search-approximate.db.test.ts`"). One edit in the "approximate statement shape" block: **remove the `/set_config/i` and `/\bset\s/i` negative assertions**. They collide with the revision-3 rule "no `set_config` / no other `SET` in `tests/db/` code". The section 2.3 grep over `src/db/` covers the same guard for product code. Keep the `materialized`, `hnsw` and `ef_search` negative assertions, the inner-sort regex, and the two-bindings check. They do not contain the string `hnsw.ef_search`.

3. **`tests/db/place-search-ef-search.db.test.ts`** (AL4 U3 bullet "`place-search-ef-search.db.test.ts`", revision 3):
   - **Remove** the test "a forced HNSW plan returns 50 rows on the Approximate handle and at most 40 on the Exact one". Also remove its now-unused helpers and imports (`forcedApproximate`, `PlanNodeSchema`, `ExplainSchema`, `RowsSchema`, `usesHnsw`, the HNSW index constant, `buildPlaceSearchStatement` if unused). After the edit this file contains no `SET LOCAL` and no `transaction(`.
   - **Keep** the "Setting in effect" test (handles from `openSearchDb`, `'100'` before and after a vector cast on Approximate, `'40'` after a cast on Exact, both destroyed), "Exact unaffected" (true top 50), and the three lifecycle tests.
   - **Keep** the store-level "Approximate, no filter, limit 50 gives exactly 50" test, but rename it and its comments so they claim only the limit and correctness of Approximate mode, **not** `ef_search` evidence (AL4 U3: "This is not evidence for `ef_search`"). Rewrite the file header comment the same way: it must not say the store-level count of 50 comes from `ef_search` 100, and it should point to `place-search-hnsw-cloud.db.test.ts` as the D-EF proof.

4. **`tests/db/place-search-plan.db.test.ts`** (AL4 U3 bullet "`place-search-plan.db.test.ts`" and 1.4.10). Same seeding, `ANALYZE` and own `createDb(testUrl, 1)` handle as now.
   - Replace the single `planNodes` helper with two variants: **default** (plain `explain (format json)`, no transaction, no settings) and **forced** (in a transaction: `PLAN_FORCE_INDEX`, then the `EXPLAIN`).
   - **Exact**, for each of the five existing cases (no filter, Radius, Area, Tags, Tags plus Radius), checked **twice**, once with default and once with forced: no node has `Index Name` `place_embeddings_embedding_hnsw_idx`, and some node is a `CTE Scan` with `CTE Name` `candidates`.
   - **Approximate**, no filters, forced: some node uses `place_embeddings_embedding_hnsw_idx`. Do not assert the absence of a Sort node (the outer Ranking Order sort stays, per 1.4.10).

5. **`tests/db/hnsw-cloud.ts`** (new helper, not a `*.test.ts`; AL4 1.4.11 "Helper module" and "Construction"). Export exactly `HNSW_CLOUD`, `HnswCloudPlace`, `hnswCloud()` and `seedHnswCloud(places, embeddings)` with the signatures and constants given in 1.4.11. Use the given mulberry32 steps and draw order (place by place, axes 1 .. `subspaceAxes`). Normalise, then `Math.fround` each entry. Compute `similarity` with the support's `cosineSimilarity(queryEmbeddingQ(), embedding)`. `seedHnswCloud` calls `savePlace` for each Place in order, then `saveRecords` once with `{ placeId, embedding, model: EMBEDDING_MODEL, documentFingerprint: documentFingerprint(`hnsw cloud ${placeId}`), embeddedAt: '2026-10-24T00:00:00Z' }` records, and returns the cloud. No `Math.random`, no DDL, no `REINDEX`, no direct SQL. Import from `contracts/` only. Add a header comment that names AL4 1.4.11 and the active parameters.

6. **`tests/db/place-search-hnsw-cloud.db.test.ts`** (new; AL4 U3 bullet "`place-search-hnsw-cloud.db.test.ts`" in full). The database holds **only** the cloud.
   - `beforeAll` (300 s timeout): `apply()`, `emptyStore()`, `seedHnswCloud(...)`, close the seeding stores, then `analyze places, place_embeddings, place_tags, tags` through a test-owned `createDb(testUrl, 1)` handle. `afterAll` re-applies Schema Setup and destroys every handle, as the other files do. The tests are read-only.
   - **Self-checks** (1.4.11 "Self-checks"): two `hnswCloud()` calls are deep-equal; there are `HNSW_CLOUD.count` distinct Place IDs; every embedding has 1024 entries and a norm within 1e-6 of 1; all similarities are distinct.
   - **D-EF proof:** the query is `{ queryEmbedding: queryEmbeddingQ(), mode: 'approximate', limit: MAX_RESULT_LIMIT }` and the statement comes from `buildPlaceSearchStatement`. The same Approximate statement runs on both handles. For each of `openSearchDb(testUrl, 'approximate')` and `openSearchDb(testUrl, 'exact')`, open one transaction and run, in order: `PLAN_FORCE_INDEX`; `EXPLAIN (FORMAT JSON)` with the bindings; `current_setting('hnsw.ef_search', true)`; then the statement (prefer `selectMatchingPlaces(trx, query)`, which yields typed `SearchResult[]`).
     - Approximate handle: the plan uses the HNSW index, the setting is `'100'`, and there are **exactly 50** rows, in Ranking Order (`isInRankingOrder`), no repeats, every `placeId` a cloud Place, and each similarity within `SIMILARITY_TOLERANCE` of the cloud oracle.
     - Exact handle (control): the plan uses the HNSW index (asserted), the setting is `'40'`, and there are **exactly 40** rows, in Ranking Order, no repeats, all cloud Places.
     - Do not assert recall against the true top 50. Destroy both handles in `finally`.
   - **Feasibility and fallback (AL4 1.4.11 "Pre-approved fallback parameters").** Against U2's stub the Approximate plan is not HNSW, so this file fails before add-coder works. Before handing over, confirm the cloud parameters with a throwaway probe. Run the AL4 1.4.4 unfiltered Approximate text (limit 50, the same bindings) under `PLAN_FORCE_INDEX` on both `openSearchDb` handles over the seeded cloud. The probe must be deleted before handover: nothing of it may remain under `tests/` or `src/`, and it must not create `src/db/search-session.ts` or `openSearchDb` (the test writer cannot use them before add-coder exists either; open the two probe connections with the pg `options` parameter only inside the throwaway probe, never in a committed file).
     - If the Approximate handle gives fewer than 50 rows, switch **once** to `count: 2000, subspaceAxes: 8` (IDs 50001 .. 52000, same seed and construction), record the switch in the `hnsw-cloud.ts` header comment, and probe again.
     - **Stop and report to the orchestrator** (for AL4) with the observed row counts on both handles, and leave the primary-or-fallback tests unweakened, if any of these happens: the fallback also gives fewer than 50; the Exact control does not give exactly 40; a correct Approximate statement gets no HNSW plan under `PLAN_FORCE_INDEX` (1.4.10 last rule: do not add settings); or the setting does not read `'100'` / `'40'`.
     - Do not lower the 50 / 40 assertions in any case.

Expected red state at handover: `search-session.test.ts` and the `openSearchDb`-based tests fail on the missing module or export, and the Approximate plan, the cloud proof and Approximate-shape tests fail on the stub. Everything else that is green today (U2 tests, self-checks, Exact plan guards) stays green. Do not edit `tests/db/place-search.db.test.ts` or any other existing test file outside the four listed.

### 2.2 add-coder

Code scope is unchanged from attempt 1. Make the tests of 2.1 green, in this order. Import contract schemas, types and constants from `../../contracts/...` and never copy them. All SQL stays in `src/db/`. **Do not edit any test file or `tests/db/hnsw-cloud.ts`.**

1. **`src/db/search-session.ts`** (create): `APPROXIMATE_HNSW_EF_SEARCH = 100` and `searchSessionOptions(mode: SearchMode): string | undefined` as in AL4 1.4.9. Build the string from the constant only (`String(APPROXIMATE_HNSW_EF_SEARCH)` for `restrict-template-expressions`). This is the only file in `src/` that names `hnsw.ef_search`, and no `100` appears anywhere else.
2. **`src/db/connection.ts`:** add the optional third parameter `sessionOptions?: string` to `createDb`. Add `options: sessionOptions` to the connection config only when it is defined, with a conditional spread (AL4 1.4.9; `exactOptionalPropertyTypes`). Nothing else in the file changes.
3. **`src/db/place-search.ts`:** replace the stub with an `approximateStatement(query)` producing exactly the AL4 1.4.4 "Approximate mode" text, and dispatch on `query.mode`.
   - Inner select: `1 - (e.embedding <=> ?::vector)` (first vector binding), `[D]`, `RESULT_TAGS as tags`; `where` plus `addFilters`; with a Radius ` and DISTANCE <= ?::float8`; then `order by e.embedding <=> ?::vector` (a second, separate binding of the same literal; ascending; the only key) and `limit ?::int`.
   - Outer query: `where a.similarity <> 'NaN'::float8`, `order by a.similarity desc, a.place_id asc`.
   - Bindings are pushed with each fragment, in placeholder order (1.4.4 "Binding order"). No `materialized`, no CTE, no `SET`, no `set_config` and no `hnsw` in the text. Remove the stub comment. `exactStatement`, the fragments and `selectMatchingPlaces` stay unchanged.
4. **`src/db/search-store.ts`:** implement the AL4 1.4.8 "From U3 on (D-EF)" pseudo-code.
   - Export `openSearchDb(connectionString, mode)` = `createDb(connectionString, POOL_MAX_SEARCH, searchSessionOptions(mode))`.
   - The factory only checks the connection string and opens no pool.
   - `searchMatchingPlaces` order: validate (`invalid_data`, no pool) -> not configured -> closed (`'Place Store unavailable: the store is closed'`, no pool) -> get or lazily open the pool for `validated.value.mode`, **inside** the guarded `try` -> `selectMatchingPlaces`. Keep the existing failure mapping.
   - `close()`: set closed, await `destroyQuietly` on every pool, clear the map. It is idempotent and never rejects.
   - Signatures of `createPlaceSearchStore` / `PlaceSearchStoreOptions` are unchanged, and the factory never throws. Messages carry no connection string, SQL, bindings or driver text (AC-60).
5. Run the "Done when" commands and fix the code until they pass. If the first Approximate plan test fails, check the statement first (bare `e.embedding <=> ?::vector` as the only inner sort key, bound as a parameter; AL4 section 5).
   - **Stop and report to the orchestrator, without touching tests:** if the setting is not in effect on the Approximate handle (`current_setting` reads `null` or `'40'`); if a correct statement gets no HNSW plan under `PLAN_FORCE_INDEX`; or if the cloud proof fails only on its row counts while plan and setting assertions hold. The cloud parameters and the fallback belong to the test writer and AL4.
   - Never switch to `SET`, `SET LOCAL`, `set_config` or a role or database setting (AL4 1.4.9 "Alternatives rejected").

### 2.3 Done when

Precondition: the Test Database is up (`pnpm db:up`) and `.env.test` provides `TEST_DATABASE_URL`. All of the following hold:

- `pnpm exec vitest run --no-color tests/db` passes. That covers the four revised files, `tests/db/place-search-hnsw-cloud.db.test.ts`, `tests/db/place-search.db.test.ts` unchanged, and every other existing `tests/db` file unchanged.
- `pnpm exec vitest run --no-color tests/db/place-search-hnsw-cloud.db.test.ts` passes with the **exact** counts 50 (Approximate handle) and 40 (Exact handle) under an asserted HNSW plan. Weakened assertions do not count as done.
- Regression: `pnpm test:db` passes, and `pnpm exec vitest run --no-color contracts/hybrid-search.schema.test.ts tests/search` passes.
- `pnpm exec eslint src/db tests/db` reports no problems.
- `pnpm exec tsc --noEmit` reports no errors other than the two baseline unresolved imports of `contracts/hybrid-search.test.ts`.
- Grep checks (AL4 U3 "Done when", revision 3; code, not comments):
  - `src/`: `hnsw\.ef_search` matches only `src/db/search-session.ts`. In `src/db/`, `(?i)['"\x60]\s*set\s|set_config|set local` finds nothing.
  - `tests/db/`: `(?i)set local` matches exactly the `SET LOCAL enable_seqscan = off` and `SET LOCAL enable_sort = off` lines, only in `place-search-plan.db.test.ts` and `place-search-hnsw-cloud.db.test.ts`, each inside a `transaction(` callback.
  - `tests/db/`: `(?i)set_config` and `(?i)alter\s+(database|role|user|system)` find nothing. `(?i)['"\x60]\s*set\s` matches only the `PLAN_FORCE_INDEX` lines.
  - `tests/db/`: `hnsw\.ef_search` matches only `current_setting('hnsw.ef_search', true)` reads and the `'-c hnsw.ef_search=100'` expectation in `search-session.test.ts`.
  - `tests/db/`: no `createDb(` call has a third argument, and no test connection string carries `options`.
  - `iterative_scan` matches nothing in `src/` or `tests/`.
- No contract test turns green directly in this unit. `contracts/hybrid-search.test.ts` is not run.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT modify anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the support files). Also leave `CLAUDE.md`, `.agrules`, `.env*`, `package.json`, `docker-compose.yml`, `docker/`, `vitest.config.ts`, `eslint.config.js` and every migration unchanged. No Schema Setup step, no index change, no `REINDEX`, no `ALTER DATABASE` / `ALTER ROLE`, no stored-data change (AC-39).
- Your code MUST pass the tests and schemas defined in AL5 and the U3 tests derived from AL4. If the code fails, fix the code, not the contract or the spec. If a contract or the AL4 spec looks wrong or contradictory, or a stop condition of 2.1 or 2.2 is hit, stop and report to the orchestrator instead of working around it (`.agrules` section 0).
- Parameterized SQL only (`.agrules` 3, AC-40). The `-c hnsw.ef_search=100` string is a connection parameter built from a constant, never from input, and never SQL.
- Each search sends exactly one SQL statement. Product code never sends `SET`, `SET LOCAL`, `set_config`, `BEGIN` or `COMMIT`. `PLAN_FORCE_INDEX` is test-only.
- Tests run only against the Test Database. No live Voyage, Anthropic or Wikimapia call, and no real key, anywhere.

## 4. Out of Scope

Do not implement these now:

- **U4:** `src/search/search-places.ts` / `searchPlaces` and `tests/search/search-places.db.test.ts`. Do not create a stub.
- **U5:** `src/search/args.ts`, `output.ts`, `command.ts`, `scripts/search.ts`, the `package.json` `search` script and the `test:db` extension (AL4 1.4.6, 1.4.7).
- **Not part of this feature:** `hnsw.iterative_scan` (stays `off`); HNSW build parameters, index or migration changes (AL4 section 2 "Indexing notes"); any planner setting beyond `PLAN_FORCE_INDEX`; recall assertions for Approximate mode; a long-lived or shared search pool (Stage 3); a `DATABASE_URL` with its own `?options=` or a transaction-pooling proxy (AL4 1.4.9 "Limitations"); recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator's job).
- **Unchanged from U2:** the Exact statement, `text-fold.ts`, `rows.ts`, `validate.ts`, the tag-fold parity test, and `tests/db/place-search.db.test.ts`.
