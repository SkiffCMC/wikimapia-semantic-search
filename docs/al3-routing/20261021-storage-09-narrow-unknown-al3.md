# AL3 Routing: storage, corrective unit U9 "Narrow `unknown`"

- **Feature:** `storage` (Stage 1, substep 2)
- **Unit:** U9, corrective (attempt 1). It narrows `unknown` and changes **no behaviour**. U1 to U8 are done and green.
- **AL4 source:** `docs/al4-design/20261021-storage-al4.md`, revision 2026-10-22. The work list is section 4, paragraph "Refactor note (2026-10-22, narrow `unknown`, `.agrules` section 5)", with its 49-row inventory table and the "Totals" paragraph after it, plus the unit block "U9. Corrective: narrow `unknown` (refactor, no behaviour change)". The target design is in section 1.3 (the `types.ts` block from "Column maps (U9)" to `ShapesCandidate`, the `Writer` block, the `mappers.ts`, `plan.ts`, `save-listing.ts / save-details.ts` and `place-store.ts` blocks, and the last comment line about `readShapesValue`), section 2.2 (paragraph "Objection"), section 2.3 (paragraph "Objection"), section 2.4 (paragraph "Objection") and section 5 (all bullets, especially "No `unknown` stand-ins").
- **Audience:** `add-test-writer` (one typing edit only, see 2.1), then `add-coder`
- **Status:** Routing to AL2 Agents

## 0. Starting state (verified before routing)

- **Baseline, verified by the orchestrator** (docker test DB running): `pnpm exec vitest run --no-color` gives **24 test files, 1184 tests, all passed**. `pnpm exec tsc --noEmit` gives 0 errors. `pnpm lint` gives 0 problems. After U9 the suite must still show exactly 24 files and 1184 passed tests, with no failed, skipped or todo tests.
- `grep -n unknown src/db/*.ts src/db/migrations/*.ts scripts/*.ts` currently matches **49 lines**, the same lines as the AL4 inventory: `failures.ts` 40, 44, 49, 54, 62; `validate.ts` 25, 37, 47, 56, 70, 82, 86; `schema-setup.ts` 28, 65, 75; `inspect.ts` 20, 39, 54; `connection.ts` 27, 60; `read.ts` 115, 135, 147, 182, 186, 195, 207, 219, 241, 274; `mappers.ts` 40, 55, 95; `plan.ts` 46, 47; `save-listing.ts` 18; `save-details.ts` 23, 51; `writer.ts` 13; `types.ts` 52; `place-store.ts` 72, 76, 91, 113, 120, 127, 137, 144, 151. `scripts/` and `src/db/migrations/` have none.
- The only test line that U9's narrowed types break is `tests/db/mappers.test.ts` line 322 (`columns[key]` inside the AC-24 test, loop key list at lines 311 to 320). It indexes the `detailsColumns` result with a `string`. No other test indexes a column map with a computed key. Other tests (`plan.test.ts` lines 76 to 98, the rest of `mappers.test.ts`) only spread the maps or read named properties, so they compile as they are.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style from `.agrules` and `CLAUDE.md`:

- Node ESM and TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Zod 4, Vitest with globals, pnpm, ESLint `strictTypeChecked`.
- Relative imports have no file extension.
- Use top-level `import type`.
- Every `type` or `interface` declared in `src/db/` lives in `src/db/types.ts`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Section 5, bullet "`unknown` Only for Truly Unknown Values", is what this unit implements. Section 4 "Strict Types Only" also applies. |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261021-storage-al4.md` | Read only the parts named in the header: section 0 paragraph "Code style", section 1.3, sections 2.2 to 2.4 (the "Objection" paragraphs), section 4 (refactor note, table, "Totals", "U9") and section 5. |
| 4 | `src/db/types.ts` | To modify. Add the U9 types. `Writer.run` (line 52) stays. |
| 5 | `src/db/models.ts` | To modify. `PlaceModel.details_fetched_at` (line 40), `CommentModel.presence` (line 78), `PlaceTagModel.presence` (line 106). |
| 6 | `src/db/mappers.ts` | To modify. Rows 31 to 33 and 38. |
| 7 | `src/db/plan.ts` | To modify. Rows 34 and 35 (`columnsDiffer`, lines 45 to 51). |
| 8 | `src/db/save-listing.ts` | To modify. Row 36 (`statementFor`, lines 18 to 42, and its caller at line 60). |
| 9 | `src/db/save-details.ts` | To modify. Rows 37 and 38 (`placeStatement`, lines 19 to 48; the local `commentPatchColumns`, lines 50 to 57; the callers at lines 73 and 121). |
| 10 | `src/db/read.ts` | To modify. Row 25 (`readShapesValue`, lines 178 to 204). Nothing else in this file changes. |
| 11 | `src/db/place-store.ts` | To modify. Rows 44 to 49 (lines 113, 120, 127, 137, 144, 151). Rows 41 to 43 (lines 72, 76, 91) stay. |
| 12 | `src/db/rows.ts` | **Read only.** `PlaceRowSchema` and `CommentRowSchema` define the types that `SummaryColumns`, `DetailsColumns` and `CommentColumns` are built from. |
| 13 | `src/db/writer.ts` | **Read only.** `run(statement: PromiseLike<unknown>)` stays (row 39). |
| 14 | `contracts/storage.schema.ts` | **Read only.** `Presence` (line 94), `SaveListingPageInput` (150), `SavePlaceDetailsInput` (214), `PlaceRefInput` (218), `TagRefInput` (221), `ReadShapesValueSchema` (404). |
| 15 | `contracts/wikimapia-client.schema.ts` | **Read only.** `Point`, used by `ShapesCandidate`. |
| 16 | `tests/db/mappers.test.ts` | add-test-writer edits lines 311 to 320 only (2.1). add-coder reads it only. |
| 17 | `scripts/db-status.ts` | **Read only.** Used by the Done-when check that `tsx` still loads `src/db`. |
| 18 | `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | Read only. Do not edit them. |

Do not read the AL6 document, the fixtures or `src/wikimapia/`. **Never open, print, copy, rewrite or delete `.env`.** It holds the user's Wikimapia API key. The tests get `TEST_DATABASE_URL` through `.env.test` and `vitest.config.ts`. `pnpm db:status --test` reads `.env.test` by itself. Do not open `.env.test` either.

## 2. Execution Directives

### 2.1 add-test-writer: one typing edit, no assertion changes

AL4 U9 lists a single test edit. Make it and nothing else:

- In `tests/db/mappers.test.ts`, test "keeps every optional key present with null when the item is absent (AC-24)", add `as const` to the array literal of the `for (const key of [...])` loop (lines 311 to 320). Then `key` is a key of `DetailsColumns`, and `columns[key]` on line 322 type-checks against the narrowed return type of `detailsColumns`.
- Keep the eight keys, their order, both `expect` lines and every other line of the file as they are. Do not add tests and do not add `expectTypeOf` checks. AL4 marks them optional, but the test count must stay exactly 1184.
- Before add-coder runs, this edit compiles and passes too, because `as const` only narrows the key type. Run `pnpm exec vitest run --no-color tests/db/mappers.test.ts` and report the pass count. It must not change.
- Leave every other `unknown` in `tests/` alone (AL4: `tests/` is outside the inventory).

### 2.2 add-coder (files and steps)

Work through the AL4 section 4 table. Fix exactly the **15 NARROW rows** (25, 31 to 38, 44 to 49) and the supporting model typing from the "Totals" paragraph. Do not touch the **34 KEEP rows**, neither their code nor their Zod schemas. Only their line numbers may move.

