# AL3 Routing: hybrid-search, U2 "Search repository: statement builder, Exact mode, filters, tag folding, search store"

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **Unit:** U2 of 5 (attempt 1)
- **AL4 source:** `docs/al4-design/20261027-hybrid-search-al4.md`, section "4. Implementation Units", "U2".
- **AL6 source (background only):** `docs/al6-requirements/20261027-hybrid-search-al6.md` (revision 2, approved 2026-10-29).
- **AL5 sources:** `contracts/hybrid-search.schema.ts`, `contracts/hybrid-search.support.ts`, `contracts/hybrid-search.test.ts` (read only, not run in this unit), `contracts/hybrid-search.schema.test.ts` (run, must stay green).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **U1 is done and verified:** `src/search/types.ts`, `src/search/failures.ts`, `src/search/query-embedding.ts`, `createVoyageQueryEmbeddingService` in `src/embed/voyage-service.ts`. U2 does not touch `src/search/` or `src/embed/`. U2 is independent of U1 (AL4 U2 "Depends on: none").
- `src/db/` holds the finished `storage`, `hydration` and `embeddings` repository layers. U2 **adds** three files (`text-fold.ts`, `place-search.ts`, `search-store.ts`) and **extends** three (`rows.ts`, `types.ts`, `validate.ts`). Existing exports keep their behaviour.
- **Exact mode only.** U2 delivers the final Exact-mode statement. Approximate mode (AL4 1.4.4 "Approximate mode", AC-65 .. AC-69) belongs to U3, and a stakeholder decision about `hnsw.ef_search` for it is still pending. See the "Approximate stub" directive in 2.2 step 5.
- **Expected baseline (AL4 section 4, "Baseline caveat"):** `pnpm exec tsc --noEmit` and `pnpm lint` report only the two unresolved imports of `contracts/hybrid-search.test.ts` (`src/search/search-places`, `src/search/command`). They stay until U4 and U5. **Do not create stubs** for those modules, and do not run `contracts/hybrid-search.test.ts` as a gate.
- **Test Database (needed by this unit):**
  - Start it with `pnpm db:up`. That runs `docker compose up -d --build --wait` and starts the `postgres` service of `docker-compose.yml`, built from `docker/postgres/Dockerfile` (`postgis/postgis:16-3.6` plus pgvector, PG16 with ICU). It listens on `127.0.0.1:5433`.
  - `.env.test` exists and sets `TEST_DATABASE_URL` (`wikimapia_test`). `vitest.config.ts` loads it into every test run automatically, and a non-empty shell variable wins. `fileParallelism` is `false`.
  - DB tests get the URL only through `requireTestDatabaseUrl()` (`contracts/storage.support.ts`). `createSchemaSetup` refuses a database whose name is not a test database name. Never point a test at `DATABASE_URL` or the Development Database.
  - Pattern per DB test file, as in `tests/db/embedding-store.db.test.ts`: `beforeAll` runs `createSchemaSetup(...).apply()`, `beforeEach` runs `emptyStore()`, and `afterAll` re-applies and closes every store.

## 1. Context Manifest

