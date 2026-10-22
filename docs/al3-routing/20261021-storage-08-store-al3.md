# AL3 Routing: storage, U8 "Public Place Store factory (contract green)"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U8 of 8 (attempt 1). This is the last unit. It turns `contracts/storage.test.ts` green.
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`. Read these sections: "0. Scope and Fixed Points" (including "Single source of truth" and "Code style"), "1.1 Module map" (row `place-store.ts` and the paragraph on unit tests below the table), "1.2 Call flow" (the numbered steps 1 to 5 at the top), "1.3 Component contracts" (`StoreResult`, `Validated`, the `failures.ts`, `validate.ts`, `connection.ts`, `read.ts`, `save-listing.ts / save-details.ts` and `place-store.ts` blocks, and the sentence under the code block about `StoreResult<T>`), "1.4.1 Factories", "1.4.3 Failures", "1.4.7 Writer and fault hook" (last paragraph), "1.4.8 Read-back" (first sentence and the "Gate" bullet), "1.5 Transaction boundaries" (rows "Invalid input" and "Multi-query reads"), "4. Implementation Units" ("Baseline caveat" and "U8") and "5. AL2 Guidance" (all bullets).
- **AL6:** `docs/al6-requirements/20261021-storage-al6.md`. Read section "3.8 Failures, atomicity and privacy" only if a failure rule is unclear. AL4 already encodes it.
- **Audience:** `add-test-writer` first, then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- U1 to U7 are done. `src/db/` contains `connection.ts`, `failures.ts`, `geometry.ts`, `inspect.ts`, `mappers.ts`, `models.ts`, `plan.ts`, `read.ts`, `rows.ts`, `save-details.ts`, `save-listing.ts`, `schema-setup.ts`, `types.ts`, `validate.ts`, `writer.ts` and `migrations/`. `src/db/place-store.ts` and `tests/db/place-store.test.ts` do not exist yet.
- The full suite is green except `contracts/storage.test.ts`, which fails only because `../src/db/place-store` cannot be imported. `tsc` and `lint` report only the follow-on errors of that missing module.
- Building blocks U8 composes. **None of them may be changed:**
  - `validate.ts`: `validateListingInput`, `validateDetailsInput`, `validatePlaceRef` and `validateTagRef` take `unknown`, never throw, and return `Validated<T>`: either `{ ok: true, value }` with the **parsed** value, or `{ ok: false, failure }` with an `invalid_data` failure.
  - `failures.ts`: `storeUnavailable(message)` and `unavailableFrom(error, action)`. The second gives the fixed template `Place Store unavailable: <action> failed` plus an optional safe code such as `(ECONNREFUSED)` or `(3D000)`. It never copies an error message.
  - `connection.ts`: `createDb(connectionString, POOL_MAX_STORE)` does not connect. `destroyQuietly(db | undefined)` never rejects and may be called twice.
  - `save-listing.ts` `saveListing(db: Knex, page, onWrite)` and `save-details.ts` `saveDetails(db: Knex, input, onWrite)` each open their own READ COMMITTED transaction. They throw on any DB or hook error after rolling back, and they never catch.
  - `read.ts`: `readPlaceValue`, `readShapesValue`, `listTagCatalogue`, `listLinksOfTag`, `listCommentKeys` and `countAll` take `Knex | Knex.Transaction` and **never open a transaction**. Each one already gates its result with the contract schema through `.parse`, which throws a `ZodError` on a mismatch. `mappers.toDetailedPlace` throws a plain `Error` with fixed text on an inconsistent row. Both kinds of throw must become `store_unavailable` in U8.
  - `schema-setup.ts` is the **pattern to follow**: `openDb` (a `try` around `StoreConfigSchema.safeParse({ connectionString })` and `createDb`), a not-configured variant with the `NOT_CONFIGURED_MESSAGE` text, a configured variant whose methods wrap everything in `try/catch` and map errors with `unavailableFrom`, and `close: () => destroyQuietly(db)`.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` section 5 and `CLAUDE.md`:

- Node ESM and TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Zod 4 and Vitest with globals.
- Relative imports have no file extension.
- Use top-level `import type`.
- Every `type` or `interface` declared in `src/db/` stays in `src/db/types.ts`.
- No `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Sections 0, 2, 3, 4 (no secrets, no live calls) and 5 matter most. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read the sections listed in the header. Skip the rest. |
| 4 | `contracts/storage.schema.ts` | Import these, never copy them: `StoreConfigSchema` and `WriteHook` / `PlaceStoreOptions` (116-136); `SaveListingPageInput`, `SavePlaceDetailsInput`, `PlaceRefInput` and `TagRefInput` (149-221); `StoreFailure` (465-491); the `*Result` types (493-533); `PlaceStore` and `CreatePlaceStoreFn` (535-561). |
| 5 | `contracts/storage.test.ts` | Read only. The black-box gate. Read the lifecycle (86-120), the helpers (122-160), AC-15 (616-665), AC-51 (1572-1592), AC-53 to AC-58 (1643-1877) and AC-60 to AC-62 (1903 to end). Read the rest only to diagnose a failure. |
| 6 | `contracts/storage.support.ts` | `requireTestDatabaseUrl`, `UNREACHABLE_DATABASE_URL`, `UNREACHABLE_PASSWORD` (lines 50, 89-90), `clientListing`, `clientDetails`, `nestedDetails`, `FETCHED_AT`. |
| 7 | `src/db/schema-setup.ts` | Pattern for the factory, the not-configured store and `close`. Read only. |
| 8 | `src/db/validate.ts`, `src/db/failures.ts` | Validators and failure builders. Read only. |
| 9 | `src/db/connection.ts` | `createDb`, `destroyQuietly`, `POOL_MAX_STORE`. Read only. |
| 10 | `src/db/read.ts` | The six read functions. Read only. |
| 11 | `src/db/save-listing.ts`, `src/db/save-details.ts` | Signatures of `saveListing` and `saveDetails`. Read only. |
| 12 | `src/db/types.ts` | `StoreResult`, `Validated`. Additions only, and only if you truly need them (see 2.2 step 8). |
| 13 | `tests/db/failures.test.ts` | Style reference for a test file that needs no DB. Read only. |
| 14 | `eslint.config.js`, `vitest.config.ts`, `tsconfig.json` | Read only (lint rules, test globs, compiler flags). |

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. `TEST_DATABASE_URL` reaches the tests through `.env.test` and `vitest.config.ts`. Get the URL only through `requireTestDatabaseUrl()`.

## 2. Execution Directives

### 2.1 add-test-writer

Write one file: **`tests/db/place-store.test.ts`**. It needs **no database** (AL4 U8). It must not use `requireTestDatabaseUrl()`, raw SQL, the query builder, model classes, the network or `.env`. It imports `createPlaceStore` from `../../src/db/place-store` and, for the transaction pin below, `READ_TRANSACTION_CONFIG` from the same module. It builds inputs with `clientListing('box-belgrade-page1.json')`, `clientDetails('getbyid-62587.json')` and `FETCHED_AT` from `contracts/storage.support.ts`. It parses every result with its contract `*ResultSchema` (for example `SaveResultSchema` and `ReadPlaceResultSchema`) before asserting.

Cover:

1. **Factory never throws (AL4 1.4.1, AC-57):** `createPlaceStore` returns an object with all nine methods and does not throw for each of these inputs:
   - `{ connectionString: '' }`
   - `UNREACHABLE_DATABASE_URL`
   - `{ connectionString: 'not a url' }`
   - `{ connectionString: '', onWrite: () => undefined }` (an extra `onWrite` must not make the strict `StoreConfigSchema` fail for a valid string, and must not throw for an empty one)
2. **Not-configured store (`connectionString: ''`):** use `it.each` over the eight data methods. For **valid** input, each one resolves `{ ok: false }` with kind `store_unavailable` and the message `Place Store is not configured: connection string is missing or unusable`. Valid input means:
   - the Belgrade page
   - `{ details: 62587, fetchedAt: FETCHED_AT }`
   - `{ placeId: 62587 }`
   - `{ tagId: 194 }`
   - no input for `listTags` and `countStored`
3. **Validation runs before the DB (AC-51, AC-53, AC-55):** on the not-configured store **and** on the unreachable store, invalid input resolves `invalid_data` with an issue at the expected path. It must not resolve `store_unavailable`. Cases:
   - `readPlace`, `listStoredComments` and `readPlaceShapes` with `{ placeId: 0 }`, `-3`, `1.5` and `NaN` give `['placeId']`.
   - `listPlaceTagLinks({ tagId: -1 })` gives `['tagId']`.
   - `saveListingPage(undefined as never)` and `savePlaceDetails(undefined as never)` resolve `invalid_data` and do not reject.
   - `savePlaceDetails` with `fetchedAt: 'yesterday'` gives `['fetchedAt']`.
   - A listing with `lon: 200` on the first place gives `['places', 0, 'location', 'lon']`.
4. **Unreachable store (AC-57):** on `UNREACHABLE_DATABASE_URL`, each of the eight data methods resolves with valid input. Each result is `store_unavailable`, and its `JSON.stringify` contains neither `UNREACHABLE_PASSWORD`, nor `UNREACHABLE_DATABASE_URL`, nor `postgres://`. The message starts with `Place Store unavailable: ` (the `unavailableFrom` template). Give the test a 60 s timeout, because each method fails fast on `ECONNREFUSED`.
5. **Never rejects:** wrap every call above so that a rejection fails the test explicitly, for example `await expect(p).resolves.toBeDefined()` before parsing.
6. **`close()`:** on both the not-configured and the unreachable store, `close()` resolves twice in a row. After `close()`, a `readPlace({ placeId: 1 })` call resolves and does not reject, and if it fails its kind is `store_unavailable`.
7. **Read transaction pin (AL4 1.5):** `READ_TRANSACTION_CONFIG` is `toStrictEqual({ isolationLevel: 'repeatable read', readOnly: true })`.

