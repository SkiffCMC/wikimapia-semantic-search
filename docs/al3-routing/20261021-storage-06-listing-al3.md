# AL3 Routing: storage, U6 "Writer, read queries and Listing Save"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U6 of 8 (attempt 1)
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`. Read these sections: "0. Scope and Fixed Points" (including "Single source of truth" and "Code style"), "1.1 Module map" (rows `writer.ts`, `read.ts`, `save-listing.ts`, and the paragraph on SQL and unit tests below the table), "1.2 Call flow" (the "Listing Save" column), "1.3 Component contracts" (the `Writer` interface, the `writer.ts`, `read.ts` and `save-listing.ts` blocks), "1.4.5 Listing Save" (`saveListing` pseudo-code and the "Statements" paragraph), "1.4.7 Writer and fault hook", "1.4.8 Read-back", "1.4.9 Map shapes" (last bullet: when shapes are recomputed), "1.5 Transaction boundaries", "2.2" to "2.4" (column tables), "4. Implementation Units" ("Baseline caveat", "DB precondition" and "U6") and "5. AL2 Guidance" (all bullets)
- **AL6 decisions in play:** D1 (details win over a listing), D4 (no shape below 3 points), D6 (Built Link replaced by a Listing Link). AL4 already encodes them. Read `docs/al6-requirements/20261021-storage-al6.md` section "5. Resolved Decisions" only if a rule is unclear.
- **Audience:** `add-test-writer` first, then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- U1 to U5 are done. `src/db/` contains `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `plan.ts`, `rows.ts`, `schema-setup.ts`, `types.ts`, `validate.ts` and `migrations/`. `writer.ts`, `read.ts` and `save-listing.ts` do not exist yet.
- `src/db/types.ts` has every row type, `OutlinePairs`, `FlatComment`, `NamedMigration` and the six planning types (`ListingState`, `DetailsState`, `ListingWrite`, `ListingPlan`, `PlaceDetailsWrite`, `DetailsPlan`). U6 adds `Writer` only.
- `src/db/plan.ts` (U5) provides `dedupeListing` and `planListingSave`. `planListingSave` dedupes internally, so passing an already deduped list gives the same plan.
- `src/db/mappers.ts` (U4) provides `summaryColumns` (keys: `name`, `wikimapia_url`, the six location columns and `outline` as `[lon, lat]` pairs), `toSummaryOnlyPlace`, `toDetailedPlace`, `orderStoredTags`, `buildStoredComments` and `decodeOutline`.
- `src/db/geometry.ts` (U4) provides `centrePointSql(db, location)` and `outlineShapeSql(db, outline)`. The second returns `null` when there is no shape (D4).
- `src/db/rows.ts` (U2) has `PlaceRowSchema` (with `details_fetched_at_text`), `CommentRowSchema`, `TagLinkRowSchema` (link + `title`), `TagRowSchema`, `ShapeRowSchema` (`centre_srid`, `centre_type`, `centre_x`, `centre_y`, `outline_srid`, `outline_type`), `RingPointRowSchema` (`x`, `y`) and `CountsRowSchema` (`places`, `comments`, `tags`, `place_tags`). Note: the contract's `StoreCounts` names the last key `placeTagLinks`. Map it.
- `src/db/models.ts` (U3) has `PlaceModel` with `jsonAttributes = ['outline']`, so Objection stringifies `outline` on write.
- `src/db/inspect.ts` (U3) shows the established read pattern: `const result: unknown = await db.raw(sql, bindings)`, then `z.object({ rows: z.array(XRowSchema) }).parse(result)`, and the assembled value gated with its contract schema (a failed gate **throws**; the public layer in U8 maps it to `store_unavailable`). Follow the same pattern in `read.ts`.
- `src/db/connection.ts` (U2) has `createDb`, `destroyQuietly`, `POOL_MAX_STORE`. `knex` is a default import everywhere.
- The Test Database is migrated. `tests/db/schema-setup.db.test.ts` shows the DB-test lifecycle: `createSchemaSetup({ connectionString: requireTestDatabaseUrl() })`, `apply()` in `beforeAll`, `emptyStore()` in `beforeEach`, close everything in `afterAll`. Vitest runs with `fileParallelism: false`.
- The full suite is green except `contracts/storage.test.ts`, which cannot load `src/db/place-store` until U8.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, extensionless relative imports, top-level `import type` instead of inline `type` specifiers, every `type`/`interface` declared in `src/db/` kept in `src/db/types.ts`, and no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 0, 2, 3 (repository layer, parameterized queries), 4 and 5 matter most. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read the sections listed in the header. Skip the rest. |
| 4 | `contracts/storage.schema.ts` | Import these, never copy them: `WriteHook` (lines 125-132), `SaveListingPageInput` (144-150), `SaveReport` (237-248), the read-back and inspection schemas and types `ReadPlaceValueSchema`, `ReadShapesValueSchema`, `PlaceShapesSchema`, `TagCatalogueSchema`, `PlaceTagLinkSchema`, `StoredCommentKeySchema`, `StoreCountsSchema` (250-417), and `STORE_TABLES`, `WGS84_SRID` (75-86). |
| 5 | `contracts/wikimapia-client.schema.ts` | Types `PlaceSummary`, `PlaceDetails`, `Point`. Look them up by name. |
| 6 | `contracts/storage.support.ts` | Test inputs: `requireTestDatabaseUrl`, `clientListing`, `summaryOf`, `listingOf`, `at`. Fixtures: `box-belgrade-page1.json` (places 1381893, 62587, 164369) and `box-belgrade-empty-page.json`. |
| 7 | `contracts/storage.test.ts` | Read only. Mirror these scenarios at the module level: helpers 90-287 (for patterns), AC-7 to AC-15 (421-665), AC-63 (667-681, read only to understand `update_link`), AC-44 second test and AC-45 (1412-1439), AC-48 "Place Summary" cases (1497-1505), AC-70 first half (1508-1516), AC-49 second test (1545-1548), AC-50 (1566-1570). Do not run this file (see 2.3). |
| 8 | `src/db/types.ts` | Extend it (2.2 step 1). |
| 9 | `src/db/plan.ts` | Reuse `dedupeListing`, `planListingSave`. Read only. |
| 10 | `src/db/mappers.ts` | Reuse `summaryColumns`, `toSummaryOnlyPlace`, `toDetailedPlace`, `orderStoredTags`, `buildStoredComments`, `decodeOutline`. Read only. |
| 11 | `src/db/geometry.ts` | Reuse `centrePointSql`, `outlineShapeSql`. Read only. |
| 12 | `src/db/rows.ts` | Row schemas to parse every query result. Read only (but see 2.2 step 3). |
| 13 | `src/db/models.ts` | `PlaceModel` for the writes. Read only. |
| 14 | `src/db/connection.ts` | `createDb`, `destroyQuietly`, `POOL_MAX_STORE`. Read only. |
| 15 | `src/db/inspect.ts` | Pattern for raw queries parsed with row schemas and gated with a contract schema. Read only. |
| 16 | `src/db/schema-setup.ts` | `createSchemaSetup` for the DB test lifecycle. Read only. |
| 17 | `tests/db/schema-setup.db.test.ts` | Style and lifecycle reference for a `*.db.test.ts` file. Read only. |
| 18 | `eslint.config.js`, `vitest.config.ts`, `tsconfig.json` | Read only (lint rules, test globs, compiler flags). |

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. `TEST_DATABASE_URL` reaches the tests through `.env.test` and `vitest.config.ts`, which you do not need to open either. Get the URL only through `requireTestDatabaseUrl()`.

