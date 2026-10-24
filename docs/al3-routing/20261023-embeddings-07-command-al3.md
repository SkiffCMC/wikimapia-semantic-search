# AL3 Routing: embeddings, U7 "Embed Command, script, environment file and contract green"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U7 of 7 (attempt 1), the last unit of the feature
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U7".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md`. Open it only if an AC number below is unclear.
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 to U6 are done and verified. 1245 tests in `tests/embed` and `tests/db` pass.
- `src/embed/` holds exactly `types.ts`, `place-document.ts`, `batches.ts`, `settings.ts`, `report.ts`, `voyage-service.ts`, `send-batch.ts` and `run-embedding.ts`. `runEmbedding` is complete and never rejects.
- `src/embed/settings.ts` already exports `usageMessage()` (`Usage: pnpm embed [--limit <n>]`). `src/embed/report.ts` already exports `failedReport(message, startedAt, endedAt)`.
- `src/embed/types.ts` does **not** declare `ParsedEmbedArgs` yet. This unit adds it.
- `package.json` already pins `voyageai` `0.4.0` and has `pgvector`. It has no `embed` script yet. `test:db` does not cover embeddings yet.
- `.env.example` has exactly two lines, `WIKIMAPIA_API_KEY=` and `DATABASE_URL=...`. AC-52 checks both by SHA-256 of the whole line.
- `pnpm exec tsc --noEmit` shows exactly 1 error: the unresolved module `src/embed/command` in `contracts/embeddings.test.ts`. After this unit there must be **0**.
- `contracts/embeddings.test.ts` can load once `src/embed/command.ts` exists. It is this unit's main gate.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:
- Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, pnpm.
- Top-level `import type` for types. Relative imports have no extension.
- Any new type alias or interface of `src/embed/` goes in `src/embed/types.ts`.
- `unknown` only for caught errors.
- No `console`. Build optional properties (`apiKey`, `embeddingService`, `clock`, `signal`, `embeddingLimit`) with conditional spreads. Never assign `undefined`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Mainly section 4: no secrets in git or output, no live calls in tests, Test Database only, strict types. Also section 5, code style. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only these parts:<br>- **"0. Scope and Fixed Points":** the table (entry point 3, Script, Env vars), "Approved contract decisions" (5), "Single source of truth" and "Code style".<br>- **"0.1 Decisions":** the "Embed command" row.<br>- **"1.1 Module map":** the `command.ts` and `scripts/embed.ts` rows.<br>- **"1.3 Component contracts":** `ParsedEmbedArgs`, `usageMessage`, `failedReport`, `parseEmbedArgs` and `runEmbedCommand`.<br>- **"1.4.10 Embed Command and script"** in full.<br>- **"4. Implementation Units":** the intro, "Baseline caveat" and "U7".<br>- **"5. AL2 Guidance":** the bullets "Never copy error messages", "Lazy SDK import", "`exactOptionalPropertyTypes`", "Test files", "Imports" (the last sentence on `tsx`) and "Output". |
| 4 | `contracts/embeddings.schema.ts` | Read these parts:<br>- lines ~111-128: `EMBED_SCRIPT`, `VOYAGE_API_KEY_ENV`, `ANTHROPIC_API_KEY_ENV`, `DATABASE_URL_ENV`, `ENV_EXAMPLE_FILE`, `ENV_EXAMPLE_EXISTING_LINES_SHA256`;<br>- lines ~466-547: `EmbeddingRunRequest`, `EmbeddingDependencies`, `EmbeddingRunOutcome`, `embedExitCodeFor`;<br>- lines ~736-781: `EMBED_COMMAND_OPTIONS`, `EmbedCommandIO`, `EmbedCommandResultSchema`, `RunEmbedCommandFn`.<br>Import these. Never redefine them. |
| 5 | `contracts/embeddings.support.ts` | For tests: `SimulatedEmbeddingClock`, `SimulatedEmbeddingService` (`calls`, `texts`), `TEST_VOYAGE_API_KEY`, `fail`, `rateLimitError`, `refusedError`, `normal`, `syntheticDetails`, `syntheticName`, `FETCHED_AT`. |
| 6 | `contracts/storage.support.ts` | `requireTestDatabaseUrl` (~line 50), `UNREACHABLE_DATABASE_URL` and `UNREACHABLE_PASSWORD` (~line 90). |
| 7 | `contracts/hydration.schema.ts` | `toMoment` (~line 148). |
| 8 | `contracts/embeddings.test.ts` | Mirror its expectations. Do not import from it.<br>- Lines ~151-180: lifecycle and the `fetch` stub.<br>- Lines ~352-391: `runCommand`, `expectNoSecrets`, `everyOutput`.<br>- The blocks AC-40 (~1234), AC-41 (~1260), AC-49 (~1557), AC-50 (~1604), AC-51 (~1641) and AC-52 (~1668). |
| 9 | `src/crawl/command.ts` | **Pattern** for `parseEmbedArgs` and `runEmbedCommand`: passthrough `--`, `NUMBER_PATTERN`, problem texts, `momentNow`, `dependenciesFrom`, `writeReport`, and the never-rejecting catch. Read-only. |
| 10 | `scripts/crawl.ts` and `scripts/load-env.ts` | **Pattern** for `scripts/embed.ts`. Read-only. |
| 11 | `src/crawl/runtime.ts` | `createSystemCrawlClock(signal?)` (~line 33). Read-only. |
| 12 | `tests/crawl/command.test.ts` and `tests/crawl/command.db.test.ts` | **Pattern** for the structure of the command tests (groups A1-A6, B1-B8). Do not change them. |
| 13 | `src/embed/types.ts`, `src/embed/settings.ts` (exports), `src/embed/report.ts` (`failedReport`), `src/embed/run-embedding.ts` (export only) | The modules this unit composes. Only `types.ts` may change, and only by adding to it. |
| 14 | `tests/embed/run-embedding.db.test.ts` | **Pattern** for Test Database setup, seeding and the `fetch` spy in `tests/embed`. Do not change it. |
| 15 | `package.json`, `.env.example` | The two files this unit edits. |

