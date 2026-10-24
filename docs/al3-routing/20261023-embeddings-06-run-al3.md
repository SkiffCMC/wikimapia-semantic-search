# AL3 Routing: embeddings, U6 "The Run: runEmbedding"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U6 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U6".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md`. Open it only if an AC number below is unclear.
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 to U5 are done and verified.
  - `src/db/embedding-store.ts` exports `createEmbeddingStore`.
  - `src/embed/` holds exactly `types.ts`, `place-document.ts`, `batches.ts`, `settings.ts`, `report.ts`, `voyage-service.ts` and `send-batch.ts`.
  - `src/embed/types.ts` already declares `DueItem`, `Resolution`, `Tally`, `ReportInput`, `StopOutcome`, `Stop`, `BatchResult`, `SendContext` and `VoyageServiceOptions`.
- `voyageai` 0.4.0 is pinned and verified. `createVoyageEmbeddingService` loads it lazily. This unit only *calls* that factory, and only when no service is injected. It never imports `voyageai` itself.
- `sendBatch` prints only the `sending` and `retrying` lines, and it never calls `tally.failed`. **The loop in this unit owns** the `kept`, `failed places` and `Stopping` lines and the `tally.failed` call.
- `pnpm exec tsc --noEmit` shows exactly 2 errors: the unresolved modules `src/embed/command` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. After this unit, **exactly 1** must remain (`src/embed/command`).
- `contracts/embeddings.test.ts` cannot load until U7. Do not run it as a gate. Do not stub `src/embed/command`.
- **Known AL4 gap (do not resolve here):** if `buildReport`'s report-check gate meets `endedAt` before `startedAt`, it returns a `failedReport` that itself fails `EmbeddingRunReportSchema`. The Simulated Clock never runs backwards, so the Run cannot reach this. Do not write a test that constructs it, and do not change `report.ts` to work around it.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:
- Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, pnpm.
- Top-level `import type` for types; extensionless relative imports.
- Any new type alias or interface of `src/embed/` goes in `src/embed/types.ts`.
- `unknown` only for the caught error of the outer `try/catch`.
- No `console`. Build optional properties (`message`, `afterPlaceId`, `onWrite`) with conditional spreads; never assign `undefined`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Mainly section 1 (offline, idempotent, resumable), section 4 (no live calls, synthetic keys only, no secrets in output, Test Database only) and section 5 (code style). |
| 2 | `CLAUDE.md` | Stack and the "Embeddings" decision. Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only these parts. **"0. Scope and Fixed Points":** the table, "Approved contract decisions" (1), "Single source of truth", "Code style". **"1.1 Module map":** the `run-embedding.ts` row and the "Unit tests" paragraph. **"1.2 Run flow"** in full. **"1.3 Component contracts":** the `types.ts` block and the signatures of `cutBatch`, `resolveSettings`, `isMissingApiKey`, `MISSING_KEY_MESSAGE`, `createTally`, `buildReport`, `failedReport`, `createVoyageEmbeddingService`, `sendBatch`, `runEmbedding`. **"1.4.2 Scan-and-send loop"** in full, including the rules under it. **"1.4.4 One Batch":** only the `BatchResult` each path returns (do not re-implement). **"1.4.7":** the `snapshot()` bullet, the `buildReport` / `failedReport` / `endedAt` bullets, and "Progress lines". **"1.5 Transaction boundaries":** the table and the paragraph under it. **"3. Batch & External Calls":** the table and "Idempotency and resumability". **"4. Implementation Units":** the intro, "Baseline caveat" and "U6". **"5. AL2 Guidance":** all bullets. |
| 4 | `contracts/embeddings.schema.ts` | Lines ~466-547: `EmbeddingRunRequest`, `EmbeddingClock`, `EmbeddingDependencies` and its doc comment, `EmbeddingRunOutcome`, `embedExitCodeFor`. Lines ~555-734: `FailedPlaceKind`, `EmbeddingRunCountsSchema` (invariants), `ZERO_EMBEDDING_COUNTS`, `EmbeddingRunSummarySchema`, `EMBED_SUMMARY_LABELS`, `EMBEDDING_OUTCOME_LABELS`, `FAILED_PLACE_LABELS`, `EmbeddingRunReportSchema`, `RunEmbeddingFn`. Lines ~786-926: `MAX_PLACES_PER_STORE_CALL`, the candidates input/value, `EmbeddingStoreCounts`, `EmbeddingStore`, `EmbeddingStoreOptions`. Also `documentFingerprint` (~275) and `isEmbeddingDue` (~303). Import these; never redefine them. |
| 5 | `contracts/embeddings.support.ts` | Lines ~30-260: re-exported `SimulatedEmbeddingClock`, `RUN_START`, `SECOND`, `iso`; `TEST_VOYAGE_API_KEY`, `fakeEmbedding`, the error helpers, `ServiceGate`, `ServiceAnswer` helpers (`NORMAL`, `normal`, `raw`, `fail`, `byAttempt`), `SimulatedEmbeddingService` (`calls`, `inputs`, `texts`), `holdsPlace`. Lines ~264-360: `FETCHED_AT`, `syntheticName`, `syntheticDetails`. |
| 6 | `contracts/storage.support.ts` | `requireTestDatabaseUrl` (~line 50), `UNREACHABLE_DATABASE_URL` and `UNREACHABLE_PASSWORD` (~line 90). `requireTestDatabaseUrl` is the only way to get a database URL. |
| 7 | `contracts/hydration.schema.ts` | `toMoment` (~line 148) and `CrawlClock` (~line 381). |
| 8 | `src/crawl/runtime.ts` | `createSystemCrawlClock(signal?)` (line ~33): the default clock. Read-only. |
| 9 | `src/embed/types.ts`, `src/embed/report.ts`, `src/embed/settings.ts`, `src/embed/batches.ts`, `src/embed/send-batch.ts` (header and `sendBatch` signature), `src/embed/voyage-service.ts` (`createVoyageEmbeddingService` signature), `src/embed/place-document.ts` (export only) | The modules this unit composes. Do not change any of them, except to extend `types.ts` if needed. |
| 10 | `src/db/embedding-store.ts` | `createEmbeddingStore`: options, failure shape, `close()`. Read-only. |
| 11 | `tests/embed/send-batch.db.test.ts` | **Pattern** for Schema Setup, seeding, `SendContext` and the Simulated Service in a DB test. Mirror it; do not change it. |
| 12 | `tests/crawl/run-crawl.db.test.ts` | **Pattern only**, these blocks: lines ~22-30 (imports of `createDb`, `POOL_MAX_SETUP`, `destroyQuietly` from `src/db/connection`), ~138-150 (`fetch` spy, `testDb()`), ~344-352 (`connectionCount` over `pg_stat_activity`), ~942-960 (group E1, the 30-Run pool loop). Do not change it. |
| 13 | `contracts/embeddings.test.ts` | Mirror its expectations; do not import from it or run it. Read lines ~151-391 (lifecycle, `startEmbed` / `embed` helpers, `expectNoSecrets`, `everyOutput`) and the blocks AC-17 to AC-48 (~659-1556). Pay most attention to AC-29 (~909), AC-31 (~950), AC-32 (~959), AC-33 (~973), AC-36 (~1064), AC-37 (~1100), AC-42 (~1293), AC-43 (~1328), AC-44 (~1373), AC-45 (~1402) and AC-47 (~1493). |

