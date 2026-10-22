# AL3 Routing: wikimapia-client, corrective unit 07 "Narrow `unknown`"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** corrective unit 07. It narrows `unknown` and changes **no behaviour**. U1 to U5 and corrective unit 06 are done.
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`. The unit is defined in section 4 "Implementation Units", paragraph "Refactor note (2026-10-22, narrow `unknown`, `.agrules` section 5)", with its inventory table and the paragraphs "Behaviour preservation", "Scope" and "Done when". Its design is in sections 1.3 (the `types.ts` and `client.ts` blocks), 1.4.1 (bullet "Typing of the options") and 1.4.8 (second bullet).
- **Audience:** `add-test-writer` (nothing to do in this unit, see 2.1), then `add-coder` (only `src/wikimapia/types.ts` and `src/wikimapia/client.ts`)
- **Status:** Routing to AL2 Agents

**Baseline (not run at routing time).** The router could not run commands in this step, so there is no recorded pass count yet. Before you edit anything, add-coder MUST run the baseline command in 2.3 and write down the number of passing tests. That number is the reference for "same number of passing tests" (AL4 section 4 "Done when" sets no hard count). The current `grep -n unknown src/wikimapia/*.ts` matches the AL4 inventory exactly: 11 lines, 14 occurrences, in `types.ts:32`, `interpret.ts:21,23`, `execute.ts:38,40,42,46,61` and `client.ts:39,41,44,45`.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style they define: Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, pnpm, ESLint `strictTypeChecked`. Use extensionless relative imports and put types in `types.ts` (`.agrules` section 5, unit 06).

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Section 5, bullet "`unknown` Only for Truly Unknown Values", is what this unit implements. Section 4 "Strict Types Only" also applies. |
| 2 | `CLAUDE.md` | Stack and project conventions. |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | Read only these parts: "0. Scope and Fixed Points" (paragraph "Code style", bullet on `unknown`); "1.1 Module map" (the `types.ts` row); "1.3 Component contracts" (the `types.ts` block, the `client.ts` block and the paragraph after the code block); "1.4.1 Configuration" (all bullets, especially "Typing of the options"); "1.4.8 Transport and failure mapping" (second bullet); "4. Implementation Units" (only the 2026-10-22 refactor note, its table, and the paragraphs "Behaviour preservation", "Scope" and "Done when"); "5. AL2 Guidance" (bullets 2, 3 and 5). |
| 4 | `src/wikimapia/types.ts` | To modify. `TransportOutcome` (line 32) has `response: unknown`. `UncheckedOptions` does not exist yet. |
| 5 | `src/wikimapia/client.ts` | To modify. Contains `CONFIG_FIELDS`, `readOption`, `resolveConfig(options: unknown)`, `Record<string, unknown>` and three `as` assertions (lines 36, 41, 66, 67). |
| 6 | `src/wikimapia/execute.ts` | **Read only.** `callTransport` already annotates `const response: TransportResponse` (line 59), and `TransportResponseSchema.safeParse(outcome.response)` (line 75) stays. Read it to confirm that narrowing `TransportOutcome` compiles with no edit here. |
| 7 | `contracts/wikimapia-client.schema.ts` | **Read only.** Read these declarations: `ClientConfigSchema` / `ClientConfig` (lines 70 to 77), `TransportResponse` and `WikimapiaTransport` (lines 83 to 94), `WikimapiaClientOptions` (line 101), `CreateWikimapiaClientFn` (line 445). |
| 8 | `tests/wikimapia/client.test.ts` | **Read only.** These tests pin the behaviour that must be kept: `setupRaw` (lines 121 to 131), describe "configuration failure (AC-31, 1.4.1)" (lines 256 to 316, including the `apiKey: 987654321` case), describe "factory robustness (1.4.1)" (lines 331 to 349, `null` and `undefined` options), and describe "only the four data fields are validated (1.4.1)" (lines 355 to 404: an extra key is ignored; explicit `undefined` for `language`, `retryLimit` and `fallbackWaitSeconds`). |
| 9 | `tsconfig.json`, `eslint.config.js` | Compiler and lint settings. Read them; do not edit them. |

Do not read the AL6 document, the fixtures, the other `src/wikimapia/*` modules or anything under `src/db/`.

## 2. Execution Directives

### 2.1 add-test-writer: nothing to do

The unit changes no behaviour, and AL4 section 4 "Scope" says: "No test file is edited." The existing tests in `tests/wikimapia/client.test.ts` already pin the behaviour this unit must keep: `null`/`undefined` options, `{}`, an `apiKey` of the wrong type, explicit `undefined` fields, an ignored extra key, the configuration message and redaction. They pass through `as unknown as WikimapiaClientOptions` casts, so the narrowed source signatures do not affect how the tests compile. **Write no tests, edit no file.** Hand off straight to add-coder and state "no test changes required for unit 07". The `unknown` uses in `tests/wikimapia/*.ts` (for example `setupRaw(rawOptions: Record<string, unknown>)` and `variants: [string, unknown][]`) are out of scope (section 4 below).

### 2.2 add-coder (only `src/wikimapia/types.ts` and `src/wikimapia/client.ts`)

0. **Baseline first.** Run the baseline command in 2.3 and record the pass count. Also record the current outputs of `pnpm exec tsc --noEmit` and `pnpm lint`. Then edit.
1. **`types.ts`: narrow `TransportOutcome`** (AL4 section 4 table row 1, 1.4.8). Change `response: unknown` to `response: TransportResponse`. Keep `error: unknown` (row 2). Add `TransportResponse` to the existing top-level `import type` from `'../../contracts/wikimapia-client.schema'`.
2. **`types.ts`: add `UncheckedOptions`** exactly as in the AL4 1.3 `types.ts` block (`Partial<WikimapiaClientOptions> | null | undefined`, with its doc comment saying it is used by `client.ts` only, unit 07). Add `WikimapiaClientOptions` to the same `import type`. Update the file header comment only if it needs to mention unit 07. `types.ts` stays types-only and re-exports no contract type.
3. **`client.ts`: remove the old machinery** (rows 5 to 9). Delete `CONFIG_FIELDS`, `readOption`, the `Record<string, unknown>` object, the field loop and the two `as WikimapiaTransport | undefined` / `as Clock | undefined` assertions.
4. **`client.ts`: add the private `configCandidate(source: UncheckedOptions): Partial<ClientConfig>`** with the signature from AL4 1.3, built as AL4 1.4.1 "Typing of the options" describes: return an empty object for `null` or `undefined`. Otherwise copy `apiKey`, `language`, `retryLimit` and `fallbackWaitSeconds` with one conditional spread each, leaving out any field whose value is `undefined`. No loop over a key list, no `Record<…>`, no `as`. The parameter type is what lets the `null` check pass `no-unnecessary-condition`. Do not reintroduce the wider type through a `const x: UncheckedOptions = options` assignment (AL4 section 5, bullet 3).
5. **`client.ts`: retype `resolveConfig(options: WikimapiaClientOptions): Resolved`** (row 8). Get the candidate from `configCandidate(options)` (row 9) and pass it to `ClientConfigSchema.safeParse`. On failure, take the redaction key from the candidate with a `typeof … === 'string'` check followed by `.trim()`, otherwise `''`, exactly as 1.4.1 says. On success, read `options.transport` and `options.clock` as typed property accesses, **only after** the successful parse. Keep everything else the same: the defaults, `config.*` values, failure construction and messages. `createWikimapiaClient(options: WikimapiaClientOptions)` keeps its signature.
6. **`client.ts`: imports.** Add `type ClientConfig` to the contract import. Change the `./types` import to `import type { Resolved, UncheckedOptions } from './types'` (do not import `ExecuteDeps`, AL4 1.3 comment). Remove contract specifiers that become unused (expected: `Clock` and `WikimapiaTransport`) and keep all that are still used. Keep the existing import style and order.
7. **Behaviour preservation (binding, AL4 section 4 "Behaviour preservation").** The object passed to `ClientConfigSchema.safeParse` must have the same keys and values as before for every input. So `transport`, `clock` and any extra key never enter it, and the issues, messages and redaction stay identical. If any test changes outcome, the refactor is wrong. Fix `client.ts`, never the test.
8. **No other edits.** Do not touch `execute.ts`, `interpret.ts` or any other module, test, contract or config file. Do not change function bodies in `client.ts` other than `resolveConfig` and the removed helpers. Update the header comment of `client.ts` only if a sentence there describes the removed `readOption`.

### 2.3 Done when

Run from the repo root:

- **Tests (same command before and after):** `pnpm exec vitest run --no-color tests/wikimapia contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts` is all green, with **the same number of passing tests as the baseline from step 0**. No failures, skipped or todo tests. Report both counts.
- `pnpm exec tsc --noEmit` reports **0 errors**.
- `pnpm lint` reports **0 problems**. Also run `pnpm exec eslint src/wikimapia tests/wikimapia contracts/wikimapia-client.schema.ts contracts/wikimapia-client.test.ts contracts/wikimapia-client.schema.test.ts contracts/wikimapia-client.support.ts`, which must report 0 problems. A parallel storage refactor may touch `src/db/`. If `tsc` or `pnpm lint` reports problems **only** in files outside `src/wikimapia/`, and those problems were not in your step-0 baseline, do not fix them: report them with their paths. The scoped ESLint run and a `tsc` output with no `src/wikimapia/` errors then count as passing for this unit.
- `grep -n unknown src/wikimapia/*.ts` returns exactly the 8 KEEP lines, one occurrence each: `types.ts` x1 (`TransportOutcome`, `error: unknown` only), `interpret.ts` x2, `execute.ts` x5.
- `src/wikimapia/client.ts` contains no `unknown`, no `Record<`, no `readOption`, no `CONFIG_FIELDS` and no `as` type assertion (`as const` included).
- `src/wikimapia/types.ts` exports `UncheckedOptions` and has no runtime code. No other `src/wikimapia/` module declares a type (unit 06 rule still holds).
- A diff shows changes only in `src/wikimapia/types.ts` and `src/wikimapia/client.ts`.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/wikimapia/`, the support file and both contract test files.
- Your code MUST pass the tests and schemas defined in AL5 and the existing unit tests. If the code fails, fix the code, not the contract or the test. Do not skip, weaken or `.todo` any test.
- add-test-writer edits nothing in this unit. add-coder edits only `src/wikimapia/types.ts` and `src/wikimapia/client.ts`.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`. Do not touch `src/db/` or any storage file.
- Stop and report the exact error if any of these happens: the narrowing cannot be typed without `unknown`, `Record<string, unknown>` or an `as` assertion; `tsc` rejects `Partial<ClientConfig>` with `exactOptionalPropertyTypes`; lint flags the `null` check in `configCandidate`; or a test changes outcome and no faithful fix exists. Do not work around it by widening types, adding eslint-disable comments or casting.

## 4. Out of Scope

- Any behaviour change, bug fix, rename or refactor beyond AL4 section 4 rows 1 and 5 to 9, even if it looks like an improvement.
- The KEEP rows 2, 3, 4 and 10 to 14 (`TransportOutcome.error`, `interpret.ts`, `execute.ts`): leave them unchanged. `execute.ts` and `interpret.ts` are not edited.
- `unknown` and `Record<string, unknown>` in `tests/wikimapia/*.ts`. AL4 did not inventory them; checking them would be a separate corrective unit.
- New tests, or changes to test logic or coverage.
- Any change to `contracts/` (no narrowing here needs a contract change, per AL4 section 4).
- The storage feature (`src/db/`, `contracts/storage.*`) and its parallel refactor. Substeps 2 to 4, and the open HTTP-framework decision in `CLAUDE.md`.
