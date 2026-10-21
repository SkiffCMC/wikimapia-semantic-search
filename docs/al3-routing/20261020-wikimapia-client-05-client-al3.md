# AL3 Routing: wikimapia-client, U5 "Runtime defaults and the public factory"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** U5 of 5, the final unit (depends on U1 to U4, all done and verified)
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`, section 4 "U5. Runtime defaults and the public factory"
- **Audience:** `add-test-writer`, then `add-coder`
- **Status:** Routing to AL2 Agents

This unit creates the contract entry point. When it is done, `contracts/wikimapia-client.test.ts` can import `src/wikimapia/client.ts` and must turn fully green, and the whole feature DoD (section 2.3) must hold.

## 1. Context Manifest

Read these files, and only these, before you start. Follow the project stack and code style they define: Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, pnpm. Match the style of the existing U1 to U4 files (file header comment naming the AL4 sections, `import type` for types, `.js` suffix on relative imports, contract items imported from `../../contracts/wikimapia-client.schema.js`).

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding project rules. Section 2 (Zod-validated boundaries: configuration and input are parsed with Zod; invalid input is a handled error) and section 4 (No Live External Calls in Tests, Strict Types, No Commenter IPs) apply directly. |
| 2 | `CLAUDE.md` | Stack, decisions, Wikimapia API reference (`WIKIMAPIA_API_KEY` lives in `.env`, never in tests). |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | The design. Required sections: "0. Scope and Fixed Points", "1.1 Module map" (rows `runtime.ts` and `client.ts`), "1.2 Call flow" (steps 1 to 3 and step 5), "1.3 Component contracts" (the `runtime.ts` block, plus the `request.ts`, `execute.ts` and `issues.ts` blocks it consumes, and the assignability note), "1.4.1 Configuration", "1.4.2 Input validation", "1.4.8 Transport and failure mapping" (last bullet "Never rejects" only), "1.4.10 Runtime defaults", "1.5 Transaction boundaries", "3. Batch & External Calls" (the timeout column), "4. Implementation Units / U5", "5. AL2 Guidance". |
| 4 | `contracts/wikimapia-client.schema.ts` | Single source of truth. U5 uses `CreateWikimapiaClientFn`, `WikimapiaClientOptions`, `WikimapiaClient`, `ClientConfigSchema`, `ListPlacesInputSchema`, `PlaceDetailsInputSchema`, `ListPlacesInput`, `PlaceDetailsInput`, `ListPlacesResult`, `PlaceDetailsResult`, `ListPlacesResultSchema`, `PlaceDetailsResultSchema`, `ClientFailure`, `WikimapiaTransport`, `TransportResponse`, `Clock`, `DEFAULT_PAGE_SIZE`, `DEFAULT_RETRY_LIMIT`, `DEFAULT_FALLBACK_WAIT_SECONDS`, `ENTRY_POINT`. |
| 5 | `contracts/wikimapia-client.test.ts` | The black-box contract that must pass after this unit. Read the header, the `setup` / `failure` helpers at the top, and the describes "AC-3", "AC-4", "AC-5", "AC-7", "AC-8", "AC-18", "AC-31", "AC-36" (`allFailures` builds one failure of each kind, including an unconfigured client and `placeId: 0`) and "AC-38" (`fetch` is spied and must never be called). The other describes exercise U1 to U4 through your factory. |
| 6 | `contracts/wikimapia-client.support.ts` | Test doubles and helpers: `SimulatedWikimapia` (`requests`, `params(i)`, `repeatLast`), `SimulatedClock` (`sleeps`), `TEST_API_KEY`, `fixtureAnswer`, `fixtureText`, `rateLimitAnswer`, `answer`, `at`. |
| 7 | `src/wikimapia/execute.ts` | Done (U4). `executeRequest(url, interpret, deps)`, `ExecuteDeps`, `ClientResult<T>`. It applies **no** defaults and does **not** re-validate `apiKey`, `retryLimit` or `fallbackWaitSeconds`: U5 must hand it resolved, validated values. It already redacts every failure it returns and never rejects. |
| 8 | `src/wikimapia/request.ts` | Done (U3). `buildBoxUrl`, `buildPlaceDetailsUrl`. Their `language?: string` parameter is an exact optional: pass the key only when a language is configured. |
| 9 | `src/wikimapia/interpret.ts` | Done (U2). Only the exports `interpretBoxAnswer` and `interpretPlaceDetailsAnswer` matter here. |
| 10 | `src/wikimapia/issues.ts` | Done (U1). `toFailureIssues`, `describeIssues`. |
| 11 | `src/wikimapia/redact.ts` | Done (U3). `redactFailure(failure, apiKey)`; with `apiKey === ''` it still strips keyed addresses and `key=` fragments. |
| 12 | `tests/wikimapia/execute.test.ts` | Style reference for test layout and the strict failure assertions. Do not modify it. |
| 13 | `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `package.json` | Compiler, lint (`strictTypeChecked`, `no-console` warn) and test settings; `pnpm lint` is `eslint .` over the whole repo, including `contracts/` and `tests/`. |

