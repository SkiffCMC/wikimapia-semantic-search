# AL3 Routing: storage, U5 "Pure save planning"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U5 of 8 (attempt 1)
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`. Read these sections: "0. Scope and Fixed Points" (including "Code style"), "1.1 Module map" (row `plan.ts`), "1.2 Call flow" (the two save columns, to see where the plan sits), "1.3 Component contracts" (the `types.ts` block from `ListingState` to `DetailsPlan`, and the `plan.ts` block), "1.4.5 Listing Save" (`dedupeListing`, `planListingSave` and its table; the `saveListing` pseudo-code only for the write order), "1.4.6 Details Save" (`planDetailsSave` pseudo-code; the `saveDetails` pseudo-code only for the write order), "2.1 General rules", "2.2" to "2.4" (column tables), "4. Implementation Units" ("Baseline caveat" and "U5") and "5. AL2 Guidance" (bullets on floats, `exactOptionalPropertyTypes`, types in `types.ts`)
- **AL6 decisions in play:** D1 (details win over a listing), D2 (gone items kept and marked), D3 (fetch moment alone is not a change), D6 (Built Link, never replaced by a Details Save). AL4 1.4.5 and 1.4.6 already encode them; read `docs/al6-requirements/20261021-storage-al6.md` section "5. Resolved Decisions" only if a rule is unclear.
- **Audience:** `add-test-writer` first, then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- U1 to U4 are done. `src/db/` contains `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `rows.ts`, `schema-setup.ts`, `types.ts`, `validate.ts` and `migrations/`. `plan.ts` does not exist yet.
- `src/db/types.ts` has `StoreResult`, `Validated`, every row type (`PlaceRow`, `CommentRow`, `TagLinkRow`, ...), `OutlinePairs`, `FlatComment` and `NamedMigration`. U5 adds the six planning types only.
- `src/db/mappers.ts` (U4) already provides what the planner reuses: `encodeOutline`, `summaryColumns`, `detailsColumns`, `flattenComments`, `commentColumns`. `detailsColumns` and `commentColumns` return `Record<string, unknown>` with every key always present (absent optional item = `null`), which is exactly the form to compare against a row.
- `PlaceRowSchema` / `CommentRowSchema` / `TagLinkRowSchema` in `src/db/rows.ts` are non-strict `z.object`s, so Zod **strips** unknown keys on parse. A place row is summary-only when `details_fetched_at_text` is `null`, detailed otherwise.
- Full suite is green except `contracts/storage.test.ts` (missing `src/db/place-store`, expected until U8).
- **Name clash (still applies):** `contracts/storage.support.ts` exports its own `flattenComments` (for `StoredComment` trees). In tests, import it under an alias if needed; never confuse it with `flattenComments` from `src/db/mappers`.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, extensionless relative imports, top-level `import type` instead of inline `type` specifiers, every `type`/`interface` declared in `src/db/` kept in `src/db/types.ts`, no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules (sections 0, 2, 4, 5 matter most). |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read the sections listed in the header. Skip the rest. |
| 4 | `contracts/storage.schema.ts` | Import, never copy: `buildWikimapiaLink`, types `SaveOutcomeKind`, `SavePlaceDetailsInput`. Lines 96 to 235 cover what U5 needs. |
| 5 | `contracts/wikimapia-client.schema.ts` | Types `PlaceSummary`, `PlaceDetails`, `Comment`, `Tag`, `Point` (lines 236 to 345). |
| 6 | `contracts/storage.support.ts` | Test inputs: `clientDetails`, `clientListing`, `summaryOf`, `listingOf`, `commentNum`, `nestedParts`, `nestedDetails`, `rehome`, `FETCHED_AT`, `LATER_FETCHED_AT`, `EVEN_LATER_FETCHED_AT`. |
| 7 | `contracts/storage.test.ts` | Read only these `describe` blocks, to mirror their scenarios as pure plans: AC-7 and AC-9 to AC-13 (421-594), AC-63 (667-686), AC-16 (687-730), AC-20 to AC-27 (817-988), AC-64 to AC-68 (989-1089), AC-31 (1132-1152), AC-37 (1227-1248), AC-40 to AC-43 and AC-69 (1310-1399). Do not run this file (see 2.3). |
| 8 | `src/db/types.ts` | Extend it (2.2 step 1). |
| 9 | `src/db/mappers.ts` | Reuse `encodeOutline`, `summaryColumns`, `detailsColumns`, `flattenComments`, `commentColumns`. Read only. |
| 10 | `src/db/rows.ts` | Row schemas: tests build synthetic state rows through them. Read only. |
| 11 | `tests/db/mappers.test.ts` | Style reference for a pure `tests/db` test and for building synthetic rows. Read only. |
| 12 | `eslint.config.js`, `vitest.config.ts`, `tsconfig.json` | Read only (lint rules, test globs). |

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. U5 needs nothing from it or from any database.

