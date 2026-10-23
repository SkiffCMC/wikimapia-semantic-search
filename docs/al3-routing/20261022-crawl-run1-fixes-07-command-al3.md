# AL3 Routing: crawl-run1-fixes, U7 "Command option and full verification"

- **Feature:** `crawl-run1-fixes` (Stage 1, change to substeps 1 and 3)
- **Unit:** U7 of 7, the last one (attempt 1). Depends on U6. U1 .. U6 are done (routing prompts `docs/al3-routing/20261022-crawl-run1-fixes-0{1..6}-*-al3.md`).
- **AL4 source:** `docs/al4-design/20261022-crawl-run1-fixes-al4.md`, section "4. Implementation Units", "U7. Command option and full verification"
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2)
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `pnpm exec vitest run --no-color` (whole suite) has **exactly 1 failure**: `contracts/crawl-run1-fixes.test.ts > AC-40 Command option > --retry-parked: with --dry-run it reports the Parked count and changes nothing; with --budget it releases`. It fails because `parseCrawlArgs` does not know `--retry-parked` yet (the Run ends Failed with `unknown option "--retry-parked"`).
- AC-19 (quota Run exits 0) and AC-46 (no live calls) already pass. They must stay green.
- `pnpm exec tsc --noEmit`: 0 errors. `pnpm lint`: clean.
- **Already done by U6, do not redo:** `ResolvedRun.retryParked`, `resolveRun` support and the `[--retry-parked]` entry in `usageMessage` (`src/crawl/config.ts`); the Dry Run parked-count read in `src/crawl/run-crawl.ts` (a Dry Run with `retryParked` returns a Planned report with `parkedPlacesInRegion`); `report.parkedPlacesInRegion`; the `quota_exhausted` outcome, its summary line and exit status 0.
- So U7 is small: the command flag, the one extra Dry Run output line, tests, and the whole-suite verification.

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, **extensionless** relative imports, `unknown` only where `.agrules` section 5 allows it, no `console`, no SQL in `src/crawl/`. Match the style of the existing `src/crawl/command.ts` and `tests/crawl/command*.ts`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 1, 4 (no secrets, no live calls) and 5. |
| 2 | `CLAUDE.md` | Stack, commands, decisions (Crawl command line). Do not edit it. |
| 3 | `docs/al4-design/20261022-crawl-run1-fixes-al4.md` | Read only: "0.1" decision 1 and the "Crawl command" row; "1.4.10" last paragraph (the command output line); "1.4.11"; "4. Implementation Units / U7". Skip everything else. |
| 4 | `contracts/hydration.schema.ts` | `CRAWL_COMMAND_OPTIONS` incl. `retryParked` (~710-720); `CrawlRequestSchema` `retryParked` (~359-370); `RunReportSchema` `parkedPlacesInRegion` and its Planned-only refine (~655-695); `SUMMARY_LABELS`, `OUTCOME_LABELS`, `exitCodeFor`, `ZERO_RUN_COUNTS`. |
| 5 | `contracts/crawl-run1-fixes.test.ts` | The harness `seedRecordedSummaries` (~318), `respond` (~397), `runCommand` (~489), and the cases **AC-19** (~913), **AC-40** (~1481) and **AC-46** (~1614). |
| 6 | `contracts/hydration.support.ts` | Test doubles (`SimulatedCrawlClock`, `CrawlWikimapia`, `scripted`, `listingAnswer`, `syntheticBoxPlace`, `wikimapiaErrorAnswer`, `detailsAnswer`, `emptyRecordedPage`, `HOUR`, `TEST_API_KEY`). |
| 7 | `contracts/wikimapia-client.support.ts` | `keyQuotaAnswer` (~105-130) for the quota command test. |
| 8 | `src/crawl/command.ts` | **The file to change.** |
| 9 | `src/crawl/config.ts` | Read only: `usageMessage` already lists `[--retry-parked]`. |
| 10 | `src/crawl/report.ts` | Read only: `formatPlanLines`, `failedReport`. |
| 11 | `tests/crawl/command.test.ts` | Test file to extend (no database: `NO_DATABASE_ENV`, `runCommand`, `parsedRequest`, `parsedProblem`, `USAGE`, `summaryLines`, `smallScript`). |
| 12 | `tests/crawl/command.db.test.ts` | Test file to extend (Test Database: `runCommand`, `emptyScript`, `progress`, `expectNoSecrets`, `outcomeLine`, `BELGRADE_SMALL_TILES`). |
| 13 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. |

Do not read `src/db/`, `src/wikimapia/`, the other `src/crawl/` files, migrations or the AL6 document. U7 changes none of them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

