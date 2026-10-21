# AL3 Routing: wikimapia-client, U2 "Answer interpretation (pure)"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** U2 of 5 (depends on U1, which is done and verified)
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`, section 4 "U2. Answer interpretation (pure)"
- **Audience:** `add-test-writer`, then `add-coder`
- **Status:** Routing to AL2 Agents

## 1. Context Manifest

Read these files, and only these, before starting. Follow the project stack and code style they define (Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, pnpm). Match the style of the existing U1 files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding project rules. Section 2 (Zod-validated boundaries) and section 4 (No Commenter IPs, Recorded API Fixtures, No Live External Calls in Tests, Strict Types) apply directly. |
| 2 | `CLAUDE.md` | Stack, decisions, and the Wikimapia API reference (the `debug` rate-limit envelope). |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | The design. Required sections: "0. Scope and Fixed Points", "1.1 Module map" (row `interpret.ts`), "1.2 Call flow" (step 4d only, for context), "1.3 Component contracts (signatures)" (the `interpret.ts` block), "1.4.4 Answer interpretation", "1.4.5 Issue mapping" (expected paths list), "1.4.9 Secret redaction" (the IP-safety bullet only), "4. Implementation Units / U2", "5. AL2 Guidance". |
| 4 | `contracts/wikimapia-client.schema.ts` | Single source of truth: `RawDebugResponseSchema`, `RawBoxResponseSchema`, `RawPlaceDetailsSchema`, `parseRateLimitMessage` (and `RateLimitMessageInfo`), `ListingPage`, `PlaceDetails`, `FailureIssue`/`FailureIssueSchema`, `ListingPageSchema`, `PlaceDetailsSchema`. |
| 5 | `contracts/wikimapia-client.support.ts` | Test helpers to reuse: `fixtureText`, `rawBox`, `rawDetails`, `rateLimitAnswer` (use its `.body`; `'a few'` gives the unreadable-wait variant), `addCommenterIps`, `SYNTHETIC_IPS`, `TEST_API_KEY`, `at`, `FIXTURE_NAMES`. |
| 6 | `src/wikimapia/issues.ts` | U1, as implemented: `toFailureIssues` (reuse; never re-implement). |
| 7 | `src/wikimapia/normalize.ts` | U1, as implemented: `normalizeListingPage`, `normalizePlaceDetails`, type `Normalized<T>` (reuse as the `normalize` argument). |
| 8 | `contracts/wikimapia-client.test.ts` | Reference only, to align unit-test bodies with the black-box contract. Relevant describes: AC-24, AC-32, AC-34, AC-35, AC-36 (the two body-shaped cases: debug message containing the key, HTML with a keyed URL), AC-37, AC-46. It imports `src/wikimapia/client.ts` (U5), so it cannot run now. |
| 9 | `contracts/fixtures/wikimapia/` (all eight JSON files) | Load them through `fixtureText` / `rawBox` / `rawDetails`; never hand-copy fixture data into tests. |
| 10 | `tests/wikimapia/normalize.test.ts` | Style reference for test layout and helper use. Do not modify it. |
| 11 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read the AL6 document. It adds nothing that U2 needs beyond the AL4 spec.

## 2. Execution Directives

### 2.1 add-test-writer

Create `tests/wikimapia/interpret.test.ts`. Import the subject from `../../src/wikimapia/interpret.js`, contract items from `../../contracts/wikimapia-client.schema.js`, and helpers from `../../contracts/wikimapia-client.support.js`. Use `import type` for type-only imports. Tests are pure and synchronous: no network, no OpenAI, no real keys, no transport or clock doubles.

Signatures and exported names are fixed by AL4 "1.3 Component contracts (signatures)" (`interpret.ts` block). The groups below expand the U2 list "Unit tests must cover" against AL4 1.4.4.

1. **Data.** Each data fixture body (`fixtureText`) gives `kind: 'data'`: the two `box-*` fixtures through `interpretBoxAnswer`, the four `getbyid-*` fixtures through `interpretPlaceDetailsAnswer`. The value deep-equals the U1 normaliser's value for the same fixture (`normalizeListingPage(rawBox(...))` / `normalizePlaceDetails(rawDetails(...))`) and passes `ListingPageSchema` / `PlaceDetailsSchema`. The empty box page gives `data` with an empty `places` list.
2. **Rate limit.** `debug-rate-limit.json` gives exactly `{ kind: 'rate_limit', waitSeconds: 7 }` through both interpreters. `rateLimitAnswer('a few').body` gives `rate_limit` with `waitSeconds` `undefined`. `rateLimitAnswer(0).body` gives `waitSeconds: 0`, and `rateLimitAnswer(86400).body` gives `86400` (no cap). A rate-limit body is never `data` and never `unexpected` (AC-24).
3. **Wikimapia error.** `debug-error.json` gives exactly `{ kind: 'wikimapia_error', message: 'Invalid API key.' }` through both interpreters (AC-32). The message is passed through verbatim. A debug message that contains `TEST_API_KEY` is also returned verbatim: redaction is U3/U4, not U2, so do not assert redaction here.
4. **Debug wins (AC-37 case 3).** A body with `debug: { message: 'Invalid API key.' }` and, next to it, the `comments` of the nested fixture after `addCommenterIps` gives `wikimapia_error`. `JSON.stringify` of the result contains no `SYNTHETIC_IPS` number. A debug envelope next to a complete, valid details object also gives `wikimapia_error`, not `data`.
5. **Malformed debug.** `{ debug: 'x' }` and `{ debug: {} }` fall through to the data schema and give `unexpected`.
6. **Unreadable bodies (AC-34).** HTML (`<html><body>Service temporarily unavailable</body></html>`), `''`, truncated JSON (`fixtureText('getbyid-62587.json').slice(0, 200)`) and an HTML body containing a keyed URL (`http://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=62587`) each give exactly `{ kind: 'unexpected', issues: [{ path: [], message: 'Wikimapia answer is not valid JSON' }] }`. Check explicitly that `JSON.stringify` of the result contains neither `TEST_API_KEY`, nor `key=`, nor any fragment of the body (e.g. `html`, `Service`).
7. **Wrong top-level shape (AC-35).** The body `[]` gives `unexpected` through both interpreters, with an issue at path `[]`. `null` and a JSON string or number also give `unexpected`.
8. **Exact raw paths (AL4 1.4.5, AC-35, AC-46).** Mutate fixture copies in the test, serialise with `JSON.stringify`, and assert that the `unexpected` issues include the listed path: details without `title` gives `['title']`; `comments[1]` without `name` gives `['comments',1,'name']`; details `id` of `"abc"`, `1.5` and `-3` each give `['id']`; box `folder[0].id = 'abc'` gives `['folder',0,'id']`; box without `found` gives `['found']`; nested fixture with `comments[0].replies[0].good = 1.5` gives `['comments',0,'replies',0,'good']`; nested fixture with the `name` of `comments[0].replies[0].replies[0]` deleted gives `['comments',0,'replies',0,'replies',0,'name']`.
9. **Semantic-check passthrough.** A schema-valid body that fails a U1 semantic check (e.g. `folder[0].url` pointing at another place, or `count` `0`) gives `unexpected` with the U1 issue path (`['folder',0,'url']`, `['count']`), not `data`.
10. **No IPs in failures (AC-37 cases 1 and 2).** Nested fixture with `addCommenterIps` and a reply-to-reply `name` deleted; and 62587 with `addCommenterIps` plus `comments[0]` set to `{ user_ip: '1555555555', good: 'many' }`. Both give `unexpected`, and `JSON.stringify` of the result contains no `SYNTHETIC_IPS` number and not `1555555555`.
11. **Issue shape.** Every `unexpected` result has at least one issue, at most 20, and every issue passes `FailureIssueSchema`. The `unexpected` result object has only the keys `kind` and `issues` (no partial value).
12. **Generic `interpretAnswer`.** Called directly with a small synthetic schema and a stub normaliser (one returning `{ ok: true, value }`, one returning `{ ok: false, issues }`), it maps them to `data` and `unexpected` respectively, and the stub is not called when the debug envelope or the raw schema decides first.

