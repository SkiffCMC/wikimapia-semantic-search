# AL3 Routing: hydration, U6 "The Run: `runCrawl` with Listing and Details Phases"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U6 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md`, section "4. Implementation Units", "U6" (spec revision 2: in 1.3 `BeginRunValue.pass` is optional, and the key is omitted for a complete pass. The Run-wide write-hook counter lives in `src/db/crawl-repository.ts`. `runCrawl` passes `deps.onWrite` unchanged and adds no counter, as 1.4.9 says.)
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **Done and verified:**
  - U1: Crawl Progress schema step, `undoLast`, `emptyStore`.
  - U2: `src/crawl/types.ts`, `tile-plan.ts`, `config.ts` (including `MISSING_API_KEY_MESSAGE`) and `report.ts`.
  - U3: the Crawl Store read side, including `readCurrentPass`.
  - U4: `src/db/crawl-repository.ts`, with `beginRun`, `renewActivity`, `recordListingPage`, `saveDetails`, `listPlacesDue`, `countPlacesDue`, `finishRun` and the Run-wide hook.
  - U5: `src/crawl/gateway.ts`, `requests.ts` and `runtime.ts`.
- **Baseline:**
  - `pnpm exec tsc --noEmit` reports exactly 2 TS2307 errors, both in `contracts/hydration.test.ts`: one for `src/crawl/command` and one for `src/crawl/run-crawl`.
  - `pnpm exec eslint src tests` is clean.
  - 1573 tests pass.
- **What this unit adds:** the orchestration of AL4 "1.2 Run flow", in three modules:
  - `listing-phase.ts`, for the Listing Phase over the current pass;
  - `details-phase.ts`, for the Details Phase over the Places Due for Details;
  - the public `run-crawl.ts`, which handles resolution, Dry Run, the key check, the start step, the Gateway with its real heartbeat, both phases, the end, the report and pool cleanup.

  After this unit, only the `src/crawl/command` TS2307 error remains.
- **What this unit does not touch:** `src/db/` and the U2/U5 modules. It only calls them. Every building block already exists, so this unit is wiring.
- **The contract file cannot load yet.** `contracts/hydration.test.ts` also imports `src/crawl/command` (U7), so it cannot be run as-is. This unit therefore has two gates:
  - the unit tests in `tests/crawl/run-crawl.db.test.ts`, which are binding;
  - a temporary contract preview (section 2.3, step 4). It loads the contract file through a throwaway Vitest config **outside the repository**, with the `command` import aliased to a throwaway stub. It touches nothing in `contracts/`, `src/` or the repo config.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:

- Node ESM; TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Top-level `import type`. Relative imports have no file extension.
- `unknown` only for caught errors.
- Every type alias or interface declared in `src/crawl/` goes in `src/crawl/types.ts`.
- No `console`. Vitest globals are on.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 1 (resumable, idempotent), 3 (no SQL outside `src/db/`), 4 (no secrets, no live calls) and 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read in full: **"1.2 Run flow"**, **"1.4.6 Listing Phase"** (the `runListingPhase` block and the bullets after it), **"1.4.7 Details Phase"** (the `runDetailsPhase` block and the last paragraph), **"1.4.8 Run end, Run Summary, report"** (including "Progress lines"), **"1.4.9 Write hook and store failures"**, and "4. Implementation Units", "U6".<br>Read in part:<br>- "0. Scope and Fixed Points": the table, "Approved contract decisions", "Single source of truth", "Code style";<br>- "1.1 Module map": the crawl-side rows;<br>- "1.3 Component contracts": the `Tally`, `PassCursor` and `RunContext` lines; the `runListingPhase`, `runDetailsPhase` and `runCrawl` lines; the `src/db/types.ts` block from `BeginRunInput` to `CrawlRepository`;<br>- "1.4.3 Gateway": only the `renewIfDue` lines and the "Last Activity guarantee" bullet;<br>- "1.4.5 Run start": the `abandonBefore` formula and the bullets;<br>- "1.5 Transaction boundaries" (the table);<br>- "5. AL2 Guidance" (all bullets). |
| 4 | `contracts/hydration.schema.ts` | Lines 100 to 157 (constants, `toMoment`, `RunIdSchema`). Lines 346 to 657: `CrawlRequest`, `CrawlClock`, **`CrawlDependencies` (read its doc comment)**, `RunOutcome`, `ItemFailureKind`, `RunCounts`, `ZERO_RUN_COUNTS`, `RunSummary`, labels, `FailedItem`, `RunReportSchema` and its refinements, `RunCrawlFn`. Lines 715 to 740 (`PlacesDueInput`, `DuePlace`). |
| 5 | `contracts/storage.schema.ts` | Only `WriteHook`, `SaveReport` (its `places[].outcome`), `SavePlaceDetailsInput` and `StoreFailure`. Use Grep to find them. |
| 6 | `contracts/wikimapia-client.schema.ts` | Lines 78 to 106 (`WikimapiaTransport`, `Clock`, `WikimapiaClientOptions`) and lines 420 to 445 (`WikimapiaClient`). |
| 7 | `contracts/hydration.support.ts` | Lines 36 to 315: Simulated Clock, `Gate`, `CrawlWikimapia`, `UNREACHABLE`, `Script`, `scripted`. Lines 317 to 515: answers, `REGION_T1`/`T2`/`T4`/`FAR` with their tiles, `testConfiguration`, `syntheticPlacesIn`, `settle`. |
| 8 | `contracts/storage.support.ts` | Lines 46 to 91 (`requireTestDatabaseUrl`, `UNREACHABLE_PASSWORD`, `UNREACHABLE_DATABASE_URL`) and lines 106 to 130 (`clientListing`, `summaryOf`). |
| 9 | `contracts/hydration.test.ts` | Read only. **Do not edit it.** Read these ranges:<br>- 144 to 472: harness helpers, the model for the unit test harness;<br>- 751 to 1112 (AC-11 to AC-25);<br>- 1179 to 1200 (AC-28, AC-29);<br>- 1351 to 1430 (AC-36 to AC-38);<br>- 1485 to 1596 (AC-41 to AC-44);<br>- 1620 to 1730 (AC-46 to AC-48);<br>- 1766 to 1870 (AC-50 to AC-53);<br>- 2127 to 2239 (AC-62, AC-69, AC-70).<br>Run it only through the preview harness in 2.3. |
| 10 | `src/crawl/types.ts` | The file to extend. `Tally`, `Gateway`, `Stop` and the other types already exist. Do not duplicate them. |
| 11 | `src/crawl/config.ts` | Exports `resolveRun`, `isMissingApiKey` and `MISSING_API_KEY_MESSAGE`. Use them; do not re-implement them. |
| 12 | `src/crawl/report.ts` | `createTally`, `buildReport` (it gates with `RunReportSchema` itself), `failedReport`, `plannedReport`. |
| 13 | `src/crawl/gateway.ts`, `src/crawl/requests.ts`, `src/crawl/runtime.ts` | `createGateway`, `requestWithBackoff`, `createSystemCrawlClock`, `defaultTransport`. |
| 14 | `src/db/crawl-repository.ts` | `openCrawlRepository` (read in full). It owns `runWideHook`. |
| 15 | `src/db/types.ts` | Lines 198 to 287: `PassState`, `DueQuery`, `BeginRunInput`, `BeginRunValue`, `RenewInput`, `ListingStepInput`, `ListingStepValue`, `FinalRunStatus`, `FinishInput`, `CrawlRepositoryOptions`, `CrawlRepository`. |
| 16 | `src/wikimapia/client.ts` | Only line 109 and the lines after it, for the `createWikimapiaClient` signature. |
| 17 | `tests/db/crawl-repository.db.test.ts` | Lines 1 to 220 only. They show the Test Database lifecycle (`requireTestDatabaseUrl`, Schema Setup `apply` in `beforeAll`, `emptyStore` in `beforeEach`, closing in `afterAll`) and a local `testDb()` Knex handle. |
| 18 | `vitest.config.ts` | Needed only for the preview harness in 2.3. |

