# AL3 Routing: wikimapia-client, U3 "Request URLs and secret redaction (pure)"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** U3 of 5 (no code dependency on U1/U2)
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`, section 4 "U3. Request URLs and secret redaction (pure)"
- **Audience:** `add-test-writer`, then `add-coder`
- **Attempt:** 2 (corrective run)
- **Status:** Routing to AL2 Agents

## Corrective run (2026-10-21)

An approved AL5 change sets `WIKIMAPIA_API_URL` in `contracts/wikimapia-client.schema.ts` to `'https://api.wikimapia.org/'`. AL4 has been revised to match (sections "1.4.3 Request building" and "3. Batch & External Calls", "Secrets" bullet). U3 is already implemented (`src/wikimapia/request.ts`, `src/wikimapia/redact.ts`) and tested (`tests/wikimapia/request.test.ts`, `tests/wikimapia/redact.test.ts`). The only failing assertion is `tests/wikimapia/request.test.ts:80`, which still expects `url.protocol` to be `'http:'`.

- **add-test-writer:** Edit the existing test files. Do not rewrite them. Change only these two things:
  1. The hard-coded protocol assertion in group 1 (Base): it must expect `'https:'`.
  2. Sample URLs that represent Wikimapia API requests built by this client: they must use `https://api.wikimapia.org/...`. Do this only where the URL stands for a request the client sends.
  Keep the `http://` variants that deliberately test protocol-agnostic redaction (groups 9 to 13). Redaction must stay covered for both `http://` and `https://` keyed URLs. If after your edit only one scheme is covered for keyed-URL removal, add the missing one. Do not touch tests of other units (`runtime.test.ts`, `client.test.ts`, `interpret.test.ts`, `normalize.test.ts`).
- **add-coder:** No source change is expected. `request.ts` derives the scheme from `new URL(WIKIMAPIA_API_URL)`. Check that this is still true, that no scheme is hard-coded or rewritten anywhere in `request.ts`, and that `redact.ts` still matches `/https?:\/\/.../`. Change code only if a test of this unit still fails after the test-writer's edit.
- **Done when:** the commands in 2.3 hold, and the full suite `pnpm exec vitest run --no-color` is green.

## 1. Context Manifest

Read these files, and only these, before you start. Follow the project stack and code style they define: Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, and pnpm. Match the style of the existing files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding project rules. Section 4 applies directly: No Data or Secrets in Git, No Live External Calls in Tests, Strict Types. |
| 2 | `CLAUDE.md` | Stack, decisions, and the Wikimapia API reference (request parameters). |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | The design. Required sections: "0. Scope and Fixed Points", "1.1 Module map" (rows `request.ts` and `redact.ts`), "1.2 Call flow" (steps 3 and 5 only, for context), "1.3 Component contracts (signatures)" (the `request.ts` and `redact.ts` blocks), "1.4.3 Request building", "1.4.9 Secret redaction", "3. Batch & External Calls" (the request column of the table and the "Secrets" bullet), "4. Implementation Units / U3", "5. AL2 Guidance". |
| 4 | `contracts/wikimapia-client.schema.ts` | The single source of truth. It provides `WIKIMAPIA_API_URL` (now `https`), `PLACE_DETAILS_DATA_BLOCKS`, `BoundingBox`, `TransportRequestSchema`, `ClientFailure`, `ClientFailureSchema` (all six failure kinds and their exact keys) and `FailureIssue`. |
| 5 | `contracts/wikimapia-client.support.ts` | Test helpers: `TEST_API_KEY` and `at`. Nothing else in this file is needed for U3. |
| 6 | `contracts/wikimapia-client.test.ts` | Reference only, to align the unit tests with the black-box contract. Relevant describes: "AC-3", "AC-4", "AC-5", "AC-17" (how the URL is read back through `searchParams.get`, and the `https:` protocol), "API key travels encrypted", and "AC-36" (the six failure scenarios, the `WIKIMAPIA_URL_WITH_KEY` shape, and the assertions `not.toContain(TEST_API_KEY)` and `not.toMatch(/[?&]key=/)`). |
| 7 | `src/wikimapia/request.ts`, `src/wikimapia/redact.ts` | The existing U3 implementation. |
| 8 | `tests/wikimapia/request.test.ts`, `tests/wikimapia/redact.test.ts` | The existing U3 tests to correct. |
| 9 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read the AL6 document or the fixtures. U3 does not import them.

