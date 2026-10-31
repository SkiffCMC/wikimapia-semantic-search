# AL4 Design: Hybrid Search (Place Search)

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **AL7 source:** `docs/al7-intent/20261027-hybrid-search-al7.md`
- **AL6 source:** `docs/al6-requirements/20261027-hybrid-search-al6.md` (revision 4, 2026-10-31: AC-1 .. AC-72, rules 1 .. 13, decisions Q1 .. Q11 incl. the Q11 follow-up, R-A, R-B; section 5 notes for AL4)
- **AL5 sources (stakeholder-approved; command-form update approved with AL6 revision 4):** `contracts/hybrid-search.schema.ts` (entry points, constants, `SearchRequestSchema`, `checkSearchRequest`, `queryTextToEmbed`, `normalizeTagTitle`, `QueryEmbeddingRequestSchema`, `QueryEmbeddingService`, `SearchDependencies`, `SearchResultSchema`, `SearchOutcomeSchema`, `SearchFailureSchema`, `compareRankingOrder`, `findResultListIssues`, `wgs84DistanceMetres`, command constants incl. `SEARCH_COMMAND_FORM`, `SEARCH_USAGE_PREFIX` = `Usage: pnpm run search`, `isSearchUsageLine`, and line builders), `contracts/hybrid-search.test.ts` (behaviour, black box, Test Database; AC-44 asserts `isSearchUsageLine`), `contracts/hybrid-search.schema.test.ts` (schema-only, green before AL2), `contracts/hybrid-search.command.test.ts` (AC-72: runs the real `pnpm run search --fast` and `pnpm run search -- --fast` from the project root; no database, no key, network blocked), `contracts/hybrid-search.support.ts` (Search Set, Point S, Area B, Simulated Query Embedding Service, synthetic vectors, oracles).
- **Builds on:** `docs/al4-design/20261021-storage-al4.md` (`src/db/` connection, failures, guarded store pattern, `places` / `tags` / `place_tags` schema, Tag read-back order), `docs/al4-design/20261023-embeddings-al4.md` (`place_embeddings`, HNSW index, `src/db/vector.ts`, Voyage adapter `src/embed/voyage-service.ts`, `isMissingApiKey`, `MISSING_KEY_MESSAGE`, the command/script pattern, `scripts/load-env.ts`).
- **Binding rules:** `.agrules` sections 1 (spatial-filtered hybrid search: filters restrict, `<=>` ranks; nothing outside the bounds; search embeds only the query, never calls Wikimapia), 2 (validated Embedding Service answers, one model per column, `query` input type, result links back to its Place), 3 (all SQL in `src/db/`, parameterized only, no migration needed), 4 (licensing and attribution, no secrets, no live calls in tests, synthetic data, strict types), 5 (extensionless imports, `unknown` only where allowed, types in `types.ts`).
- **Status:** Ready for AL3 Routing
- **Revision 2 (2026-10-29):** records the stakeholder decision D-EF (Approximate mode runs with `hnsw.ef_search` = 100, set as a connection startup parameter of the per-call pool; sections 0.1, 1.4.4, 1.4.8, 1.4.9, 1.5, 2, U3, 5). U1 (done) and U2 (Exact mode, in progress) are unchanged; the work lands in U3. The contracts do not change.
- **Revision 3 (2026-10-29):** fixes three gaps in the U3 test plan that the AL2 test writer found and confirmed with probes on the Test Database. (1) Test-only planner settings: `enable_seqscan = off` alone does not give the HNSW plan for the correct Approximate statement, so plan-guard tests now use the fixed pair `enable_seqscan = off` + `enable_sort = off` (new 1.4.10). (2) A real proof of D-EF: the contract support's orthogonal vectors give a degenerate HNSW graph (a forced HNSW scan finds 37 rows at ef_search 100 or 1000), so the forced-plan test moves to its own file and runs on a new test-local, deterministic, connected vector cloud `tests/db/hnsw-cloud.ts` (new 1.4.11). The store-level "exactly 50" test stays, but it is explicitly not evidence for `ef_search`. (3) The U3 grep rule now exempts the `searchSessionOptions` assertion in `tests/db/search-session.test.ts` and allows the two planner settings. Changed: sections 1.1 (test seeding note), 1.4.9, 1.4.10 and 1.4.11 (new), U3, 5. U1, U2, U4, U5, the product design and the contracts are unchanged.
- **Revision 4 (2026-10-31):** follows AL6 revision 4 (decision Q11 and its follow-up, rule 13, new AC-72) and the updated contracts. `pnpm search ...` is handled by pnpm itself (an npm registry search) and never reaches the project's script, so the documented form of the Search Command is now `pnpm run search "<Query Text>" [options]` (`SEARCH_COMMAND_FORM`). Changed: the usage line of `usageLine()` (1.4.6), now built from `SEARCH_COMMAND_FORM` and `SEARCH_COMMAND_OPTIONS` so that it passes `isSearchUsageLine`; every place that gives the command form (sections 0, 0.1, 1.1, 1.4.7, 5); the red-state note; and U5 (files, tests, AC-72, the new contract file `contracts/hybrid-search.command.test.ts`, Done-when). The script name `search`, `package.json` and its `test:db` script, and U1 .. U4 are unchanged.

## 0. Scope and Fixed Points

This feature adds **Place Search**: `searchPlaces(request, deps)` validates a Search Request, embeds the trimmed Query Text once with Voyage `voyage-4` as `inputType: "query"`, and then runs **exactly one SQL statement**. That statement restricts the Searchable Places with the Spatial Filter and the Tag Filter, ranks them by cosine similarity (`<=>`) with the Query Embedding, and returns at most the Result Limit in Ranking Order. There are two Search Modes. **Exact** (the default) is a brute-force ranking over the filtered candidate set and always returns the true top N. **Approximate** is the plain HNSW index-ordered search. The **Search Command** (`pnpm run search "<Query Text>" [options]`, `SEARCH_COMMAND_FORM`, decision Q11) wraps it for manual checks. The short form `pnpm search ...` is not the Search Command: pnpm treats it as an npm registry search, so no document, comment or message of this feature uses it (rule 13).

Fixed by AL5, not to be changed by AL3/AL2:

