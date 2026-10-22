# AL3 Routing: storage, U7 "Details Save"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U7 of 8 (attempt 1)
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`. Read these sections: "0. Scope and Fixed Points" (including "Single source of truth" and "Code style"), "1.1 Module map" (row `save-details.ts` and the paragraph on SQL and unit tests below the table), "1.2 Call flow" (the "Details Save" column), "1.3 Component contracts" (`DetailsState`, `PlaceDetailsWrite`, `DetailsPlan`, and the `save-listing.ts / save-details.ts` block), "1.4.6 Details Save" (all of it, especially the `saveDetails` pseudo-code steps 1 to 4), "1.4.7 Writer and fault hook", "1.4.9 Map shapes" (last bullet: when shapes are recomputed), "1.5 Transaction boundaries" (row "Details Save" and the paragraph after the table), "2.2" to "2.4" (column tables, the `place_tags` and `comments` checks, the deferrable self-FK, and the "Invariants" paragraph), "3. Batch & External Calls" (row "Details Save"), "4. Implementation Units" ("Baseline caveat", "DB precondition" and "U7") and "5. AL2 Guidance" (all bullets).
- **AL6 decisions in play:** D1 (details win over a listing), D2 (Gone items kept with their values), D3 (a moved fetch moment alone is not a change), D4 (no shape below 3 points), D5 (every comment belongs to the place; enforced by validation in U2, so U7 input is already clean), D6 (Built Link on a details-only place; a Details Save never replaces a stored link). AL4 already encodes them. Read `docs/al6-requirements/20261021-storage-al6.md` section "5. Resolved Decisions" only if a rule is unclear.
- **Audience:** `add-test-writer` first, then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- U1 to U6 are done. `src/db/` contains `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `plan.ts`, `read.ts`, `rows.ts`, `save-listing.ts`, `schema-setup.ts`, `types.ts`, `validate.ts`, `writer.ts` and `migrations/`. `save-details.ts` and `place-store.ts` do not exist yet.
- `src/db/types.ts` already has `FlatComment`, `Writer`, `DetailsState`, `PlaceDetailsWrite` and `DetailsPlan` exactly as in AL4 1.3. U7 needs no new type.
- `src/db/plan.ts` (U5) provides `planDetailsSave(input, state)`. It dedupes tags (first occurrence wins), sorts `tagUpserts` and `goneLinks` by id, emits `commentWrites` in pre-order and `goneComments` ascending, and returns no `place` write when nothing moved (AC-21).
- `src/db/read.ts` (U6) provides `loadDetailsState(trx, details)`, which never opens a transaction. It returns the place row (or `undefined`), all comment rows of the place, all its links with tag titles, and `tagTitles` for the input's distinct tag ids. U6 tested it only on summary-only and missing places. U7 tests the detailed cases.
- `src/db/mappers.ts` (U4) provides `detailsColumns(details, fetchedAt)`. Every key is always present: absent optional items are `null`, `outline` is `[lon, lat]` pairs, and `details_fetched_at` is the fetch moment. It never contains `wikimapia_url` or `place_id`. `commentColumns(placeId, flat)` returns the full comment row including `place_id`, `num`, `parent_num`, `presence: 'present'` and `position`.
- `src/db/models.ts` (U3) has `PlaceModel` (`jsonAttributes = ['outline']`), `CommentModel` (`idColumn = ['place_id', 'num']`), `TagModel` and `PlaceTagModel` (`idColumn = ['place_id', 'tag_id']`).
- `src/db/save-listing.ts` (U6) is the pattern to follow: one `db.transaction`, `pg_advisory_xact_lock(?::bigint)`, load state, plan, `createWriter(onWrite)`, then one statement per planned write through `writer.run(...)`. Writes use the Objection form (`PlaceModel.query(trx).insert(...)` / `.findById(id).patch(...)`). Errors propagate.
- Schema facts that matter for write order: `place_tags.tag_id` references `tags` (`ON DELETE RESTRICT`, not deferrable), so a tag row must exist before its link is inserted. `comments (place_id, parent_num)` references `comments (place_id, num)` and is `DEFERRABLE INITIALLY DEFERRED`, so it is checked at commit. `presence`/`position` checks: `(presence = 'present') = (position IS NOT NULL)` on both `place_tags` and `comments`. There is no unique constraint on positions.
- `tests/db/listing.db.test.ts` shows the DB-test pattern: `createSchemaSetup` + `apply()` and a `createDb(requireTestDatabaseUrl(), POOL_MAX_STORE)` handle in `beforeAll`, `emptyStore()` in `beforeEach`, `destroyQuietly(db)` and `setup.close()` in `afterAll`, and every read parsed with its contract schema.
- The full suite is green except `contracts/storage.test.ts`, which cannot load `src/db/place-store` until U8.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, extensionless relative imports, top-level `import type` instead of inline `type` specifiers, every `type`/`interface` declared in `src/db/` kept in `src/db/types.ts`, and no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 0, 2, 3 (repository layer, parameterized queries), 4 and 5 matter most. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read the sections listed in the header. Skip the rest. |
| 4 | `contracts/storage.schema.ts` | Import these, never copy them: `STORE_TABLES` (75-86), `buildWikimapiaLink` (105), `WriteHook` (125-132), `SavePlaceDetailsInputSchema` / `SavePlaceDetailsInput` (204-214), `SaveReportSchema` / `SaveReport` (228-248), and the read-back schemas `ReadPlaceValueSchema`, `ReadShapesValueSchema`, `TagCatalogueSchema`, `PlaceTagLinkSchema`, `StoredCommentKeySchema`, `StoreCountsSchema` (250-417). |
| 5 | `contracts/wikimapia-client.schema.ts` | Types `PlaceDetails`, `Comment`, `Tag`, `Point`. Look them up by name. |
| 6 | `contracts/storage.support.ts` | Test inputs: `requireTestDatabaseUrl`, `clientDetails`, `clientListing`, `summaryOf`, `listingOf`, `at`, `FETCHED_AT`, `LATER_FETCHED_AT`, `EVEN_LATER_FETCHED_AT`, `rehome`, `nestedParts`, `nestedDetails`, `omitKeys`, `asPlaceDetails`, `withoutPresence`, `flattenComments`, `presenceMarks`, `storedNum`, `levelOrder`, `longMixedDescription`. Fixtures: `getbyid-62587.json`, `getbyid-1381893.json`, `getbyid-55.json`, `box-belgrade-page1.json`. |
| 7 | `contracts/storage.test.ts` | Read only. Mirror these scenarios at the module level: helpers 90-287 (for patterns: `snapshot`, `expectPresentThenGone`, `ring`, `expectSamePoints`), AC-11 (521-569), AC-63 (667-685), AC-16 to AC-33 (687-1174), AC-34 to AC-37 (1180-1247), AC-40 to AC-43 and AC-69 (1305-1394), AC-44 first test (1400-1410), AC-45 (1422-1438), AC-46 to AC-48 "Place Details" cases (1441-1495), AC-70 (1508-1525), AC-49 first test (1531-1543), AC-71 (1551-1564), AC-52 (1594-1615), AC-72 (1617-1637), AC-56 (1745-1787), AC-59 (1879-1897). Skip AC-38, AC-39, AC-53 to AC-55, AC-57 and AC-58: they test validation and the public factory (U2, U8). Do not run this file (see 2.3). |
| 8 | `src/db/save-listing.ts` | The pattern to follow. Read only. |
| 9 | `src/db/plan.ts` | `planDetailsSave`. Read only. |
| 10 | `src/db/read.ts` | `loadDetailsState` plus every read used by the tests. Read only. |
| 11 | `src/db/mappers.ts` | `detailsColumns`, `commentColumns`, `flattenComments`. Read only. |
| 12 | `src/db/geometry.ts` | `centrePointSql`, `outlineShapeSql`. Read only. |
| 13 | `src/db/models.ts` | `PlaceModel`, `CommentModel`, `PlaceTagModel`. Read only. |
| 14 | `src/db/writer.ts`, `src/db/types.ts` | `createWriter`; `DetailsPlan` and related types. Read only (but see 2.2 step 5). |
| 15 | `src/db/connection.ts`, `src/db/schema-setup.ts` | `createDb`, `destroyQuietly`, `POOL_MAX_STORE`, `createSchemaSetup` for the test lifecycle. Read only. |
| 16 | `tests/db/listing.db.test.ts` | Style and lifecycle reference for a `*.db.test.ts` file. Read only. |
| 17 | `eslint.config.js`, `vitest.config.ts`, `tsconfig.json` | Read only (lint rules, test globs, compiler flags). |

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. `TEST_DATABASE_URL` reaches the tests through `.env.test` and `vitest.config.ts`. Get the URL only through `requireTestDatabaseUrl()`.

