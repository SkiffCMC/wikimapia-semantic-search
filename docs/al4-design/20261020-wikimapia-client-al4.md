# AL4 Design: Wikimapia API Client

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **AL6 source:** `docs/al6-requirements/20261020-wikimapia-client-al6.md` (AC-1 .. AC-50)
- **AL5 sources:** `contracts/wikimapia-client.schema.ts` (types, schemas, `ENTRY_POINT`), `contracts/wikimapia-client.test.ts` (behavioural tests), `contracts/wikimapia-client.schema.test.ts` (schema/fixture tests), `contracts/wikimapia-client.support.ts` (Simulated Wikimapia, Simulated Clock, fixture loaders), `contracts/fixtures/wikimapia/`
- **Binding rules:** `.agrules` sections 1 (Offline Ingestion), 2 (Zod-validated boundaries), 4 (Licensing, No Commenter IPs, Recorded API Fixtures, No Live External Calls in Tests, Strict Types), 5 (Code Style: extensionless relative imports, types in `types.ts`)
- **Status:** Ready for AL3 Routing

## 0. Scope and Fixed Points

This design covers a pure, stateless TypeScript library inside the "Data pipeline" component. It contains no database, no HTTP server and no crawl orchestration.

Fixed by AL5, not to be changed by AL3/AL2:

| Item | Value |
|---|---|
| Entry point | `src/wikimapia/client.ts` exports `createWikimapiaClient: CreateWikimapiaClientFn` |
| Public types | `WikimapiaClientOptions`, `WikimapiaClient`, `ListPlacesInput`, `PlaceDetailsInput`, `ListPlacesResult`, `PlaceDetailsResult`, `ClientFailure`, `WikimapiaTransport`, `Clock` (all from the schema file) |
| Constants | `WIKIMAPIA_API_URL`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `DEFAULT_RETRY_LIMIT`, `DEFAULT_FALLBACK_WAIT_SECONDS`, `PLACE_DETAILS_DATA_BLOCKS` |
| Validators | `parseRateLimitMessage`, `isWikimapiaPlaceUrl` (reuse them; do not re-implement) |

**Single source of truth.** Every `src/wikimapia/*` module imports schemas, types and constants from `../../contracts/wikimapia-client.schema`. AL2 must not copy or redefine any of them. Use `import type` for type-only imports (`verbatimModuleSyntax`).

**Code style (`.agrules` section 5).**

- **Extensionless relative imports.** `tsconfig.json` uses `"module": "preserve"` + `"moduleResolution": "bundler"`. Relative imports carry no extension: `from './issues'`, `from '../../contracts/wikimapia-client.schema'`, never `'./issues.js'` or `'./issues.ts'`. Runnable scripts go through `tsx` or a build step, not plain `node`.
- **Types in `types.ts`.** Every type alias and interface declared in `src/wikimapia/` lives in `src/wikimapia/types.ts` (section 1.3) and is imported with `import type { ... } from './types'`. The other `src/wikimapia/*` modules declare and export no types. Types inferred from Zod schemas (`z.infer`) stay in `contracts/wikimapia-client.schema.ts` and are imported from there, not re-exported through `types.ts`.

**HTTP framework:** not needed here, because this feature is a client and not a server. The open decision in `CLAUDE.md` stays open.

**New dependencies:** none. The default transport uses Node 22's global `fetch`, and the default clock uses `node:timers/promises`.

## 1. Architecture & Subsystems

### 1.1 Module map

Files lower in the table depend only on files above them. `types.ts` was added by the 2026-10-21 code-style refactor (section 4); the other files were created in U1 to U5.

| File | Kind | Responsibility | Exports (internal unless marked public) |
|---|---|---|---|
| `src/wikimapia/types.ts` | types only | Holds every type alias and interface declared in `src/wikimapia/`. It has no runtime code and imports only `import type` from the schema file. | type `Normalized<T>`, type `Interpretation<T>`, type `ClientResult<T>`, interface `ExecuteDeps`, type `TransportOutcome` (used by `execute.ts` only), type `Resolved` (used by `client.ts` only) |
| `src/wikimapia/issues.ts` | pure | Turns Zod issues into contract `FailureIssue`s and formats paths for messages. | `toFailureIssues`, `formatIssuePath`, `describeIssues`, `MAX_REPORTED_ISSUES` |
| `src/wikimapia/normalize.ts` | pure | Maps validated raw wire objects to strict output objects. Runs the semantic checks that Zod wire schemas cannot express. Gates the result with the contract output schemas. | `normalizeListingPage`, `normalizePlaceDetails`, `normalizeComment` |
| `src/wikimapia/interpret.ts` | pure | Classifies one HTTP body: data, rate limit, Wikimapia error or unexpected response. | `interpretAnswer`, `interpretBoxAnswer`, `interpretPlaceDetailsAnswer` |
| `src/wikimapia/request.ts` | pure | Builds request URLs. | `buildBoxUrl`, `buildPlaceDetailsUrl` |
| `src/wikimapia/redact.ts` | pure | Removes the API key and keyed request addresses from any failure text. | `redactSecrets`, `redactFailure` |
| `src/wikimapia/execute.ts` | async core | Runs one client call: transport, status check, interpretation, rate-limit wait/retry loop, failure redaction. | `executeRequest` |
| `src/wikimapia/runtime.ts` | I/O defaults | Real transport (global `fetch`) and real clock. Used only when the Operator injects none. | `createFetchTransport`, `systemClock`, `DEFAULT_REQUEST_TIMEOUT_MS`, `MAX_TIMER_DELAY_MS` |
| `src/wikimapia/client.ts` | factory (**public**) | Resolves configuration and validates input, then composes the modules above. | `createWikimapiaClient` (public). It may also re-export `createFetchTransport` and `systemClock` for Operators. |