## 2. Execution Directives

### 2.1 add-test-writer

Write one **pure** test file, `tests/db/plan.test.ts`. It never connects to a database, never imports `connection`, `models`, `geometry`, `knex` or `objection`, never calls the network, and never edits `contracts/`. Inputs come from `contracts/storage.support.ts` (Client readings of the recorded fixtures) or small synthetic values. The public names under test are fixed by AL4 1.3 (`plan.ts` block); plan and state shapes by the `types.ts` block.

**Building stored state (synthetic rows).** Every row passes through `PlaceRowSchema` / `CommentRowSchema` / `TagLinkRowSchema` from `src/db/rows` before use. Suggested small helpers inside the test file (private, not exported):
- a summary-only place row from a `PlaceSummary`: `place_id`, `summaryColumns(...)`, every details column `null`, `details_fetched_at_text: null`;
- a detailed place row from `PlaceDetails` + link + moment: `place_id`, `wikimapia_url`, `detailsColumns(details, moment)` (its `details_fetched_at` key is stripped by the parse) plus `details_fetched_at_text: moment`;
- comment rows from `flattenComments(...)` + `commentColumns(...)`, with a way to override `presence: 'gone'`, `position: null`;
- link rows `{ place_id, tag_id, presence, position, title }`, and `tagTitles` as a `Map<number, string>`.
A "state equal to the input" built this way must plan **zero writes**; that is the base case most other tests vary one thing from.

**`dedupeListing`** (AL4 1.4.5; AC-13):
1. `[first 1381893, 62587, last 1381893 (renamed)]` gives `[1381893 (renamed value), 62587]`: first-appearance order, last value.
2. No duplicates: same order and values. Empty list gives `[]`. The input array is not mutated.

**`planListingSave`** (AL4 1.4.5 table; AC-7, AC-9 to AC-13, AC-63, D1, D6). Use summaries of `box-belgrade-page1.json`.
1. No stored row: `insert_summary` carrying the summary, outcome `created` (AC-7).
2. Summary-only row equal to the summary: no write, `unchanged` (AC-9).
3. Summary-only row, one difference at a time, each giving one `update_summary` and `updated` (AC-10): `name`; `wikimapia_url`; each of the six location numbers (one `it.each`); an outline point; an outline with one point more and one fewer. Use a tiny float change (e.g. `x + 1e-12` or `0.1 + 0.2` vs `0.3`) at least once to pin exact `===`, no rounding.
4. Detailed row whose name, location and outline differ from the summary but whose link is equal: no write, `unchanged` (AC-11, D1).
5. Detailed row with a different link (for example the Built Link `buildWikimapiaLink(id)` vs the Listing Link): exactly one `update_link` with `placeId` and the summary's `url`, `updated` (AC-63, D6). It never carries name, location or outline.
6. Mixed page (new, unchanged summary-only, changed summary-only, detailed with new link): `outcomes` in page order with one entry per distinct id; `writes` in the same order, one per changed place.
7. Duplicate ids on the page: one outcome per id, at the first appearance, planned from the last value (AC-13).
8. Empty page: `{ outcomes: [], writes: [] }` (AC-12). Stored rows for ids not on the page are ignored.

**`planDetailsSave`** (AL4 1.4.6; AC-16, AC-20 to AC-27, AC-31, AC-37, AC-40 to AC-43, AC-64 to AC-69, D1 to D3, D6). Use the 62587 reading, `nestedDetails()`/`nestedParts()`, and the 1381893 reading.
1. **New place** (`place: undefined`, no rows): `place` is `{ kind: 'insert', wikimapiaUrl: buildWikimapiaLink(placeId) }`, outcome `created`; every tag in `tagUpserts` (ascending id), every tag a link `insert` at its input index, every comment a `commentWrites` `insert` in pre-order; `goneLinks`/`goneComments` empty (AC-16, AC-31).
2. **Summary-only row** (same id, Listing Link stored): `update_details`, `updated` (AC-20). No plan field carries a link (D6).
3. **Identical** (detailed row, links, comments and tag titles all equal, same moment): `place` undefined, every list empty, `unchanged` (AC-21).
4. **Only the moment moved** (`LATER_FETCHED_AT`): `place` is `update_fetched_at`, every other list empty, `unchanged` (AC-22, D3).
5. **Details column changed** (one `it.each` row each): title, description, one flag, `parentPlaceId` added and removed, `wikipediaUrl` removed, one address item removed (absent == stored `null` means equal; absent vs stored value means different, AC-24), one location number, outline point: `update_details`, `updated` (AC-23, AC-24).
6. **Comments** (each `updated`, with exactly the expected `commentWrites` entry kinds and `flat` values):
   - one value field of one comment changed: one `update` (AC-25);
   - one new comment: one `insert` (AC-26);
   - two top-level comments swapped: `update` for both (positions changed);
   - reply moved (AC-37: Mateja > Serbia > Paul becomes Mateja > Serbia, Paul top-level): `update` for Paul only (`parent_num` and `position` changed);
   - a stored gone comment present again in the input with the same values: one `update` (AC-65).
