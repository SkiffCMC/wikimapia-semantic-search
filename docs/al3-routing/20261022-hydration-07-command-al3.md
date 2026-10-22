# AL3 Routing: hydration, U7 "Crawl Command, script and contract green"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U7 of 7 (attempt 1), the last unit
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md` (revision 2), section "4. Implementation Units", "U7". Design refs: **"1.4.10 Crawl Command and script"** and "0.1 Decisions".
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- **Done and verified:** U1 to U6. That is all of `src/crawl/` except `command.ts`, the Crawl Store and crawl repository in `src/db/`, and the Crawl Progress migration.
- **Baseline:**
  - `pnpm exec tsc --noEmit` reports exactly 1 error: TS2307 in `contracts/hydration.test.ts` for `../src/crawl/command`.
  - `pnpm exec eslint src tests` is clean.
  - 1604 tests pass.
- **U6 contract preview** (with `command` stubbed). The only failures were the command-level tests:
  - AC-45;
  - AC-47 (the second test, "an unreachable Place Store ...");
  - AC-49;
  - AC-59 (4 tests, including the `package.json` `crawl` script check);
  - AC-60;
  - AC-61.

  AC-56 also failed. That is a bug in the contract's `crawlTables` helper, and the contracts step is fixing it in parallel in `contracts/`. **U7 does not touch it** (see 2.3 gate 3).
- **What this unit adds:**
  - the public `src/crawl/command.ts` (`parseCrawlArgs`, `runCrawlCommand`);
  - the `tsx` script `scripts/crawl.ts`;
  - two `package.json` script entries;
  - command unit tests.

  This unit is wiring. `runCrawl`, `usageMessage`, `knownRegionNames`, `failedReport`, `formatPlanLines`, `createSystemCrawlClock` and the contract's `exitCodeFor` already exist.
- **After this unit:** tsc reports 0 errors, `pnpm lint` reports 0 problems, and the whole suite, `contracts/hydration.test.ts` included, is green.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:

- Node ESM; TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Top-level `import type`. Relative imports have no file extension.
- `unknown` only for caught errors and `JSON.parse` output.
- Every type alias or interface declared in `src/crawl/` goes in `src/crawl/types.ts`.
- No `console.*` (output goes through `io.write` or `process.stdout.write`). Vitest globals are on.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly section 4 (no secrets, no live calls) and section 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read in full: **"1.4.10 Crawl Command and script"**, "4. Implementation Units", "U7", and "5. AL2 Guidance".<br>Read in part:<br>- "0. Scope and Fixed Points": the table and "0.1 Decisions" (the Crawl command row);<br>- "1.3 Component contracts": the `parseCrawlArgs` and `runCrawlCommand` lines;<br>- "1.4.1 Resolving the Run": the `usageMessage` line and the bullets;<br>- "1.4.8": the "Progress lines" paragraph and the summary line list. |
| 4 | `contracts/hydration.schema.ts` | Lines 85 to 102: `CRAWL_COMMAND_ENTRY_POINT`, `CRAWL_SCRIPT`, `API_KEY_ENV`, `DATABASE_URL_ENV`.<br>Lines 350 to 432: `CrawlRequestSchema`, `CrawlClock`, `CrawlDependencies`, `RunOutcome`, `exitCodeFor`.<br>Lines 659 to 711: `CRAWL_COMMAND_OPTIONS`, `CrawlCommandIO`, `CrawlCommandResultSchema`, `RunCrawlCommandFn`.<br>Use Grep for `DEFAULT_CRAWL_CONFIGURATION`, `SUMMARY_LABELS` and `OUTCOME_LABELS` if you need them. |
| 5 | `contracts/hydration.support.ts` | Lines 41 to 315: `RUN_START`, time units, `SimulatedCrawlClock`, `Gate`, `CrawlWikimapia`, `UNREACHABLE`, `scripted`.<br>Lines 360 to 385: `belgradePage1`, `emptyRecordedPage`, `wikimapiaErrorAnswer`, `rateLimitForever`. |
| 6 | `contracts/storage.support.ts` | Lines 46 to 91: `requireTestDatabaseUrl`, `UNREACHABLE_PASSWORD`, `UNREACHABLE_DATABASE_URL`. Also the `TEST_API_KEY` export; use Grep to find it. |
| 7 | `contracts/hydration.test.ts` | Read only. **Do not edit it.** Read these ranges:<br>- 144 to 190 (lifecycle, the `fetch` stub);<br>- 430 to 473 (`commandIO`, `runCommand`, `smallScript`): the model for the command test harness;<br>- 1597 to 1614 (AC-45);<br>- 1703 to 1721 (AC-47, second test);<br>- 1732 to 1759 (AC-49);<br>- 2025 to 2130 (AC-59, AC-60, AC-61);<br>- 2256 to 2262 (AC-64). |
| 8 | `src/crawl/types.ts` | The file to extend with one type. |
| 9 | `src/crawl/config.ts` | Lines 1 to 30 and 60 to 80: `MISSING_API_KEY_MESSAGE`, `knownRegionNames`, `usageMessage`. |
| 10 | `src/crawl/report.ts` | Lines 100 to 176: `failedReport`, `formatPlanLines`. |
| 11 | `src/crawl/run-crawl.ts` | Lines 275 to 291 only: the public `runCrawl` and its never-reject pattern. |
| 12 | `src/crawl/runtime.ts` | `createSystemCrawlClock` (needed for the fallback time when `io.clock` is absent). |
| 13 | `scripts/load-env.ts`, `scripts/db-migrate.ts` | `readEnvFile` and `applyEnvDefaults`, and the script pattern: `.env` path via `fileURLToPath(new URL(...))`, top-level `await`, `process.exitCode`, no `console`. |
| 14 | `package.json` | The `scripts` block to change. |
| 15 | `tests/crawl/run-crawl.db.test.ts` | Lines 1 to 120 only: the Test Database lifecycle and the local harness style for `tests/crawl`. |

Do not read the rest of `src/db/`, `src/wikimapia/` or `src/crawl/`, or the AL6/AL7 documents.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. In tests, use only `TEST_API_KEY` and the synthetic `UNREACHABLE_*` values.

## 2. Execution Directives

### 2.1 add-test-writer

Write two new files. Both stub global `fetch` with a rejecting spy in `beforeAll` and unstub it in `afterAll`. Every `runCrawlCommand` call gets an injected `SimulatedCrawlClock` and `CrawlWikimapia.transport`, built with a local `runCommand(argv, responder, extra)` helper modelled on the contract's. Parse every result with `CrawlCommandResultSchema`. Do not copy contract tests wholesale.

**`tests/crawl/command.test.ts`** (pure, no database)

A. `parseCrawlArgs` (AL4 1.4.10):

1. **Options.** Each option alone and all of them together produce exactly the expected `CrawlRequest`, with keys present only for the options given. Use `toStrictEqual`, so absent keys are really absent.
2. **Leading `--`.** One leading `--` is dropped. A `--` anywhere else is an unknown option.
3. **Values that look like options.** `--refresh-age -1` gives `refreshAgeDays: -1`. `--budget --relist` takes `--relist` as the value, which becomes NaN.
4. **Numbers.** `'2'`, `'0'`, `'-1'` and `'1.5'` parse to numbers. `''`, `'abc'`, `'1e3'`, `'0x10'` and `' 2'` give `NaN` (use `Number.isNaN`).
5. **Problems.** Each of these returns `{ ok: false }` and a `problem` that names the offending option:
   - an unknown option (`--regoin`) or a bare word;
   - a missing value (`--budget` as the last token);
   - an option given twice (`--region a --region b`, `--dry-run --dry-run`).
6. **No arguments.** `[]` gives `{ ok: true, request: {} }`.

B. `runCrawlCommand` paths that need no database. Use `env` without `DATABASE_URL`, or with `UNREACHABLE_DATABASE_URL`.

1. **Unknown option.** The outcome is `failed` and the exit code is 1. The message and output contain the problem, `--region`, `belgrade` and `belgrade-small`. 0 Wikimapia calls.
2. **`--budget abc` and `--budget ''`.** `failed`, the message names `requestBudget`, exit 1, 0 calls.
3. **`[]` (no region).** `failed`, exit 1, the usage text lists the known Region Names, 0 calls, and `summary.regionName` is absent.
4. **Dry Run.** `--region belgrade-small --dry-run` with `env: {}` (no key, no database):
   - `planned`, exit 0, 0 calls;
   - the output has the `Region belgrade-small: 4 tiles` line, then exactly 4 `Tile <n>: west ...` lines in Tile Number order, then the summary lines (including `Run outcome: Planned`).
5. **No database and no Dry Run.** `env` without `DATABASE_URL` and without `--dry-run`, with a valid key:
   - `failed`, exit 1, 0 calls;
   - the output and `JSON.stringify(result)` contain no `TEST_API_KEY`, `key=`, `postgres://` or `UNREACHABLE_PASSWORD`.