## 2. Execution Directives

### 2.1 add-test-writer

Write two test files. Neither edits `contracts/`, calls the network or reads `.env`. Neither issues SQL: no `.raw(`, no query builder calls, no model classes. Data goes in through `saveListing` and comes out through `read.ts` functions. The public names are fixed by AL4 1.3 (`writer.ts`, `read.ts`, `save-listing.ts` blocks).

**A. `tests/db/writer.test.ts`** (pure: no database, no `knex`, no `objection`, no `connection` import). Statements are fake `PromiseLike` values (resolved or rejected promises). Cover AL4 1.4.7:
1. Without a hook, `run` resolves and `count` goes 0, 1, 2, 3 over three runs.
2. With a hook, the hook receives `1, 2, 3` in order, numbering starts at 1, and `count` matches after each run.
3. The hook is called only **after** the statement settles (use a deferred statement and check the hook has not run yet).
4. A hook that throws synchronously at write 2 makes the second `run` reject with that error. Same for a hook that returns a rejected promise. An async hook is awaited before `run` resolves.
5. A rejecting statement makes `run` reject, the hook is not called for it, and `count` does not increase.
6. Two writers from two `createWriter` calls number independently.

**B. `tests/db/listing.db.test.ts`** (Test Database). Lifecycle: in `beforeAll`, `createSchemaSetup({ connectionString: requireTestDatabaseUrl() })` and `apply()` (assert ok), plus one `createDb(requireTestDatabaseUrl(), POOL_MAX_STORE)` handle. Call `emptyStore()` in `beforeEach` (assert ok). In `afterAll`, `destroyQuietly(db)` and `setup.close()`. Parse every `read.ts` result with its contract schema before asserting (`ReadPlaceValueSchema`, `ReadShapesValueSchema`, `TagCatalogueSchema`, `z.array(PlaceTagLinkSchema)`, `z.array(StoredCommentKeySchema)`, `StoreCountsSchema`) and every report with `SaveReportSchema`. Cover:
1. **Created (AC-7):** saving `box-belgrade-page1.json` reports the three ids `created` in page order. `countAll` gives `{ places: 3, comments: 0, tags: 0, placeTagLinks: 0 }`. Each place reads back `summary_only`.
2. **Summary content (AC-8, AC-49, AC-14):** `readPlaceValue(db, 1381893)` is `toStrictEqual` to `{ found: true, place: <the exact AC-8 object> }`. The place has no `detailsFetchedAt`, `page`, `pageSize` or `totalFound` key.
3. **Idempotent (AC-9):** a second save of the same page reports all three `unchanged`. A snapshot (read value, shapes and counts for the three ids) is `toStrictEqual` before and after. A hook passed on that second save is never called (zero writes).
4. **Update (AC-10):** the AC-10 changed summary reports `updated` and reads back with the new name, link, location and outline. The "outline alone" case also reports `updated`.
5. **Duplicates (AC-13):** `listingOf(first, 62587, last)` reports 1381893 once, as `created` at the first position, stores the last name, and gives `countAll().places === 2`.
6. **Empty page (AC-12):** after the full page, the empty-page fixture reports `{ places: [] }` and the snapshot is unchanged. With a hook that throws on any call, the hook is not called.
7. **All or nothing (AC-15 third test, module level):** loop `failAt` from 1 upward. Call `saveListing(db, page, hook)` with a hook that throws at `failAt`. While it rejects, `countAll` stays at all zeros. Stop at the first success. At least one injection must happen, and the final count is 3 places. Repeat once with a hook that **rejects** (async) at write 2: the save rejects and the counts stay at zero.
8. **Shapes (AC-44, AC-45, AC-48, AC-70):** for 1381893 after the page save, `readShapesValue` gives `centrePoint` `{ type: 'Point', srid: 4326 }` at the summary's `lon`/`lat`, and `outlineShape` `{ type: 'Polygon', srid: 4326 }` whose ring is the summary outline plus its first point (compare points with `toBeCloseTo(_, 9)`, as the contract does). After a listing save of the same summary with `outline.slice(0, 2)`, the value has no `outlineShape` key. With 1 point and 0 points (`it.each`): saved, no `outlineShape`, centre point present, outline read back as given. Growing back to the full outline restores the shape.
9. **Not found (AC-50):** `readPlaceValue(db, 424242)` is `{ found: false, placeId: 424242 }`. `readShapesValue(db, 424242)` is `{ found: false, placeId: 424242 }`.
10. **Other reads on a summary-only store:** `listTagCatalogue` is `[]`, `listLinksOfTag(db, 194)` is `[]`, and `listCommentKeys(db, 1381893)` and `listCommentKeys(db, 424242)` are `[]`.
11. **State loaders:** inside `db.transaction(async (trx) => ...)`, `loadListingState(trx, [62587, 424242])` returns exactly one row (62587) whose `details_fetched_at_text` is `null`. `loadListingState(trx, [])` returns `{ rows: [] }`. `loadDetailsState(trx, <a PlaceDetails for 1381893 with two tags>)` on a summary-only 1381893 gives a summary-only `place`, `comments: []`, `links: []` and an empty `tagTitles` map. The same call for a details value whose `placeId` is not stored gives `place: undefined`. Build the details value from `clientDetails('getbyid-1381893.json')`. U7 tests the detailed cases.
12. **Read-only snapshot:** `readPlaceValue` and `readShapesValue` also work when called with a transaction opened as `db.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true })`. This is how U8 will call them.