Do not read the rest of `src/db/` or `src/wikimapia/`, or the AL6/AL7 documents.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. Use only `TEST_API_KEY` from the support files.

## 2. Execution Directives

### 2.1 add-test-writer

Write one new file, `tests/crawl/run-crawl.db.test.ts`. It needs the Test Database (`pnpm db:up`, `.env.test`). Follow the lifecycle of `tests/db/crawl-repository.db.test.ts`:

- `beforeAll`: stub global `fetch` with a rejecting spy, `requireTestDatabaseUrl()`, then `createSchemaSetup(...).apply()`.
- `beforeEach`: `emptyStore()`.
- `afterAll`: close every handle and unstub the globals.

Call `runCrawl` with:

- `SimulatedCrawlClock`;
- `CrawlWikimapia.transport` with `scripted(...)`;
- `testConfiguration(...)`;
- `TEST_API_KEY`.

Model a small local `crawl(...)` helper on the contract's `startCrawl`/`crawl`. Parse every report with `RunReportSchema`. Read state only through public APIs:

- `createCrawlStore(...).readCrawlProgress` and `listPlacesDueForDetails`;
- `createPlaceStore(...).countStored` and `readPlace`.

The single exception is the `pg_stat_activity` query in group E, which uses a local `testDb()` Knex handle. Use synthetic data and the recorded fixtures through support helpers only. These tests are a small subset; the contract file is the full net. Do not copy contract tests wholesale.

**A. Pre-start paths** (AL4 1.2 steps 1 to 3; AC-5 to AC-10, AC-48, AC-60)

1. An unknown Region gives `failed`. The message names the Region and the known names. No `runId`, 0 calls, and the Crawl Progress of the test Regions stays empty.
2. A missing `regionName` gives `failed` with a usage message that contains `--region`. `summary.regionName` is absent.
3. An invalid override (`requestBudget: -3`) gives `failed` naming `requestBudget`. The database is untouched.
4. A Dry Run with `connectionString: UNREACHABLE_DATABASE_URL` and no `apiKey` gives `planned`, with `plan` equal to `planTiles(region)`, zero counts and 0 calls.
5. `apiKey` absent, `''` and `' \t '` each give `failed` with exactly `MISSING_API_KEY_MESSAGE`, 0 calls, and no Run Record.
6. An unreachable store (`UNREACHABLE_DATABASE_URL`, valid key) gives `failed`, no `runId`, 0 calls, and the report text has no `postgres://` and no `UNREACHABLE_PASSWORD`.

**B. Start step outcomes** (AL4 1.4.5; AC-24, AC-25, AC-53, AC-62, AC-69)

1. **Budget 0:** `budget_reached`, a `runId` present, 0 requests. `readCrawlProgress` shows one Run Record with that status.
2. **Interrupted before start** (signal already aborted): `interrupted`, a `runId` present, 0 calls. The Run Record is kept.
3. **Gated first Run** (use `Gate`). A second Run for the same Region, on a clock `ABANDONMENT_AGE_SECONDS` later, gives `failed`. Its message matches `/already in progress/i`, it makes 0 calls, and Crawl Progress is unchanged. A Run for `REGION_FAR` meanwhile gives `completed`. Opening the gate lets the first Run end `completed`.
4. **Takeover.** A gated, aborted zombie Run is taken over by a Run at `silentSince + ABANDONMENT_AGE_SECONDS + 1 s`. That Run lists tile 1 page 1 and gives `completed`. The zombie's record is `abandoned` with its counts kept. The progress lines contain `Marked run <zombie id> as abandoned`. Clean up the zombie afterwards, as AC-69 does.
5. **Region definition changed.** An incomplete pass of `REGION_T2` followed by a changed `tileSize` gives `failed`, matching `/changed/i` and `/relist|new listing pass/i`, with 0 calls. With `relist: true`, the same Run starts pass 2.
6. **Complete pass.** A complete pass without `relist`, with no Places due, sends 0 requests and gives `completed` with `tilesUnfinished` 0.

**C. Phases and counts** (AL4 1.4.6, 1.4.7, 1.4.8; AC-11 to AC-19, AC-28, AC-33, AC-36, AC-51)

