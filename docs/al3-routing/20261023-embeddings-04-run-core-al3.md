# AL3 Routing: embeddings, U4 "Pure Run core: settings, Batch cutting, tally and summary"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U4 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U4".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md` (stakeholder-approved). Do not open it unless an AC number below is unclear.
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1, U2 and U3 are done and verified. `src/embed/place-document.ts` and `tests/embed/place-document.test.ts` exist. `src/embed/types.ts` does **not** exist yet (U3 did not need it). This unit creates it.
- `pnpm exec tsc --noEmit` shows exactly 2 errors today: the unresolved modules `src/embed/command` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. After this unit, exactly those 2 must remain (AL4 section 4, "Baseline caveat").
- `contracts/embeddings.test.ts` still cannot load until U7. Do not run it as a gate. Do not stub the missing modules.
- U4 is pure: no database, no network, no clock, no new dependency.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:
- Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals.
- Top-level `import type` for types; extensionless relative imports.
- `unknown` is not needed anywhere in this unit.
- Every type alias or interface you declare in `src/embed/` goes in `src/embed/types.ts`.
- No `console`. Build optional properties (`message`) with conditional spreads; never assign `undefined`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Mainly section 4 (no secrets, synthetic fixtures only, no live calls, strict types) and section 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only these parts. "0. Scope and Fixed Points": the Constants row, the "Helpers to reuse" row, "Single source of truth", "Code style". "1.1 Module map": the `types.ts`, `batches.ts`, `settings.ts` and `report.ts` rows and the "Unit tests" paragraph. "1.3 Component contracts": the `src/embed/types.ts` block and the `batches.ts`, `settings.ts`, `report.ts` signatures. "1.4.2 Scan-and-send loop": read only to understand how `cutBatch`, `room`, `scanDone` and `limitHeld` are used (do not implement the loop). "1.4.3 Batch cutting" in full. "1.4.4 One Batch": only the bullet "Failed Place reports" (the `Place <id>: <reason>` message format). "1.4.5 Settings, key, messages" in full. "1.4.7 Tally, Run Summary, report" in full. "4. Implementation Units": the intro, "Baseline caveat" and "U4". "5. AL2 Guidance": the bullets "`exactOptionalPropertyTypes`", "Counts by construction", "Test files", "Imports", and the last bullet (do not edit `contracts/`). |
| 4 | `contracts/embeddings.schema.ts` | Lines ~154-184: `VOYAGE_MAX_TEXTS_PER_REQUEST`, `DEFAULT_BATCH_TOKEN_LIMIT`, `DEFAULT_EMBEDDING_LIMIT`, `EMBEDDING_RETRY_WAITS_SECONDS`, `estimateDocumentTokens`. Lines ~239-240 and ~270-280: `PlaceDocument`, `DocumentFingerprint`, `documentFingerprint`. Lines ~440-484: `findBatchIssues`, `EmbeddingRunRequestSchema`, `EmbeddingSettingsSchema`, `EMBEDDING_SETTING_KEYS`. Lines ~528-725: outcomes, `embedExitCodeFor`, `FailedPlaceKindSchema`, `EmbeddingRunCountsSchema` (and its four refinements), `ZERO_EMBEDDING_COUNTS`, `EmbeddingRunSummarySchema`, `EMBED_SUMMARY_LABELS`, `EMBEDDING_OUTCOME_LABELS`, `FAILED_PLACE_LABELS`, `FailedPlaceReportSchema`, `EmbeddingRunReportSchema`. Line ~115: `VOYAGE_API_KEY_ENV`. Line ~745: `EMBED_COMMAND_OPTIONS`. Import these; never redefine them. |
| 5 | `contracts/hydration.schema.ts` | Lines ~139-150 only: `MomentSchema`, `Moment`, `toMoment` (tests use `toMoment` to build valid moments). |
| 6 | `src/wikimapia/issues.ts` | `toFailureIssues` and `formatIssuePath`. `settings.ts` reuses them to turn a Zod issue path (which may hold symbols) into text, without a cast. |
| 7 | `src/crawl/report.ts` | Optional, pattern only: how the Crawl's `createTally`, `formatSummaryText`, `buildReport` and `failedReport` are shaped. Do not import from it and do not change it. |
| 8 | `contracts/embeddings.test.ts` | Read only these blocks, to mirror their expectations in unit tests (do not import from this file or run it): "AC-27" to "AC-32" (lines ~882-971), "AC-40" and "AC-41" (lines ~1234-1291), `summaryLines` / `expectSummaryText` and "AC-46" to "AC-48" (lines ~1433-1555), "AC-50" (line ~1604). |

Do not read `src/db/`, `src/crawl/` (other than the optional file above), `contracts/embeddings.support.ts` or the migrations. U4 does not need them: every input is built in the test from synthetic strings and numbers.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's API keys.

