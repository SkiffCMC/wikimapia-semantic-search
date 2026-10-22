# AL3 Routing: storage, U4 "Pure mapping: geometry, outline, comment tree, read-back assembly"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U4 of 8 (attempt 1)
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`. Read these sections: "0. Scope and Fixed Points" (including "Code style"), "1.1 Module map" (rows `geometry.ts` and `mappers.ts`), "1.3 Component contracts" (the `types.ts`, `geometry.ts` and `mappers.ts` blocks), "1.4.6 Details Save" (only the `flattenComments` paragraph), "1.4.8 Read-back" (bullets "Summary-only", "Detailed", "Tags", "Comments"), "1.4.9 Map shapes", "2.1 General rules", "2.2" to "2.4" (column tables), "2.5 Mapping summary", "4. Implementation Units" ("Baseline caveat" and "U4"), and "5. AL2 Guidance"
- **Audience:** `add-test-writer` first, then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- U1 to U3 are done. The `postgres` compose service is healthy and the Test Database is migrated. U4 needs neither: both new modules are pure, and their tests never connect.
- `src/db/` contains `connection.ts`, `failures.ts`, `inspect.ts`, `models.ts`, `rows.ts`, `schema-setup.ts`, `types.ts`, `validate.ts` and `migrations/`. `geometry.ts` and `mappers.ts` do not exist yet.
- `src/db/rows.ts` defines the row schemas U4 consumes: `PlaceRowSchema` (every `places` column except the geometries, plus `details_fetched_at_text`), `CommentRowSchema`, `TagLinkRowSchema` (`place_tags` plus `title`). The shape and ring aliases (`centre_srid`/`centre_type`/`centre_x`/`centre_y`/`outline_srid`/`outline_type`, ring point `x`/`y`) belong to U6 and are not used here.
- `src/db/types.ts` already has `StoreResult`, `Validated`, every row type and `NamedMigration`. U4 adds `OutlinePairs` and `FlatComment` only.
- `src/db/connection.ts` uses the default import `import knex from 'knex'` (AL4 1.4.2 and section 5). `docs/al3-routing/20261021-storage-02-validate-al3.md` still mentions the named import `import { knex } from 'knex'`. That line is superseded. Do not follow it.
- **Name clash:** `contracts/storage.support.ts` also exports a function named `flattenComments`. It flattens `StoredComment` trees for the contract tests. In `tests/db/mappers.test.ts`, import it under an alias (for example `flattenComments as flattenStored`) if you need it. Never confuse it with `flattenComments` from `src/db/mappers`.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, extensionless relative imports, top-level `import type` instead of inline `type` specifiers, every `type`/`interface` declared in `src/db/` kept in `src/db/types.ts`, and no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 2 to 5 matter most here (validated boundaries, No Commenter IPs, strict types, code style). |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read the sections listed in the header. Skip the rest. |
| 4 | `contracts/storage.schema.ts` | Import, never copy: `outlineShapeRing`, `StoredTag`, `StoredComment`, `SummaryOnlyPlace`, `DetailedPlace`, the schemas `StoredCommentSchema`, `StoredTagSchema`, `SummaryOnlyPlaceSchema` and `DetailedPlaceSchema` (tests), and `buildWikimapiaLink` (test data). Lines 250 to 432 cover everything U4 needs. |
| 5 | `contracts/wikimapia-client.schema.ts` | Types `Point`, `Location`, `PlaceSummary`, `PlaceDetails`, `Comment`, `Tag`. Lines 236 to 345. |
| 6 | `contracts/storage.support.ts` | Test inputs: `clientDetails`, `clientListing`, `summaryOf`, `nestedParts`, `nestedDetails`, `rehome`, `FETCHED_AT`, `asPlaceDetails`, `withoutPresence`, `levelOrder`, `storedNum`, `UNREACHABLE_DATABASE_URL`. |
| 7 | `contracts/storage.test.ts` | Read only these `describe` blocks, to mirror their data sets in the unit tests: AC-8 (434-462), AC-18 (781-802), AC-19 (803-816), AC-34/AC-35/AC-36 (1180-1226), AC-44 (1400-1421), AC-46/AC-47/AC-48 (1448-1507), AC-49/AC-71 (1531-1564), AC-52/AC-72 (1594-1637), AC-66/AC-67 (1044-1077), AC-59 (1879-1902). Do not run this file (see 2.3). |
| 8 | `src/db/rows.ts` | Row schemas and column keys. Read only. |
| 9 | `src/db/types.ts` | Extend it (2.2 step 1). |
| 10 | `src/db/connection.ts` | Exports `createDb`, `destroyQuietly` and `POOL_MAX_STORE`. The geometry tests use them to get a Knex handle that never connects (2.1). Read only. |
| 11 | `tests/db/failures.test.ts` | Style reference for a pure `tests/db` unit test. Read only. |
| 12 | `eslint.config.js`, `vitest.config.ts`, `tsconfig.json` | Read only. They show the lint rules (`strictTypeChecked`, `no-console`) and the test file globs. |

Only if the wording of an AC is unclear, look it up in `docs/al6-requirements/20261021-storage-al6.md`. The spec and the contract tests win.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. U4 needs nothing from it or from any database.

## 2. Execution Directives

### 2.1 add-test-writer

Write two **pure** test files. They never connect to a database, never execute SQL, never call the network or OpenAI, and never edit `contracts/`. Build inputs from `contracts/storage.support.ts` (the Client's reading of the recorded fixtures) or from small synthetic values. Build synthetic DB rows as plain objects and pass them through `PlaceRowSchema` / `CommentRowSchema` / `TagLinkRowSchema` from `src/db/rows`, so the test proves they are valid rows. The public names under test are fixed by AL4 1.3 (the `geometry.ts` and `mappers.ts` blocks).

**`tests/db/geometry.test.ts`** (AL4 1.4.9; AC-44, AC-46 to AC-48):

For the `Knex.Raw` builders, create one handle in `beforeAll` with `createDb(UNREACHABLE_DATABASE_URL, POOL_MAX_STORE)`, and release it in `afterAll` with `destroyQuietly`. Inspect the fragments only through `.toSQL()` (`sql` and `bindings`). Never `await` a fragment, because awaiting would run it.

1. `pointGeoJson(lon, lat)` parses (`JSON.parse`) to `{ type: 'Point', coordinates: [lon, lat] }`.
2. `polygonGeoJson`:
   - An open 3-point ring that was already closed by `outlineShapeRing` has 4 positions, and the last equals the first.
   - An already closed 4-point outline (AC-46) keeps exactly 4 positions.
   - Coordinates round-trip exactly. `JSON.parse` gives back the identical doubles, for example `20.4573249816895` and `44.8165469050407`, and for values like `0.1 + 0.2`. No rounding.
   - The 19-point outline of the `getbyid-62587.json` reading gives 20 positions in the given order, closed with the first point (AC-44).
3. `centrePointSql(db, { lon, lat })`: `bindings` are exactly `[lon, lat]`. The `sql` contains `ST_MakePoint`, `ST_SetSRID` and `4326`, and does not contain the coordinate text.
4. `outlineShapeSql(db, outline)`:
   - Returns `null` for 0, 1 and 2 points, and for the closed 3-point outline A, B, A (AC-48, approved contract choice).
   - For a 3-point open outline, a 4-point closed outline and a self-crossing bow tie of 4 points (AC-47), it returns a raw whose `sql` contains `ST_GeomFromGeoJSON` and `4326`. It has exactly one binding, equal to `polygonGeoJson(outlineShapeRing(outline))`. No coordinate text appears in `sql`.
   - It never mutates the input array (compare against a deep copy).

**`tests/db/mappers.test.ts`** (AL4 1.4.6 `flattenComments`, 1.4.8, 2.2 to 2.5; AC-8, AC-16 to AC-19, AC-34 to AC-36, AC-49, AC-52, AC-59, AC-66, AC-67, AC-71, AC-72 on the mapping side):

1. **Outline encoding:**
   - `encodeOutline` gives `[[lon, lat], ...]` in order. `decodeOutline(encodeOutline(x))` `toStrictEqual`s `x` for: the 62587 outline, an empty outline, and a closed outline with its repeated point (AC-46, AC-48).
   - Both return new arrays.
2. **`summaryColumns(summary)`** for summary 164369 of `box-belgrade-page1.json` (AC-8):
   - Has exactly the keys `name`, `wikimapia_url`, `location_lon`, `location_lat`, `bound_north`, `bound_south`, `bound_east`, `bound_west` and `outline`.
   - `wikimapia_url` is the Listing Link (`summary.url`) unchanged.
   - `outline` equals `encodeOutline(summary.outline)`.
   - It has no `place_id`, no geometry keys and no details keys.
3. **`detailsColumns(details, FETCHED_AT)`** for the 62587 reading:
   - `name` is `title`.
   - Description, the three flags and the six location numbers map one to one.
   - `details_fetched_at` is the given string.
   - `outline` is the encoded outline.
   - All of `parent_place_id`, `wikipedia_url` and the six `address_*` keys are **present**, with value `null` when the item is absent from the input. AC-24 depends on this: a removed item must be overwritten with `null`.
   - The same details with every optional item set give the values, and `houseNumber` maps to `address_house_number`.
   - It has no `place_id`, `wikimapia_url` or geometry keys.
4. **`flattenComments`** (AC-34, AC-36):
   - For `nestedDetails()` (Mateja #1 > Serbia #2 > Paul #5), the result is pre-order with `num` `[1, 2, 5]`, `parentNum` `[null, 1, 2]` and `position` `[0, 0, 0]`.
   - For Mateja with replies `[serbia, ramona, paul]`, the order is `[1, 2, 7, 5]` with positions `[0, 0, 1, 2]` and every reply's `parentNum` equal to `1`.
   - Top-level siblings get positions `0..n-1`.
   - An empty list gives `[]`.
5. **`commentColumns(placeId, flat)`:**
   - Gives `place_id`, `num`, `parent_num`, `position`, `presence: 'present'` and the snake_case value columns of AL4 2.4.
   - `author_photo_url` and `moderator_name` are `null` when absent.
   - There is no `replies` key, and no key matches `/(^|_)ip($|_)/` (no Commenter IP column, AC-6).
6. **`buildStoredComments(rows)`:**
   - Rows built from the nested 62587 save (all present) rebuild exactly the AC-34 tree: `{ ...mateja, presence: 'present', replies: [{ ...serbia, ..., replies: [{ ...paul, ..., replies: [] }] }] }`, using `toStrictEqual`.
   - Each node passes `StoredCommentSchema`.
   - Absent `authorPhotoUrl` and `moderatorName` are **not present as keys** (check with `Object.hasOwn`).
   - Every node has `author` (AC-59).
   - Mirror the **AC-52** final state as rows. Top level: 3 present at position 0, 2 present at position 1, and 1, 4 and 9 gone. Under 2: 7 present at position 0 and 5 gone. Rows are given in a scrambled order. Then `levelOrder` gives `[[3,'present'],[2,'present'],[1,'gone'],[4,'gone'],[9,'gone']]` at the top and `[[7,'present'],[5,'gone']]` under 2.
   - **AC-66:** a gone reply stays under its present parent.
   - **AC-67:** a present or gone reply stays under its gone parent, and the gone parent keeps its own position in the gone group.
   - **AC-71:** present and gone rows are returned together.
   - **Defensive rule (AL4 1.4.8):** a row whose `parent_num` names a number with no row appears at the top level after all reachable top-level comments. Two rows whose `parent_num`s point at each other (a cycle) still terminate and appear exactly once each. No stored row is ever dropped: the count of nodes in the flattened tree equals the row count.
7. **`orderStoredTags(rows)`:**
   - Mirror **AC-72**: present 194 at position 0 and 300 at position 1, gone 46360 and 44926, rows in scrambled order. The result is `[194 present, 300 present, 44926 gone, 46360 gone]`.
   - Each element is exactly `{ id, title, presence }` and passes `StoredTagSchema`.
8. **`toSummaryOnlyPlace(row)`:**
   - A summary-only row (details columns null, `details_fetched_at_text` null, built from summary 164369) gives a value that passes `SummaryOnlyPlaceSchema`.
   - Its `outline` and `location` `toStrictEqual` the summary's, and `wikimapiaUrl` is the stored link.
   - `tags` and `comments` are `[]`, and there is no `detailsFetchedAt` key (AC-8, AC-49).
9. **`toDetailedPlace(row, links, comments)`:**
   - Build the row from the 62587 reading with `place_id`, the Built Link from `buildWikimapiaLink(62587)`, `detailsColumns(...)` and `details_fetched_at_text: FETCHED_AT`. Build the links (all present, input positions) and the comment rows (from `flattenComments` plus `commentColumns`).
   - The value passes `DetailedPlaceSchema`. `asPlaceDetails(value)` `toStrictEqual`s the Client reading (AC-18 shape), and `detailsFetchedAt` is `FETCHED_AT`.
   - Optional keys `parentPlaceId`, `wikipediaUrl` and the six `location` address keys are **absent** (`Object.hasOwn` false) when their column is `null`, and present when the column has a value (AC-19, AC-24 read side).
   - A detailed place with no comments and no links gives `comments: []` and `tags: []` (AC-19).
   - A row with `details_fetched_at_text: null`, or with a null required details column (`description` or a flag), makes `toDetailedPlace` throw. The error message must not contain any row value (see 2.2 step 4).

Before the coder runs, the tests fail only because `src/db/geometry.ts` and `src/db/mappers.ts` are missing.

### 2.2 add-coder

Implement in this order. Import contract schemas, types and helpers from `../../contracts/storage.schema` and `../../contracts/wikimapia-client.schema`. Never redefine or re-export them.

1. **`src/db/types.ts`:** add `OutlinePairs` (`[number, number][]`) and `FlatComment` (`{ comment: Comment; parentNum: number | null; position: number }`) exactly as in AL4 1.3. Add the needed contract type imports as top-level `import type` lines. Add nothing else. The state, plan and `Writer` types belong to U5 and U6.
2. **`src/db/geometry.ts`** (AL4 1.4.9), exactly as specified:
   - `pointGeoJson` and `polygonGeoJson` use `JSON.stringify` of the plain numbers.
   - `centrePointSql` is `db.raw('ST_SetSRID(ST_MakePoint(?, ?), 4326)', [lon, lat])`.
   - `outlineShapeSql` calls the contract `outlineShapeRing`. When that returns `undefined`, return `null`. Otherwise return `db.raw('ST_SetSRID(ST_GeomFromGeoJSON(?), 4326)', [polygonGeoJson(ring)])`.
   - Only `import type { Knex } from 'knex'`. No value import of `knex` is needed here.
   - Never interpolate a value into SQL text. Never use `ST_MakeValid`, `ST_IsValid`, `ST_AsGeoJSON`, `toFixed` or rounding.
3. **`src/db/mappers.ts`** (AL4 1.3, 1.4.6, 1.4.8, 2.2 to 2.5). Pure functions only: no Knex, no SQL, no I/O. `mappers.ts` must not import `geometry.ts`'s SQL builders, and `geometry.ts` must not import `mappers.ts`.
   - `encodeOutline` / `decodeOutline`: order-preserving, without copying or dropping a repeated closing point.
   - `summaryColumns(summary)`: the nine keys listed in 2.1 item 2.
   - `detailsColumns(details, fetchedAt)`:
     - `name` (from `title`), `description`, `is_building`, `is_region` and `is_deleted`.
     - `parent_place_id` and `wikipedia_url`, `null` when absent.
     - The six location numbers.
     - The six `address_*` columns, `null` when absent.
     - `outline` (encoded) and `details_fetched_at`.
     - Every key is always present, so an update overwrites removed items with `null`.
   - `flattenComments(comments)`: pre-order depth-first walk. `parentNum` is `null` at the top level, and `position` is the index among siblings. Iterate the given `replies`. Never mutate the input.
   - `commentColumns(placeId, flat)`: the AL4 2.4 columns. Use `null` for an absent `authorPhotoUrl` or `moderatorName`, set `presence: 'present'`, and take `position` and `parent_num` from `flat`. Add no `replies` key.
   - `orderStoredTags(rows)`: present by `position` ascending, then gone by `tag_id` ascending. Each element is `{ id: tag_id, title, presence }`. Sort a copy, never the input.
   - `buildStoredComments(rows)`:
     - Group the rows by `parent_num`.
     - Order each sibling list: present by `position`, then gone by `num`.
     - Build the tree recursively from the `null` group. Each node has the AL4 1.4.8 keys in Client camelCase plus `presence` and `replies`, with `placeId` taken from `place_id`. Attach `authorPhotoUrl` and `moderatorName` only when the column is not null.
     - Apply the defensive rule with a visited set: after the reachable tree is built, take every unvisited row whose parent is missing or unvisited, in ascending `num`, and append it at the top level with its unvisited descendants. A cycle must not recurse forever, and every row appears exactly once.
   - `toSummaryOnlyPlace(row)`: build the AL4 1.4.8 "Summary-only" shape. Read no address columns.
   - `toDetailedPlace(row, links, comments)`:
     - Build the AL4 1.4.8 "Detailed" shape with `tags: orderStoredTags(links)`, `comments: buildStoredComments(comments)` and `detailsFetchedAt` from `details_fetched_at_text`.
     - Attach `parentPlaceId`, `wikipediaUrl` and each address key of `location` only when the column is not null (`exactOptionalPropertyTypes`: never assign `undefined`).
4. **Routing clarification (not in AL4 1.3):** the row types make `description`, the three flags and `details_fetched_at_text` nullable. The table check `places_details_consistent` makes a null impossible for a detailed row. If `toDetailedPlace` meets a null there anyway, it throws `new Error('stored place row is not a detailed place')`. That is a fixed text with no row values. U8's `try/catch` maps the throw to `store_unavailable` (AL4 1.2 step 3). Do not return a partial value and do not use non-null assertions (`!`).
5. Narrow everything with types and guards. No `any`, no `as` casts to silence the compiler, no `@ts-expect-error`, no ESLint disable comments. If a contract type makes something impossible to express, stop and report it.
6. Run every Done-when check (2.3) and report each result with its exit code.

Scope: create or modify only `src/db/types.ts`, `src/db/geometry.ts`, `src/db/mappers.ts` and the two test files. Do not touch other `src/db` modules, `tests/db` files from earlier units, `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files or env files.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker is needed only for the regression run in check 2. If `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. All of the following must hold:

1. `pnpm exec vitest run --no-color tests/db/geometry.test.ts tests/db/mappers.test.ts` passes with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` passes.
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly one error: TS2307 for `'../src/db/place-store'` in `contracts/storage.test.ts`. `pnpm lint` reports problems only in `contracts/storage.test.ts`, and only the follow-on problems of that missing module (AL4 section 4, "Baseline caveat").
5. Files:
   - `Get-ChildItem src/db -File` lists exactly `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `rows.ts`, `schema-setup.ts`, `types.ts` and `validate.ts`.
   - `Test-Path src/db/plan.ts, src/db/place-store.ts` gives `False` for both.
6. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/geometry.ts, src/db/mappers.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|toFixed|Math\.round|ST_MakeValid|ST_IsValid|ST_AsGeoJSON|user_ip"`
   - `Select-String -Path src/db/geometry.ts, src/db/mappers.ts -Pattern "^\s*(export\s+)?(type|interface)\s"` (no type declarations outside `types.ts`)
   - `Select-String -Path src/db/mappers.ts -Pattern "from 'knex'|\.raw\("` (mappers stay free of SQL)
   - `Select-String -Path src/db/*.ts, src/db/migrations/*.ts, scripts/*.ts -Pattern "import \{[^}]*\bknex\b[^}]*\} from 'knex'"`
   - `Select-String -Path tests/db/geometry.test.ts, tests/db/mappers.test.ts -Pattern "requireTestDatabaseUrl|\.raw\(|await [a-zA-Z]*Sql\("` (pure tests: no Test Database, no executed fragments)
