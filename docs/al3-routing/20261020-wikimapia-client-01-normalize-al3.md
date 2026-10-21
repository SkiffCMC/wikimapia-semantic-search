# AL3 Routing: wikimapia-client, U1 "Issue mapping and normalisation (pure)"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** U1 of 5 (first unit; `src/` and `tests/` do not exist yet)
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`, section 4 "U1. Issue mapping and normalisation (pure)"
- **Audience:** `add-test-writer`, then `add-coder`
- **Status:** Routing to AL2 Agents

## 1. Context Manifest

Read these files, and only these, before starting. Follow the project stack and code style they define (Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, pnpm).

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding project rules. Section 2 (Zod-validated boundaries) and section 4 (No Commenter IPs, Recorded API Fixtures, No Live External Calls in Tests, Strict Types) apply directly. |
| 2 | `CLAUDE.md` | Stack, decisions, and the Wikimapia API reference (wire field names). |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | The design. Required sections: "0. Scope and Fixed Points", "1.1 Module map" (rows `issues.ts`, `normalize.ts`), "1.3 Component contracts (signatures)" (the `issues.ts` and `normalize.ts` blocks), "1.4.5 Issue mapping", "1.4.6 Normalisation", "1.5 Transaction boundaries" (no partial data), "2. Data Model Design" (2.1, 2.2, 2.3), "4. Implementation Units / U1", "5. AL2 Guidance". |
| 4 | `contracts/wikimapia-client.schema.ts` | Single source of truth for every raw (wire) schema, output schema, type and constant you use: `RawBoxResponse`, `RawPlaceDetails`, `RawComment`, `ListingPageSchema`, `PlaceDetailsSchema`, `CommentSchema`, `FailureIssue`/`FailureIssueSchema`, `MAX_PAGE_SIZE`, `isWikimapiaPlaceUrl`, `findCommenterIpPaths`. |
| 5 | `contracts/wikimapia-client.support.ts` | Test helpers to reuse in unit tests: `rawBox`, `rawDetails`, `addCommenterIps`, `SYNTHETIC_IPS`, `at`, `FixtureName`. |
| 6 | `contracts/wikimapia-client.test.ts` | Reference only, to align unit-test expectations with the black-box contract. Relevant describes: AC-1, AC-2, AC-6, AC-9 .. AC-16, AC-19 .. AC-21, AC-35, AC-42 .. AC-47. It imports `src/wikimapia/client.ts`, which does not exist until U5, so it cannot run now. |
| 7 | `contracts/wikimapia-client.schema.test.ts` | Must stay 35/35 green; do not change it. |
| 8 | `contracts/fixtures/wikimapia/box-belgrade-page1.json`, `box-belgrade-empty-page.json`, `getbyid-62587.json`, `getbyid-1381893.json`, `getbyid-55.json`, `getbyid-62587-nested-replies.json` | Recorded and reconstructed answers. Load them through the support helpers, never by hand-copying data into tests. |
| 9 | `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | Compiler and lint settings; `tests/**/*.test.ts` is already included by Vitest and `tests`/`src` by `tsc`. |

Do not read the AL6 document or the other fixtures (`debug-*.json`) for this unit: the AL4 spec already carries everything U1 needs, and debug envelopes belong to U2.

## 2. Execution Directives

### 2.1 add-test-writer

Create `tests/wikimapia/issues.test.ts` and `tests/wikimapia/normalize.test.ts`. They import the subjects from `../../src/wikimapia/issues.js` and `../../src/wikimapia/normalize.js`, contract items from `../../contracts/wikimapia-client.schema.js`, and helpers from `../../contracts/wikimapia-client.support.js`. Use `import type` for type-only imports. No network, no OpenAI, no real keys; the tests are pure and synchronous.

Signatures and exported names are fixed by AL4 "1.3 Component contracts (signatures)". The test groups below are the U1 list "Unit tests must cover", expanded per spec section.

**`issues.test.ts`** (AL4 1.4.5)

