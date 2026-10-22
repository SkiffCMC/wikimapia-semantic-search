# AL3 Routing: hydration, U2 "Pure crawl core: Tile Plan, configuration, tally and summary"

- **Feature:** `hydration` (Stage 1, substep 3)
- **Unit:** U2 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261022-hydration-al4.md`, section "4. Implementation Units", "U2".
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 is done and verified: the Schema Setup step `20261022_01_create_crawl_progress`, `src/db/crawl-tables.ts`, `undoLast()` and the extended `emptyStore()` exist. This unit does not touch `src/db/`.
- `src/crawl/` and `tests/crawl/` do not exist yet. You create them.
- Baseline: `pnpm exec tsc --noEmit` reports exactly 4 TS2307 errors in `contracts/hydration.test.ts` (modules `src/crawl/command`, `src/crawl/run-crawl`, `src/crawl/tile-plan`, `src/db/crawl-store`), and `pnpm lint` reports the 4 matching errors. After this unit the `src/crawl/tile-plan` error is gone. The other 3 remain until U3, U6 and U7. Do not create stubs for `command`, `run-crawl` or `crawl-store`.
- Everything in this unit is pure: no database, no network, no clock, no `Date.now()`/`new Date()` (moments come in as arguments).

## 1. Context Manifest

Read these files, and only these. Follow the stack and code style from `.agrules` section 5 and `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), top-level `import type`, extensionless relative imports, `unknown` only where `.agrules` 5 allows it, every type alias/interface of `src/crawl/` in `src/crawl/types.ts`, no `console`. Vitest globals are on.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules, mainly sections 2, 4 and 5. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261022-hydration-al4.md` | Read only: "0. Scope and Fixed Points" (table, "Single source of truth", "Code style"); "1.1 Module map" (rows `types.ts`, `tile-plan.ts`, `config.ts`, `report.ts`); "1.3 Component contracts" (the `src/crawl/types.ts` block and the `tile-plan.ts`, `config.ts`, `report.ts` signatures); "1.4.1 Resolving the Run"; "1.4.2 Tile Plan"; "1.4.8 Run end, Run Summary, report" (bullets on `buildReport`, `failedReport`, the `formatSummaryText` line list, the paragraph after it); "4. Implementation Units", "U2"; "5. AL2 Guidance" (bullets "`exactOptionalPropertyTypes`", "Imports", "`unknown`", "Do not edit `contracts/`"). |
| 4 | `contracts/hydration.schema.ts` | Lines 100 to 660: constants, `toMoment`, `RegionNameSchema`, `TileSizeSchema`, `RegionSchema`, `CrawlConfigurationSchema`, `CONFIGURATION_SETTING_KEYS`, `BELGRADE_*_REGION`, `DEFAULT_CRAWL_CONFIGURATION`, `TileSchema`, `TilePlanSchema`, `cellsCovering`, `findTilePlanIssues`, `PlanTilesFn`, `CrawlRequestSchema`, `RunOutcomeSchema`, `ItemFailureKindSchema`, `RunCountsSchema`, `ZERO_RUN_COUNTS`, `RunSummarySchema`, `SUMMARY_LABELS`, `OUTCOME_LABELS`, `ITEM_FAILURE_LABELS`, `FailedItemSchema`, `ItemFailureReportSchema`, `RunReportSchema`. Also `CRAWL_COMMAND_OPTIONS` (line 668) and `API_KEY_ENV` (line 101). |
| 5 | `contracts/wikimapia-client.schema.ts` | Only `BoundingBoxSchema` (lines 112 to 122; its refine issue paths end in `east`/`north`) and `MAX_PAGE_SIZE`. |
| 6 | `contracts/hydration.support.ts` | Only section "Test Regions" (lines 432 to 490): `SMALL_BBOX`, `REGION_T1`/`T2`/`T4`/`FAR`, `T1_TILES`/`T2_TILES`/`T4_TILES`/`FAR_TILES`, `testConfiguration`. |
| 7 | `contracts/hydration.test.ts` | Read only (end-to-end checks your modules must later satisfy through `runCrawl` in U6/U7): lines 418 to 437 (`BELGRADE_SMALL_TILES`, `planOf`), the blocks AC-1, AC-2, AC-66, AC-3, AC-4, AC-67, AC-5, AC-6 (lines 478 to 671), AC-10 (736), AC-51 and AC-54 (1801 to 1906), AC-60 (2086). Do not run this file. |
| 8 | `src/wikimapia/issues.ts` | Only `formatIssuePath` (line 28), which `config.ts` may reuse unchanged. |
| 9 | `src/wikimapia/types.ts` | Style reference for a types-only module. |
| 10 | `tests/wikimapia/issues.test.ts` | Style reference for a pure unit test (header comment, import layout). |

Do not read `src/db/`, the rest of `src/wikimapia/` or the other `tests/` folders. They are not touched by this unit.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key.

## 2. Execution Directives

### 2.1 add-test-writer

Create three pure test files (no Test Database, no network, no timers). Import production code from `../../src/crawl/<module>` and contract items from `../../contracts/hydration.schema`, `../../contracts/hydration.support`. Use synthetic values only. Never put a real key in a test; for `isMissingApiKey` use obviously fake strings.

**A. `tests/crawl/tile-plan.test.ts`** (`planTiles`; AL4 1.4.2, AC-2, AC-3, AC-4, AC-66, AC-67)
1. `BELGRADE_SMALL_REGION`: 2 columns x 2 rows, the 4 Tiles of AC-2 in order (copy the expected values from AL6 AC-2 / `contracts/hydration.test.ts` lines 419 to 424), compared within `COORDINATE_TOLERANCE`; `TilePlanSchema.parse` succeeds; `findTilePlanIssues` returns `[]`.
2. `BELGRADE_REGION`: 120 columns, 66 rows, 7,920 Tiles; Tiles 1, 120, 121 and 7920 as in AC-66; every Tile is 0.005 wide and high within `COORDINATE_TOLERANCE`; `findTilePlanIssues` returns `[]`.
3. A Region smaller than a Tile (use the AC-3 region of the contract test): exactly 1 Tile, Tile Number 1, bbox equal to the Region's bbox.
4. `REGION_T1`, `REGION_T2`, `REGION_T4`, `REGION_FAR`: `plan.tiles` `toStrictEqual` `T1_TILES`, `T2_TILES`, `T4_TILES`, `FAR_TILES` (exact equality is intended: AL4 1.4.2 `round9` removes float noise, and edges equal to the Region edge are copied, not computed).
5. Plan-level fields: `regionName` = Region name; `bbox` and `tileSize` equal the Region's but are fresh objects (mutating the returned plan does not change the Region).
6. Stability (AC-4): two calls on the same Region and one on `structuredClone(region)` are `toStrictEqual`.
7. AC-67: two Regions with the same bbox and Tile Sizes 0.005 and 0.01 give 4 and 1 Tiles, each plan carrying its own `tileSize`.
8. Inner edges carry no float noise: for the `belgrade` plan, every Tile coordinate has at most 9 decimals (e.g. `Number(x.toFixed(9)) === x`).

**B. `tests/crawl/config.test.ts`** (`resolveRun`, `knownRegionNames`, `usageMessage`, `isMissingApiKey`; AL4 1.4.1, AC-1, AC-5, AC-6, AC-60)
1. Success: `resolveRun({ regionName: 'belgrade-small' }, DEFAULT_CRAWL_CONFIGURATION)` is ok; `run.plan` equals `planTiles(BELGRADE_SMALL_REGION)`; `dryRun` and `relist` are `false` when absent and `true` when given; the request name is trimmed (`'  belgrade-small '` resolves).
2. Overrides: `requestBudget`, `minRequestIntervalSeconds`, `refreshAgeDays` from the request replace the configuration values in `run.configuration`; absent overrides keep the configuration values; the input configuration object is not mutated.
3. AC-6, one case per row, each `ok: false` with a message containing the setting key (use `testConfiguration` and `REGION_T1` as the contract test does): reversed bbox -> `bbox`; Tile width 0 -> `tileSize`; `listingPageSize` 0 and 101 -> `listingPageSize`; `refreshAgeDays` -1 -> `refreshAgeDays`; `minRequestIntervalSeconds` NaN -> `minRequestIntervalSeconds`; `requestBudget` -3 -> `requestBudget`; request override `requestBudget: NaN` -> `requestBudget`; request override `refreshAgeDays: -0.5` -> `refreshAgeDays`. For the Region-level cases the message also names the Region (`of region "test-one"`). Messages start with `Invalid crawl configuration:`. An invalid configuration fails even with `dryRun: true` and even when the asked Region is unknown or absent (validation comes first).
4. A configuration issue whose path holds no setting key (e.g. two Regions with the same name) fails with `Invalid crawl configuration:` and does not throw.
5. Messages never contain input values that are not names: for a configuration with `requestBudget: -3`, the message does not contain `-3`.
6. AC-5: unknown `atlantis` with the default configuration -> `ok: false`, `regionName: 'atlantis'`, message contains `atlantis`, and the AC-1 regex `/\bbelgrade(?:-[a-z0-9-]+)?\b/g` finds exactly `belgrade` and `belgrade-small` (as a set).
7. AC-60: `regionName` absent, `''` and `'   '` -> `ok: false`, no `regionName` key in the result, message equals `usageMessage(['belgrade', 'belgrade-small'])` and contains `CRAWL_COMMAND_OPTIONS.region`, `belgrade` and `belgrade-small`.
8. `knownRegionNames(DEFAULT_CRAWL_CONFIGURATION)` is `['belgrade', 'belgrade-small']` (configuration order).
9. `isMissingApiKey`: `true` for `undefined`, `''`, `'   '`, `' \t '`; `false` for a fake key such as `'fake-key'` and for `' fake '`.

**C. `tests/crawl/report.test.ts`** (`createTally`, `formatSummaryText`, `buildReport`, `failedReport`, `plannedReport`, `formatPlanLines`; AL4 1.3 `Tally`, 1.4.8, AC-10, AC-16, AC-50, AC-51, AC-54)
1. Tally from scratch: `snapshot` with zero gateway counts and zero extras equals `ZERO_RUN_COUNTS`.
2. Tally counting: `pageSaved` adds one listing page, counts the Tile when `tileFinished` is true, adds `createdCount` to `placesNewlyStored`, and counts distinct Place IDs (the same id on two pages, or twice on one page, counts once, AC-16). `detailsSaved(true)`/`(false)` add to `detailsSaved` and only `true` to `detailsChanged`. `itemFailure` appends `{ item, failureKind, message }` to `failures` in order and increments `itemFailures` and the matching `itemFailuresByKind` entry.
3. `snapshot` maps gateway counts: `wikimapiaRequests` = listing + details requests, `rateLimitWaitSeconds` = `rateLimitWaitMs / 1000`, `tilesUnfinished` and `placesStillDue` from `extra`. Every snapshot in these tests passes `RunCountsSchema.parse`.
4. AC-51 numbers: drive a tally to exactly the AC-51 counts (1 listing page with 3 created Places finishing the Tile, 2 changed Details Saves, 1 `wikimapia_error` Item Failure on a `place_details` item, gateway `{ listingRequests: 1, detailsRequests: 4, rateLimitWaits: 1, rateLimitWaitMs: 7000 }`, extras `{ tilesUnfinished: 0, placesStillDue: 1 }`) and compare `toStrictEqual` with those counts.
5. `formatSummaryText` of a summary with Region `test-one`, outcome `completed` and the AC-51 counts: the lines equal exactly the list in AL4 1.4.8 in that order (Region, Run outcome `Completed`, Started at, Ended at, the 14 number lines, then 5 `Item failures (<label>): n` lines in `ItemFailureKindSchema` order), joined by `\n`, no trailing empty line. Every line matches `/^[A-Z][^:{}[\]"]*: \S.*$/`. Without `regionName` the `Region:` line is absent. A non-integer `rateLimitWaitSeconds` (e.g. 1.5) prints as `String(1.5)`.
6. `buildReport` passes `RunReportSchema.parse` for: `completed` with a `runId` and the AC-51 tally's failures; `failed` with a message; `budget_reached` with a message. Its `summaryText` equals `formatSummaryText(summary)`, `itemFailures` equals the given failures, and `plan` is absent for non-planned outcomes. Optional keys (`regionName`, `message`, `runId`) are absent (not `undefined`) when not given.
7. `failedReport('some reason', 'atlantis', at)`: outcome `failed`, message as given, counts `toStrictEqual` `ZERO_RUN_COUNTS`, no `runId` key, `startedAt` = `endedAt` = `at`, `itemFailures` `[]`, passes `RunReportSchema`. With `regionName` undefined the summary has no `regionName` key and the text has no `Region:` line.
8. `plannedReport(planTiles(BELGRADE_SMALL_REGION), at)`: outcome `planned`, `summary.regionName` `belgrade-small`, zero counts (AC-10), `plan` present and equal to the input plan, no `runId`, passes `RunReportSchema`.
9. `formatPlanLines` of the `belgrade-small` plan: 4 lines, the first `Tile 1: west 20.452, south 44.814, east 20.457, north 44.819`.

Use fixed moments such as `RUN_START` from the support file, or literal `MomentSchema` text. The new tests are expected to fail until `add-coder` has finished. Do not stub the production modules.

### 2.2 add-coder

1. **`src/crawl/types.ts`** (new, types only). Declare only what U2 needs, exactly as written in AL4 1.3: `StopReason`, `Stop`, `ResolvedRun`, `Resolution`, `GatewayCounts` (used by `Tally.snapshot`), `Tally`. Import contract types with `import type` from `../../contracts/hydration.schema` (and `../../contracts/wikimapia-client.schema` only if a declared type needs it). Do not declare `Gateway`, `GatewayOptions`, `HeartbeatOutcome`, `RequestKind`, `Requested`, `ClientCall`, `PassCursor` or `RunContext` now (U5/U6 add them). Never re-export contract types.
2. **`src/crawl/tile-plan.ts`** (new, public). Export `planTiles` typed as the contract's `PlanTilesFn`, implementing AL4 1.4.2 literally: `cellsCovering` from the contract for columns and rows; rows south to north, west to east inside a row; first edge = Region edge, last edge = Region edge exactly, inner edges through a private `round9`; fresh `bbox`/`tileSize` copies on the plan. No validation inside (input is a valid Region). Do not re-implement `cellsCovering`.
3. **`src/crawl/config.ts`** (new). Export `resolveRun`, `knownRegionNames`, `usageMessage`, `isMissingApiKey` per AL4 1.3 and 1.4.1, step by step:
   - Parse the request with `CrawlRequestSchema.safeParse`, then build the merged configuration (copy; only overrides present in the parsed request), then `CrawlConfigurationSchema.safeParse`. On failure use the first issue only and build the message with the private `settingMessage` exactly as AL4 1.4.1 states (setting key = first element of `issue.path` that is in `CONFIGURATION_SETTING_KEYS`; Region part only when `path[0] === 'regions'` and that Region's `name` in the merged input is a string).
   - Fallback path text: reuse `formatIssuePath` from `../wikimapia/issues` (unchanged); Zod 4 paths may contain symbols, so convert them to strings first. Use only issue messages and paths, never input values.
   - Then the Region: trim the asked name; empty or absent -> `{ ok: false, message: usageMessage(names) }` without `regionName`; unknown -> the AL4 1.4.1 message with `regionName` set. The message text must contain no other `belgrade-*` word than the configured names.
   - `usageMessage` and the missing-key rule as in AL4 1.4.1 (`CRAWL_COMMAND_OPTIONS.region` in the usage text). The missing-key message text (`Wikimapia API key is missing: set ${API_KEY_ENV}.`) is used by `runCrawl` in U6; you may export it as a constant from `config.ts`, but do not build `runCrawl` logic.
   - Build `ResolvedRun` with `dryRun: r.data.dryRun === true`, `relist: r.data.relist === true`, `plan: planTiles(region)`.
4. **`src/crawl/report.ts`** (new). Export `createTally`, `formatSummaryText`, `buildReport`, `failedReport`, `plannedReport`, `formatPlanLines` per AL4 1.3 and 1.4.8:
   - `createTally`: counters plus a `Set<number>` of listed Place IDs; `failures` is a read-only view in order met; `snapshot` returns a fresh `RunCounts` (start from a copy of `ZERO_RUN_COUNTS`, including a fresh `itemFailuresByKind` object) that satisfies `RunCountsSchema` by construction.
   - `formatSummaryText`: labels only from `SUMMARY_LABELS`, `OUTCOME_LABELS`, `ITEM_FAILURE_LABELS`; per-kind lines in `ItemFailureKindSchema.options` order; numbers with `String(n)`; no other lines; no message inside.
   - `buildReport`: assemble `summary` and the report with conditional spreads for `regionName`, `message`, `runId`, `plan` (`exactOptionalPropertyTypes`; never assign `undefined`). Gate with `RunReportSchema.safeParse`; on failure return `failedReport('Crawl failed: internal error (report check)', regionName, endedAt)`. `failedReport` must not recurse into a failing gate (build it directly from zero counts).
   - `failedReport` and `plannedReport`: zero counts, `startedAt = endedAt = at`, no `runId`; `plannedReport` uses `plan.regionName` and includes `plan`.
   - `formatPlanLines`: `Tile <n>: west <w>, south <s>, east <e>, north <n>`, one per Tile, numbers with `String`.
5. No module of this unit reads a clock, the environment, the file system, the network or the database. No `console`. Types used across modules go in `types.ts`; module-private helpers may be plain functions.
6. Do not change `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `src/db/`, `src/wikimapia/`, or `scripts/`.
7. **Stop and report, do not work around:** stop if AL4 1.4.2 does not reproduce `T2_TILES`/`T4_TILES` exactly or `findTilePlanIssues` reports issues for `belgrade`; if a contract type (`PlanTilesFn`, `RunReportSchema`, `RunCountsSchema`) cannot be satisfied as AL4 describes; or if an AC-6 case cannot name its key with the AL4 1.4.1 rule.
8. Run every Done-when check in 2.3, in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. No database is needed for checks 1 and 3 to 5; check 2 uses the Test Database (`pnpm db:up`, `.env.test`).

1. `pnpm exec vitest run --no-color tests/crawl/tile-plan.test.ts tests/crawl/config.test.ts tests/crawl/report.test.ts contracts/hydration.schema.test.ts` passes: no failures, no skipped or todo tests.
2. Regression: `pnpm exec vitest run --no-color tests/db tests/wikimapia contracts/storage.test.ts contracts/storage.schema.test.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` passes.
3. `pnpm exec eslint src/crawl tests/crawl` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly 3 errors, all TS2307 in `contracts/hydration.test.ts`, for `src/crawl/command`, `src/crawl/run-crawl` and `src/db/crawl-store`. The `src/crawl/tile-plan` error is gone. `pnpm lint` reports problems only in `contracts/hydration.test.ts`, and only those that follow from the same three missing modules.
5. Guards. Each of these returns nothing:
   - `Select-String -Path src/crawl/*.ts -Pattern "console\.|: any|as any|ts-expect-error|eslint-disable|new Date\(|Date\.now|process\.|from 'knex'|from 'pg'|\.js'"`
   - `Select-String -Path src/crawl/*.ts -Pattern "^export (type|interface) " | Where-Object { $_.Path -notmatch 'types\.ts$' }`
   - `Get-ChildItem src/crawl -Name` lists only `types.ts`, `tile-plan.ts`, `config.ts`, `report.ts`.

Do not run `contracts/hydration.test.ts` or `pnpm test:db` as a gate. The contract file cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/fixtures/` and the `*.support.ts` files).
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any contract test, and do not copy or redefine contract schemas, constants or helpers (`cellsCovering`, `findTilePlanIssues`, `toMoment`, labels) in `src/` or `tests/`.
- Files you may create: the 7 files listed in AL4 U2 "Files". Nothing else in `src/`, `tests/`, `scripts/`, `package.json` or config files.
- Never open, write or print `.env`. Never put a real API key, password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, anything under `src/wikimapia/` or `src/db/`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U3:** crawl row schemas, `src/db/types.ts` crawl types, validators, `places-due.ts`, `crawl-progress.ts` reads, `crawl-store.ts`.
- **U4:** `beginRunStep` and the other write steps, `crawl-repository.ts`, `writeListingPage`.
- **U5:** `gateway.ts`, `requests.ts`, `runtime.ts` and their types (`Gateway`, `GatewayOptions`, `HeartbeatOutcome`, `RequestKind`, `Requested`, `ClientCall`), `WAIT_CHUNK_MS`, `RENEW_AFTER_MS`.
- **U6:** `listing-phase.ts`, `details-phase.ts`, `run-crawl.ts`, `PassCursor`, `RunContext`, progress lines, the Run-wide write hook, the API-key check inside the Run, `placesStillDue` computation.
- **U7:** `command.ts` (`parseCrawlArgs`, `runCrawlCommand`, the `Region <name>: <n> tiles` line), `scripts/crawl.ts`, `package.json` scripts, making `contracts/hydration.test.ts` green.
- Recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator does this).