Read these files, and only these. Follow `.agrules` (especially sections 1, 3, 4 and 5) and the stack in `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, Knex. Use `import type` for types (`import type { Knex } from 'knex'`), extensionless relative imports, and `unknown` only where `.agrules` 5 and AL4 section 5 allow it (caught errors, the raw `db.raw` result parsed on the next line, and `validatePlaceSearchQuery`'s parameter). Every type alias or interface goes in `src/db/types.ts`. No `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 1 (filters restrict, `<=>` ranks, nothing outside the bounds), 3 (all SQL in `src/db/`, parameterized only), 4 (synthetic data, no live calls), 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions. "Decisions": rows "Database access" and "Embedding storage". Do not edit it. |
| 3 | `docs/al4-design/20261027-hybrid-search-al4.md` | Read only. Sections: "0. Scope and Fixed Points" (rows "Constants", "Helpers to reuse", "Unchanged"; paragraphs "Single source of truth" and "Code style"); "0.1" rows "One statement per search", "Exact mode", "Tag title folding", "Radius predicate", "Area predicate", "DB connections"; "1.1 Module map" (the "Database side" table and the "Unit tests" paragraph); "1.3" (the `src/db/types.ts` and `src/db/*.ts` blocks); "1.4.3"; "1.4.4" (**Exact mode** and "Why this is exact" only, plus the "Binding order" paragraph); "1.4.5"; "1.4.8"; "1.5"; "2. Data Model Design"; "4" intro, "Baseline caveat" and "U2"; "5. AL2 Guidance". Skip 1.4.1, 1.4.2, 1.4.6 and 1.4.7. |
| 4 | `docs/al6-requirements/20261027-hybrid-search-al6.md` | Background only. Section 1 (glossary: Searchable Place, Matching Place, Ranking Order, Radius / Area / Tag Filter, Distance); section 3 preamble (Search Set, Point S, Area B); sections 3.1 .. 3.5 (AC-1 .. AC-38); AC-40; AC-59, AC-60 (3.8); AC-64 (3.10); section 4 rules; section 6 decisions Q3, Q4, Q5, R-A. |
| 5 | `contracts/hybrid-search.schema.ts` | Constants (~lines 98-119: limits, `MAX_RADIUS_METRES`, `SIMILARITY_TOLERANCE`, `SearchModeSchema`, `SEARCHABLE_EMBEDDING_MODEL`); `normalizeTagTitle`, `tagTitlesMatch` (~152-164); `LatLonSchema`, `AreaFilterSchema` (~166-180); `SearchResultSchema`, `compareRankingOrder`, `isInRankingOrder` (~335-376); `wgs84DistanceMetres` (~468). |
| 6 | `contracts/hybrid-search.support.ts` | Lines 38-122 (`queryEmbeddingQ`, `embeddingWithSimilarity`, `cosineSimilarity`, `fakeVector`); 125-305 (`POINT_S`, `AREA_B`, `SEARCH_TAGS`, `SEARCH_SET`, `NOT_SEARCHABLE_IDS`, `SEARCHABLE_RANKING`, `searchSetPlace`, `similarityOf`, `isSearchable`, `liesInArea`); 307-466 (`savePlace`, `recordOf`, `saveRecords`, `seedPlaces`, `seedSearchSet`, `manyPlaces`). |
| 7 | `contracts/hybrid-search.test.ts` | Read only, lines ~344-875 (AC-1 .. AC-40) and ~1276-1310 (AC-59, AC-60). This is the end-to-end net that your store must satisfy through `searchPlaces` in U4/U5. Mirror its expectations at the store level. Do not run it. |
| 8 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_PASSWORD`, `UNREACHABLE_DATABASE_URL`, `clientListing`, `clientDetails`, `FETCHED_AT` (AC-38 fixtures `box-belgrade-page1.json`, `getbyid-1381893.json`). |
| 9 | `contracts/storage.schema.ts` | Only `StoreConfigSchema`, `StoreFailureSchema` / `StoreFailure` (~line 486) and `PlaceStore` / `SchemaSetup` types. |
| 10 | `contracts/embeddings.schema.ts` | `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` (~154-156), `EmbeddingSchema` / `Embedding` (~257), `EmbeddingStore` type. |
| 11 | `src/db/connection.ts` | `createDb`, `destroyQuietly`, timeouts, the int8 parser. Do not change it. |
| 12 | `src/db/failures.ts` | `invalidData`, `storeUnavailable`, `unavailableFrom`. Do not change it. |
| 13 | `src/db/vector.ts` | `toVectorLiteral`. Do not change it. |
| 14 | `src/db/embedding-store.ts` | **Pattern reference** for the guarded, never-rejecting store factory (`openDb`, `guarded`, `failureFor`, not-configured fallback). Do not change it. |
| 15 | `src/db/rows.ts` | File to extend (`SearchRowSchema`). |
| 16 | `src/db/types.ts` | File to extend (AL4 1.3 `src/db/types.ts` additions; `StoreResult`, `Validated` already exist). |
| 17 | `src/db/validate.ts` | File to extend (`validatePlaceSearchQuery`). |
| 18 | `tests/db/validate.test.ts` | File to extend (new cases). Existing cases stay unchanged and green. |
| 19 | `tests/db/embedding-store.db.test.ts` | Style reference for Test Database setup and teardown. Do not change it. |

Other `src/db/` files (crawl, parking, migrations, models, place-store internals) are not needed. Use `createPlaceStore`, `createEmbeddingStore` and `createSchemaSetup` only through their public factories.

## 2. Execution Directives

### 2.1 add-test-writer

Write the tests first. They must fail (missing modules or exports) before add-coder starts. Seed Places and Embedding Records only through `seedSearchSet`, `seedPlaces` and `manyPlaces` of `contracts/hybrid-search.support.ts`, or through the real `createPlaceStore` / `createEmbeddingStore`. Generate vectors in code (`queryEmbeddingQ`, `embeddingWithSimilarity`, `fakeVector`, `recordOf`). Never write a 1024-number literal. Call the store with `queryEmbeddingQ()` as the Query Embedding. Never reach Voyage, Anthropic or Wikimapia. **Do not write any `SET`, `SET LOCAL`, `set_config`, `hnsw.ef_search` or `hnsw.iterative_scan` statement**, and no `EXPLAIN` plan test (U3).

1. **`tests/db/text-fold.test.ts`** (pure): the AL4 U2 bullet "`text-fold.test.ts`". For every code point U+0000 .. U+10FFFF except surrogates, `String.fromCodePoint(cp).trim() === ''` holds exactly when the code point is in `JS_TRIM_CHARACTERS`. `JS_TRIM_CHARACTERS` has no duplicates. `FOLDED_TAG_TITLE_SQL` contains exactly one `?`, the `und-x-icu` collation and `t.title`.
2. **`tests/db/tag-fold-parity.db.test.ts`** (Test Database, via the test's own handle from `createDb(requireTestDatabaseUrl(), 1)`, destroyed in `afterAll`): the AL4 U2 bullet "`tag-fold-parity.db.test.ts`" and AL4 1.4.5.
   - BMP sweep: every non-surrogate BMP code point, wrapped as in AL4. Send it in chunks of 5,000 as one `text[]` binding, after the `JS_TRIM_CHARACTERS` binding. SQL output equals `normalizeTagTitle` for each element. Preserve element order (for example `with ordinality` and an ordered aggregate), and report the first mismatching code point in hex.
   - The contextual corpus from AL4 U2.
   - `und-x-icu` exists in `pg_collation`.
   - If parity fails on real data, do not weaken the test. Report it (AL4 1.4.5 "Residual risk").
3. **`tests/db/place-search.db.test.ts`** (Test Database; one `createPlaceSearchStore` per test, always closed in `finally`). Pin down every bullet of the AL4 U2 "`place-search.db.test.ts`" list, all in **Exact mode** (once with `mode: 'exact'` explicitly, AC-64, and otherwise as the default the caller passes):
   - **Ranking:** AC-1 order (`SEARCHABLE_RANKING`) and similarities within `SIMILARITY_TOLERANCE`. AC-4 (`NOT_SEARCHABLE_IDS` absent; the other-model Place excluded). AC-5, AC-6 (20 of 25), AC-7 (50 of 60), AC-8. AC-9 ties broken by Place ID. AC-11 (Embedding Due Place still returned). AC-12 (empty list is `ok`).
   - **AC-10 needle:** the needle by radius, by area and by tag among 1,000 `manyPlaces` haystack Places, plus the true top 50 of `['hotel']` checked against an oracle computed in the test. Per-test timeout 300 s.
   - **Radius:**
     - AC-13: Distances against `wgs84DistanceMetres` within `DISTANCE_TOLERANCE_METRES`.
     - AC-15: nothing outside the circle.
     - AC-16: a Radius equal to a reported Distance includes that Place (the AL4 102 / 104 case).
     - AC-17, AC-18, AC-19.
     - AC-20: an Outline Shape is ignored for the circle.
     - AC-21: no `distanceMetres` key without a Radius (`not.toHaveProperty`).
   - **Area:** AC-22 .. AC-26, including both edge cases, checked with the `liesInArea` oracle.
   - **Tags:**
     - AC-27 .. AC-34.
     - A Cyrillic catalogue Tag `Музеј` is matched by the filter `[' МУЗЕЈ ']`, normalized in the test with `normalizeTagTitle`, as `searchPlaces` will do. Seed this Place through the real Place Store with a hand-built synthetic `PlaceDetails` (a free Tag id), and seed its record through `saveRecords`.
     - 300 distinct tag titles in one query work.
   - **Content:** AC-35 exact content (name, link, centre, tag order). AC-36, AC-37. AC-38: the Listing Link is stored from `clientListing('box-belgrade-page1.json')` / `clientDetails('getbyid-1381893.json')` plus an Embedding Record.
   - **Safety:**
     - AC-40: `museum'; --` as a title gives `[]`, and `countEmbeddingStore` / place counts are unchanged.
     - `buildPlaceSearchStatement`: the `?` count equals `bindings.length` for all 2 × 3 × 2 combinations of mode × {none, radius, area} × {no tags, tags}.
     - No `??` and no bound value (a tag title, the vector literal, a radius number) appears in the SQL text.
   - **Validation and failures:**
     - `invalid_data` without DB access for limit 0, a 1023-number vector, and radius plus area together. This is also true with `UNREACHABLE_DATABASE_URL`.
     - A valid query against `UNREACHABLE_DATABASE_URL` gives `store_unavailable`, and the message contains neither `UNREACHABLE_PASSWORD` nor `postgres://`.
     - A missing or blank connection string gives the "not configured" message of AL4 1.4.8.
     - `close()` twice never rejects.
   - **Connection hygiene:** read the baseline count of `pg_stat_activity` rows for `current_database()` (excluding the test handle's own backend) through the test's own handle. Then 30 open / search / close cycles, after which the count equals the baseline.
   - **Approximate (stub only):** do not assert Approximate behaviour beyond the placeholder/binding count and the no-interpolation checks above. U3 adds `tests/db/place-search-approximate.db.test.ts`.
4. **`tests/db/validate.test.ts`** (new cases, pure) for `validatePlaceSearchQuery`:
   - Accepts each valid shape (no filter, radius, area, tags, radius plus tags, area plus tags; both modes).
   - Rejects with `invalid_data`:
     - `limit` 0, 51 and 2.5;
     - `radiusMetres` 0, negative, and 50,001;
     - a bad `LatLon` or `AreaFilter`;
     - radius and area together;
     - `tagTitles` empty, or containing `''`;
     - a 1023- or 1025-number vector, or a non-finite value;
     - an unknown mode.
   - Accepts 300 tag titles (no maximum).

### 2.2 add-coder

Make the tests of 2.1 green, in this order. Import every contract schema, type and helper from `../../contracts/...` (or `../../contracts/...` relative to `src/db/`), and never copy or redefine them (AL4 "Single source of truth"). All SQL stays in `src/db/` (`.agrules` 3).

1. **`src/db/text-fold.ts`** (create): `JS_TRIM_CHARACTERS` (the complete ECMAScript set listed in AL4 1.4.5) and `FOLDED_TAG_TITLE_SQL` (AL4 1.3, exact text).
2. **`src/db/rows.ts`:** add `SearchRowSchema` as in AL4 1.4.8 (last paragraph before "`searchPlaces` creates the store").
3. **`src/db/types.ts`:** add `PlaceSearchQuery`, `SqlBinding`, `SqlStatement`, `SearchRow`, `PlaceSearchStoreOptions` and `PlaceSearchStore` exactly as in AL4 1.3. Use `import type` for the contract types (`Embedding`, `SearchMode`, `LatLon`, `AreaFilter`, `SearchResult`).
4. **`src/db/validate.ts`:** add `validatePlaceSearchQuery(input: unknown): Validated<PlaceSearchQuery>`. Build it as a Zod schema from contract pieces as in the AL4 1.4.8 table row "`searchMatchingPlaces(query)`". Map issues to `invalid_data` the same way the existing validators do.
5. **`src/db/place-search.ts`** (create): `buildPlaceSearchStatement` (pure) and `selectMatchingPlaces`.
   - Concatenate only the constant fragments of AL4 1.4.3. Push each fragment's bindings as you append it. Put an explicit cast on every binding. Coordinates go in `lon, lat` order, envelopes in `west, south, east, north` order. The radius margin is a named constant of 1. Tags are one fresh `string[]` binding (spread the readonly array).
   - The **Exact** statement must be exactly the AL4 1.4.4 "Exact mode" shape:
     - a `materialized` `candidates` CTE holding `SEARCHABLE`, `RADIUS_COARSE`, `AREA` and `TAGS` as present, with no `ORDER BY` and no `LIMIT`;
     - a `top_n` that drops NaN, applies the exact radius test on `distance_metres`, orders by `similarity desc, place_id asc`, and applies `limit ?::int`;
     - an outer join to `places` with `RESULT_TAGS`, in the same order.
     - Never `order by e.embedding <=> ...` (AL4 section 5, first bullet).
   - `selectMatchingPlaces`: as in AL4 1.4.8 (`db.raw`, parse `{ rows }` with `SearchRowSchema`, map with a conditional `distanceMetres` spread, gate with `z.array(SearchResultSchema)`).
   - **Approximate stub (routing decision within AL4 U2's "may be stubbed"):** for `mode: 'approximate'`, return the **same statement as Exact**. Add a short comment that U3 replaces it with the AL4 1.4.4 Approximate text. This keeps every result correct (it is a valid Approximate answer under AC-65 .. AC-67). Do not write the HNSW-ordered inner query now.
   - **Never emit `SET`, `SET LOCAL`, `set_config`, `hnsw.ef_search` or `hnsw.iterative_scan`.** The `hnsw.ef_search` question is a pending stakeholder decision for U3.
6. **`src/db/search-store.ts`** (create): `POOL_MAX_SEARCH = 1` and `createPlaceSearchStore` per AL4 1.4.8, following the `embedding-store.ts` pattern. The factory never throws, and `StoreConfigSchema` checks the connection string. `searchMatchingPlaces` never rejects:
   - validation runs first, with no DB access;
   - a missing or unusable connection string gives the not-configured message;
   - a `ZodError` gives the read-back message;
   - any other error goes through `unavailableFrom(error, 'place search')`.
   `close()` is idempotent via `destroyQuietly`. No message carries the connection string, SQL text, bindings or a driver message (AC-60).
7. Run the "Done when" commands, and fix the code until they pass. If the BMP parity test fails because of an ICU version skew, stop and report it. Do not change the fold to make it pass.

### 2.3 Done when

Precondition: `pnpm db:up` has been run (Docker Desktop running, service `postgres` healthy on `127.0.0.1:5433`) and `.env.test` provides `TEST_DATABASE_URL`. Vitest loads it itself, so do not export it by hand. All of the following hold:

- `pnpm exec vitest run --no-color tests/db` passes: the new `text-fold`, `tag-fold-parity`, `place-search` and `validate` cases, and every existing `tests/db` file unchanged.
- Regression: `pnpm test:db` passes (storage, hydration and embeddings contracts; `tests/db`, `tests/crawl`, `tests/embed`), and `pnpm exec vitest run --no-color contracts/hybrid-search.schema.test.ts tests/search` passes.
- `pnpm exec eslint src/db tests/db` reports no problems.
- `pnpm exec tsc --noEmit` reports no errors other than the two baseline unresolved imports of `contracts/hybrid-search.test.ts` (`src/search/search-places`, `src/search/command`).
- A search (Grep tool) of `src/db/` and `tests/db/` for `ef_search`, `iterative_scan`, `set_config` and `SET LOCAL` finds nothing.
- No contract test turns green directly in this unit (AL4 U2). `contracts/hybrid-search.test.ts` is not run.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT modify anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the support files). Also leave `CLAUDE.md`, `.agrules`, `.env*`, `package.json`, `docker-compose.yml`, `docker/`, `vitest.config.ts` and every migration unchanged in this unit. No Schema Setup step and no stored-data change (AC-39).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. If a contract or the AL4 spec looks wrong or contradictory (including a BMP fold-parity failure), stop and report it to the orchestrator instead of working around it (`.agrules` section 0).
- Parameterized SQL only: no value of any kind is interpolated into SQL text (`.agrules` 3, AC-40).
- Tests run only against the Test Database (`TEST_DATABASE_URL`). No live Voyage, Anthropic or Wikimapia call, and no real key, anywhere.

## 4. Out of Scope

Do not implement these now. They belong to later units or to pending decisions:

- **U3:**
  - the real Approximate statement of AL4 1.4.4 (the inner `order by e.embedding <=> ?::vector limit` with the outer re-sort);
  - `tests/db/place-search-approximate.db.test.ts` and `tests/db/place-search-plan.db.test.ts`;
  - every `EXPLAIN` or plan assertion and every `SET LOCAL enable_seqscan`;
  - AC-65 .. AC-69 and AC-14 at the Approximate level.
- **Pending stakeholder decision:** any setting or tuning of `hnsw.ef_search` or `hnsw.iterative_scan`, in product code or in tests.
- **U4:** `src/search/search-places.ts` / `searchPlaces`. That covers query assembly from a Search Request (`normalizeTagTitle` and dedup in TS), the store lifecycle with close-before-resolve, and the outcome gate (AL4 1.2). Do not create a stub.
- **U5:**
  - `src/search/args.ts`, `output.ts`, `command.ts` and `scripts/search.ts`;
  - the `package.json` `search` script and the `test:db` extension (AL4 1.4.6, 1.4.7).
- **Out of scope for this feature:** any index or migration change (AL4 section 2 "Indexing notes"), and recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator's job).