| Item | Value |
|---|---|
| Entry point 1 | `src/search/search-places.ts` exports `searchPlaces: SearchPlacesFn` (`ENTRY_POINT`) |
| Entry point 2 | `src/search/command.ts` exports `runSearchCommand: RunSearchCommandFn` (`SEARCH_COMMAND_ENTRY_POINT`) |
| Script | `package.json` `scripts.search` starts with `tsx ` (`SEARCH_SCRIPT`) |
| Env vars | `VOYAGE_API_KEY` (`VOYAGE_API_KEY_ENV`), `DATABASE_URL` (`DATABASE_URL_ENV`); `.env.example` already carries both (no change) |
| Constants | `DEFAULT_RESULT_LIMIT` 20, `MAX_RESULT_LIMIT` 50, `MAX_QUERY_TEXT_LENGTH` 1000, `MAX_RADIUS_METRES` 50,000, `DISTANCE_TOLERANCE_METRES` 1, `SIMILARITY_TOLERANCE` 1e-6, `DEFAULT_SEARCH_MODE` `exact`, `SEARCHABLE_EMBEDDING_MODEL` = `voyage-4`, `SEARCH_PARAMETERS`, `SEARCH_COMMAND_OPTIONS`, `SEARCH_COMMAND_FORM` (`pnpm run search "<Query Text>" [options]`), `SEARCH_USAGE_PREFIX` (`Usage: pnpm run search`), `SEARCH_OPTION_FOR_PARAMETER`, `SEARCH_FAILURE_LABELS`, `MODE_LINES`, `NO_RESULTS_LINE`, `ATTRIBUTION_LINE` |
| Helpers to reuse (never re-implement) | from `contracts/hybrid-search.schema`: `checkSearchRequest`, `queryTextToEmbed`, `normalizeTagTitle`, `effectiveLimit`, `effectiveMode`, `hasRadiusFilter`, `SearchOutcomeSchema`, `SearchResultSchema`, `resultCountLine`, `searchResultBlock`, `findResultListIssues` and `isSearchUsageLine` (tests only); from `contracts/embeddings.schema`: `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `QUERY_INPUT_TYPE`, `findEmbeddingAnswerIssues`, `classifyEmbeddingServiceError`, `EmbeddingAnswerSchema`, `EmbeddingSchema`; from `contracts/storage.schema`: `StoreConfigSchema`; from `src/embed/settings.ts`: `isMissingApiKey`, `MISSING_KEY_MESSAGE`; from `src/db/`: `createDb`, `destroyQuietly`, `storeUnavailable`, `unavailableFrom`, `toVectorLiteral`; from `scripts/load-env.ts`: `readEnvFile`, `applyEnvDefaults` |
| Unchanged | `createPlaceStore`, `createSchemaSetup`, `createEmbeddingStore`, `buildPlaceDocument`, every migration. **No Schema Setup step, no stored data change (AC-39).** |

**Order of checks (contract header, rule 6):** (1) the Search Request (`checkSearchRequest`; Invalid Search Request: no Embedding Service call, no database), (2) the key (`isMissingApiKey`; Missing Key: no call, no database, also when a service is injected), (3) one Embedding Request (Query Embedding Failure: no database), (4) one SQL statement (Store Unavailable). Every entry point resolves and never rejects.

**Single source of truth.** `src/search/*` and `src/db/*` import schemas, types and helpers from `../../contracts/...`. AL2 never copies or redefines them. Contract `z.infer` types are imported with `import type`.

**Code style (`.agrules` section 5).** Relative imports carry no extension. Every type alias or interface declared in `src/search/` lives in `src/search/types.ts`. Those declared in `src/db/` live in `src/db/types.ts`, and those in `src/embed/` in `src/embed/types.ts`. Use `unknown` only for caught errors, the raw Embedding Service answer, raw `db.raw` results that are parsed with Zod on the next line, and validator parameters.

**HTTP framework:** not needed here, because the Search Command is a CLI and Place Search is a function. The open decision in `CLAUDE.md` stays open, for Stage 3.

**Current red state resolved by the units:** `contracts/hybrid-search.test.ts` cannot resolve `src/search/command` and `src/search/search-places`. That gives 2 unresolved-import lint errors and matching tsc errors. U4 fixes `search-places` and U5 fixes `command`. `contracts/hybrid-search.schema.test.ts` is green already and stays green. **Revision 4 red state:** with U1 .. U5 implemented to revision 3, the imports resolve, but the AC-44 case of `contracts/hybrid-search.test.ts` (`isSearchUsageLine`) and both cases of `contracts/hybrid-search.command.test.ts` (AC-72) fail, because `usageLine()` still prints the old form; `tests/search/args.test.ts` pins that old text. The U5 revision-4 delta fixes all of them.

### 0.1 Decisions made by this design (for the orchestrator to record in `CLAUDE.md`)

| Decision | Choice |
|---|---|
| Search command | `pnpm run search "<Query Text>" [options]` (decision Q11, rule 13; `SEARCH_COMMAND_FORM`), options `[--near <lat>,<lon> --radius <m> \| --bbox <s>,<w>,<n>,<e>] [--tag <title>]... [--limit <n>] [--approximate]`. **Never document it as `pnpm search`:** pnpm handles that form itself as an npm registry search and it never reaches the project script. `pnpm run search -- <args>` also works (the parser drops one leading `--`). The script name stays `search`, run by `tsx scripts/search.ts`. It reads `.env` through `scripts/load-env.ts` (the shell wins) and searches the Development Database (`DATABASE_URL`). |
| One statement per search | Each search is one parameterized `SELECT` (`db.raw`), built only from constant SQL fragments plus `?` bindings. No explicit transaction, no `SET`, no second query (no Tag Catalogue pre-read). |
| Exact mode | Brute force over a `MATERIALIZED` CTE of all Matching Places (an optimizer fence), ranked by `similarity desc, place_id asc`. The query never carries an `ORDER BY <embedding> <=> ...` that the HNSW index could serve, so the true top N comes back whatever the filter selectivity (AC-10). |
| Approximate mode | The plain pgvector HNSW pattern: filters in `WHERE`, `ORDER BY e.embedding <=> ?::vector LIMIT n` as the only sort key, then an outer re-sort into Ranking Order. It runs with `hnsw.ef_search` = `APPROXIMATE_HNSW_EF_SEARCH` (100), see decision D-EF. There is no iterative scan (the pgvector default `hnsw.iterative_scan = off` stays). |
| **D-EF: Approximate `hnsw.ef_search` (stakeholder decision, 2026-10-29)** | In Approximate mode, pgvector's `hnsw.ef_search` is raised from the default 40 to **100**, the named constant `APPROXIMATE_HNSW_EF_SEARCH` in `src/db/search-session.ts`. An HNSW scan then yields up to 100 candidates, so `--approximate --limit 50` can return 50 results; without the change an index-ordered search stops at 40. **Mechanism:** a per-connection startup parameter of the per-call search pool, the pg/libpq `options: '-c hnsw.ef_search=100'` connection parameter (Knex `PgConnectionConfig.options`, pg 8.23). It is **not** a `SET`, `SET LOCAL` or `set_config` statement, so each search stays one SQL statement (AL7). Only the Approximate pool carries it. The Exact pool is opened exactly as before (no `options`), and Exact still never uses the HNSW index (1.4.4, U3 plan test). Filtered Approximate searches may still return fewer than N (AC-67, unchanged). Details and rejected alternatives: 1.4.9. |
| Tag title folding | SQL folds catalogue titles with `lower(btrim(t.title, ?::text) COLLATE "und-x-icu")`. The binding is the exact ECMAScript `String.prototype.trim` character set, and ICU root lowercasing is used, which is full Unicode case mapping including Final_Sigma and `İ`, as in `toLowerCase()`. TS normalizes the filter titles with the contract's `normalizeTagTitle`. Equality is bytewise (the collation is deterministic). This requires an ICU-enabled PostgreSQL; the project image (`postgis/postgis:16-3.6`, PG16 built with ICU) has it, and a DB test checks parity. |
| Radius predicate | Coarse `ST_DWithin(centre_point::geography, centre, radius + 1)` (spheroid) plus an exact `ST_Distance(centre_point::geography, centre) <= radius`. The reported Distance is that same `ST_Distance` value, so the boundary is consistent by construction (AC-16). |
| Area predicate | Planar SRID 4326 geometry, not geography: `ST_Intersects(outline_shape, envelope)` when there is an Outline Shape, else `ST_Intersects(centre_point, envelope)`. Edges are included, and box edges are lines of constant latitude/longitude, as in the glossary (Q3). |
| DB connections | One Knex instance with pool max 1 per `searchPlaces` call. It is opened only after the Query Embedding succeeded and is destroyed (`await destroyQuietly`) in `finally` before the call resolves. From U3 on, the store opens that pool lazily on its first search, with the session options of the query's mode (D-EF, 1.4.8). A long-lived pool is a later contract (Stage 3). |
| Query-side Voyage adapter | `createVoyageQueryEmbeddingService` in `src/embed/voyage-service.ts`, a sibling of the document adapter that shares its private client setup. It uses `maxRetries: 0`, a 30 s timeout and no retry (Q10). |
| HTTP framework | Still open (not needed here) |

## 1. Architecture & Subsystems

### 1.1 Module map

In each table, files lower down depend only on files above them (and on the modules noted).

**Embedding side (`src/embed/`, changed):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/embed/types.ts` | types (extended) | Adds `VoyageEmbedRequest`. | adds `VoyageEmbedRequest` |
| `src/embed/voyage-service.ts` | I/O adapter (extended) | A private `openVoyageEmbed(options)` holds the lazy SDK import, client construction and per-call options, so the document and query adapters share it. `createVoyageEmbeddingService` keeps its behaviour. | adds `createVoyageQueryEmbeddingService` |

**Database side (`src/db/`, all SQL of the feature):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/db/connection.ts` | factory (extended in U3) | `createDb` gains an optional third parameter `sessionOptions`, passed as the pg `options` connection parameter only when defined. Existing callers are unchanged. | `createDb` (extended signature) |
| `src/db/search-session.ts` | pure constants (U3) | The Approximate `hnsw.ef_search` value and the per-mode connection options string (D-EF, 1.4.9). It is the only place that names `hnsw.ef_search` in `src/`. | `APPROXIMATE_HNSW_EF_SEARCH`, `searchSessionOptions` |
| `src/db/text-fold.ts` | pure constants | The JS trim character set and the SQL fragment that folds a Tag title. It is the only place that knows how SQL folds text the way `normalizeTagTitle` does. | `JS_TRIM_CHARACTERS`, `FOLDED_TAG_TITLE_SQL` |
| `src/db/rows.ts` | Zod (extended) | Row schema of the search statement. | adds `SearchRowSchema` |
| `src/db/types.ts` | types (extended) | Search query input, statement, row, store. | adds `PlaceSearchQuery`, `SqlStatement`, `SqlBinding`, `SearchRow`, `PlaceSearchStore`, `PlaceSearchStoreOptions` |
| `src/db/validate.ts` | pure (extended) | Validates a `PlaceSearchQuery` before any SQL. | adds `validatePlaceSearchQuery` |
| `src/db/place-search.ts` | SQL (read) | Builds the one statement for either mode (1.4.3, 1.4.4), runs it, parses rows, maps and gates them as `SearchResult[]`. | `buildPlaceSearchStatement`, `selectMatchingPlaces` |
| `src/db/search-store.ts` | factory | `createPlaceSearchStore`: guarded, never rejects; `close()` destroys the pool. From U3 on, the pool is opened lazily per Search Mode through `openSearchDb` (1.4.8). | `createPlaceSearchStore`, `POOL_MAX_SEARCH`, `openSearchDb` (U3) |

**Search side (`src/search/`, no SQL; network only through the Voyage adapter):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/search/types.ts` | types only | Every type of `src/search/`. | section 1.3 |
| `src/search/failures.ts` | pure | Builds Search Failures with fixed, secret-free messages. | `missingKeyFailure`, `embeddingFailure`, `storeFailure`, `INTERNAL_FAILURE` |
| `src/search/query-embedding.ts` | orchestration helper | One Embedding Request, classification, answer validation, vector extraction (1.4.2). | `buildQueryEmbeddingRequest`, `embedQueryText`, `QUERY_EMBEDDING_TIMEOUT_SECONDS` |
| `src/search/search-places.ts` | **public** | Place Search (1.2). Never rejects. | `searchPlaces` |
| `src/search/args.ts` | pure | Command-line parsing into a `SearchRequestDraft` or a usage problem (1.4.6). | `parseSearchArgs`, `usageLine` |
| `src/search/output.ts` | pure | Output lines of a Search Outcome (1.4.7). | `outcomeLines`, `failureLine` |
| `src/search/command.ts` | CLI core (**public**) | Parse, search, write, exit code. Never rejects. | `runSearchCommand` |
| `scripts/search.ts` | script (`tsx`) | Loads `.env`, wires argv, env and stdout, sets `process.exitCode`. Its header doc comment gives the form `pnpm run search "<Query Text>" [options]`. | none |

Unit tests: pure tests go in `tests/search/<module>.test.ts` and `tests/db/text-fold.test.ts`. Test Database tests go in `tests/db/place-search*.db.test.ts` and `tests/search/*.db.test.ts`: Schema Setup is applied in `beforeAll` and `emptyStore()` runs in `beforeEach`. Places and Embedding Records are seeded only through `seedPlaces` / `seedSearchSet` of `contracts/hybrid-search.support.ts`, which uses the real stores. The one exception is the U3 test-local helper `tests/db/hnsw-cloud.ts` (1.4.11), which builds its own deterministic vectors and still writes only through the real stores, using the support's `savePlace` and `saveRecords`. Tests never edit `contracts/`. They never paste a 1024-number literal; vectors are generated in code (`embeddingWithSimilarity`, `queryEmbeddingQ`, `fakeVector`). They never reach Voyage, Anthropic or Wikimapia.

### 1.2 Search flow (`search-places.ts`)

```
searchPlaces(request, deps)                                   never rejects; outer try/catch -> INTERNAL_FAILURE
  1. checked = checkSearchRequest(request)                    contract helper; !ok -> { ok: false, failure: checked.failure }
  2. isMissingApiKey(deps.apiKey) -> missingKeyFailure()      checked even when deps.embeddingService is given (AC-56)
  3. service = deps.embeddingService
               ?? await createVoyageQueryEmbeddingService({ apiKey: deps.apiKey.trim(), timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS })
       adapter cannot be loaded -> embeddingFailure('connection', 'Embedding Service client could not be loaded')
  4. e = await embedQueryText(service, queryTextToEmbed(r.queryText))       exactly one call (AC-2, AC-57); !ok -> e.failure
  5. query: PlaceSearchQuery = {
        queryEmbedding: e.embedding, mode: effectiveMode(r), limit: effectiveLimit(r),
        ...(hasRadiusFilter(r) ? { radius: { centre: r.centre, radiusMetres: r.radiusMetres } } : {}),
        ...(r.area !== undefined ? { area: r.area } : {}),
        ...(r.tags !== undefined ? { tagTitles: [...new Set(r.tags.map(normalizeTagTitle))] } : {}) }
  6. store = createPlaceSearchStore({ connectionString: deps.connectionString })
     try   { s = await store.searchMatchingPlaces(query) }
     finally { await store.close() }                          pool destroyed BEFORE the call resolves
     !s.ok -> storeFailure(s.failure)                          always kind store_unavailable (message already secret-free)
  7. gate = SearchOutcomeSchema.safeParse({ ok: true, results: s.value })
     !gate.success -> storeFailure 'Place Store unavailable: search results failed the result check'
     return gate.data
```

- `r` is `checked.request` (the parsed value), never the raw argument.
- Step 3 runs only after steps 1 and 2. A test that injects a service never loads `voyageai`.
- No result is post-filtered, re-ranked or deduplicated in TS. The statement already returns at most N rows, each Place once, in Ranking Order. Step 7 is a gate, not a fix-up: if it fails, that is a bug, reported as Store Unavailable and never as a partial list.
- Every message comes from `failures.ts` or a store failure (which is already fixed text plus a safe code). Error objects, SDK messages, SQL text, bindings and the connection string never reach a message (AC-60).

### 1.3 Component contracts (signatures)

```ts
// ---------------------------------------------------------------- src/embed/types.ts (addition)
export type VoyageEmbedRequest = EmbeddingServiceRequest | QueryEmbeddingRequest;

// ---------------------------------------------------------------- src/embed/voyage-service.ts (addition)
export function createVoyageQueryEmbeddingService(options: VoyageServiceOptions): Promise<QueryEmbeddingService>;

// ---------------------------------------------------------------- src/search/types.ts
export type QueryEmbeddingResult =
  | { ok: true; embedding: Embedding }                       // 1024 finite numbers, not all zero
  | { ok: false; failure: SearchFailure };                    // kind 'query_embedding_failed'
export type ParsedSearchArgs =
  | { ok: true; draft: SearchRequestDraft }
  | { ok: false; problem: string };                           // usage error text, no input values beyond option names

// ---------------------------------------------------------------- src/search/*.ts
export const QUERY_EMBEDDING_TIMEOUT_SECONDS = 30;                                           // query-embedding.ts
export function buildQueryEmbeddingRequest(text: string): QueryEmbeddingRequest;
export function embedQueryText(service: QueryEmbeddingService, text: string): Promise<QueryEmbeddingResult>;
export function missingKeyFailure(): SearchFailure;                                          // failures.ts
export function embeddingFailure(kind: EmbeddingFailureKind, message: string): SearchFailure;
export function storeFailure(failure: StoreFailure | { message: string }): SearchFailure;
export const INTERNAL_FAILURE: SearchFailure;              // store_unavailable 'Place search failed: internal error'
export const searchPlaces: SearchPlacesFn;                                                   // search-places.ts
export function parseSearchArgs(argv: readonly string[]): ParsedSearchArgs;                  // args.ts
export function usageLine(): string;          // isSearchUsageLine(usageLine()) === true; starts with SEARCH_USAGE_PREFIX (1.4.6)
export function outcomeLines(mode: SearchMode, outcome: SearchOutcome): string[];            // output.ts
export function failureLine(failure: SearchFailure): string;
export const runSearchCommand: RunSearchCommandFn;                                           // command.ts

// ---------------------------------------------------------------- src/db/types.ts (additions)
export interface PlaceSearchQuery {
  queryEmbedding: Embedding;                                  // gated by EmbeddingSchema
  mode: SearchMode;
  limit: number;                                              // 1 .. MAX_RESULT_LIMIT
  radius?: { centre: LatLon; radiusMetres: number };          // never together with area
  area?: AreaFilter;
  tagTitles?: readonly string[];                              // normalized, unique, at least one; any count
}
export type SqlBinding = string | number | string[];
export interface SqlStatement { sql: string; bindings: SqlBinding[] }
export type SearchRow = z.infer<typeof SearchRowSchema>;
export interface PlaceSearchStoreOptions { connectionString: string }
export interface PlaceSearchStore {
  searchMatchingPlaces(query: PlaceSearchQuery): Promise<StoreResult<SearchResult[]>>;      // never rejects
  close(): Promise<void>;                                                                    // idempotent
}

// ---------------------------------------------------------------- src/db/*.ts (additions)
export const JS_TRIM_CHARACTERS: string;                                                     // text-fold.ts
export const FOLDED_TAG_TITLE_SQL: string;     // 'lower(btrim(t.title, ?::text) COLLATE "und-x-icu")' (one binding: JS_TRIM_CHARACTERS)
export const SearchRowSchema: z.ZodType;                                                     // rows.ts
export function validatePlaceSearchQuery(input: unknown): Validated<PlaceSearchQuery>;      // validate.ts
export function buildPlaceSearchStatement(query: PlaceSearchQuery): SqlStatement;           // place-search.ts (pure)
export function selectMatchingPlaces(db: Knex, query: PlaceSearchQuery): Promise<SearchResult[]>;
export const POOL_MAX_SEARCH = 1;                                                            // search-store.ts
export function createPlaceSearchStore(options: PlaceSearchStoreOptions): PlaceSearchStore;
export function openSearchDb(connectionString: string, mode: SearchMode): Knex;             // search-store.ts (U3)
  // = createDb(connectionString, POOL_MAX_SEARCH, searchSessionOptions(mode))
export const APPROXIMATE_HNSW_EF_SEARCH = 100;                                               // search-session.ts (U3; D-EF)
export function searchSessionOptions(mode: SearchMode): string | undefined;
  // 'approximate' -> `-c hnsw.ef_search=${APPROXIMATE_HNSW_EF_SEARCH}`; 'exact' -> undefined
export function createDb(connectionString: string, poolMax: number, sessionOptions?: string): Knex;  // connection.ts (U3 extension)
```

### 1.4 Detailed behaviour per subsystem

#### 1.4.1 Query-side Voyage adapter (`voyage-service.ts`)

```
openVoyageEmbed({ apiKey, baseUrl?, timeoutSeconds = 120 }):          private, shared
  { VoyageAIClient } = await import('voyageai')                          lazy, as today
  client = new VoyageAIClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) })
  return async (request: VoyageEmbedRequest) => {
    try   { return normaliseVoyageAnswer(await client.embed({ input, model, inputType, outputDimension,
                                                               ...(truncation defined ? { truncation } : {}) },
                                                             { maxRetries: 0, timeoutInSeconds })) }
    catch (e) { 2xx statusCode -> return undefined; otherwise rethrow unchanged }
  }
createVoyageEmbeddingService(o)      = { embed: await openVoyageEmbed(o) }          behaviour unchanged
createVoyageQueryEmbeddingService(o) = { embed: await openVoyageEmbed(o) }          typed QueryEmbeddingService
```

`searchPlaces` passes `timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS` (30), which is short enough for an interactive search. A timeout has no status code, so it is a Connection Failure. The adapter never logs, never reads `process.env` and never builds a message.

#### 1.4.2 Query embedding (`query-embedding.ts`; AC-2, AC-3, AC-57, AC-58, AC-60, rule 5)

```
buildQueryEmbeddingRequest(text) = { input: [text], model: EMBEDDING_MODEL, inputType: QUERY_INPUT_TYPE,
                                     outputDimension: EMBEDDING_DIMENSIONS }          (no `truncation`: Voyage's default is true)
embedQueryText(service, text):
  try   answer = await Promise.resolve().then(() => service.embed(buildQueryEmbeddingRequest(text)))   (sync throws caught too)
  catch e -> kind = classifyEmbeddingServiceError(e)                                  exactly one call, no retry (Q10)
             return { ok: false, failure: embeddingFailure(kind, MESSAGE[kind](e)) }
  issues = findEmbeddingAnswerIssues(answer, 1)
  issues.length -> embeddingFailure('invalid_answer', `The Embedding Service answer is invalid: ${issues[0]}`)
  item = EmbeddingAnswerSchema.parse(answer).data[0]                                  (noUncheckedIndexedAccess: check undefined)
  vector = EmbeddingSchema.parse(item.embedding)
  vector.every(v => v === 0) -> embeddingFailure('invalid_answer', 'The Embedding Service answer is invalid: the Query Embedding is all zeros')
  return { ok: true, embedding: vector }
```

Fixed messages (`MESSAGE[kind]`):
- `connection`: `The Embedding Service could not be reached.`
- `rate_limit`: `The Embedding Service answered with its rate limit; try again later.`
- `refused`: `The Embedding Service refused the request (HTTP <status>). Check VOYAGE_API_KEY and the Voyage account.` (`<status>` only when `statusCode` is a number).

The simulated errors carry `Bearer <key>`, so the error's own message is never used. The zero-vector check exists because a zero Query Embedding has no cosine similarity (pgvector answers NaN). The contract's `findEmbeddingAnswerIssues` accepts it, so this check adds a stricter `invalid_answer`; it never relaxes one. `missingKeyFailure()` = `{ kind: 'missing_key', message: MISSING_KEY_MESSAGE }`, which names `VOYAGE_API_KEY`.

#### 1.4.3 The search statement: shared fragments (`place-search.ts`, `text-fold.ts`)

`buildPlaceSearchStatement(query)` is pure. It concatenates **only constant SQL text**: the fragments below, chosen by which filters are present and by the mode. Every value is a `?` binding, pushed in the same order as its placeholder. No value, title, number or vector is ever interpolated (`.agrules` section 3, AC-40). Every binding carries an explicit cast, so parameter types never depend on inference. Notation: `$V` = `?::vector` bound to `toVectorLiteral(queryEmbedding)`, and `$C` = `ST_SetSRID(ST_MakePoint(?::float8, ?::float8), 4326)::geography` bound to **`lon, lat`** in that order (`ST_MakePoint(x, y)`).

| Fragment | SQL | Bindings |
|---|---|---|
| SEARCHABLE (always) | `e.embedding_model = ?::text and p.details_fetched_at is not null and p.is_deleted = false` | `SEARCHABLE_EMBEDDING_MODEL` |
| RADIUS_COARSE | `ST_DWithin(p.centre_point::geography, $C, ?::float8)` | `lon, lat, radiusMetres + RADIUS_MARGIN_METRES` (= 1) |
| DISTANCE (expression) | `ST_Distance(p.centre_point::geography, $C)` | `lon, lat` |
| AREA | `((p.outline_shape is not null and ST_Intersects(p.outline_shape, ST_MakeEnvelope(?::float8, ?::float8, ?::float8, ?::float8, 4326))) or (p.outline_shape is null and ST_Intersects(p.centre_point, ST_MakeEnvelope(?::float8, ?::float8, ?::float8, ?::float8, 4326))))` | `west, south, east, north`, twice |
| TAGS | `exists (select 1 from place_tags pt join tags t on t.tag_id = pt.tag_id where pt.place_id = p.place_id and pt.presence = 'present' and ` + `FOLDED_TAG_TITLE_SQL` + ` = any(?::text[]))` | `JS_TRIM_CHARACTERS`, `[...tagTitles]` |
| RESULT_TAGS (expression) | `coalesce((select array_agg(t.title order by pt.position, pt.tag_id) from place_tags pt join tags t on t.tag_id = pt.tag_id where pt.place_id = p.place_id and pt.presence = 'present'), '{}'::text[])` | none |

Rules behind the fragments:

- **Searchable Places (R-A, Q5, AC-4, AC-11):** an inner join `place_embeddings e join places p on p.place_id = e.place_id` (the PK on both sides gives each Place at most once), with model `voyage-4`, Detailed, and not deleted. The Document Fingerprint is ignored, so an Embedding Due Place is still searched.
- **Radius (AC-13 .. AC-20, rule 3):** Distance is measured from the Centre Point only (never the Outline Shape) on the WGS 84 spheroid. PostGIS geography `ST_Distance` uses the spheroid by default and is accurate far inside 1 m of Vincenty (AC-14). `ST_DWithin(..., radius + 1)` is the coarse spheroid test the stakeholder named. The **exact** test is `DISTANCE <= radiusMetres`, and the reported `distanceMetres` is **that same value**: one column in Exact mode, and the identical IMMUTABLE expression on identical inputs in Approximate mode. So a Radius equal to a reported Distance always includes that Place (AC-16). The 1 m margin only absorbs last-bit differences between PostGIS's DWithin and Distance code paths; the exact test decides. A Place at the Search Centre gets exactly 0 because the coordinates are bound as the same doubles.
- **Area (Q3, AC-22 .. AC-26):** this uses **geometry** (planar degrees, SRID 4326), never geography. With geography the box edges would become great-circle arcs, which differs from the glossary's latitude/longitude comparison. `ST_Intersects` is true when the shapes touch, so edges are included (AC-24). The two `outline_shape is [not] null` branches let the planner use `places_outline_shape_gist` and `places_centre_point_gist` (BitmapOr).
- **Tags (Q4, AC-27 .. AC-34):** `EXISTS` is a semi-join, so a Place carrying several matching Tags, or a repeated title, is returned once (AC-34). Only Present links count. Whole titles only: it is an equality test, never `LIKE`. The bound array holds the **already normalized** filter titles (`normalizeTagTitle`, deduplicated, in TS). SQL folds the **catalogue** titles with `FOLDED_TAG_TITLE_SQL` (1.4.5). The Tag Filter has no maximum count. The titles travel as **one** `text[]` binding, so there is no bind-parameter ceiling and the SQL text does not grow with the count (the stakeholder kept the contract as is).
- **Result Tag Titles (AC-35 .. AC-37):** Present links ordered by `position`, then `tag_id`. This is the Place Store read-back order (`orderStoredTags`, present branch). Titles are returned as stored (not trimmed), and `'{}'` is returned when there are none. The expression is evaluated only for the at most N final rows, never for the whole candidate set.
- **Result centre:** `p.location_lat`, `p.location_lon` (the stored doubles the Centre Point was built from; AC-35, AC-68).
- **Similarity:** `1 - (e.embedding <=> $V)` as `float8`, computed once per row and both **ordered by and reported**. Ordering and reporting therefore use the same doubles, and `isInRankingOrder` holds even for two distances that collapse to one similarity (ties then fall to `place_id`). pgvector's cosine uses float32 accumulators. For the contract's float32-exact synthetic vectors the error is below 2e-7, inside `SIMILARITY_TOLERANCE`. Rows whose similarity is NaN (a stored zero vector) are dropped with `similarity <> 'NaN'::float8`. In PostgreSQL NaN equals NaN, so `<>` excludes it.

#### 1.4.4 The search statement per mode (AC-1, AC-5 .. AC-10, AC-63 .. AC-69; AL6 section 5)

`[F]` stands for `SEARCHABLE` and the present filter fragments joined with `and`. `[D]` is `, DISTANCE as distance_metres` with a Radius Filter, otherwise `, null::float8 as distance_metres`.

**Exact mode** (default; the true top N whatever the filter selectivity):

```sql
with candidates as materialized (
  select e.place_id, 1 - (e.embedding <=> $V) as similarity [D]
  from place_embeddings e join places p on p.place_id = e.place_id
  where [F]                                          -- RADIUS_COARSE here, never the exact radius test
),
top_n as (
  select place_id, similarity, distance_metres from candidates
  where similarity <> 'NaN'::float8
    [and distance_metres <= ?::float8]               -- exact radius test on the reported value (radiusMetres)
  order by similarity desc, place_id asc
  limit ?::int                                       -- limit
)
select n.place_id, p.name, p.wikimapia_url, p.location_lat, p.location_lon,
       n.similarity, n.distance_metres, RESULT_TAGS as tags
from top_n n join places p on p.place_id = n.place_id
order by n.similarity desc, n.place_id asc
```

Why this is exact (AC-10, the AL6 section 5 requirement):
- The candidate set is **every** Matching Place. The `WHERE` of `candidates` holds every filter and there is no `LIMIT` before ranking. The spatial and tag predicates may use their GiST and btree indexes; the vector index plays no part in choosing candidates.
- The HNSW index can only serve an `ORDER BY <column> <=> <constant> ASC` scan, and it cannot filter. In Exact mode no such ordering exists at any level. `candidates` has no `ORDER BY`. `top_n` orders by a computed column of a **materialized** CTE scan, and `MATERIALIZED` is an optimizer fence (PG12+), so that ordering cannot be pushed into an index scan of `place_embeddings`. An incremental sort over a partially index-ordered path is therefore also impossible. The ranking is a full sort (top-N heapsort) over all candidates. Its result is exactly the smaller of M and N best Matching Places in Ranking Order. The 1-in-1,000 needle of AC-10 lies beyond any `ef_search` window (40 or 100), and it is found because no `ef_search` window exists in this plan. The Exact pool also carries no `hnsw.ef_search` setting (D-EF), so Exact mode is untouched by that decision in every respect.
- Cost: one cosine distance per Matching Place. With no filter, that is a sequential pass over `place_embeddings` (about 4 KB per row). For the Belgrade data (thousands to tens of thousands of Places) that is well under the 30 s `statement_timeout`. Approximate mode is the fast path when that ever matters.
- AL2 must **not** "simplify" the ranking to `order by e.embedding <=> $V` or drop `MATERIALIZED`. The plan tests in U3 guard this.

**Approximate mode** (plain HNSW index search; may return fewer, never outside the filters):

```sql
select a.place_id, a.name, a.wikimapia_url, a.location_lat, a.location_lon,
       a.similarity, a.distance_metres, a.tags
from (
  select p.place_id, p.name, p.wikimapia_url, p.location_lat, p.location_lon,
         1 - (e.embedding <=> $V) as similarity [D], RESULT_TAGS as tags
  from place_embeddings e join places p on p.place_id = e.place_id
  where [F]
    [and DISTANCE <= ?::float8]                      -- exact radius test, same expression as reported
  order by e.embedding <=> $V                        -- the ONLY sort key: the HNSW-servable form (second $V binding)
  limit ?::int
) a
where a.similarity <> 'NaN'::float8
order by a.similarity desc, a.place_id asc           -- Ranking Order, ties by Place ID (AC-66)
```

- Every filter is in the inner `WHERE`, so whatever plan the planner picks (HNSW index scan with post-filter, or a sequential/GiST plan on small or selective sets), every row returned is a Matching Place (AC-65). The inner `LIMIT` caps the result at N (AC-67), and the join on primary keys gives no repeats.
- `$V` appears twice, as two separate bindings of the same literal: in the select list, and as the bare `ORDER BY` operand. pgvector can use the index only when the order operand is a constant or parameter. It must not come from a joined CTE or subquery. `RESULT_TAGS` in the inner select is evaluated only for rows that pass the limit, because Postgres computes target-list subqueries after `LIMIT` in a Limit-over-scan plan. If the planner were to do otherwise, the result would still be correct, just slower.
- With an HNSW scan, pgvector returns at most `hnsw.ef_search` tuples before filtering. The Approximate connection sets it to `APPROXIMATE_HNSW_EF_SEARCH` = 100 (D-EF, 1.4.9), which is at least `MAX_RESULT_LIMIT` (50). So an Approximate search whose only restriction is the Searchable condition returns N results whenever at least N Searchable Places lie among those candidates; with the Belgrade data, where nearly every Embedding Record is Searchable, that means `--limit 50` returns 50. Under Spatial or Tag Filters (and when many non-Searchable records are near the query) the post-filter can still leave fewer than N, or miss better Places. That is decision Q6 and AC-67, unchanged. Similarity, Distance, name, link, tags and centre are computed exactly as in Exact mode (AC-66, AC-68).
- The statement text is identical with or without the setting. `hnsw.ef_search` is never named in SQL.

**Binding order** follows placeholder order in the final text. `buildPlaceSearchStatement` appends each fragment's bindings as it appends the fragment, so text and bindings cannot drift. A unit test asserts that the count of `?` equals `bindings.length` for every combination of mode × spatial filter × tags. The SQL text must contain no other `?` (no jsonb `?` operators) and no `??`.

#### 1.4.5 Tag title folding parity (`text-fold.ts`; AC-31, AC-32; the orchestrator's Cyrillic requirement)

The contract's rule is `title.trim().toLowerCase()`. The SQL side must give byte-identical text for every catalogue title:

- **Trim:** PostgreSQL `btrim(text)` removes only spaces, while ECMAScript `trim()` removes WhiteSpace and LineTerminator. So `btrim(title, chars)` is used with `chars` = `JS_TRIM_CHARACTERS`, the complete ECMAScript set: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000 .. U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. `btrim` with a character set removes any of them from both ends, exactly like `trim()`. The set is bound as a parameter, not written into the SQL.
- **Lowercase:** `lower(x COLLATE "und-x-icu")`. With an ICU collation, PostgreSQL 16 lowercases through ICU `u_strToLower` with the root locale. That is full Unicode case mapping, context-sensitive and locale-independent, which is what `String.prototype.toLowerCase` does: Cyrillic `МУЗЕЈ` -> `музеј`, Serbian Latin `ĐINĐIĆ` -> `đinđić`, Greek word-final `Σ` -> `ς`, `İ` -> `i̇` (two code points), `ẞ` -> `ß`, Georgian Mtavruli -> Mkhedruli. The database's default libc collation (`en_US.utf8` in the image) is **not** used: it lowercases code point by code point (`towlower`) and gets final sigma and `İ` wrong.
- **Compare:** `= any(?::text[])`. `und-x-icu` is deterministic, so equality is bytewise. No Unicode normalization (NFC/NFD) happens on either side, as in the contract.
- **Precondition:** the `und-x-icu` collation exists (PostgreSQL built with ICU; PG16 default; the project's `postgis/postgis:16-3.6` image qualifies). If it is missing, the statement fails with SQLSTATE 42704 and the search reports Store Unavailable. Nothing falls back silently.
- **Residual risk:** Node's ICU and the server's ICU can differ in Unicode version. Only code points whose case mapping is new in the newer version could differ. The U2 parity test sweeps the whole BMP, so a skew shows up as a failing test, never as a silent mismatch. If it fails, AL2 reports to AL4 and does not patch around it.

#### 1.4.6 Command-line parsing (`args.ts`; AC-41, AC-44, AC-71)

```
parseSearchArgs(argv):
  tokens = argv; drop ONE leading '--' (pnpm passthrough)
  for each token:
    exactly '--near' | '--radius' | '--bbox' | '--limit' | '--tag'  -> value = next token (taken even if it starts with '-', so negative
                                                                       coordinates work); missing -> problem `missing value for <opt>`
        '--tag' may repeat (titles kept in the order given, unchanged); any other valued option twice -> `option <opt> given twice`
    exactly '--approximate'                                         -> flag (repeats allowed, AC-71)
    starts with '--' otherwise (incl. '--approximate=yes', '--fast')-> `unknown option "<token>"`
    anything else                                                   -> the Query Text; a second one -> `more than one query text`
  no Query Text                                    -> `missing query text`
  --radius without --near / --near without --radius -> `--radius needs --near` / `--near needs --radius`
  --near and --bbox together                        -> `give either --near with --radius, or --bbox, not both`
  numbers: NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/ and Number.isFinite(Number(text)); otherwise
           `<opt> needs a number` (AC-44; 'ten', 'abc', 'NaN', 'Infinity', '1e999' are usage errors)
  --near   value split on ',' into exactly 2 parts, each trimmed and NUMBER -> centre { lat: first, lon: second } (Q2)
  --bbox   value split on ',' into exactly 4 parts                          -> area { south, west, north, east } (that order)
  --radius, --limit: NUMBER                                                 -> radiusMetres, limit (2.5 passes; Place Search refuses it)
  draft = { queryText, centre?, radiusMetres?, area?, tags?, limit?, mode?: 'approximate' }   keys only when given
```

Usage problems are found before anything else runs, so there is no Embedding Service call (AC-44). Values that are well-formed but out of range (`--radius 0`, `--limit 51`, `--near 91,20`, `--bbox` with south >= north, `--tag " "`, an empty Query Text `""`) are **not** usage errors. They go to `searchPlaces`, which reports an Invalid Search Request (AC-43).

**Usage line (revision 4; rule 13, AC-44, AC-72).** `usageLine()` must satisfy the contract's `isSearchUsageLine`: it starts with exactly `Usage: pnpm run search "<Query Text>" [options]` (case and spacing as in `SEARCH_COMMAND_FORM`, so `<Query Text>` with capitals and quotes), optionally followed by a single space and more text. It is built only from contract constants, so it cannot drift from the contract:

```
usageLine() = `Usage: ${SEARCH_COMMAND_FORM} where options are `
            + `[${O.near} <lat>,<lon> ${O.radius} <metres> | ${O.bbox} <south>,<west>,<north>,<east>] `
            + `[${O.tag} <title>]... [${O.limit} <n>] [${O.approximate}]`
              (O = SEARCH_COMMAND_OPTIONS)
```

The literal result is:

`Usage: pnpm run search "<Query Text>" [options] where options are [--near <lat>,<lon> --radius <metres> | --bbox <south>,<west>,<north>,<east>] [--tag <title>]... [--limit <n>] [--approximate]`

- `args.ts` imports `SEARCH_COMMAND_FORM` and `SEARCH_COMMAND_OPTIONS`. It never writes `pnpm run search` (or `pnpm search`) as its own literal. `SEARCH_USAGE_PREFIX` is no longer needed in `args.ts`; drop the import if it becomes unused (lint).
- It is one line, with no trailing whitespace and no line break. The command writes it through `io.write`, so the script prints it on stdout. `isSearchUsageLine` tolerates the `\r` a Windows console may add.
- The problem line before it (`Search failed: <problem>`) is unchanged.

#### 1.4.7 Output and exit code (`output.ts`, `command.ts`; AC-42, AC-43, AC-45, AC-71)

```
outcomeLines(mode, outcome):
  ok, n > 0 -> [MODE_LINES[mode], ...results.flatMap((r, i) => searchResultBlock(i + 1, r)), resultCountLine(n), ATTRIBUTION_LINE]
  ok, n = 0 -> [MODE_LINES[mode], NO_RESULTS_LINE, ATTRIBUTION_LINE]
  failure   -> [failureLine(failure)]
failureLine(f):
  invalid_request -> `Search failed: ${LABEL}: ${option}: ${f.message}`
                     option = SEARCH_OPTION_FOR_PARAMETER[f.parameter] when f.parameter is a known key other than 'request', else f.parameter
  other kinds     -> `Search failed: ${SEARCH_FAILURE_LABELS[f.kind]}: ${f.message}`

runSearchCommand(argv, io):                                  never rejects
  try {
    p = parseSearchArgs(argv)
    !ok -> io.write(`Search failed: ${p.problem}`); io.write(usageLine()); return { exitCode: 1 }
    key = io.env.VOYAGE_API_KEY
    outcome = await searchPlaces(p.draft, { connectionString: io.env.DATABASE_URL ?? '',
                                            ...(key !== undefined ? { apiKey: key } : {}),
                                            ...(io.embeddingService ? { embeddingService: io.embeddingService } : {}) })
    for line of outcomeLines(effectiveMode(p.draft), outcome): io.write(line)
    return { exitCode: outcome.ok ? 0 : 1, request: p.draft, outcome }
  } catch { best effort io.write('Search failed: internal error'); return { exitCode: 1 } }
```

- `SearchRequestDraft` is structurally assignable to `SearchRequest`, because the contract's refinements add no TS types. Pass it directly; no cast is needed. `searchPlaces` re-validates it.
- The mode line is printed only for list outcomes, which is the contract's success layout. Failures print one line naming the kind (and, for Invalid Search Request, the option). Usage errors print the problem line and then the usage line.
- `io.env` is the only source of settings (AC-45). The command never reads `process.env` and never prints an env value.

`scripts/search.ts` (same shape as `scripts/embed.ts`, without signal handling, because a search is one call plus one statement): `applyEnvDefaults(readEnvFile(fileURLToPath(new URL('../.env', import.meta.url))))`; `env` built from `process.env[VOYAGE_API_KEY_ENV]` and `process.env[DATABASE_URL_ENV]` (keys only when defined); `write = line => process.stdout.write(line + '\n')`; `result = await runSearchCommand(process.argv.slice(2), { env, write })`; `process.exitCode = result.exitCode`. No `console.*`. The real Voyage query adapter is used. Its header doc comment starts with the documented form `pnpm run search "<Query Text>" [options]` (revision 4; previously `pnpm search "<query text>" [options]`) and may add that `pnpm run search -- <args>` works too. A non-zero `process.exitCode` makes `pnpm run search` exit non-zero, which AC-72 checks.

`package.json`: `"search": "tsx scripts/search.ts"`; `test:db` extended with `contracts/hybrid-search.test.ts tests/search`. Both are already in place, and revision 4 changes neither: the script name stays `search` (Q11: no rename). No new dependency.

**AC-72 test placement (revision 4).** `contracts/hybrid-search.command.test.ts` needs no database, so it is **not** added to `test:db`. It is matched by the default Vitest `include` (`contracts/**/*.test.ts`), so the default run `pnpm exec vitest run --no-color` (and `pnpm test`) runs it. It can also run alone: `pnpm exec vitest run --no-color contracts/hybrid-search.command.test.ts`. It spawns the real `pnpm` through a shell from the project root, with the npm registry pointed at `127.0.0.1:9`, `fetch` blocked by a preload in `NODE_OPTIONS`, and no key or database URL in the environment. Each case may take up to 90 s (the `tsx` start-up). Consequences for AL2:
- `scripts/search.ts` must reach the usage failure without network access, without a key, without a database and with an injected `NODE_OPTIONS` preload. It already does, because `parseSearchArgs` runs first (AC-44). It must not add a `fetch`, a version check or any other start-up work before the parse.
- The script's output must not match the test's npm-registry pattern (`npm error`, `npm warn`, `npm ERR!`, `registry`, `No matches found`, `ECONNREFUSED`, ...). So no line printed by the command may contain those words. The current usage and problem lines do not.
- The test does not depend on a pnpm version (Q11 follow-up). AL2 adds no pnpm version pin or check for it.

#### 1.4.8 Search store (`search-store.ts`; AC-39, AC-59, AC-60, "release before resolving")

Same pattern as `embedding-store.ts`. The factory never throws. `StoreConfigSchema` checks the connection string, then `createDb(connectionString, POOL_MAX_SEARCH)` creates the pool. Creating it does not connect; the statement does. The pool inherits `CONNECT_TIMEOUT_MS` 5 s and `statement_timeout` 30 s.

**From U3 on (D-EF): lazy, mode-specific pool.** The connection options depend on the Search Mode, and the mode is known only from the query. So U3 changes the store as follows. `createPlaceSearchStore` and `PlaceSearchStoreOptions` keep their signatures, and `searchPlaces` (1.2) is unchanged.

```
createPlaceSearchStore({ connectionString }):
  configured = blank or StoreConfigSchema fails ? undefined : parsed connection string     (as today; no pool yet)
  pools: Map<SearchMode, Knex> = empty; closed = false
  searchMatchingPlaces(query):
    validated = validatePlaceSearchQuery(query)          !ok -> invalid_data (no pool, no DB access; as today)
    configured === undefined -> store_unavailable NOT_CONFIGURED_MESSAGE
    closed -> store_unavailable 'Place Store unavailable: the store is closed'   (no pool is opened)
    db = pools.get(mode) ?? (pools.set(mode, openSearchDb(configured, mode)), that pool)
    selectMatchingPlaces(db, validated.value)            failure mapping as in the table below
  close(): closed = true; await destroyQuietly(each pool); pools.clear()      idempotent, never rejects