Do not read the migrations, `src/db/` internals, `src/wikimapia/` or earlier AL3 prompts.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's real API keys. You may open `.env.example`, `.env.test` and `vitest.config.ts` if you need to.

## 2. Execution Directives

### 2.1 add-test-writer

Create **two** new files. Import the subjects from `../../src/embed/command`.
- `tests/embed/command.test.ts`: pure. No database.
- `tests/embed/command.db.test.ts`: uses the Test Database.

The split follows the `.db.test.ts` naming of AL4 1.1 "Unit tests" and the crawl pattern. AL4 U7 lists only `command.test.ts`. The DB cases are the ones AL4 U7 asks for that need stored Places.

Tests are expected to fail until `add-coder` finishes. Do not stub production modules.

**Rules for both files**
- Every `runEmbedCommand` call injects `embeddingService` (a `SimulatedEmbeddingService`) and `clock` (a `SimulatedEmbeddingClock`). A call without a service would build the real Voyage adapter. Never do that.
- Use a local `runCommand` helper that mirrors the contract's: collect `write` lines, and parse every result with `EmbedCommandResultSchema`.
- Build `env` keys from `VOYAGE_API_KEY_ENV` and `DATABASE_URL_ENV`, not from string literals. Use only `TEST_VOYAGE_API_KEY` as a key. Never read `process.env`.
- Stub global `fetch` with a rejecting spy in both files, and assert it was never called.
- Never write an `https://` URL or `api.voyageai.com`.

**`tests/embed/command.test.ts` (pure, AL4 1.4.10 `parseEmbedArgs`)**
1. **Parsing.**
   - `[]` gives `{ ok: true, request: {} }`. The `embeddingLimit` key is absent.
   - `['--limit', '2']` gives `{ embeddingLimit: 2 }`.
   - A leading `--` is dropped (`['--', '--limit', '2']`). A `--` in any other position is an unknown option.
   - `--limit -3` reads `-3` as the value. `--limit 2.5` gives `2.5`.
   - `abc`, `''`, `1e3`, `0x10`, `+2` and `' 2'` give `NaN`.
   - The given argv is not mutated.
2. **Problems.** Each gives `{ ok: false }` with exactly this text and no `request`:
   - `--limit` given twice: `option --limit given twice`;
   - `--limit` with no value: `missing value for --limit`;
   - `--dry-run`, `--region`, `extra`: `unknown option "<token>"`.