## 2. Execution Directives

### 2.1 add-test-writer

The test files `tests/wikimapia/request.test.ts` and `tests/wikimapia/redact.test.ts` exist. On this run, apply only the corrections in "Corrective run" above. The groups below are the full specification the files must satisfy. Imports: the subjects from `../../src/wikimapia/request.js` and `../../src/wikimapia/redact.js`, contract items from `../../contracts/wikimapia-client.schema.js`, and `TEST_API_KEY`/`at` from `../../contracts/wikimapia-client.support.js`. Use `import type` for type-only imports. All tests are pure and synchronous. They make no network calls, use no OpenAI, use no real keys and need no transport or clock doubles. Use a small synthetic bounding box such as `{ west: 20.452, south: 44.814, east: 20.462, north: 44.82 }`.

AL4 "1.3 Component contracts (signatures)" fixes the signatures and exported names. The groups below expand the U3 list "Unit tests must cover" against AL4 1.4.3 and 1.4.9.

**`request.test.ts`** (read every URL back with `new URL(...)` and `searchParams.get`, never with substring matching on the raw string):

1. **Base.** For both builders, the protocol and host are those of `WIKIMAPIA_API_URL` (`https:`, `api.wikimapia.org`) and the pathname is `/`. Assert both equality with `new URL(WIKIMAPIA_API_URL).protocol` and the literal `'https:'`. The result passes `TransportRequestSchema` as `{ url }`.
2. **Common parameters.** `function` is `box` or `place.getbyid`, `format` is `json` and `key` equals the given key. With a key that contains URL-special characters (e.g. `a&b=c d+e/?#%`), `searchParams.get('key')` returns the key unchanged and no extra parameter appears. This proves that `URLSearchParams` encodes the values and that no string concatenation is used.
3. **Parameter order.** `[...searchParams.keys()]` is exactly `['function','key','format','bbox','page','count']` for `box` and `['function','key','format','id','data_blocks']` for `place.getbyid`. When a language is given, `language` comes right after `format`.
4. **`box` (AC-3, AC-4 URL side).** `bbox` split on `,` and mapped through `Number` equals `[west, south, east, north]`. Also check a box with negative coordinates. `page` and `count` are the decimal strings of the given values (e.g. `3` and `25`, plus `100` to cover the AC-4 value; the default itself comes from U5).
5. **`place.getbyid` (AC-17).** `id` is the decimal string of `placeId` (e.g. `'62587'`). The sorted `data_blocks` split on `,` equals the sorted `PLACE_DETAILS_DATA_BLOCKS`.
6. **Language (AC-5).** With `language: 'en'`, `searchParams.get('language')` is `'en'` for both builders. When `language` is absent, `searchParams.has('language')` is `false`.
7. **No extras.** `pack` is never present. The only parameter names are those listed in group 3.
8. **Determinism (AC-22 prerequisite).** Two builds with the same arguments return identical strings, for both builders.

**`redact.test.ts`** (use `TEST_API_KEY` as the key unless a case says otherwise; redaction is protocol-agnostic, so keyed-URL cases must cover both `https://` and `http://`):