Before the coder runs, both files fail only because `src/db/writer.ts`, `src/db/read.ts` and `src/db/save-listing.ts` are missing.

### 2.2 add-coder

Implement in this order. Import contract types, schemas and helpers from `../../contracts/storage.schema` and `../../contracts/wikimapia-client.schema`. Never redefine or re-export them.

1. **`src/db/types.ts`:** add the `Writer` interface exactly as in AL4 1.3 (`run(statement: PromiseLike<unknown>): Promise<void>`, `readonly count: number`). Add nothing else unless step 3 requires a new row type.
2. **`src/db/writer.ts`** (AL4 1.4.7): `createWriter(onWrite)` returns a `Writer` that awaits the statement, increments its count, and then awaits `onWrite(count)` when a hook is given. A hook error (synchronous throw or rejection) propagates unchanged. Pure: no Knex, no SQL, no imports besides types and the contract `WriteHook` type.
3. **`src/db/read.ts`** (AL4 1.4.8). Every function takes `db: Knex | Knex.Transaction` (the loaders take the transaction) and runs its queries on it. **No function in `read.ts` opens a transaction.** The caller wraps multi-query reads (U8 for `readPlace`/`readPlaceShapes`, the save modules for the loaders). Every result is assigned to `unknown` and parsed with a row schema from `./rows`. Every assembled public value is gated with its contract schema using `.parse` (it throws on mismatch, as in `inspect.ts`).
   - One private place-row select used by `readPlaceValue`, `loadListingState` and `loadDetailsState`: every `places` column except `centre_point` and `outline_shape`, plus `to_char(details_fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS details_fetched_at_text`. Filter ids with bindings (`where`/`whereIn`), never with string building.
   - `readPlaceValue(db, placeId)`: no row gives `{ found: false, placeId }`. A summary-only row gives `toSummaryOnlyPlace(row)`. A detailed row also loads the place's links joined with `tags.title` (`TagLinkRowSchema`) and all its comment rows (`CommentRowSchema`), then uses `toDetailedPlace`. Gate with `ReadPlaceValueSchema`.
   - `readShapesValue(db, placeId)`: one query for `ST_SRID`, `GeometryType`, `ST_X`, `ST_Y` of `centre_point` and `ST_SRID`, `GeometryType` of `outline_shape` (aliases as in `ShapeRowSchema`). When `outline_shape` is not null, run the `ST_DumpPoints(ST_ExteriorRing(...))` ring query ordered by `path[1]` (`RingPointRowSchema`). Map `POINT` to `Point` and `POLYGON` to `Polygon`. Omit `outlineShape` when it is null. Build the value with plain keys and gate it with `ReadShapesValueSchema` (that narrows the `srid`/`type` literals; no `as`). Never use `ST_AsGeoJSON`.
   - `listTagCatalogue`, `listLinksOfTag`, `listCommentKeys`, `countAll`: as in AL4 1.4.8, last bullet. Each maps the snake_case row to its contract shape. `parentNum` is attached only when not null (`exactOptionalPropertyTypes`). `countAll` is one statement with four `count(*)` sub-selects, mapping `place_tags` to `placeTagLinks`. Gate with `TagCatalogueSchema`, `z.array(PlaceTagLinkSchema)`, `z.array(StoredCommentKeySchema)` and `StoreCountsSchema`.
   - `loadListingState(trx, placeIds)`: an empty list gives `{ rows: [] }` without a query. Otherwise return the place rows for those ids.
   - `loadDetailsState(trx, details)` (consumed by U7): the place row (or `undefined`), all comment rows of the place, all its links with titles, and `tagTitles`, a `Map` of the stored titles for the distinct tag ids in `details.tags`. Skip the query when there are no tags.
   - Reuse the existing row schemas, selecting the full comment and link rows where needed. If a query truly needs a new row shape, add it to `rows.ts` and its `z.infer` type to `types.ts`. Additions only, and report them.