6. **Output order.** For a failed report, the first line written after any progress lines is `report.message`, and each `summaryText` line follows as its own `write` call. No written line contains `\n`.
7. **`exitCodeFor` agreement.** For every result in this file, `result.exitCode === exitCodeFor(result.report.outcome)`.
8. **Never rejects.** Use an `io.write` that throws on its first call. The command still resolves, with outcome `failed` and exit code 1. This covers the outer `try/catch`.

**`tests/crawl/command.db.test.ts`** (Test Database, same lifecycle as `tests/crawl/run-crawl.db.test.ts`)

1. **Completed.** `--region belgrade-small` with a script where every tile is `emptyRecordedPage()` gives `completed` and exit 0. The output contains the `Run <id> started for region belgrade-small` progress line before the summary lines.
2. **Budget Reached.** `--budget 1` gives `budget_reached`, exit 0, exactly 1 call, and an output line `Run outcome: <OUTCOME_LABELS.budget_reached>`.
3. **Rate Limited.** A `rateLimitForever` responder gives `rate_limited` and exit 0.
4. **Interrupted.** A signal aborted before the call gives `interrupted`, exit 1 and 0 calls.
5. **Overrides reach the Run.** `--min-interval 1 --budget 2` gives 2 calls exactly 1 s apart (`startedAtMs`).
6. **Relist.** After a complete pass, `--relist --budget 1` (on a clock 1 hour later) lists `tile 1 page 1` again, and `readCrawlProgress` shows 2 passes.
7. **Unreachable database.** `DATABASE_URL: UNREACHABLE_DATABASE_URL` with a valid key gives `failed`, exit 1, 0 calls and no secrets in the output. Give this test a 60 s timeout.