Run the new test file once and confirm that it fails only because `src/wikimapia/interpret.ts` does not exist yet.

### 2.2 add-coder

1. Create `src/wikimapia/interpret.ts` exactly per AL4 1.3 (`interpret.ts` block) and the pseudo-code in 1.4.4. Export the type `Interpretation<T>` and the functions `interpretAnswer`, `interpretBoxAnswer` and `interpretPlaceDetailsAnswer`.
2. `interpretAnswer`, in this order:
   - Parse with `JSON.parse` inside `try`/`catch`. Type the result as `unknown`; do not let it be `any`. Use an optional catch binding or ignore the error entirely. **Never** copy the `SyntaxError` message or any part of the body. On failure, return the single fixed issue `{ path: [], message: 'Wikimapia answer is not valid JSON' }`.
   - `RawDebugResponseSchema.safeParse` first. On success, classify `debug.message` with the contract's `parseRateLimitMessage` (do not re-implement it). Return `rate_limit` with `waitSeconds: info.waitSeconds`. The key must be present even when its value is `undefined`, as the `Interpretation` type requires. Otherwise return `wikimapia_error` with the message unchanged. Do not read or return anything else from the body.
   - Otherwise `rawSchema.safeParse`. On failure, return `unexpected` with `toFailureIssues(error.issues)` from `./issues.js`.
   - Otherwise call `normalize(raw.data)` and map `ok` to `data` and `!ok` to `unexpected` with its `issues`.
