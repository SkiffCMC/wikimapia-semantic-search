# AL3 Routing: hydration, U5 "Gateway, request classification, runtime defaults"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U5 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md`, section "4. Implementation Units", "U5" (spec revision: 1.3 `BeginRunValue.pass` optional; the Run-wide write counter lives in `src/db/crawl-repository.ts`. Neither change affects this unit).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **Done and verified:** U1 (Crawl Progress schema step, `undoLast`, `emptyStore`), U2 (`src/crawl/types.ts`, `tile-plan.ts`, `config.ts`, `report.ts`), U3 (Crawl Store read side), U4 (`src/db/crawl-repository.ts` and the write steps, including `renewActivityStep`).
- **Baseline:**
  - `pnpm exec tsc --noEmit` reports exactly 2 TS2307 errors, both in `contracts/hydration.test.ts`, for `src/crawl/command` and `src/crawl/run-crawl`. Both stay until U6 and U7. Do not create stubs for those modules.
  - `pnpm exec eslint src tests` is clean.
  - 1504 tests pass across `tests/` and the green contract files.
- **What this unit adds:** the I/O layer between the Crawl and the Wikimapia Client. It has three modules:
  - `gateway.ts` wraps the injected transport and clock. It owns pacing, the Request Budget, interrupts, request and Rate-Limit Wait counting, and chunked waits with a Last Activity heartbeat.
  - `requests.ts` makes one Client call with Connection Failure back-off and classifies the result.
  - `runtime.ts` provides the real-time clock and the default transport.
- **What this unit does not touch:** the database. The heartbeat is an injected function. U6 wires it to `repo.renewActivity`. In this unit's tests it is a fake that records its calls.
- **The Client is not changed.** `src/wikimapia/` stays as it is. The Gateway only wraps the `transport` and `clock` that the Client receives.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:

- Node ESM; TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Top-level `import type`. Relative imports have no file extension.
- `unknown` only where `.agrules` 5 allows it.
- Every type alias or interface declared in `src/crawl/` goes in `src/crawl/types.ts`.
- No `console`. Vitest globals are on.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 1 (paced, backs off), 4 (no live calls, no secrets) and 5. |
| 2 | `CLAUDE.md` | Stack, plus the Wikimapia rate-limit notes in "Wikimapia API Reference". Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read only these parts: "0. Scope and Fixed Points" (the "Approved contract decisions" paragraph, "Single source of truth", "Code style"); "1.1 Module map" (rows `runtime.ts`, `gateway.ts`, `requests.ts`); "1.3 Component contracts" (in the `src/crawl/types.ts` block: from `StopReason` to `ClientCall<T>`; in the `src/crawl/*.ts` block: the `createSystemCrawlClock`, `defaultTransport`, `createGateway`, `WAIT_CHUNK_MS`, `RENEW_AFTER_MS` and `requestWithBackoff` lines); **"1.4.3 Gateway"** and **"1.4.4 One Client call"**, both in full; "1.4.9", only bullet 3, last sentence ("Failures raised in a renewal inside the Gateway ..."); "3. Batch & External Calls" (the table); "4. Implementation Units", "U5"; "5. AL2 Guidance" (bullets "Never change the Client", "Never copy error messages", "Moments", "`exactOptionalPropertyTypes`", "Imports", "`unknown`", the last bullet). |
| 4 | `contracts/hydration.schema.ts` | Lines 100 to 130 (`DEFAULT_MIN_REQUEST_INTERVAL_SECONDS`, `DEFAULT_REQUEST_BUDGET`, `CRAWL_QUOTA_SHARE`, `CONNECTION_RETRY_WAITS_SECONDS`, `MAX_HEARTBEAT_INTERVAL_SECONDS`); `CrawlClock` and `CrawlDependencies` (lines 365 to 402, read the `signal` doc); `RunOutcomeSchema`, `ItemFailureKindSchema` (lines 408 to 442); `findPacingIssues` (lines 880 to 910). |
| 5 | `contracts/wikimapia-client.schema.ts` | Lines 78 to 106 (`TransportRequest`, `TransportResponse`, `WikimapiaTransport`, `Clock`, `WikimapiaClientOptions`); lines 355 to 445 (the Client Failure schemas, `ClientFailure`, `WikimapiaClient`, `CreateWikimapiaClientFn`). `DEFAULT_RETRY_LIMIT` and `DEFAULT_FALLBACK_WAIT_SECONDS` (lines 48 to 50). |
| 6 | `contracts/hydration.support.ts` | Lines 36 to 315: `RUN_START`, `SECOND`/`MINUTE`/`HOUR`, `SimulatedCrawlClock` (with `sleeps`, `onSleep` and `advance`), `CrawlWikimapia`, `SimulatedAnswer`, `UNREACHABLE`, `Script` and `scripted`. Lines 340 to 392: `listingAnswer`, `syntheticBoxPlace`, `wikimapiaErrorAnswer`, `unexpectedAnswer`, `rateLimitForever`, `detailsAnswer`. Lines 437 to 445: `SMALL_BBOX`, `REGION_T1`, `T1_TILES`. The re-exports on lines 33 and 34 (`TEST_API_KEY`, `at`, `answer`, `rateLimitAnswer`). |
| 7 | `contracts/hydration.test.ts` | Read only, and only these ranges. They are the end-to-end checks this unit's code must support in U6 and U7: 893 to 948 (AC-17, AC-18), 1430 to 1595 (AC-39 to AC-44, AC-71), 1620 to 1666 (AC-46), 1724 to 1730 (AC-48), 1831 to 1841 (AC-52), 2196 to 2239 (AC-70: note how "silence" is measured at every `sleep`). Do not run this file. |
| 8 | `src/crawl/types.ts` | The file to extend. `StopReason`, `Stop` and `GatewayCounts` already exist. Do not duplicate them. |
| 9 | `src/wikimapia/client.ts` | Read only. `createWikimapiaClient` and the re-exported `createFetchTransport`. |
| 10 | `src/wikimapia/execute.ts` | Read only, lines 46 to 127. This is the Client's retry loop. A transport rejection becomes a redacted `connection` failure. The Client sleeps only when `wait > 0`. `rate_limit_exhausted` comes after `retryLimit + 1` attempts. |
| 11 | `src/wikimapia/runtime.ts` | Read only. The pattern for `runtime.ts`: `createFetchTransport`, and `sleep` built on global `setTimeout` (so Vitest fake timers work) with `MAX_TIMER_DELAY_MS` clamping. |
| 12 | `tests/wikimapia/runtime.test.ts` | Lines 1 to 60 only: the fake-timer and `fetch`-spy pattern for `tests/crawl/runtime.test.ts`. |
| 13 | `tests/crawl/report.test.ts` | Lines 1 to 30 only: the header-comment and import style of `tests/crawl/`. |