3. **Command without a database.** Use `connectionString` `UNREACHABLE_DATABASE_URL` where noted; it proves nothing touched the database.
   - (a) Every case of group 2 through `runEmbedCommand`:
     - outcome `failed`, exit 1;
     - `report.message` = `<problem>. <usageMessage()>`, which contains `--limit`;
     - 0 service calls;
     - the written lines are the message, then each `summaryText` line as its own write;
     - `startedAt` = `endedAt` = the Simulated Clock's moment.
   - (b) `--limit abc`, `0`, `-3`, `2.5` (with an unreachable `DATABASE_URL`): outcome `failed`, exit 1, the message contains `embeddingLimit`, 0 calls.
   - (c) An env without `VOYAGE_API_KEY`, and one where it is `'   '`: outcome `failed`, exit 1, the message contains `VOYAGE_API_KEY`, 0 calls.
   - (d) An env without `DATABASE_URL`, with a valid key: outcome `failed`, exit 1, 0 calls. The whole output passes a local `expectNoSecrets`, which checks for the key, `/Bearer\s/`, `postgres://` and `UNREACHABLE_PASSWORD`.
   - (e) An already aborted `signal`: outcome `interrupted`, exit 1, 0 calls.
   - (f) **Never rejects.** A `write` that throws on its first call resolves with outcome `failed` and exit 1. The result passes `EmbedCommandResultSchema`, and the message does not contain the thrown error's text.
   - (g) For each outcome reached in this file, `exitCode` equals `embedExitCodeFor(outcome)`.

**`tests/embed/command.db.test.ts` (Test Database)**
- Setup: copy the `run-embedding.db.test.ts` setup.
  - `requireTestDatabaseUrl()`;
  - Schema Setup `apply()` in `beforeAll`, `emptyStore()` in `beforeEach`, everything closed in `afterAll`;
  - seed Places through `createPlaceStore(...).savePlaceDetails` with `syntheticDetails(id)`;
  - seed Summary-Only Places through a Listing Save of synthetic summaries.
- Cases:
  1. **No options (AC-49):** 2 Detailed and 1 Summary-Only Place give `completed`, exit 0, 2 texts sent, `summaryOnlySkipped` 1.
  2. **`--limit 2`:** 3 due give `limit_reached`, exit 0, exactly 2 texts sent.
  3. **Rate Limited:** a responder that always answers `fail(rateLimitError())` gives `rate_limited`, exit 0.
  4. **Refused:** a responder answering `fail(refusedError())` gives `failed` and exit 1. The joined output (`JSON.stringify(result)` and every written line) passes `expectNoSecrets`. This includes the Test Database password taken from the test URL.
  5. **Output order:** the written lines are the progress lines first, then the failure message if there is one, then every `summaryText` line in order. Each `summaryText` line is its own write.
  6. **No Place Document text** of a seeded Place appears in any written line.

Never paste vectors as literals.

### 2.2 add-coder

Implement AL4 1.4.10. Import constants, types and `embedExitCodeFor` from `../../contracts/embeddings.schema`, and `toMoment` from `../../contracts/hydration.schema`. Never copy or redefine them. There must be no literal `'--limit'`, `'VOYAGE_API_KEY'` or `'DATABASE_URL'` in the new source files.

1. **`src/embed/types.ts`.** Add `ParsedEmbedArgs` exactly as in AL4 1.3. Do not change the existing declarations.
2. **`src/embed/command.ts` (new).** Export `parseEmbedArgs` and `runEmbedCommand: RunEmbedCommandFn`. Mirror `src/crawl/command.ts`.
   - `parseEmbedArgs(argv)`:
     - drop one leading `--`;
     - the only option is `EMBED_COMMAND_OPTIONS.limit`, and it takes a value. The next token is the value, even if it starts with `-`;
     - problem texts exactly as in 1.4.10;
     - a value matching `/^-?\d+(?:\.\d+)?$/` becomes `Number(text)`, anything else `NaN`;
     - put the `embeddingLimit` key in the request only when the option was given.
   - `runEmbedCommand(argv, io)`:
     - **Parse failure:** `failedReport(`${problem}. ${usageMessage()}`, now, now)`. Here `now = toMoment((io.clock ?? createSystemCrawlClock(io.signal)).now())`. Do not call `runEmbedding`.
     - **Parse success:** call `runEmbedding(request, deps)` with:
       - `connectionString: io.env[DATABASE_URL_ENV] ?? ''`;
       - `apiKey` only when `io.env[VOYAGE_API_KEY_ENV]` is defined;
       - `embeddingService`, `clock` and `signal` only when given;
       - `onProgress: io.write`.
     - The command adds no check of its own. `runEmbedding` already orders settings, key, interrupt and store.
     - **Output:** write `report.message` (when present) as one line, then each line of `report.summaryText.split('\n')`.
     - **Return:** `{ exitCode: embedExitCodeFor(report.outcome), report }`.
     - **Never rejects:** wrap everything in `try/catch`. On a throw, return `{ exitCode: embedExitCodeFor('failed'), report: failedReport('Embedding run failed: internal error', now, now) }`. Take `now` with the same fallback chain as the crawl command. Never use the caught error's message. Write nothing more after a throw.
     - Never read `process.env`. Never import `voyageai`.