4. **`src/db/save-listing.ts`** (AL4 1.4.5 `saveListing` pseudo-code and "Statements"; 1.5 row "Listing Save"):
   - `saveListing(db, page, onWrite)`: `places = dedupeListing(page.places)`. An empty list returns `{ places: [] }` with no transaction and no query. Otherwise use one `db.transaction` (default READ COMMITTED) that does the following:
     - Take `pg_advisory_xact_lock(?::bigint)` for every distinct id in **numeric** ascending order. Use a comparator: the default `sort()` is lexicographic.
     - `loadListingState`, then `planListingSave`, then `createWriter(onWrite)`.
     - Run one statement per planned write, in plan order, each through `writer.run(...)`, then return `{ places: plan.outcomes }`.
   - Locks and selects never go through the writer.
   - `insert_summary`: `PlaceModel.query(trx).insert({ place_id, ...summaryColumns(s), centre_point: centrePointSql(trx, s.location), outline_shape: outlineShapeSql(trx, s.outline) })`.
   - `update_summary`: `PlaceModel.query(trx).findById(id).patch(...)` with the same columns minus `place_id`. A `null` from `outlineShapeSql` must write `NULL` (AC-70 shrink).
   - `update_link`: `patch({ wikimapia_url })` only, with no shapes and no other columns.
   - Any DB or hook error propagates (the transaction rolls back). Do not catch, wrap or map errors here: U8 does that.
   - Objection typing: `summaryColumns` returns `Record<string, unknown>`. If the `insert`/`patch` overloads do not accept it, do not cast. Use the Knex query builder on `STORE_TABLES.places` for that statement instead, with `outline` passed as `JSON.stringify(...)` of the pairs, because `jsonAttributes` does not apply to the builder and pg would otherwise send a Postgres array literal. Report which form you used.