Do not read the migrations, `src/wikimapia/`, `scripts/`, the other AL3 prompts, or `src/db/` beyond file 10 and `src/db/connection.ts` exports.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's real API keys. The only key in tests is `TEST_VOYAGE_API_KEY`.

## 2. Execution Directives

### 2.1 add-test-writer

Create **one** new file, `tests/embed/run-embedding.db.test.ts` (Test Database). Import the subject from `../../src/embed/run-embedding`. Import contracts with `import type` for types. Tests are expected to fail until `add-coder` finishes. Do not stub production modules.

**Setup**
- Use the `send-batch.db.test.ts` pattern:
  - `requireTestDatabaseUrl()`, then `createSchemaSetup(...).apply()` in `beforeAll`, `emptyStore()` in `beforeEach`, every setup and store closed in `afterAll`.
  - Seed Detailed Places through `createPlaceStore(...).savePlaceDetails` with `syntheticDetails(id)`. For bulk seeding, reuse one template with `placeId`, `title: syntheticName(id)` and a distinct description, as `seedManySynthetic` in the contract file does.
  - Seed a Summary-Only Place through a Listing Save of synthetic Place summaries.
- Stub global `fetch` with a rejecting spy, as in `run-crawl.db.test.ts`. One test asserts it was never called.
- Write a local `embed(...)` helper that mirrors the contract's `startEmbed` / `embed`:
  - a `SimulatedEmbeddingClock` and a `SimulatedEmbeddingService(clock, responder)`;
  - `connectionString` = the test URL unless overridden;
  - `apiKey: TEST_VOYAGE_API_KEY` unless the case says otherwise;
  - `onProgress` collects lines;
  - `signal`, `onWrite`, `batchTokenLimit` only when given (conditional spread);
  - every report is parsed with `EmbeddingRunReportSchema`;
  - every `service.calls[i].request` is parsed with `EmbeddingServiceRequestSchema`.