Do not read `src/db/`, the other `src/crawl/` modules, or the rest of `src/wikimapia/`. This unit does not need them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. Use only `TEST_API_KEY` from the support file.

## 2. Execution Directives

### 2.1 add-test-writer

Write three new files: `tests/crawl/gateway.test.ts`, `tests/crawl/requests.test.ts` and `tests/crawl/runtime.test.ts`.

**Ground rules:**

- **Gateway and requests tests:**
  - Build the real Client over the Gateway: `createWikimapiaClient({ apiKey: TEST_API_KEY, transport: gateway.transport, clock: gateway.clock })`. Use the `SimulatedCrawlClock` and `CrawlWikimapia` (with `scripted({ tiles: T1_TILES, ... })` or a hand-written responder) from `contracts/hydration.support.ts`.
  - Pass `SimulatedCrawlClock` as the Gateway's `clock` and `CrawlWikimapia.transport` as its `transport`.
  - The heartbeat is a fake. It records `clock.nowMilliseconds` at each call and returns `{ ok: true }`, unless a test makes it fail.
  - Set `lastRenewalMs` to the clock start.
- **No database, no network, no real time** in `gateway.test.ts` and `requests.test.ts`.
- **In `runtime.test.ts`:**
  - Stub `globalThis.fetch` with a rejecting spy, as `tests/wikimapia/runtime.test.ts` does.
  - Use `vi.useFakeTimers()` for the clock, or at most a few milliseconds of real delay.
- **Assertions and data:**
  - Assert on observable results only: `CrawlWikimapia.calls` and `startTimes`; `SimulatedCrawlClock.sleeps`; the Gateway's `stopped`, `requestsSent` and `counts()`; the `Requested<T>` value; the heartbeat call log. Use `findPacingIssues` for pacing checks.
  - Use synthetic data only. Use `listingAnswer(...)` with `syntheticBoxPlace` for `box`, and `detailsAnswer('getbyid-62587.json')` or `syntheticDetailsAnswer` for details.

