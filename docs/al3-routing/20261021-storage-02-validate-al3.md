# AL3 Routing: storage, U2 "Internal types, row schemas, failures, input validation, connection factory"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U2 of 8 (attempt 1)
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`, sections "0. Scope and Fixed Points", "1.1 Module map", "1.3 Component contracts (signatures)", "1.4.2 Connection", "1.4.3 Failures", "1.4.4 Input validation", "2.1" to "2.4" (column lists, for the row schemas only), "4. Implementation Units" ("Baseline caveat", "U2") and "5. AL2 Guidance"
- **Audience:** `add-test-writer` first, then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- U1 is done. `knex`, `pg`, `objection`, `@types/pg` and `tsx` are installed. The `postgres` compose service is healthy on `127.0.0.1:5433` and serves `wikimapia` and `wikimapia_test`. `.env.test` exists, and `vitest.config.ts` loads it into the test env with `fileParallelism: false`.
- `src/db/` and `tests/db/` do not exist yet. U2 creates both.
- No migrations have been applied. U2 needs none: the DB test only runs `select` against the server.
- `src/wikimapia/issues.ts` exports `MAX_REPORTED_ISSUES`, `toFailureIssues`, `formatIssuePath` and `describeIssues`. U2 reuses the first three. Note that `formatIssuePath([])` returns `(whole answer)`, while AL4 1.4.3 wants `(whole input)` for the store. See 2.2 step 3.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, pnpm, extensionless relative imports, and every `type`/`interface` declared in `src/db/` kept in `src/db/types.ts` (`.agrules` section 5).

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 2 and 4 (validated boundaries, No Commenter IPs, no secrets, strict types) and 5 (code style) matter most here. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read the sections listed in the header above. Skip the rest. |
| 4 | `contracts/storage.schema.ts` | Source of `SaveListingPageInputSchema`, `SavePlaceDetailsInputSchema`, `PlaceRefInputSchema`, `TagRefInputSchema`, `findCommentRuleIssues`, `StoreIssue`, `StoreFailure`, `StoreFailureSchema`, `InvalidDataFailureSchema` and `StoreUnavailableFailureSchema`. Import these; never copy them. |
| 5 | `contracts/wikimapia-client.schema.ts` | `PlaceDetailsSchema`, `FailureIssue` and `findCommenterIpPaths`. Read only the parts you import. |
| 6 | `contracts/storage.support.ts` | Test inputs: `clientDetails`, `clientListing`, `nestedParts`, `nestedDetails`, `omitKeys`, `at`, `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL` and `UNREACHABLE_PASSWORD`. |
| 7 | `contracts/wikimapia-client.support.ts` | `SYNTHETIC_IPS` only (line 97). |
| 8 | `contracts/storage.test.ts` | Read only the `describe` blocks AC-15 (lines 616-665), AC-38/AC-39 (1249-1299), AC-51 (1572-1592), AC-53/AC-54/AC-55 (1643-1743) and AC-57 (1789-1856). They show the exact inputs and issue paths the unit tests must mirror. Do not run this file (see 2.3). |
| 9 | `src/wikimapia/issues.ts` | Reused helpers (`toFailureIssues`, `formatIssuePath`, `MAX_REPORTED_ISSUES`). Read only. |
| 10 | `src/wikimapia/types.ts` | Style reference for a types-only `types.ts`. Read only. |
| 11 | `tests/wikimapia/issues.test.ts` | Style reference for a pure unit test in this repo. Read only. |
| 12 | `vitest.config.ts`, `tsconfig.json`, `eslint.config.js` | Read only. They confirm that `tests/db/**` is picked up and type-checked and show the lint rules (`strictTypeChecked`, `no-console`). |

Only if the wording of an AC is unclear, look it up in `docs/al6-requirements/20261021-storage-al6.md`. The spec and the contract tests win.

**Never read, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. The tests get `TEST_DATABASE_URL` from `.env.test` through `vitest.config.ts` and need nothing from `.env`.

## 2. Execution Directives

### 2.1 add-test-writer

Write three test files. Only `tests/db/connection.db.test.ts` touches the database. Tests never issue SQL themselves, never edit `contracts/`, never call the network or OpenAI, and never contain a real password. Build inputs from the support helpers (manifest rows 6 and 7). For the secret checks, use synthetic values such as `UNREACHABLE_PASSWORD`. The public names under test are fixed by AL4 1.3 plus the two additions in 2.2 (`parseSafeInt8` and `selectBigint`).

**`tests/db/validate.test.ts`** (pure, covers AL4 1.4.4). Every invalid case must give `ok: false`, a failure that passes `InvalidDataFailureSchema`, and an issue whose `path` equals the expected path exactly:

1. `validateListingInput`:
   - `['places', 1, 'placeId']` when the second summary has Place ID `0`.
   - `['places', 2, 'url']` when the third summary has a link to another place (`http://wikimapia.org/55/Eiffel-Tower`).
   - `['places', 0, 'location', 'lon']` for longitude `200`.
   - `undefined` gives `invalid_data` with path `[]`.
   - The unmodified Belgrade page gives `ok: true`.
2. `validateDetailsInput` shape errors:
   - `['details', 'title']` when the title is omitted.
   - `['details', 'comments', 1, 'author']` when the second comment has no author.
   - `['details', 'comments', 0, 'replies', 0, 'replies', 0, 'goodVotes']` for `goodVotes: 1.5` on Paul in the nested shape.
   - The valid 62587 details with `FETCHED_AT` give `ok: true`, and the value equals the parsed input.
3. `validateDetailsInput` with a bad `fetchedAt` gives `['fetchedAt']` for each of: missing, `'yesterday'`, `'2026-13-01T00:00:00Z'`, `'2026-10-21T12:00:00+02:00'` and the number `1761040800`.
4. Comment-rule enrichment (AC-38, AC-39):
   - For the `getbyid-62587-nested-replies.json` reading, the issue at `['details','comments',0,'replies',0,'replies',0,'placeId']` carries `commentNum: 5` and `placeId: 55`.
   - A top-level foreign comment carries `commentNum: 1` and `placeId: 55`.
   - A duplicate top-level number `2` gives an issue with `commentNum: 2`.
   - Paul renumbered to `1` at depth 2 gives an issue at `[...,'replies',0,'num']` with `commentNum: 1` and no `placeId` key.
   - Issues that do not come from a comment rule have no `commentNum` or `placeId` key at all (check with `Object.hasOwn` or `toStrictEqual`).
5. Robustness:
   - `validateDetailsInput(undefined)`, `null`, `{ details: 'x' }`, `{ details: { comments: 'x' } }` and a details value whose `replies` is not an array all return `invalid_data` and never throw.
   - The returned issues are never empty and are capped at 20.
6. No Commenter IP (AC-54): `user_ip`, `userIp` and `commenterIp` set to `SYNTHETIC_IPS[1]` on a reply to a reply, and `user_ip` set to `SYNTHETIC_IPS[0]` on a top-level comment, all give `invalid_data`. `JSON.stringify(failure)` contains neither `String(ip)` nor `String(Math.abs(ip))`.
7. `validatePlaceRef`: `{ placeId: 0 | -3 | 1.5 | NaN }` each gives path `['placeId']`, and `{ placeId: 62587 }` gives `ok: true`. `validateTagRef`: `{ tagId: -1 }` gives path `['tagId']`, and `{ tagId: 0 }` gives `ok: true`.

**`tests/db/failures.test.ts`** (pure, covers AL4 1.4.3):

1. `invalidData(issues)`:
   - Gives `kind: 'invalid_data'` and passes `InvalidDataFailureSchema`.
   - Passing 25 issues keeps 20.
   - Passing `[]` still gives one issue (non-empty).
   - The message starts with `Invalid data` and names the first issue's path.
   - A path of `[]` renders as `(whole input)`.
   - More than one issue adds ` (+N more)`.
   - `commentNum` and `placeId` on an input issue are kept.
2. `describeStoreIssues(prefix, issues)`: check the exact text for one issue with a nested path (for example `details.comments[0].replies[0].placeId`), for several issues, and for the empty path.
3. `storeUnavailable(message)`: gives `kind: 'store_unavailable'` and passes `StoreUnavailableFailureSchema`.
4. `safeErrorCode`:
   - Returns `ECONNREFUSED` from `error.code`.
   - Returns `3D000` and `28P01` (SQLSTATE).
   - Reads `error.cause.code` when `error.code` is absent.
   - Returns `undefined` for a lowercase code, a code with spaces or a URL, a non-string code, a non-object value (`'boom'`, `undefined`, `42`) and an error without a code.
5. `unavailableFrom(error, action)`:
   - The message is exactly `Place Store unavailable: <action> failed (ECONNREFUSED)` for an error with that code.
   - Without a usable code the message has no parentheses.
   - An error whose `message`, `detail`, `where` and `cause.message` contain `postgres://wm_contract:${UNREACHABLE_PASSWORD}@127.0.0.1:1/wm_unreachable_test`, SQL text and a binding value gives a failure whose `JSON.stringify` contains none of: the password, `postgres://`, the SQL text or the binding.
   - Never throws for non-`Error` inputs.

**`tests/db/connection.db.test.ts`** (Test Database, covers AL4 1.4.2). Every `Knex` created goes through `destroyQuietly` in `afterEach`/`afterAll`.

1. `parseSafeInt8`: `'9007199254740991'` gives `9007199254740991`, `'-42'` gives `-42`, and `'9007199254740993'` throws `int8 value is not a safe integer`. This group is pure; it may live in this file or in a separate `tests/db/connection.test.ts`. If you split it out, add that file to the Done-when command.
2. Constants: `POOL_MAX_STORE === 4`, `POOL_MAX_SETUP === 1`, `CONNECT_TIMEOUT_MS === 5000`, `ACQUIRE_TIMEOUT_MS === 10000`, `STATEMENT_TIMEOUT_MS === 30000`.
3. `createDb(UNREACHABLE_DATABASE_URL, POOL_MAX_STORE)` does not throw. `selectBigint(db, '1')` on it rejects with an error whose `code` (or `cause.code`) is `ECONNREFUSED`. The test does not run against a real server.
4. On `createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP)`, `selectBigint(db, '9007199254740991')` resolves to the JS number `9007199254740991` (`typeof` is `'number'`). `selectBigint(db, '9007199254740993')` rejects.
5. `destroyQuietly(undefined)` resolves, and calling `destroyQuietly(db)` twice on the same instance resolves both times.

Before the coder runs, the tests fail only because the `src/db/*` modules are missing.

### 2.2 add-coder

Implement in this order. Each file depends only on the ones before it (AL4 1.1). Import contract schemas, types and helpers from `../../contracts/storage.schema` and `../../contracts/wikimapia-client.schema`. Never redefine or re-export them.

1. **`src/db/rows.ts`** (AL4 1.1 row, "5. AL2 Guidance"):
   - Write non-strict `z.object` schemas named `PlaceRowSchema`, `CommentRowSchema`, `TagLinkRowSchema`, `TagRowSchema`, `ShapeRowSchema`, `RingPointRowSchema`, `CountsRowSchema`, `ColumnRowSchema` and `NameRowSchema`.
   - Keys are snake_case and equal the column names in AL4 2.2 to 2.4. `PlaceRowSchema` covers every `places` column except the two geometries, plus `details_fetched_at_text: string | null` (1.4.8). `TagLinkRowSchema` is `place_tags` plus `title`.
   - For the read-only rows, pick snake_case aliases and keep them: shapes (1.4.8 "Shapes": centre SRID/type/x/y, outline SRID/type), ring point (`x`, `y`), counts (one per table), column info (`table_name`, `column_name`, `data_type`, `udt_name`) and name (`name`). Later units use these aliases.
   - `bigint` columns are `z.number().int()`, because the int8 parser returns numbers. Nullable columns use `.nullable()`. `outline` is an array of `[number, number]` tuples. `presence` uses the contract `PresenceSchema`.
   - Add one more schema, `BigintProbeRowSchema` (`{ value: number }`), for `selectBigint`.
2. **`src/db/types.ts`** (types only, no runtime code):
   - Add `StoreResult<T>`, `Validated<T>` and the row types (`PlaceRow`, `CommentRow`, `TagLinkRow`, `TagRow`, `ShapeRow`, `RingPointRow`, `CountsRow`, `ColumnRow`, `NameRow`, `BigintProbeRow`), each written as `z.infer<typeof XRowSchema>` with `import type { ... } from './rows'` (AL4 section 0, "Code style").
   - Do **not** add `OutlinePairs`, `FlatComment`, `NamedMigration`, `Writer` or the state and plan types yet. U3 to U6 add them.
3. **`src/db/failures.ts`** (AL4 1.4.3):
   - Implement `invalidData`, `storeUnavailable`, `unavailableFrom`, `safeErrorCode` and `describeStoreIssues`.
   - Reuse `toFailureIssues`, `formatIssuePath` and `MAX_REPORTED_ISSUES` from `../wikimapia/issues`.
   - `describeStoreIssues` must render an empty path as `(whole input)`. Special-case it locally and call `formatIssuePath` only for non-empty paths. **Do not modify `src/wikimapia/issues.ts`.**
   - `invalidData` caps the issues at 20, never returns an empty list, keeps `commentNum` and `placeId`, and never assigns `undefined` to an optional key.
   - `unavailableFrom` uses only the fixed template and the safe code. It never reads `message`, `detail`, `where`, SQL text or bindings into the result.
   - Narrow `unknown` with type guards, without casts to `any`.
4. **`src/db/validate.ts`** (AL4 1.4.4): implement exactly the pseudocode for `validateDetailsInput`:
   - Wrap `safeParse` in try/catch with the fixed fallback issue.
   - Map issues with `toFailureIssues`.
   - Re-parse `input.details` with `PlaceDetailsSchema` behind an `isRecord` guard.
   - Attach `commentNum` and `placeId` from `findCommentRuleIssues` to the issues whose path equals `['details', ...rule.path]`.

   `validateListingInput`, `validatePlaceRef` and `validateTagRef` are plain `safeParse` plus `invalidData`. Return only `r.data`, never the raw input. Wrap every function so that it never throws.
5. **`src/db/connection.ts`** (AL4 1.4.2):
   - Constants and `createDb` exactly as specified: `import { knex } from 'knex'`, `import type { Knex } from 'knex'` and `import pg from 'pg'`. The int8 parser goes through the per-connection `types.getTypeParser` and never through `pg.types.setTypeParser`. Creating the instance must not connect.
   - `destroyQuietly(db)`: never rejects and is idempotent (calling it twice on one instance resolves).
   - Two additions to the 1.3 export list, both needed by the U2 tests:
     - Export `parseSafeInt8(text: string): number`.
     - Export `selectBigint(db: Knex, value: string): Promise<number>`. It runs one parameterized `select ?::bigint as value`, with the value as a binding and never interpolated (`.agrules` section 3). It assigns the `knex.raw` result to `unknown` and parses it with `z.object({ rows: z.array(BigintProbeRowSchema) })`. It throws if there is no row. Errors propagate unchanged so the test can read `code`.
   - If Knex's typings reject the `types` or `statement_timeout` connection keys, keep them in a typed connection config object. Do not use `any` or `@ts-expect-error`. If that is impossible, stop and report.
6. Run every Done-when check (2.3) and report each result.

Scope: create no other file under `src/`. Write no migration, model or SQL beyond `selectBigint`. Do not touch `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files or env files.

### 2.3 Done when

**Precondition:** Docker is running and the service is up. Run `pnpm db:up` if `docker compose ps` does not show `postgres` as `healthy`. Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. All of the following must hold:

1. `pnpm exec vitest run --no-color tests/db/failures.test.ts tests/db/validate.test.ts tests/db/connection.db.test.ts` passes with no failures and no skipped or todo tests. If `parseSafeInt8` was split into `tests/db/connection.test.ts`, add that file to this command.
2. `pnpm exec vitest run --no-color tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` still passes (regression; `contracts/storage.schema.test.ts` must stay green in every unit).
3. `pnpm exec eslint src/db tests/db` reports no problems.
4. `pnpm exec tsc --noEmit` and `pnpm lint` report errors only in `contracts/storage.test.ts`, and only those caused by the missing `../src/db/schema-setup` and `../src/db/place-store` modules. That includes the unresolved imports and the `no-unsafe-*` follow-on errors (AL4 section 4, "Baseline caveat").
5. `Get-ChildItem src/db` lists exactly `types.ts`, `rows.ts`, `failures.ts`, `validate.ts` and `connection.ts`.
6. `Select-String -Path src/db/*.ts -Pattern "console\.|setTypeParser|: any|as any"` returns nothing.
7. `.env` and `src/wikimapia/issues.ts` are unchanged. The orchestrator or the user checks this; AL2 does not open `.env`.

Do not run `contracts/storage.test.ts` or `pnpm test:db` as a gate. They stay red until U8.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, the support files and every contract test.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- If a contract schema or helper looks wrong, for example a path that the spec says Zod produces but that it does not, stop and report it with the exact output (`.agrules` section 0, "Triggered Bugfixing"). Do not work around it in `src/db/`.
- Never read, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js` or anything under `src/wikimapia/`.

## 4. Out of Scope

- **U3:** migrations, `models.ts`, `inspect.ts` (including `currentDatabaseName`), `schema-setup.ts` and `isTestDatabaseName`; `scripts/db-migrate.ts`, `scripts/db-status.ts` and their package scripts; the `NamedMigration` type; creating the extensions.
- **U4:** `geometry.ts` and `mappers.ts`; the `OutlinePairs` and `FlatComment` types.
- **U5:** `plan.ts` and the state and plan types.
- **U6/U7:** `writer.ts`, `read.ts`, `save-listing.ts` and `save-details.ts`; transactions and advisory locks.
- **U8:** `place-store.ts`, the "not configured" handling of the factories (AL4 1.4.1) and making `contracts/storage.test.ts` green.
- The `pgvector` npm package, vector columns and crawl-progress tables (substeps 3 and 4).