Unit tests go in `tests/wikimapia/<module>.test.ts`. Tests import `src/wikimapia` modules extensionless (e.g. `../../src/wikimapia/execute`) and take the internal types (`Normalized`, `Interpretation`, `ClientResult`, `ExecuteDeps`) from `../../src/wikimapia/types` with `import type`. They may import the contract support module (`../../contracts/wikimapia-client.support`) for fixtures, `SimulatedWikimapia`, `SimulatedClock`, `addCommenterIps` and `at`. They must never edit anything under `contracts/`.

### 1.2 Call flow (both functions)

```
listPlaces(input) / getPlaceDetails(input)
  1. config resolved? ── no ──> { ok:false, failure: configuration }          (AC-31, nothing sent)
  2. Input schema safeParse ── fail ──> invalid_request (issues from Zod)      (AC-7, AC-8, AC-18, nothing sent)
  3. url = buildBoxUrl(...) | buildPlaceDetailsUrl(...)                         (built ONCE; reused on retry, AC-22)
  4. executeRequest(url, interpretBoxAnswer | interpretPlaceDetailsAnswer, deps)
       loop attempt = 1, 2, ...
         a. transport({ url })  ── rejects/throws ──> connection (no status)    (AC-33)
         b. TransportResponseSchema.safeParse ── fail ──> unexpected_response, path []
         c. status outside 200..299 ──> connection { status }                   (AC-33)
         d. interpret(body):
              data            ──> { ok:true, value }
              wikimapia_error ──> wikimapia_error (no retry)                     (AC-32)
              unexpected      ──> unexpected_response (no retry)                 (AC-34, AC-35, AC-46)
              rate_limit      ──> wait = waitSeconds ?? fallbackWaitSeconds
                                  if attempt > retryLimit ──> rate_limit_exhausted { attempts: attempt, lastWaitSeconds: wait }
                                  if wait > 0: await clock.sleep(round(wait * 1000))
                                  continue loop                                  (AC-22..AC-28, AC-30, AC-48, AC-49)
  5. Every failure goes through redactFailure(failure, apiKey) before it is returned  (AC-36)
```

### 1.3 Component contracts (signatures)

```ts
// types.ts  (types only; no runtime code)
import type { ClientFailure, Clock, FailureIssue, WikimapiaTransport } from '../../contracts/wikimapia-client.schema';
export type Normalized<T> = { ok: true; value: T } | { ok: false; issues: FailureIssue[] };
export type Interpretation<T> =
  | { kind: 'data'; value: T }
  | { kind: 'rate_limit'; waitSeconds: number | undefined }
  | { kind: 'wikimapia_error'; message: string }
  | { kind: 'unexpected'; issues: FailureIssue[] };
export type ClientResult<T> = { ok: true; value: T } | { ok: false; failure: ClientFailure };
export interface ExecuteDeps {
  transport: WikimapiaTransport; clock: Clock; apiKey: string;
  retryLimit: number; fallbackWaitSeconds: number;
}
export type TransportOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };   // execute.ts only
export type Resolved =                                                                              // client.ts only
  | { ok: true; deps: ExecuteDeps; language: string | undefined }
  | { ok: false; failure: ClientFailure };

// issues.ts
export const MAX_REPORTED_ISSUES = 20;
export function toFailureIssues(issues: readonly z.core.$ZodIssue[]): FailureIssue[];   // >= 1 when input non-empty, capped at 20
export function formatIssuePath(path: readonly (string | number)[]): string;           // ['comments',0,'replies',0,'name'] -> 'comments[0].replies[0].name'; [] -> '(whole answer)'
export function describeIssues(prefix: string, issues: readonly FailureIssue[]): string; // 'prefix: <path>: <message>' for the first issue, plus ' (+N more)'

// normalize.ts   (import type { Normalized } from './types')
export function normalizeListingPage(raw: RawBoxResponse): Normalized<ListingPage>;
export function normalizePlaceDetails(raw: RawPlaceDetails): Normalized<PlaceDetails>;
export function normalizeComment(raw: RawComment): Comment;                              // recursive

// interpret.ts   (import type { Interpretation, Normalized } from './types')
export function interpretAnswer<S extends z.ZodType, T>(
  body: string, rawSchema: S, normalize: (raw: z.output<S>) => Normalized<T>,
): Interpretation<T>;
export function interpretBoxAnswer(body: string): Interpretation<ListingPage>;
export function interpretPlaceDetailsAnswer(body: string): Interpretation<PlaceDetails>;

// request.ts
export function buildBoxUrl(p: { apiKey: string; language?: string; bbox: BoundingBox; page: number; pageSize: number }): string;
export function buildPlaceDetailsUrl(p: { apiKey: string; language?: string; placeId: number }): string;

// redact.ts
export function redactSecrets(text: string, apiKey: string): string;
export function redactFailure(failure: ClientFailure, apiKey: string): ClientFailure;

// execute.ts     (import type { ClientResult, ExecuteDeps, Interpretation, TransportOutcome } from './types')
export function executeRequest<T>(
  url: string, interpret: (body: string) => Interpretation<T>, deps: ExecuteDeps,
): Promise<ClientResult<T>>;                                                             // never rejects

// runtime.ts
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export function createFetchTransport(options?: { timeoutMs?: number }): WikimapiaTransport;
export const systemClock: Clock;

// client.ts      (import type { Resolved } from './types'; ExecuteDeps is used here only inside Resolved, so importing it too fails lint as unused)
export const createWikimapiaClient: CreateWikimapiaClientFn;
export { createFetchTransport, systemClock } from './runtime';
```