**A. Gateway: pacing** (`tests/crawl/gateway.test.ts`; AL4 1.4.3; AC-39, AC-40, AC-71)

1. Use an interval of 2 s and 5 instant answers. The starts are exactly 2 s apart, and the first starts at the clock start (not delayed). `findPacingIssues(startTimes, 2)` is `[]`.
2. A first answer that takes 3 s (`{ delayMs: 3 * SECOND, then: ... }`) adds no further delay: the second start is exactly 3 s after the first, and no pacing sleep is recorded.
3. A Client retry after a Rate-Limit Response (`rateLimitAnswer(0)`, then an answer) is paced as well. Calls 1 and 2 are for the same page and are ≥ 2 s apart.
4. With the default interval (6 s), 60 requests give no `findPacingIssues` with the `CRAWL_QUOTA_SHARE` window.
5. Interval 0 never sleeps for pacing.

**B. Gateway: budget and counting** (AC-41, AC-42, AC-43, AC-51, AC-52)

1. **Budget 3:** exactly 3 transport calls. The 4th Client call resolves a `connection` failure without reaching the transport. Then `stopped` = `{ reason: 'budget_reached', message: 'Request Budget of 3 used up.' }` and `requestsSent` 3.
2. **Budget 0:** the first call is refused, 0 transport calls, `budget_reached`, and no pacing sleep.
3. **The budget includes Client retries and is checked before pacing.** Use budget 2: page 1 is answered; page 2 gets `rateLimitAnswer(1)` and then an answer. That gives 2 transport calls, `budget_reached`, and no pacing sleep after the refusal.
4. **Kinds are counted with `setKind`.** Two `listing` calls and three `details` calls give `counts()` = `{ listingRequests: 2, detailsRequests: 3, ... }`. Their sum equals `requestsSent` and `CrawlWikimapia.calls.length`.
5. **A 1 s Rate-Limit Response is one request and one wait.** The result is `rateLimitWaits` 1, `rateLimitWaitMs` 1000 and `requestsSent` 2. A `rateLimitAnswer(0)` adds no wait.
6. **Fallback wait.** `rateLimitAnswer('a few')` counts one wait of `DEFAULT_FALLBACK_WAIT_SECONDS * 1000` ms.
7. **Waits on `gateway.clock.sleep` are the only ones counted as Rate-Limit Waits.** `gateway.wait(30_000)` returns 30000 and leaves `rateLimitWaits` and `rateLimitWaitMs` unchanged.

**C. Gateway: chunked waits and heartbeat** (AC-70; `WAIT_CHUNK_MS`, `RENEW_AFTER_MS`)

1. `WAIT_CHUNK_MS` = `(MAX_HEARTBEAT_INTERVAL_SECONDS - 60) * 1000` (840000), and `RENEW_AFTER_MS` = 60000.
2. **A 3-hour Rate-Limit Response** (`rateLimitAnswer(3 * 3600)`, then an answer):
   - every recorded sleep is ≤ `WAIT_CHUNK_MS`, and the sleeps add up to 3 h;
   - `rateLimitWaits` is 1 and `rateLimitWaitMs` is `3 * HOUR`;
   - the heartbeat is called before every chunk once ≥ 60 s have passed since the last renewal;
   - for every sleep, `sleep.atMs + sleep.ms - lastHeartbeatOrStart` ≤ `MAX_HEARTBEAT_INTERVAL_SECONDS * SECOND`.
3. **No heartbeat in the first minute.** A request within 60 s of `lastRenewalMs` calls no heartbeat. The first request at least 60 s after it calls the heartbeat once, before the transport call.
4. **Failing heartbeat.** A heartbeat that returns `{ ok: false, message: 'renewal failed' }` gives:
   - `stopped` = `{ reason: 'failed', message: 'renewal failed' }`;
   - the request that triggered it is not sent;
   - a wait in progress ends early (no further chunk).
5. **Heartbeat rejection.** A heartbeat that **rejects** (`new Error('postgres://user:secret@host/db')`):
   - stops the Gateway `failed`;
   - never rejects into the Client (the Client call still resolves);
   - leaves no `secret` and no `postgres://` in `JSON.stringify(gateway.stopped)`.
6. **`stop` keeps the first stop.** After `stop('budget_reached', ...)`, a later `stop('failed', ...)` changes nothing.

**D. Gateway: interrupt** (AC-46, request side)