9. **Key removal.** `redactSecrets` returns text that contains neither the key nor a match for `/[?&]key=/`. Cover these inputs: `Key ${TEST_API_KEY} is not valid`; the HTML body `<html>Bad request: https://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=62587</html>`; a bare keyed API URL `https://api.wikimapia.org/?function=box&key=${TEST_API_KEY}&format=json`; the same keyed URL with `http://` (protocol-agnostic case); a `?key=...` and an `&key=...` fragment outside any URL; an uppercase `&KEY=...` fragment; and the key repeated several times.
10. **Replacement markers.** A keyed URL becomes `[request address removed]` for both `https://` and `http://`, and the text around it (`<html>Bad request: ` and `</html>`) is kept. A `?key=` or `&key=` fragment becomes `[key removed]`, and so does a bare key occurrence.
11. **Unkeyed text unchanged.** `'Invalid API key.'` (AC-32), a text with an `http://` URL and a text with an `https://` URL that contain neither `key=` nor the key, and the empty string are all returned unchanged.
12. **RegExp metacharacters.** With a key such as `a.b*c+(d)?[e]$^|\\`, the key is removed wherever it appears. A text that matches the key only as a regex, e.g. `aXbbbc` for `a.b*c`, stays unchanged. This proves that the key is never compiled into a RegExp.
13. **Empty key.** With `apiKey === ''`, `redactSecrets` does not throw, does not insert markers between characters, and still removes `?key=`/`&key=` fragments. An unkeyed URL stays unchanged (see the clarification in 2.2 step 3).
14. **`redactFailure`, all six kinds.** For each kind (`configuration`, `invalid_request`, `rate_limit_exhausted`, `wikimapia_error`, `connection` with and without `status`, `unexpected_response`), build a valid failure whose text fields carry the key or a keyed URL wherever the kind allows: `message`; `wikimapiaMessage`; every `issues[i].message`; string elements of `issues[i].path`. Check that:
    - `JSON.stringify` of the result contains neither the key nor a match for `/[?&]key=/`;
    - the result passes `ClientFailureSchema`;
    - the result has exactly the same keys as the input (in particular, a `connection` failure without `status` still has no `status` key);
    - non-text fields (`kind`, `status`, `attempts`, `lastWaitSeconds`, number path elements) are unchanged;
    - the input object is not mutated (compare with a `structuredClone` taken before the call).
15. **Verbatim pass-through.** A `wikimapia_error` with `wikimapiaMessage: 'Invalid API key.'` comes back deep-equal to the input (AC-32). So does a failure with no secrets, for every kind. A `wikimapiaMessage` of `''` stays `''`.

After the edit, run both U3 test files and confirm they pass against the existing implementation.

### 2.2 add-coder

No source change is expected on this run (see "Corrective run"). The steps below describe the required implementation. Verify the existing code against them, and change it only if a U3 test still fails.

1. **`src/wikimapia/request.ts`.** Implement it per AL4 1.3 (`request.ts` block) and 1.4.3. Export `buildBoxUrl` and `buildPlaceDetailsUrl` with exactly the parameter object shapes given in 1.3. `language?: string` is optional under `exactOptionalPropertyTypes`, and `BoundingBox` is an `import type` from the contract.
   - Start from `new URL(WIKIMAPIA_API_URL)`. The scheme comes only from this constant. Never hard-code, set or rewrite `url.protocol`, and never hard-code the base URL. Add every parameter with `url.searchParams.set` in the order given in 1.4.3. Add `language` only when it is not `undefined`. Return `url.toString()` (or `href`).
   - `bbox` is `[west, south, east, north].map(String).join(',')`. Numbers go through `String(...)`. `data_blocks` is `PLACE_DETAILS_DATA_BLOCKS.join(',')`. Never hard-code the block list.
   - Validate nothing here. U5 validates inputs before calling these functions.