The new tests are expected to fail until `add-coder` has finished. Do not stub production modules.

### 2.2 add-coder

1. **`src/crawl/types.ts`** (extend). Add one exported type, `ParsedCrawlArgs = { ok: true; request: CrawlRequest } | { ok: false; problem: string }`.
   - Import `CrawlRequest` with `import type` from the hydration contract.
   - Change no existing type. Update the header comment ("U7 adds `ParsedCrawlArgs`").

2. **`src/crawl/command.ts`** (new, **public**). Follow the AL4 1.4.10 pseudocode.

   **`parseCrawlArgs(argv: readonly string[]): ParsedCrawlArgs`**, a pure function:
   - Drop one leading `--`.
   - **Option names.** Use `CRAWL_COMMAND_OPTIONS` for every name; never hard-code the strings.
     - Flags (no value): `--dry-run`, `--relist`.
     - Valued options: `--region`, `--budget`, `--min-interval`, `--refresh-age`. The next token is the value even when it starts with `-`.
   - **Problems.** Problem texts are short and name the option or token, never an env value:
     - an unknown option or bare word: `unknown option "<token>"`;
     - a missing value: `missing value for <option>`;
     - an option given twice: `option <option> given twice`.
   - **Numbers.** Values matching `/^-?\d+(?:\.\d+)?$/` become `Number(text)`; anything else becomes `NaN`. `--region` keeps its text as is.
   - **The request.** Build the `CrawlRequest` with conditional spreads, so keys are present only when the option was given (`exactOptionalPropertyTypes`).

   **`runCrawlCommand: RunCrawlCommandFn`**, which never rejects:
   - **Parse.** Call `parseCrawlArgs(argv)`.
     - Not ok: `report = failedReport(`${problem}. ${usageMessage(knownRegionNames(DEFAULT_CRAWL_CONFIGURATION))}`, undefined, now)`.
     - Ok: `report = await runCrawl(parsed.request, deps)`. Build `deps` with:
       - `connectionString: io.env[DATABASE_URL_ENV] ?? ''`;
       - `apiKey` from `io.env[API_KEY_ENV]`;
       - `transport`, `clock` and `signal` from `io`;
       - `onProgress: io.write`.

       Add each optional key only when it is defined. Do not pass `configuration`, so the default applies. Do not pass `onWrite`.
   - **`now`.** `toMoment((io.clock ?? createSystemCrawlClock(io.signal)).now())`. No `new Date()` in this file.
   - **Write the output**, one `io.write` per line, in this order:
     1. `report.message`, if present;
     2. for `planned` only: `Region <plan.regionName>: <n> tiles`, then each line of `formatPlanLines(plan)`;
     3. each line of `report.summaryText.split('\n')`.
   - **Return** `{ exitCode: exitCodeFor(report.outcome), report }`. Use the contract's `exitCodeFor`; never re-implement it.
   - **Errors.** An outer `try/catch` around everything turns any thrown error, including one from `io.write`, into `failedReport('Crawl failed: internal error', undefined, now)` with exit code 1. Write nothing more in that case. Never put a caught error's `.message` in the report or the output.
   - **Constraints:**
     - Never read or print anything from `io.env` except passing the two values to `runCrawl`.
     - No SQL, no `knex` or `pg` imports, no `fetch`.
     - Use `String(n)` in templates where lint requires it.

