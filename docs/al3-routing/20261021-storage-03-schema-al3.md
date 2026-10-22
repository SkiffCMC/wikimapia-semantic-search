# AL3 Routing: storage, U3 "Migrations, models, Schema Setup and DB scripts" (corrective, attempt 2)

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U3 of 8 (attempt 2, corrective)
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md` (revised). Read only "1.4.2 Connection (`connection.ts`)" and "5. AL2 Guidance (toolchain pitfalls)", first bullet ("Imports"). Everything else in U3 was implemented in attempt 1 and is not re-specified here.
- **Audience:** `add-coder` only. `add-test-writer` has no work in this attempt (see 2.1).
- **Status:** Routing to AL2 Agents

## 0. Why this attempt exists

Attempt 1 created every U3 file: the four migrations and `src/db/migrations/index.ts`, `src/db/models.ts`, `src/db/inspect.ts`, `src/db/schema-setup.ts`, the `NamedMigration` type in `src/db/types.ts`, `scripts/db-migrate.ts`, `scripts/db-status.ts`, and the `db:migrate`/`db:status` scripts in `package.json`. Done-when checks 1, 2, 5 and 6 (Vitest, tsc, ESLint) passed.

Done-when checks 3 and 4 failed. `pnpm db:status --test` and `pnpm db:migrate` both exit 1 with:

```text
SyntaxError: The requested module 'knex' does not provide an export named 'knex'
```

The error is raised at `src/db/connection.ts:6` (`import { knex } from 'knex';`). knex 3.3.0 has no `exports` map, so under plain Node ESM (`tsx`) it exposes only `default`. Vitest hid the problem through Vite's CJS interop. The revised AL4 (1.4.2 and section 5) now requires `import knex from 'knex'` (default import) together with `import type { Knex } from 'knex'`. The older routing prompt `docs/al3-routing/20261021-storage-02-validate-al3.md` still mentions the named import. That instruction is superseded and must not be followed.

Verified before routing (Grep over `src/db/**` and `scripts/*.ts`): `src/db/connection.ts` line 6 is the **only** value import of `knex`. Every other file uses `import type { Knex } from 'knex'`, which is erased at runtime and stays as it is. The only other value imports of CommonJS packages are `import pg from 'pg'` (already a default import) and `import { Model } from 'objection'` in `models.ts` (AL4 section 5 says this one is safe). Neither is to be changed.

The Development Database is untouched: no extension and no migration. The Test Database may or may not be migrated, depending on how attempt 1's test run ended.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type` instead of inline `type` specifiers, extensionless relative imports, and no `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules (sections 3, 4 and 5). |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Only "1.4.2 Connection (`connection.ts`)" and the first bullet of "5. AL2 Guidance". |
| 4 | `src/db/connection.ts` | The file to fix (line 6). |
| 5 | `docs/al3-routing/20261021-storage-03-schema-al3.md` | This file. The Done-when list in 2.3 below is complete. You do not need attempt 1's prompt. |

Do not read `contracts/`, the migrations, the models or the scripts unless a Done-when check fails and the error points into one of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. The Done-when checks pass `DATABASE_URL` through the shell so that nothing depends on what `.env` contains.

## 2. Execution Directives

### 2.1 add-test-writer

No work. `tests/db/schema-setup.db.test.ts` exists and passes. Do not modify it or any other test. The runtime failure is covered by Done-when checks 3 and 4, which run the scripts under `tsx`, not under Vitest.

### 2.2 add-coder

1. **`src/db/connection.ts`.** This is a U2 file, and this attempt explicitly allows you to edit it. Replace the named value import `import { knex } from 'knex'` with the default import `import knex from 'knex'`. Keep `import type { Knex } from 'knex'` as a separate top-level type import. Change nothing else in the file: the exports, constants, `getTypeParser`, `createDb`, `destroyQuietly`, `selectBigint` and the doc comment all stay as they are.
2. **Any other value import of `knex`.** You may also edit any other file under `src/db/` or `scripts/` that imports `knex` as a runtime value, and switch it to the default import in the same way. Grep found none, so re-check with `Select-String -Path src/db/*.ts, src/db/migrations/*.ts, scripts/*.ts -Pattern "import \{[^}]*\bknex\b[^}]*\} from 'knex'"`. Leave `import type { Knex } from 'knex'` lines alone.
3. **Keep everything else.** Do not refactor, reformat or "improve" the U3 files from attempt 1. Do not touch `tests/`, `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, docker files or env files.
4. **Stop and report, do not work around:**
   - If the default import fails type checking or linting (for example, a default-import ESLint rule fires, or tsc reports TS1192/TS1259), stop and report the exact output. Do not add `esModuleInterop` overrides, `createRequire`, `@ts-expect-error`, `any` or an ESLint disable comment.
   - If `tsx` then fails on another CommonJS named import (for example `Model` from `objection`), stop and report the exact error. Do not change that import on your own.
   - If `migrate.latest` with `POOL_MAX_SETUP = 1` hangs, or if `DROP EXTENSION postgis` fails on undo, stop and report (as in attempt 1).
5. Run **every** Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running. If `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. All of the following must hold:

1. `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts` passes, with no failures and no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` passes. `tests/db/connection.db.test.ts` must stay green after the import change.
3. `pnpm db:status --test` exits 0 and lists the four steps (`20261021_01_enable_extensions`, `20261021_02_create_places`, `20261021_03_create_tags`, `20261021_04_create_comments`) as applied, none pending, with `postgis` and `vector` enabled. Run it right after check 1, because the test file's `afterAll` leaves the Test Database migrated.
4. Development Database. Use the shell variable so that `.env` is irrelevant. The value is the local default from `.env.example` and is not a secret.
   - `$env:DATABASE_URL = 'postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia'`
   - `pnpm db:migrate` exits 0 and applies the four steps.
   - A second `pnpm db:migrate` exits 0 and applies none.
   - `pnpm db:status` exits 0 and lists the four steps as applied, none pending, with `postgis` and `vector` enabled.
   - `Remove-Item Env:DATABASE_URL`
   - None of these outputs contains `postgres://` or `wikimapia_local`.
5. `pnpm exec eslint src/db tests/db scripts` reports no problems.
6. `pnpm exec tsc --noEmit` reports exactly one error: TS2307 for `'../src/db/place-store'` in `contracts/storage.test.ts`. `pnpm lint` reports problems only in `contracts/storage.test.ts`, and only those that follow from the missing `place-store` (AL4 section 4, "Baseline caveat").
7. Files:
   - `Get-ChildItem src/db -File` lists exactly `connection.ts`, `failures.ts`, `inspect.ts`, `models.ts`, `rows.ts`, `schema-setup.ts`, `types.ts` and `validate.ts`.
   - `Get-ChildItem src/db/migrations` lists the four step files and `index.ts`.
   - `Test-Path src/db/place-store.ts` is `False`.
8. Guards. Each of these returns nothing:
   - `Select-String -Path src/db/*.ts, src/db/migrations/*.ts, scripts/db-*.ts -Pattern "console\.|setTypeParser|: any|as any|ts-expect-error|Model\.knex\("`
   - `Select-String -Path src/db/migrations/*.ts -Pattern "drop extension[^;]*cascade|vector\(|inet|cidr|user_ip"`
   - `Select-String -Path src/db/*.ts, src/db/migrations/*.ts, scripts/*.ts -Pattern "import \{[^}]*\bknex\b[^}]*\} from 'knex'"`
9. `.env` is unchanged. The orchestrator or the user checks this; AL2 does not open `.env`.

Do not run `contracts/storage.test.ts` or `pnpm test:db` as a gate. The file cannot load before U8 because it imports `../src/db/place-store` (unchanged from attempt 1).

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the support files).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- In this attempt, the only U2 file you may edit is `src/db/connection.ts`, and only its `knex` value import. `rows.ts`, `failures.ts`, `validate.ts` and the U2 tests stay unchanged.
- Never open, write or print `.env`. Never put a real password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `eslint.config.js`, anything under `src/wikimapia/`, or any earlier AL3 prompt.

## 4. Out of Scope

- Any change to U3 behaviour beyond the import fix: migrations, models, `inspect.ts`, `schema-setup.ts` and the scripts stay as attempt 1 left them, unless a Done-when failure traces directly to the `knex` import.
- **U4:** `geometry.ts` and `mappers.ts`; the `OutlinePairs` and `FlatComment` types.
- **U5:** `plan.ts` and the state and plan types.
- **U6/U7:** `writer.ts`, `read.ts`, `save-listing.ts` and `save-details.ts`; advisory locks and save transactions.
- **U8:** `place-store.ts` and making `contracts/storage.test.ts` green.
- The `pgvector` npm package, vector or embedding columns (substep 4) and crawl-progress tables (substep 3).
- Recording AL4 decisions in `CLAUDE.md` or correcting `docs/al3-routing/20261021-storage-02-validate-al3.md`. The orchestrator handles both.
