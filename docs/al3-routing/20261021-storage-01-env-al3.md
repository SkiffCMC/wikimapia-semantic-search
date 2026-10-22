# AL3 Routing: storage, U1 "Local services, dependencies, environment and test configuration" (corrective, attempt 2)

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U1 of 8
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md` (revised): section "0.1 Decisions made by this design" (row "Database image"), section "2.7 Local services, environment and tests", and section "4. Implementation Units", "U1"
- **Audience:** `add-coder` only. `add-test-writer` has nothing to do on this attempt (see 2.1).
- **Status:** Routing to AL2 Agents

## 0. Why this run exists

Attempt 1 completed everything in U1 except the image build. It stopped at `pnpm db:up` because `docker/postgres/Dockerfile` uses `FROM postgis/postgis:16-3.5`. That tag is Debian 11 bullseye, and its `bullseye-pgdg` apt source returns 404, so `postgresql-16-pgvector` cannot be installed. The AL4 spec has been revised:

1. The base image is now `postgis/postgis:16-3.6` (Debian 13 trixie, PGDG source `trixie-pgdg`, pgvector 0.8.x). See AL4 0.1, 2.7 and U1 "Base image".
2. The caret ranges that `pnpm add` wrote are now accepted explicitly (AL4 2.7 `package.json` table and U1 "Dependency ranges"). Do **not** hand-edit them back to the minimum ranges.
3. Extension version expectations are now `postgis` 3.6.x and `vector` 0.8.x for `default_version` (AL4 2.7 "Extension version expectations" and U1 "Done when").

State verified before routing:

- `docker/postgres/Dockerfile` line 1 reads `FROM postgis/postgis:16-3.5`. This is the only line that is out of date.
- `package.json` has `knex ^3.3.0`, `objection ^3.9.1`, `pg ^8.23.1`, `@types/pg ^8.23.1`, `tsx ^4.23.15` and the scripts `db:up`, `db:down`, `db:reset` and `test:db`. This matches the revised spec.
- The following already exist: `docker/postgres/initdb/10-create-test-database.sql`, `docker-compose.yml`, `.env.example`, `.env.test.example`, `scripts/load-env.ts`, `vitest.config.ts` and `tests/scripts/load-env.test.ts`. According to the orchestrator, `.env.test`, `.gitignore` and `tsconfig.json` are done, and `tests/scripts` passes.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style they define: Node ESM, TypeScript strict, Zod 4, Vitest with globals, pnpm, and extensionless relative imports (`.agrules` section 5).

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Section 3 says extensions are created **by migration only**, so the image must not create them. Section 4 covers no secrets or `.env` in git and no live external calls in tests. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read only "0.1 Decisions made by this design" (the "Database image" row), "2.7 Local services, environment and tests" (the Dockerfile block, the paragraph under it and "Extension version expectations") and "4. Implementation Units": the "Baseline caveat" paragraph and "U1". |
| 4 | `docker/postgres/Dockerfile` | The file you fix. |
| 5 | `package.json` | Read only. Confirm that the dependencies and scripts match AL4 2.7 and U1 "Dependency ranges". |

**Never read, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. Do not re-read or rework the files that attempt 1 finished unless a Done-when check below fails because of them.

## 2. Execution Directives

### 2.1 add-test-writer

Nothing to do. `tests/scripts/load-env.test.ts` exists and passes, and the revision changed no tested behaviour. Do not modify it.

### 2.2 add-coder

1. **Dockerfile fix (the only required edit):** in `docker/postgres/Dockerfile`, change the `FROM` line to `FROM postgis/postgis:16-3.6`. Then compare the whole file with the block in AL4 2.7. It must match that block exactly:
   - the apt install of `postgresql-16-pgvector` has no version pin,
   - the `rm -f /docker-entrypoint-initdb.d/10_postgis.sh` step is present,
   - `COPY initdb/` is present.
   Do not add an apt-archive source or any other repository.
2. **Keep everything else.** Do not modify the dependency ranges in `package.json` or `pnpm-lock.yaml`, and do not reinstall. Do not modify the scripts, `docker-compose.yml`, the init SQL, the env files, `.gitignore`, `tsconfig.json`, `scripts/load-env.ts`, `vitest.config.ts` or the tests. Change one of these only when a Done-when check fails because of it, and then only to match AL4 2.7.
3. **Bring the services up:** run `pnpm db:up`.
   - If the build still fails (for example, the apt package is not found), stop and report the exact output.
   - If port 5433 on `127.0.0.1` is taken, stop and report the exact output.
   - Do not change the port, the image tag or the URLs to work around a failure.
   - If a `pgdata` volume left over from attempt 1 means the init scripts did not run (`wikimapia_test` is missing, or `postgis` is already in `pg_extension`), run `pnpm db:reset` once. The volume holds no data yet. Then repeat the checks.
4. **Run every Done-when check (2.3)** and report each result.
5. **Scope:**
   - Create no file under `src/`.
   - Write no migration and create no extension by hand.
   - Do not add `db:migrate` or `db:status` (U3 adds them).
   - Do not edit `eslint.config.js`, `CLAUDE.md` or `.agrules`.
6. **Hand-off:** report this exact line for the user to add to `.env`. Do not add it yourself.
   `DATABASE_URL=postgres://wikimapia:wikimapia_local@127.0.0.1:5433/wikimapia`