`TransportOutcome` and `Resolved` are exported from `types.ts` only so that their single consumer can import them. They are not part of any other module's surface, and tests should not depend on them. `ClientResult<ListingPage>` and `ClientResult<PlaceDetails>` must be assignable to the contract's `ListPlacesResult` and `PlaceDetailsResult`. If they are not, use the contract types directly.

### 1.4 Detailed behaviour per subsystem

#### 1.4.1 Configuration (`client.ts`, AC-31, AC-49)

- `createWikimapiaClient(options)` **never throws**. It copies only the four data fields (`apiKey`, `language`, `retryLimit`, `fallbackWaitSeconds`) into a fresh object, leaving out keys whose value is `undefined`. It then calls `ClientConfigSchema.safeParse` on that object. `ClientConfigSchema` is a `strictObject`, so passing `transport` or `clock` to it would fail. At runtime `options` may lack `apiKey`, because the AC-31 test casts `{}`.
- On success it uses the **parsed** values. `apiKey` is trimmed by the schema, and that trimmed key is the one sent and redacted. It fills in defaults: `retryLimit ?? DEFAULT_RETRY_LIMIT`, `fallbackWaitSeconds ?? DEFAULT_FALLBACK_WAIT_SECONDS`, `transport ?? createFetchTransport()`, `clock ?? systemClock`.
- On failure it still returns a client. Every call of that client resolves to `{ ok: false, failure: { kind: 'configuration', message } }` before any input validation or transport call. The message is built from issue paths and Zod messages only (e.g. `Wikimapia client is not configured: apiKey: API key is required`) and never contains a value. An invalid `language` or a negative `retryLimit` is also reported as `configuration`, because it is the only kind that fits.
- The default transport is created lazily or as a closure that reads `globalThis.fetch` at call time. Merely creating a client must never call `fetch` (AC-38).

#### 1.4.2 Input validation (`client.ts`, AC-7, AC-8, AC-18)

- `ListPlacesInputSchema.safeParse(input)` and `PlaceDetailsInputSchema.safeParse(input)` run after the configuration check. On failure: `{ kind: 'invalid_request', message: describeIssues('Invalid request', issues), issues: toFailureIssues(error.issues) }`. Zod already produces paths such as `['bbox','east']`, `['bbox','west']` (NaN), `['page']`, `['pageSize']` and `['placeId']`, which the tests check by first element.
- `pageSize` defaults to `DEFAULT_PAGE_SIZE` (100) after successful parsing (AC-4).

#### 1.4.3 Request building (`request.ts`, AC-3, AC-4, AC-5, AC-17)

- Base: `new URL(WIKIMAPIA_API_URL)` (`https://api.wikimapia.org/`; the scheme comes only from this constant and is never rewritten, so every attempt has protocol `https:`). Parameters are added with `URLSearchParams.set` (never string concatenation), in this order:
  - common: `function`, `key`, `format=json`, then `language` **only if configured**;
  - `box`: `bbox = [west, south, east, north].map(String).join(',')`, `page = String(page)`, `count = String(pageSize)`;
  - `place.getbyid`: `id = String(placeId)`, `data_blocks = PLACE_DETAILS_DATA_BLOCKS.join(',')`.
- `URLSearchParams` encodes `,` as `%2C`. Wikimapia (PHP) decodes it, and the tests read the values back through `searchParams.get`. Do not add `pack=gzip`.
- The URL string is built once per call and passed unchanged to every attempt, so a retry is an identical request (AC-22: `requests[1].url === requests[0].url`).

#### 1.4.4 Answer interpretation (`interpret.ts`, AC-16, AC-24, AC-32, AC-34, AC-35, AC-37, AC-46)

Pseudo-code:

```
interpretAnswer(body, rawSchema, normalize):
  try parsed = JSON.parse(body)                        // parsed: unknown
  catch -> unexpected [{ path: [], message: 'Wikimapia answer is not valid JSON' }]
         // NEVER include the SyntaxError message: Node 22 quotes a snippet of the body,
         // which can contain a keyed URL (AC-36) or comment data (AC-37).
  debug = RawDebugResponseSchema.safeParse(parsed)
  if debug.success:                                    // debug envelope WINS over any data next to it (AC-37 case 3)
    info = parseRateLimitMessage(debug.data.debug.message)
    return info.isRateLimit ? { kind: 'rate_limit', waitSeconds: info.waitSeconds }
                            : { kind: 'wikimapia_error', message: debug.data.debug.message }
  raw = rawSchema.safeParse(parsed)
  if !raw.success -> unexpected toFailureIssues(raw.error.issues)
  n = normalize(raw.data)
  return n.ok ? { kind: 'data', value: n.value } : { kind: 'unexpected', issues: n.issues }
```