1. **The AC-51 scenario.** Use `REGION_T1`, `belgradePage1()`, details 1381893 OK, 62587 with `rateLimitAnswer(7)` and then OK, and 164369 with a Wikimapia Error. The report must have exactly the AC-51 counts of the contract (lines 1801 to 1830) and outcome `completed`. Exactly one `itemFailures` entry is `{ kind: 'place_details', placeId: 164369 }`, and its message starts with `Place 164369: `.
2. **Paging.** Use `listingPageSize: 3` and pages of 3, 3 and 1 Places. Calls are pages 1, 2, 3 of tile 1. The Finished Pages are 1 to 3, and the tile is finished.
3. **Listing Item Failure.** A tile whose page is `wikimapiaErrorAnswer()` produces one item failure `{ kind: 'listing_page', tileNumber, page: 1 }` with message prefix `Tile <n> page 1: `. The next tile is still listed and the Details Phase still runs (AC-19). `tilesUnfinished` counts the failed tile.
4. **Details Fetched At** is the receive moment after a 5 s Rate-Limit Wait (AC-29), read back through `readPlace`.
5. **Progress lines.** They contain `Run <id> started for region <name>`, `Tile 1 page 1: <k> places saved, tile finished`, `Place <id>: details saved (created)` and `Item failure: ...`. A stopped Run also gets `Stopping: <OUTCOME_LABELS[outcome]>`.

**D. Stops and store failures** (AL4 1.4.9; AC-14, AC-41, AC-44, AC-46, AC-47)

1. **Budget 3 over a 4-tile Region** gives `budget_reached` with 3 requests. A second Run resumes where the first stopped and asks no Finished Page again.
2. **Rate Limit Exhausted on a listing page** gives `rate_limited`. That page is neither saved nor finished, and the next Run asks it first.
3. **`onWrite` that throws on write 1** gives `failed`, no `runId`, nothing stored, and no Run Record.
4. **Run-wide numbering.** Over the AC-51 scenario, a recording `onWrite` sees exactly `1, 2, ..., N` with no gaps or repeats, across the start step, the listing step, Details Saves and finish. This proves the Run passes the hook once, unchanged.
5. **`onWrite` fails mid-Run** (AC-47 first case): `failed`, exactly 2 calls, Finished Pages `['tile 1 page 1']`, 3 Places stored. The report and progress lines have no `postgres://` and no password.
6. **For each write number `k` of the paging scenario** (AC-14 subset): with the hook throwing at `k`, a page is stored exactly when its Finished Page exists. Empty the database between iterations.
7. **Abort from inside an answer's `effect`** gives `interrupted` with no further request. The page in hand is either both saved and finished or neither.

**E. Resources and secrets**

1. **No pool leak.** Run 30 non-dry Runs in a loop, for example `REGION_T1` with an empty listing. Before and after, count `select count(*) from pg_stat_activity where datname = current_database()` through the test's own `testDb()` handle. The count after is at most the count before plus 2. Give this test a 120 s timeout.
2. **No secrets.** Across the reports, progress lines and `JSON.stringify(readCrawlProgress(...))` of a Run with `UNREACHABLE` details, a Wikimapia Error and the fallback rate limit, none of these appear: `TEST_API_KEY`, `/[?&]key=/`, `postgres://`, `UNREACHABLE_PASSWORD`.

The new tests are expected to fail until `add-coder` has finished. Do not stub production modules. Do not create a `src/db` helper for the `pg_stat_activity` query.

### 2.2 add-coder

1. **`src/crawl/types.ts`** (extend). Add `PassCursor` and `RunContext` exactly as in AL4 1.3.
   - Import `WikimapiaClient` from `../../contracts/wikimapia-client.schema` and `CrawlRepository` from `../db/types`, both with `import type`.
   - Change no existing type. Update the header comment.