1. `toFailureIssues` with real Zod issues: obtain them by calling the raw schemas' `safeParse` on fixture copies mutated in the test (e.g. delete `title`; delete `comments[1].name`; set `folder[0].id` to `"abc"`; delete `found`; set a nested reply's `good` to `1.5`; delete the `name` of a reply to a reply in the nested fixture). Assert that the resulting paths include the expected paths listed in 1.4.5 (`['title']`, `['comments',1,'name']`, `['folder',0,'id']`, `['found']`, `['comments',0,'replies',0,'good']`, `['comments',0,'replies',0,'replies',0,'name']`), and `['id']` for the details `id` values `"abc"`, `1.5` and `-3`.
2. Every produced issue passes `FailureIssueSchema` (non-empty message, path of strings and numbers only).
3. No input value leaks: an issue produced from a wrongly typed `user_ip` (e.g. a string value made from a `SYNTHETIC_IPS` entry) contains neither that value nor any `SYNTHETIC_IPS` number in its message or path; the issue objects have only the keys `path` and `message`.
4. A symbol path element maps to its description, and to `'symbol'` when it has none (use hand-built issue objects cast to the Zod issue type).
5. Empty message maps to `'invalid value'`.
6. Cap: more than 20 input issues give exactly `MAX_REPORTED_ISSUES` (20), in input order.
7. Never empty: an empty input array gives `[{ path: [], message: 'invalid value' }]`.
8. `formatIssuePath`: `['comments',0,'replies',0,'name']` gives `comments[0].replies[0].name`; `[]` gives `(whole answer)`; a single key gives the key.
9. `describeIssues`: the format `prefix: <path>: <message>` for the first issue, with ` (+N more)` only when there are further issues; the nested-reply case contains `comments[0].replies[0].replies[0].name`.

**`normalize.test.ts`** (AL4 1.4.6, section 2)

