# AL3 Routing: hybrid-search, U1 "Query embedding: Voyage query adapter and the embedding step"

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **Unit:** U1 of 5 (attempt 1)
- **AL4 source:** `docs/al4-design/20261027-hybrid-search-al4.md`, section "4. Implementation Units", "U1".
- **AL6 source (background only):** `docs/al6-requirements/20261027-hybrid-search-al6.md` (revision 2, approved 2026-10-29).
- **AL5 sources:** `contracts/hybrid-search.schema.ts`, `contracts/hybrid-search.support.ts`, `contracts/hybrid-search.test.ts` (read only, not run in this unit), `contracts/hybrid-search.schema.test.ts` (run, must stay green).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `src/search/` and `tests/search/` do not exist yet. This unit creates both.
- `src/embed/` holds the finished `embeddings` feature. `src/embed/voyage-service.ts` exports `normaliseVoyageAnswer` and `createVoyageEmbeddingService` (document adapter, lazy `import('voyageai')`, `maxRetries: 0`, default timeout 120 s, a 2xx `statusCode` error resolves `undefined`, every other error is rethrown unchanged). `VoyageServiceOptions` (`apiKey`, `baseUrl?`, `timeoutSeconds?`) is in `src/embed/types.ts`.
- `tests/embed/voyage-service.test.ts` **mocks `voyageai` for the whole file** (`vi.mock`). `tests/embed/voyage-wire.test.ts` uses the **real** SDK against a local `node:http` server on `127.0.0.1`. See the placement note in section 2.1.
- **Expected baseline (AL4 section 4, "Baseline caveat"):** `pnpm exec tsc --noEmit` and `pnpm lint` report only the two unresolved imports of `contracts/hybrid-search.test.ts` (`src/search/search-places`, `src/search/command`). They stay until U4 and U5. **Do not create stubs** for those modules, and do not run `contracts/hybrid-search.test.ts` as a gate.
- No database is needed for this unit. `tests/embed` and the new `tests/search` files are pure or use a local HTTP server.

## 1. Context Manifest

