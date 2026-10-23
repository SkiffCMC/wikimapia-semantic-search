# AL3 Routing: crawl-run1-fixes, U5 "Crawl core: quota stop, item messages, tally and summary"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U5 of 7 (attempt 1). Depends on U1 (done: `docs/al3-routing/20261022-crawl-run1-fixes-01-client-al3.md`). U2, U3 and U4 are done as well.
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section "4. Implementation Units", "U5. Crawl core: quota stop, item messages, tally and summary"
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2)
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 delivered the Client side: a code 1004 answer resolves the Client Failure `key_quota_exhausted` (`message` = `Wikimapia key quota exhausted (code 1004): <text>`, `wikimapiaMessage`, `code: 1004`), with no retry and no wait. A `wikimapia_error` failure carries the Client-redacted `message` (`Wikimapia reported an error`) and `wikimapiaMessage`.
- U4 delivered `BeginRunValue.started.placesReleased` and `repo.regionTotals` / `repo.listParkedPlaces`. `src/crawl/run-crawl.ts` passes `retryParked: false` to `repo.beginRun` (U4 placeholder) and still calls the repository's `countPlacesDue` adapter. **Both stay as they are in U5** (U6 replaces them).
- `pnpm exec tsc --noEmit` reports exactly two errors, both yours: `src/crawl/requests.ts:65` (`key_quota_exhausted` reaches the `never` default) and `tests/crawl/report.test.ts:38` (the `AC51_COUNTS` literal lacks the three parking counts).
- `tests/crawl/report.test.ts` has 2 failing cases, both yours: "createTally: the AC-51 numbers > gives exactly the AC-51 counts" and "buildReport > completed with a runId and the AC-51 tally passes RunReportSchema". The cause is the same literal: `zeroCounts()` already spreads `ZERO_RUN_COUNTS`, so the tally emits the three counts as 0, while the test literal lacks them.
- Everything else in `tests/` passes, as do the storage, schema and client contract suites. They must stay green.
- The end-to-end cases of `contracts/crawl-run1-fixes.test.ts` (AC-15 .. AC-39 Run cases) drive whole Runs and stay red until U6. That is expected. The one exception that U5 turns green is the AC-39 Dry Run case (section 2.3 step 4).

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, **extensionless** relative imports, `unknown` only where `.agrules` section 5 allows it, types in `src/crawl/types.ts`, no `console`. Match the style of the existing `src/crawl/` and `tests/crawl/` files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly section 2 (Zod at every boundary), section 4 (no secrets, recorded fixtures, no live calls) and section 5. |
| 2 | `CLAUDE.md` | Stack and decisions ("Key quota" under "Verified behaviour"). Do not edit it. |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | The design. Read only these parts: "0. Scope and Fixed Points" (the fixed-points table and the "Single source of truth" paragraph); "0.1" decision 4 and the "Key Quota" and "Item Failure messages" rows; "1.1 Module map", the Crawl rows for `types.ts`, `gateway.ts`, `requests.ts`, `report.ts`; "1.2 Run flow" step 9 and the "Heartbeat snapshots" paragraph (only to understand the interim values); "1.3 Component contracts", the `src/crawl/types.ts` block and the `oneLine`, `formatSummaryText`, `buildReport`, `plannedReport` signatures; "1.4.3"; "1.4.10" (not the "Command output" paragraph); "4. Implementation Units / U5"; "5. AL2 Guidance". Skip everything else. |
| 4 | `contracts/hydration.schema.ts` | `RunOutcomeSchema`, `CLEAN_STOP_OUTCOMES`, `exitCodeFor` (~414-450); `RunCountsSchema` with the three parking counts and the `placesParkedThisRun <= placesParked` refine, `ZERO_RUN_COUNTS` (~470-555); `SUMMARY_LABELS` incl. `placesParkedThisRun`, `placesParked`, `placesReleased`, `wikimapiaMessage`, `OUTCOME_LABELS`, `ITEM_FAILURE_LABELS` (~573-621); `ItemFailureReportSchema`, `RunReportSchema` with `parkedPlacesInRegion` and its Planned-only refine (~634-693); `CONNECTION_RETRY_WAITS_SECONDS`. |
| 5 | `contracts/wikimapia-client.schema.ts` | `KEY_QUOTA_CODE` (~59), `WikimapiaErrorFailureSchema`, `KeyQuotaExhaustedFailureSchema`, `ClientFailureSchema` (~403-444). |
| 6 | `contracts/wikimapia-client.support.ts` | `KEY_QUOTA_BODY`, `keyQuotaAnswer`, `keyQuotaVariant` (~105-130): recorded answers for the test harness. |
| 7 | `contracts/hydration.support.ts` | Test doubles already used by `tests/crawl/requests.test.ts` and `gateway.test.ts` (`SimulatedCrawlClock`, `CrawlWikimapia`, `scripted`, `UNREACHABLE`, `wikimapiaErrorAnswer`, `RUN_START`, `SECOND`, `at`). |
| 8 | `contracts/crawl-run1-fixes.schema.ts` | Reference only. Nothing in it is implemented in U5. |
| 9 | `contracts/crawl-run1-fixes.test.ts` | Reference only: `KEY_QUOTA_MESSAGE` (~161), AC-18 (~887), AC-20 (~929), AC-22 (~994), AC-39 (~1449). They show what the pure parts must support end to end. Only the AC-39 Dry Run case is expected to pass in U5. |
| 10 | `src/crawl/types.ts` | File to change (`Stop`, `Gateway.stop`, `Tally`, `SummaryNotes`). |
| 11 | `src/crawl/gateway.ts` | File to change (`stop`). |
| 12 | `src/crawl/requests.ts` | File to change (the `key_quota_exhausted` case, the Wikimapia Error message). |
| 13 | `src/crawl/report.ts` | File to change (tally, `oneLine`, `formatSummaryText`, `buildReport`, `plannedReport`). |
| 14 | `src/crawl/run-crawl.ts` | Read only, except the single permitted edit in section 2.2 step 6 (the local `snapshot` closure, lines ~102-106). |
| 15 | `tests/crawl/report.test.ts` | Test file to update. Reuse `LINE_PATTERN`, `ZERO_GATEWAY`, `ZERO_EXTRA`, `AC51_COUNTS`, `ac51Tally`, `ac51Snapshot`, `ac51Summary`, `expectedLines`. |
| 16 | `tests/crawl/requests.test.ts` | Test file to update. Reuse `harness`, `page1`, `directFailure`, `pageAnswer`. |
| 17 | `tests/crawl/gateway.test.ts` | Test file to update (the `stop` describe, ~517). |
| 18 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read anything under `src/wikimapia/` or `src/db/`, the other `src/crawl/` files (`listing-phase.ts`, `details-phase.ts`, `config.ts`, `command.ts`), the AL6 document or the migrations. U5 touches none of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