3. **`scripts/crawl.ts`** (new). Follow the `scripts/crawl.ts` paragraph of AL4 1.4.10 and the `scripts/db-migrate.ts` pattern:
   - **Environment.** `applyEnvDefaults(readEnvFile(fileURLToPath(new URL('../.env', import.meta.url))))`. The shell and the scheduler win.
   - **Interrupt.** Create one `AbortController`. Register `process.once('SIGINT', abort)` and `process.once('SIGTERM', abort)`.
   - **Output.** `write = (line) => process.stdout.write(`${line}\n`)`.
   - **Environment for the command.** `env` holds only `WIKIMAPIA_API_KEY` and `DATABASE_URL`, read from `process.env`. Use the contract constants `API_KEY_ENV` and `DATABASE_URL_ENV`, and conditional spreads (a key only when it is defined).
   - **Run.** `const result = await runCrawlCommand(process.argv.slice(2), { env, write, signal: controller.signal })`. Do not inject a transport or clock, so the real defaults are used.
   - **Finish.** Afterwards, in a `finally`, remove both signal listeners with `process.off`. Then set `process.exitCode = result.exitCode`.
   - **Constraints.** No `console.*`, no `process.exit()`, and never print an env value.

4. **`package.json`**. Change only these two entries:
   - add `"crawl": "tsx scripts/crawl.ts"`;
   - change `"test:db"` to `"vitest run --no-color contracts/storage.test.ts contracts/hydration.test.ts tests/db tests/crawl"`.

   Change nothing else: no dependency changes and no reordering of other keys.

5. **Do not change:**
   - `src/db/` or `src/wikimapia/`;
   - any existing module in `src/crawl/` other than the one addition to `types.ts`;
   - `scripts/load-env.ts`, `scripts/db-*.ts`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, `.env.example`;
   - existing tests.

6. **Stop and report, do not work around,** if:
   - a contract test fails because `contracts/` and AL4 disagree;
   - AC-56 still fails because the parallel contracts-step fix has not landed (report the failing assertion verbatim);
   - `runCrawl` or a U2 export lacks something the command needs.

7. Run every Done-when check in 2.3, in order. Report each result with its exit code and the relevant output lines (totals, error counts, smoke output).

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker and the Test Database must be up (`pnpm db:up`, `.env.test`). No gate may make a live Wikimapia or OpenAI call.

0. **Before running any test,** record the output of `pnpm db:status` (Development Database) for gate 8.
1. **Unit tests.** `pnpm exec vitest run --no-color tests/crawl` passes, with no failures and no skipped or todo tests.
2. **Contracts.** `pnpm exec vitest run --no-color contracts/hydration.test.ts contracts/hydration.schema.test.ts contracts/storage.test.ts` passes. Every test listed in section 0 as an expected U6 preview failure now passes.
3. **Whole suite.** `pnpm exec vitest run --no-color` (all of `contracts/` and `tests/`) passes, with more than the 1604 baseline tests and no skipped or todo tests.
   - If the only failure is AC-56, check whether the contracts step has landed its `crawlTables` fix. If it has not, report the failure and stop. Do not touch `contracts/`.