The end-to-end behaviour (saves, read-back, the `onWrite` fault loops, the wrong-database case) is covered by `contracts/storage.test.ts` and the U6/U7 DB tests. Do not duplicate it here.

Before the coder runs, the file fails only because `src/db/place-store.ts` is missing.

### 2.2 add-coder

Create **`src/db/place-store.ts`** exporting `createPlaceStore: CreatePlaceStoreFn` (public) and `READ_TRANSACTION_CONFIG` (internal, typed `Knex.TransactionConfig`). Import contract schemas, types and helpers from `../../contracts/storage.schema`. Never redefine or re-export them. Use the contract `*Result` types as the method return types (AL4 1.3, last sentence).

1. **Factory (AL4 1.4.1).** Follow `schema-setup.ts`:
   - `openDb`: inside one `try`, run `StoreConfigSchema.safeParse({ connectionString: options.connectionString })` (never pass `onWrite` or the whole options object), then `createDb(parsed.data.connectionString, POOL_MAX_STORE)`. Any failure or throw means the store is "not configured".
   - Read `options.onWrite` inside the same guard and keep it as given (`WriteHook | undefined`).
   - `createPlaceStore` must never throw.
2. **Method skeleton (AL4 1.2 steps 1 to 5).** Every public method does the following, in this order:
   1. It validates its input with the matching `validate.ts` function, passing the argument as `unknown`. An `invalid_data` result is returned as is, with no DB access, even on a not-configured store.
   2. If there is no `db`, it resolves `storeUnavailable(<the same NOT_CONFIGURED text as schema-setup.ts>)`.
   3. It runs the operation **on the parsed value only** inside `try`.
   4. It resolves `{ ok: true, value }`, or `{ ok: false, failure }` from the `catch`.

   `listTags` and `countStored` have no input. They skip step 1. Every method body is wrapped so that nothing can reject. That includes a validator or `createDb` surprise.
3. **Saves:**
   - `saveListingPage` calls `saveListing(db, page, onWrite)`.
   - `savePlaceDetails` calls `saveDetails(db, input, onWrite)`.
   - On any throw, return `unavailableFrom(error, 'listing save')` or `unavailableFrom(error, 'details save')`. Do not add a transaction around them, because they open their own. A throw from the hook, sync or async, ends up here after the rollback (AC-15, AC-56).
4. **Multi-query reads (AL4 1.4.8, 1.5):**
   - `readPlace` runs `db.transaction((trx) => readPlaceValue(trx, placeId), READ_TRANSACTION_CONFIG)`.
   - `readPlaceShapes` does the same with `readShapesValue`.
   - `READ_TRANSACTION_CONFIG` is `{ isolationLevel: 'repeatable read', readOnly: true }`.
   - Use the callback form so Knex commits or rolls back by itself. Do not hold an open transaction object.
5. **Single-query reads.** These run directly on `db` with no transaction:
   - `listTags`: `listTagCatalogue(db)`
   - `listPlaceTagLinks`: `listLinksOfTag(db, tagId)`
   - `listStoredComments`: `listCommentKeys(db, placeId)`
   - `countStored`: `countAll(db)`
6. **Read failures (AL4 1.4.8 "Gate").** In every read's `catch`:
   - If the error is `instanceof z.ZodError` (Zod 4 `z.ZodError` from `'zod'`), resolve `storeUnavailable('Place Store unavailable: stored data failed the read-back check')`.
   - Otherwise, resolve `unavailableFrom(error, <action>)`. This includes the fixed-text `Error` from `toDetailedPlace`.
   - Use these actions: `'read place'`, `'read place shapes'`, `'list tags'`, `'list place tag links'`, `'list stored comments'` and `'count stored'`.
   - `read.ts` already gates its values, so do not parse a second time.