3. `interpretBoxAnswer(body)` = `interpretAnswer(body, RawBoxResponseSchema, normalizeListingPage)`. `interpretPlaceDetailsAnswer(body)` = `interpretAnswer(body, RawPlaceDetailsSchema, normalizePlaceDetails)`. Import the normalisers from `./normalize.js`.
4. Import every schema, type and function from `../../contracts/wikimapia-client.schema.js`. Use `import type` for type-only imports (`z` itself is needed only as a type here). Relative imports carry the `.js` suffix.
5. Follow AL4 "5. AL2 Guidance": no `parse` (throwing) on external data, no non-null assertions, no `console.log`, no `async`. The functions are synchronous.
6. Do not modify `src/wikimapia/issues.ts`, `src/wikimapia/normalize.ts` or the U1 tests. If U1's API seems insufficient, stop and report it instead of changing it. Do not create any other file under `src/`. Do not touch `package.json`.

### 2.3 Done when

All of the following hold:

- `pnpm exec vitest run --no-color tests/wikimapia/interpret.test.ts` passes.
- `pnpm exec vitest run --no-color tests/wikimapia/issues.test.ts tests/wikimapia/normalize.test.ts contracts/wikimapia-client.schema.test.ts` stays fully green (U1 tests, and the schema tests at 35/35).
- `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems.
- `pnpm exec tsc --noEmit` reports no new errors, and `pnpm lint` reports no new problems. **"No new errors" means exactly one error each, the pre-existing one:** the unresolved import `../src/wikimapia/client.js` in `contracts/wikimapia-client.test.ts`. It goes away only in U5. Any other error is yours to fix.
- `contracts/wikimapia-client.test.ts` is expected to stay red (it cannot import) until U5. Do not try to make it pass now.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/wikimapia/`, the support file and both contract test files).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
- If a contract schema, fixture or the AL4 spec appears wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing). Do not work around it locally.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.

## 4. Out of Scope

Do not implement any of the following now. They belong to other units:

- U1 (done): issue mapping and normalisation. Reuse it and do not change it.
- U3: `src/wikimapia/request.ts` (URL building) and `src/wikimapia/redact.ts` (`redactSecrets`, `redactFailure`), AL4 1.4.3 and 1.4.9. U2 does no redaction; it only guarantees that no body text or `SyntaxError` text enters its output.
- U4: `src/wikimapia/execute.ts`, AL4 1.4.7 and 1.4.8. This covers the transport call, `TransportResponseSchema`, HTTP status mapping, the wait and retry loop, the fallback wait time, attempt counting, conversion of an `Interpretation` into a `ClientFailure` (`wikimapia_error` / `unexpected_response` / `rate_limit_exhausted`) and the never-reject guard.
- U5: `src/wikimapia/runtime.ts` and `src/wikimapia/client.ts`: configuration, input validation, `createWikimapiaClient`, and the default transport and clock (AL4 1.2, 1.4.1, 1.4.2, 1.4.10).
- Any database, migration, crawl or embedding work (later Stage 1 substeps).