0. **Before you edit,** run the full suite, `tsc` and `pnpm lint` once (2.3 commands 1 to 3) and confirm the baseline from section 0 (24 files, 1184 passed, 0 errors, 0 problems). If it differs, stop and report it.
1. **`src/db/types.ts`.** Add `ColumnValue`, `SummaryColumns`, `DetailsColumns`, `CommentColumns`, `CommentPatchColumns` and `ShapesCandidate` exactly as in the AL4 1.3 `types.ts` block, with short doc comments. Add `Point` to the existing `import type` from `'../../contracts/wikimapia-client.schema'`. Keep `Writer.run(statement: PromiseLike<unknown>)` (row 40, KEEP). You may extend its doc comment to say the resolved value is discarded, but do not use the word "unknown" in any new comment (see 2.3, command 5). No runtime code, no re-exported contract types.
2. **`src/db/models.ts`** (AL4 2.2 to 2.4 "Objection"; "Totals" paragraph). Change `PlaceModel.details_fetched_at` to `string | Date | null`. Type `CommentModel.presence` and `PlaceTagModel.presence` with the contract `Presence`, imported through a top-level `import type { Presence } from '../../contracts/storage.schema'`. Nothing else changes (statics, relations, other columns).
3. **`src/db/mappers.ts`** (rows 31 to 33 and 38).
   - `summaryColumns` returns `SummaryColumns`. `detailsColumns` returns `DetailsColumns`. Keep the bodies, the keys, their order and the values.
   - Add the exported `commentPatchColumns(flat: FlatComment): CommentPatchColumns`. It returns the 15 non-key columns in today's order: `parent_num`, `lang_id`, `author`, `author_user_id`, `author_photo_url`, `message`, `good_votes`, `bad_votes`, `is_blocked`, `is_deleted`, `posted_at_epoch_seconds`, `moderator_user_id`, `moderator_name`, `presence: 'present'`, `position`. The values are the ones in today's `commentColumns`.
   - `commentColumns(placeId, flat): CommentColumns` becomes `{ place_id: placeId, num: flat.comment.num, ...commentPatchColumns(flat) }`. The key order and values are the same as today, which `tests/db/mappers.test.ts` checks with `toStrictEqual`.
   - Add the new types to the existing `import type { ... } from './types'`.
4. **`src/db/plan.ts`** (rows 34 and 35). Retype the private `columnsDiffer` to `columns: Readonly<Record<string, ColumnValue>>`, `row: Readonly<Partial<Record<string, ColumnValue>>>`, `skip: ReadonlySet<string>`. Keep the body and every caller as they are: the callers pass `SummaryColumns`, `DetailsColumns` or `CommentColumns`, and `PlaceRow` or `CommentRow`. `OUTLINE_ONLY`, `DETAILS_SKIP` and `NO_SKIP` stay. Import `ColumnValue` through `import type`.
5. **`src/db/save-listing.ts`** (row 36). Replace `statementFor(trx, write): PromiseLike<unknown>` with the private `async function runListingWrite(writer: Writer, trx: Knex.Transaction, write: ListingWrite): Promise<void>`. Each `switch` case does one `await writer.run(<the same builder as today>)` and then `return`. The loop in `saveListing` becomes `await runListingWrite(writer, trx, write)`. The statements, their order and the write count stay the same. Import `Writer` through `import type`.
6. **`src/db/save-details.ts`** (rows 37 and 38).
   - Replace `placeStatement(...): PromiseLike<unknown>` with the private `async function runPlaceWrite(writer: Writer, trx: Knex.Transaction, input: SavePlaceDetailsInput, write: PlaceDetailsWrite): Promise<void>` in the same pattern as step 5. The caller becomes `await runPlaceWrite(writer, trx, input, plan.place)` inside the existing `if (plan.place !== undefined)`.
   - Keep the `update_fetched_at` case on the **same Knex builder** (`trx(STORE_TABLES.places).where(...).update({ details_fetched_at: fetchedAt })`). Update only its comment, which currently says the model declares `Date`. For example, say that only this one column is written and that the builder is unchanged from U7.
   - Delete the local `commentPatchColumns` (lines 50 to 57). Import `commentPatchColumns` from `./mappers` and call it as `commentPatchColumns(write.flat)` in the comment update branch.
   - Drop the `FlatComment` import if nothing uses it any more. All other writes (tags, links, gone marks, comment inserts) stay as they are.