**Line endings:** `src/crawl/command.ts`, `tests/crawl/command.test.ts` and `tests/crawl/command.db.test.ts` are LF and must stay LF. Do not touch `tests/crawl/run-crawl.db.test.ts` or `contracts/storage.support.ts` (both are committed CRLF and must stay so). Every other file keeps its existing endings. Never rewrite a whole file with a tool that converts line endings.

## 2. Execution Directives

### 2.1 add-test-writer

Expand AL4 U7 "Unit tests must cover" as follows. Use only contract constants for option names and labels (`CRAWL_COMMAND_OPTIONS`, `SUMMARY_LABELS`, `OUTCOME_LABELS`); never retype `--retry-parked` or a label text. Do not change or delete existing expectations. Global `fetch` stays a rejecting spy.

**A. `tests/crawl/command.test.ts` (no database)**

1. `parseCrawlArgs`: `[CRAWL_COMMAND_OPTIONS.retryParked]` alone gives exactly `{ retryParked: true }`. With `--region belgrade-small --dry-run` it gives `{ regionName, dryRun: true, retryParked: true }`; with `--budget 10` it gives `{ ..., requestBudget: 10, retryParked: true }`. Order does not matter. Without the flag the request has no `retryParked` key.
2. `--retry-parked` given twice: problem `option --retry-parked given twice`. Through `runCrawlCommand`: outcome `failed`, exit 1, message `option --retry-parked given twice. ${USAGE()}`, 0 Wikimapia calls.
3. `USAGE()` contains `[${CRAWL_COMMAND_OPTIONS.retryParked}]`, and it follows `[--relist]`.
4. A Dry Run **without** the option still prints no parked line (assert no output line starts with `Parked places that`), and the existing B4 output shape is unchanged.
5. `--region belgrade-small --dry-run --retry-parked` with an env that has **no** `DATABASE_URL` (or an unreachable one built like the existing B4 case): outcome `failed`, exit 1, 0 Wikimapia calls, no parked line, and no `postgres://` or `UNREACHABLE_PASSWORD` in the report or output (AL4 0.1 decision 1: the read cannot be answered, so the Run ends Failed). If `runCrawl` with an empty connection string turns out to end in another documented way, stop and report instead of adapting the expectation.

**B. `tests/crawl/command.db.test.ts` (Test Database)**

1. **Parked line.** Make one Place of `belgrade-small` Parked through the command itself: three runs `--region belgrade-small` (clock advanced by at least 1 `HOUR` between runs, as in contract AC-40) whose Listing Phase lists the Place and whose Details request for it gets `wikimapiaErrorAnswer()`. Then `--region belgrade-small --dry-run --retry-parked`: outcome `planned`, exit 0, `report.parkedPlacesInRegion` 1, counts strictly `ZERO_RUN_COUNTS`, 0 Wikimapia calls. The output is: the plan header and the four Tile lines, then exactly one line `Parked places that ${CRAWL_COMMAND_OPTIONS.retryParked} would release: 1`, then the summary lines (equal to `report.summaryText.split('\n')`). The parked line is not part of `summaryText`. Afterwards the Place is still Parked: a following plain run sends no `place.getbyid` for it.
2. With nothing Parked, `--dry-run --retry-parked` prints `... would release: 0` and exits 0.
3. `--region belgrade-small --retry-parked --budget 10` after B.1: exit 0, the Place is requested, `summary.counts.placesReleased` 1, and the output contains `Explicit retry: released 1 parked places of region belgrade-small` before the summary lines.
4. **Quota Run** (AL4 U7): the first request answered by `keyQuotaAnswer()`: exit 0, outcome `quota_exhausted`, 1 Wikimapia call, output contains `outcomeLine(result)` (`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`) and a line starting with `${SUMMARY_LABELS.wikimapiaMessage}: `, and `expectNoSecrets` holds for the joined output.

Seed only through the command and the scripted transport (synthetic listing pages via `listingAnswer`/`syntheticBoxPlace`, or recorded fixtures). Read state only through the public Crawl Store. Run the new cases once and confirm that they fail only because the flag and the line are missing. Do not stub production modules.

### 2.2 add-coder

Implement AL4 1.4.11 and the command part of 1.4.10, in `src/crawl/command.ts` only.