## 2. Execution Directives

### 2.1 add-test-writer

Write one file: **`tests/db/details.db.test.ts`** (Test Database). It does not edit `contracts/`, call the network or read `.env`. It issues no SQL: no `.raw(`, no query builder calls, no model classes. Data goes in through `saveDetails` (and `saveListing` where a listing is part of the scenario). It comes out through `read.ts` functions. `saveDetails(db, input, onWrite)` is fixed by AL4 1.3.

**Lifecycle and helpers.** Use the same lifecycle as `tests/db/listing.db.test.ts`. Build every input as `SavePlaceDetailsInputSchema.parse({ details, fetchedAt })`, the parsed value that U8 will pass. Parse every report with `SaveReportSchema` and every read with its contract schema. Write a local `snapshot(placeIds)` helper modelled on the contract's (storage.test.ts 244-259). It should collect `readPlaceValue`, `listCommentKeys` and `readShapesValue` per place, then `listTagCatalogue`, `listLinksOfTag` for every catalogue tag, and `countAll`. Write a counting hook helper that records every write number it receives.

Cover:

1. **Created and round trip (AC-16, AC-17, AC-18, AC-19, AC-31 first test, AC-49):** for each of `getbyid-62587.json`, `getbyid-1381893.json`, `getbyid-55.json` and `nestedDetails()` (`it.each`), save with `LATER_FETCHED_AT`. The report is `[{ placeId, outcome: 'created' }]`. The place reads back `detailed`, `asPlaceDetails(place)` is `toStrictEqual` to the input, every presence mark is `present`, `wikimapiaUrl` is `buildWikimapiaLink(id)` and `detailsFetchedAt` is the moment. For 62587, also assert the AC-16 tag list and the AC-17 comment objects, including the absence of `authorPhotoUrl`/`moderatorName` on comment 1.
2. **Idempotent (AC-21, AC-31):** re-saving the same input with the same moment reports `unchanged`, leaves the snapshot `toStrictEqual`, and calls the hook **zero** times. Do this for 62587 and for `nestedDetails()`.
3. **Re-fetched (AC-22, D3):** the same details with `LATER_FETCHED_AT` reports `unchanged`. The hook is called exactly **once**. The read-back equals the earlier one except `detailsFetchedAt`, and `listCommentKeys` is unchanged.
4. **Summary-only completed (AC-20):** after a listing save of 1381893 with a different name, the details save reports `updated`, takes `title`/`location`/`outline` from the details, and keeps the Listing Link `http://wikimapia.org/1381893/University-Park`.
5. **Details changed (AC-23, AC-24):** the AC-23 `d2` reads back `toStrictEqual` through `asPlaceDetails`. Each single-field change (`it.each`: description, title, deleted mark, address item) reports `updated`. Removing `parentPlaceId`, `wikipediaUrl` and `street` reads them back as absent keys.
6. **Comment changed and added (AC-25, AC-26):** as in the contract.
7. **Gone (AC-27, AC-68, AC-71, D2):** the AC-27 reduction reports `updated`. Comment 1 reads back equal to its earlier value except `presence: 'gone'`, tag 44926 is `gone` after the present tag, and the catalogue still holds 44926. Removing all comments marks both `gone`. The marks match AC-71.
8. **Gone idempotent (AC-64):** with `it.each` over the same moment and a later moment, re-saving the reduction reports `unchanged`. The read-back changes only in `detailsFetchedAt`. `countAll` is `{ places: 1, comments: 2, tags: 2, placeTagLinks: 2 }`. The hook is called zero times (same moment) or once (later moment).
9. **Gone comes back (AC-65):** as in the contract. Comment 1 is stored once.
10. **Replies (AC-34, AC-35, AC-36, AC-37):** the nesting is rebuilt exactly, the comment keys carry `parentNum` 1 and 2, Ramona sits between Serbia and Paul, and Paul moved to the top level has no `parentNum`.
11. **Gone replies (AC-66, AC-67, AC-52, AC-59):** Paul gone stays under Serbia. In the AC-67 reshuffle (only Paul remains), the full `comments` array is `toStrictEqual` to the contract's expected value: Paul top-level present, Mateja gone holding Serbia gone with no replies. The AC-52 ordering holds at both levels. The authors read back as in AC-59 (comment part only).
12. **Tags (AC-40, AC-41, AC-42, AC-43, AC-69, AC-72):** the shared catalogue lists each tag once. `listLinksOfTag` lists the linked places in id order with presence. A changed title shows for present and gone links. A duplicate tag id gives one link. A gone link to a shared tag leaves the other place's link present. The AC-72 order is present-by-position, then gone-by-id.
13. **Shapes (AC-44, AC-45, AC-46, AC-47, AC-48 details cases, AC-70):** the 62587 polygon ring is the outline plus its first point (`toBeCloseTo(_, 9)`), with SRID 4326 and a centre point at `location`. An already closed outline adds no extra point. A bow tie is stored as given. With 2, 1 or 0 points there is no `outlineShape` key. Shrinking to `[]` in a later details save drops the shape, and growing restores it. A save that only moves the fetch moment leaves `readShapesValue` unchanged.
14. **Unusual values (AC-28, AC-29, AC-30, AC-32, AC-33):** the deleted place, the deleted/blocked comment and reply, parent place 999 with no place 999 stored, the 7,000+ character description and CRLF message character for character, and the empty description.
15. **Link precedence (AC-11, AC-31 second test, AC-63, D1, D6):** a Details Save after a Listing Save keeps the Listing Link, also after a changed details save. After details of 62587, a listing with a different name, location and outline but the same Built Link reports `unchanged` and changes nothing. A listing with the Listing Link reports `updated`, changes only `wikimapiaUrl`, and leaves `readShapesValue` identical.
16. **All or nothing (AC-56, module level):** save 62587, then take the snapshot. Build the contract's `d2` (new description, tags `[46360, { id: 300, title: 'fountain' }]` so 44926 goes, comment 2 changed, comment 1 gone, new comment 3 from `rehome(paul, 62587, 3)`) with `LATER_FETCHED_AT`. Loop `failAt` from 1 upward, using a hook that **rejects** at `failAt` (and, in a second test, one that **throws synchronously**). While `saveDetails` rejects, the snapshot is `toStrictEqual` to the earlier one, with every presence mark, the catalogue and the counts. Stop at the first success. At least one injection must have happened, the successful run's highest write number must be below `failAt`, and the description must then be the new one. Bound the loop (for example 200) and give each test a 120 s timeout.
17. **Lock and transaction (AL4 1.5, AL6 rule 13):** save 62587 once. Then run two `saveDetails` calls for 62587 concurrently (`Promise.all`) with inputs that differ only in `title` and `description` (same tags, same comments, same moment). Both resolve, and afterwards `asPlaceDetails(readDetailed)` is `toStrictEqual` to exactly one of the two inputs' details.
18. **`loadDetailsState` on a detailed place:** inside `db.transaction(async (trx) => ...)`, after the AC-27 reduction of 62587, call `loadDetailsState(trx, <62587 details with tags [46360, 46360, 999999]>)`. `place.details_fetched_at_text` is `LATER_FETCHED_AT`. `comments` holds both rows: num 1 has presence `gone`, `position` null and its old values. `links` holds both links, 44926 gone with `position` null and its title. `tagTitles` has exactly one entry, `46360 -> 'town square'`: no entry for 44926 (not in the input) and none for 999999 (not stored).