7. `.env` is unchanged. The orchestrator or the user checks this. AL2 does not open `.env`.

Do not run `contracts/storage.test.ts` or `pnpm test:db` as a gate. They stay red until U8.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, the support files and every contract test.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If a contract schema or helper looks wrong, stop and report it with the exact output (`.agrules` section 0, "Triggered Bugfixing"). Examples: `outlineShapeRing` disagreeing with AC-44/AC-46, or `DetailedPlaceSchema` rejecting a value built as AL4 1.4.8 says. Do not work around it in `src/db/`.
- Never open, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js`, anything under `src/wikimapia/`, the U2/U3 modules (other than adding the two types to `src/db/types.ts`), or any earlier AL3 prompt.

## 4. Out of Scope

- **U5:** `plan.ts`, `dedupeListing`, change detection and outcomes, and the types `ListingState`, `DetailsState`, `ListingWrite`, `ListingPlan`, `PlaceDetailsWrite` and `DetailsPlan`.
- **U6:** `writer.ts` and `read.ts`. That covers every SQL read: the place row with `to_char`, `readShapesValue` and the `ShapeRow`/`RingPointRow` mapping into `PlaceShapes`, the tag catalogue, the links of a tag, comment keys and counts. It also covers `save-listing.ts`, the read-back gate with `ReadPlaceValueSchema`, and the `Writer` type.
- **U7:** `save-details.ts`, the tag upserts, gone marks, advisory locks and transactions.
- **U8:** `place-store.ts`, mapping thrown errors to `store_unavailable`, and making `contracts/storage.test.ts` green.
- Using the Objection models or a live database in any U4 test.
- The `pgvector` npm package, vector or embedding columns (substep 4), and crawl-progress tables (substep 3).
- Recording AL4 decisions in `CLAUDE.md` or correcting `docs/al3-routing/20261021-storage-02-validate-al3.md`. The orchestrator handles both.