7. **`src/db/read.ts`** (row 25). In `readShapesValue`, type `shapes` as `ShapesCandidate`, built as `{ placeId, centrePoint: { ... } }` with the same values. Set `shapes.outlineShape = { type, srid, ring }` only inside the existing `if (row.outline_type !== null)`, and never assign `undefined` (`exactOptionalPropertyTypes`). The gate `ReadShapesValueSchema.parse({ found: true, shapes })` stays. So do both queries and both `const ...: unknown` lines (rows 24 and 26, KEEP). Import `ShapesCandidate` through `import type`.
8. **`src/db/place-store.ts`** (rows 44 to 49). In `buildStore`, type the parameters as `page: SaveListingPageInput` for `saveListingPage`, `input: SavePlaceDetailsInput` for `savePlaceDetails`, `input: PlaceRefInput` for `readPlace`, `listStoredComments` and `readPlaceShapes`, and `input: TagRefInput` for `listPlaceTagLinks`. Add the four types to the existing contract `import type`. **Keep every validator call** (`validateListingInput(page)` and so on), because callers can bypass the types (AC-53 passes `undefined`). Keep `saveFailure`, `readFailure` and `guarded` with `(error: unknown)` (rows 41 to 43, KEEP).
9. **Stop rule (binding, AL4 U9 "Rules for the change").**
   - Add no `as` type assertion (`as const` included) and no non-null assertion `!` anywhere in `src/db`.
   - Add no `any`, `@ts-expect-error`, `@ts-ignore` or `eslint-disable` comment.
   - Do not widen a type back to `unknown`, `Record<string, unknown>` or `PromiseLike<unknown>`.
   - If a narrowing does not type-check or lint without one of these, **stop and report** the file, the line, the exact `tsc` or ESLint message and the narrowing you tried. Examples: `SummaryColumns` or `DetailsColumns` spread into `PlaceModel.query(trx).insert/patch`, `CommentColumns` into `CommentModel.query(trx).insert`, `PlaceRow` passed to `columnsDiffer`. Do not invent a workaround and do not change the AL4 types.
10. **Behaviour preservation.** Keep the same SQL statements, statement order and write count per save, the same mapper keys and values, and the same failure messages. If any test changes outcome, the refactor is wrong: fix the `src/db` code, never the test.
11. Run every Done-when check (2.3) and report each result with its exit code. Report the test file and test counts, and the per-file `unknown` counts.

**Scope:** add-coder modifies only `src/db/types.ts`, `src/db/models.ts`, `src/db/mappers.ts`, `src/db/plan.ts`, `src/db/save-listing.ts`, `src/db/save-details.ts`, `src/db/read.ts` and `src/db/place-store.ts`. add-test-writer modifies only `tests/db/mappers.test.ts` lines 311 to 320. Nothing else changes, including `failures.ts`, `validate.ts`, `schema-setup.ts`, `inspect.ts`, `connection.ts`, `writer.ts`, `rows.ts`, `geometry.ts`, the migrations, `scripts/` and all other tests.

### 2.3 Done when

Run every command from `D:\Programming\wikimapia-semantic-search` in PowerShell. Docker must be up: if `docker compose ps` does not show `postgres` as `healthy`, run `pnpm db:up`. All of the following must hold.

1. **Full suite:** `pnpm exec vitest run --no-color` reports **24 test files and 1184 tests, all passed**, with no failed, skipped or todo tests. This is the same count as the baseline.
2. `pnpm exec tsc --noEmit` reports **0 errors**.
3. `pnpm lint` reports **0 problems**.
4. **AL5 gate, also covered by 1:** `pnpm exec vitest run --no-color contracts/storage.test.ts contracts/storage.schema.test.ts` passes.
5. **The 34 KEEP rows remain.** This command must print **34**:
   ```powershell
   (Select-String -Path src/db/*.ts, src/db/migrations/*.ts, scripts/*.ts -Pattern 'unknown' -CaseSensitive).Count
   ```
   It is the PowerShell equivalent of `grep -n unknown src/db/*.ts src/db/migrations/*.ts scripts/*.ts`; in Bash, `... | wc -l` must print 34. Run the same `Select-String` without `.Count`, then check the per-file distribution: `failures.ts` 5, `validate.ts` 7, `schema-setup.ts` 3, `inspect.ts` 3, `connection.ts` 2, `read.ts` 9, `writer.ts` 1, `types.ts` 1, `place-store.ts` 3. The count for `mappers.ts`, `plan.ts`, `save-listing.ts`, `save-details.ts`, `models.ts`, `migrations/` and `scripts/` is 0. Every match is one of the KEEP rows of the AL4 table, and no match is inside a comment.