1. **`FLAG_OPTIONS`** gains `CRAWL_COMMAND_OPTIONS.retryParked`. The existing loop already turns a repeated flag into `option ... given twice`.
2. **`parseCrawlArgs`**: add `retryParked: true` to the request through a conditional spread when the flag was given, in the same style as `dryRun` / `relist`. No key when absent (`exactOptionalPropertyTypes`).
3. **`writeReport`**: for a Planned report with `report.parkedPlacesInRegion !== undefined`, write one extra line **after the plan lines and before the summary lines**: `` `Parked places that ${CRAWL_COMMAND_OPTIONS.retryParked} would release: ${String(n)}` ``. Never add it to `summaryText`. Nothing else in the output order changes.
4. Update the file header comment (mention `--retry-parked` and the parked line; reference crawl-run1-fixes AL4 1.4.10/1.4.11, AC-40).
5. Do not change `src/crawl/config.ts`, `run-crawl.ts`, `report.ts`, any other `src/` file, `scripts/` or `package.json`. U6 already did their part. If a test or contract case seems to need such a change, stop and report it.
6. **Stop and report, do not work around:** any whole-suite failure outside AC-40 that appears or remains after your change; any contract case that contradicts AL4 1.4.10/1.4.11; any need to edit `contracts/`.
7. Run every Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

**Precondition:** Docker is running and `postgres` is healthy (`pnpm db:up` otherwise), and `.env.test` exists. Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. **Use the Test Database only.**

1. `pnpm exec vitest run --no-color tests/crawl/command.test.ts tests/crawl/command.db.test.ts` passes (no failures, no skipped or todo tests).
2. `pnpm exec vitest run --no-color contracts/crawl-run1-fixes.test.ts contracts/crawl-run1-fixes.schema.test.ts contracts/hydration.test.ts contracts/hydration.schema.test.ts` passes, including **AC-19, AC-40 and AC-46** (the whole of `crawl-run1-fixes.test.ts` is green).
3. `pnpm exec vitest run --no-color` (whole suite: `tests/` and `contracts/`) passes with **0 failures**. Report the totals.
4. `pnpm exec tsc --noEmit` reports **0 errors**.
5. `pnpm lint` reports **0 problems**.
6. `pnpm crawl --region belgrade-small --dry-run` (no `--retry-parked`) prints the plan, exits 0 and needs no database. This is the only `pnpm crawl` invocation allowed.
7. Guards. Each returns nothing (or `False` for the line-ending check):
   - `Select-String -Path src/crawl/command.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable"`
   - `Select-String -Path src/crawl/command.ts -Pattern "'--retry-parked'|`"--retry-parked`""` (the option name comes from `CRAWL_COMMAND_OPTIONS`)
   - LF guard: `foreach ($f in 'src/crawl/command.ts','tests/crawl/command.test.ts','tests/crawl/command.db.test.ts') { "$f " + ((Get-Content -Raw $f) -match "`r") }` prints `False` for every file.
   - `tests/crawl/run-crawl.db.test.ts` and `contracts/storage.support.ts` are untouched (still CRLF): `foreach ($f in 'tests/crawl/run-crawl.db.test.ts','contracts/storage.support.ts') { "$f " + ((Get-Content -Raw $f) -match "`r") }` prints `True` for both.

**Deviation from AL4 U7 Done-when (routing decision):** AL4 asks for `pnpm crawl --region belgrade-small --dry-run --retry-parked` against the Development Database plus `pnpm db:status`. That command opens the Development Database (read-only), and the orchestrator restricts this unit to the Test Database. **Do not run it**, and do not run `pnpm db:status` or `pnpm db:migrate`. B.1/B.2 of 2.1 cover the same behaviour on the Test Database. Mention in your report that this manual check is left to the Operator. (Note for the Operator: if the Development Database does not have Schema Setup step 6 applied yet, that Dry Run will end Failed until it is migrated.)

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/`, the `*.support.ts` files and every contract test file).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test or existing `tests/` case, and do not change existing expectations.
- Files you may change: `src/crawl/command.ts`, `tests/crawl/command.test.ts`, `tests/crawl/command.db.test.ts`. Nothing else.
- Keep LF in those three files. `tests/crawl/run-crawl.db.test.ts` and `contracts/storage.support.ts` stay CRLF and untouched.
- Test Database only. Never migrate or write the Development Database, never set `DATABASE_URL`, never run a non-dry-run `pnpm crawl` or a `pnpm crawl` with `--retry-parked`.
- Never open, write or print `.env`. Never put a real API key, password or non-default connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, or any earlier AL3 prompt.
- If a contract, the AL4 spec or this prompt looks wrong or contradictory, stop and report it (`.agrules` section 0, Triggered Bugfixing).

## 4. Out of Scope

Do not implement any of the following now:

- Anything already delivered by U1 .. U6: `resolveRun` / `usageMessage` (`config.ts`), the Dry Run parked read, Explicit Retry start, Failure Records, Parking, end-of-run totals (`run-crawl.ts`, `failures.ts`, phases), report and summary lines (`report.ts`), Client changes (`src/wikimapia/`), every `src/db/` file and migration.
- Recording the AL4 0.1 "Further decisions" in `CLAUDE.md` (the orchestrator does that).
- Any Development Database migration, write or read (see the deviation note in 2.3).
