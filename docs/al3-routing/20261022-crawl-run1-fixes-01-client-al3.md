# AL3 Routing: crawl-run1-fixes, U1 "Client: missing/null Tags and Key Quota Exhausted"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U1 of 7 (no dependencies; first unit)
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section 4 "U1. Client: missing/null Tags and Key Quota Exhausted"
- **Audience:** `add-test-writer`, then `add-coder`
- **Status:** Routing to AL2 Agents

## 1. Context Manifest

Read these files, and only these, before starting. Follow the project stack and code style they define (Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, pnpm). **Relative imports are extensionless** (`.agrules` section 5; older AL3 prompts that say `.js` are outdated). Match the style of the existing `src/wikimapia/` and `tests/wikimapia/` files.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Section 2 (Zod at boundaries), section 4 (no secrets, recorded fixtures, no live calls, strict types), section 5 (extensionless imports, `unknown` only where allowed, types in `types.ts`). |
| 2 | `CLAUDE.md` | Stack, decisions, Wikimapia API reference (the "Key quota" and "`tags` is omitted" bullets). |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | The design. Required sections: "0. Scope and Fixed Points" (incl. the red-state table), "1.1 Module map" (the Client table only), "1.3 Component contracts" (the `src/wikimapia/types.ts` block only), "1.4.1 Missing or null Tags", "1.4.2 Key Quota in the Client", "4. Implementation Units / U1", "5. AL2 Guidance". Skim nothing else. |
| 4 | `contracts/wikimapia-client.schema.ts` | Single source of truth (amended): `RawPlaceDetailsSchema` (`tags` nullish), `RawDebugResponseSchema` (`debug.code`), `KEY_QUOTA_CODE`, `KeyQuotaExhaustedFailureSchema`, `ClientFailureSchema`, `DebugAnswerInfo`, `classifyDebugResponse`, `parseRateLimitMessage`. |
| 5 | `contracts/wikimapia-client.support.ts` | Test helpers to reuse: `keyQuotaAnswer`, `keyQuotaVariant`, `KEY_QUOTA_BODY`, `rateLimitAnswer`, `fixtureAnswer`, `fixtureText`, `rawDetails`, `answer`, `at`, `TEST_API_KEY`. |
| 6 | `contracts/fixtures/wikimapia/getbyid-1391132-no-tags.json`, `getbyid-8918979-no-tags.json`, `debug-key-quota.json` | New recorded fixtures. Load them through the support helpers only; never hand-copy their data. |
| 7 | `contracts/crawl-run1-fixes.test.ts` | Reference: the describes AC-1 .. AC-5 and AC-7 .. AC-14 (lines ~520-815) and their helpers (`clientSetup`, `clientReading`, `KEY_QUOTA_MESSAGE`). Align unit tests with them. Do not modify. |
| 8 | `src/wikimapia/types.ts` | `Interpretation<T>` gets the new member. |
| 9 | `src/wikimapia/interpret.ts` | `debug` branch to change. |
| 10 | `src/wikimapia/execute.ts` | `run` loop to extend. |
| 11 | `src/wikimapia/redact.ts` | `redactFailure` switch to extend (current tsc error at line 53). |
| 12 | `src/wikimapia/normalize.ts` | `normalizePlaceDetails` (current tsc error at line 157). |
| 13 | `tests/wikimapia/normalize.test.ts`, `tests/wikimapia/interpret.test.ts`, `tests/wikimapia/execute.test.ts`, `tests/wikimapia/redact.test.ts` | Existing unit tests to extend (and fix `normalize.test.ts:566`). Reuse their local helpers and doubles. |
| 14 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read the AL6 document or anything under `src/crawl/` or `src/db/`. U1 needs nothing from them.

## 2. Execution Directives

### 2.1 add-test-writer

Extend the four existing test files (do not create new ones). Tests are pure: no network, no OpenAI, no real keys; use the existing fake transport and fake clock patterns of `execute.test.ts`. Expand AL4 U1 "Unit tests must cover" as follows.

1. **`tests/wikimapia/normalize.test.ts`**
   - Fix the type error at line 566: `raw.tags` is now `... | null | undefined` in the contract, so the "drops unlisted keys" case must take a local, non-null Tag list from the fixture (narrow it, or assign a local array to `raw.tags` first) before `at(...)`. Do not use non-null assertions. The case keeps asserting the same thing.
   - New group (AL4 1.4.1, AC-1 .. AC-3, AC-5): `normalizePlaceDetails` of `getbyid-1391132-no-tags.json` and `getbyid-8918979-no-tags.json` succeeds with `tags: []`, no `wikipediaUrl` (1391132 has `wikipedia: ''`). For 8918979, `tags` missing, `null` and `[]` give `toStrictEqual` results. A fixture with Tags still yields its Tags unchanged.
2. **`tests/wikimapia/interpret.test.ts`** (AL4 1.4.2, AC-12, AC-13)
   - `debug-key-quota.json` (through `fixtureText`) gives exactly `{ kind: 'key_quota', message: 'Key limit has been reached' }`, through both `interpretBoxAnswer` and `interpretPlaceDetailsAnswer`.
   - Code 1004 as text `"1004"` also gives `key_quota`.
   - Code 1004 with message `''` gives `key_quota` with `message: ''`; with the rate-limit wording ("You have reached the limit ... wait for 7 seconds.") gives `key_quota` with that message as sent (code wins).
   - Code 1003 and no code (`keyQuotaVariant({ code: 1003 })`, `keyQuotaVariant({ code: null })`, use the `.body`) give `wikimapia_error` with the message. `debug-rate-limit.json` still gives `{ kind: 'rate_limit', waitSeconds: 7 }`; `debug-error.json` still gives `wikimapia_error`.