**Line endings:** every file you create or change must keep **LF** line endings. A previous coder rewrote files as CRLF. Do not rewrite whole files with a tool that converts line endings. Check with the guard in 2.3 step 8.

## 2. Execution Directives

### 2.1 add-test-writer

All U5 tests are pure: no database, no network, no real time, no real API key (`TEST_API_KEY` only). Use the recorded Key Quota answer (`keyQuotaAnswer()`, `keyQuotaVariant(...)`) through the existing `harness`, or a hand-written `ClientCall` returning a literal `key_quota_exhausted` failure. Expand AL4 U5 "Unit tests must cover" as follows.

**A. `tests/crawl/requests.test.ts`**

1. Key Quota on the first call (recorded `keyQuotaAnswer()`, details and listing kind): result `{ kind: 'stopped' }`, exactly 1 transport call, no sleep, `gateway.stopped` equals `{ reason: 'quota_exhausted', message: <the Client's message>, wikimapiaMessage: 'Key limit has been reached' }`. Compare `message` with `directFailure(keyQuotaAnswer()).message`. It contains `Key limit has been reached` and never the API key.
2. Key Quota answer to the second Connection Failure try (`UNREACHABLE`, then `keyQuotaAnswer()`): 2 calls, exactly one 30 s wait, stopped with `quota_exhausted`, and no third call even when the script has a further good answer (AC-20 pure side).
3. Key Quota after a Rate-Limit Response (the Client's own retry): stopped `quota_exhausted`, 2 calls, both counted in the request kind.
4. An already stopped Gateway (e.g. `budget_reached`) that receives a Key Quota failure keeps the first stop.
5. A blank `wikimapiaMessage` (`keyQuotaVariant({ message: '' })` or a literal failure) still stops with `quota_exhausted`; `stopped.wikimapiaMessage` is `''` and `message` is the Client's bare message.
6. **Rewrite the two existing cases that pin the old Wikimapia Error message** (the AL4 "Item Failure messages" row amends hydration AL4 1.4.4):
   - "a wikimapia_error makes 1 call and is an Item Failure ..." (the loop at ~202): for `wikimapia_error` the expected message is now `${direct.message}: ${direct.wikimapiaMessage}` (with `direct` narrowed to the `wikimapia_error` kind), i.e. `Wikimapia reported an error: Invalid API key.`. `unexpected_response` keeps `direct.message`.
   - "uses only the Client's failure message, never wikimapiaMessage or issues" (~233): rename it. The `wikimapia_error` part now expects `Wikimapia answered with an error: RAW-WIKIMAPIA-TEXT`. The `unexpected_response` part is unchanged and still proves that `issues` never appear.
7. Wikimapia Error message rules: a multi-line or tab-separated `wikimapiaMessage` gives one line with single spaces, trimmed. A blank or whitespace-only `wikimapiaMessage` gives exactly the bare Client `message`. A redacted text (e.g. `Key [key removed] is not valid`) is copied as is. The Gateway is not stopped.

**B. `tests/crawl/gateway.test.ts`** (`stop` describe)

1. `stop('quota_exhausted', 'm', 'w')` gives `stopped` deep-equal `{ reason: 'quota_exhausted', message: 'm', wikimapiaMessage: 'w' }`.
2. First stop wins with its `wikimapiaMessage`: a later `stop` with a different message or Wikimapia text changes nothing. A first stop without a Wikimapia text is not completed by a later one.
3. Absent arguments are absent keys, not `undefined` (`Object.keys` check): `stop('interrupted')` gives `{ reason }` only; `stop('failed', 'm')` gives no `wikimapiaMessage` key. An empty string `wikimapiaMessage` is kept as `''`.
4. A stopped Gateway refuses further requests after a `quota_exhausted` stop (no transport call).

**C. `tests/crawl/report.test.ts`**

1. Fix the `AC51_COUNTS` literal (line 38): add `placesParkedThisRun: 0`, `placesParked: 0`, `placesReleased: 0`. Extend `ZERO_EXTRA`, `ac51Snapshot` and every other `snapshot` call with `placesParked` and `placesReleased` (0 unless the case says otherwise). Extend `expectedLines` with the three parking lines after the per-kind lines, in `SUMMARY_LABELS` order, so the existing "gives exactly the lines ... in order" case pins the new layout. The two known failures must pass without weakening them.
2. Tally parking: a fresh tally has `parkedThisRun` 0. Each `placeParked()` adds 1. `snapshot` writes `placesParkedThisRun = parkedThisRun` and copies `placesParked` and `placesReleased` from `extra`. Every snapshot passes `RunCountsSchema`, including a case with `placesParkedThisRun === placesParked` and one with `placesParked` larger.
3. `oneLine`: whitespace runs (spaces, tabs, `\n`, `\r\n`) become one space, the result is trimmed, `''` and whitespace-only give `''`.
4. `formatSummaryText(summary)` for every outcome other than `quota_exhausted`: no `Wikimapia message` line, even when notes with a message are passed. For `quota_exhausted` without notes, or with notes lacking `wikimapiaMessage`: no such line either.
5. `formatSummaryText(quotaSummary, { wikimapiaMessage: 'Key limit has been reached' })`: the last four lines are exactly the three parking lines and `Wikimapia message: Key limit has been reached`. A blank or whitespace-only message gives `Wikimapia message: (empty)`. A multi-line message gives one line. Every line of every case matches `LINE_PATTERN`.
6. `buildReport` with outcome `quota_exhausted`, a message and `wikimapiaMessage`: passes `RunReportSchema`, keeps the message, `summaryText` equals `formatSummaryText(report.summary, { wikimapiaMessage })` and contains the Wikimapia line. With another outcome and a `wikimapiaMessage`, `summaryText` has no Wikimapia line. `buildReport` never adds a `wikimapiaMessage` key to the report object (the contract report has none).
7. `plannedReport(plan, at, n)` passes `RunReportSchema`, has `parkedPlacesInRegion: n` (also for `n = 0`) and zero counts. `plannedReport(plan, at)` has no `parkedPlacesInRegion` key. `buildReport` with `parkedPlacesInRegion` and a non-Planned outcome fails the gate and becomes the internal-error failed report.
8. `failedReport` and `plannedReport` show `0` on each of the three parking lines (AC-39 pure side).

Run the new and changed files once and confirm that the new cases fail only because the implementation is missing. Do not stub production modules.

### 2.2 add-coder

Implement exactly AL4 1.4.3 (the `requests.ts` and `gateway.ts` parts), 1.4.10 (without the "Command output" paragraph) and the U5 rows of 1.1 and 1.3. Use only contract labels and constants; never retype a label text.

1. **`src/crawl/types.ts`.** `Stop` gains `wikimapiaMessage?: string`. `Gateway.stop(reason, message?, wikimapiaMessage?)`. `Tally` gains `placeParked(): void` and `readonly parkedThisRun: number`, and `snapshot`'s `extra` becomes `{ tilesUnfinished; placesStillDue; placesParked; placesReleased }` (all `number`). Add `SummaryNotes { wikimapiaMessage?: string }`. `StopReason` stays `Exclude<RunOutcome, 'completed' | 'planned'>` (it now includes `quota_exhausted` automatically). Update the stale comment on `StopReason`. Do **not** add `ResolvedRun.retryParked` or `DetailsPhaseResult` (U6).
2. **`src/crawl/gateway.ts`.** `stop(reason, message?, wikimapiaMessage?)`: first stop wins, as now. Build the `Stop` with conditional spreads, so absent arguments are absent keys (`exactOptionalPropertyTypes`). Nothing else changes.
3. **`src/crawl/report.ts`.**
   - Export `oneLine(text)`: whitespace runs to one space, trimmed.
   - `createTally`: `placeParked()` increments `parkedThisRun` (getter). `snapshot` sets `placesParkedThisRun = parkedThisRun`, `placesParked = extra.placesParked`, `placesReleased = extra.placesReleased`.
   - `formatSummaryText(summary, notes?)`: after the per-kind Item Failure lines, append the three parking lines with `SUMMARY_LABELS.placesParkedThisRun`, `.placesParked`, `.placesReleased`. Then, only when `summary.outcome === 'quota_exhausted'` and `notes?.wikimapiaMessage !== undefined`, append `${SUMMARY_LABELS.wikimapiaMessage}: <value>`, where the value is `oneLine(text)`, or `(empty)` when that is `''` (use an explicit `=== ''` check so ESLint's `prefer-nullish-coalescing` / `strict-boolean-expressions` rules stay quiet).
   - `buildReport` input gains `wikimapiaMessage?: string` and `parkedPlacesInRegion?: number`. It passes `{ wikimapiaMessage }` to `formatSummaryText` only for `quota_exhausted` with a given message, and sets `parkedPlacesInRegion` on the report by conditional spread only when given. The gate stays `RunReportSchema`; a gate failure still yields the internal-error failed report.
   - `plannedReport(plan, at, parkedPlacesInRegion?)` forwards the count by conditional spread.
   - `failedReport` keeps zero counts (its summary now shows the three lines with 0).
4. **`src/crawl/requests.ts`.**
   - New case `'key_quota_exhausted'`, placed with the stopping kinds: `gateway.stop('quota_exhausted', failure.message, failure.wikimapiaMessage)`, return `STOPPED`. No wait, no further call. The `never` default stays.
   - Split `'wikimapia_error'` out of the shared case: message = `failure.message` when `oneLine(failure.wikimapiaMessage) === ''`, otherwise `${failure.message}: ${oneLine(failure.wikimapiaMessage)}`. Import `oneLine` from `./report`. `unexpected_response` and `invalid_request` keep the bare `failure.message`; never copy `issues`.
   - Update the file's header comment, which still says Wikimapia's raw text is never passed on: it now says the Client-redacted `wikimapiaMessage` is passed on for Wikimapia Errors and Key Quota stops (AL4 0.1 "Item Failure messages").
5. Do not change the progress line: `run-crawl.ts` already prints `Stopping: ${OUTCOME_LABELS[reason]}`, which gives `Stopping: Quota Exhausted`.
6. **Single permitted edit outside the four files:** in `src/crawl/run-crawl.ts`, the local `snapshot` closure (~102-106) must satisfy the widened `Tally.snapshot` signature. Add `placesParked: tally.parkedThisRun` and `placesReleased: started.placesReleased` to the `extra` object. This keeps today's behaviour (nothing calls `placeParked` before U6, and the refine holds) and matches AL4 1.2's interim heartbeat values. Make no other change in `run-crawl.ts`: no `wikimapiaMessage` forwarding to `buildReport`, no `regionTotals`, no change to `retryParked: false` or `countPlacesDue` (all U6).
7. Do not change `listing-phase.ts`, `details-phase.ts`, `config.ts`, `command.ts`, `src/wikimapia/`, `src/db/`, `scripts/` or `package.json`. If any of them stops compiling because of the type changes, stop and report it.
8. **Stop and report, do not work around:** a contract type or test that contradicts AL4 1.4.3 or 1.4.10; an existing `tests/crawl` or `contracts/hydration.test.ts` case that pins the old Wikimapia Error item message or the old summary layout other than the ones listed in 2.1 A.6 and C.1.
9. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. **Use the Test Database only.** Do not migrate or write to the Development Database, and never set `DATABASE_URL`.

Before you change any file, record two baselines: `pnpm exec vitest run --no-color tests/crawl` (only the 2 known `tests/crawl/report.test.ts` failures are expected) and `pnpm exec vitest run --no-color contracts/hydration.test.ts` (note the failing test names; they belong to U6).

1. `pnpm exec vitest run --no-color tests/crawl/report.test.ts tests/crawl/requests.test.ts tests/crawl/gateway.test.ts contracts/hydration.schema.test.ts` passes (no failures, no skipped or todo tests).
2. `pnpm exec vitest run --no-color tests` passes (all of `tests/`, including `tests/crawl/*.db.test.ts` and `tests/db`).
3. Contract regression: `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
4. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-([1-5]|[7-9]|1[0-4]|41 .*the newest step|39 .*a Dry Run shows 0) "` passes (the U1 and U2 cases stay green, and the AC-39 Dry Run case turns green). The other AC-15 .. AC-39 Run cases need U6 and stay red. That is expected.
5. `pnpm exec vitest run --no-color contracts/hydration.test.ts -t "^AC-(2[89]|3[0-4]|5[5-7]) "` passes. The full `contracts/hydration.test.ts` run shows no failure beyond its baseline (in particular, AC-54 is no worse than before).
6. `pnpm exec eslint src/crawl tests/crawl` reports no problems.
7. `pnpm exec tsc --noEmit` reports **0 errors** (the `requests.ts:65` and `report.test.ts:38` errors are gone, and no new one appears).
8. Guards. Each of these returns nothing (or `False` for the line-ending check):
   - `Select-String -Path src/crawl/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/crawl/report.ts, src/crawl/requests.ts -Pattern "'Places parked|'Wikimapia message|'Quota Exhausted"` (labels come only from `SUMMARY_LABELS` / `OUTCOME_LABELS`)
   - `Select-String -Path src/crawl/requests.ts -Pattern "failure\.issues"`
   - Line endings: `foreach ($f in 'src/crawl/types.ts','src/crawl/gateway.ts','src/crawl/requests.ts','src/crawl/report.ts','src/crawl/run-crawl.ts','tests/crawl/report.test.ts','tests/crawl/requests.test.ts','tests/crawl/gateway.test.ts') { "$f " + ((Get-Content -Raw $f) -match "`r") }` prints `False` for every file.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`, the `*.support.ts` files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test or existing `tests/` case. The only existing expectations you may change are the ones listed in 2.1 A.6 (the Wikimapia Error item message) and 2.1 C.1 (the three parking counts and lines).
- Files you may change: `src/crawl/types.ts`, `src/crawl/gateway.ts`, `src/crawl/requests.ts`, `src/crawl/report.ts`, `src/crawl/run-crawl.ts` (only the edit in 2.2 step 6), and the tests `tests/crawl/report.test.ts`, `tests/crawl/requests.test.ts`, `tests/crawl/gateway.test.ts`. Nothing else.
- Keep LF line endings in every file you touch.
- Use the Test Database only. Never migrate or write the Development Database, and never set `DATABASE_URL`.
- Never open, write or print `.env`. Never put a real API key, password or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.
- If a contract, the AL4 spec or this prompt looks wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing).

## 4. Out of Scope

Do not implement any of the following now:

- **U6:** `concludeItemFailure` (`src/crawl/failures.ts`) and the phases' use of `recordItemFailure`, `listParkedPlaces` and `tally.placeParked()`; `ResolvedRun.retryParked`, `DetailsPhaseResult` and `parkedAtStart`; passing `run.retryParked` to `beginRun`; the `Explicit retry: released ...` progress line; end-of-run `regionTotals` with its fallback and the final `placesParked` / `placesStillDue`; heartbeat counts beyond the step 6 edit; forwarding `stopped.wikimapiaMessage` from `run-crawl.ts` to `buildReport`; the Dry Run with `--retry-parked` (`plannedReport(..., n)` call site); removing the repository `countPlacesDue` adapter; turning the AC-15 .. AC-39 Run cases green end to end.
- **U7:** the `--retry-parked` command flag, the usage message, the Dry Run `Parked places that --retry-parked would release: n` output line in `command.ts`, the quota exit code check through the command, and the whole-suite / `pnpm lint` check.
- Anything in `src/wikimapia/` (U1, done) or `src/db/` (U2 .. U4, done).
- Any Development Database migration or write.