Before the coder runs, the file fails only because `src/db/save-details.ts` is missing.

### 2.2 add-coder

Create **`src/db/save-details.ts`** exporting `saveDetails(db: Knex, input: SavePlaceDetailsInput, onWrite: WriteHook | undefined): Promise<SaveReport>` (AL4 1.3, 1.4.6). Import contract types and helpers from `../../contracts/storage.schema` and `../../contracts/wikimapia-client.schema`. Never redefine or re-export them.

1. One `db.transaction(async (trx) => ...)` with the default READ COMMITTED isolation. First, `trx.raw('select pg_advisory_xact_lock(?::bigint)', [placeId])` with the id as a binding. Then `loadDetailsState(trx, input.details)`, `planDetailsSave(input, state)` and `createWriter(onWrite)`. Locks and selects never go through the writer.
2. Execute the plan **in exactly this order**, one statement per item, each through `await writer.run(<statement>)` (AL4 1.4.6 steps 1 to 4):
   1. **Place** (`plan.place`):
      - `insert`: `PlaceModel.query(trx).insert({ place_id, wikimapia_url: <the plan's wikimapiaUrl>, ...detailsColumns(D, F), centre_point: centrePointSql(trx, D.location), outline_shape: outlineShapeSql(trx, D.outline) })`. This is the only statement in the file that writes `wikimapia_url`.
      - `update_details`: `PlaceModel.query(trx).findById(placeId).patch({ ...detailsColumns(D, F), centre_point, outline_shape })`. A `null` shape must write `NULL` (AC-70). Never write `wikimapia_url` here (D6, AC-20, AC-31).
      - `update_fetched_at`: `patch({ details_fetched_at: F })` only, with no shapes and no other column.
      - `undefined`: no statement.
   2. **Tags** (`plan.tagUpserts`, already ascending): `trx(STORE_TABLES.tags).insert({ tag_id, title }).onConflict('tag_id').merge(['title'])`. These must run before any link insert (the FK to `tags` is not deferrable).
   3. **Links:** first `plan.linkWrites` in plan order. Use `insert` for `PlaceTagModel.query(trx).insert({ place_id, tag_id, presence: 'present', position })` and `update` for `PlaceTagModel.query(trx).findById([placeId, tagId]).patch({ presence: 'present', position })`. Then each id in `plan.goneLinks`: `findById([placeId, tagId]).patch({ presence: 'gone', position: null })`.
   4. **Comments:** first `plan.commentWrites` in plan (pre-order) order. Use `insert` for `CommentModel.query(trx).insert(commentColumns(placeId, flat))` and `update` for `CommentModel.query(trx).findById([placeId, num]).patch(<commentColumns(...) without place_id and num>)`. The update must write `parent_num` (null for a reply moved to the top level, AC-37/AC-67), presence `present` and the position. Then each num in `plan.goneComments`: `findById([placeId, num]).patch({ presence: 'gone', position: null })`. Patch only those two columns, because a Gone row keeps every value and its `parent_num` (AC-27, AC-66, AC-67).