1. A signal aborted before the first call gives 0 transport calls and `stopped.reason` `interrupted`.
2. **Abort during an answer.** Use `{ effect: () => controller.abort(), then: ... }`. That call still resolves `ok`. The next call is refused (no transport call) and the Gateway is `interrupted`.
3. **Abort during a long Rate-Limit Wait.** Abort from the clock's `onSleep` at the first chunk. No further chunk is slept and no further request is sent.

**E. `requestWithBackoff`** (`tests/crawl/requests.test.ts`; AL4 1.4.4; AC-17, AC-18, AC-43, AC-44, AC-48)

1. **Always unreachable** (`UNREACHABLE`), with interval 0:
   - 3 calls, started 30 s and then 60 s apart (`CONNECTION_RETRY_WAITS_SECONDS`);
   - the result is `{ kind: 'item_failure', failureKind: 'connection', message }`;
   - `message` contains neither `key=`, nor `TEST_API_KEY`, nor `ECONNREFUSED while requesting`;
   - `rateLimitWaits` stays 0.
2. **Unreachable once, then answered:** 2 calls and `ok`.
3. **No retry.** `wikimapiaErrorAnswer()` and `unexpectedAnswer()` each make 1 call and give `item_failure` with `failureKind` `wikimapia_error` and `unexpected_response`.
4. **Invalid request.** An invalid request (for example `pageSize: 0`) gives `item_failure` `invalid_request` with 0 calls.
5. **Rate Limit Exhausted.** `rateLimitForever()` makes `DEFAULT_RETRY_LIMIT + 1` calls and gives `{ kind: 'stopped' }`. The Gateway is then stopped with reason `rate_limited` and the message `Wikimapia kept answering with its rate limit after ${DEFAULT_RETRY_LIMIT + 1} attempts.`
6. **Configuration failure.** A Client built with `apiKey: ' \t '` makes 0 calls and gives `stopped`. The Gateway is `failed` with the Client's configuration message.
7. **Budget runs out inside a retry** (AC-43). With budget 1, `rateLimitAnswer(1)` and then an answer give `stopped` (not `item_failure`), 1 call and `budget_reached`.
8. **Abort during back-off.** The signal aborts during the 30 s back-off wait (from `onSleep`). The result is `stopped`, the reason is `interrupted`, and there is no further call.
9. **Already stopped.** When the Gateway is already stopped, the call gives `stopped` and the transport is never reached.
10. **`setKind`.** `requestWithBackoff(gateway, 'details', ...)` counts its calls (retries included) as `detailsRequests`.

**F. Runtime** (`tests/crawl/runtime.test.ts`)

1. `createSystemCrawlClock().now()` returns a `Date` close to the real time (use fake timers with `vi.setSystemTime`).
2. **`sleep(1000)` under fake timers:** it does not resolve before 1000 ms have been advanced, and it resolves after. `sleep(0)` and negative values resolve at once.
3. **Abort during sleep:** `createSystemCrawlClock(signal).sleep(10_000)` resolves promptly after `controller.abort()`, without advancing 10 s, and leaves no pending timer (`vi.getTimerCount()` is 0).
4. **Already-aborted signal:** `sleep` resolves at once.
5. **`defaultTransport()`:**
   - it returns a function and creating it calls `fetch` zero times;
   - calling it with a synthetic keyed URL calls the stubbed `fetch` once and returns `{ status, body }`.

The new tests are expected to fail until `add-coder` has finished. Do not stub production modules. Never call real `fetch`.

### 2.2 add-coder

1. **`src/crawl/types.ts`** (extend). Add exactly the AL4 1.3 types that are not there yet:
   - `RequestKind`, `HeartbeatOutcome`, `GatewayOptions`, `Gateway`, `Requested<T>`, `ClientCall<T>`;
   - import `WikimapiaTransport` and `ClientFailure` from `../../contracts/wikimapia-client.schema`, and `CrawlClock` from `../../contracts/hydration.schema`, all with `import type`;
   - change no existing type;
   - do not add `RunContext` or `PassCursor` (U6);
   - update the header comment.
2. **`src/crawl/runtime.ts`** (new):
   - **`createSystemCrawlClock(signal?)`:**
     - `now()` returns `new Date()`. This is the only `new Date()` without an argument allowed in `src/crawl`.
     - `sleep(ms)` resolves at once when `ms <= 0` or when the signal is already aborted. Otherwise it waits on global `setTimeout`, as `src/wikimapia/runtime.ts` does, so fake timers work.
     - On `abort` it clears the timer and resolves early (it never rejects). It removes its abort listener when it settles.
     - For delays above `MAX_TIMER_DELAY_MS`, loop as the Client's `sleep` does. You may import the exported `MAX_TIMER_DELAY_MS` from `../wikimapia/runtime`.
   - **`defaultTransport`:** `() => createFetchTransport()`, imported from `../wikimapia/client`.