openSearchDb(cs, mode) = createDb(cs, POOL_MAX_SEARCH, searchSessionOptions(mode))
```

`searchPlaces` runs one search per store, so at most one pool (max 1 connection) is ever opened per call. A store used for both modes (tests only) holds one pool per mode, and `close()` destroys both. Exact searches open their pool exactly as U2 does (`searchSessionOptions('exact')` is `undefined`, so `createDb` gets no `options`).

| Method | Validation | Operation | Failure mapping |
|---|---|---|---|
| `searchMatchingPlaces(query)` | `validatePlaceSearchQuery` (Zod built from contract pieces: `EmbeddingSchema`, `SearchModeSchema`, `LatLonSchema`, `AreaFilterSchema`, `limit` int 1 .. 50, `radiusMetres` > 0 .. 50,000, `tagTitles` non-empty strings, min 1, no max; `radius` and `area` not both) -> `invalid_data` without DB access | `selectMatchingPlaces(db, value)` | not configured -> `store_unavailable` 'Place Store is not configured: connection string is missing or unusable'; `ZodError` -> 'Place Store unavailable: stored data failed the read-back check'; other throw -> `unavailableFrom(error, 'place search')` (fixed text plus a safe SQLSTATE/errno code only) |
| `close()` | none | `destroyQuietly(db)` | idempotent, never rejects |

`selectMatchingPlaces(db, query)`:

```
{ sql, bindings } = buildPlaceSearchStatement(query)
raw: unknown = await db.raw(sql, bindings)
rows = z.object({ rows: z.array(SearchRowSchema) }).parse(raw).rows
results = rows.map(row => ({ placeId: row.place_id, name: row.name, wikimapiaUrl: row.wikimapia_url, tags: row.tags,
                             centre: { lat: row.location_lat, lon: row.location_lon }, similarity: row.similarity,
                             ...(query.radius !== undefined ? { distanceMetres: row.distance_metres } : {}) }))
                             (distance_metres is non-null whenever radius is set; the row schema allows null)