3. **`scripts/embed.ts` (new).** Copy the shape of `scripts/crawl.ts`:
   - `applyEnvDefaults(readEnvFile(fileURLToPath(new URL('../.env', import.meta.url))))`;
   - an `AbortController` aborted by `process.once` on `SIGINT` and `SIGTERM`;
   - `write` = `process.stdout.write(line + '\n')`;
   - `env` from `process.env[VOYAGE_API_KEY_ENV]` and `process.env[DATABASE_URL_ENV]`, each key only when defined;
   - `await runEmbedCommand(process.argv.slice(2), { env, write, signal })`, with no injected service or clock;
   - listeners removed in `finally`;
   - `process.exitCode = exitCode`, with a default of 1.

   No `console.*`. Never print an env value. The script reads `.env` only through `readEnvFile` at runtime. You never open the file yourself.
4. **`package.json`.** Change only these two entries, and keep everything else byte-identical (order, indentation, versions):
   - add `"embed": "tsx scripts/embed.ts"` after `"crawl"`;
   - set `"test:db"` to the existing value with ` contracts/embeddings.test.ts tests/embed` appended: `vitest run --no-color contracts/storage.test.ts contracts/hydration.test.ts tests/db tests/crawl contracts/embeddings.test.ts tests/embed`.

   Do not add or change dependencies. Do not run `pnpm install` unless the lockfile check fails, and it should not.
5. **`.env.example`.** Append exactly two lines, `VOYAGE_API_KEY=` and `ANTHROPIC_API_KEY=`, after the two existing lines.
   - The existing bytes must stay identical. Keep the file's existing line-ending style.
   - If the file does not end with a newline, add one before the new lines. The file ends with a newline.
   - No values, no comments, no other changes.
   - Verify with the hash check in 2.3 step 4.
6. **Contract failures.** If `contracts/embeddings.test.ts` still fails after these files exist, the fault is in `src/`. Fix the earlier modules **only** when a contract case proves that an AL4-described behaviour is missing. Name each such change, its AC and the AL4 section in your report.
   - Allowed files for such fixes: `src/embed/*` and `src/db/embedding-*.ts`.
   - If a contract case contradicts AL4, stop and report it. Do not work around it.
7. **Never:**
   - put an error's own message, a key, a URL, a connection string or Place Document text into output;
   - read `process.env` outside `scripts/embed.ts`;
   - import `voyageai` outside `src/embed/voyage-service.ts`.
8. Run every check in 2.3 in order. Report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell.
- **Test Database only.** It is reached only through `requireTestDatabaseUrl()` (`.env.test`).
- If Postgres is not running, you may run `pnpm db:up`.
- Do not run `pnpm db:migrate`, `pnpm db:status`, `pnpm db:reset` or `pnpm crawl`. Do not set `DATABASE_URL`. Do nothing against the Development Database.
- **No live Voyage call, no real key, no network** beyond `127.0.0.1`.

1. `pnpm exec vitest run --no-color tests/embed` passes. That includes both new command test files.
2. `pnpm exec vitest run --no-color contracts/embeddings.test.ts contracts/embeddings.schema.test.ts contracts/storage.test.ts contracts/crawl-run1-fixes.test.ts contracts/hydration.test.ts` passes, with no skipped or todo tests.
3. **Smoke runs.** These are the only allowed `pnpm embed` invocations. Each one exits before any database access or network request.
   - `pnpm embed --limit abc; $LASTEXITCODE` prints a message containing `embeddingLimit`, then `Run outcome: Failed`, and exits 1. The settings fail before the key check and before the store opens.
   - `pnpm embed --dry-run; $LASTEXITCODE` prints `unknown option "--dry-run". Usage: pnpm embed [--limit <n>]`, then `Run outcome: Failed`, and exits 1.
   - This proves the script and its `voyageai`-free import chain load under `tsx`.
   - **Do not** run `pnpm embed` with no arguments or with a valid `--limit`. `.env` may hold a real key and the Development Database URL, so that would make a live call. The AL4 "missing key" smoke run is replaced by test 2.1 group 3(c) and contract AC-40.