3. **`src/crawl/gateway.ts`** (new). Implement AL4 1.4.3 line by line.
   - **Exports:** `createGateway(options: GatewayOptions): Gateway`, `WAIT_CHUNK_MS = (MAX_HEARTBEAT_INTERVAL_SECONDS - 60) * 1000` (840000; derive it from the contract constant), and `RENEW_AFTER_MS = 60_000`.
   - **State:** `stopped`, `sent`, `byKind`, `kind` (default `'listing'`), `lastStartMs`, `lastRenewalMs`, `rateLimitWaits`, `rateLimitWaitMs`.
   - **`transport`** checks, in this order:
     1. stopped;
     2. aborted, then `stop('interrupted')`;
     3. budget, as `sent >= requestBudget`, then `stop('budget_reached', \`Request Budget of ${budget} used up.\`)`;
     4. pacing: `dueMs` from the previous **start**, `waitChunked(dueMs)` when > 0, then re-check stopped and aborted;
     5. `renewIfDue()`, then re-check stopped.

     After the checks, it records `lastStartMs = clock.now()`, `sent += 1` and `byKind[kind] += 1`, and returns `inner.transport(request)` unchanged (rejections pass through).
   - **Refusal:** each refusal throws a fresh `new Error('request not sent by the crawl')` with no `cause`.
   - **`clock`:** `now` delegates to the inner clock. `sleep(ms)`: if `ms <= 0`, return. Otherwise `rateLimitWaits += 1` and `rateLimitWaitMs += await waitChunked(ms)`. It never rejects.
   - **`waitChunked(ms)`:** follow the AL4 loop exactly:
     - break when stopped or aborted;
     - `renewIfDue()` before every chunk;
     - each chunk is ≤ `WAIT_CHUNK_MS`;
     - `actual` is measured on the clock and bounded to `[0, chunk]`;
     - it returns the total actually slept.
   - **`wait(ms)`** = `waitChunked(ms)`.
   - **`renewIfDue()`:** if fewer than `RENEW_AFTER_MS` ms have passed since `lastRenewalMs`, return. Otherwise `await options.heartbeat()`:
     - `ok`: `lastRenewalMs = clock.now()`;
     - not `ok`: `stop('failed', r.message)`;
     - **rejects**: catch it and `stop('failed', <fixed text>)`, for example `'Crawl failed: Last Activity could not be renewed.'`. Never copy the error's message, and never let it reach the Client (AL4 1.4.9 bullet 3).
   - **`stop`:** the first stop wins.
   - **Getters and methods:** `stopped`, `requestsSent` and `counts()` as in AL4. `setKind` sets the kind for the following transport calls.
   - **No URL parsing.** Never inspect `request.url`.
   - **No imports** from `src/db/`, `knex` or `pg`.
4. **`src/crawl/requests.ts`** (new). Implement `requestWithBackoff(gateway, kind, signal, call)` exactly as in AL4 1.4.4:
   - `setKind` first;
   - the `gateway.stopped` check comes **before** looking at `result.ok`;
   - `ok` passes through even if the signal was aborted meanwhile;
   - `rate_limit_exhausted`: `stop('rate_limited', \`Wikimapia kept answering with its rate limit after ${f.attempts} attempts.\`)` (with `String(...)` where lint requires it);
   - `configuration`: `stop('failed', f.message)`;
   - `connection`: aborted means `stop('interrupted')`; otherwise back off with `gateway.wait(CONNECTION_RETRY_WAITS_SECONDS[attempt] * 1000)` for each listed wait, then re-check stopped and aborted, then `continue`. When the waits are used up, return `item_failure` `connection`;
   - `wikimapia_error`, `unexpected_response`, `invalid_request`: return `item_failure` with `failureKind = f.kind` and `message = f.message`. No retry.
   - **Messages:** use only the Client's own (already redacted) failure `message`. Never `wikimapiaMessage`, `issues`, a URL or any other text.
   - **Exhaustiveness:** use an exhaustive `switch` with a `never` default. Read `CONNECTION_RETRY_WAITS_SECONDS[attempt]` with a `noUncheckedIndexedAccess`-safe check.