- A body of `[]` (as `place.getbyarea` returns) fails the raw object schema with path `[]`, which gives an unexpected response (AC-35).
- A rate-limit answer is never returned as data and never reported as unexpected (AC-24), because the debug check runs before any data schema.
- If `debug` is present but malformed (e.g. `debug: "x"`), the debug schema fails and the body falls through to the data schema, which reports it as unexpected.

#### 1.4.5 Issue mapping (`issues.ts`)

- `path`: each Zod path element is kept as is when it is a `string` or `number`. A `symbol` becomes `symbol.description ?? 'symbol'`, because Zod 4 paths are `PropertyKey[]`.
- `message`: the Zod issue message. Zod 4 default messages state the expected type and the received type, not the received value. Do **not** enable `reportInput`, and never copy `issue.input` or any other field. If a message is empty, use `'invalid value'`, because `FailureIssueSchema.message` must be non-empty.
- The result is capped at `MAX_REPORTED_ISSUES` (20), in Zod order. It always has at least one entry: when Zod reports none, use `[{ path: [], message: 'invalid value' }]`.
- Expected paths, matching the contract tests: `['title']`, `['comments',1,'name']`, `['id']` (union failure on `"abc"`, `1.5`, `-3`), `['folder',0,'id']`, `['found']`, `['comments',0,'replies',0,'good']`, `['comments',0,'replies',0,'replies',0,'name']`. Zod produces these natively through the recursive `replies` getter. The failure `message` (via `describeIssues`) contains the formatted path, e.g. `comments[0].replies[0].replies[0].name`. That satisfies AC-46's "indicating that it is inside a Reply".

#### 1.4.6 Normalisation (`normalize.ts`, AC-1, AC-2, AC-9 .. AC-16, AC-19 .. AC-21, AC-42 .. AC-47)

**Rule: allow-list construction only.** Raw schemas are `looseObject`s, so their parsed output still carries unknown keys (`urlhtml`, `gadm`, `x`, `y`, `pl`, `user_ip`, ...). Every output object must be built field by field from the tables in section 2. **Never spread a raw object or a raw sub-object.** This one rule makes AC-11, AC-16 and AC-45 hold.

Helpers (private):

- `toWhole(v: number | string): number`: returns `v` if it is a number, otherwise `Number(v)`. The raw schemas already guarantee digits.
- `presentText(v: string | null | undefined): string | undefined`: returns `undefined` for `null`, `undefined` or `''`, otherwise `v` unchanged. It does not trim (AL6 rule 6). Optional output keys are attached only when the value is defined, using conditional assignment or `...(x === undefined ? {} : { key: x })` (`exactOptionalPropertyTypes`: the key must be **absent**, never `undefined`).

Semantic checks: the wire schemas cannot express these. Each failed check produces an issue with a **raw** path.

| Check | Raw path | Message |
|---|---|---|
| `toWhole(page) >= 1` | `['page']` | `page must be at least 1` |
| `1 <= toWhole(count) <= MAX_PAGE_SIZE` | `['count']` | `count must be between 1 and 100` |
| `Number.isSafeInteger(toWhole(found))` | `['found']` | `found is not a safe whole number` |
| `Number.isSafeInteger(toWhole(folder[i].id))` | `['folder', i, 'id']` | `id is not a safe whole number` |
| `isWikimapiaPlaceUrl(folder[i].url, id)` | `['folder', i, 'url']` | `url is not the Wikimapia page link of this place` |
| `Number.isSafeInteger(toWhole(id))` (details) | `['id']` | as above |
| `Number.isSafeInteger(toWhole(parent_id))` | `['parent_id']` | as above |

If any check fails, return `{ ok: false, issues }` with no partial value. Otherwise build the output.

**Output gate:** the built object is passed through `ListingPageSchema.safeParse` / `PlaceDetailsSchema.safeParse`, and `.data` is returned. A gate failure means a mapping bug or an unforeseen value. It is returned as `{ ok: false, issues }` with the output-side paths, each message prefixed `output check: `. Contract tests never reach this path.

#### 1.4.7 Rate limiting and retries (`execute.ts`, AC-22 .. AC-30, AC-48, AC-49)

- Only `rate_limit` interpretations are retried. Connection failures, Wikimapia errors and unexpected responses return immediately (AL6 rule 2).
- Wait time: `info.waitSeconds` when readable, otherwise `fallbackWaitSeconds`. It is **not capped** (AC-48) and has **no safety margin**: the tests require exactly the stated value.
- `clock.sleep(Math.round(wait * 1000))` is awaited before the next attempt, so nothing is sent while waiting (AC-30). When the wait is `0`, `sleep` is **not called** (AC-28: "retries without waiting").
- Attempt counting: there are at most `retryLimit + 1` requests. When the rate-limit answer of attempt `retryLimit + 1` arrives, the client returns `rate_limit_exhausted` with `attempts = retryLimit + 1` and `lastWaitSeconds = wait` (the stated or fallback value of that last answer), and **does not sleep** (AC-26). With `retryLimit = 0`, the first rate-limit answer is immediately exhausted with no sleep (AC-24).
- Failure messages are fixed templates, e.g. `Wikimapia rate limit still in effect after ${String(attempts)} attempts (last wait ${String(lastWaitSeconds)} s)`. They never contain the URL.
- No proactive pacing and no shared quota state between calls (AL6 rule 3). Concurrent calls each run their own loop.