2. **`src/crawl/listing-phase.ts`** (new). Write `runListingPhase(ctx, pass)` exactly as the AL4 1.4.6 `runListingPhase` block describes:
   - Walk the tiles in Tile Number order. Skip finished tiles. Start at `lastFinishedPage + 1`.
   - Check `gateway.stopped` before every request.
   - Make each request through `requestWithBackoff(ctx.gateway, 'listing', ctx.signal, () => ctx.client.listPlaces({ bbox, page, pageSize }))`.
   - A page is short when it has fewer Places than `listingPageSize`.
   - `recordListingPage` takes `finishedAt: toMoment(ctx.clock.now())`.
   - Map the results:

     | Result | Action |
     |---|---|
     | `invalid_data` | Item failure. |
     | `store_unavailable` | `gateway.stop('failed', failure.message)` and return. |
     | `taken_over` | Stop with the 1.4.6 message and return. |
     | `saved` | Call `tally.pageSaved(ids, created count, short)` and update the cursor. |

   - The created count is the number of `report.places` with outcome `created`.
   - Item failure messages are `Tile ${n} page ${p}: ${message}`.
   - Progress lines are `Tile <n> page <p>: <k> places saved[, tile finished]` and `Item failure: <message>`.
   - Use `String(...)` for numbers in templates where lint requires it.

3. **`src/crawl/details-phase.ts`** (new). Write `runDetailsPhase(ctx)` exactly as the AL4 1.4.7 block describes:
   - Use `ctx.dueBefore`.
   - The limit is `Math.max(1, requestBudget - gateway.requestsSent + 1)`.
   - If `listPlacesDue` fails, call `gateway.stop('failed', failure.message)` and return `{ dueLoaded: 0 }`.
   - Process the Places in the order returned.
   - `fetchedAt` is `toMoment(ctx.clock.now())`, taken after the request resolves.
   - Count a save as changed when its outcome is `created` or `updated`. Deleted Places count as saved.
   - On `invalid_data`, record an item failure with the 1.4.7 message. On `store_unavailable`, stop `failed` and break.
   - Progress lines are `Place <id>: details saved (<outcome>)` and `Item failure: ...`.
   - Return `{ dueLoaded: due.length }`.