## 2. Execution Directives

### 2.1 add-test-writer

Create three new pure test files (no database, no network, no fixture files). Import subjects from `../../src/embed/<module>` and types from `../../src/embed/types` and `../../contracts/embeddings.schema` (with `import type` for types). Build `DueItem`s in the test with synthetic documents (e.g. `'x'.repeat(n)` or numbered names) and `documentFingerprint(document)`. Never paste vectors or long literal lists; generate data in code. Tests are expected to fail until `add-coder` finishes. Do not stub the production modules.

**`tests/embed/settings.test.ts`** (AL4 1.4.5; AC-40, AC-41):
1. **Defaults.** `resolveSettings({}, undefined)` is `ok` with `{ embeddingLimit: DEFAULT_EMBEDDING_LIMIT, batchTokenLimit: DEFAULT_BATCH_TOKEN_LIMIT }` (assert against the constants and also that they are 1,000 and 320,000). Given values (`{ embeddingLimit: 3 }`, `batchTokenLimit` 500) are passed through.
2. **Invalid `embeddingLimit`.** For 0, -1, 1.5, `NaN` and `Infinity`: `ok: false`, the message contains `embeddingLimit` and does not contain `batchTokenLimit`.
3. **Invalid `batchTokenLimit`.** For 0 and 2.5 (with a valid request): `ok: false`, the message contains `batchTokenLimit`.
4. **Value-free messages.** For -1, 1.5 and 2.5 the message does not contain `String(value)`. (Do not apply this check to `NaN` or `Infinity`: Zod's type text may name them.) The message format is `Invalid embedding setting "<key>": <zod message>`.
5. **Order.** A request with an invalid `embeddingLimit` and an invalid `batchTokenLimit` names `embeddingLimit` (the request is checked first).
6. **`isMissingApiKey`.** `true` for `undefined`, `''`, `'   '`, `' \t '`; `false` for `'TEST_VOYAGE_API_KEY'` and `'  TEST_VOYAGE_API_KEY  '`. Use only synthetic key strings.
7. **Messages.** `MISSING_KEY_MESSAGE` contains `VOYAGE_API_KEY_ENV`. `usageMessage()` contains `EMBED_COMMAND_OPTIONS.limit` and starts with `Usage: pnpm embed`.

**`tests/embed/batches.test.ts`** (AL4 1.4.3; AC-27, AC-28, AC-29 .. AC-32 cutting side). Write a small test-local driver that repeatedly calls `cutBatch(queue, room, tokenLimit, true)`, takes that many items, lowers `room`, and collects the Batches until it returns 0. Check every split it produces with the contract's `findBatchIssues(batches, documents, tokenLimit)` returning `[]` (pass the documents of the items that were taken).
1. **1,000 per Batch.** 2,500 equal small items, room 3,000, default limit: Batches of 1000, 1000, 500, in queue order.
2. **Token limit.** A `tokenLimit` equal to the estimate of exactly 2 items (`2 * estimateDocumentTokens(doc)`), 5 items: Batches of 2, 2, 1.
3. **Oversize.** An item whose estimate alone exceeds the limit, first in the queue, is taken alone (`cutBatch` returns 1). The same item after a small one: the small one is cut first (returns 1), then the oversize one alone. `findBatchIssues` accepts both splits.
4. **Room caps.** Room 3 with 5 items returns 3. Room 0 returns 0. An empty queue returns 0.
5. **Open Batch.** With `scanDone` false: a queue that fits in one Batch (below 1,000 items and within the limit) returns 0; the same queue with `scanDone` true returns all of it. A queue whose next item does not fit returns the closed count even with `scanDone` false. A queue of 1,000 or more items returns 1,000 with `scanDone` false. Room smaller than the queue returns the room with `scanDone` false (closed by the limit).
6. **Purity.** `cutBatch` does not change the queue (compare with a copy).

**`tests/embed/report.test.ts`** (AL4 1.4.7; AC-46, AC-47, AC-48 counting side, AC-50):
1. **Fresh tally.** `createTally().snapshot()` equals `ZERO_EMBEDDING_COUNTS`; `failures` is empty; `limitHeld` is 0.
2. **AC-47 scenario.** Replay on a tally: `summaryOnlySkipped = 1`; `considered('due')` x3 and `considered('unchanged')` x1; Batch 1: `batch()`, `request()`, `embedded(2, 40)`; Batch 2: `batch()`, `request()`, `failed([item 1381893], 'invalid_answer', <reason>)`. `snapshot()` `toStrictEqual`s the exact counts of contract AC-47 (considered 4, embedded 2, unchanged 1, summary-only 1, empty 0, failed 1 with `invalid_answer: 1`, still due 1, batches 2, requests 2, tokens 40) and passes `EmbeddingRunCountsSchema`. `failures` is `[{ placeId: 1381893, failureKind: 'invalid_answer', message: 'Place 1381893: <reason>' }]` and passes `FailedPlaceReportSchema`.
3. **Derived counts.** `placesStillDue` = considered - embedded - unchanged - empty, including Failed Places and Places never sent (e.g. 5 due, 3 embedded: still due 2). `failedPlaces` equals the sum of `failedPlacesByKind` across several kinds. Failed Places keep the order they were reported in. `empty` considerations count in `emptyDocumentsSkipped`. A retried Batch (1 `batch()`, 3 `request()`) passes the schema. `limitHeld` is a plain counter and does not change the snapshot.
4. **`formatSummaryText`.** For a summary with distinct numbers in every count, the text split on `\n` equals exactly the 17 lines of AL4 1.4.7, in that order, built from `EMBED_SUMMARY_LABELS`, `EMBEDDING_OUTCOME_LABELS` and `FAILED_PLACE_LABELS` (the per-kind lines in the order connection, invalid answer, invalid data). No leading or trailing newline. Every outcome shows its label.
5. **`buildReport`.** Passes `EmbeddingRunReportSchema` for `completed`, `limit_reached` and `failed` with a message. `summary.embeddingModel` is `EMBEDDING_MODEL`; `summaryText` equals `formatSummaryText(summary)`; the message is absent (not `undefined`-valued: `'message' in report` is false) when none is given; the message never appears inside `summaryText`.
6. **Gate.** Inputs that break the report schema (e.g. `failed` without a message, `endedAt` before `startedAt`, `failedPlaces` length not equal to `counts.failedPlaces`) return the `failedReport` with message `Embedding run failed: internal error (report check)`, zero counts and the given moments, and that result passes the schema.
7. **`failedReport`.** Outcome `failed`, the given message, `ZERO_EMBEDDING_COUNTS`, no Failed Places, the given moments (one moment for both works), passes `EmbeddingRunReportSchema`, and its `summaryText` holds the `Run outcome: Failed` line.
8. **Exit codes (AC-50).** `embedExitCodeFor(report.outcome)` is 0 for built `completed`, `limit_reached`, `rate_limited` reports and 1 for `failed` and `interrupted`.

Build moments with `toMoment(new Date(...))` from fixed synthetic dates.

### 2.2 add-coder

Implement AL4 1.3 (U4 part), 1.4.3, 1.4.5 and 1.4.7 exactly. Import constants, schemas, helpers and types from `../../contracts/embeddings.schema` (and `Moment` from `../../contracts/hydration.schema` if you need it). Never copy or redefine them: no literal `1000`, `320000`, `[30, 60]`, label texts or outcome texts in `src/embed/`.

1. **`src/embed/types.ts`** (new): declare exactly `DueItem`, `Resolution` and `Tally` as written in AL4 1.3 (with `import type` from the contract). You may also name the `buildReport` input as an interface here. Do **not** add `Stop`, `StopOutcome`, `BatchResult`, `SendContext`, `VoyageServiceOptions` or `ParsedEmbedArgs`; they belong to U5 to U7.
2. **`src/embed/settings.ts`** (new): `resolveSettings`, `isMissingApiKey`, `MISSING_KEY_MESSAGE`, `usageMessage`, per AL4 1.4.5 and the 1.3 comments:
   - Parse the request with `EmbeddingRunRequestSchema.safeParse` first, then the candidate with `EmbeddingSettingsSchema.safeParse`. Report only the first issue.
   - Key detection: `issue.path[0]` is one of `EMBEDDING_SETTING_KEYS` -> `Invalid embedding setting "<key>": <issue.message>`. Otherwise -> `Invalid embedding request: <formatIssuePath(path)>: <issue.message>`. Get a string/number path with `toFailureIssues` from `../wikimapia/issues`, not with a cast.
   - Never put an input value in a message.
   - `MISSING_KEY_MESSAGE` and `usageMessage()` use `VOYAGE_API_KEY_ENV` and `EMBED_COMMAND_OPTIONS.limit`.
3. **`src/embed/batches.ts`** (new): `cutBatch` per the AL4 1.4.3 pseudocode, line for line. Use `estimateDocumentTokens` and `VOYAGE_MAX_TEXTS_PER_REQUEST`. Return a count only; never change the queue.
4. **`src/embed/report.ts`** (new): `createTally`, `formatSummaryText`, `buildReport`, `failedReport`, per AL4 1.4.7:
   - `snapshot()` derives `placesStillDue` and `failedPlaces`; never counts them separately.
   - `failed(items, kind, reason)` adds one report per item, in item order, with message `Place <id>: <reason>`, and raises `failedPlacesByKind[kind]` by `items.length`.
   - `failures` exposes a read-only view or copy; callers cannot change the tally through it.
   - `formatSummaryText`: the 17 lines of 1.4.7 in order, joined with `\n`, numbers with `String(n)`. The per-kind lines are `${EMBED_SUMMARY_LABELS.failedPlaces} (${FAILED_PLACE_LABELS[kind]}): n`, in `FailedPlaceKindSchema.options` order.
   - `buildReport` gates with `EmbeddingRunReportSchema.safeParse`. On failure it returns `failedReport('Embedding run failed: internal error (report check)', startedAt, endedAt)`. `message` is added only when given (conditional spread).
   - `failedReport` uses `ZERO_EMBEDDING_COUNTS`, outcome `failed`, and no Failed Places.
5. **Purity.** No I/O, no clock, no logging, no module-level mutable state (each `createTally()` has its own state). Do not mutate inputs.
6. Do not touch `src/embed/place-document.ts`, `src/db/`, `src/crawl/`, `src/wikimapia/`, `scripts/`, `package.json`, the lockfile, `.env.example`, or config and docker files. Do not create any other `src/embed/` module.
7. **Stop and report, do not work around**, if:
   - a contract type makes the AL4 signatures untypeable without a cast; or
   - the AC-47 counts cannot be produced by the 1.4.7 derivation; or
   - Zod's message for an invalid setting contains the input value.
8. Run every check in 2.3 in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. This unit needs no database:
- Do not run `pnpm db:*`, `pnpm crawl`, `pnpm embed`, `pnpm test:db` or anything against the Development Database or the Test Database.
- Do not set `DATABASE_URL`.

1. `pnpm exec vitest run --no-color tests/embed contracts/embeddings.schema.test.ts` passes (this includes the U3 `place-document.test.ts`), with no failures and no skipped or todo tests.
2. Regression (pure suites): `pnpm exec vitest run --no-color tests/crawl/tile-plan.test.ts tests/crawl/report.test.ts tests/crawl/config.test.ts tests/db/vector.test.ts tests/db/writer.test.ts tests/db/validate.test.ts` passes.
3. `pnpm exec eslint src/embed tests/embed` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly 2 errors: the unresolved modules `src/embed/command` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. `pnpm lint` reports problems only in `contracts/embeddings.test.ts`, and only those caused by the same 2 missing modules.
5. Guards. Each of these must return nothing:
   - `Select-String -Path src/embed/*.ts -Pattern "console\.|: any|as any|as unknown|ts-expect-error|eslint-disable|unknown"`
   - `Select-String -Path src/embed/settings.ts,src/embed/batches.ts,src/embed/report.ts -Pattern "\b1000\b|320_?000|\b30, 60\b|'Run outcome|'Places embedded|'Completed'|'Limit Reached'|'connection failure'|'VOYAGE_API_KEY'|'--limit'"` (no copied constants or labels)
   - `Select-String -Path src/embed/batches.ts -Pattern "\.(sort|reverse|splice|shift|pop|push)\("` (`cutBatch` never changes the queue)
6. `Get-ChildItem src/embed` lists exactly `place-document.ts`, `types.ts`, `settings.ts`, `batches.ts`, `report.ts`. `Get-ChildItem tests/embed` lists exactly `place-document.test.ts`, `settings.test.ts`, `batches.test.ts`, `report.test.ts`.

Do not run `contracts/embeddings.test.ts` as a gate: it cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- Files you may change: exactly those in AL4 U4 "Files":
  - `src/embed/types.ts`
  - `src/embed/settings.ts`
  - `src/embed/batches.ts`
  - `src/embed/report.ts`
  - `tests/embed/settings.test.ts`
  - `tests/embed/batches.test.ts`
  - `tests/embed/report.test.ts`
- Never open, write or print `.env`. Never put a real key, password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `package.json`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U5:** the `voyageai` dependency, `voyage-service.ts`, `send-batch.ts` (requests, retries, `classifyEmbeddingServiceError`, `findEmbeddingAnswerIssues`, `refusedMessage`, the save), the `Stop`, `StopOutcome`, `BatchResult`, `SendContext` and `VoyageServiceOptions` types, and progress lines.
- **U6:** `runEmbedding`: the Run flow of 1.2, the scan-and-send loop of 1.4.2 (including where `limitHeld` is raised and how the outcome is chosen), store lifecycle, clock moments, and production use of `isEmbeddingDue` / `documentFingerprint` (tests may call `documentFingerprint`).
- **U7:** `command.ts` (`parseEmbedArgs`, `runEmbedCommand`, `ParsedEmbedArgs`), `scripts/embed.ts`, package scripts, `.env.example`, and the end-to-end AC checks in `contracts/embeddings.test.ts`.
- Any change to `src/embed/place-document.ts` (U3 is finished) or `src/db/` (U1/U2 are finished), and recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator does this).