Do not read `src/wikimapia/normalize.ts`, the AL6 document or the fixture files directly. U5 does not need them; use the support helpers for fixture bodies.

## 2. Execution Directives

### 2.1 add-test-writer

Create `tests/wikimapia/runtime.test.ts` and `tests/wikimapia/client.test.ts`. Use `import type` for type-only imports.

**Network guard (mandatory in both files).** No test may reach the real network. In each file, a `beforeEach` installs `vi.spyOn(globalThis, 'fetch')` with a default implementation that rejects (e.g. "real network is disabled in unit tests"), and an `afterEach` calls `vi.restoreAllMocks()` and `vi.useRealTimers()`. Tests that exercise the default transport override the spy's implementation per test. Use only `TEST_API_KEY` or obviously synthetic keys. Never use real timers for a wait longer than a microtask turn.

#### `tests/wikimapia/runtime.test.ts` (AL4 1.4.10, U5 list)

Import `createFetchTransport`, `systemClock`, `DEFAULT_REQUEST_TIMEOUT_MS` and `MAX_TIMER_DELAY_MS` from `../../src/wikimapia/runtime.js`.

1. **Constants.** `DEFAULT_REQUEST_TIMEOUT_MS` is `30_000`; `MAX_TIMER_DELAY_MS` is `2_147_483_647`.
2. **Creation sends nothing.** Calling `createFetchTransport()` (with and without options) does not call `fetch`.
3. **Request shape.** With `fetch` mocked to resolve a `Response` (status 200, a fixture body via `fixtureText`): the transport calls `fetch` exactly once, with the URL string unchanged as first argument, and an init whose `method` is `'GET'`, `redirect` is `'follow'`, `signal` is an `AbortSignal`, and which has no `headers` key.
4. **Response mapping.** The result is exactly `{ status, body }` (strict keys) and passes `TransportResponseSchema`; the body equals the response text. Cover status 200 and a non-2xx status (e.g. 503 with an HTML body): the transport maps it without throwing (status handling belongs to `execute.ts`).
5. **Timeout.** `vi.spyOn(AbortSignal, 'timeout')` shows `DEFAULT_REQUEST_TIMEOUT_MS` by default and the given value for `createFetchTransport({ timeoutMs: 5000 })`.
6. **Rejection propagates.** When `fetch` rejects (e.g. a `TypeError` with a `cause` `{ code: 'ECONNREFUSED' }`), the transport promise rejects with that same error (it does not map or swallow it). Same when `response.text()` rejects.
7. **Late binding.** A transport created **before** the `fetch` spy's implementation is changed uses the implementation in place at call time (the transport reads `globalThis.fetch` per call).
8. **`systemClock.sleep` with fake timers.** After `vi.useFakeTimers()`: `sleep(7000)` is still pending after advancing 6999 ms and resolved after 1 more ms (use `vi.advanceTimersByTimeAsync` and a settled flag).
9. **Long delay (chunking).** `sleep(MAX_TIMER_DELAY_MS + 5000)` is still pending after advancing `MAX_TIMER_DELAY_MS` ms and after advancing a further 4999 ms, and resolves only after the full time has elapsed. A naive single `setTimeout` would be clamped to 1 ms and fail this test.
10. **Zero.** `sleep(0)` resolves (no hang) after advancing 0 ms or running pending timers.

#### `tests/wikimapia/client.test.ts` (AL4 1.2 steps 1 to 3, 1.4.1, 1.4.2, U5 list)