### 2.3 Done when

Run every command from the repo root (`D:\Programming\wikimapia-semantic-search`) in PowerShell. Docker must be running. All of the following must hold:

1. `pnpm db:up` exits 0 and `docker compose ps` shows the `postgres` service as `healthy`.
2. Both databases exist:
   - `docker compose exec postgres psql -U wikimapia -d wikimapia_test -tAc "select current_database()"` prints `wikimapia_test`.
   - `docker compose exec postgres psql -U wikimapia -d wikimapia -tAc "select current_database()"` prints `wikimapia`.
3. Both extensions are available but not created. Run these in **each** database (`-d wikimapia` and `-d wikimapia_test`):
   - `docker compose exec postgres psql -U wikimapia -d <db> -tAc "select name, default_version from pg_available_extensions where name in ('postgis','vector') order by name"` prints `postgis|3.6.x` and `vector|0.8.x`, where `x` is any patch level.
   - `docker compose exec postgres psql -U wikimapia -d <db> -tAc "select extname from pg_extension"` prints only `plpgsql`.
4. `pnpm exec vitest run --no-color tests/scripts tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/storage.schema.test.ts` passes with no failures and no skipped or todo tests.
5. `pnpm exec eslint scripts tests/scripts vitest.config.ts` reports no problems.
6. `pnpm exec tsc --noEmit` and `pnpm lint` report errors only in `contracts/storage.test.ts`, and only errors that come from the missing `../src/db/schema-setup` and `../src/db/place-store` modules. This includes unresolved imports and the `no-unsafe-*` follow-on errors they cause (AL4 section 4, "Baseline caveat").
7. Files are in place and git-safe:
   - `Test-Path .env.test, .env.example, .env.test.example, docker-compose.yml, docker/postgres/Dockerfile, docker/postgres/initdb/10-create-test-database.sql, scripts/load-env.ts, tests/scripts/load-env.test.ts` returns `True` for every path.
   - `.gitignore` contains `.env.*`, `!.env.example` and `!.env.test.example`.
   - `.env.example` has an empty `WIKIMAPIA_API_KEY=`.
   - `docker/postgres/Dockerfile` starts with `FROM postgis/postgis:16-3.6`.
8. `.env` is untouched. Its `LastWriteTime` is checked by the orchestrator or the user, not by AL2.

`contracts/storage.test.ts` stays red until U8. Do not run `pnpm test:db` as a gate for this unit.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, the support file and every contract test file.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- Never read, write or print `.env`. Never commit or print a connection string that contains a real password.
- add-coder edits only the files listed in AL4 U1 "Files" plus the local `.env.test`. On this attempt that should be `docker/postgres/Dockerfile` alone.
- Do not edit `CLAUDE.md`, `.agrules` or `eslint.config.js`.
- If the revised blueprint does not work as written (image build, the pgvector package, the healthcheck, extension versions outside 3.6.x or 0.8.x), stop and report the exact output. Do not invent an alternative design.

## 4. Out of Scope

- **U2:** `src/db/types.ts`, `rows.ts`, `failures.ts`, `validate.ts`, `connection.ts`.
- **U3:**
  - migrations, `models.ts`, `inspect.ts` and `schema-setup.ts`;
  - `scripts/db-migrate.ts`, `scripts/db-status.ts` and the `db:migrate` and `db:status` package scripts;
  - creating the `postgis` and `vector` extensions.
- **U4 to U8:** geometry, mappers, planning, writer, reads, Listing Save, Details Save and `createPlaceStore`.
- The `pgvector` npm package and vector columns (substep 4), and the crawl-progress tables (substep 3).
- Recording the AL4 0.1 decisions (including the new base image) in `CLAUDE.md`. The orchestrator does this.