Read these files, and only these. Follow `.agrules` (especially sections 2, 4 and 5) and the stack in `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, `import type` for types, extensionless relative imports, `unknown` only where `.agrules` 5 allows it (caught errors, the raw Embedding Service answer), every type alias or interface in the `types.ts` next to its module, no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 2 (validated service answers, `voyage-4`, 1024 dims, `query` input type), 4 (no live calls, synthetic keys, no secrets) and 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions. "Decisions": rows "Embeddings" and "Voyage client". Do not edit it. |
| 3 | `docs/al4-design/20261027-hybrid-search-al4.md` | Read only: "0. Scope and Fixed Points" (rows "Helpers to reuse", "Env vars"; paragraphs "Order of checks", "Single source of truth", "Code style"); "0.1" row "Query-side Voyage adapter"; "1.1 Module map" (the "Embedding side" table, the `src/search/types.ts`, `failures.ts` and `query-embedding.ts` rows, and the "Unit tests" paragraph); "1.3 Component contracts" (the `src/embed/types.ts`, `src/embed/voyage-service.ts`, `QueryEmbeddingResult`, `QUERY_EMBEDDING_TIMEOUT_SECONDS`, `buildQueryEmbeddingRequest`, `embedQueryText`, `missingKeyFailure`, `embeddingFailure`, `storeFailure`, `INTERNAL_FAILURE` lines); "1.4.1"; "1.4.2"; "3. Batch & External Calls"; "4" intro, "Baseline caveat" and "U1"; "5. AL2 Guidance" bullets "Never copy error messages", "Lazy SDK import", "`exactOptionalPropertyTypes`", "`noUncheckedIndexedAccess`", "Imports", "`unknown`", "Tests", and the last bullet. |
| 4 | `docs/al6-requirements/20261027-hybrid-search-al6.md` | Background only: AC-2 and AC-3 (section 3.1), AC-56 .. AC-60 (section 3.8), AC-61 (section 3.9), rule 5 and rule 11 (section 4), decision Q10 (section 6). |
| 5 | `contracts/hybrid-search.schema.ts` | Lines ~275-317 ("Embedding Service seam (query side)": `QueryEmbeddingRequestSchema`, `QueryEmbeddingService`, `SearchDependencies`) and ~370-402 (`SearchFailureSchema`, `SearchFailure`). |
| 6 | `contracts/hybrid-search.support.ts` | Lines 1-122: re-exported `TEST_VOYAGE_API_KEY`, `connectionError`, `unavailableError`, `rateLimitError`, `refusedError`, `fakeVector`; `queryEmbeddingQ`, `queryAnswer`, `QueryServiceAnswer`, `SimulatedQueryEmbeddingService`. |
| 7 | `contracts/embeddings.schema.ts` | `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `QUERY_INPUT_TYPE` (~lines 150-160); `EmbeddingSchema` (~257); `EmbeddingServiceRequestSchema` (~323); `EmbeddingAnswerSchema`, `findEmbeddingAnswerIssues` (~346-396); `EmbeddingFailureKindSchema`, `classifyEmbeddingServiceError` (~398-428). |
| 8 | `contracts/embeddings.support.ts` | Only the error makers and `TEST_VOYAGE_API_KEY` (to see what `statusCode` and message each error carries, including `Bearer <key>`). |
| 9 | `contracts/storage.schema.ts` | Only `StoreFailureSchema` / `StoreFailure` (~lines 486-491), for the `storeFailure` parameter type. |
| 10 | `contracts/hybrid-search.test.ts` | Read only, around lines 1200-1320 (AC-56 .. AC-61). This is the end-to-end net your code must satisfy in U5. Do not run it. |
| 11 | `src/embed/voyage-service.ts` | File to change. |
| 12 | `src/embed/types.ts` | File to change (add `VoyageEmbedRequest`; `VoyageServiceOptions` already exists). |
| 13 | `src/embed/settings.ts` | `MISSING_KEY_MESSAGE` (used by `missingKeyFailure`). Do not change it. |
| 14 | `tests/embed/voyage-service.test.ts` | File to extend (mocked SDK). Existing cases stay unchanged and green. |
| 15 | `tests/embed/voyage-wire.test.ts` | File to extend (real SDK over a local server). It is the style reference for server setup, `baseUrl` and the synthetic key. Existing case stays unchanged and green. |

## 2. Execution Directives

### 2.1 add-test-writer

Write the tests first. They must fail (missing modules or exports) before add-coder starts. Use only the contract helpers for keys, errors, answers and vectors. Never write a 1024-number literal, and never use a real key or reach the network beyond `127.0.0.1`.

**Placement note (routing decision, not a design change):** AL4 U1 puts the local-HTTP-server cases in `tests/embed/voyage-service.test.ts`. That file mocks `voyageai` for the whole file, so a real-SDK server test cannot live there. Put the **mocked-SDK** query-adapter cases in `tests/embed/voyage-service.test.ts` and the **real-SDK, local-server** cases in `tests/embed/voyage-wire.test.ts`. Do not remove the existing `vi.mock`.