Import `createWikimapiaClient` (and the re-exported `createFetchTransport`, `systemClock`) from `../../src/wikimapia/client.js`. Use a local `setup` helper in the style of the contract test (`SimulatedWikimapia` + `SimulatedClock`). For every failure result assert: it passes `ListPlacesResultSchema` / `PlaceDetailsResultSchema`, `Object.keys(result)` is exactly `['ok','failure']`, the kind is the expected one, and `JSON.stringify(result)` contains neither the API key in use nor a match for `/[?&]key=/`.

1. **Entry point.** A compile-time assignment `const create: CreateWikimapiaClientFn = createWikimapiaClient`. The re-exported `createFetchTransport` and `systemClock` are the same references as the ones from `runtime.js`.
2. **Configuration failure (AC-31, 1.4.1).** `it.each` over: `{}` (cast through `unknown`, as the contract does), `apiKey: ''`, `apiKey: '   '`, `language: 'eng'`, `language: 'EN'`, `retryLimit: -1`, `retryLimit: 1.5`, `fallbackWaitSeconds: -1`, and `apiKey` of a wrong type (e.g. a number, cast). For each: `createWikimapiaClient` does not throw; both `listPlaces` (valid input) and `getPlaceDetails({ placeId: 62587 })` resolve to `configuration`; `wikimapia.requests` is empty; `fetch` is not called. The message is non-empty, names the offending field (e.g. contains `apiKey` or `language`), and does not contain the offending value (e.g. not `'eng'`, not `'EN'`).
3. **Configuration before input.** An unconfigured client called with invalid input (`placeId: 0`, a NaN bbox) reports `configuration`, not `invalid_request`.
4. **Factory robustness.** `createWikimapiaClient(undefined as unknown as WikimapiaClientOptions)` and `null` (cast) do not throw, and every call resolves to `configuration` with zero requests.
5. **Only the four data fields are validated.** Options with an extra unknown key (cast) and options with `language: undefined`, `retryLimit: undefined`, `fallbackWaitSeconds: undefined` are valid: the call succeeds and the defaults apply (no `language` parameter sent; see 7 for the limits). Passing `transport` and `clock` never produces a configuration failure (the strict config schema must not see them).
6. **Trimmed key (1.4.1).** `apiKey: '  wm-trim-test-key  '` sends `key` exactly `wm-trim-test-key` (`params(0).get('key')`). A failure built from a debug answer that echoes the trimmed key (e.g. `answer({ debug: { message: 'Key wm-trim-test-key is not valid' } })`) does not contain the trimmed key.
7. **Defaults.** Without `retryLimit` / `fallbackWaitSeconds`: `rateLimitAnswer(3)` with `repeatLast` gives 6 requests, five sleeps of 3000 and `attempts: 6`; `rateLimitAnswer('a few')` then data gives `sleeps` `[60000]`. With configured `retryLimit: 0` the first rate-limit answer is exhausted after 1 request; with `retryLimit: 2, fallbackWaitSeconds: 10` and `rateLimitAnswer('several')` with `repeatLast`: 3 requests, `sleeps` `[10000, 10000]`.
8. **Input validation (AC-7, AC-8, AC-18, 1.4.2).** `invalid_request`, zero requests, at least one issue whose `path[0]` is the field, and a message starting with `Invalid request`: bbox cases (west = east, west > east, south >= north, out-of-range longitude and latitude, NaN west), `page` 0 / -1 / 1.5, `pageSize` 0 / 101 / 2.5, `placeId` 0 / -5 / 1.5 / NaN. Also: an unknown extra input key (cast) gives `invalid_request`; an input of `undefined` or `null` (cast) gives `invalid_request` with no throw.
9. **Page size (AC-3, AC-4).** No `pageSize` sends `count=100` (`DEFAULT_PAGE_SIZE`); `pageSize: 25` with `page: 3` sends `count=25`, `page=3` and `bbox` W,S,E,N.
10. **Language (AC-5).** With `language: 'en'` both functions send `language=en`; without it neither sends a `language` parameter.
11. **Wiring of both functions.** `listPlaces` sends `function=box` and returns the Listing Page of `box-belgrade-page1.json` (`pageSize` 10, `totalFound` 290); `getPlaceDetails` sends `function=place.getbyid` with `id` and returns Place Details for `getbyid-62587.json`. Each success passes the matching result schema and has keys `['ok','value']`.
12. **Default transport, stubbed `fetch` (AC-38, 1.4.1 last bullet).** A client created **without** `transport` (with an injected `SimulatedClock`): creation does not call `fetch`; a `getPlaceDetails` call with `fetch` mocked to resolve a `Response` with the `getbyid-62587.json` body succeeds, and `fetch` was called once with a URL whose `key` is the configured test key. With `fetch` mocked to reject (error message containing the keyed URL), the call resolves to `connection` with no `status` and no leak. With an injected transport, `fetch` is never called (AC-38 mirror).
13. **Default clock, fake timers.** A client created **without** `clock` (injected `SimulatedWikimapia` answering `rateLimitAnswer(7)` then data), under `vi.useFakeTimers()`: the call is still pending with one request after advancing 6999 ms, and resolves to success with two requests after advancing the remaining time.
14. **Never rejects.** A transport that throws synchronously and a clock whose `sleep` rejects: both calls resolve (`connection` and `unexpected_response` respectively). Use `await expect(promise).resolves` style.
15. **No shared state.** Two clients with different keys and one client called twice: each call gets its own full retry budget, and requests of one client never carry the other client's key.