4. **`pnpm test:db`** passes. This checks the extended script.
5. **Types.** `pnpm exec tsc --noEmit` reports **0 errors**.
6. **Lint.** `pnpm lint` (`eslint .`, which includes `contracts/` and `scripts/`) reports **0 problems**, warnings included.
7. **Smoke runs of the real command.** These run under `tsx`. They make no Wikimapia request and leave `.env` untouched.
   - **Dry Run.**
     - Command: `$env:DATABASE_URL='postgres://nobody:none@127.0.0.1:1/none'; pnpm crawl --region belgrade-small --dry-run; $code=$LASTEXITCODE; Remove-Item Env:DATABASE_URL; $code`
     - Expected output: the `Region belgrade-small: 4 tiles` line, 4 `Tile <n>:` lines, `Run outcome: Planned` and `Wikimapia requests: 0`.
     - Expected exit code: `0`.
     - This shows the Dry Run opens no database (the URL is unreachable) and sends nothing.
   - **No region.**
     - Command: `pnpm crawl; $LASTEXITCODE`
     - Expected output: the usage line with `--region`, `belgrade` and `belgrade-small`.
     - Expected exit code: `1`.
   - **What to report.** Paste both outputs. Neither may contain an API key, `key=` or a `postgres://` URL.
8. **AC-64.** `pnpm db:status` prints exactly what it printed in step 0. The test run did not change the Development Database.
9. **Guards.** Each of these returns nothing:
   - `Select-String -Path src/crawl/command.ts, scripts/crawl.ts, src/crawl/types.ts, tests/crawl/command.test.ts, tests/crawl/command.db.test.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|\.js'|from 'knex'|from 'pg'|process\.exit\("`
   - `Select-String -Path src/crawl/command.ts -Pattern "new Date\(|error\.message|err\.message|String\(error|function exitCodeFor"`
   - `Select-String -Path scripts/crawl.ts -Pattern "write\(.*process\.env"` (no env value is ever printed)

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. This includes `contracts/fixtures/`, the `*.support.ts` files, and the AC-56 `crawlTables` helper that the contracts step is fixing.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract.
  - Do not skip, weaken or `.todo` any contract test or any existing test.
  - Do not copy or redefine contract schemas, constants or helpers in `src/`, `scripts/` or `tests/`. Import them. This covers `exitCodeFor`, `CRAWL_COMMAND_OPTIONS`, `API_KEY_ENV`, `DATABASE_URL_ENV`, `DEFAULT_CRAWL_CONFIGURATION`, `toMoment`, `CrawlCommandResultSchema`, `SimulatedCrawlClock`, `scripted`, and the like.
- **Files you may create or change:** `src/crawl/command.ts`, `src/crawl/types.ts` (one addition only), `scripts/crawl.ts`, `package.json` (the two script entries only), `tests/crawl/command.test.ts`, `tests/crawl/command.db.test.ts`. Nothing else.
- **No live calls.** No test reaches real `fetch` or real long timers. The smoke runs in 2.3 step 7 are the only real-runtime executions, and both end before any network or database access.
- **Secrets:** never open, write or print `.env`. Never print `process.env` values. Use only `TEST_API_KEY` and the synthetic `UNREACHABLE_*` values.
- **Protected files:** do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U1 to U6 (done):** any change to the schema step, the Crawl Store, the crawl repository, the Gateway, `requestWithBackoff`, the runtime defaults, config resolution, the tally and report builders, the Listing and Details Phases, and `runCrawl`. If a contract test points at one of them, stop and report it.
- **AC-56 contract-helper fix:** owned by the contracts step in `contracts/`.
- **Any in-process scheduler:** scheduling is OS cron or Task Scheduler (AL4 0.1).
- **Live crawling:** any run of `pnpm crawl` without `--dry-run`, which would call Wikimapia with the real key.
- **Orchestrator:** recording the AL4 0.1 decisions in `CLAUDE.md`. That covers the Crawl command, Crawl Progress storage, one live Run per Region, the current Listing Pass and write-hook numbering.