4. **`.env.example` check.** Run `Get-Content .env.example`. It must show exactly 4 lines: the two original lines, then `VOYAGE_API_KEY=` and `ANTHROPIC_API_KEY=`. Contract AC-52 in step 2 confirms the hashes of the original lines.
5. **Guards.** Each must return nothing:
   - `Select-String -Path src/embed/command.ts,scripts/embed.ts -Pattern "console\.|: any|as any|as unknown|ts-expect-error|eslint-disable|voyageai|https://"`
   - `Select-String -Path src/embed/command.ts -Pattern "process\.env|'--limit'|'VOYAGE_API_KEY'|'DATABASE_URL'"`
   - `Select-String -Path src/embed/command.ts,scripts/embed.ts -Pattern "\w!\.|\w!;|\w!\)|\w!,"` (non-null assertions)
   - `Get-ChildItem tests/embed -File | Where-Object Name -ne 'place-document.test.ts' | Select-String -Pattern "api\.voyageai\.com|api\.anthropic\.com|https://"`. This excludes `place-document.test.ts`, because its `https://` strings are real test data for Bare Web Addresses.
   - `Select-String -Path tests/embed/command.test.ts,tests/embed/command.db.test.ts -Pattern "process\.env|\bDATABASE_URL\b|'VOYAGE_API_KEY'"`. The `\b` keeps `UNREACHABLE_DATABASE_URL` and `DATABASE_URL_ENV` from matching.
6. `Select-String -Path src/embed/command.ts -Pattern "\.message\b"`. List every match. Each must be `report.message`. A caught error's `.message` is not allowed.
7. `Select-String -Path tests/embed/command.test.ts,tests/embed/command.db.test.ts -Pattern "runEmbedCommand\("`. List the matches and confirm each call passes `embeddingService`, directly or through the helper.
8. `Get-ChildItem src/embed` lists exactly `place-document.ts`, `types.ts`, `settings.ts`, `batches.ts`, `report.ts`, `voyage-service.ts`, `send-batch.ts`, `run-embedding.ts` and `command.ts`.
9. **Full Definition of Done.** Run these last. All must be clean:
   - `pnpm exec vitest run --no-color` (the whole suite, `contracts/` and `tests/`): all pass, with no failures and no skipped or todo tests;
   - `pnpm exec tsc --noEmit`: **0 errors**;
   - `pnpm lint`: **0 problems**.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- Files you may change:
  - `src/embed/command.ts` (new);
  - `src/embed/types.ts` (add only);
  - `scripts/embed.ts` (new);
  - `package.json` (the two script entries only);
  - `.env.example` (append two lines only);
  - `tests/embed/command.test.ts` and `tests/embed/command.db.test.ts` (new);
  - under 2.2 step 6 only: `src/embed/*` and `src/db/embedding-*.ts`, each change reported.
- **Never open, write or print `.env`.** Never put a real key, password or connection string in code, tests or output. Never make a request to Voyage, Anthropic or Wikimapia.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, docker files, other `scripts/`, other `tests/`, or any earlier AL3 prompt.

## 4. Out of Scope

- Recording the AL4 0.1 decisions in `CLAUDE.md`: the `pnpm embed` command, Schema Setup step 7, the pinned `voyageai` version and the adapter choices. The orchestrator does this.
- Any real Embedding Run against the Development Database, or with a real `VOYAGE_API_KEY`.
- Scheduling of `pnpm embed` (OS cron / Task Scheduler), and chaining it to the Crawl.
- The known `buildReport` report-check gap from the U6 routing (`endedAt` before `startedAt`). It is an AL4 matter. Do not change `report.ts` for it.
- Query embedding (`input_type: "query"`), any Anthropic client and hybrid search (Stage 2). `ANTHROPIC_API_KEY=` is added to `.env.example` only as a placeholder.
- The HTTP framework decision.
