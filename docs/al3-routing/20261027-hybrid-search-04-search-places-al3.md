# AL3 Routing: hybrid-search, U4 "Place Search: `searchPlaces`"

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **Unit:** U4 of 5 (attempt 1)
- **AL4 source:** `docs/al4-design/20261027-hybrid-search-al4.md` (**revision 3**), section "4. Implementation Units", "U4"; design refs 1.2, 1.4.2, 1.4.8, 1.5. Revision 3 does not change U4.
- **AL6 source (background only):** `docs/al6-requirements/20261027-hybrid-search-al6.md` (revision 2, approved 2026-10-29).
- **AL5 sources:** `contracts/hybrid-search.schema.ts`, `contracts/hybrid-search.support.ts`, `contracts/embeddings.support.ts` (error makers, `TEST_VOYAGE_API_KEY`), `contracts/storage.support.ts`, `contracts/hybrid-search.test.ts` (read only, **not run** in this unit), `contracts/hybrid-search.schema.test.ts` (run, must stay green).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **U1, U2 and U3 are done and verified** (`pnpm test:db`: 43 files / 614 tests green). Everything U4 orchestrates already exists and is **not** changed by U4:
  - `src/search/failures.ts` (`missingKeyFailure`, `embeddingFailure`, `storeFailure`, `INTERNAL_FAILURE`), `src/search/query-embedding.ts` (`embedQueryText`, `QUERY_EMBEDDING_TIMEOUT_SECONDS`), `src/search/types.ts`.
  - `src/embed/voyage-service.ts` (`createVoyageQueryEmbeddingService`, lazy `voyageai` import), `src/embed/settings.ts` (`isMissingApiKey`, `MISSING_KEY_MESSAGE`).
  - `src/db/search-store.ts` (`createPlaceSearchStore`: never throws, never rejects, lazy per-mode pool, idempotent `close()`), `src/db/types.ts` (`PlaceSearchQuery`, `PlaceSearchStore`, `StoreResult`).
- **Missing:** `src/search/search-places.ts` and `tests/search/search-places.db.test.ts`. `tests/search/` today holds only `failures.test.ts` and `query-embedding.test.ts` (pure, must stay green).
- **Baseline:** `pnpm exec tsc --noEmit` and `pnpm lint` report only the two unresolved imports in `contracts/hybrid-search.test.ts` (`src/search/search-places`, `src/search/command`). After U4 only the `src/search/command` one may remain. **Do not create a stub for `src/search/command`**, and do not run `contracts/hybrid-search.test.ts` (it cannot import until U5). `pnpm test` (whole suite) is therefore not a gate in this unit.
- **Test Database:** up (`pnpm db:up`; PG16 + PostGIS + pgvector with ICU). `.env.test` provides `TEST_DATABASE_URL`, loaded by `vitest.config.ts`; `fileParallelism` is `false`. DB tests get the URL only through `requireTestDatabaseUrl()`. Never use `DATABASE_URL`. Note: the `test:db` script does not yet include `tests/search` (U5 extends it), so run `tests/search` explicitly.

## 1. Context Manifest