- **Every `runEmbedding` call in this file injects `embeddingService`.** A call without one would build the real Voyage adapter. Never do that.
- Read Embedding Records back with a separate `createEmbeddingStore({ connectionString: testUrl }).readEmbeddingRecord`, parsed with `ReadEmbeddingRecordResultSchema`. Close it in `afterAll`.
- To make one Place per Batch, use `estimateDocumentTokens(document)` as the `batchTokenLimit`. Get the document with `buildPlaceDocument(readPlace(...))`, as the contract's `limitFor` does.
- Bulk-seeding cases (1,001+ Places) get an explicit per-test timeout of about 180 s.

**Cases.** Each one pins the stated AL4 behaviour.

1. **Counts are exact (AC-47 pattern, 1.4.7).**
   - Seed: 1 Summary-Only Place; Detailed Places 301, 302, 303; and 304 with an existing `voyage-4` record whose fingerprint matches its current document (kept through the Embedding Store).
   - Use a token limit that fits 2 documents. The responder answers the request holding 303 with `raw({ data: [], usage: { totalTokens: 0 } })` and every other request with `normal(40)`.
   - Expect:
     - `service.inputs` = `[[d301, d302], [d303]]`;
     - outcome `completed`;
     - counts `toStrictEqual` `{ detailedPlacesConsidered: 4, placesEmbedded: 2, unchangedSkipped: 1, summaryOnlySkipped: 1, emptyDocumentsSkipped: 0, failedPlaces: 1, failedPlacesByKind: { connection: 0, invalid_answer: 1, invalid_data: 0 }, placesStillDue: 1, batchesSent: 2, embeddingRequests: 2, tokensUsed: 40 }`;
     - `failedPlaces` = `[{ placeId: 303, failureKind: 'invalid_answer', message: starts with 'Place 303: ' }]`.
   - Progress lines contain, in this order:
     - `Embedding run started: 1 summary-only places skipped`
     - `Batch 1: sending 2 places`
     - `Batch 1: kept 2 embeddings (40 tokens)`
     - `Batch 2: sending 1 places`
     - `Batch 2: 1 failed places (invalid embedding answer)`
   - There is no `Stopping:` line.
2. **Embedding Limit (AC-29, AC-31, 1.4.2 rules).**
   - (a) 5 due Places, `{ embeddingLimit: 3 }`: outcome `limit_reached`, 3 embedded, `placesStillDue` 2, 1 request of 3 (the first 3 in ascending Place ID). A second Run with no request override sends exactly the remaining 2 in 1 request and ends `completed`.
   - (b) Exactly 3 due with limit 3: `completed`, not `limit_reached`.
   - (c) Failed Places count towards the limit (AC-32): limit 3, and a first Batch of 3 answered with an invalid answer. Exactly 1 request, `failedPlaces` 3, outcome `limit_reached` when a 4th due Place exists.
   - (d) Unchanged Places do not use up the limit (AC-30): 2 Unchanged and 2 due with limit 2 give `completed`, 2 embedded.