5. **Do not change:**
   - `src/wikimapia/`, `src/db/`, and the other `src/crawl/` modules (`tile-plan.ts`, `config.ts`, `report.ts`);
   - `scripts/`, `package.json`, config files, and existing tests.
6. **Stop and report, do not work around,** if:
   - the real Client calls `clock.sleep` other than after a Rate-Limit Response, which would break "every sleep with `ms > 0` is one Rate-Limit Wait";
   - a refused request does not come back from the Client as a `connection` failure;
   - the AL4 1.3 types cannot express a case the tests need;
   - meeting the AC-70 bound would need a chunk or renewal rule other than AL4 1.4.3.
7. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. This unit's tests need no database.

1. `pnpm exec vitest run --no-color tests/crawl/gateway.test.ts tests/crawl/requests.test.ts tests/crawl/runtime.test.ts tests/wikimapia` passes, with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/crawl contracts/hydration.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes. If Docker and the Test Database are up, also run `pnpm exec vitest run --no-color tests/db contracts/storage.test.ts`. It must stay green; this unit changes nothing there.
3. `pnpm exec eslint src/crawl tests/crawl` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly 2 errors, both TS2307 in `contracts/hydration.test.ts`, for `src/crawl/command` and `src/crawl/run-crawl`. No new error.
5. Guards. Each of these returns nothing:
   - `Select-String -Path src/crawl/types.ts, src/crawl/gateway.ts, src/crawl/requests.ts, src/crawl/runtime.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|\.js'"`
   - `Select-String -Path src/crawl/gateway.ts, src/crawl/requests.ts -Pattern "from '\.\./db|from 'knex'|from 'pg'|new URL|searchParams|\.url\b|wikimapiaMessage|new Date\("` (no DB, no URL parsing, no raw Wikimapia text, no wall clock)
   - `Select-String -Path src/crawl/gateway.ts -Pattern "error\.message|String\(error|err\.message"` (a heartbeat rejection's text is never copied)
   - `Get-ChildItem src/crawl -Filter *.ts | Where-Object Name -ne 'runtime.ts' | Select-String -Pattern 'new Date\(\)'` (wall clock only in `runtime.ts`)

Do not run `contracts/hydration.test.ts` or `pnpm test:db` as a gate. The contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
  - Do not skip, weaken or `.todo` any contract test or any existing test.
  - Do not copy or redefine contract schemas, constants or helpers (`CONNECTION_RETRY_WAITS_SECONDS`, `MAX_HEARTBEAT_INTERVAL_SECONDS`, `DEFAULT_RETRY_LIMIT`, `DEFAULT_FALLBACK_WAIT_SECONDS`, `findPacingIssues`, `SimulatedCrawlClock`, `CrawlWikimapia`, ...) in `src/` or `tests/`. Import them.
- **The Client is frozen.** Do not modify anything in `src/wikimapia/` or `tests/wikimapia/`. All counting, pacing and budget logic lives in `gateway.ts`.
- **Files you may create or change:** `src/crawl/types.ts`, `src/crawl/gateway.ts`, `src/crawl/requests.ts`, `src/crawl/runtime.ts`, `tests/crawl/gateway.test.ts`, `tests/crawl/requests.test.ts`, `tests/crawl/runtime.test.ts`. Nothing else.
- **No live calls.** No test reaches real `fetch` or real long timers.
- **Secrets:** never open, write or print `.env`. Use only `TEST_API_KEY`.
- **Protected files:** do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U6:**
  - `listing-phase.ts`, `details-phase.ts`, `run-crawl.ts`, and the `RunContext`/`PassCursor` types;
  - building the real heartbeat (`repo.renewActivity` with `toMoment(clock.now())` and a `tally.snapshot` of `gateway.counts()`);
  - choosing `lastRenewalMs` from the Run start;
  - calling `gateway.stop('interrupted')` when the signal is already aborted at Run start;
  - Item Failure messages with `Tile n page p:` / `Place id:` prefixes;
  - the tally, progress lines, the outcome and the report.
- **U7:** `command.ts`, `scripts/crawl.ts`, SIGINT/SIGTERM wiring, `package.json` scripts; making `contracts/hydration.test.ts` green.
- **U1 to U4 (done):** anything in `src/db/`, including the Run-wide write counter in `crawl-repository.ts`.
- **Orchestrator:** recording the AL4 0.1 decisions in `CLAUDE.md`.
