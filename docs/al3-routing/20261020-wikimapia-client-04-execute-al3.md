# AL3 Routing: wikimapia-client, U4 "Execution core: transport, status, rate-limit loop"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** U4 of 5 (depends on U2 `interpret.ts` and U3 `redact.ts`; U1 to U3 are done and verified)
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`, section 4 "U4. Execution core: transport, status, rate-limit loop"
- **Audience:** `add-test-writer`, then `add-coder`
- **Status:** Routing to AL2 Agents

## 1. Context Manifest

Read these files, and only these, before you start. Follow the project stack and code style they define: Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, and pnpm. Match the style of the existing U1 to U3 files (file header comment naming the AL4 sections, `import type` for types, `.js` suffix on relative imports).

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding project rules. Section 2 (Zod-validated boundaries: the transport result is validated) and section 4 (No Live External Calls in Tests, No Commenter IPs, Strict Types) apply directly. |
| 2 | `CLAUDE.md` | Stack, decisions, and the Wikimapia API reference ("Rate limiting" bullet). |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | The design. Required sections: "0. Scope and Fixed Points", "1.1 Module map" (row `execute.ts`), "1.2 Call flow" (step 4 and step 5), "1.3 Component contracts (signatures)" (the `execute.ts` block, plus the `interpret.ts` and `redact.ts` blocks it consumes, and the assignability note below the block), "1.4.7 Rate limiting and retries", "1.4.8 Transport and failure mapping", "1.4.9 Secret redaction" (first paragraph only: redaction applies to every failure), "1.5 Transaction boundaries", "4. Implementation Units / U4", "5. AL2 Guidance". |
| 4 | `contracts/wikimapia-client.schema.ts` | Single source of truth. U4 uses `TransportResponseSchema`, `TransportRequest`, `WikimapiaTransport`, `Clock`, `ClientFailure`, `ClientFailureSchema` (exact keys of `rate_limit_exhausted`, `wikimapia_error`, `connection` with `exactOptional` `status`, `unexpected_response`), `FailureIssue`, `ListPlacesResult`, `PlaceDetailsResult`, `ListPlacesResultSchema`, `PlaceDetailsResultSchema`, `DEFAULT_RETRY_LIMIT`, `DEFAULT_FALLBACK_WAIT_SECONDS`. |
| 5 | `contracts/wikimapia-client.support.ts` | Test doubles: `SimulatedWikimapia` (with `repeatLast` and `log`; its unreachable answer rejects with an error whose message contains the keyed URL), `SimulatedClock` (with `manual`, `log`, `sleeps`, `pendingWaits`, `elapseAll`, `totalMilliseconds`), `settle`, `answer`, `fixtureAnswer`, `fixtureText`, `rateLimitAnswer`, `rawDetails`, `TEST_API_KEY`, `at`. |
| 6 | `contracts/wikimapia-client.test.ts` | Reference only, to align the unit tests with the black-box contract. Relevant describes: "AC-22" to "AC-30", "AC-48", "AC-49" (rate limiting), "AC-32", "AC-33", "AC-34" (failures), "AC-36" (the `JSON.stringify` key checks), and the helper `failure(...)` near the top (a failure result has only `ok` and `failure`). The file imports `src/wikimapia/client.ts` (U5), so it cannot run yet. |
| 7 | `src/wikimapia/interpret.ts` | Done (U2). Provides `Interpretation<T>`, `interpretBoxAnswer`, `interpretPlaceDetailsAnswer`. Note: a `wikimapia_error` interpretation carries Wikimapia's message **verbatim** (including any key); U4 redacts it. |
| 8 | `src/wikimapia/redact.ts` | Done (U3). Provides `redactFailure(failure, apiKey)`. |
| 9 | `src/wikimapia/issues.ts` | Done (U1). Provides `describeIssues(prefix, issues)` for `unexpected_response` messages. |
| 10 | `src/wikimapia/request.ts` | Done (U3). Tests may use `buildPlaceDetailsUrl` / `buildBoxUrl` to obtain the fixed test URL. |
| 11 | `tests/wikimapia/interpret.test.ts` | Style reference for test layout and helper use. Do not modify it. |
| 12 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read the AL6 document, `src/wikimapia/normalize.ts` or the fixture files directly (use the support helpers). U4 does not need them.

## 2. Execution Directives

### 2.1 add-test-writer

Create `tests/wikimapia/execute.test.ts`. Import `executeRequest` and the types `ExecuteDeps` and `ClientResult` from `../../src/wikimapia/execute.js`; the interpreters from `../../src/wikimapia/interpret.js`; contract items from `../../contracts/wikimapia-client.schema.js`; and the doubles and helpers from `../../contracts/wikimapia-client.support.js`. Use `import type` for type-only imports.

Setup rules:

- One fixed test URL per function for the whole file, built once (e.g. `buildPlaceDetailsUrl({ apiKey: TEST_API_KEY, placeId: 62587 })`, and `buildBoxUrl` for listing cases). Use `TEST_API_KEY` as `deps.apiKey`. No real keys, no network, no real timers: every `transport` is a `SimulatedWikimapia` (or a small inline fake for the malformed/throwing cases) and every `clock` is a `SimulatedClock` (or an inline fake for the rejecting case).
- A small helper that builds `ExecuteDeps` with `retryLimit: DEFAULT_RETRY_LIMIT` and `fallbackWaitSeconds: DEFAULT_FALLBACK_WAIT_SECONDS` unless overridden. U4 has no defaults of its own; the test passes the contract constants explicitly.
- For every failure result, assert: it passes `PlaceDetailsResultSchema` (or `ListPlacesResultSchema`), `Object.keys(result)` is exactly `['ok','failure']`, the failure kind is the expected one, and `JSON.stringify(result)` contains neither `TEST_API_KEY` nor a match for `/[?&]key=/`. For every success, assert the value passes the matching result schema and deep-equals the result of interpreting the same fixture body directly.

Test groups (they expand the U4 list "Unit tests must cover" against AL4 1.4.7, 1.4.8 and 1.5):

1. **Plain success (AC-29).** One data answer for each interpreter (`getbyid-62587.json` with `interpretPlaceDetailsAnswer`, `box-belgrade-page1.json` with `interpretBoxAnswer`): one request, `clock.sleeps` empty, `requests[0].url` equals the test URL and the request object is exactly `{ url }`.
2. **Wait then success (AC-22, AC-23).** `rateLimitAnswer(7)` then data: `sleeps` is `[7000]`, two requests, `requests[1].url === requests[0].url`. Cover both interpreters.
3. **Several limits (AC-25).** 3 s, 5 s, then data: `sleeps` `[3000, 5000]`, total 8000, three requests.
4. **Retry limit (AC-26).** With `repeatLast` and the default limit: 6 requests, `sleeps` five times `3000`, `attempts: 6`, `lastWaitSeconds: 3`. With `retryLimit: 1` and answers 2 s then 9 s: 2 requests, `sleeps` `[2000]`, `attempts: 2`, `lastWaitSeconds: 9` (no sleep after the last answer).
5. **Retry limit 0 (AC-24).** First rate-limit answer gives `rate_limit_exhausted` immediately: 1 request, no sleep, `attempts: 1`, kind is not `unexpected_response`.
6. **Unreadable wait (AC-27, AC-49).** `rateLimitAnswer('a few')` then data: `sleeps` `[60000]`. With `repeatLast`, `retryLimit: 1`: 2 requests, `lastWaitSeconds: 60`. With `retryLimit: 2`, `fallbackWaitSeconds: 10` and `rateLimitAnswer('several')`: 3 requests, `sleeps` `[10000, 10000]`, `attempts: 3`, `lastWaitSeconds: 10`.
7. **Wait of zero (AC-28).** `rateLimitAnswer(0)` then data: two requests and `sleeps` is **empty** (`sleep` is never called, not even with 0). With `repeatLast` and `retryLimit: 2`: 3 requests, `attempts: 3`, `lastWaitSeconds: 0`, `sleeps` empty.
8. **No cap (AC-48).** `rateLimitAnswer(86400)` then data: `sleeps` `[86_400_000]`, success.
9. **No early retry (AC-30).** Shared `log` array, `SimulatedWikimapia(..., { log })` and `SimulatedClock({ manual: true, log })`: after `settle()` exactly 1 request and 1 pending wait; after `settle(20)` still 1 request; after `elapseAll()` the promise resolves to success and `log` is exactly `['request', 'sleep:7000', 'request']`.
10. **Rate-limit exhausted message.** Non-empty, contains `String(attempts)` and `String(lastWaitSeconds)`, and contains no URL (`/https?:\/\//` does not match).
11. **Unreachable (AC-33, AC-36).** `{ unreachable: true }` with `repeatLast`: kind `connection`, the failure has **no** `status` key (`'status' in failure` is false), 1 request, no sleep, and the failure JSON contains neither the key, nor `api.wikimapia.org`, nor `ECONNREFUSED while requesting` (the error's own message is never copied).
12. **Error cause code.** An inline transport rejecting with an `Error` whose `cause` is `{ code: 'ECONNREFUSED' }` and whose message contains the keyed URL: `connection`, message may contain `ECONNREFUSED`, never the URL or key. A `cause.code` that does not match `/^[A-Z][A-Z0-9_]*$/` (e.g. a lowercase string containing the key, or a number) is not copied. A rejection with a non-`Error` value (e.g. a plain string containing the key) still gives `connection` without leaking it.
13. **Non-2xx status (AC-33).** `it.each([404, 500, 502, 503])` with the 62587 fixture body and `repeatLast`: `connection` with `status` equal to the given value, 1 request, no sleep. Also cover the edges: `199` and `300` are `connection` with that status; `200`, `201` and `299` with a valid data body are success (the body is only inspected for 2xx).
14. **Malformed transport result.** An inline transport resolving to each of: `{ status: 200 }` (no body), `{ status: 200, body: 5 }`, `{ status: 1.5, body: '' }`, `{ status: 200, body: '', extra: 1 }` (strict schema), `null`, and `undefined` (cast through `unknown` to the transport type). Each gives `unexpected_response` with an issue at path `[]` whose message is `transport returned a malformed response`, and 1 request.
15. **Synchronous throw.** An inline transport that throws synchronously (not a rejected promise) with a message containing the keyed URL: the call still resolves to `connection` with no `status`, no leak.
16. **Never rejects.** A clock whose `sleep` rejects (with a message containing the key), after one rate-limit answer: resolves to `unexpected_response` with an issue at path `[]` and message `internal client error`, no leak. An interpret callback that throws: same outcome. Use `await expect(promise).resolves...` style so that a rejection fails the test.
17. **No retry for other failures (AC-32, AC-34).** With `repeatLast`: `debug-error.json` gives `wikimapia_error` with `wikimapiaMessage` `'Invalid API key.'` unchanged, 1 request, no sleep. HTML body, `''`, truncated JSON (`fixtureText('getbyid-62587.json').slice(0, 200)`) and `'[]'` each give `unexpected_response`, 1 request, no sleep, and the issues of the interpretation are carried over (e.g. path `[]` for the HTML body; path `['title']` for a `rawDetails('getbyid-62587.json')` body with `title` deleted).
18. **Redaction applied (AC-36).** A debug answer `{ debug: { message: \`Key ${TEST_API_KEY} is not valid\` } }`: `wikimapia_error`, `wikimapiaMessage` no longer contains the key. An HTML body containing the keyed URL: `unexpected_response`, no leak. A 502 with an empty body: `connection` with `status: 502`, no leak.
19. **No shared state (AL4 1.4.7 last bullet, 1.5).** Two sequential `executeRequest` calls with the same `deps` (`retryLimit: 1`) and one `SimulatedWikimapia` answering rate-limit 7 s, data, rate-limit 7 s, data: both calls succeed (the second gets its own full retry budget, not what is left of the first); total 4 requests, `sleeps` `[7000, 7000]`.
20. **Type-level assignability (AL4 1.3 note).** A compile-time check that `ClientResult<ListingPage>` is assignable to `ListPlacesResult` and `ClientResult<PlaceDetails>` to `PlaceDetailsResult` (e.g. assign the awaited result to a variable annotated with the contract type). `tsc` enforces it.

Run the new test file once and confirm that it fails only because `src/wikimapia/execute.ts` does not exist yet.

### 2.2 add-coder

1. **Create `src/wikimapia/execute.ts`** per AL4 1.3 (`execute.ts` block), 1.4.7, 1.4.8 and 1.5. Export exactly `executeRequest`, `ExecuteDeps` and `ClientResult<T>` with the signatures in 1.3. If `ClientResult<T>` is not assignable to the contract result types, follow the note below the 1.3 block.
2. **Loop.** For `attempt = 1, 2, ...` follow 1.2 step 4 (a to d) in order. The `url` argument is passed unchanged to every attempt as `{ url }`. Avoid a constant loop condition that `@typescript-eslint/no-unnecessary-condition` flags (use `for (let attempt = 1; ; attempt += 1)` or an equivalent bounded loop).
3. **Transport call (1.4.8).** `await deps.transport({ url })` inside `try`, so that a synchronous throw and a rejection are both caught. Map either to `connection` with message `Wikimapia could not be reached`, optionally followed by ` (CODE)` when `error.cause.code` is a string matching `/^[A-Z][A-Z0-9_]*$/`. Read the cause through `unknown`-safe narrowing (no casts to `any`, no non-null assertions). Never copy the error's message, the error itself or any non-matching code. Never add a `status` key in this branch.
4. **Boundary validation.** `TransportResponseSchema.safeParse(response)`. On failure: `unexpected_response` with `issues: [{ path: [], message: 'transport returned a malformed response' }]`.
5. **Status.** `status < 200 || status > 299` gives `connection` with message `Wikimapia answered with HTTP status ${String(status)}` and `status`. The body is not passed to the interpreter.
6. **Interpretation.** Call `interpret(body)` and switch on `kind` with an exhaustiveness check:
   - `data`: return `{ ok: true, value }`.
   - `wikimapia_error`: `{ kind: 'wikimapia_error', message: <fixed non-empty text, e.g. 'Wikimapia reported an error'>, wikimapiaMessage: message }`. No retry.
   - `unexpected`: `{ kind: 'unexpected_response', message: describeIssues('Unexpected Wikimapia response', issues), issues }`. No retry.
   - `rate_limit`: `wait = waitSeconds ?? deps.fallbackWaitSeconds`. If `attempt > deps.retryLimit`, return `rate_limit_exhausted` with `attempts: attempt`, `lastWaitSeconds: wait` and the template message of 1.4.7, without sleeping. Otherwise, if `wait > 0`, `await deps.clock.sleep(Math.round(wait * 1000))`; then continue. No cap, no safety margin, no jitter.

   **Routing clarification:** AL4 fixes the message text only for `connection`, `rate_limit_exhausted` and the issue messages. The `wikimapia_error` and `unexpected_response` message wording above is a routing choice; any fixed, non-empty text that contains no body content, URL or key is acceptable. For the malformed-response and internal-error cases, build the message with the same `describeIssues('Unexpected Wikimapia response', issues)` call.
7. **Never rejects (1.4.8 last bullet).** Wrap the whole body in `try/catch`. Any unanticipated exception (rejecting `clock.sleep`, throwing `interpret`) becomes `unexpected_response` with `issues: [{ path: [], message: 'internal client error' }]`. The caught value is never copied.
8. **Redaction (1.2 step 5).** Every failure, from every branch including the guard, passes through `redactFailure(failure, deps.apiKey)` exactly once before it is returned. A single helper that builds `{ ok: false, failure: redactFailure(f, deps.apiKey) }` is preferred. Success values are not redacted. The returned failure result has only the keys `ok` and `failure`.
9. **Trust the inputs.** `retryLimit`, `fallbackWaitSeconds` and `apiKey` are already validated by U5. Do not re-validate them, do not apply defaults in `execute.ts`, and keep no module-level state (no caches, no counters, no pacing).
10. **Imports.** Contract items from `../../contracts/wikimapia-client.schema.js`; `Interpretation` (type) from `./interpret.js`; `redactFailure` from `./redact.js`; `describeIssues` from `./issues.js`. Do not import `normalize.ts`, `request.ts` or `runtime.ts`.
11. **Style.** AL4 "5. AL2 Guidance": `String(n)` in template literals, no non-null assertions, no `console.*`, no floating promises, catch variables treated as `unknown`.
12. **Scope of changes.** Do not modify any U1 to U3 source or test file. Do not create any other file under `src/`. Do not touch `package.json`.

### 2.3 Done when

All of the following hold:

- `pnpm exec vitest run --no-color tests/wikimapia/execute.test.ts` passes.
- `pnpm exec vitest run --no-color tests contracts/wikimapia-client.schema.test.ts` stays fully green: all 333 previously passing tests (U1 to U3 unit tests and the 35/35 schema tests), plus the new tests.
- `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems.
- `pnpm exec tsc --noEmit` and `pnpm lint` report no new errors. **"No new errors" means exactly one error each, the one that already exists:** the unresolved import `../src/wikimapia/client.js` in `contracts/wikimapia-client.test.ts`. It goes away only in U5. Any other error is yours to fix.
- `contracts/wikimapia-client.test.ts` is expected to stay red (it cannot import) until U5. Do not try to make it pass now. Its rate-limit and failure describes (AC-22 to AC-30, AC-32 to AC-34, AC-36, AC-48, AC-49) are the behaviour U4 must make possible; U5 verifies them end to end.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/wikimapia/`, the support file and both contract test files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
- If a contract schema, a support double or the AL4 spec appears wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing). Do not work around it locally.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.
- Use only `TEST_API_KEY` and synthetic values in tests. Never use a real API key, never call `fetch`, never use real timers.

## 4. Out of Scope

Do not implement any of the following now. They belong to other units:

- U1 to U3 (done): issue mapping, normalisation, answer interpretation, URL building, redaction. Do not change their behaviour; in particular, do not move redaction into `interpret.ts`.
- U5: `src/wikimapia/runtime.ts` (`createFetchTransport`, `systemClock`, `DEFAULT_REQUEST_TIMEOUT_MS`, `MAX_TIMER_DELAY_MS`, AL4 1.4.10) and `src/wikimapia/client.ts` (`createWikimapiaClient`, configuration and key trimming, defaults for `retryLimit`, `fallbackWaitSeconds`, `transport` and `clock`, input validation, the `pageSize` default, choice of builder and interpreter; AL4 1.2 steps 1 to 3, 1.4.1, 1.4.2). The never-reject guard of the public methods also belongs to U5.
- Any request timeout: timeouts live in the default transport (U5), not in `execute.ts`.
- Any database, migration, crawl, pacing, logging or embedding work (later Stage 1 substeps).