#### 1.4.8 Transport and failure mapping (`execute.ts`, AC-33, AC-34)

- Call the transport inside `try { await deps.transport({ url }) }`, so that both rejection and a synchronous throw are caught. Either one becomes `{ kind: 'connection', message: 'Wikimapia could not be reached' }` with **no** `status` key. The error's own message is never copied, because it contains the URL (the Simulated Wikimapia deliberately puts the keyed URL in it). The message may include `error.cause.code` when it is a string matching `/^[A-Z][A-Z0-9_]*$/` (e.g. `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `TimeoutError`), which helps crawl diagnostics.
- The transport's result is validated with `TransportResponseSchema` (boundary rule). If it fails: `unexpected_response`, path `[]`, `transport returned a malformed response`.
- A `status` outside 200..299 gives `{ kind: 'connection', message: 'Wikimapia answered with HTTP status N', status }`. The body is not inspected.
- **Never rejects:** the whole body of `executeRequest` and of each public client method is guarded. Any exception not anticipated above (including a rejecting `clock.sleep` or a mapping bug) becomes `unexpected_response` with path `[]` and the fixed message `internal client error`. Its original message is not copied. Contract tests never reach this guard.

#### 1.4.9 Secret redaction (`redact.ts`, AC-36, AC-37)

`redactFailure` is applied to **every** failure, of every kind, as the last step before it is returned. It maps `redactSecrets` over `message`, `wikimapiaMessage` and every `issues[i].message`, and over the string elements of `issues[i].path`.

```
redactSecrets(text, apiKey):
  1. replace every /https?:\/\/[^\s"'<>]+/g match that contains 'key=' or apiKey -> '[request address removed]'
  2. replace /[?&]key=[^&\s"'<>]*/gi                                              -> '[key removed]'
  3. text.split(apiKey).join('[key removed]')   (only if apiKey !== ''; split/join, NOT a RegExp built from the key)
```

- `wikimapiaMessage` is "Wikimapia's own message text, unchanged" (contract). It is reported verbatim **unless** it contains the key or a keyed address, in which case only those substrings are replaced. AC-32 (`'Invalid API key.'` unchanged) and AC-36 (`Key <key> is not valid` with no key in the output) are both satisfied. This is how the design reconciles the two clauses; it does not contradict them.
- IP safety (AC-37) comes from the issue-mapping rules (no input values), the debug-first rule (a Wikimapia error never echoes the rest of the body) and the no-SyntaxError-message rule. No IP-specific scrubbing is needed. A path element `'user_ip'` (a key name, not a value) may legitimately appear, e.g. for the wrongly typed `user_ip` in AC-37 case 2.
- Known trade-off: a very short API key (e.g. `k`) would mangle failure text where that character appears. This is accepted, because security takes precedence.

#### 1.4.10 Runtime defaults (`runtime.ts`, AC-38)

- `createFetchTransport({ timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS })` returns `async ({ url }) => { const res = await globalThis.fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) }); return { status: res.status, body: await res.text() }; }`. Rejections (DNS, refused connection, timeout abort) propagate, and `execute.ts` maps them to `connection`. It sets no custom headers and does not log.
- `systemClock.sleep(ms)` awaits `setTimeout` from `node:timers/promises` in chunks of at most `MAX_TIMER_DELAY_MS`. Node clamps larger delays to 1 ms, and AC-48 allows waits of any length.
- Tests never use these defaults through the client. Their own unit tests mock `globalThis.fetch` with `vi.spyOn` and use `vi.useFakeTimers()`. **No real network call in any test.**

### 1.5 Transaction boundaries

There is no database, so there are no DB transactions. The unit of atomicity is **one client call**:

- It resolves to exactly one `ClientResult`: a fully validated value, or one failure with **no partial data** (AC-35, AC-46). The failure object has only the keys `ok` and `failure`.
- It has no side effects other than the HTTP GETs it sends (1 .. `retryLimit + 1`) and the clock waits. No state is kept between calls: no cache and no quota tracker.
- Both Wikimapia functions are read-only GETs, so retrying the identical request is safe.

## 2. Data Model Design (Declarative)

**Database:** no schema changes, no migrations, no Knex/Objection models in this feature (substep 2 designs storage, informed by the output types below). The "data model" here is the wire-to-output mapping. All types are `z.infer` of the AL5 schemas.

### 2.1 `box` -> `ListingPage`

| Output | Raw source | Rule |
|---|---|---|
| `page` | `page` | `toWhole`; must be >= 1. The value is the one **reported** by Wikimapia, not the one requested. |
| `pageSize` | `count` | `toWhole`; 1..100. Reported value (fixture: 10 although 100 was requested). |
| `totalFound` | `found` | `toWhole` (`"290"` -> 290) |
| `places[i]` | `folder[i]` | order preserved |
| `.placeId` | `.id` | `toWhole` (`"1381893"` -> 1381893) |
| `.name` | `.name` | unchanged |
| `.url` | `.url` | unchanged; must satisfy `isWikimapiaPlaceUrl(url, placeId)` (licensing back-link) |
| `.location` | `.location` | exactly `{ lon, lat, north, south, east, west }` |
| `.outline[j]` | `.polygon[j]` | `{ lon: x, lat: y }`, order preserved |