3. **Pages and the default limit (1.4.2, AC-27).**
   - (a) Seed 1,001 small Places. Run with the default limit:
     - outcome `limit_reached`;
     - 1 request of exactly 1,000 texts;
     - `placesEmbedded` 1000, `placesStillDue` 1, `detailedPlacesConsidered` 1001 (reading continues past the used-up limit).
   - (b) **A Batch open at a page boundary is not closed by it.**
     - Continue from (a) or seed afresh, and run with `{ embeddingLimit: 2000 }` until every Place has a record.
     - Then re-save Place number 1,000 and Place number 1,001 in ascending order (the last of page 1 and the first of page 2) with a changed description.
     - The next Run makes exactly **1** request with exactly those 2 documents, ends `completed`, and has `unchangedSkipped` 999.
     - This covers AL4 U6's "1,000 Unchanged then 2 due" case and is stronger than it.
4. **Persistent rate limit on Batch 2 of 3 (AC-36, approved decision 1).**
   - 3 due Places, one per Batch. Batch 2 always gets `rateLimitError()`.
   - Expect:
     - outcome `rate_limited`, with the message from `sendBatch`;
     - 1 + 3 = 4 requests, and none holds Place 3's document;
     - Batch 1's record kept; Places 2 and 3 without records;
     - `placesStillDue` 2, `failedPlaces` 0;
     - the progress line `Stopping: Rate Limited`.
5. **Refused on Batch 2 (AC-37).**
   - 3 due, one per Batch, `fail(refusedError())` on call index 1.
   - Expect:
     - outcome `failed`, with a message matching `/Embedding Service refused/i`;
     - exactly 2 requests;
     - Batch 1 kept;
     - `placesStillDue` 2;
     - `Stopping: Failed` printed once.
   - The report still has full counts: `detailedPlacesConsidered` 3, because reading continues after a refused stop.
6. **Store failure while keeping Batch 2 (AC-42 second case, AC-45).**
   - 3 due, one per Batch, with an `onWrite` that throws `new Error('hook ' + TEST_VOYAGE_API_KEY)` once `service.calls.length >= 2`.
   - Expect: outcome `failed`, exactly 2 requests, Batch 1 kept, 302 and 303 without records.
   - The output (`everyOutput`-style join of the JSON report, the summary text and the progress lines) contains neither the hook's text nor the key.
7. **Interrupt (AC-43).**
   - (a) Already aborted at the start, with `connectionString: UNREACHABLE_DATABASE_URL`:
     - outcome `interrupted` (not `failed`), which proves no store was opened;
     - 0 requests, zero counts;
     - `startedAt` equal to `endedAt`.
   - (b) Abort inside the responder's `effect` on call index 1 (3 due, one per Batch):
     - exactly 2 requests, outcome `interrupted`;
     - record 301 kept, 302 either kept in full or absent, 303 absent;
     - a following Run (no abort) sends only what is left and ends `completed`.
   - (c) AC-44:
     - A Run stuck on a `ServiceGate` for Batch 2 does not block a second, concurrent Run. The second Run sends 302 and 303, and has `unchangedSkipped` 1.
     - Then abort the first Run and open the gate with `raw('the process was killed')`. Its report still parses.
8. **Before-start failures (1.2 steps 1, 2, 6).** Use `UNREACHABLE_DATABASE_URL` where marked, to prove the ordering.
   - (a) `{ embeddingLimit: 0 }` with an unreachable URL gives `failed` with a message containing `embeddingLimit`, and 0 requests.
   - (b) `batchTokenLimit: 0` gives `failed` naming `batchTokenLimit`.
   - (c) No `apiKey`, a blank `apiKey` (`'   '`), and each with an injected service and an unreachable URL: `failed`, the message contains `VOYAGE_API_KEY`, and 0 requests (AC-40, AC-60).
   - (d) A valid key and an unreachable URL (AC-42 first case):
     - `failed`, 0 requests;
     - the `summaryText` contains `Run outcome: Failed`;
     - the output contains no `UNREACHABLE_PASSWORD`, `postgres://`, `UNREACHABLE_DATABASE_URL`, key or `Bearer`.
   - (e) In every case of this group, the report has zero counts (`ZERO_EMBEDDING_COUNTS`) and no Failed Places.