6. **Stand-in checks:**
   - `Select-String -Path src/db/*.ts -Pattern 'Record<string, unknown>'` returns exactly one line: `validate.ts`, `isRecord`.
   - `Select-String -Path src/db/*.ts -Pattern 'PromiseLike<unknown>'` returns exactly two lines: `writer.ts` `run` and `types.ts` `Writer.run`.
   - `Select-String -Path src/db/place-store.ts -Pattern ': unknown'` returns exactly the three error mappers (`saveFailure`, `readFailure`, `guarded`).
   - `Select-String -Path src/db/*.ts -Pattern 'statementFor|placeStatement|Object\.fromEntries'` returns nothing.
7. **No new assertions or escapes:** `Select-String -Path src/db/*.ts -Pattern '\bas\s+[A-Za-z{\[(]|!\.|!\)|!;|: any\b|as any|ts-expect-error|ts-ignore|eslint-disable'` returns no code line. Matches inside comments are acceptable, for example "as bindings" in the `read.ts` header. List each comment match in your report and do not edit it.
8. **Types only in `types.ts`:** `Select-String -Path src/db/*.ts -Exclude types.ts -Pattern '^\s*(export\s+)?(type|interface)\s'` returns nothing. `src/db/types.ts` exports `ColumnValue`, `SummaryColumns`, `DetailsColumns`, `CommentColumns`, `CommentPatchColumns` and `ShapesCandidate`.
9. **`tsx` still loads `src/db` (plain Node ESM):** `pnpm db:status --test` exits 0. It lists the four steps `20261021_01_enable_extensions` to `20261021_04_create_comments` as applied, no pending steps, and enabled extensions that include `postgis` and `vector`. Use only the `--test` form. Plain `pnpm db:status` reads `.env`, so do not run it.
10. **Diff scope:** only the eight `src/db` files of 2.2 and `tests/db/mappers.test.ts` changed. In the test file, the only change is the added `as const` on the AC-24 key list.
11. `.env` is unchanged. The orchestrator or the user checks this. AL2 does not open `.env`.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`. That includes `contracts/fixtures/`, `storage.support.ts`, `storage.schema.ts` and every contract test.
- Your code MUST pass the tests and schemas defined in AL5 and the existing unit tests. If the code fails, fix the code, not the contract or the test. Do not skip, weaken or `.todo` any test, do not change any assertion, and do not raise timeouts.
- No narrowing in U9 needs a contract change (AL4 section 4). If one seems to need one, stop and report it.
- Never open, write or print `.env` or `.env.test`. Never put a password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `package.json`, docker files, `scripts/`, anything under `src/wikimapia/`, or any earlier AL3 prompt.

## 4. Out of Scope

- The 34 KEEP rows (`failures.ts`, `validate.ts`, `schema-setup.ts` including `MigrateResultSchema`'s `z.unknown()`, `inspect.ts`, `connection.ts` including `getTypeParser`, the raw-result lines of `read.ts`, `writer.ts`, `Writer.run` in `types.ts`, and the three error mappers in `place-store.ts`). Do not "improve" them.
- Any behaviour change, bug fix, rename or refactor beyond the 15 NARROW rows and the three model property types. That includes SQL text, statement order, the `update_fetched_at` builder, failure messages and the mapper key order.
- `unknown` and `Record<string, unknown>` in `tests/` (outside the AL4 inventory). The optional `expectTypeOf` checks of AL4 U9 are also out (they would change the fixed test count).
- `src/wikimapia/` and its finished corrective unit 07.
- Substeps 3 and 4 (crawl jobs, crawl-progress tables, `pgvector` npm package, embedding columns), any HTTP server, and recording decisions in `CLAUDE.md` (the orchestrator handles that).