4. **`src/crawl/run-crawl.ts`** (new). Export `runCrawl: RunCrawlFn` and follow AL4 1.2 step by step. The whole body sits inside an outer `try/catch`; a caught error gives `failedReport('Crawl failed: internal error', regionName, toMoment(clock.now()))` and never rejects.
   1. **Setup.** `clock = deps.clock ?? createSystemCrawlClock(deps.signal)`, `transport = deps.transport ?? defaultTransport()`. Then `startMs` and `startedAt = toMoment(new Date(startMs))`. `progress` calls `deps.onProgress` when it is given.
   2. **Resolve.** Call `resolveRun(request, deps.configuration ?? DEFAULT_CRAWL_CONFIGURATION)`. On failure return `failedReport(message, regionName, startedAt)`.
   3. **Dry Run.** Return `plannedReport(plan, startedAt)`. No database and no key check.
   4. **Key check.** If `isMissingApiKey(deps.apiKey)`, return `failedReport(MISSING_API_KEY_MESSAGE, regionName, startedAt)`.
   5. **Open the repository.** `repo = openCrawlRepository({ connectionString: deps.connectionString, ...(deps.onWrite === undefined ? {} : { onWrite: deps.onWrite }) })`. **Pass the hook unchanged. Do not wrap it, and add no counter (AL4 1.4.9).** Everything after this point runs inside `try { ... } finally { await repo.close(); }`.
   6. **Start the Run.** Call `repo.beginRun` with:
      - the region's `bbox` and `tileSize`, and `tileCount = plan.tiles.length`;
      - `relist`, `startedAt`;
      - `abandonBefore` from the AL4 1.4.5 formula with `ABANDONMENT_AGE_SECONDS`;
      - `counts: ZERO_RUN_COUNTS`.

      Handle the results:

      | Result | Report |
      |---|---|
      | Store failure | `failedReport(failure.message, ...)`, no `runId`. |
      | `run_in_progress` | Failed. The message contains "already in progress" and names the Region. It may state the Last Activity moment. |
      | `region_changed` | Failed. The message says the Region definition changed since the incomplete Listing Pass and hints to rerun with `--relist` to start a new listing pass. |
      | `started` | Emit `Marked run <id> as abandoned` for each `abandonedRunIds` entry, then `Run <id> started for region <name>`, with ` (pass <p>, <k> of <n> tiles finished)` when `pass` is present. |

      The two failed messages must match AC-62 and AC-25.
   7. **Build the pass cursor and the Gateway.**
      - `PassCursor` comes from `PassState`: a Set of finished tiles and a Map from `lastFinishedPage`.
      - `dueBefore` is computed as in AL4 1.4.7.
      - `tally = createTally()`.
      - `createGateway({ transport, clock, signal: deps.signal, minRequestIntervalSeconds, requestBudget, heartbeat, lastRenewalMs: startMs })`.
      - `heartbeat` calls `repo.renewActivity({ runId, at: toMoment(clock.now()), counts: tally.snapshot(gateway.counts(), { tilesUnfinished: <current cursor value or 0>, placesStillDue: 0 }) })`. The real `placesStillDue` is only computed at Run end (1.4.8).
        - Store failure: `{ ok: false, message: failure.message }`.
        - `alive: false`: `{ ok: false, message: <the 1.4.6 taken-over message> }`.
        - Otherwise `{ ok: true }`.
      - `client = createWikimapiaClient({ apiKey, transport: gateway.transport, clock: gateway.clock })`.
      - If `deps.signal?.aborted`, call `gateway.stop('interrupted')`.
   8. **Run the phases.** If `pass` is present and the Gateway is not stopped, call `runListingPhase`. Then, if not stopped, call `runDetailsPhase` and keep `dueLoaded`.
   9. **End the Run.** Follow AL4 1.4.8:
      - `outcome = gateway.stopped?.reason ?? 'completed'`.
      - If the Gateway stopped, emit `Stopping: <OUTCOME_LABELS[outcome]>`.
      - `tilesUnfinished` and `placesStillDue` come from `countPlacesDue`, with the estimate as fallback.
      - Build `counts` from `tally.snapshot`.
      - Call `finishRun({ runId, status: outcome, endedAt, counts })`. On a store failure, the outcome becomes `failed` with that message, and one best-effort `finishRun` with `failed` follows; ignore its result. `updated: false` leaves the outcome unchanged.
   10. **Return** `buildReport({ outcome, message: stop message (or the finish failure message), regionName, startedAt, endedAt, counts, failures: tally.failures, runId })`. Use conditional spreads for every optional key.
   - **Constraints:**
     - No transaction or DB call is held across a request or a wait.
     - No `new Date()` without an argument.
     - No SQL.
     - Never copy an error's `.message` into the report or progress lines; only store failures' and the Client's own messages.
     - Exhaustive `switch` on `BeginRunValue.kind`, with a `never` default.

5. **Do not change:**
   - `src/db/`, `src/wikimapia/`, or the U2/U5 modules (`tile-plan.ts`, `config.ts`, `report.ts`, `gateway.ts`, `requests.ts`, `runtime.ts`);
   - `scripts/`, `package.json`, `vitest.config.ts`, `tsconfig.json`, or existing tests.

   Do not create `src/crawl/command.ts`, not even as a stub.

6. **Stop and report, do not work around,** if:
   - a repository method or a U2/U5 export lacks something the flow needs;
   - the AC-51 counts cannot be reached with `tally.snapshot` as it is;
   - the preview harness shows a contract test outside the expected-failure list that fails because the contract and AL4 disagree.

7. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker and the Test Database must be up (`pnpm db:up`, `.env.test`).