return z.array(SearchResultSchema).parse(results)                    ZodError -> read-back failure
```

`SearchRowSchema` (in `rows.ts`): `place_id` number (int8 through the connection's safe parser), `name` string, `wikimapia_url` string, `location_lat` number, `location_lon` number, `similarity` number, `distance_metres` number or null, `tags` array of strings. `float8` arrives as a JS number (pg's default parser, exact round trip) and `text[]` as a string array (pg's default array parser).

`searchPlaces` creates the store only after a successful Query Embedding (rules 6, AC-56, AC-57: the store is not consulted otherwise) and **awaits `close()` in `finally` before resolving**, on success, on store failure and on throw. So no pooled connection outlives the call (contract `SearchDependencies.connectionString`).

#### 1.4.9 Approximate session setting: `hnsw.ef_search` = 100 (D-EF; `search-session.ts`, `connection.ts`)

**Decision (stakeholder, 2026-10-29).** Approximate mode runs with `hnsw.ef_search` = `APPROXIMATE_HNSW_EF_SEARCH` = **100** instead of pgvector's default 40, so that `--approximate --limit 50` can return up to 50 results. The constants live in `src/db/search-session.ts`:

```
APPROXIMATE_HNSW_EF_SEARCH = 100            integer; MAX_RESULT_LIMIT (50) <= value <= 1000 (pgvector's maximum)
searchSessionOptions(mode):
  'approximate' -> `-c hnsw.ef_search=${APPROXIMATE_HNSW_EF_SEARCH}`     only the constant is interpolated, never input
  'exact'       -> undefined                                             Exact connections get no options at all
createDb(cs, poolMax, sessionOptions?):
  connection = { connectionString, connectionTimeoutMillis, statement_timeout, types,
                 ...(sessionOptions !== undefined ? { options: sessionOptions } : {}) }   (exactOptionalPropertyTypes)
```

**Mechanism: a connection startup parameter on the per-call pool.** pg sends `options` in the startup packet, as libpq does. The server applies `-c name=value` to the session before the first statement, and to every connection the pool opens, including a reconnect. The search itself still sends exactly one statement (the 1.4.4 `SELECT`). No `SET`, `SET LOCAL`, `set_config`, `BEGIN` or `COMMIT` is ever sent, so the AL7 rule and the "One statement per search" decision hold. This is not SQL: it is a constant connection parameter, so `.agrules` section 3 (parameterized SQL only) is unaffected.

**Why the value is in effect when the index scan runs.** `hnsw.ef_search` is a custom variable of the `vector` extension. If `vector.so` is not loaded yet when the session starts, PostgreSQL keeps `hnsw.ef_search=100` as a placeholder. The search statement loads the library before the index scan starts, because the `vector` input function for the bound literal and the HNSW access-method handler both live in `vector.so`. The library's `_PG_init` defines the variable and adopts the placeholder value (100 is within pgvector's range 1 .. 1000). If `vector` is preloaded, the value is applied directly. This is the same path `ALTER ROLE ... SET hnsw.ef_search` takes. U3 checks this in two ways on real connections. First, `current_setting` reads 100 on the Approximate handle and 40 on the Exact handle. Second, a forced HNSW scan over the HNSW cloud (1.4.11) returns 50 rows on the Approximate handle and 40 on the Exact handle. The second check is the behavioural proof that the setting reaches the index scan.

**Exact mode is unaffected.** The Exact pool is created without `options`, so the setting is not even present on that connection. The Exact plan never uses the HNSW index anyway (1.4.4, U3 plan test), so `ef_search` could not change its result.

**Alternatives rejected:**
- `SET` / `SET LOCAL hnsw.ef_search` before the search: these are a second statement (`SET LOCAL` also needs `BEGIN` / `COMMIT`), which breaks the AL7 one-statement rule.
- `set_config('hnsw.ef_search', '100', true)` inside the search statement: one statement, but PostgreSQL does not guarantee that the call is evaluated before the HNSW scan reads the variable at scan start, and it puts a side effect into a read-only query. Not reliable.
- `ALTER DATABASE` / `ALTER ROLE ... SET`: this changes every client of the database, Exact searches and other tools included, and it would need a Schema Setup step, which AC-39 and the contract header rule out.
- The same option on every search pool, Exact included: harmless to Exact's results, but it is not needed, and the requirement is that Exact stays as it is.
- `hnsw.iterative_scan`: not part of the decision; it stays `off`.

**Limitations (documented, not handled):**
- pg merges the parameters parsed from the connection string over the explicit config. A `DATABASE_URL` that carries its own `?options=...` replaces the startup option. The project's URLs (`.env.example`, `.env.test`) carry none. If one did, Approximate would fall back to 40 candidates: still correct under AC-65 .. AC-67, just shorter.
- A transaction-pooling proxy (for example PgBouncer in transaction mode) would drop startup options. The project connects directly to Postgres. The Stage 3 long-lived pool must restate this decision.
- Cost: an `ef_search` of 100 means about 2.5 times more graph distance computations per Approximate search than 40. That is negligible at Belgrade scale and still far below Exact mode's full pass.

#### 1.4.10 Test-only planner settings for plan guards (U3)

On small test data the planner prefers cheap non-HNSW plans for the Approximate statement. A probe on the Test Database (Search Set plus 1,000 `manyPlaces`, analyzed) showed this: with only `enable_seqscan = off`, it picks a `place_embeddings_pkey` index scan, a Hash Join and a Sort (cost about 171) over the HNSW index scan (about 3,270). A correct implementation would therefore fail an "Approximate uses HNSW" test. The inner `ORDER BY e.embedding <=> $V LIMIT n` is the only place where an index can stand in for a sort. Disabling sorts as well makes every non-index alternative carry an extra disable cost, so the HNSW index scan wins. The probe confirmed this.

**`PLAN_FORCE_INDEX`**, the only planner settings any test may use, as exactly these two statements and in this order:

```
SET LOCAL enable_seqscan = off
SET LOCAL enable_sort = off
```

Rules:
- They are sent only inside a test-owned transaction (`handle.transaction(async (trx) => { ... })`) on a test-owned handle. Because they are `SET LOCAL`, they end with that transaction and never reach a product pool or a later test. They are never part of a product statement, and `src/` never sends them.
- No other planner or pgvector setting is allowed: no other `enable_*`, no `random_page_cost`, no `hnsw.*`, and no `set_config`.
- The Approximate statement keeps its outer `order by a.similarity desc, a.place_id asc`, so its plan still holds one Sort node under `enable_sort = off`. That is expected: the setting only penalises sorts, it does not forbid them. The assertion is about the index, not about the absence of a Sort.
- The **Exact** plan is checked under both the default settings and `PLAN_FORCE_INDEX`. `PLAN_FORCE_INDEX` favours an index-ordered path as much as possible, so "no HNSW node in Exact even under `PLAN_FORCE_INDEX`" is the stronger guard of AC-10 (1.4.4).
- If a correct Approximate statement still gets no HNSW plan under `PLAN_FORCE_INDEX` on the U3 data, the test writer reports it to AL4 and does not add more settings.

#### 1.4.11 HNSW cloud: test data that proves D-EF (`tests/db/hnsw-cloud.ts`, U3)

**Why the contract data cannot prove it.** `embeddingWithSimilarity` puts every Place on its own orthogonal axis next to the shared axis 0. Two such Places have cosine distance `1 - s1*s2` whatever their axes, so the points are nearly equidistant and have no local structure. pgvector's neighbour-selection heuristic then prunes the layer-0 graph into small pieces. The probe confirmed this: a forced HNSW scan from the entry point reaches only 37 tuples, whether `ef_search` is 100 or 1000, and 10 at `ef_search` 10. So on `seedPlaces` / `manyPlaces` data, "50 rows under a forced HNSW plan" cannot happen, and a 40-versus-100 comparison cannot tell the settings apart. The store-level "exactly 50" test does not help either. On that data the planner does not choose HNSW (see 1.4.10), so its count of 50 does not depend on `ef_search`. It stays as a limit and correctness check of Approximate mode, **not** as evidence for D-EF.

**Why a connected cloud gives a clean proof.** Without iterative scan, pgvector's layer-0 search keeps a result set W of at most `ef_search` tuples. As long as W is not full, every neighbour it visits is added to W and to the candidate queue. So the search stops early only when the candidate queue runs empty, which means the reachable part of the graph is used up. The HNSW scan therefore returns `min(ef_search, reachable)` tuples, and the inner `LIMIT 50` takes the first 50. On a graph where at least 100 tuples are reachable from the entry point, the result is exactly 50 at `ef_search` 100 and exactly 40 at the default of 40, because 40 is a hard cap. Same graph, same statement, same plan: the only difference is the setting. Low-dimensional, unstructured-but-local data gives pgvector (`m = 16`, `ef_construction = 64`, built by insertion) a well-connected, navigable graph.

**Helper module `tests/db/hnsw-cloud.ts`** (test-local, not a `*.test.ts`, never in `contracts/`; type-checked and linted like any other file under `tests/`):

```ts
export const HNSW_CLOUD = {
  seed: 20261029,          // PRNG seed (uint32)
  count: 1000,             // Places in the cloud
  firstId: 50001,          // Place IDs 50001 .. 51000
  subspaceAxes: 16,        // vector axes 1 .. 16 are used besides axis 0; axes 17 .. 1023 are 0
  centre: { lat: 44.9, lon: 20.4 },
} as const;
export interface HnswCloudPlace extends SyntheticSearchPlace {   // from contracts/hybrid-search.support
  similarity: number;      // true cosine similarity with queryEmbeddingQ(), from the float32-rounded vector
  embedding: number[];     // 1024 numbers, unit length, each already Math.fround-ed
}
export function hnswCloud(): HnswCloudPlace[];                                         // pure, deterministic
export async function seedHnswCloud(places: PlaceStore, embeddings: EmbeddingStore): Promise<HnswCloudPlace[]>;
```

Construction (`hnswCloud`), which is fully deterministic:

```
next = mulberry32(HNSW_CLOUD.seed):                  uint32 state, s = seed >>> 0
  s = (s + 0x6D2B79F5) >>> 0
  t = Math.imul(s ^ (s >>> 15), s | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296        uniform in [0, 1)
for i in 0 .. count-1:                                  draw order is fixed: place by place, axis 1 .. 16
  raw = new Array(1024).fill(0); raw[0] = 1
  for j in 1 .. subspaceAxes: raw[j] = 2 * next() - 1   uniform in [-1, 1)
  norm = sqrt(sum raw[k]^2)                              >= 1, never zero
  embedding = raw.map(x => Math.fround(x / norm))       float32-exact, as stored by pgvector
  similarity = cosineSimilarity(queryEmbeddingQ(), embedding)    (support oracle; about 0.30 .. 0.60)
  place = { placeId: firstId + i, name: `HNSW cloud place ${firstId + i}`, centre: HNSW_CLOUD.centre,
            similarity, embedding }                      no tags, no outline, Detailed, not deleted
```

Every vector has a positive axis-0 component of the same size before normalisation, so the cloud is clustered around Q's direction, and the spread lies in a 16-dimensional subspace. Neighbours therefore carry real local structure. The PRNG makes the vectors a function of the seed only, with no `Math.random`. No literal vectors appear anywhere.

`seedHnswCloud(places, embeddings)`: for each cloud Place, in order, `savePlace(places, place)` from the contract support (a Details Save: the Place becomes Detailed and Searchable, with no tags). Then `saveRecords(embeddings, records)`, where each record is `{ placeId, embedding, model: EMBEDDING_MODEL, documentFingerprint: documentFingerprint(`hnsw cloud ${placeId}`), embeddedAt: '2026-10-24T00:00:00Z' }`. Both helpers write through the real Place Store and Embedding Store. It returns the cloud. It never touches the HNSW index directly: no `REINDEX`, no DDL. The graph is built by insertion into the index that Schema Setup created.

**Self-checks** (in the cloud test file, run before the proof): `hnswCloud()` called twice gives deep-equal output; there are 1,000 distinct Place IDs; every embedding has 1024 entries and a norm within 1e-6 of 1; and all similarities are distinct.

**Pre-approved fallback parameters.** If, with the parameters above, the Approximate forced run returns fewer than 50 rows on the real Test Database, the test writer may switch once to `count: 2000, subspaceAxes: 8` (IDs 50001 .. 52000, same seed and construction). The switch is recorded in the helper's header comment. If that also fails, they stop and report the observed row counts at both handles to AL4. In that case D-EF would be proven only through `current_setting` (1.4.9), and AL4 would record that limitation. AL4 judges the primary parameters feasible: random data in 16 dimensions is easy for HNSW at `m = 16`, and 1,000 points is ten times the `ef_search` of 100.

### 1.5 Transaction boundaries

| Operation | Boundary | Isolation / locking | On failure |
|---|---|---|---|
| One search | one autocommit `SELECT` statement (no explicit transaction; one statement-level snapshot, so filters, ranking, tags and content come from one consistent view) | READ COMMITTED statement snapshot; plain `SELECT`, takes only `AccessShareLock`; no data-modifying CTE | `store_unavailable`; nothing to roll back |
| Query embedding | no database involvement; no transaction or connection is open while the Embedding Request is in flight | n/a | `query_embedding_failed`; store never opened |

Read-only by construction (AC-39, rule 7): the feature contains no `insert`, `update`, `delete`, `truncate`, DDL or `SET` statement. AC-39 is verified by the contract's snapshot test in both modes and for failures. The Approximate `hnsw.ef_search` value (D-EF) is a session parameter set in the connection startup packet. It is not a statement, it is outside any transaction, and it dies with the per-call connection, so it never leaks to another search or client.

## 2. Data Model Design (Declarative)

**No schema change.** There is no migration, no new column, no new index and no Schema Setup step (the contract header and AC-39). The feature reads:

| Table | Columns read | Index used |
|---|---|---|
| `places` | `place_id`, `name`, `wikimapia_url`, `location_lat`, `location_lon`, `centre_point` (geometry Point 4326), `outline_shape` (geometry Polygon 4326, nullable), `details_fetched_at`, `is_deleted` | `places_pkey`; `places_centre_point_gist`, `places_outline_shape_gist` (Area Filter) |
| `place_embeddings` | `place_id`, `embedding vector(1024)`, `embedding_model` | `place_embeddings_pkey`; `place_embeddings_embedding_hnsw_idx` (`hnsw`, `vector_cosine_ops`; Approximate mode only) |
| `place_tags` | `place_id`, `tag_id`, `presence`, `position` | `place_tags_pkey (place_id, tag_id)` (per-Place lookups), `place_tags_tag_id_place_id_idx` |
| `tags` | `tag_id`, `title` | `tags_pkey` |

Relations used: `place_embeddings.place_id` -> `places` (1:0..1), and `place_tags` -> `places` / `tags`. The Wikimapia Link comes from `places.wikimapia_url` as stored, whether Listing Link or Built Link (Q1, AC-38). It always satisfies `isWikimapiaPlaceUrl`, which the result gate checks.

**Indexing notes (not part of this feature):**
- The Radius test casts `centre_point` to geography, so `places_centre_point_gist` (geometry) does not assist it. Every Searchable Place gets one spheroid distance computation, which is cheap at Belgrade scale. A later Schema Setup step may add `CREATE INDEX ... USING gist ((centre_point::geography))` to make `ST_DWithin` index-assisted, with no query change.
- The Tag fold is computed per catalogue row and is not indexed. The Tag Catalogue is small (69 distinct titles in the crawled sample). An expression index is possible later if needed.
- HNSW build parameters stay at the pgvector defaults set by Schema Setup step 7 (`m = 16`, `ef_construction = 64`); the index is not rebuilt. The query-time `hnsw.ef_search` is 100 on Approximate search connections only (D-EF, 1.4.9). It is not a database or role setting, and every other connection keeps the default of 40.

## 3. Batch & External Calls

There is no batch job. Search makes **one** external call per valid search: the Query Embedding. It never calls Wikimapia or Anthropic and never embeds stored content (`.agrules` section 1).

| External call | Unit of work | Limits / pacing | Timeout | Retry / back-off | Failure mapping |
|---|---|---|---|---|---|
| Voyage `POST /v1/embeddings` via `VoyageAIClient.embed` (`model: voyage-4`, `inputType: query`, `outputDimension: 1024`, `input: [trimmed Query Text]`) | one text of 1 .. 1,000 characters | one request per search; no client-side pacing (interactive, sequential) | 30 s (`timeoutInSeconds`); a timeout is a Connection Failure | **none**: SDK `maxRetries: 0`, and the search does not retry (Q10, AC-57: asked exactly once) | thrown error -> `classifyEmbeddingServiceError` (`connection` / `rate_limit` / `refused`); answer failing `findEmbeddingAnswerIssues(answer, 1)` (wrong count, 1023/1025 numbers, non-finite, unreadable, model not `voyage-4`) or all zeros -> `invalid_answer` |

Idempotency: a search changes nothing, so reruns are trivially idempotent. Cost: one query of at most 1,000 characters, about 300 tokens at most, which is negligible next to Voyage's free tier. Licensing: results are Wikimapia-derived (CC BY-NC-SA 3.0), at most 50 per answer, each with its Wikimapia Link. The command prints `ATTRIBUTION_LINE` on every list outcome.

## 4. Implementation Units

The units are ordered by dependency, and each fits one AL3 -> AL2 iteration. `contracts/hybrid-search.test.ts` imports both entry points, so it can run only once U5 exists. The ACs listed for U1 .. U4 are the ones each unit implements, and U5 verifies them end to end through the contract file. `contracts/hybrid-search.schema.test.ts`, every other `contracts/*.test.ts` and all existing `tests/` must stay green in every unit.

**Baseline caveat:** until U4 and U5, `pnpm exec tsc --noEmit` and `pnpm lint` report only the unresolved-import errors of `contracts/hybrid-search.test.ts` for `src/search/search-places` (gone after U4) and `src/search/command` (gone after U5). "No new errors" below means only those. **DB precondition** for every unit with a database test: `pnpm db:up` has been run and `.env.test` exists.

### U1. Query embedding: Voyage query adapter and the embedding step

- **Scope:** the shared private Voyage helper and `createVoyageQueryEmbeddingService`; `buildQueryEmbeddingRequest` and `embedQueryText`; the Search Failure builders.
- **Files:** `src/embed/types.ts`, `src/embed/voyage-service.ts`, `src/search/types.ts` (created), `src/search/failures.ts`, `src/search/query-embedding.ts`, `tests/embed/voyage-service.test.ts` (new cases), `tests/search/query-embedding.test.ts`, `tests/search/failures.test.ts`
- **Depends on:** none
- **Design refs:** 1.3, 1.4.1, 1.4.2, section 3
- **Implements ACs:** AC-2 and AC-3 (request side), AC-57, AC-58, AC-60 (embedding and missing-key messages), AC-61 (no SDK load when a service is injected)
- **Contract tests it should turn green:** none directly (the contract file needs U5). `contracts/hybrid-search.schema.test.ts` stays green.
- **Unit tests must cover:**
  - `query-embedding.test.ts` (`SimulatedQueryEmbeddingService` and error makers from `contracts/hybrid-search.support.ts`): the request parses with `QueryEmbeddingRequestSchema`, with `input` exactly `[text]`, `voyage-4`, `query`, 1024; a normal answer yields `queryEmbeddingQ()`; every AC-57 case gives `query_embedding_failed` of the stated kind after exactly 1 call; model `voyage-3.5` gives `invalid_answer`; an all-zero 1024 vector gives `invalid_answer`; a synchronously throwing service is caught; no message contains `TEST_VOYAGE_API_KEY`, `Bearer` or the error's own text.
  - `voyage-service.test.ts` (local `node:http` server on `127.0.0.1`, `baseUrl`, synthetic key): the query adapter sends a snake_case body with `input_type: "query"`, `output_dimension: 1024` and `model: voyage-4`; 429, 401 and 503 each make exactly one HTTP request (no SDK retry) and keep `statusCode`; a server slower than a 1 s test timeout throws without `statusCode`. The existing document-adapter cases stay green unchanged.
  - `failures.test.ts`: `missingKeyFailure()` parses with `SearchFailureSchema` and names `VOYAGE_API_KEY`; every builder output parses with `SearchFailureSchema`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/search tests/embed contracts/hybrid-search.schema.test.ts contracts/embeddings.schema.test.ts` passes
  - `pnpm exec eslint src/search src/embed tests/search tests/embed` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U2. Search repository: statement builder, Exact mode, filters, tag folding, search store

- **Scope:** `text-fold.ts`, `SearchRowSchema`, `validatePlaceSearchQuery`, `buildPlaceSearchStatement` (both modes' text may be stubbed for Approximate until U3, but the Exact text must be final), `selectMatchingPlaces`, and `createPlaceSearchStore` with `close()`.
- **Files:** `src/db/text-fold.ts`, `src/db/rows.ts`, `src/db/types.ts`, `src/db/validate.ts`, `src/db/place-search.ts`, `src/db/search-store.ts`, `tests/db/text-fold.test.ts`, `tests/db/tag-fold-parity.db.test.ts`, `tests/db/place-search.db.test.ts`, `tests/db/validate.test.ts` (new cases)
- **Depends on:** none (independent of U1)
- **Design refs:** 1.4.3, 1.4.4 (Exact), 1.4.5, 1.4.8, 1.5, section 2
- **Implements ACs (store side, Exact mode, called with `queryEmbeddingQ()`):** AC-1, AC-4 .. AC-13, AC-15 .. AC-38, AC-40 (SQL side), AC-59 (store side), AC-60 (store messages), AC-64
- **Contract tests it should turn green:** none directly (the contract file needs U5).
- **Unit tests must cover:**
  - `text-fold.test.ts` (pure): for **every** code point from U+0000 to U+10FFFF except surrogates, `String.fromCodePoint(cp).trim() === ''` exactly when the code point is in `JS_TRIM_CHARACTERS`; `JS_TRIM_CHARACTERS` has no duplicates.
  - `tag-fold-parity.db.test.ts` (Test Database, through the test's own Knex handle, `select array_agg(... FOLDED_TAG_TITLE_SQL ...) from unnest(?::text[]) as t(title)` in chunks of 5,000): for every BMP code point except surrogates, wrapped as `"　" + ch + " \t"`, SQL equals `normalizeTagTitle`. A contextual corpus also matches: `МУЗЕЈ`, `  Трг Републике `, `ĐINĐIĆ`, `ΟΔΟΣ`, `ΣΑΣ ΟΔΟΣ`, `İSTANBUL`, `STRAẞE`, `ᲐᲑᲒ`, `﻿Museum `, `Ꭰ`, mixed `Музеј Of ART`. The collation `und-x-icu` exists.
  - `place-search.db.test.ts` (seeded with `seedSearchSet` / `seedPlaces` / `manyPlaces`, store opened and closed per test): exact AC-1 order and scores (within 1e-6); AC-4 exclusions; AC-5; AC-6 (20 of 25); AC-7 (50 of 60); AC-9 ties by Place ID; AC-10 needle by radius, area and tag among 1,000 haystack Places (timeout 300 s), plus the true top 50 of `['hotel']`; AC-13 Distances; AC-16 boundary (a Radius equal to the reported Distance of 102 includes it and excludes 104); AC-17, AC-18, AC-19; AC-20 (Outline Shape ignored for the circle); AC-21 (no `distanceMetres` key without a Radius); AC-22 .. AC-26 incl. both edge cases; AC-27 .. AC-34; a Cyrillic catalogue Tag `Музеј` matched by `[' МУЗЕЈ ']` (filter title normalized in the test with `normalizeTagTitle`, as `searchPlaces` will do); 300 tag titles in one query work; AC-35 exact content; AC-36; AC-37; AC-38 (Listing Link from `box-belgrade-page1.json` and `getbyid-1381893.json`); AC-40 (`museum'; --` as a title gives an empty list; place counts unchanged); invalid query (limit 0, 1023-number vector, radius and area together) gives `invalid_data` without a DB call (unreachable URL still gives `invalid_data`); unreachable URL with a valid query gives `store_unavailable` without password or `postgres://`; `buildPlaceSearchStatement` placeholder count equals `bindings.length` for all 2 × 3 × 2 combinations of mode × spatial × tags; the SQL text contains none of the bound values (tag title, vector literal); 30 open/search/close cycles leave the test database's `pg_stat_activity` count at its baseline.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db` passes
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U3. Approximate mode: statement, `hnsw.ef_search` = 100 session setting, plan guards

- **Scope:**
  - the final Approximate text of `buildPlaceSearchStatement`, replacing U2's Approximate stub (Exact text unchanged);
  - decision D-EF: `APPROXIMATE_HNSW_EF_SEARCH` and `searchSessionOptions` in the new `src/db/search-session.ts`, the optional `sessionOptions` parameter of `createDb`, and `openSearchDb` plus the lazy, mode-specific pool in `search-store.ts` (1.4.8, 1.4.9);
  - plan tests that pin the Exact guarantee (no HNSW use) and the Approximate shape (HNSW usable).
- **Files:** `src/db/place-search.ts`, `src/db/search-session.ts` (new), `src/db/connection.ts` (optional third parameter only), `src/db/search-store.ts`, `tests/db/search-session.test.ts` (new, pure), `tests/db/place-search-approximate.db.test.ts`, `tests/db/place-search-plan.db.test.ts`, `tests/db/place-search-ef-search.db.test.ts` (new), `tests/db/hnsw-cloud.ts` (new, test-local helper, revision 3), `tests/db/place-search-hnsw-cloud.db.test.ts` (new, revision 3)
- **Depends on:** U2
- **Design refs:** 1.4.4 (Approximate, and "why this is exact"), 1.4.3, 1.4.8 (lazy pool), 1.4.9, 1.4.10 (planner settings), 1.4.11 (HNSW cloud), 1.5, decision D-EF
- **Implements ACs (store side):** AC-4, AC-14, AC-15, AC-23 (Approximate), AC-65 .. AC-69, AC-10 (guarded by plan); decision D-EF
- **Contract tests it should turn green:** none directly (the contract file needs U5).
- **Unit tests must cover:**
  - `search-session.test.ts` (pure): `APPROXIMATE_HNSW_EF_SEARCH` is 100, an integer, at least `MAX_RESULT_LIMIT` and at most 1000; `searchSessionOptions('approximate')` is exactly `-c hnsw.ef_search=100`; `searchSessionOptions('exact')` is `undefined`.
  - `place-search-approximate.db.test.ts`: for the four `MODE_REQUESTS` of the contract, every Approximate result is a Matching Place with the true similarity and content (oracle `isSearchable`, `liesInArea`, `wgs84DistanceMetres`, `tagTitlesMatch` from the support and schema files); Ranking Order and no repeats; at most N for limits 1, 2, 50; each Approximate result equals its Exact twin (AC-68; Distance within 0.001); empty circle, box and unknown Tag give `[]`; with 60 seeded Places and no filter, at most 50 results are returned and all are correct (the exact count of 50 is asserted in the ef_search test below, on a larger set).
  - `place-search-ef-search.db.test.ts` (Test Database; Search Set plus 1,000 `manyPlaces`, then `ANALYZE`):
    - **Setting in effect on the search connection:** on a handle from `openSearchDb(testUrl, 'approximate')` (the factory the store uses), `select current_setting('hnsw.ef_search', true) as value` returns `'100'`, and returns `'100'` again after a statement that casts a vector (library loaded). On a handle from `openSearchDb(testUrl, 'exact')`, after a vector cast the value is pgvector's default `'40'`, not `'100'`. Both handles are destroyed.
    - **Limit 50 through the store:** `createPlaceSearchStore` with an Approximate query, no Spatial or Tag Filter, `limit: 50` and `queryEmbeddingQ()` returns **exactly 50** results. They are in Ranking Order, without repeats, and every one is a Searchable Place with its true similarity. **This is not evidence for `ef_search`.** On this data the planner picks a non-HNSW plan (1.4.10), so the count does not depend on the setting. The test checks the limit and correctness of Approximate mode, and its name or comment must not claim more. The D-EF proof is the forced-plan test in `place-search-hnsw-cloud.db.test.ts`.
    - The revision-2 forced-plan test ("a forced HNSW plan returns 50 rows ... at most 40") is **removed from this file**. It cannot pass on `manyPlaces` data (1.4.11). It is replaced by the cloud test below.
    - **Exact unaffected:** an Exact unfiltered limit-50 search through the store returns the true top 50 (oracle ranking over all Searchable Places).
    - **Lifecycle:** 30 mixed Exact/Approximate open/search/close cycles leave `pg_stat_activity` at its baseline; a search after `close()` resolves `store_unavailable` and opens no connection; a store used for both modes closes both pools.
  - `place-search-hnsw-cloud.db.test.ts` (new; Test Database, **only** the HNSW cloud: `apply()`, `emptyStore()`, `seedHnswCloud(places, embeddings)` in `beforeAll` with a 300 s timeout, seeding stores closed, then `analyze places, place_embeddings, place_tags, tags`; `afterAll` re-applies Schema Setup as the other files do; read-only tests):
    - **Self-checks** of 1.4.11: determinism, 1,000 distinct IDs, 1024 entries, unit norm within 1e-6, distinct similarities.
    - **D-EF proof under a forced HNSW plan.** Query `{ queryEmbedding: queryEmbeddingQ(), mode: 'approximate', limit: MAX_RESULT_LIMIT }`, statement from `buildPlaceSearchStatement`. For each of two handles, `openSearchDb(testUrl, 'approximate')` and `openSearchDb(testUrl, 'exact')`, run one `handle.transaction(async (trx) => ...)` with these steps: send `PLAN_FORCE_INDEX` (1.4.10); run `EXPLAIN (FORMAT JSON)` of the statement with its bindings; read `current_setting('hnsw.ef_search', true)` (vector library loaded by then); run the statement with `trx.raw(sql, bindings)`, or `selectMatchingPlaces(trx, query)`. Expected results:
      - **Approximate handle:** the plan uses `place_embeddings_embedding_hnsw_idx`, the setting reads `'100'`, and the statement returns **exactly 50** rows. They are in Ranking Order, without repeats, every row is a cloud Place, and each similarity is within `SIMILARITY_TOLERANCE` of the cloud oracle.
      - **Exact handle (control, default `ef_search`):** the plan also uses `place_embeddings_embedding_hnsw_idx` (the control is void otherwise, so this is asserted, not assumed), the setting reads `'40'`, and the statement returns **exactly 40** rows. Exactly 40, not just "at most", follows from 1.4.11: the same graph had at least 50 reachable tuples at 100, so at 40 the result set fills to its cap. The rows are in Ranking Order, without repeats, and all are cloud Places.
      - Together these show that the same statement, plan and graph give 50 versus 40, and the only difference is the connection's `ef_search`. Recall against the true top 50 is **not** asserted, because Approximate mode is allowed to miss.
    - Both handles are destroyed in `finally`. The test never sets `hnsw.ef_search` and never passes options to `createDb` itself.
  - `place-search-plan.db.test.ts` (Search Set plus 1,000 `manyPlaces`, `ANALYZE`; runs `EXPLAIN (FORMAT JSON)` of the built statement through the test's own Knex handle, `createDb(testUrl, 1)` with no options; planner settings exactly as in 1.4.10):
    - The **Approximate** plan without filters, inside a transaction with `PLAN_FORCE_INDEX`, uses `place_embeddings_embedding_hnsw_idx`. `enable_seqscan = off` alone is not enough (1.4.10), and a Sort node for the outer Ranking Order is allowed.
    - The **Exact** plan, with and without filters (unfiltered; radius; area; tags), contains no node using `place_embeddings_embedding_hnsw_idx` and contains a `CTE Scan` of `candidates`. This is checked twice: once with default settings (plain `EXPLAIN`, no transaction needed) and once inside a transaction with `PLAN_FORCE_INDEX`.
    - These planner settings are test-only and never part of the product statement.
  - The U2 tests in `tests/db/place-search.db.test.ts` stay green unchanged (Exact behaviour, store messages, `invalid_data` without DB access, the 30-cycle `pg_stat_activity` check), and so do all existing `createDb` callers.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db` passes
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors
  - `place-search-hnsw-cloud.db.test.ts` passes with the **exact** counts 50 (Approximate handle) and 40 (Exact handle) under an asserted HNSW plan. Weakening those assertions is not "done". If they cannot pass, apply the 1.4.11 fallback rule.
  - A search (Grep tool) of `src/` finds `hnsw.ef_search` only in `src/db/search-session.ts`, and finds no `SET`, `SET LOCAL` or `set_config` in any SQL text under `src/db/`.
  - A search of `tests/db/` (code, not comments) shows:
    - `SET LOCAL` occurs only as `SET LOCAL enable_seqscan = off` and `SET LOCAL enable_sort = off` (`PLAN_FORCE_INDEX`, 1.4.10), only in `place-search-plan.db.test.ts` and `place-search-hnsw-cloud.db.test.ts`, and only inside a `transaction(...)` callback.
    - There is no other `SET`, no `set_config`, and no `ALTER ... SET`.
    - `hnsw.ef_search` occurs only (a) in `current_setting('hnsw.ef_search', true)` reads, and (b) in `tests/db/search-session.test.ts` as the expected value `'-c hnsw.ef_search=100'` of `searchSessionOptions('approximate')`. That file is pure: it opens no connection and sends nothing.
    - No test passes a third argument to `createDb`. Search connections in tests come only from `openSearchDb` or the store, and no test connection string carries `options`.

### U4. Place Search: `searchPlaces`

- **Scope:** the orchestration of 1.2: validation, key, adapter selection, one embedding, store lifecycle with close-before-resolve, outcome gate, internal-error fallback.
- **Files:** `src/search/search-places.ts`, `src/search/types.ts`, `tests/search/search-places.db.test.ts`
- **Depends on:** U1, U2, U3
- **Design refs:** 1.2, 1.4.2, 1.4.8, 1.5
- **Implements ACs:** AC-1 .. AC-40 and AC-63 .. AC-69 end to end through `searchPlaces`; AC-46 .. AC-56, AC-70 (order of checks); AC-57 .. AC-60
- **Contract tests it should turn green:** none yet (the contract file still needs `src/search/command`). The `src/search/search-places` import error is gone.
- **Unit tests must cover** (Test Database, `SimulatedQueryEmbeddingService`; a focused subset, since the contract file is the full net): AC-1 and AC-13 through `searchPlaces` in both modes; a trimmed Cyrillic Query Text is sent trimmed and unchanged (AC-3); every section 3.7 case gives `invalid_request` naming the parameter, with 0 service calls and an unreachable URL never reached; missing or blank key gives `missing_key` with 0 calls, also with an injected service; each embedding failure kind gives 1 call and no store (unreachable URL, outcome not `store_unavailable`); unreachable URL after a good embedding gives `store_unavailable` within 60 s without secrets; `[' Museum ']` and `['MUSEUM']` give AC-27's results; every outcome parses with `SearchOutcomeSchema` and list outcomes pass `findResultListIssues`; 30 sequential searches (success, store failure, embedding failure mixed) leave `pg_stat_activity` at its baseline once each promise has resolved (no `afterEach` grace period); a store whose statement throws an unexpected error still resolves (never rejects).
- **Done when:**
  - `pnpm exec vitest run --no-color tests/search tests/db contracts/hybrid-search.schema.test.ts` passes
  - `pnpm exec eslint src/search tests/search` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (only the `src/search/command` import error remains)

### U5. Search Command, script, package scripts and contract green

- **Scope:** argument parsing, output lines, exit codes, `runSearchCommand`, `scripts/search.ts`, `package.json`; full contract verification. **Revision 4 delta** (the only work for this iteration if U5 is already in place to revision 3): the usage line of 1.4.6 built from `SEARCH_COMMAND_FORM` so that it passes `isSearchUsageLine`, the `scripts/search.ts` doc comment, the two unit tests that pin the old text, and the green run of the new contract file `contracts/hybrid-search.command.test.ts` (AC-72).
- **Files:** `src/search/args.ts` (`usageLine()` and its doc comment; revision 4), `src/search/output.ts`, `src/search/command.ts`, `src/search/types.ts`, `scripts/search.ts` (header doc comment shows `pnpm run search "<Query Text>" [options]`; revision 4), `package.json` (`search`, extended `test:db`; **unchanged in revision 4**), `tests/search/args.test.ts` (revision 4: new usage-line assertions), `tests/search/output.test.ts`, `tests/search/command.db.test.ts` (revision 4: `isSearchUsageLine` assertion). Revision 4 touches no file outside these and never `contracts/`.
- **Depends on:** U4
- **Design refs:** 1.4.6 (usage line), 1.4.7 (script, `package.json`, AC-72 test placement), 0.1 (command form)
- **Implements ACs:** AC-41 .. AC-45, AC-71, **AC-72** (rule 13, decision Q11); all ACs end to end
- **Contract tests it should turn green:**
  - all of `contracts/hybrid-search.test.ts` (AC-1 .. AC-71; the AC-44 case now asserts `output.some(isSearchUsageLine)`);
  - all of `contracts/hybrid-search.command.test.ts` (AC-72: `pnpm run search --fast` and `pnpm run search -- --fast` each exit non-zero with a line that passes `isSearchUsageLine`, print nothing from the npm registry and call no `fetch`);
  - `contracts/hybrid-search.schema.test.ts` stays green.
- **Unit tests must cover:**
  - `args.test.ts` (pure): AC-41 forms incl. `--bbox` order, repeated `--tag` order, `--limit 3`; a leading `--` dropped; negative coordinates (`--near -33.86,151.2`); `--near " 44.817 , 20.457 "` accepted; every AC-44 case is a problem (no Query Text, `--fast`, `--approximate=yes`, `--radius` alone, `--near` alone, `--near` + `--bbox`, `--limit ten`, `--near abc,20.457`, `--near 1,2,3`, `--bbox 1,2,3`, `--limit Infinity`, `--radius 1e999`, `--limit` twice, a missing value, two positionals); `--approximate` twice gives `mode: 'approximate'`; `--radius 0` and `--limit 2.5` are **not** problems; every draft parses with `SearchRequestDraftSchema`. **Usage line (revision 4, replaces the old pin of `"<query text>"`):** `isSearchUsageLine(usageLine())` is true; `usageLine()` starts with `SEARCH_USAGE_PREFIX` and with `` `Usage: ${SEARCH_COMMAND_FORM}` ``; it equals the 1.4.6 text, with the expected value built in the test from `SEARCH_COMMAND_FORM` and `SEARCH_COMMAND_OPTIONS` (no hand-written `pnpm run search`); it does not contain `pnpm search ` and contains no `\n`, `\r` or trailing whitespace; `parseSearchArgs(['--', '--fast'])` and `parseSearchArgs(['--fast'])` are problems (the two AC-72 argv shapes).
  - `output.test.ts` (pure): the exact AC-42 layouts for a list and an empty list in both modes; `failureLine` for each kind contains its `SEARCH_FAILURE_LABELS` text; `invalid_request` for `radiusMetres` contains `--radius`, for `spatialFilter` contains `--near / --bbox`, and for an unknown parameter contains the parameter itself. Unchanged in revision 4.
  - `command.db.test.ts` (Test Database, Simulated service): AC-41 and AC-71 requests; output layout; exit codes 0 for results and for empty, 1 for every failure kind and for usage errors (with `outcome` and `request` absent after a usage error); **after a usage error the second line passes `isSearchUsageLine` (revision 4; the existing `startsWith(SEARCH_USAGE_PREFIX)` check stays and now checks the new prefix)**, and the Simulated service got 0 calls; env without `VOYAGE_API_KEY` gives `missing_key`; env without `DATABASE_URL` gives `store_unavailable` without secrets; every result parses with `SearchCommandResultSchema`; a throwing `write` still resolves.
  - AC-72 itself is covered only by the contract file `contracts/hybrid-search.command.test.ts`. AL2 adds no second spawn test under `tests/`.
- **Test runs (revision 4):** `contracts/hybrid-search.command.test.ts` needs no database and is **not** part of `test:db`. The default Vitest run includes it through `contracts/**/*.test.ts`. `contracts/hybrid-search.test.ts` and `tests/search` stay in `test:db` as before (1.4.7).
- **Done when:**
  - `pnpm exec vitest run --no-color contracts/hybrid-search.test.ts contracts/hybrid-search.schema.test.ts contracts/hybrid-search.command.test.ts` passes
  - `pnpm exec vitest run --no-color tests/search` passes
  - `pnpm exec vitest run --no-color` (whole suite: `contracts/` and `tests/`, incl. the AC-72 file) passes
  - Manual checks, all in the documented form: `pnpm run search --fast` and `pnpm run search -- --fast` each print a line starting with `Usage: pnpm run search "<Query Text>" [options]` and exit non-zero without network access; `pnpm run search "museum" --near 44.817,20.457` exits non-zero with a usage message; `pnpm run search "museum"` with `VOYAGE_API_KEY` unset in the shell and in `.env` prints `Search failed: Missing key: ...VOYAGE_API_KEY...` and exits non-zero. AL2 verification makes no live Voyage call and never runs `pnpm search ...` (npm registry search, network).
  - A search (Grep tool) of `src/`, `scripts/` and `package.json` finds no `pnpm search` (rule 13); under `tests/` it occurs at most in a negative assertion. `src/search/args.ts` has no `pnpm run search` string literal in code; comments may name the form. The form in code comes from `SEARCH_COMMAND_FORM`.
  - `pnpm exec tsc --noEmit` reports **0 errors**
  - `pnpm lint` reports **0 problems**

## 5. AL2 Guidance (pitfalls)

- **Exact means no index ordering.** Keep `as materialized` on `candidates`, and keep the Exact ranking on the computed `similarity` column. Never write `order by e.embedding <=> ...` in Exact mode, and never add a `LIMIT` inside `candidates`. The U3 plan test fails if you do.
- **Approximate means the index form only.** The inner `ORDER BY` is the bare `e.embedding <=> ?::vector` (a parameter, ascending, the only key) with `LIMIT`. Tie-breaking and the similarity ordering happen in the outer query. A vector that comes from a CTE or a join cannot use the index.
- **`hnsw.ef_search` only as a connection option (D-EF).** It is set solely through `searchSessionOptions('approximate')` -> `createDb(..., sessionOptions)` -> pg `options`. Never send `SET`, `SET LOCAL` or `set_config`, never put it in the SQL text, never give the Exact pool any `options`, and never hard-code `100` outside `APPROXIMATE_HNSW_EF_SEARCH`. Do not add `hnsw.iterative_scan`. Tests never set it either. They only read it with `current_setting`, and they get their search connections from `openSearchDb`.
- **Plan-guard tests use exactly `PLAN_FORCE_INDEX`** (`SET LOCAL enable_seqscan = off`, then `SET LOCAL enable_sort = off`, inside a test transaction; 1.4.10). If the Approximate plan shows no HNSW under it, look at the statement first: the bare `e.embedding <=> ?::vector` as the only inner sort key, and a parameter rather than a CTE value. Do not reach for more planner settings.
- **The D-EF proof needs the HNSW cloud** (`tests/db/hnsw-cloud.ts`, 1.4.11), not `manyPlaces`. The contract's orthogonal vectors make a fragmented HNSW graph (37 reachable tuples), and an unforced store search on them does not use HNSW at all. A store-level "50 results" therefore says nothing about `ef_search`. Do not loosen the cloud test's exact 50 / 40 counts. Use the pre-approved fallback parameters once, then report to AL4.
- **`ST_MakePoint(lon, lat)` and `ST_MakeEnvelope(west, south, east, north, 4326)`**: x first. The contract's `LatLon` is latitude first.
- **Area uses geometry, Radius uses geography.** Do not cast the Area envelope to geography, and do not measure the Radius on geometry (degrees).
- **The Radius test is on the reported value.** In Exact mode, filter `distance_metres <= ?` in `top_n` on the CTE column. In Approximate mode, use the identical `ST_Distance(...)` expression. `ST_DWithin(..., radius + 1)` is only the coarse filter.
- **Tag folding happens only in `FOLDED_TAG_TITLE_SQL`.** Never write `lower(title)` or `btrim(title)` without the bound character set and the `und-x-icu` collation. Filter titles are normalized in TS with the contract's `normalizeTagTitle`, never in SQL.
- **One array binding for tags**, `?::text[]` with a fresh `string[]` (Knex binding types reject `readonly` arrays: spread them). Never one placeholder per title.
- **Explicit casts on every binding** (`::float8`, `::int`, `::text`, `::text[]`, `::vector`). Placeholder count must equal binding count. The SQL text may contain no stray `?`.
- **Close before resolve.** `await store.close()` in `finally` inside `searchPlaces`. Do not fire-and-forget the destroy. Create the store only after a successful embedding.
- **Never copy error messages** from the Embedding Service, the SDK, Knex or pg into a failure or output line. The simulated errors carry `Bearer <key>`, and the unreachable URL carries a password (AC-60).
- **Lazy SDK import.** Build the Voyage query adapter only when no service is injected and the key is present (the contract test stubs `fetch` and fails on any call).
- **`exactOptionalPropertyTypes`:** build `SearchDependencies`, the draft, `PlaceSearchQuery` and `distanceMetres` with conditional spreads, and never assign `undefined`. A result without a Radius Filter must not have a `distanceMetres` key at all (AC-21 uses `not.toHaveProperty`).
- **`noUncheckedIndexedAccess`:** `data[0]`, `rows[0]` and argv lookups are possibly `undefined`, so check them.
- **Imports:** `import type { Knex } from 'knex'`; relative imports are extensionless. Check `pnpm run search` under `tsx`, because Vitest interop hides ESM import problems.
- **Command form (rule 13):** always `pnpm run search ...`, in the usage line, comments, doc comments and manual checks. `pnpm search ...` is pnpm's npm registry search: never use it to verify anything (it would also make a network call).
- **`unknown`:** only for caught errors, the raw Embedding Service answer, the raw `db.raw` result (parsed on the next line) and `validatePlaceSearchQuery`'s parameter.
- **Output:** use `process.stdout.write` in the script only (ESLint `no-console`). The command prints through `io.write`.
- **Tests:** seed only through `contracts/hybrid-search.support.ts` helpers, the U3 cloud helper `tests/db/hnsw-cloud.ts` (which itself uses the support's `savePlace` / `saveRecords`), or the real stores. Never paste vectors as literals, and never call Voyage, Anthropic or Wikimapia. The voyage-service tests talk only to their own `127.0.0.1` server with the synthetic key.
- Do not edit `contracts/` or its fixtures. If a contract looks wrong, stop and report it (`.agrules` section 0).