9. **Only Summary-Only Places (AC-17).** 0 requests, outcome `completed`, `summaryOnlySkipped` equal to their count, 0 embedded.
10. **Pool closed (1.2 step 5, AL4 5 "Close every pool").**
    - Mirror run-crawl E1: take a `pg_stat_activity` count through the test's own `testDb()` handle, then run 30 Runs over 1 seeded Place in a loop (each `completed` or with nothing due).
    - After a short settle loop, the count is at most `before + 2`.
    - Close the `testDb()` handle in `afterEach`/`afterAll`.
11. **No secrets, no document text (AC-51).** A Run mixing kept, failed and stopped Batches (for example, the case 5 setup). The joined output:
    - passes a local `expectNoSecrets` (key, `/Bearer\s/`, `postgres://`, the test DB password);
    - contains no full Place Document text of any seeded Place. Check `d301` itself; the `syntheticName` alone may appear in no line either.
12. **No network.** The `fetch` spy was never called (final test in the file, or `afterAll` assertion).

Never paste vectors as literals; use `fakeEmbedding`. Never write an `https://` URL or `api.voyageai.com` in this file.

### 2.2 add-coder

Implement AL4 1.2 and 1.4.2 in **one** new file, `src/embed/run-embedding.ts`, exporting `runEmbedding: RunEmbeddingFn`.
- Import constants, schemas, helpers and types from `../../contracts/embeddings.schema` and `toMoment` from `../../contracts/hydration.schema`.
- Never copy or redefine them. There must be no literal `1000`, `voyage-4`, `VOYAGE_API_KEY` or outcome label text in this file.
- Compose the existing modules. Do not re-implement them:
  - `resolveSettings`, `isMissingApiKey`, `MISSING_KEY_MESSAGE`;
  - `cutBatch`, `buildPlaceDocument`, `sendBatch`;
  - `createTally`, `buildReport`, `failedReport`;
  - `createVoyageEmbeddingService`, `createEmbeddingStore`, `createSystemCrawlClock`;
  - `documentFingerprint`, `isEmbeddingDue`.

1. **Shell (1.2).** `runEmbedding` never rejects.
   - Wrap the whole body in `try/catch`. On a throw, return `failedReport('Embedding run failed: internal error', startedAt, now)`. Never use the caught error's message.
   - `clock = deps.clock ?? createSystemCrawlClock(deps.signal)`; `startedAt = toMoment(clock.now())`.
   - `progress = deps.onProgress ?? no-op`.
2. **Before-start checks, in this order.** None of them opens a store or sends a request.
   - **Settings.** `resolveSettings(request, deps.batchTokenLimit)`. If not ok: `failedReport(message, startedAt, startedAt)`.
   - **Key.** If `isMissingApiKey(deps.apiKey)`: `failedReport(MISSING_KEY_MESSAGE, ...)`. Check this even when `deps.embeddingService` is given.
   - **Interrupt at start.** If `deps.signal?.aborted`: `buildReport({ outcome: 'interrupted', startedAt, endedAt: startedAt, counts: createTally().snapshot(), failedPlaces: [] })`.
   - **Service.** `service = deps.embeddingService ?? await createVoyageEmbeddingService({ apiKey: deps.apiKey.trim() })`.
     - Narrow `apiKey` without `!` (the key check above guarantees a string).
     - If building the default service throws, return `failedReport('Embedding Service client could not be loaded', ...)` with no detail.
3. **Store lifecycle.**
   - Open exactly one store: `createEmbeddingStore({ connectionString: deps.connectionString, ...(deps.onWrite ? { onWrite } : {}) })`. Open it only after step 2.
   - Close it in `finally` with `await store.close()`.
   - Take `endedAt = toMoment(clock.now())` after the loop, before the close.
4. **Totals.** Call `store.countEmbeddingStore()`.
   - Failure: `failedReport(result.failure.message, startedAt, now)`.
   - Otherwise: `tally.summaryOnlySkipped = value.summaryOnlyPlaces`, then the progress line `Embedding run started: <n> summary-only places skipped`.