3. **`tests/wikimapia/execute.test.ts`** (AL4 1.4.2 bullets, AC-8 .. AC-12)
   - Key quota on attempt 1: failure `key_quota_exhausted`, `wikimapiaMessage` as sent, `code: 1004`, exactly 1 transport call, no sleep.
   - Rate limit (7 s) then key quota: exactly one sleep of 7000 ms, 2 transport calls, `key_quota_exhausted`; a third queued answer is never requested.
   - `retryLimit` 0 (and a large value) behave identically to the default.
   - `message` is `Wikimapia key quota exhausted (code 1004): Key limit has been reached`; for a blank or whitespace-only Wikimapia message it is the bare `Wikimapia key quota exhausted (code 1004)`.
   - The returned failure passes `ClientFailureSchema` / `KeyQuotaExhaustedFailureSchema`.
   - A key-quota body whose message contains `TEST_API_KEY` or a keyed URL comes back redacted in both `message` and `wikimapiaMessage` (end-to-end through `executeRequest`).
4. **`tests/wikimapia/redact.test.ts`** (AC-14)
   - `redactFailure` on a `key_quota_exhausted` failure removes the API key and keyed request addresses from `message` and `wikimapiaMessage`, keeps `kind` and `code: 1004`, and adds or drops no keys.

Run the four files once and confirm the new cases fail only for the missing implementation (and that the line-566 fix compiles).

### 2.2 add-coder

Implement exactly AL4 1.1 (Client table), 1.3 (`src/wikimapia/types.ts` block), 1.4.1 and 1.4.2:

1. `src/wikimapia/types.ts`: add `{ kind: 'key_quota'; message: string }` to `Interpretation<T>` as in AL4 1.3.
2. `src/wikimapia/normalize.ts`: map `raw.tags ?? []`. Nothing else in the normaliser changes.
3. `src/wikimapia/interpret.ts`: in the `debug` branch, classify with the contract's `classifyDebugResponse(debug.data.debug)` and map its three kinds per the 1.4.2 pseudo-code. Remove the direct `parseRateLimitMessage` call (and its import if unused). Keep the `rate_limit` member's `waitSeconds` key present even when `undefined`, as the type requires. Do not re-implement the code-1004 check.
4. `src/wikimapia/execute.ts`: add `case 'key_quota'` to the `run` switch. Return `key_quota_exhausted` immediately with `message` per `keyQuotaMessage` (1.4.2), `wikimapiaMessage` = the interpretation's message, `code: KEY_QUOTA_CODE` (imported from the contract, never the literal `1004`). No sleep, no attempt check, before anything else. The existing `never` default must keep compiling.
5. `src/wikimapia/redact.ts`: add `case 'key_quota_exhausted'` that redacts `message` and `wikimapiaMessage` (same shape as the `wikimapia_error` case; may share it). This resolves the `never` error at line 53.
6. Do not change `parseRateLimitMessage`'s export or behaviour (it lives in the contract). Do not touch `request.ts`, `runtime.ts`, `client.ts`, `issues.ts`, or anything outside `src/wikimapia/` and `tests/wikimapia/`. No new files under `src/`. Any new local type goes in `src/wikimapia/types.ts`.
7. Follow AL4 section 5: no non-null assertions, no `console.log`, `unknown` only where `.agrules` section 5 allows, no throwing `parse` on external data.

### 2.3 Done when

Precondition: `pnpm db:up` has run and `.env.test` exists (the contract file's `beforeAll` applies Schema Setup on the Test Database, and AC-7 uses the Place Store).

- `pnpm exec vitest run --no-color tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/crawl-run1-fixes.schema.test.ts` passes.
- `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts -t "^AC-([1-5]|[7-9]|1[0-4]) "` passes (AC-1 .. AC-5, AC-7 .. AC-14). The rest of that file stays red; that is expected (U2 .. U7).
- `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems.
- `pnpm exec tsc --noEmit`: the errors at `src/wikimapia/normalize.ts:157`, `src/wikimapia/redact.ts:53` and `tests/wikimapia/normalize.test.ts:566` are gone. **Exactly these errors may remain, and they are not yours to fix:** `src/crawl/requests.ts:65` (the `never` check on the new `key_quota_exhausted` kind) and `tests/crawl/report.test.ts:38` (new run counts). Both belong to U5. Do not touch `src/crawl/` to silence them. Any other error is yours.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/wikimapia/`, the support files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
- If a contract schema, fixture or the AL4 spec appears wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing). Do not work around it locally.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.

## 4. Out of Scope

Do not implement any of the following now:

- **U5:** the crawl side of the Key Quota: `src/crawl/requests.ts` (`key_quota_exhausted` -> Gateway stop `quota_exhausted`, the `requests.ts:65` tsc error), Gateway `wikimapiaMessage`, Wikimapia Error item messages, tally parking counts, summary lines (`report.ts`, `tests/crawl/report.test.ts`). AL4 1.4.3, 1.4.10.
- **U2:** Schema Setup step 6, `emptyStore()`, widened status check, old Run Record counts (AL4 1.4.9, 1.4.12, 2.x).
- **U3 / U4:** Failure Records, Parking, Explicit Retry, due exclusion (`src/db/`; AL4 1.4.5 .. 1.4.8).
- **U6 / U7:** Run orchestration, `--retry-parked`, Dry Run count, command output, and the AC-6, AC-15 .. AC-46 contract cases.
- Any change to the Place Store: AL4 1.4.1 states it needs none (AC-7 is green through the Client change alone).