### 2.2 `place.getbyid` -> `PlaceDetails`

| Output | Raw source | Rule |
|---|---|---|
| `placeId` | `id` | `toWhole` |
| `title`, `description` | same | unchanged (HTML entities and `\r\n` kept) |
| `tags[i]` | `tags[i]` | `{ id, title }` only |
| `parentPlaceId` | `parent_id` | absent when `toWhole(parent_id) === 0`, else the whole number (AC-15) |
| `isBuilding`, `isRegion`, `isDeleted` | `is_building`, `is_region`, `is_deleted` | unchanged |
| `wikipediaUrl` | `wikipedia` | `presentText`; absent for null, missing or `''` (AC-13) |
| `outline[j]` | `polygon[j]` | `{ lon: x, lat: y }` |
| `location` | `location` | `{ lon, lat, north, south, east, west }` plus optional `street`, `houseNumber` (from `housenumber`), `city`, `place`, `state`, `country`, each through `presentText` |
| `comments[i]` | `comments[i]` | `normalizeComment`, order preserved |

Dropped: `object_type`, `language_*`, `urlhtml`, `x`, `y`, `pl`, `location.country_adm_id`, `location.gadm`, `location.city_id`, `location.cityguideDomain`, `location.zoom`, and anything else not listed.

### 2.3 Comment / Reply (`normalizeComment`, recursive)