3. Return `{ places: [{ placeId, outcome: plan.outcome }] }`. Any DB or hook error propagates and rolls the transaction back. Do not catch, wrap or map errors here: U8 does that.
4. **Typing.** `detailsColumns` and `commentColumns` return `Record<string, unknown>`. If an Objection `insert`/`patch` overload does not accept them, do not cast. Use the Knex query builder on the `STORE_TABLES` table name for that statement instead. For `places`, pass `outline` as `JSON.stringify(...)` of the pairs, because `jsonAttributes` does not apply to the builder. Report which form you used for each statement kind.
5. Do not use `any`, `as` casts that silence the compiler, non-null assertions (`!`), `@ts-expect-error`, ESLint disable comments or template literals. SQL text is a plain string literal and every value is a binding. Add no `type`/`interface` to `save-details.ts`. If you truly need a helper type, add it to `src/db/types.ts` (additions only) and report it.
6. If a test fails because of `plan.ts`, `read.ts`, `mappers.ts` or another earlier module (for example a wrong row from `loadDetailsState`, or a plan that misses a write), **stop and report** the AC, the observed value and the module. Do not edit those modules.
7. Run every Done-when check (2.3) and report each result with its exit code.

**Scope:** create or modify only `src/db/save-details.ts`, `tests/db/details.db.test.ts`, and (additions only, step 5) `src/db/types.ts`. Do not touch any other file. That includes `read.ts`, `plan.ts`, `mappers.ts`, `geometry.ts`, `models.ts`, `writer.ts`, `save-listing.ts`, `connection.ts`, `inspect.ts`, `schema-setup.ts`, migrations, `tests/db` files from earlier units, `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files and env files.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker must be up: if `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. All of the following must hold:

1. `pnpm exec vitest run --no-color tests/db/details.db.test.ts` passes with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` passes.
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly one error: TS2307 for `'../src/db/place-store'` in `contracts/storage.test.ts`. `pnpm lint` reports problems only in `contracts/storage.test.ts`, and only the follow-on problems of that missing module (AL4 section 4, "Baseline caveat").
5. Development Database check (proves `tsx` still loads `src/db`, AL4 section 5). `.env` has no `DATABASE_URL`, so set it in the shell for this one command and clear it afterwards. Shell values win over `.env` (`applyEnvDefaults`). The URL below is the compose default from AL4 2.7. If the user set a different `POSTGRES_PASSWORD`, the user substitutes it.
   ```powershell
   $env:DATABASE_URL = 'postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia'; pnpm db:status; Remove-Item Env:DATABASE_URL
   ```
   It runs without error and lists the four steps as applied. If it reports them pending, the Development Database was never migrated. Report that and do not migrate it.
6. Files:
   - `Get-ChildItem src/db -File | Select-Object -ExpandProperty Name` lists exactly `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `plan.ts`, `read.ts`, `rows.ts`, `save-details.ts`, `save-listing.ts`, `schema-setup.ts`, `types.ts`, `validate.ts` and `writer.ts`.
   - `Test-Path src/db/place-store.ts` gives `False`.