5. Narrow everything with types and guards. Do not use `any`, `as` casts that silence the compiler, non-null assertions (`!`), `@ts-expect-error` or ESLint disable comments. Do not use template literals in `read.ts`, `save-listing.ts` or `writer.ts`: SQL text is a plain string literal and every value is a binding. If a contract type makes something impossible to express, stop and report it.
6. Run every Done-when check (2.3) and report each result with its exit code.

**Scope:** create or modify only `src/db/types.ts`, `src/db/writer.ts`, `src/db/read.ts`, `src/db/save-listing.ts`, `tests/db/writer.test.ts`, `tests/db/listing.db.test.ts`, and (additions only, step 3) `src/db/rows.ts`. Do not touch any other file. That includes the other `src/db` modules (`plan.ts`, `mappers.ts`, `geometry.ts`, `models.ts`, `connection.ts`, `inspect.ts`, `schema-setup.ts`), `tests/db` files from earlier units, migrations, `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files and env files. If an earlier module turns out to be wrong, stop and report it instead of editing it.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker must be up: if `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. All of the following must hold:

1. `pnpm exec vitest run --no-color tests/db/writer.test.ts tests/db/listing.db.test.ts` passes with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` passes.
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly one error: TS2307 for `'../src/db/place-store'` in `contracts/storage.test.ts`. `pnpm lint` reports problems only in `contracts/storage.test.ts`, and only the follow-on problems of that missing module (AL4 section 4, "Baseline caveat").
5. `pnpm db:status` still loads and runs (proves the new modules did not break `tsx` loading of `src/db`, AL4 section 5), and shows the Development Database's four steps as applied.
6. Files:
   - `Get-ChildItem src/db -File` lists exactly `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `plan.ts`, `read.ts`, `rows.ts`, `save-listing.ts`, `schema-setup.ts`, `types.ts`, `validate.ts` and `writer.ts`.
   - `Test-Path src/db/save-details.ts, src/db/place-store.ts` gives `False` for both.
7. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/writer.ts, src/db/read.ts, src/db/save-listing.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|toFixed|Math\.round|\$\{"`
   - `Select-String -Path src/db/writer.ts, src/db/read.ts, src/db/save-listing.ts -Pattern "^\s*(export\s+)?(type|interface)\s"` (no type declarations outside `types.ts`)
   - `Select-String -Path src/db/read.ts, src/db/save-listing.ts -Pattern "ST_AsGeoJSON|ST_MakeValid|ST_IsValid|Model\.knex\("`
   - `Select-String -Path src/db/writer.ts -Pattern "from 'knex'|from 'objection'|\.raw\("` (writer stays pure)
   - `Select-String -Path tests/db/writer.test.ts -Pattern "requireTestDatabaseUrl|createDb|from 'knex'|from 'objection'"` (pure test)
   - `Select-String -Path tests/db/listing.db.test.ts -Pattern "\.raw\(|Model\.query|from 'objection'|DATABASE_URL"` (no SQL in tests; URL only through `requireTestDatabaseUrl()`)
8. `.env` is unchanged. The orchestrator or the user checks this. AL2 does not open `.env`.

Do not run `contracts/storage.test.ts` or `pnpm test:db` as a gate. They stay red until U8.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, the support files and every contract test.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If AL4 1.4.5, 1.4.7 or 1.4.8 and a contract test disagree (for example on a read-back key, an ordering or a write count), stop and report it with the exact AC and spec lines (`.agrules` section 0, "Triggered Bugfixing"). Do not guess.
- Never open, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js`, anything under `src/wikimapia/`, the U2 to U5 modules (beyond the additions allowed in 2.2), or any earlier AL3 prompt.

## 4. Out of Scope

- **U7:** `save-details.ts`. That covers executing `DetailsPlan` (place insert/patch, tag upserts with `onConflict`, link and comment writes, gone marks), the AC-56 fault-injection loops, and DB tests of detailed read-back, comments, tags, links and `update_link` on a detailed place (AC-11, AC-63 end to end). U6 implements `loadDetailsState` and the detailed branch of `readPlaceValue` but tests them only on summary-only and missing places.
- **U8:** `place-store.ts`. That covers input validation at the public entry points, opening the read-only REPEATABLE READ transaction around `readPlace`/`readPlaceShapes`, mapping thrown errors and gate failures to `store_unavailable`, the `onWrite` option plumbing, and making `contracts/storage.test.ts` green.
- Any change to `plan.ts`, `mappers.ts`, `geometry.ts`, migrations or models.
- The `pgvector` npm package, vector or embedding columns (substep 4), and crawl-progress tables (substep 3).
- Recording AL4 decisions in `CLAUDE.md`. The orchestrator handles it.