1. `pnpm exec vitest run --no-color tests/crawl tests/db` passes, with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts tests` passes.
3. `pnpm exec eslint src tests` reports no problems. `pnpm exec tsc --noEmit` reports **exactly 1 error**: TS2307 in `contracts/hydration.test.ts` for `../src/crawl/command`. The `run-crawl` error is gone and no new error appears.
4. **Contract preview** (temporary; nothing inside the repo is created or changed):
   - **Set up.** Create a directory `$env:TEMP\add-hydration-u6-preview\` with two throwaway files:
     - `command-stub.ts` exports `runCrawlCommand`, which returns a rejected promise (`'runCrawlCommand arrives in U7'`).
     - `vitest.preview.config.ts` imports the repo's `vitest.config.ts` by absolute path and re-exports it with two additions: `root` set to the repo path, and `resolve.alias` mapping the exact specifier `../src/crawl/command` (anchored regex) to the stub's absolute path.
   - **Run.** `pnpm exec vitest run --no-color --config "$env:TEMP\add-hydration-u6-preview\vitest.preview.config.ts" contracts/hydration.test.ts`
   - **Expected failures.** These are exactly the tests that call `runCommand` or check the `crawl` script, all of them U7. Nothing else may fail:
     - AC-45 (1 test);
     - AC-47 "an unreachable Place Store ..." (it reaches `runCommand` after the `runCrawl` part, so check in the output that its failure comes from the stub);
     - AC-49 (same check);
     - AC-59 (4 tests);
     - AC-60 (1 test);
     - AC-61 (1 test).
   - **Every other test must pass.** Report the pass/fail totals and the names of any failing tests.
   - **Tooling problems.** If the harness cannot load the file for a tooling reason (not an assertion), report the exact error and do not change any repo file to fix it. Gates 1 to 3 then decide alone.
   - **Clean up.** Delete `$env:TEMP\add-hydration-u6-preview\` afterwards.
5. Guards. Each of these returns nothing:
   - `Select-String -Path src/crawl/listing-phase.ts, src/crawl/details-phase.ts, src/crawl/run-crawl.ts, src/crawl/types.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|\.js'|new Date\(\)|from 'knex'|from 'pg'|\.raw\("`
   - `Select-String -Path src/crawl/run-crawl.ts -Pattern "onWrite\(|\+= 1"` (no second write counter; `deps.onWrite` is only passed through)
   - `Select-String -Path src/crawl/listing-phase.ts, src/crawl/details-phase.ts, src/crawl/run-crawl.ts -Pattern "error\.message|String\(error|err\.message|\.url\b"`
   - `Test-Path src/crawl/command.ts` prints `False`.

Do not run `pnpm test:db` or `contracts/hydration.test.ts` directly as a gate. Without the preview harness, the contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
  - Do not skip, weaken or `.todo` any contract test or any existing test.
  - Do not copy or redefine contract schemas, constants or helpers (`toMoment`, `ABANDONMENT_AGE_SECONDS`, `ZERO_RUN_COUNTS`, `RunReportSchema`, `OUTCOME_LABELS`, `Gate`, `scripted`, `testConfiguration`, ...) in `src/` or `tests/`. Import them.
- **The preview harness lives outside the repository only.** Do not add aliases, stubs or configs inside the repo for it, and do not edit `vitest.config.ts`.
- **Frozen modules:** `src/db/` (including the Run-wide counter in `crawl-repository.ts`), `src/wikimapia/`, and the U2/U5 modules in `src/crawl/`.
- **Files you may create or change:** `src/crawl/types.ts`, `src/crawl/listing-phase.ts`, `src/crawl/details-phase.ts`, `src/crawl/run-crawl.ts`, `tests/crawl/run-crawl.db.test.ts`. Nothing else.
- **No live calls.** No test reaches real `fetch` or real long timers.
- **Secrets:** never open, write or print `.env`. Use only `TEST_API_KEY` and the synthetic `UNREACHABLE_*` values.
- **Protected files:** do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U7:**
  - `src/crawl/command.ts` (`parseCrawlArgs`, `runCrawlCommand`, output lines, exit codes);
  - `scripts/crawl.ts`, `.env` loading, SIGINT/SIGTERM wiring;
  - `package.json` (`crawl` script, extended `test:db`);
  - `tests/crawl/command.test.ts`;
  - making `contracts/hydration.test.ts` green as-is;
  - tsc and `pnpm lint` at 0.
- **U1 to U5 (done):** any change to the schema step, the Crawl Store, the crawl repository and its steps, the Gateway, `requestWithBackoff`, the runtime defaults, config resolution, the tally or the report builders.
- **Orchestrator:** recording the AL4 0.1 decisions in `CLAUDE.md`.