1. Listing page (2.1): `box-belgrade-page1.json` gives page, reported `pageSize` (10, not the requested 100), `totalFound` 290, summaries in fixture order; University Park summary exactly as in contract AC-2 (whole-number `placeId`, `url` unchanged, `location` with exactly the six bound keys, `outline` mapped `x`/`y` to `lon`/`lat` in order). `box-belgrade-empty-page.json` gives an empty `places` list and no failure (AC-6).
2. Place details (2.2): 62587 as in AC-9; 1381893 with empty `comments` (AC-12); optional values (`wikipediaUrl`, `street`, `houseNumber`, other location details) are **absent keys** (assert with `not.toHaveProperty` / `Object.keys`) for `null`, missing and `''` (AC-13), present and unchanged (not trimmed) otherwise (AC-14, using 55 or a mutated copy); `parent_id` `"0"` gives no `parentPlaceId`, `"7291521"` gives `7291521` (AC-15); `is_deleted` true is kept (AC-19).
3. Comments (2.3): the two comments of 62587 field by field as in AC-10, in order; `authorPhotoUrl` and `moderatorName` absent for `''` and `null`; deleted and blocked comments and replies kept with their marks (AC-20); empty `replies` give `[]` (AC-21).
4. Replies (nested fixture): Mateja -> Serbia -> Paul fully normalised (AC-42, AC-43; the reply's own `place_id`, e.g. 55, kept as is); several replies keep their order (AC-44); a 12-level chain built in the test normalises to 12 levels with no depth limit; replies of a deleted and blocked parent are kept in full (AC-47). Test `normalizeComment` directly as well as through `normalizePlaceDetails`.
5. Allow-list (AC-16): add unlisted keys at every level (top level, `location`, a box place, a polygon point, a tag, a comment, a reply; e.g. `urlhtml`, `gadm`, `zoom`, `x`/`y` at top level, `pl`, `extra`) and assert exact `Object.keys` sets of each output object per section 2.
6. No Commenter IPs (AC-11, AC-45): after `addCommenterIps` on 62587 and on the nested fixture, `findCommenterIpPaths(value)` returns `[]`, no `SYNTHETIC_IPS` number appears anywhere in `JSON.stringify(value)`, and `author` is still present.
7. Semantic checks (table in 1.4.6), each returning `{ ok: false, issues }` with no `value` key and the exact raw path and message: `['folder',0,'url']` (url of another place or another host), `['count']` (`0` and `101`), `['page']` (`0`), `['folder',0,'id']` (digit string above `Number.MAX_SAFE_INTEGER`), `['found']` (unsafe digit string), `['id']` and `['parent_id']` on details (unsafe digit strings). Several failing checks are all reported.
8. Output gate: every success value (all six data fixtures, plus the nested and 12-level cases) passes `ListingPageSchema` / `PlaceDetailsSchema` `.safeParse` with `success: true`. Do not try to force the gate-failure branch from tests.

Run the new tests once and confirm they fail only because the modules do not exist yet.

### 2.2 add-coder

1. Create `src/wikimapia/issues.ts` exactly per AL4 1.3 (`issues.ts` block) and 1.4.5: `MAX_REPORTED_ISSUES`, `toFailureIssues`, `formatIssuePath`, `describeIssues`. Copy only `path` (string/number kept, symbol -> description or `'symbol'`) and `message` (empty -> `'invalid value'`) from each issue; never read `input` or any other field; cap at 20; never return an empty array.
2. Create `src/wikimapia/normalize.ts` per AL4 1.3 (`normalize.ts` block), 1.4.6 and section 2: type `Normalized<T>`, `normalizeListingPage`, `normalizePlaceDetails`, `normalizeComment` (recursive), with the private helpers `toWhole` and `presentText` as described.
   - Run every semantic check in the 1.4.6 table first, collecting all issues with their raw paths and exact messages; if any fail, return `{ ok: false, issues }` with no partial value.
   - Build every output object field by field from the tables in 2.1, 2.2 and 2.3. Never spread a raw object or sub-object. Never read `user_ip`.
   - Attach optional keys only when the value is defined (`exactOptionalPropertyTypes`).
   - Gate the built object with `ListingPageSchema.safeParse` / `PlaceDetailsSchema.safeParse` and return `.data`; on gate failure, return the issues mapped via `toFailureIssues` with each message prefixed `output check: `.
3. Import every schema, type and constant from `../../contracts/wikimapia-client.schema.js`; reuse `isWikimapiaPlaceUrl`; do not redefine anything the contract exports. Relative imports carry the `.js` suffix; type-only imports use `import type`.
4. Follow AL4 "5. AL2 Guidance": no non-null assertions, `String(n)` in template literals, no `console.log`, no `parse` (throwing) on data, no `async` without `await`.
5. Do not create any other file under `src/`. Do not touch `package.json` (no new dependencies).

### 2.3 Done when

All of the following hold:

- `pnpm exec vitest run --no-color tests/wikimapia/issues.test.ts tests/wikimapia/normalize.test.ts` passes.
- `pnpm exec vitest run --no-color contracts/wikimapia-client.schema.test.ts` is still 35/35 green.
- `pnpm exec eslint src/wikimapia tests/wikimapia` reports no problems.
- `pnpm exec tsc --noEmit` reports no new errors, and `pnpm lint` reports no new problems. **"No new errors" means exactly one error each, the pre-existing one:** the unresolved import `../src/wikimapia/client.js` in `contracts/wikimapia-client.test.ts`. It disappears only in U5. Any other error is yours to fix.
- `contracts/wikimapia-client.test.ts` is expected to stay red (cannot import) until U5; do not try to make it pass now.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/wikimapia/`, the support file and both contract test files).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
- If a contract schema, fixture or the AL4 spec appears wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing). Do not work around it locally.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.

## 4. Out of Scope

Do not implement any of the following now; they belong to later units:

- U2: `src/wikimapia/interpret.ts` (JSON parsing, debug envelope / rate-limit detection, raw-schema `safeParse` of HTTP bodies, `Interpretation<T>`), AL4 1.4.4.
- U3: `src/wikimapia/request.ts` (URL building) and `src/wikimapia/redact.ts` (secret redaction), AL4 1.4.3 and 1.4.9.
- U4: `src/wikimapia/execute.ts` (transport, status mapping, rate-limit wait/retry loop), AL4 1.4.7, 1.4.8.
- U5: `src/wikimapia/runtime.ts` and `src/wikimapia/client.ts` (configuration, input validation, `createWikimapiaClient`, default transport and clock), AL4 1.2, 1.4.1, 1.4.2, 1.4.10.
- Any database, migration, crawl or embedding work (later Stage 1 substeps).