Run both new test files once and confirm they fail only because `src/wikimapia/runtime.ts` and `src/wikimapia/client.ts` do not exist yet.

### 2.2 add-coder

1. **Create `src/wikimapia/runtime.ts`** per AL4 1.3 (`runtime.ts` block) and 1.4.10. Export exactly `DEFAULT_REQUEST_TIMEOUT_MS`, `MAX_TIMER_DELAY_MS`, `createFetchTransport` and `systemClock`, with the 1.3 signatures.
   - `createFetchTransport(options?)`: the default for `timeoutMs` is `DEFAULT_REQUEST_TIMEOUT_MS`. The returned transport reads `globalThis.fetch` **at call time**, calls it with the request URL and an init of `method: 'GET'`, `redirect: 'follow'`, `signal: AbortSignal.timeout(timeoutMs)`, and returns `{ status: response.status, body: await response.text() }`. No headers, no logging, no try/catch: rejections propagate (`execute.ts` maps them). Creating the transport must not call `fetch`.
   - `systemClock.sleep(ms)`: waits the full `ms` in successive chunks of at most `MAX_TIMER_DELAY_MS`, so delays above the Node timer limit are not clamped to 1 ms. A non-positive `ms` resolves without a long wait. Use `setTimeout` from `node:timers/promises` (AL4 1.4.10). **Routing clarification:** the faked-timer tests (runtime group 8 to 10, client group 13) are the arbiter. If Vitest's fake timers do not intercept the `node:timers/promises` import in this setup, wrap the global `setTimeout` in a promise instead; the behaviour is identical and no dependency is added. State which variant you used in your hand-off.
2. **Create `src/wikimapia/client.ts`** per AL4 1.2 steps 1 to 3, 1.4.1 and 1.4.2. Export `createWikimapiaClient`, typed so that it is assignable to `CreateWikimapiaClientFn`, and re-export `createFetchTransport` and `systemClock` from `./runtime.js`. Export nothing else.
3. **Resolve the configuration once, at creation (1.4.1).** The factory never throws.
   - Read the options through a widened, `unknown`-safe view (the runtime value may be `{}`, `undefined` or `null` despite the declared type; a guard on a field typed as non-optional `string` would also trip `no-unnecessary-condition`). A non-object `options` is treated as an empty one.
   - Copy only `apiKey`, `language`, `retryLimit` and `fallbackWaitSeconds` into a fresh object, omitting keys whose value is `undefined`. Never pass `transport`, `clock` or unknown keys to `ClientConfigSchema`.
   - `ClientConfigSchema.safeParse` that object. On success, use the **parsed** values (trimmed `apiKey`) and fill in `retryLimit ?? DEFAULT_RETRY_LIMIT`, `fallbackWaitSeconds ?? DEFAULT_FALLBACK_WAIT_SECONDS`, `transport ?? createFetchTransport()`, `clock ?? systemClock`. Build the `ExecuteDeps` object once.
   - On failure, keep a `configuration` failure whose message is `describeIssues('Wikimapia client is not configured', toFailureIssues(error.issues))`. It contains paths and Zod messages only, never a value. Pass it through `redactFailure` with the trimmed key when `apiKey` is a non-empty string after trimming, otherwise with `''`.
   - Do not validate `transport` or `clock` further. A broken injected transport or clock is already handled by `execute.ts` (connection or internal error).