2. **`src/wikimapia/redact.ts`.** Implement it per AL4 1.3 (`redact.ts` block) and 1.4.9. Export `redactSecrets` and `redactFailure`.
3. **`redactSecrets(text, apiKey)`.** Apply the three steps of 1.4.9 in that order.
   - Step 1: use the global regex `/https?:\/\/[^\s"'<>]+/g` with a replacer function. It must stay protocol-agnostic (both `http` and `https`). A match is replaced by `[request address removed]` when it contains `key=`, or when `apiKey !== ''` and it contains `apiKey`. **Clarification:** the `apiKey !== ''` guard is needed because `''.includes`-style checks are always true. Without it, an empty key would remove every URL, which goes against the intent of 1.4.9 ("keyed request addresses") and the empty-key guard of step 3.
   - Step 2: use the regex `/[?&]key=[^&\s"'<>]*/gi`, replaced with `[key removed]`.
   - Step 3: if `apiKey !== ''`, use `text.split(apiKey).join('[key removed]')`.
   - Never build a `RegExp` from `apiKey`, and never escape the key into one.
4. **`redactFailure(failure, apiKey)`.** Return a **new** object of the same kind and with exactly the same keys. Map `redactSecrets` over `message`; over `wikimapiaMessage` (for `wikimapia_error`); and over each `issues[i].message` and each string element of `issues[i].path` (for `invalid_request` and `unexpected_response`). Leave numbers, `kind` and every other field untouched, and never add a key that was absent (`status`). A `switch` on `kind` with exhaustiveness checking is preferred, so that the result stays typed as `ClientFailure` without casts. Shallow-copying the already-validated failure object is acceptable here; the "never spread raw objects" rule of 1.4.6 concerns raw Wikimapia data.
5. **Imports.** Import every constant and type from `../../contracts/wikimapia-client.schema.js`. Use `import type` for type-only imports, and keep the `.js` suffix on relative imports. Neither file imports U1/U2 modules.
6. **Style.** Follow AL4 "5. AL2 Guidance": no non-null assertions, no `console.log` and no `async`. Both modules are synchronous and pure, with no module-level state.
7. **Scope of changes.** Do not modify any other file under `src/` or any test file of another unit. Do not touch `package.json`.

### 2.3 Done when

All of the following hold:

- `pnpm exec vitest run --no-color tests/wikimapia/request.test.ts tests/wikimapia/redact.test.ts` passes.
- The full suite `pnpm exec vitest run --no-color` is green, including `contracts/wikimapia-client.schema.test.ts` and `contracts/wikimapia-client.test.ts` (U4 and U5 now exist, so the earlier "contract test stays red until U5" exception no longer applies). If a test outside U3 fails because of the `https` change, do not fix it here; report it to the orchestrator.
- `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems.
- `pnpm exec tsc --noEmit` and `pnpm lint` report no errors.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/wikimapia/`, the support file and both contract test files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
- If a contract schema or the AL4 spec appears wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing). Do not work around it locally.
- `WIKIMAPIA_API_URL` is `https` by contract. The request scheme must come only from that constant. Never hard-code `http` or `https` in `request.ts`, never rewrite the protocol, and never add an HTTP fallback.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.
- Use only `TEST_API_KEY` and synthetic keys in tests. Never use a real API key.

## 4. Out of Scope

Do not implement or change any of the following now. They belong to other units:

- U1 and U2: issue mapping, normalisation and answer interpretation. U2 returns Wikimapia debug messages verbatim, including any key, by design. Do not add redaction to `interpret.ts`; U4 applies `redactFailure`.
- U4: `src/wikimapia/execute.ts` (AL4 1.4.7, 1.4.8). This covers calling `redactFailure` on every failure before it is returned, the transport call, status mapping, the retry loop, reuse of the URL across retries, and the never-reject guard.
- U5: `src/wikimapia/runtime.ts` and `src/wikimapia/client.ts` (AL4 1.2, 1.4.1, 1.4.2, 1.4.10), and their tests. This covers configuration (including key trimming), input validation, the `pageSize` default of `DEFAULT_PAGE_SIZE`, and the choice of which builder to call. Sample `http://api.wikimapia.org/...` URLs in `tests/wikimapia/runtime.test.ts` and `tests/wikimapia/client.test.ts` are not part of this run.
- Place links in Wikimapia responses (`http://wikimapia.org/...`) are data and stay unchanged (AL4 section 3, "Secrets").
- Any database, migration, crawl or embedding work (later Stage 1 substeps).