7. **`close()`** returns `destroyQuietly(db)` (`undefined` when not configured). It is idempotent and never rejects. Later calls go through the normal path, and Knex's "pool destroyed" error becomes `store_unavailable`.
8. **Typing and style.** Do not use these to silence the compiler:
   - `any`
   - `as` casts (`as const` on literals is fine)
   - non-null assertions `!`
   - `@ts-expect-error`
   - ESLint disable comments

   No failure text may include any part of an error's message, the connection string or input values. Messages are the fixed strings above. Add no `type`/`interface` to `place-store.ts`. If you truly need one, add it to `src/db/types.ts` (additions only) and report it. `import knex` is not needed here. Use `import type { Knex } from 'knex'` for `Knex.TransactionConfig`.
9. **Contract run.** Run `contracts/storage.test.ts`. If a contract test fails because of an earlier module (`read.ts`, `plan.ts`, `mappers.ts`, `save-*.ts`, `validate.ts`, `failures.ts`, migrations), **stop and report** it: give the AC, the observed value and the module. Do not edit those modules (`.agrules` section 0, "Triggered Bugfixing"). Fix only `place-store.ts` problems yourself.
10. Run every Done-when check (2.3) and report each result with its exit code.

**Scope:** create or modify only `src/db/place-store.ts`, `tests/db/place-store.test.ts`, and (additions only, step 8) `src/db/types.ts`. Do not touch anything else. That includes the other `src/db` modules, migrations, earlier `tests/db` files, `scripts/`, `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files and env files.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker must be up: if `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. All of the following must hold.

1. **Dev DB before.** `.env` has no `DATABASE_URL`, so set it in the shell for this one command only. Shell values win over `.env`. The URL is the compose default from AL4 2.7. If the user set a different `POSTGRES_PASSWORD`, the user substitutes it.
   ```powershell
   $env:DATABASE_URL = 'postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia'; pnpm db:status; Remove-Item Env:DATABASE_URL
   ```
   Record the output. Do not migrate or otherwise change the Development Database.
2. `pnpm exec vitest run --no-color tests/db/place-store.test.ts` passes.
3. **AL5 gate:** `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts` passes with no failed, skipped or todo tests.
4. **Full suite:** `pnpm exec vitest run --no-color` (all of `contracts/` and `tests/`) passes with no failed, skipped or todo tests. There is no fixed test count.
5. `pnpm exec tsc --noEmit` reports **0 errors**.
6. `pnpm lint` reports **0 problems**.
7. **Dev DB after:** the command from step 1 prints the same output as before (the tests never touched the Development Database, AC-60). It also proves that `tsx` still loads `src/db` (AL4 section 5).
8. Files:
   - `Get-ChildItem src/db -File | Select-Object -ExpandProperty Name` lists exactly the 15 files from section 0 plus `place-store.ts`.
9. Guards. Each returns nothing:
   - `Select-String -Path src/db/place-store.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|\.message|process\.env|\$\{"`. This checks for no logging, no `any`, no error-message copying, no env reads and no template literals.
   - `Select-String -Path src/db/place-store.ts -Pattern "^\s*(export\s+)?(type|interface)\s"`. This checks for type declarations outside `types.ts`.
   - `Select-String -Path src/db/place-store.ts -Pattern "\.raw\(|Model\.|from 'objection'|\.select\(|\.insert\(|\.patch\("`. The factory must issue no SQL itself: SQL lives in `read.ts` and `save-*.ts`.
   - `Select-String -Path tests/db/place-store.test.ts -Pattern "\.raw\(|Model\.query|from 'objection'|DATABASE_URL|requireTestDatabaseUrl"`. This keeps the test free of the DB and of env access.
10. `.env` is unchanged. The orchestrator or the user checks this. AL2 does not open `.env`.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, `storage.support.ts` and every contract test.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test, and do not raise timeouts in contract files.
- If AL4 and a contract test disagree (for example on a failure kind, an issue path, or whether a call may reject), stop and report it with the exact AC and spec lines. Do not guess.
- Never open, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js`, anything under `src/wikimapia/`, the U2 to U7 modules (beyond the `types.ts` additions allowed in 2.2), or any earlier AL3 prompt.

## 4. Out of Scope

- Any change to `validate.ts`, `failures.ts`, `connection.ts`, `read.ts`, `plan.ts`, `mappers.ts`, `geometry.ts`, `writer.ts`, `save-listing.ts`, `save-details.ts`, `schema-setup.ts`, `inspect.ts`, models or migrations. If one of them is wrong, report it.
- Retries or backoff inside the store (AL4 section 3: the crawl, substep 3, decides).
- Logging of any kind.
- The `pgvector` npm package, vector or embedding columns (substep 4), and crawl-progress tables or crawl jobs (substep 3).
- An HTTP server or framework. The open decision in `CLAUDE.md` stays open.
- Recording the AL4 section 0.1 decisions in `CLAUDE.md`. The orchestrator handles it.