4. **Each public method (1.2 steps 1 to 4).** In this order:
   1. If the configuration failed, resolve to `{ ok: false, failure }` with the stored configuration failure. No input validation, no transport call.
   2. `ListPlacesInputSchema.safeParse(input)` / `PlaceDetailsInputSchema.safeParse(input)`. On failure, resolve to `invalid_request` with `issues: toFailureIssues(error.issues)` and `message: describeIssues('Invalid request', issues)`, passed through `redactFailure(failure, apiKey)` (1.2 step 5 covers every failure). Nothing is sent.
   3. Build the URL once from the **parsed** input: `buildBoxUrl` with `pageSize: parsed.pageSize ?? DEFAULT_PAGE_SIZE`, or `buildPlaceDetailsUrl`. Add the `language` key only when configured (`exactOptionalPropertyTypes`).
   4. Return `executeRequest(url, interpretBoxAnswer | interpretPlaceDetailsAnswer, deps)`.
   - The return types are the contract's `Promise<ListPlacesResult>` and `Promise<PlaceDetailsResult>` (U4 verified that `ClientResult<T>` is assignable).
5. **Never rejects (1.4.8 last bullet, method side).** Guard steps 2 to 4 of each method so that any unanticipated exception becomes `unexpected_response` with `issues: [{ path: [], message: 'internal client error' }]` and a message built with `describeIssues('Unexpected Wikimapia response', issues)` (the same wording as `execute.ts`), redacted. The caught value is never copied. Observe `require-await`: a method that awaits nothing must not be `async`.
6. **No state between calls (1.5).** No caches, counters or pacing; nothing module-level except constants. Creating a client sends nothing and calls no `fetch`.
7. **Style.** AL4 "5. AL2 Guidance": `String(n)` in template literals, no non-null assertions, no `any`, no `console.*`, no floating promises, catch variables treated as `unknown`, never `.parse` (always `safeParse`).
8. **Scope of changes.** Create only `src/wikimapia/runtime.ts` and `src/wikimapia/client.ts`. Do not modify any U1 to U4 source or test file. If a contract test fails because of a U1 to U4 module, report the failing test and the module instead of patching around it in `client.ts`; a fix there is a separate corrective run. Do not add dependencies or touch `package.json`.

### 2.3 Done when (full feature DoD)

All of the following hold, run from the repo root:

- `pnpm exec vitest run --no-color tests/wikimapia/runtime.test.ts tests/wikimapia/client.test.ts` passes.
- `pnpm exec vitest run --no-color contracts` passes **101/101**: all 66 behavioural tests in `contracts/wikimapia-client.test.ts` and all 35 in `contracts/wikimapia-client.schema.test.ts`.
- `pnpm exec vitest run --no-color` (the whole suite: `contracts/` and `tests/`) passes with no failures and no skipped or todo tests; every U1 to U4 unit test that passed before still passes.
- `pnpm exec tsc --noEmit` reports **0 errors**. The baseline error about the unresolved `../src/wikimapia/client.js` import is gone.
- `pnpm lint` reports **0 problems** (0 errors and 0 warnings) over the whole repo.
- No test touches the real network: the default `fetch` transport is exercised only with `globalThis.fetch` stubbed via `vi.spyOn`, and AC-38 confirms that an injected transport never calls `fetch`. No test waits on real timers.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/wikimapia/`, the support file and both contract test files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test.
- If a contract schema, a support double or the AL4 spec appears wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing). Do not work around it locally.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.
- Use only `TEST_API_KEY` and synthetic values in tests. Never use a real API key, never let `fetch` reach the network, never wait on real timers.

## 4. Out of Scope

Do not implement any of the following now:

- U1 to U4 (done): issue mapping, normalisation, answer interpretation, URL building, redaction, the transport/status/rate-limit loop. Do not change their behaviour or re-implement any of it in `client.ts` (no second retry loop, no second redaction layer beyond the two failures `client.ts` creates itself, no re-validation of Wikimapia answers).
- Any change to the contract-fixed base URL (`http://`): the HTTPS question in AL4 section 3 is an AL5 matter for the orchestrator.
- Crawl orchestration, page walking, checkpointing, exponential backoff for `connection` failures, logging or observability wrappers (substep 3), storage and migrations (substep 2), embeddings (substep 4).
- The HTTP framework decision in `CLAUDE.md` stays open: this feature is a client, not a server.