5. **Scan-and-send loop (1.4.2), line for line.**
   - Pages:
     - `listEmbeddingCandidates({ limit: MAX_PLACES_PER_STORE_CALL, ...(after !== undefined ? { afterPlaceId: after } : {}) })`.
     - `scanDone` when a page holds fewer than `MAX_PLACES_PER_STORE_CALL` places.
   - Classify each candidate:
     - `''` -> `empty`;
     - `!isEmbeddingDue(document, embeddingRecord)` -> `unchanged`;
     - else `due`.
   - A due Place:
     - is left alone when a stop is set;
     - adds `tally.limitHeld += 1` when `room === 0`;
     - otherwise is queued with its `documentFingerprint`.
   - Inner Batch loop:
     - `cutBatch(queue, room, settings.batchTokenLimit, scanDone)`;
     - check the abort **before** each Batch;
     - `queue.splice(0, n)`, `room -= n`, `batchNumber += 1`;
     - `sendBatch({ service, store, clock, signal: deps.signal, tally, progress, batchNumber }, items)`.
   - Results:
     - `kept`: progress `Batch <k>: kept <n> embeddings (<tokens> tokens)`.
     - `failed`: `tally.failed(items, failureKind, reason)` and progress `Batch <k>: <n> failed places (<FAILED_PLACE_LABELS[kind]>)`. The Run goes on.
     - `stopped`: `stop = result.stop`.
     - After each Batch: if the signal is aborted and no stop is set, set `stop = { outcome: 'interrupted' }`.
   - After the inner loop:
     - if `room === 0` and no stop: `limitHeld += queue.length`, clear the queue;
     - if a stop is set: clear the queue (still due, **not** `limitHeld`).
   - **Scan halting (routing interpretation of AL4 `scanHalted`).** Keep a local `scanHalted` boolean, set **only** by `interrupted` or by a failed candidates read.
     - A `failed` stop from `sendBatch` (refused, or store unavailable while keeping) does **not** halt the scan by itself. Reading continues, reads only, so the counts stay exact.
     - If a later read fails while a stop is already set, keep the **first** stop and its message. Halt the scan.
     - If a read fails with no stop set: `stop = { outcome: 'failed', message: r.failure.message }`.
   - **`Stopping: <EMBEDDING_OUTCOME_LABELS[outcome]>`** is printed exactly once, at the moment `stop` is first set. It is never printed for `completed` or `limit_reached`.
   - End the loop when `scanDone || scanHalted`.
6. **Outcome and report (1.2 steps 8 and 9).**
   - `outcome = stop?.outcome ?? (tally.limitHeld > 0 ? 'limit_reached' : 'completed')`.
   - `buildReport({ outcome, ...(stop?.message !== undefined ? { message } : {}), startedAt, endedAt, counts: tally.snapshot(), failedPlaces: tally.failures })`.
   - Do not gate again. `buildReport` already does.
7. **Types.** Add to `src/embed/types.ts` only what is really needed, for example a scan state interface if you introduce one. Do not change existing declarations.
8. **Never:**
   - put an error's own `message`, a key, a URL, a connection string or Place Document text into a message or progress line (store `failure.message` values are safe and allowed);
   - read `process.env`;
   - import `voyageai`;
   - hold a store call open across `sendBatch`.
9. Do not touch any other `src/` file, `tests/` file other than the new one, `scripts/`, `package.json`, `.env.example`, configs or docker files.
10. **Stop and report, do not work around**, if any of these happens:
    - a contract type makes the AL4 flow untypeable without a cast;
    - an existing module's behaviour contradicts AL4 1.4.2 (for example, `cutBatch` closing a Batch at a page boundary, or `sendBatch` calling `tally.failed`);
    - a case in 2.1 can only pass by changing a U1 to U5 module.