7. Guards. Each of the first four returns nothing:
   - `Select-String -Path src/db/save-details.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|toFixed|Math\.round|\$\{"`
   - `Select-String -Path src/db/save-details.ts -Pattern "^\s*(export\s+)?(type|interface)\s"` (no type declarations outside `types.ts`)
   - `Select-String -Path src/db/save-details.ts -Pattern "ST_AsGeoJSON|ST_MakeValid|ST_IsValid|Model\.knex\(|\.delete\(|\.del\(|truncate"` (no deletes, no outline rewrites)
   - `Select-String -Path tests/db/details.db.test.ts -Pattern "\.raw\(|Model\.query|from 'objection'|DATABASE_URL"` (no SQL in tests; URL only through `requireTestDatabaseUrl()`)
   - `(Select-String -Path src/db/save-details.ts -Pattern "wikimapia_url").Count` is `1` (the link is written only by the place insert).
8. `.env` is unchanged. The orchestrator or the user checks this. AL2 does not open `.env`.

Do not run `contracts/storage.test.ts` or `pnpm test:db` as a gate. They stay red until U8.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, the support files and every contract test.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If AL4 1.4.6 and a contract test disagree (for example on an outcome, a read-back value, an ordering or a write count), stop and report it with the exact AC and spec lines (`.agrules` section 0, "Triggered Bugfixing"). Do not guess.
- Never open, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js`, anything under `src/wikimapia/`, the U2 to U6 modules (beyond the `types.ts` additions allowed in 2.2), or any earlier AL3 prompt.

## 4. Out of Scope

- **U8:** `place-store.ts`. That covers input validation at the public entry points (AC-38, AC-39, AC-51, AC-53 to AC-55, AC-58), the "not configured" store, mapping thrown errors and gate failures to `store_unavailable` (AC-56's `store_unavailable` kind, AC-57), the `onWrite` option plumbing, the read-only REPEATABLE READ transaction around `readPlace`/`readPlaceShapes`, and making `contracts/storage.test.ts` green.
- Any change to `plan.ts`, `read.ts`, `mappers.ts`, `geometry.ts`, `writer.ts`, `save-listing.ts`, migrations or models. If one of them is wrong, report it.
- Deleting rows of any table (rows are never deleted, AL4 2.3, 2.4), `ST_MakeValid` or any rewrite of a stored outline.
- The `pgvector` npm package, vector or embedding columns (substep 4), and crawl-progress tables (substep 3).
- Recording AL4 decisions in `CLAUDE.md`. The orchestrator handles it.