| Output | Raw | Rule |
|---|---|---|
| `placeId` | `place_id` | unchanged (a nested reply may carry another place's id, e.g. 55; it is kept as is) |
| `num`, `langId` | `num`, `lang_id` | unchanged |
| `author` | `name` | unchanged, kept for CC BY attribution |
| `authorUserId` | `user_id` | unchanged (0 = anonymous) |
| `authorPhotoUrl` | `user_photo` | `presentText` (absent for `''`) |
| `message` | `message` | unchanged |
| `goodVotes`, `badVotes` | `good`, `bad` | unchanged |
| `isBlocked`, `isDeleted` | `block`, `is_deleted` | unchanged; replies of blocked or deleted comments are kept in full (AC-47) |
| `postedAtEpochSeconds` | `date` | unchanged |
| `moderatorUserId` | `moder_uid` | unchanged |
| `moderatorName` | `moder_name` | `presentText` (absent for null or `''`) |
| `replies` | `replies` | `replies.map(normalizeComment)`, order preserved, no depth limit (AC-43) |
| (none) | `user_ip` | **never read, never copied**, at any depth (`.agrules` section 4) |

Recursion depth is bounded only by the input. Plain recursion is acceptable: real replies are shallow, the contract tests go 12 levels deep, and Zod's own recursive parse already recurses equally deep.

### 2.4 Indexing and relations

These are not applicable here. For substep 2: `placeId` is the natural key of places, `(placeId, num)` identifies a top-level comment, and replies need a parent reference, because reply `num` uniqueness has not been verified (no real reply has been recorded).

## 3. Batch & External Calls

This feature makes no OpenAI calls and runs no batch job. Its only external system is the Wikimapia API, and every call is a single read-only GET.

| Call | Request | Batch size | Timeout | Retry / backoff | Rate limit |
|---|---|---|---|---|---|
| `box` | `GET https://api.wikimapia.org/?function=box&key=…&format=json[&language=xx]&bbox=W,S,E,N&page=P&count=C` | 1 page per call, `C` = 1..100, default 100 | 30 s per attempt (default transport, `AbortSignal.timeout`); none imposed when a transport is injected | Only on Rate-Limit Response: wait the stated N s (fallback 60 s, no cap), up to `retryLimit` (default 5) retries; no retry on any other failure | Reactive only: no pacing, no quota assumption (AL6 rule 3) |
| `place.getbyid` | `GET …?function=place.getbyid&key=…&format=json[&language=xx]&id=N&data_blocks=main,geometry,location,comments` | 1 place per call | same | same | same |

- **Worst-case latency of one call** = sum of the stated waits (unbounded by design, AC-48) + `(retryLimit + 1) × timeout`. The crawl (substep 3) should be prepared for this.
- **Idempotency and resumability:** both calls are safe reads, and the client keeps no state, so any call can be repeated. Walking pages, checkpointing and resuming belong to substep 3. To support that, failures are typed so that the crawl can decide what to do next. The following guidance is non-binding for this feature:

| Failure kind | Suggested crawl reaction (substep 3) |
|---|---|
| `configuration` | stop the job |
| `invalid_request` | bug in the caller; stop |
| `rate_limit_exhausted` | pause the whole crawl, then resume from the checkpoint |
| `connection` | back off (exponential) and retry later |
| `wikimapia_error` | stop if it concerns the key; otherwise skip the item and log it |
| `unexpected_response` | skip the place, record it for a contract update (AL5 bugfix flow) |

- **Secrets:** the API key travels only in the request URL that is handed to the transport. It never appears in failures (section 1.4.9), and the client does not log. The key travels only over HTTPS: the contract fixes `WIKIMAPIA_API_URL = 'https://api.wikimapia.org/'` (AL5 change approved 2026-10-21), and every request, retries included, must have protocol `https:` (AC-3, AC-17, describe "API key travels encrypted"). HTTP is never used and there is no fallback to it, since Wikimapia does not redirect HTTP to HTTPS. Place links in responses (`http://wikimapia.org/...`) are data and stay unchanged.
- **Licensing:** every returned value is Wikimapia data (CC BY-NC-SA 3.0). Each Place Summary keeps its Wikimapia link, and every comment and reply keeps its author.

## 4. Implementation Units

Units are ordered by dependency. Each one can be routed, tested and implemented in one AL3 -> AL2 iteration, and each has its own unit tests in `tests/wikimapia/`. The behavioural contract file imports `src/wikimapia/client.ts`, so it can only turn green in U5. The ACs listed for U1 to U4 are the ones each unit implements; U5 verifies them end to end.

**Refactor note (2026-10-21, code style, `.agrules` section 5):** behaviour is unchanged. The type aliases and interfaces that U1 to U5 originally declared in their modules (`Normalized<T>` in `normalize.ts`, `Interpretation<T>` in `interpret.ts`, `ClientResult<T>`, `ExecuteDeps` and `TransportOutcome` in `execute.ts`, `Resolved` in `client.ts`) now live in `src/wikimapia/types.ts` (sections 1.1 and 1.3). The source modules no longer export them, and tests import them from `../../src/wikimapia/types` with `import type`. All relative imports in `src/`, `tests/` and `contracts/` are extensionless. Wherever the units below say a module provides one of these types, read it as `types.ts`. This refactor is routed as one corrective unit, not as a new unit here. Done when: `pnpm exec vitest run --no-color tests/wikimapia contracts` is still all green (all contract tests pass: 127 as counted by Vitest on 2026-10-21, since `it.each` cases count separately and the HTTPS change added 3 tests), `pnpm exec tsc --noEmit` reports 0 errors, `pnpm lint` reports 0 problems, and no relative import under `src/` or `tests/` ends in `.js` or `.ts`.

**Baseline caveat for U1 to U4 (historical):** until U5 created `src/wikimapia/client.ts`, `pnpm exec tsc --noEmit` and `pnpm lint` each reported the single known error for the missing `../src/wikimapia/client` import in `contracts/wikimapia-client.test.ts`. "No new errors" in the Done-when lists below means that this is the only error reported.

### U1. Issue mapping and normalisation (pure)

- **Files:** `src/wikimapia/issues.ts`, `src/wikimapia/normalize.ts`, `tests/wikimapia/issues.test.ts`, `tests/wikimapia/normalize.test.ts`
- **Design refs:** 1.4.5, 1.4.6, section 2
- **Implements ACs:** AC-1, AC-2, AC-9 .. AC-16, AC-19 .. AC-21, AC-42 .. AC-47 (mapping side); AC-35 and AC-46 (path format)
- **Unit tests must cover:** University Park summary exactly as in AC-2; the comments of 62587 as in AC-10; nested Mateja -> Serbia -> Paul; 12-level chain; optional values absent for `null` and `''`; `parent_id` `"0"` vs `"7291521"`; extra keys dropped (`Object.keys` allow-list); no `user_ip` at any depth after `addCommenterIps` (check with `findCommenterIpPaths`); semantic-check issues at `['folder',0,'url']`, `['count']`, `['page']`, `['folder',0,'id']` (unsafe integer string); every success value passes the contract output schemas; `toFailureIssues` path formatting, symbol mapping, cap of 20, never empty.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/wikimapia/issues.test.ts tests/wikimapia/normalize.test.ts` passes
  - `pnpm exec vitest run --no-color contracts/wikimapia-client.schema.test.ts` still all green
  - `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (baseline caveat)

### U2. Answer interpretation (pure)

- **Files:** `src/wikimapia/interpret.ts`, `tests/wikimapia/interpret.test.ts`
- **Depends on:** U1
- **Design refs:** 1.4.4
- **Implements ACs:** AC-16, AC-24, AC-32, AC-34, AC-35, AC-37 (interpretation side), AC-46
- **Unit tests must cover:** each fixture body gives `data`; `debug-rate-limit.json` gives `rate_limit` with 7; the "a few seconds" variant gives `rate_limit` with `undefined`; `debug-error.json` gives `wikimapia_error` `'Invalid API key.'`; debug plus comments with IPs gives `wikimapia_error` (no IPs in the result); HTML, `''`, truncated JSON and an HTML body containing a keyed URL each give `unexpected` with path `[]` and no body text in the issues; `[]` gives `unexpected`; the wrong-shape variants give the exact raw paths listed in 1.4.5.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/wikimapia/interpret.test.ts` passes
  - `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (baseline caveat)

### U3. Request URLs and secret redaction (pure)

- **Files:** `src/wikimapia/request.ts`, `src/wikimapia/redact.ts`, `tests/wikimapia/request.test.ts`, `tests/wikimapia/redact.test.ts`
- **Design refs:** 1.4.3, 1.4.9
- **Implements ACs:** AC-3, AC-4 (the URL side; the default comes from U5), AC-5, AC-17, AC-36
- **Unit tests must cover:** host `api.wikimapia.org`; `function`, `format`, `key`; `bbox` order W,S,E,N; `page` and `count`; `language` only when given; `id` and `data_blocks` (set equality); a deterministic URL (two builds give the same string); `redactSecrets` removes the key, keyed URLs and `?key=`/`&key=` fragments (the output matches neither the key nor `/[?&]key=/`), leaves `'Invalid API key.'` unchanged, and handles a key with RegExp metacharacters; `redactFailure` covers `message`, `wikimapiaMessage`, issue messages and paths for all six kinds.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/wikimapia/request.test.ts tests/wikimapia/redact.test.ts` passes
  - `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (baseline caveat)

### U4. Execution core: transport, status, rate-limit loop

- **Files:** `src/wikimapia/execute.ts`, `tests/wikimapia/execute.test.ts`
- **Depends on:** U2 (the interpreters; the `Interpretation` type now comes from `types.ts`), U3 (`redactFailure`)
- **Design refs:** 1.4.7, 1.4.8, 1.5
- **Implements ACs:** AC-22 .. AC-30, AC-32, AC-33, AC-34, AC-36, AC-48, AC-49
- **Unit tests** (use `SimulatedWikimapia` and `SimulatedClock` from the contract support file and a fixed test URL) **must cover:** 7 s wait then success (identical URLs); 3 s + 5 s; defaults of 5 retries (6 requests, 5 sleeps, `attempts: 6`); `retryLimit` 0 (1 request, no sleep); unreadable wait (fallback); wait of 0 (no `sleep` call, still counted); 86400 s; manual-clock ordering `['request','sleep:7000','request']`; unreachable gives `connection` with no `status` key and no URL or key in the failure; statuses 404, 500, 502 and 503 give `connection` with `status`; a malformed transport result gives `unexpected_response`; a throwing transport and a rejecting clock still resolve; no retry for Wikimapia errors or unexpected responses.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/wikimapia/execute.test.ts` passes
  - `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (baseline caveat)

### U5. Runtime defaults and the public factory

- **Files:** `src/wikimapia/runtime.ts`, `src/wikimapia/client.ts`, `tests/wikimapia/runtime.test.ts`, `tests/wikimapia/client.test.ts`
- **Depends on:** U1 .. U4
- **Design refs:** 1.2, 1.4.1, 1.4.2, 1.4.10
- **Implements ACs:** all of them end to end. In particular AC-4 (default 100), AC-7, AC-8, AC-18 (input validation), AC-31 (configuration), AC-38 (no `fetch` when a transport is injected)
- **Unit tests must cover:** `createFetchTransport` with `vi.spyOn(globalThis, 'fetch')` mocked (URL passed, `signal` present, status and body mapped, rejection propagated; **no real network**); `systemClock.sleep` with `vi.useFakeTimers()`, including a delay above `MAX_TIMER_DELAY_MS` that resolves only after the full time; the factory does not throw for `{}`, `apiKey: ''`, `apiKey: '   '` or `language: 'eng'`, and each of these gives `configuration` with zero requests; the trimmed key is sent; creating a client without a transport does not call `fetch`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/wikimapia` passes
  - `pnpm exec vitest run --no-color contracts` passes (all contract tests green; no hard count, since Vitest counts `it.each` cases separately)
  - `pnpm exec tsc --noEmit` reports **0 errors**
  - `pnpm lint` reports **0 problems**

## 5. AL2 Guidance (toolchain pitfalls)

- Module resolution is `"module": "preserve"` + `"moduleResolution": "bundler"`, not `nodenext`. Write relative imports without an extension (`from './types'`, `from '../../contracts/wikimapia-client.schema'`). Do not add `.js` or `.ts`, and do not turn on `allowImportingTsExtensions`.
- Declare no `type` or `interface` outside `src/wikimapia/types.ts`. Import from it with a top-level `import type { ... } from './types'` (`verbatimModuleSyntax`), not with inline `type` specifiers mixed into a value import. A value import of `./types` would be wrong, since the module has no runtime exports. Do not re-export contract `z.infer` types from `types.ts`.
- `strictTypeChecked`: use `String(n)` in template literals (`restrict-template-expressions`); no non-null assertions (use `at`-style guards or `noUncheckedIndexedAccess`-safe loops); a public method with no `await` should not be `async` (`require-await`), so return `Promise.resolve(...)` instead; no floating promises.
- `exactOptionalPropertyTypes`: never assign `undefined` to an optional output key. Leave the key out instead (the contract output schemas use `exactOptional()` and reject an explicit `undefined`).
- Zod 4: `z.core.$ZodIssue` is the issue type; `safeParse(...).error.issues`; never `parse` (which throws) on external data inside the client.
- Do not `console.log` (lint warns, and logs could leak data). Observability belongs to substep 3, which can wrap the injected transport and clock.
- Do not edit `contracts/` or its fixtures. If a contract looks wrong, stop and report it (`.agrules` section 0, Triggered Bugfixing). All relative imports in `src/`, `tests/` and `contracts/` are extensionless (AL5 removed the last `.js` extensions from `contracts/*.ts` on 2026-10-21, as `.agrules` section 5 requires); keep them that way.