Read these files, and only these. Follow `.agrules` (sections 1, 2, 4 and 5) and the stack in `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, ESLint `strictTypeChecked`. Use `import type` for types, extensionless relative imports, `unknown` only for caught errors. Any new type alias or interface in `src/search/` goes in `src/search/types.ts`. No `console`, no `process.env` in `src/search/`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 1 (search embeds only the query, never calls Wikimapia), 2 (validated answers), 3 (**no SQL outside `src/db/`**), 4 (no live calls, no secrets, synthetic data), 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions ("Voyage client", "Embeddings"). Do not edit it. |
| 3 | `docs/al4-design/20261027-hybrid-search-al4.md` | Read only. Section "0" ("Order of checks", "Single source of truth", "Code style", "Current red state"); "0.1" rows "DB connections" and "Query-side Voyage adapter"; "1.1" "Search side" table and the test paragraph after it; **"1.2 Search flow" in full**; "1.3" (`src/search/*.ts` block and `PlaceSearchQuery`); "1.4.2" (messages only, for context); "1.4.8" last paragraph ("`searchPlaces` creates the store only after ..."); "1.5"; "4" intro, "Baseline caveat" and **"U4" in full**; "5. AL2 Guidance" bullets "Close before resolve", "Never copy error messages", "Lazy SDK import", "`exactOptionalPropertyTypes`", "`unknown`", "Tests". Skip 1.4.1, 1.4.3 .. 1.4.7, 1.4.9 .. 1.4.11, U1 .. U3, U5. |
| 4 | `docs/al6-requirements/20261027-hybrid-search-al6.md` | Background only. Section 3.7 (AC-46 .. AC-55, AC-70), 3.8 (AC-56 .. AC-60), rule 6 in section 4; AC-1, AC-3, AC-13, AC-27, AC-31, AC-34 for the happy-path expectations. |
| 5 | `contracts/hybrid-search.schema.ts` | `SearchDependencies` (~313), `SearchOutcomeSchema` / `SearchOutcome` (~408), `SearchPlacesFn` (~423), `checkSearchRequest` (~441), `SearchRequest` (~206), `queryTextToEmbed`, `normalizeTagTitle` (~152), `effectiveLimit`, `effectiveMode`, `hasRadiusFilter` (~260), `SearchFailureSchema` (~386), `findResultListIssues` (~529, tests only), `SEARCH_PARAMETERS`, `MAX_*` constants, `VOYAGE_API_KEY_ENV`. |
| 6 | `contracts/hybrid-search.support.ts` | `SimulatedQueryEmbeddingService` (~105, `.calls`, `.texts`), `queryAnswer` (~74), `queryEmbeddingQ`, `POINT_S`, `AREA_B`, `SEARCH_SET`, `SEARCHABLE_RANKING`, `seedSearchSet` (~436), `seedPlaces`, `searchSetPlace`. |
| 7 | `contracts/embeddings.support.ts` | `TEST_VOYAGE_API_KEY` (~34), `fakeVector` (~54), `rateLimitError`, `refusedError`, `unavailableError`, `connectionError` (~89-110). |
| 8 | `contracts/storage.support.ts` | `requireTestDatabaseUrl` (~50), `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD` (~89-90). |
| 9 | `contracts/hybrid-search.test.ts` | Read only, as the reference for how the contract will call `searchPlaces` in U5: lines ~135-338 (lifecycle, `fetch` stub, `search` helper, `expectNoSecrets`) and ~1089-1305 (AC-46 .. AC-60). Do not run it, do not copy it wholesale. |
| 10 | `src/search/failures.ts`, `src/search/query-embedding.ts`, `src/search/types.ts` | The U1 building blocks `searchPlaces` composes. Do not change them. |
| 11 | `src/embed/voyage-service.ts` (lines ~76-91), `src/embed/settings.ts` (lines ~19-27) | `createVoyageQueryEmbeddingService(options)`; `isMissingApiKey`, `MISSING_KEY_MESSAGE`. Do not change them. |
| 12 | `src/db/search-store.ts`, `src/db/types.ts` (`PlaceSearchQuery` ~380, `PlaceSearchStore` ~406, `StoreResult` ~69) | The store `searchPlaces` opens and closes. Do not change them. |
| 13 | `src/db/connection.ts` (`createDb` ~34, `destroyQuietly` ~50) | Test-only: the test's own handle for the `pg_stat_activity` count. |
| 14 | `tests/db/place-search.db.test.ts` | Style reference only: lifecycle (lines ~70-98) and `otherBackends()` (~614-633). Do not edit it. |
| 15 | `tests/search/query-embedding.test.ts` | Style reference for `tests/search/` imports and the Simulated service. Do not edit it. |

No other `src/` file is needed. Use `createPlaceStore`, `createEmbeddingStore` and `createSchemaSetup` only through their public factories for seeding and setup.

## 2. Execution Directives

### 2.1 add-test-writer

Create **`tests/search/search-places.db.test.ts`** (AL4 U4 "Unit tests must cover"). It tests the real `searchPlaces` from `src/search/search-places`, which does not exist yet; the file is expected to fail on import at handover.

**Lifecycle** (mirror `tests/db/place-search.db.test.ts`): `beforeAll` stubs global `fetch` to record and reject (as the contract file does, and assert at the end that it was never called), gets `testUrl` from `requireTestDatabaseUrl()`, applies Schema Setup, opens a Place Store, an Embedding Store and one test-owned `createDb(testUrl, 1)` handle; `beforeEach` runs `emptyStore()`; `afterAll` re-applies Schema Setup and closes/destroys everything, then `vi.unstubAllGlobals()`. Seed only with `seedSearchSet` / `seedPlaces` (and `searchSetPlace` for expectations). Every call gets a `SimulatedQueryEmbeddingService` and the synthetic `TEST_VOYAGE_API_KEY` unless the test is about the key. Parse every outcome with `SearchOutcomeSchema`; on list outcomes also assert `findResultListIssues(request, results)` is `[]`. Parse every `db.raw` result with Zod on the next line. Never paste a vector literal; never reach Voyage, Anthropic or Wikimapia.

**Module seams (the only test doubles besides the Simulated service).** Two cases cannot be produced with real collaborators, so use `vi.mock` with a **pass-through by default**, overridden for single tests only:
- `../../src/db/search-store`: `createPlaceSearchStore` is a `vi.fn` that delegates to the real factory (`importOriginal`); individual tests override it once with a hand-built `PlaceSearchStore`.
- `../../src/embed/voyage-service`: `createVoyageQueryEmbeddingService` is a `vi.fn` whose default implementation rejects with a "must not be called" error; individual tests override it once. This makes "no SDK load when a service is injected" observable and guarantees no real Voyage client is ever built.
- Reset the mocks' one-off implementations in `afterEach`. No other module is mocked; all other tests run against the real store and Test Database.

**Test groups** (focused subset; the contract file is the full net in U5):

1. **Happy path, both modes** (`exact`, `approximate`, and mode omitted): AC-1 (no filter: Exact gives `SEARCHABLE_RANKING` with similarities within `SIMILARITY_TOLERANCE` of the support's values; Approximate gives a Ranking-Order subset with true scores) and AC-13 (Point S, 500 m: Exact ids and `distanceMetres` within `DISTANCE_TOLERANCE_METRES` of `wgs84DistanceMetres`). Assert the service was called exactly once per search with a request that parses with `QueryEmbeddingRequestSchema`. Without a Radius Filter no result has a `distanceMetres` key.
2. **Query Text sent trimmed (AC-3):** `'  Музеј на тргу \t'` (Cyrillic, surrounding spacing) is sent as exactly `[queryTextToEmbed(text)]`, inner text unchanged.
3. **Invalid Search Request (AL6 3.7):** one case per AC-46 .. AC-55 and AC-70 (a table like the contract's, both modes where meaningful). Each gives `kind: 'invalid_request'` with the expected `parameter`, **0 service calls**, with `connectionString: UNREACHABLE_DATABASE_URL`, and `createPlaceSearchStore` was **not called** (mock call count 0).
4. **Missing Key (AC-56):** key absent, `''` and `'  \t '`, each with an injected service and `UNREACHABLE_DATABASE_URL`: `missing_key`, message contains `VOYAGE_API_KEY`, 0 service calls, store factory not called, voyage-service factory not called.
5. **Query Embedding Failure (AC-57, AC-58):** each AC-57 answer (four error makers, the six invalid answers) plus model `voyage-3.5` gives `query_embedding_failed` of the stated kind, exactly 1 service call, store factory not called (with `UNREACHABLE_DATABASE_URL`, the outcome is never `store_unavailable`).
6. **Adapter selection (AL4 1.2 step 3):**
   - injected service: the voyage-service factory is never called;
   - no injected service, key `'  key-with-spaces  '` (synthetic): the factory is called once with `{ apiKey: 'key-with-spaces', timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS }` (override resolves a `SimulatedQueryEmbeddingService`), and the search succeeds on the seeded Search Set;
   - the factory rejects: outcome is `query_embedding_failed` / `connection` with message `Embedding Service client could not be loaded`, store factory not called.
7. **Store Unavailable (AC-59, AC-60):** a good embedding and `UNREACHABLE_DATABASE_URL` give `store_unavailable` within a 60 s test timeout; blank `connectionString` `''` gives `store_unavailable` too. Run `expectNoSecrets`-style checks (no `TEST_VOYAGE_API_KEY`, no `Bearer `, no `UNREACHABLE_PASSWORD`, no `postgres://`, no test DB password) over `JSON.stringify(outcome)` for every failure kind produced in this file.
8. **Tag normalisation (AC-27, AC-31, AC-34):** `['museum']`, `[' Museum ']`, `['MUSEUM']` and `['museum', ' MUSEUM ']` all give AC-27's ids (102, 101) in Exact mode.
9. **Gate and internal-error fallback** (store factory overridden once with a fake store that records the order of its calls):
   - `searchMatchingPlaces` rejects with an `Error` carrying a secret-looking message: `searchPlaces` **resolves** to `INTERNAL_FAILURE` (or another `store_unavailable` whose message does not contain the error text), and `close()` was called before the promise resolved;
   - `searchMatchingPlaces` resolves `ok` with two valid results **out of Ranking Order**: outcome is `store_unavailable` with message `Place Store unavailable: search results failed the result check` (never a partial list), `close()` called;
   - `searchMatchingPlaces` resolves `{ ok: false, failure: storeUnavailable-like }`: outcome is `store_unavailable` with exactly that message;
   - the fake store receives a `PlaceSearchQuery` with `mode`, `limit` from `effectiveMode` / `effectiveLimit`, `radius` only with a Radius Filter, `area` only with an Area Filter, `tagTitles` normalized and deduplicated, and no `undefined`-valued keys (`not.toHaveProperty`).
10. **Connection hygiene ("close before resolve"):** with the real store, measure `otherBackends()` (pattern of `tests/db/place-search.db.test.ts` ~614-624) after seeding, then run 30 sequential searches mixing success, store failure (`UNREACHABLE_DATABASE_URL`) and embedding failure, both modes; immediately after the last promise resolves (no sleep, no `afterEach` grace), the count equals the baseline. Timeout 120 s.

Expected red state at handover: the file fails to import `src/search/search-places`. `tests/search/failures.test.ts`, `tests/search/query-embedding.test.ts` and all of `tests/db` stay green. Do not edit any existing test file or anything under `contracts/`.

### 2.2 add-coder

Make the tests of 2.1 green. Import contract schemas, types and helpers from `../../contracts/...`; never copy or redefine them (AL4 "Single source of truth"). **Do not edit any test file.**

1. **Create `src/search/search-places.ts`** exporting `searchPlaces: SearchPlacesFn` (typed with the contract's `SearchPlacesFn`), implementing AL4 1.2 step by step:
   1. `checkSearchRequest(request)`; on failure return `{ ok: false, failure }`. From here on use only `checked.request`, never the raw argument.
   2. Missing key via `isMissingApiKey(deps.apiKey)` -> `missingKeyFailure()`; this check runs even when `deps.embeddingService` is given. Keep the narrowed key in a local (no non-null assertion).
   3. Service = `deps.embeddingService`, otherwise `await createVoyageQueryEmbeddingService({ apiKey: key.trim(), timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS })`; if that throws or rejects -> `embeddingFailure('connection', 'Embedding Service client could not be loaded')`. Never import `voyageai` directly.
   4. `embedQueryText(service, queryTextToEmbed(r.queryText))` exactly once; `!ok` -> its `failure`.
   5. Build `PlaceSearchQuery` exactly as AL4 1.2 step 5 (conditional spreads; tag titles `normalizeTagTitle` + `Set` dedupe, spread into a fresh array).
   6. `createPlaceSearchStore({ connectionString: deps.connectionString })` only now; `try { search } finally { await store.close() }`. `!ok` -> `storeFailure(s.failure)`.
   7. Gate: `SearchOutcomeSchema.safeParse({ ok: true, results: s.value })`; failure -> `storeFailure({ message: 'Place Store unavailable: search results failed the result check' })`; success -> return `gate.data`.
   - Wrap the whole body in an outer `try/catch` that returns `{ ok: false, failure: INTERNAL_FAILURE }`. The function never rejects, never post-filters, re-ranks or deduplicates results, and never puts an error's message, SQL, binding or connection string into a failure.
2. **`src/search/types.ts`:** change only if you declare a new type alias or interface in `src/search/` (it must live there). Prefer contract types and `PlaceSearchQuery` from `src/db/types.ts`; do not add types you do not need.
3. **No other file changes.** `failures.ts`, `query-embedding.ts`, `voyage-service.ts`, `settings.ts` and everything in `src/db/` stay as they are. If a test needs a change there, stop and report it.
4. Run the "Done when" commands and fix the code until they pass. If a test seems to contradict AL4 1.2 or the contract, stop and report to the orchestrator; do not edit the test.

### 2.3 Done when

Precondition: the Test Database is up (`pnpm db:up`) and `.env.test` provides `TEST_DATABASE_URL`. All of the following hold:

- `pnpm exec vitest run --no-color tests/search tests/db contracts/hybrid-search.schema.test.ts` passes (includes the new `tests/search/search-places.db.test.ts` and the unchanged U1 .. U3 tests).
- Regression: `pnpm test:db` passes (unchanged file set; no regressions in `tests/db`, `tests/embed`, `tests/crawl` and the storage, hydration and embeddings contracts).
- `pnpm exec eslint src/search tests/search` reports no problems.
- `pnpm exec tsc --noEmit` reports exactly one error: the unresolved import of `src/search/command` in `contracts/hybrid-search.test.ts`. The `src/search/search-places` import error is gone.
- `pnpm lint` reports only that same `src/search/command` unresolved import.
- Grep checks (code, not comments) under `src/search/`: no `knex`, `db.raw`, `select ` SQL text, `process.env`, `console.` or `from 'voyageai'`; `createPlaceSearchStore` is called only in `search-places.ts` and only after `embedQueryText`; `src/search/command.ts` does **not** exist.
- No contract test turns green directly in this unit; `contracts/hybrid-search.test.ts` is not run.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT modify anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the support files). Also leave `CLAUDE.md`, `.agrules`, `.env*`, `package.json`, `vitest.config.ts`, `eslint.config.js`, `docker-compose.yml` and every migration unchanged.
- Your code MUST pass the tests and schemas defined in AL5 and the U4 tests derived from AL4. If the code fails, fix the code, not the contract or the spec. If a contract or the AL4 spec looks wrong or contradictory, stop and report to the orchestrator instead of working around it (`.agrules` section 0).
- No SQL outside `src/db/` (`.agrules` 3). `searchPlaces` reaches the database only through `createPlaceSearchStore`.
- Tests run only against the Test Database. No live Voyage, Anthropic or Wikimapia call and no real key anywhere; the only keys are `TEST_VOYAGE_API_KEY` and obviously synthetic strings.

## 4. Out of Scope

Do not implement these now:

- **U5:** `src/search/args.ts`, `src/search/output.ts`, `src/search/command.ts`, `scripts/search.ts`, the `package.json` `search` script and the `test:db` extension (AL4 1.4.6, 1.4.7). Do not create stubs for them.
- **Done units (U1 .. U3):** the Voyage query adapter, `embedQueryText` and the failure builders; the search statement, tag folding, `validatePlaceSearchQuery`, the search store and its pools, `hnsw.ef_search` (D-EF). Do not change them or their tests.
- **Not part of this feature:** a long-lived or shared search pool (Stage 3), the HTTP framework, the LLM intent parser and reranking, result-card links (`/ru/{title_slug}`), any retry of the Embedding Request (decision Q10), and recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator's job).