7. **Gone items** (D2):
   - present stored comments and links missing from the input: `goneComments` / `goneLinks` in ascending order, `updated` (AC-27, AC-68: all comments gone);
   - a gone reply under a present parent, and a gone parent with replies, are listed by `num`, with no write to the kept rows (AC-66, AC-67);
   - **already gone** rows missing from the input are **not** listed again: re-saving the reduced input with a later moment gives `update_fetched_at` and `unchanged` (AC-64).
8. **Tags:**
   - duplicate tag id in the input: one link at the first occurrence's position, first title wins, one `tagUpserts` entry at most (AC-43);
   - stored title differs from the input title: exactly one `tagUpserts` entry, `updated` (AC-42); a tag already in `tagTitles` with the same title is not upserted;
   - tag reordered: `update` links with the new positions;
   - a stored gone link present again: one link `update` (AC-65);
   - a gone link to a tag shared with another place: listed only in this place's `goneLinks`; `tagUpserts` untouched (AC-69).
9. **Ordering and determinism:** `tagUpserts` ascending by id; `linkWrites` in deduplicated input order; `commentWrites` in pre-order; two calls with the same input and state give `toStrictEqual` plans; neither the input nor the state (rows, `Map`) is mutated (compare with `structuredClone` copies).

Before the coder runs, the tests fail only because `src/db/plan.ts` (and its types) are missing.

### 2.2 add-coder

Implement in this order. Import contract types and helpers from `../../contracts/storage.schema` and `../../contracts/wikimapia-client.schema`. Never redefine or re-export them.

1. **`src/db/types.ts`:** add `ListingState`, `DetailsState`, `ListingWrite`, `ListingPlan`, `PlaceDetailsWrite` and `DetailsPlan` exactly as in AL4 1.3. Extend the existing top-level `import type` lines with `SaveOutcomeKind`, `PlaceSummary` and `Tag`. Add nothing else (`Writer` belongs to U6).
2. **`src/db/plan.ts`** (AL4 1.4.5, 1.4.6). Pure and synchronous: no Knex, no Objection, no SQL, no I/O, no `async`. May import from `./mappers` (`encodeOutline`, `summaryColumns`, `detailsColumns`, `flattenComments`, `commentColumns`), `./types` (types only) and the contracts. Never import `connection`, `models`, `geometry`, `inspect`, `schema-setup`, `knex` or `objection`.
   - `dedupeListing(places)`: first index of each id fixes the order, the last value wins. Returns a new array.
   - `planListingSave(places, state)`: plans over `dedupeListing(places)` (idempotent, so U6 passing an already deduped list gives the same plan). Index `state.rows` by `place_id`. Apply the AL4 1.4.5 table row by row. Summary-only comparison: every key of `summaryColumns(s)` against the row with `===`, except `outline`, which is compared pair by pair (length, then each `lon`/`lat` with `===`). Detailed comparison: `wikimapia_url` only. Outcomes and writes in deduped order.
   - `planDetailsSave(input, state)`: follow the AL4 1.4.6 pseudo-code literally.
     - Place row: absent -> `insert` with `buildWikimapiaLink(D.placeId)`, base outcome `created`; summary-only -> `update_details`; detailed -> compare every key of `detailsColumns(D, F)` against the row with `===` **except** `details_fetched_at` (the row carries `details_fetched_at_text`) and `outline` (pairwise as above); any difference -> `update_details`; else `details_fetched_at_text !== F` -> `update_fetched_at` (does **not** count as a change, D3); else `undefined`.
     - Tags: dedupe `D.tags` by id, first occurrence wins (title and position = index in the deduped list). Upsert when the id is missing from `state.tagTitles` or the title differs. Link `insert` when no link row; `update` when the row is gone or its position differs. Gone links: present link rows whose `tag_id` is not in the deduped tags, ascending.
     - Comments: walk `flattenComments(D.comments)`. A `CommentRow` is assignable to `Record<string, unknown>` without a cast; compare every key of `commentColumns(D.placeId, flat)` (this covers the value fields, `parent_num`, `presence: 'present'` and `position`) against the row with `===`. No row -> `insert`; any difference -> `update`. Gone comments: present rows whose `num` is not in the input at any depth, ascending.
     - Outcome: `created` when there was no place row; otherwise `updated` if any change was planned (place `update_details`, a tag upsert, any link or comment write, any gone mark), else `unchanged`.
     - Sort `tagUpserts` ascending by id; keep `linkWrites` in deduped input order and `commentWrites` in pre-order.
   - Never mutate inputs or state. No rounding, no `toFixed`, no tolerance: equality is `===` on numbers as read back.
