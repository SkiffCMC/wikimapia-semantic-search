# AL3 Routing: hybrid-search, U5 "Search Command" (corrective, AL4 revision 4)

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **Unit:** U5 of 5, **attempt 2: corrective run for AL4 revision 4**. U5 was implemented and green under revision 3. This run covers only the "Revision 4 delta" named in AL4 U5 "Scope".
- **Bug (AL1):** `pnpm search ...` is pnpm's own npm registry search and never reaches the project's `search` script. The documented form is now `pnpm run search "<Query Text>" [options]` (`SEARCH_COMMAND_FORM`).
- **AL4 source:** `docs/al4-design/20261027-hybrid-search-al4.md` (**revision 4**): header entry "Revision 4", section 0 (first paragraph and "Current red state ... Revision 4 red state"), 0.1 row "Search command", 1.4.6 paragraph "Usage line (revision 4 ...)", 1.4.7 (the `scripts/search.ts` paragraph, the `package.json` paragraph and "AC-72 test placement"), section 5 bullets "Imports" and "Command form (rule 13)", and **U5 in full**.
- **AL6 source (background only):** `docs/al6-requirements/20261027-hybrid-search-al6.md` (revision 4): decision Q11 and its follow-up (section 6), rule 13, AC-44 and AC-72 (section 3.6), and the section 5 note on AC-72.
- **AL5 sources:** `contracts/hybrid-search.schema.ts` (`SEARCH_COMMAND_FORM`, `SEARCH_COMMAND_OPTIONS`, `SEARCH_USAGE_PREFIX`, `isSearchUsageLine`), `contracts/hybrid-search.test.ts` (AC-44 asserts `isSearchUsageLine`), `contracts/hybrid-search.schema.test.ts` (green, stays green), `contracts/hybrid-search.command.test.ts` (**new**, AC-72).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- `src/search/{args,output,command,types}.ts`, `scripts/search.ts`, `package.json` (`search` script, extended `test:db`) and `tests/search/{args,output,command.db}.test.ts` exist and satisfy revision 3.
- **Current red:** both cases of `contracts/hybrid-search.command.test.ts` (AC-72) and the 8 AC-44 cases of `contracts/hybrid-search.test.ts` fail, and they fail **only** on `isSearchUsageLine`. The cause is that `usageLine()` in `src/search/args.ts` still prints `Usage: pnpm run search "<query text>" ...`, with the lower-case placeholder that has no `[options]` after it. `tests/search/args.test.ts` (test "usageLine() is the AL4 usage text ...") pins that old text. `scripts/search.ts` line 2 still documents `pnpm search "<query text>" [options]`.
- Everything else is green: tsc, lint and every other test.
- **Test Database:** up (`pnpm db:up`). `.env.test` provides `TEST_DATABASE_URL`, loaded by `vitest.config.ts`. DB tests get it only through `requireTestDatabaseUrl()`.

## 1. Context Manifest

Read these files and no others. Follow `.agrules` (sections 0, 4 and 5) and the stack in `CLAUDE.md`: Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Zod 4, Vitest with globals, ESLint `strictTypeChecked`, pnpm. Use extensionless relative imports and `import type` for types.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules: section 0 (bugs are fixed below a contract, never in it), 4 (no live calls, no secrets), 5 (code style). |
| 2 | `CLAUDE.md` | Stack and the "Embed run" decision (`.env` loading: the shell wins). Read only. Do not edit it. |
| 3 | `docs/al4-design/20261027-hybrid-search-al4.md` | Read only. Read the sections listed under "AL4 source" above. Do not read 1.2 to 1.4.5, 1.4.8 to 1.4.11, or U1 to U4. |
| 4 | `docs/al6-requirements/20261027-hybrid-search-al6.md` | Background only: rule 13, AC-44, AC-72, Q11. |
| 5 | `contracts/hybrid-search.schema.ts` | `SEARCH_COMMAND_FORM` (~line 102), the Search Command block ~575-621 (`SEARCH_COMMAND_OPTIONS`, `SEARCH_USAGE_PREFIX`, `isSearchUsageLine`). |
| 6 | `contracts/hybrid-search.command.test.ts` | AC-72 target: it spawns real `pnpm run search --fast` / `-- --fast` with the network blocked. Read it to understand it. Do not edit it. |
| 7 | `contracts/hybrid-search.test.ts` | ~1010-1035 (AC-44 cases, `output.some(isSearchUsageLine)`). Do not edit it. |
| 8 | `src/search/args.ts` | Coder changes `usageLine()`, its doc comment and the import line. Test writer reads it. |
| 9 | `scripts/search.ts` | Coder changes the header doc comment only. |
| 10 | `tests/search/args.test.ts` | The test writer revises it: imports, plus the usage-line test at the end of the file. |
| 11 | `tests/search/command.db.test.ts` | The test writer revises the "a usage error: ..." test (~173-182) and its imports. |
| 12 | `package.json` | Read only, to confirm the `search` script (`tsx scripts/search.ts`) and `test:db`. Revision 4 does not change it. |