1. **`tests/search/query-embedding.test.ts`** (pure; `SimulatedQueryEmbeddingService`, `queryAnswer`, error makers). Pin down AL4 1.4.2:
   - `buildQueryEmbeddingRequest(text)` parses with `QueryEmbeddingRequestSchema`: `input` exactly `[text]`, model `voyage-4`, `inputType` `query`, `outputDimension` 1024, and no `truncation` key. A Cyrillic or diacritic text is passed through byte for byte (no trimming or folding here).
   - A normal answer gives `{ ok: true, embedding }` equal to `queryEmbeddingQ()`, after exactly 1 call, and the recorded request equals `buildQueryEmbeddingRequest(text)`.
   - Every AC-57 row (the 10 cases in the contract's "AC-57 Query Embedding Failure" table: `connectionError`, `unavailableError`, `rateLimitError`, `refusedError`, and the raw answers with 0 or 2 embeddings, 1023 or 1025 numbers, a non-finite value, and an unreadable string) gives `{ ok: false }` with `kind: 'query_embedding_failed'` and the stated `embeddingFailure`, after exactly 1 call.
   - The answer from `queryAnswer([queryEmbeddingQ()], 'voyage-3.5')` gives `invalid_answer` (AC-58).
   - An all-zero 1024 vector (built in code) gives `invalid_answer` with the message from AL4 1.4.2.
   - A service whose `embed` throws **synchronously** (a hand-written object implementing `QueryEmbeddingService`) resolves to a `connection` failure, or to the kind its `statusCode` maps to, and never rejects.
   - Messages: `connection`, `rate_limit` and `refused` use exactly the fixed texts of AL4 1.4.2. `refused` from `refusedError()` contains `HTTP <its statusCode>`, and a refused-class error without a numeric `statusCode` cannot occur (classification gives `connection`). No message contains `TEST_VOYAGE_API_KEY`, `Bearer` or the thrown error's own `message`.
   - Every failure parses with `SearchFailureSchema`.
   - `QUERY_EMBEDDING_TIMEOUT_SECONDS` is 30.
2. **`tests/search/failures.test.ts`** (pure):
   - `missingKeyFailure()` parses with `SearchFailureSchema`, has kind `missing_key`, and its message contains `VOYAGE_API_KEY`.
   - `embeddingFailure(kind, msg)` for each of the 4 `EmbeddingFailureKind` values parses with `SearchFailureSchema` and carries that kind and message.
   - `storeFailure` with a `StoreFailure` and with a bare `{ message }` gives kind `store_unavailable` with that message, and parses.
   - `INTERNAL_FAILURE` parses, is kind `store_unavailable`, with message `Place search failed: internal error`.
3. **`tests/embed/voyage-service.test.ts`** (new cases, mocked SDK). `createVoyageQueryEmbeddingService`:
   - constructs the client with the given `apiKey` (and `baseUrl` only when given);
   - calls the SDK `embed` with `input`, `model`, `inputType: 'query'`, `outputDimension` and no `truncation` key, plus `{ maxRetries: 0, timeoutInSeconds }`: 120 by default, and the given `timeoutSeconds` (e.g. 30) when set;
   - rethrows a non-2xx error unchanged (same object), and resolves `undefined` for a 2xx `statusCode` error;
   - normalises `usage.total_tokens` the same way as the document adapter.
   - The existing document-adapter cases stay unchanged.
4. **`tests/embed/voyage-wire.test.ts`** (new cases, real SDK, local `node:http` server on `127.0.0.1`, `baseUrl` `http://127.0.0.1:<port>/v1`, `TEST_VOYAGE_API_KEY`):
   - The query adapter sends a snake_case JSON body with `input_type: "query"`, `output_dimension: 1024`, `model: "voyage-4"` and `input` equal to the one text.
   - Server answers 429, 401 and 503 each lead to **exactly one** HTTP request (no SDK retry). The thrown error keeps a numeric `statusCode` equal to the status.
   - With `timeoutSeconds: 1` and a server that does not answer within that time, the call throws an error with no numeric `statusCode`. Close the server and destroy open sockets in cleanup so the test does not hang.

### 2.2 add-coder

Make the tests of 2.1 green, in this order. Import every contract schema, type and helper from `../../contracts/...`, and never copy or redefine them (AL4 "Single source of truth").

1. **`src/embed/types.ts`:** add `VoyageEmbedRequest` = `EmbeddingServiceRequest | QueryEmbeddingRequest` (AL4 1.3), using `import type` from the two contract files.
2. **`src/embed/voyage-service.ts`:** apply AL4 1.4.1.
   - Extract a private (non-exported) `openVoyageEmbed(options)` that holds the lazy `import('voyageai')`, the client construction and the per-call `{ maxRetries: 0, timeoutInSeconds }`, the `truncation` conditional spread, `normaliseVoyageAnswer`, and the 2xx-to-`undefined` / rethrow-unchanged catch.
   - `createVoyageEmbeddingService` keeps its exact behaviour and signature.
   - Add `createVoyageQueryEmbeddingService(options: VoyageServiceOptions): Promise<QueryEmbeddingService>`.
   - Keep the adapter free of logging, `process.env` reads and message building. Update the module doc comment to mention the query adapter.
3. **`src/search/types.ts`** (create): `QueryEmbeddingResult` only (AL4 1.3). `ParsedSearchArgs` belongs to U5, so do not add it now.
4. **`src/search/failures.ts`** (create): `missingKeyFailure` (message `MISSING_KEY_MESSAGE` from `src/embed/settings`), `embeddingFailure`, `storeFailure`, `INTERNAL_FAILURE`, all typed as the contract's `SearchFailure` (AL4 1.3; `storeFailure` per 1.2 step 6).
5. **`src/search/query-embedding.ts`** (create): `QUERY_EMBEDDING_TIMEOUT_SECONDS = 30`, `buildQueryEmbeddingRequest`, `embedQueryText`, exactly as in AL4 1.4.2.
   - One call and no retry. Synchronous throws are caught by calling through `Promise.resolve().then(...)`.
   - Classify with `classifyEmbeddingServiceError`. Validate with `findEmbeddingAnswerIssues(answer, 1)`, then `EmbeddingAnswerSchema` / `EmbeddingSchema`, and handle `data[0]` being `undefined`.
   - Apply the all-zero check.
   - Use the fixed messages of 1.4.2. Read the numeric `statusCode` for the `refused` text with a narrow type guard on the caught `unknown`.
   - Never use the error's own message.
   - This module must not import `voyageai` or `src/embed/voyage-service`. Choosing the adapter is U4's job in `searchPlaces`.
6. Run the "Done when" commands, and fix the code until they pass.

### 2.3 Done when

All of the following hold:

- `pnpm exec vitest run --no-color tests/search tests/embed contracts/hybrid-search.schema.test.ts contracts/embeddings.schema.test.ts` passes (the existing `tests/embed` cases included, unchanged).
- `pnpm exec eslint src/search src/embed tests/search tests/embed` reports no problems.
- `pnpm exec tsc --noEmit` reports no errors other than the two baseline unresolved imports of `contracts/hybrid-search.test.ts` (`src/search/search-places`, `src/search/command`).
- No contract test turns green directly in this unit (AL4 U1). `contracts/hybrid-search.schema.test.ts` stays green.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT modify anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`). Also leave `CLAUDE.md`, `.agrules`, `.env*` and `package.json` unchanged in this unit.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. If a contract or the AL4 spec looks wrong or contradictory, stop and report it to the orchestrator instead of working around it (`.agrules` section 0).
- No live Voyage, Anthropic or Wikimapia call, and no real key, in any test. Only `TEST_VOYAGE_API_KEY` and a `127.0.0.1` server are allowed.

## 4. Out of Scope

Do not implement these now. They belong to later units:

- **U2 / U3:** everything in `src/db/` (`text-fold.ts`, `SearchRowSchema`, `PlaceSearchQuery` and the other `src/db/types.ts` additions, `validatePlaceSearchQuery`, `place-search.ts`, `search-store.ts`), the search SQL in both modes, tag folding, plan tests, and every `tests/db/*` file (AL4 1.4.3, 1.4.4, 1.4.5, 1.4.8, section 2).
- **U4:** `src/search/search-places.ts` / `searchPlaces`: request validation, the key check, adapter selection, the store lifecycle and the outcome gate (AL4 1.2). Do not create a stub.
- **U5:** `src/search/args.ts`, `output.ts`, `command.ts`, the `ParsedSearchArgs` type, `scripts/search.ts`, and the `package.json` `search` and `test:db` scripts (AL4 1.4.6, 1.4.7). Do not create a stub for `command`.
- Recording the AL4 0.1 decisions in `CLAUDE.md`. That is the orchestrator's job.