3. Narrow everything with types and guards. No `any`, no `as` casts to silence the compiler, no non-null assertions (`!`), no `@ts-expect-error`, no ESLint disable comments. If a contract type makes something impossible to express, stop and report it.
4. Run every Done-when check (2.3) and report each result with its exit code.

Scope: create or modify only `src/db/types.ts`, `src/db/plan.ts` and `tests/db/plan.test.ts`. Do not touch other `src/db` modules (including `mappers.ts`), `tests/db` files from earlier units, `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files or env files. If a mapper turns out to be wrong for planning, stop and report it instead of editing it.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker is needed only for the regression run in check 2. If `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. All of the following must hold:

1. `pnpm exec vitest run --no-color tests/db/plan.test.ts` passes with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` passes.
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly one error: TS2307 for `'../src/db/place-store'` in `contracts/storage.test.ts`. `pnpm lint` reports problems only in `contracts/storage.test.ts`, and only the follow-on problems of that missing module (AL4 section 4, "Baseline caveat").
5. Files:
   - `Get-ChildItem src/db -File` lists exactly `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `plan.ts`, `rows.ts`, `schema-setup.ts`, `types.ts` and `validate.ts`.
   - `Test-Path src/db/writer.ts, src/db/read.ts, src/db/place-store.ts` gives `False` for all three.
6. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/plan.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|toFixed|Math\.round|async |await "`
   - `Select-String -Path src/db/plan.ts -Pattern "^\s*(export\s+)?(type|interface)\s"` (no type declarations outside `types.ts`)
   - `Select-String -Path src/db/plan.ts -Pattern "from 'knex'|from 'objection'|\.raw\(|from './(connection|models|geometry|inspect|schema-setup)'"` (planner stays pure)
   - `Select-String -Path tests/db/plan.test.ts -Pattern "requireTestDatabaseUrl|createDb|from 'knex'|from 'objection'"` (pure test)
7. `.env` is unchanged. The orchestrator or the user checks this. AL2 does not open `.env`.

Do not run `contracts/storage.test.ts` or `pnpm test:db` as a gate. They stay red until U8.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, the support files and every contract test.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If AL4 1.4.5/1.4.6 and a contract test disagree on an outcome or a write (for example whether a tag title change or a returning gone item counts as `updated`), stop and report it with the exact AC and spec lines (`.agrules` section 0, "Triggered Bugfixing"). Do not guess.
- Never open, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js`, anything under `src/wikimapia/`, the U2 to U4 modules (other than adding the six types to `src/db/types.ts`), or any earlier AL3 prompt.

## 4. Out of Scope

- **U6:** `writer.ts` (`Writer` type, numbering, `onWrite` hook), `read.ts` (including `loadListingState` and `loadDetailsState`, which produce the state this unit consumes), `save-listing.ts`, advisory locks, transactions and turning `ListingWrite`s into statements.
- **U7:** `save-details.ts`: executing `DetailsPlan` (place insert/patch, tag upserts with `onConflict`, link and comment writes, gone marks), and the fault-injection loops of AC-56.
- **U8:** `place-store.ts`, input validation at the public entry points, mapping thrown errors to `store_unavailable`, and making `contracts/storage.test.ts` green.
- Any database access, Objection models or SQL in U5 code or tests.
- The `pgvector` npm package, vector or embedding columns (substep 4), and crawl-progress tables (substep 3).
- Recording AL4 decisions in `CLAUDE.md`. The orchestrator handles it.