## 2. Execution Directives

### 2.1 add-test-writer

Change only the two files below (AL4 U5 "Unit tests must cover", the revision 4 parts). Import every constant and helper from `contracts/hybrid-search.schema`. Never hand-write `pnpm run search` or `"<Query Text>"`; build the expected text from `SEARCH_COMMAND_FORM` and `SEARCH_COMMAND_OPTIONS`. Leave every other test in these files unchanged.

**`tests/search/args.test.ts`:** replace the old usage-line test, which pins `"<query text>"`, with tests that pin the following (AL4 1.4.6 "Usage line", U5):
1. `isSearchUsageLine(usageLine())` is true.
2. `usageLine()` starts with `SEARCH_USAGE_PREFIX` and with `` `Usage: ${SEARCH_COMMAND_FORM}` ``.
3. `usageLine()` equals the literal result in 1.4.6. Build the expected value in the test from `SEARCH_COMMAND_FORM` and the `SEARCH_COMMAND_OPTIONS` names: `Usage: <FORM> where options are [<near> <lat>,<lon> <radius> <metres> | <bbox> <south>,<west>,<north>,<east>] [<tag> <title>]... [<limit> <n>] [<approximate>]`.
4. `usageLine()` does not contain `pnpm search `. Spelling out `pnpm search ` in this negative assertion is the only allowed use of it under `tests/`. The line also contains no `\n` and no `\r`, and has no trailing whitespace (`usageLine() === usageLine().trimEnd()`).
5. The two AC-72 argv shapes are usage problems: `parseSearchArgs(['--fast'])` and `parseSearchArgs(['--', '--fast'])` each give `{ ok: false }` with a non-empty `problem`.
Remove the `SEARCH_USAGE_PREFIX` import only if it ends up unused. Under these tests it stays in use.

**`tests/search/command.db.test.ts`:** in the "a usage error: problem line, usage line, no request, no outcome, no service call" test, keep every existing assertion, including `output[1]?.startsWith(SEARCH_USAGE_PREFIX)`, which now checks the new prefix. Add an assertion that `output[1]` passes `isSearchUsageLine` (handle the `undefined` from `noUncheckedIndexedAccess` without a non-null assertion). The 0 service calls assertion stays. Do not add a spawn test: AC-72 is covered only by the contract file (U5).

**Expected red state at handover:** the new usage-line assertions in `args.test.ts` and the new assertion in `command.db.test.ts` fail. The AC-72 argv-shape test passes already. All other tests are as they were in section 0. Do not touch `src/`, `scripts/`, `package.json` or `contracts/`. Both files must be lint-clean (`pnpm exec eslint tests/search`).

### 2.2 add-coder

Make the tests of 2.1, all of `contracts/hybrid-search.test.ts` and all of `contracts/hybrid-search.command.test.ts` green. **Do not edit any test file.**

1. **`src/search/args.ts`, `usageLine()`:** rebuild it exactly as the 1.4.6 "Usage line" pseudocode: `Usage: ${SEARCH_COMMAND_FORM} where options are ` followed by the option list built from `SEARCH_COMMAND_OPTIONS` (it already uses the destructured `near`, `radius`, `bbox`, `tag`, `limit`, `approximate`). The result must be one line with no trailing whitespace. Do not write `pnpm run search` or `pnpm search` as a string literal in code.
2. **`src/search/args.ts`, imports:** import `SEARCH_COMMAND_FORM` from `../../contracts/hybrid-search.schema`. Drop `SEARCH_USAGE_PREFIX` from the import because it becomes unused (lint).
3. **`src/search/args.ts`, doc comment of `usageLine()`:** state that the line passes `isSearchUsageLine`, starts with `Usage: ` followed by `SEARCH_COMMAND_FORM`, and is followed by the option list (rule 13, AC-44, AC-72). Comments may name the form `pnpm run search "<Query Text>" [options]`, but never `pnpm search`.
4. **`scripts/search.ts`, header doc comment:** it starts with the documented form `pnpm run search "<Query Text>" [options]` and may add that `pnpm run search -- <args>` works too (1.4.7). Leave the rest of the comment and all code unchanged. Add no start-up work (fetch, version check) before the parse (1.4.7 "AC-72 test placement").
5. **No other file changes.** `parseSearchArgs`, `output.ts`, `command.ts`, `types.ts`, `package.json`, U1 to U4 code and every test file stay as they are. If a contract case still fails for a reason outside `usageLine()` or the script comment, stop and report to the orchestrator. Do not widen the change.
6. Run the "Done when" checks (2.3) and fix the code until they pass.