11. Run every check in 2.3 in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.
- **Test Database only.** It is reached only through `requireTestDatabaseUrl()` (`.env.test`).
- If Postgres is not running, `pnpm db:up` may be run. Do not run `pnpm db:migrate`, `pnpm db:status`, `pnpm db:reset`, `pnpm crawl` or `pnpm embed`. Do not set `DATABASE_URL`. Do nothing against the Development Database.
- **No live Voyage call, no real key, no network** beyond `127.0.0.1` (the U5 adapter test's local server).

1. `pnpm exec vitest run --no-color tests/embed tests/db` passes, with no failures and no skipped or todo tests. This includes the new `tests/embed/run-embedding.db.test.ts` and every U1 to U5 suite.
2. Regression: `pnpm exec vitest run --no-color contracts/embeddings.schema.test.ts contracts/storage.test.ts contracts/hydration.test.ts contracts/crawl-run1-fixes.test.ts tests/crawl` passes.
3. `pnpm exec eslint src/embed tests/embed` reports no problems.
4. `pnpm exec tsc --noEmit` reports **exactly 1** error: the unresolved module `src/embed/command` in `contracts/embeddings.test.ts`. `pnpm lint` reports problems only in `contracts/embeddings.test.ts`, and only those caused by that missing module.
5. Guards. Each must return nothing:
   - `Select-String -Path src/embed/run-embedding.ts -Pattern "console\.|: any|as any|as unknown|ts-expect-error|eslint-disable|process\.env|voyageai|\b1000\b|'voyage-4'|VOYAGE_API_KEY'"`
   - `Select-String -Path src/embed/run-embedding.ts -Pattern "\w!\.|\w!;|\w!\)|\w!,"`. This catches non-null assertions.
   - `Select-String -Path tests/embed/run-embedding.db.test.ts -Pattern "api\.voyageai\.com|https://|\bDATABASE_URL\b|process\.env"`. The `\b` keeps `UNREACHABLE_DATABASE_URL` from matching. This guard covers this unit's test file only; `tests/embed/place-document.test.ts` legitimately contains `https://` test data.
6. `Select-String -Path src/embed/run-embedding.ts -Pattern "\.message\b"`. List every match. Each must be a `failure.message` of a store result, the `message` of a failed `resolveSettings` resolution, or `stop.message`. A caught error's `.message` is not allowed.
7. `Select-String -Path src/embed/run-embedding.ts -Pattern "unknown"`. List every match. Only the outer `catch` may use it.
8. `Select-String -Path tests/embed/run-embedding.db.test.ts -Pattern "runEmbedding\("`. List the matches and confirm each call passes `embeddingService` (directly or through the helper).
9. `Get-ChildItem src/embed` lists exactly:
   - `place-document.ts`, `types.ts`, `settings.ts`, `batches.ts`, `report.ts`, `voyage-service.ts`, `send-batch.ts`, `run-embedding.ts`.

   `Get-ChildItem tests/embed` lists exactly:
   - `place-document.test.ts`, `settings.test.ts`, `batches.test.ts`, `report.test.ts`, `voyage-service.test.ts`, `send-batch.db.test.ts`, `run-embedding.db.test.ts`.

Do not run `contracts/embeddings.test.ts` as a gate: it cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If AL4 1.2 / 1.4.2 cannot be implemented as written with the existing U1 to U5 modules, report it. Do not bend the contract, the earlier modules, or add casts.
- Files you may change: exactly those in AL4 U6 "Files":
  - `src/embed/run-embedding.ts` (new)
  - `src/embed/types.ts` (extend only)
  - `tests/embed/run-embedding.db.test.ts` (new)
- Never open, write or print `.env`. Never put a real key, password or connection string in code, tests or output. Never make a request to Voyage, Anthropic or Wikimapia.
- Do not edit `CLAUDE.md`, `.agrules`, `.env.example`, `package.json`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U7:**
  - `src/embed/command.ts` (`parseEmbedArgs`, `runEmbedCommand`, `ParsedEmbedArgs`) and `scripts/embed.ts`;
  - the `embed` and extended `test:db` package scripts, and `.env.example`;
  - exit codes in use (`embedExitCodeFor` is applied by the command);
  - the end-to-end run of `contracts/embeddings.test.ts`, and `tsc` / `lint` at 0.
- Any change to U1 to U5 modules: `src/db/`, `place-document.ts`, `batches.ts`, `settings.ts`, `report.ts`, `voyage-service.ts`, `send-batch.ts`. This includes the known `buildReport` report-check gap (an AL4 matter).
- Recording the AL4 0.1 decisions or the pinned SDK version in `CLAUDE.md` (the orchestrator does this).
- Query embedding (`input_type: "query"`, Stage 2) and any Anthropic client.
