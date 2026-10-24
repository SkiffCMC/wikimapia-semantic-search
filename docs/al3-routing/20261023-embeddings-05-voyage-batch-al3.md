# AL3 Routing: embeddings, U5 "Voyage adapter and one Batch"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U5 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U5".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md` (stakeholder-approved). Open it only if an AC number below is unclear.
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 to U4 are done and verified:
  - `src/db/` has the Embedding Store (`src/db/embedding-store.ts`, `createEmbeddingStore`).
  - `src/embed/` holds exactly `types.ts`, `place-document.ts`, `batches.ts`, `settings.ts` and `report.ts`.
  - `src/embed/types.ts` declares `DueItem`, `Resolution`, `Tally` and `ReportInput`.
- `pnpm exec tsc --noEmit` shows exactly 2 errors: the unresolved modules `src/embed/command` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. After this unit exactly those 2 must remain.
- `contracts/embeddings.test.ts` cannot load until U7. Do not run it as a gate. Do not stub the missing modules.
- `voyageai` is **not** installed yet. This unit adds it.
- **The `voyageai` SDK's real API has not been checked.** That covers its export names, client and per-request options (base URL, `maxRetries`, timeout), error classes and their `statusCode`, the camelCase answer including `usage.totalTokens`, and ESM loading under `tsx` and Vitest. AL4 1.4.6 describes the API as *expected*, not verified. The adapter test against a local `127.0.0.1` server is what confirms it. Where the installed SDK differs from AL4 1.4.6, the SDK wins for option names. Where the difference changes behaviour, stop and report (section 2.2, step 7).

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:
- Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, pnpm.
- Top-level `import type` for types; extensionless relative imports.
- Every type alias or interface declared in `src/embed/` goes in `src/embed/types.ts`.
- `unknown` is allowed only for caught errors, the raw Embedding Service answer (`normaliseVoyageAnswer`'s parameter and result, the value `embed` resolves with), and the `statusCode` probe of a caught error.
- No `console`. Build optional properties (`message`, `baseUrl`) with conditional spreads; never assign `undefined`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Mainly section 2 (one model, 1024 dims, `document` input type, every service answer validated with Zod), section 4 (no live calls, synthetic keys only, no secrets in output) and section 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions ("Embeddings" decision). Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only these parts. **"0. Scope and Fixed Points":** the table, "Approved contract decisions" (1) to (3), "Single source of truth", "Code style". **"0.1":** the "Voyage client" and "Pacing" rows. **"1.1 Module map":** the `voyage-service.ts` and `send-batch.ts` rows and the "Unit tests" paragraph. **"1.3 Component contracts":** the `src/embed/types.ts` block (`Stop`, `StopOutcome`, `BatchResult`, `SendContext`, `VoyageServiceOptions`) and the `voyage-service.ts` and `send-batch.ts` signatures. **"1.4.2 Scan-and-send loop":** read only to see how the loop consumes `BatchResult` (which progress lines and `tally.failed` calls the *loop* makes); do not implement it. **"1.4.4 One Batch"** and **"1.4.6 Voyage adapter"** in full. **"1.4.7":** the "Progress lines" paragraph only. **"3. Batch & External Calls":** the table. **"4. Implementation Units":** the intro, "Baseline caveat" and "U5". **"5. AL2 Guidance":** all bullets. |
| 4 | `contracts/embeddings.schema.ts` | Lines ~150-172: constants (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `DOCUMENT_INPUT_TYPE`, `EMBEDDING_RETRY_WAITS_SECONDS`). Line ~115: `VOYAGE_API_KEY_ENV`. Lines ~257-297: `EmbeddingSchema`, `EmbeddingRecord`. Lines ~318-428: `EmbeddingServiceRequestSchema`, `EmbeddingService`, `EmbeddingAnswerSchema`, `findEmbeddingAnswerIssues`, `classifyEmbeddingServiceError`. Lines ~486-535: `EmbeddingClock`, `EmbeddingRunOutcome`. Lines ~555-556: `FailedPlaceKind`. Lines ~671-686: `EMBEDDING_OUTCOME_LABELS`, `FAILED_PLACE_LABELS`. Lines ~836-926: `SaveEmbeddingRecordsInput`, `SaveEmbeddingRecordsResultSchema`, `EmbeddingStore`, `EmbeddingStoreOptions`. Import these; never redefine them. |
| 5 | `contracts/embeddings.support.ts` | Lines ~1-260: `TEST_VOYAGE_API_KEY`, `fakeEmbedding`, `fakeVector`, `normalAnswer`, `SimulatedServiceError`, `rateLimitError`, `refusedError`, `unavailableError`, `connectionError`, `SimulatedEmbeddingService`, `EmbeddingCall`, `ServiceAnswer` helpers (`NORMAL`, `normal`, `raw`, `fail`, `byAttempt`), re-exported `SimulatedEmbeddingClock`, `RUN_START`, `SECOND`, `iso`. Lines ~317-420: `SyntheticSpec`, `syntheticDetails`, `syntheticName` (for seeding Places in the DB test). |
| 6 | `contracts/hydration.support.ts` | Lines ~40-95 only: `SimulatedCrawlClock` (`now`, `sleep`, `sleeps`, `advance`, the `onSleep` option, `nowMilliseconds`). |
| 7 | `contracts/hydration.schema.ts` | Lines ~139-150 (`toMoment`, `Moment`) and ~375-390 (`CrawlClock`). |
| 8 | `contracts/storage.support.ts` | `requireTestDatabaseUrl` (line ~50) and `at` re-exports. This is the only way to get a database URL in tests. |
| 9 | `src/embed/types.ts`, `src/embed/report.ts` | Existing types and `createTally` (the real tally is used in `send-batch.db.test.ts`). Extend `types.ts` only; do not change `report.ts`. |
| 10 | `src/db/embedding-store.ts` | Public `createEmbeddingStore` (read its exports and how a failure is shaped; do not change it). |
| 11 | `tests/db/embedding-store.db.test.ts` | Lines ~1-170 only, **pattern**: Schema Setup in `beforeAll`, `emptyStore()` in `beforeEach`, seeding Detailed Places with `createPlaceStore` + `syntheticDetails`, closing every store and setup. Mirror it; do not change this file. |
| 12 | `src/crawl/runtime.ts` | `createSystemCrawlClock`: how a real-clock `sleep` ends early on abort (read-only background for the abort checks). |
| 13 | `contracts/embeddings.test.ts` | Read only these blocks, to mirror their expectations in unit tests (do not import from this file or run it): "AC-18" (~671-692), "AC-26" (~838-881), "AC-34" to "AC-38" (~1000-1163), "AC-45" (~1402-1466), "AC-48" (~1538-1556), "AC-51" (~1641-1667). |
| 14 | `package.json` | Dependencies and scripts. Only `voyageai` is added in this unit. |

Do not read the migrations, `src/crawl/` (other than file 12), `src/wikimapia/`, `scripts/` or the other AL3 prompts.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's real API keys. Never put a real key anywhere. The only key in tests is `TEST_VOYAGE_API_KEY`.

## 2. Execution Directives

### 2.1 add-test-writer

Create two new test files. Import subjects from `../../src/embed/<module>`, types from `../../src/embed/types` and the contracts (with `import type` for types). Generate every vector in code (`fakeEmbedding`, `fakeVector`, `normalAnswer`); never paste numbers (contract AC-59 scans `tests/`). Tests are expected to fail until `add-coder` finishes. Do not stub production modules, `fetch` or the SDK.

**A. `tests/embed/voyage-service.test.ts`** (AL4 1.4.6; no database)

Setup: a local HTTP server.
- Start a `node:http` server on `127.0.0.1`, port 0, in `beforeAll`. Close it in `afterAll`, including open sockets (`closeAllConnections`).
- For every request it records the method, path, headers and parsed JSON body. A per-test handler chooses the status, the body and an optional delay.
- Build the adapter with `createVoyageEmbeddingService({ apiKey: TEST_VOYAGE_API_KEY, baseUrl: <server URL>, ... })`. Nothing may leave `127.0.0.1`.
- Bodies the server returns are REST snake_case: `{ object: 'list', data: [{ object: 'embedding', embedding, index }], model: 'voyage-4', usage: { total_tokens } }`, with vectors from `fakeEmbedding`.

Requests are built with `EmbeddingServiceRequest` values of 1 to 3 short synthetic texts.

1. **Request shape.**
   - Exactly 1 HTTP request: `POST`, path ending in `/embeddings`.
   - Header `authorization` equals `Bearer ${TEST_VOYAGE_API_KEY}`.
   - JSON body: `input` (the texts, in order), `model: 'voyage-4'`, `input_type: 'document'`, `output_dimension: 1024`, `truncation: true`.
   - The body has no camelCase `inputType` or `outputDimension` key.
2. **Answer shape.** A 200 REST answer comes back with `usage.totalTokens` equal to the server's `total_tokens`, `data[i].embedding` and `data[i].index`, and `model`. `findEmbeddingAnswerIssues(answer, n)` returns `[]`, and `EmbeddingAnswerSchema` parses it.
3. **Errors carry the status.**
   - For each of 401, 403, 400 (`refused`), 429 (`rate_limit`), 503 and 408 (`connection`), `embed` rejects.
   - `classifyEmbeddingServiceError(error)` returns the stated kind, and `error.statusCode` is that number.
   - The server received **exactly 1** request per case. After the rejection, wait a short real time (about 300 ms) and check the count is still 1, so a delayed SDK retry would be caught.
   - Give the 429 response a `retry-after: 0` header, so an SDK that still retries does so at once and the test sees it.
4. **No status for network failures.**
   - (a) A closed port: start a second server, note its port, close it, then point an adapter at it. `embed` rejects, the error has no numeric `statusCode`, and `classifyEmbeddingServiceError` returns `connection`.
   - (b) A server that answers after 3 s, with an adapter built with `timeoutSeconds: 1`: `embed` rejects in well under 3 s, with no numeric `statusCode` (`connection`). The server saw exactly 1 request.
5. **Unreadable 2xx.** A 200 with body `<html>Bad gateway</html>` and `content-type: text/html` must not reject with a status that classifies as `refused`. It either resolves to a value that `findEmbeddingAnswerIssues(value, 1)` rejects (non-empty), or (only if the SDK cannot be made to resolve) the test must state which. Primary expectation: resolves, and the issues are non-empty.
6. **Secrets.** For the 401 case and the closed-port case, the adapter adds no key of its own to the error. The SDK's own message may contain it; that is why `send-batch` never copies messages. Do **not** assert on SDK message text. Only check that the adapter wrote nothing to stdout or stderr: spy on `process.stdout.write` and `process.stderr.write` during the calls; neither was called with text containing the key.
7. **`normaliseVoyageAnswer` (pure).**
   - `{ usage: { total_tokens: 5 } , data: [] }` gains `usage.totalTokens: 5`.
   - An answer that already has `totalTokens` is returned unchanged (same values).
   - `null`, a string, `{}`, `{ usage: 3 }` and `{ usage: { total_tokens: 'x' } }` are returned unchanged.
   - The input object is not mutated.
8. **Lazy load.** Importing `../../src/embed/voyage-service` does not load `voyageai` before `createVoyageEmbeddingService` is called. Optional; skip it if it cannot be checked without mocking the module. Do not use `vi.mock('voyageai')`.

**B. `tests/embed/send-batch.db.test.ts`** (AL4 1.4.4; Test Database)

Setup:
- Use the `embedding-store.db.test.ts` pattern: `requireTestDatabaseUrl()`, `createSchemaSetup(...).apply()` in `beforeAll`, `emptyStore()` in `beforeEach`.
- Seed Detailed Places through `createPlaceStore` with `syntheticDetails(id)` (ids 301, 302, 303).
- Build one real `createEmbeddingStore({ connectionString: testUrl, ...(onWrite) })` per test and close it in `finally`/`afterEach`.
- The context is a `SendContext`:
  - a `SimulatedEmbeddingService(clock, responder)`;
  - a `SimulatedEmbeddingClock` (start `RUN_START`);
  - the real `createTally()`;
  - a `progress` that collects lines;
  - `signal` from an `AbortController` (or `undefined`);
  - `batchNumber` 1.
- Build `DueItem`s with `document` = any non-empty synthetic text (e.g. `syntheticName(id)` plus a line) and `fingerprint: documentFingerprint(document)`.
- Read records back with `store.readEmbeddingRecord`, parsed with `ReadEmbeddingRecordResultSchema`.

Cases:
1. **Kept (AC-18, AC-33, AC-48).**
   - Responder `{ delayMs: 5 * SECOND, then: normal(40) }` for 2 items gives `{ kind: 'kept', tokens: 40 }`.
   - Exactly 1 request, whose `request` `toStrictEqual`s `{ input: [docs], model: EMBEDDING_MODEL, inputType: DOCUMENT_INPUT_TYPE, outputDimension: EMBEDDING_DIMENSIONS, truncation: true }`.
   - Both records are stored with `embedding` = `fakeEmbedding(doc)`, `model` = `EMBEDDING_MODEL`, the item's fingerprint, and `embeddedAt` = `iso(Date.parse(RUN_START) + 5 * SECOND)`.
   - `tally.snapshot()` shows `batchesSent 1`, `embeddingRequests 1`, `tokensUsed 40`, `placesEmbedded 2`.
   - Progress holds `Batch 1: sending 2 places`.
2. **Index mapping (AC-26).** A `raw` answer whose `data` lists the items' embeddings with indexes in reverse order maps each embedding to the item with that index. An answer without indexes maps by position.
3. **Connection failure then normal (AC-34).** `byAttempt(fail(connectionError()), NORMAL)`, and the same with `unavailableError()`:
   - result `kept`, 2 requests with identical `input`;
   - `clock.sleeps` shows exactly one sleep of `EMBEDDING_RETRY_WAITS_SECONDS[0] * 1000` ms;
   - `embeddingRequests 2`, `batchesSent 1`;
   - progress holds `Batch 1: connection failure, retrying in 30 s`.
4. **Persistent connection failure (AC-35).**
   - Result `{ kind: 'failed', failureKind: 'connection', reason: 'connection failure after 3 tries' }`.
   - 3 requests whose start times are 30 s and then 60 s apart. Sleeps are `[30000, 60000]` ms, from `EMBEDDING_RETRY_WAITS_SECONDS`.
   - Nothing is kept, and an earlier record of the Place stays unchanged.
   - `sendBatch` itself does **not** call `tally.failed`: `snapshot().failedPlaces` stays 0, because the loop does that in U6.
5. **Rate limit.**
   - Persistent `rateLimitError()`: `{ kind: 'stopped', stop: { outcome: 'rate_limited', message } }` with the AL4 1.4.4 message, 3 requests, nothing kept (AC-36).
   - `byAttempt(fail(rateLimitError()), NORMAL)`: `kept` after 1 sleep of 30 s.
   - Progress holds `Batch 1: rate limit, retrying in 30 s`.
6. **Refused (AC-37, AC-51).**
   - `refusedError()` (401) and a `SimulatedServiceError(400, ...)` give `stopped` with outcome `failed` after exactly 1 request and no sleep.
   - The message matches `/Embedding Service refused/i`, contains `HTTP 401` (and `HTTP 400`) and `VOYAGE_API_KEY_ENV`.
   - Neither the message nor any progress line contains `TEST_VOYAGE_API_KEY`, `Bearer` or the error's own message text.
7. **Invalid answers (AC-38).** For every AC-38 case (2 embeddings for 3 documents; 1023 and 1025 numbers; NaN; Infinity; a text value; `'<html>Bad gateway</html>'`; `null`; `{ usage: { totalTokens: 1 } }`) and an answer whose `model` is `'voyage-3.5'`:
   - `{ kind: 'failed', failureKind: 'invalid_answer', reason }`, where `reason` equals `findEmbeddingAnswerIssues(answer, n)[0]`;
   - exactly 1 request, no sleep, nothing kept;
   - `tokensUsed` stays 0.
8. **Store rejects (invalid data).** An item whose `placeId` is not a stored Detailed Place (e.g. 777777, together with a stored one) gives:
   - `{ kind: 'failed', failureKind: 'invalid_data' }`, with a `reason` starting `the Place Store rejected the Embedding Records: `;
   - nothing kept for either Place, and `tokensUsed` 0.
9. **Store unavailable (AC-42, AC-45).** A store built with `onWrite` that throws `new Error('hook failed Bearer ' + TEST_VOYAGE_API_KEY)` on write 1 gives:
   - `stopped` with outcome `failed`, after 1 request;
   - nothing kept;
   - a message that does not contain the hook's text, `Bearer` or the key.
10. **Interrupt.**
    - (a) `signal` already aborted when the first attempt fails with `connectionError()` gives `stopped` `interrupted`, 1 request, no sleep.
    - (b) Abort inside the clock's `onSleep` (the wait is in progress). The result is `stopped` `interrupted` and no second request is made.
11. **Synchronous throw.** A service whose `embed` throws synchronously (a small object literal implementing `EmbeddingService`, not a `Promise` rejection) is classified the same way as a rejection. For example, a sync throw of `rateLimitError()` with the abort set gives `interrupted`, and a sync `refusedError()` gives `stopped` `failed`.
12. **Request counter per attempt.** In every case above, `tally.snapshot().embeddingRequests` equals the number of `service.calls`, and `batchesSent` is 1.

### 2.2 add-coder

Implement AL4 1.3 (U5 part), 1.4.4 and 1.4.6. Import constants, schemas, helpers and types from `../../contracts/embeddings.schema` and `toMoment` from `../../contracts/hydration.schema`. Never copy or redefine them: no literal `voyage-4`, `1024`, `'document'`, `[30, 60]`, `429` or `VOYAGE_API_KEY` in `src/embed/`. Use `classifyEmbeddingServiceError` and `findEmbeddingAnswerIssues`; never re-implement them.

1. **Install the SDK.**
   - Check the newest published stable version with `pnpm view voyageai version`.
   - Install it pinned exactly: `pnpm add voyageai@<that version> --save-exact`. `package.json` must show `"voyageai": "<x.y.z>"` with no `^` or `~`. Only `package.json` and `pnpm-lock.yaml` change.
   - Then inspect the installed package's `package.json` (`exports`, `module`, `type`) and its type declarations, and write down for your report:
     - the client export name;
     - the base-URL client option (`environment` / `baseUrl`);
     - the per-request option names for retries and timeout;
     - the error class(es) and whether they carry `statusCode`;
     - the timeout error class;
     - whether answers are deserialized to camelCase.
2. **Load probe (before writing the adapter).** Run `pnpm exec tsx -e "import('voyageai').then((m) => process.stdout.write(typeof m.VoyageAIClient + '\n'))"` (use the real export name if it differs). It must print `function` and exit 0. **If the SDK's ESM entry fails to load under `tsx`, stop and report** the exact error to the orchestrator (an AL4 decision is needed). Do not add `createRequire`, `require`, a vendored copy, or `any`-typed workarounds.
3. **`src/embed/types.ts`** (extend): add exactly `StopOutcome`, `Stop`, `BatchResult`, `SendContext` and `VoyageServiceOptions` as written in AL4 1.3, with `import type` from the contracts:
   - `EmbeddingService`, `EmbeddingStore`, `EmbeddingClock`, `EmbeddingRunOutcome` and `FailedPlaceKind` come from the contracts.
   - `Tally` already exists in this file.
   - Do not add `ParsedEmbedArgs` (U7). Do not change the existing declarations.
4. **`src/embed/voyage-service.ts`** (new): `createVoyageEmbeddingService` and `normaliseVoyageAnswer`, per AL4 1.4.6:
   - Load the SDK with `await import('voyageai')` **inside** the factory only. Elsewhere use only `import type` from `voyageai`, if anything.
   - Build the client with the key and, when `baseUrl` is given, the SDK's base-URL option (conditional spread).
   - Every `embed` call passes SDK retries off (`maxRetries: 0`) and the timeout (`timeoutSeconds`, default 120). Use the SDK's real option names and units.
   - Map the contract request to the SDK request type field by field, if a plain spread does not type-check. No casts.
   - Return `normaliseVoyageAnswer(answer)`.
   - On a caught error: if it carries a numeric `statusCode` in 200..299, resolve `undefined`. Otherwise rethrow **the same error object** unchanged.
   - Read `statusCode` with `typeof`/`in` narrowing; no cast.
   - Never read `process.env`, never log, never build an error message containing the key.
   - `normaliseVoyageAnswer`: adds `usage.totalTokens` from a numeric `usage.total_tokens` only when `totalTokens` is absent. It returns a copy and never mutates. Anything else is returned as it came.
   - If the SDK resolves a non-JSON 2xx body as a string or another value, return that value. `findEmbeddingAnswerIssues` rejects it downstream.
5. **`src/embed/send-batch.ts`** (new): `sendBatch(ctx, items)` per the AL4 1.4.4 pseudocode, line for line:
   - **Request:** `{ input, model: EMBEDDING_MODEL, inputType: DOCUMENT_INPUT_TYPE, outputDimension: EMBEDDING_DIMENSIONS, truncation: true }`.
   - **Before the first attempt:** call `tally.batch()` once and send the progress line `Batch <k>: sending <n> places`.
   - **Each attempt:** call `tally.request()`. Call the service via `Promise.resolve().then(() => ctx.service.embed(request))`, so a synchronous throw is caught too.
   - **Classification:** use `classifyEmbeddingServiceError`.
     - `refused`: `stopped` `{ outcome: 'failed', message: refusedMessage(e) }`. Format: `The Embedding Service refused the request (HTTP <status>). Check ${VOYAGE_API_KEY_ENV} and the Voyage account.`; leave out ` (HTTP <status>)` when there is no numeric status.
     - `connection` / `rate_limit` with attempts left: check `signal?.aborted`, send the progress line `Batch <k>: connection failure, retrying in <w> s` or `Batch <k>: rate limit, retrying in <w> s`, call `clock.sleep(w * 1000)` with `w` from `EMBEDDING_RETRY_WAITS_SECONDS`, check `signal?.aborted` again, then retry. An abort returns `stopped` `{ outcome: 'interrupted' }`.
     - Retries used up: `failed` `connection` with reason `connection failure after 3 tries`, or `stopped` `{ outcome: 'rate_limited', message: 'The Embedding Service kept answering with its rate limit after 3 tries.' }`. Derive the "3" from `EMBEDDING_RETRY_WAITS_SECONDS.length + 1` if you build the text.
   - **Answer:** take `embeddedAt = toMoment(clock.now())` right after the answer arrives, then `findEmbeddingAnswerIssues(answer, items.length)`.
     - Any issue: `failed` `invalid_answer` with reason `issues[0]`.
     - Otherwise `EmbeddingAnswerSchema.parse`, then map vectors by `index` when the items carry one, else by position. Build records with `model: EMBEDDING_MODEL` and the item's fingerprint, and `await store.saveEmbeddingRecords({ records })`.
   - **Save result:**
     - ok: `tally.embedded(items.length, parsed.usage.totalTokens)` and return `{ kind: 'kept', tokens }`.
     - `invalid_data`: `failed` `invalid_data` with reason `the Place Store rejected the Embedding Records: ${failure.message}`.
     - Anything else (`store_unavailable`): `stopped` `{ outcome: 'failed', message: failure.message }`.
   - Under `noUncheckedIndexedAccess`, handle missing array entries explicitly (no `!`).
   - `sendBatch` does **not** call `tally.failed`, and does not print the `kept` / `failed places` / `Stopping` progress lines. The U6 loop does (AL4 1.4.2, 1.4.7).
   - Never put an error's `message`, a key, a URL or a Place Document into a result message or progress line.
6. Do not touch `src/embed/place-document.ts`, `batches.ts`, `settings.ts`, `report.ts`, `src/db/`, `src/crawl/`, `src/wikimapia/`, `scripts/`, `.env.example`, `tsconfig.json`, ESLint/Vitest config or docker files. Do not create any other `src/embed/` module.
7. **Stop and report, do not work around**, if any of these happens:
   - The SDK cannot be loaded under `tsx` or Vitest.
   - Retries cannot be turned off per request or per client.
   - HTTP errors carry no numeric `statusCode`, or a timeout or network error does carry one.
   - The SDK rejects a valid REST answer, or returns it without a usable `usage.totalTokens` that `normaliseVoyageAnswer` can repair.
   - The SDK sends camelCase fields or a different auth header.
   - The SDK cannot be pointed at `127.0.0.1`.
   - A contract type makes the AL4 signatures untypeable without a cast.
   - The SDK has no timeout option.

   In every case, report the observed behaviour exactly, so AL4 can decide.
8. Run every check in 2.3 in order. Report each result with its exit code and the relevant output lines, plus the SDK facts from step 1.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.
- **Test Database only.** It is reached only through `requireTestDatabaseUrl()` (`.env.test`).
- If the Postgres service is not running, `pnpm db:up` may be run to start it. Do not run `pnpm db:migrate`, `pnpm db:status`, `pnpm db:reset`, `pnpm crawl` or `pnpm embed`. Do not set `DATABASE_URL`. Do nothing against the Development Database.
- **No live Voyage call, no real key.** The only network traffic allowed is to `127.0.0.1` and the npm registry (for `pnpm view` / `pnpm add`).

1. `pnpm view voyageai version` was checked, and `package.json` has `"voyageai"` pinned to an exact version. `git`-free check: `Select-String -Path package.json -Pattern '"voyageai": "\d'` matches, and `Select-String -Path package.json -Pattern '"voyageai": "[\^~]'` returns nothing.
2. The load probe from 2.2 step 2 prints `function` and exits 0.
3. `pnpm exec vitest run --no-color tests/embed tests/db/embedding-store.db.test.ts` passes, with no failures and no skipped or todo tests. This includes the U3/U4 suites, the new `voyage-service.test.ts` and `send-batch.db.test.ts`.
4. Regression: `pnpm exec vitest run --no-color contracts/embeddings.schema.test.ts tests/db` passes.
5. `pnpm exec eslint src/embed tests/embed` reports no problems.
6. `pnpm exec tsc --noEmit` reports exactly 2 errors: the unresolved modules `src/embed/command` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. `pnpm lint` reports problems only in `contracts/embeddings.test.ts`, and only those caused by the same 2 missing modules.
7. Guards. Each of these must return nothing:
   - `Select-String -Path src/embed/*.ts -Pattern "console\.|: any|as any|as unknown|ts-expect-error|eslint-disable|createRequire|require\("`
   - `Select-String -Path src/embed/*.ts -Pattern "process\.env"`
   - `Select-String -Path src/embed/voyage-service.ts,src/embed/send-batch.ts -Pattern "'voyage-4'|\b1024\b|'document'|\b30, 60\b|'VOYAGE_API_KEY'|\.message\b"`. This checks for copied constants and copied error messages. `failure.message` of a store result is the one allowed `.message`: if this guard matches only that, list the match and explain it.
   - `Select-String -Path src/embed/*.ts -Pattern "^import .*from 'voyageai'" | Where-Object { $_.Line -notmatch '^import type' }`. Statically, only type imports are allowed.
   - `Select-String -Path tests/embed/*.ts -Pattern "api\.voyageai\.com|https://"`. No live endpoint in tests.
8. `Select-String -Path src/embed/*.ts -Pattern "unknown"`: list every match and state that each is one of the allowed uses from section 1.
9. `Get-ChildItem src/embed` lists exactly `place-document.ts`, `types.ts`, `settings.ts`, `batches.ts`, `report.ts`, `voyage-service.ts`, `send-batch.ts`. `Get-ChildItem tests/embed` lists exactly `place-document.test.ts`, `settings.test.ts`, `batches.test.ts`, `report.test.ts`, `voyage-service.test.ts`, `send-batch.db.test.ts`.

Do not run `contracts/embeddings.test.ts` as a gate: it cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If the real SDK contradicts AL4 1.4.6 or the contract's `EmbeddingService` / `classifyEmbeddingServiceError` assumptions, report it. Do not bend the contract or add casts.
- Files you may change: exactly those in AL4 U5 "Files", plus the lockfile:
  - `package.json` (only the `voyageai` dependency)
  - `pnpm-lock.yaml` (by `pnpm add` only)
  - `src/embed/types.ts`
  - `src/embed/voyage-service.ts`
  - `src/embed/send-batch.ts`
  - `tests/embed/voyage-service.test.ts`
  - `tests/embed/send-batch.db.test.ts`
- Never open, write or print `.env`. Never put a real key, password or connection string in code, tests or output. Never make a request to Voyage, Anthropic or Wikimapia.
- Do not edit `CLAUDE.md`, `.agrules`, `.env.example`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U6:** `runEmbedding`, which covers:
  - the Run flow of 1.2: settings, the key check, the interrupt check at start, building the default service, and the "Embedding Service client could not be loaded" failure;
  - the scan-and-send loop of 1.4.2: queueing, `cutBatch` use, `room`, `limitHeld`, `tally.failed` for `failed` results, the `kept` / `failed places` / `Stopping` progress lines, and choosing the outcome;
  - store lifecycle, and the start and end moments.
- **U7:** `command.ts`, `scripts/embed.ts`, the `embed` and extended `test:db` package scripts, `.env.example`, `ParsedEmbedArgs`, and the end-to-end AC checks in `contracts/embeddings.test.ts`.
- Any change to the U1 to U4 modules (`src/db/`, `place-document.ts`, `batches.ts`, `settings.ts`, `report.ts`), and recording the AL4 0.1 decisions or the pinned SDK version in `CLAUDE.md` (the orchestrator does this).
- Query embedding (`input_type: "query"`, Stage 2) and any Anthropic client.