### 2.3 Done when

Precondition: the Test Database is up (`pnpm db:up`) and `.env.test` exists. All of the following must hold:

- `pnpm exec vitest run --no-color contracts/hybrid-search.test.ts contracts/hybrid-search.schema.test.ts contracts/hybrid-search.command.test.ts` passes. Every case must be green and none skipped, including the 8 AC-44 cases and both AC-72 cases. Each AC-72 case may take up to 90 s.
- `pnpm exec vitest run --no-color tests/search` passes.
- `pnpm exec vitest run --no-color` passes. This is the whole suite: `contracts/` and `tests/`, including the AC-72 file.
- `pnpm exec tsc --noEmit` reports **0 errors**.
- `pnpm lint` reports **0 problems**.
- **Manual checks**, from the project root under `tsx`, always in the documented form:
  - `pnpm run search --fast` and `pnpm run search -- --fast` each print a line starting with `Usage: pnpm run search "<Query Text>" [options]` and exit non-zero. Neither prints npm registry output.
  - `pnpm run search "museum" --near 44.817,20.457` exits non-zero with a usage message.
  - `pnpm run search "museum"` with `VOYAGE_API_KEY` unset: **skip this check and report it as skipped.** `.env` exists, and `applyEnvDefaults` fills an unset (or empty) shell variable from it. The agents may not open, print, grep or edit `.env`, so they cannot rule out that this command gets past the key check and makes a live Voyage call. `tests/search/command.db.test.ts` (AC-45) and the contract cover the missing-key path.
  - **Never run `pnpm search ...`** in any form. It is an npm registry search and makes a network call.
- **Grep checks:** search `src/`, `scripts/` and `package.json` with the Grep tool. None of them may contain `pnpm search`. Under `tests/`, `pnpm search` may occur only in the negative assertion of 2.1 item 4. The code of `src/search/args.ts` has no `pnpm run search` string literal (comments may name the form), and `SEARCH_COMMAND_FORM` is imported there. `scripts/search.ts` line 2 shows `pnpm run search "<Query Text>" [options]`.

## 3. Boundary Enforcement (The Iron Rule)

- Do NOT modify anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/` (including `contracts/hybrid-search.command.test.ts`, the support files and `contracts/fixtures/`). Also leave `CLAUDE.md`, `.agrules`, `.env*`, `package.json`, `vitest.config.ts`, `eslint.config.js` and `tsconfig.json` unchanged.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Never skip a contract test, never use `.only` on one, and never loosen it. If a contract test or the AL4 spec looks wrong or contradictory, stop and report to the orchestrator instead of working around it (`.agrules` section 0).
- Do not add a pnpm version pin or check, a second AC-72 spawn test, or a rename of the `search` script (Q11 and its follow-up).
- No live Voyage, Anthropic or Wikimapia call, no real key, and no reading of `.env`.

## 4. Out of Scope

- Everything else in U5 that is already done and green: `parseSearchArgs` rules, `output.ts`, `runSearchCommand`, the script's code, `package.json` (`search`, `test:db`), and `tests/search/output.test.ts`.
- U1 to U4 (query adapter, embedding step, search statement, both modes, D-EF, the search store, `searchPlaces`) and their tests.
- Adding `contracts/hybrid-search.command.test.ts` to `test:db` (AL4 1.4.7: it needs no database and runs through the default include).
- Recording the 0.1 "Search command" decision in `CLAUDE.md`. That is the orchestrator's job.
- Not part of this feature: HTTP endpoint or framework, LLM intent parsing and reranking, MCP, extra command options or JSON output.
