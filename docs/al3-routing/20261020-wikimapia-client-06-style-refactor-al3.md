# AL3 Routing: wikimapia-client, corrective unit 06 "Code-style refactor"

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **Unit:** corrective unit 06, a code-style refactor with **no behaviour change**. U1 to U5 are done and verified.
- **AL4 source:** `docs/al4-design/20261020-wikimapia-client-al4.md`, section 4 "Implementation Units", paragraph "Refactor note (2026-10-21, code style, `.agrules` section 5)"
- **Audience:** `add-test-writer` (only `tests/`), then `add-coder` (only `src/`)
- **Status:** Routing to AL2 Agents

Baseline (verified before routing): the full suite passes (583 tests), `pnpm exec tsc --noEmit` reports 0 errors and `pnpm lint` reports 0 problems. `tsconfig.json` already uses `"module": "preserve"` + `"moduleResolution": "bundler"`. AL5 has already made every relative import in `contracts/` extensionless. Only `src/wikimapia/*.ts` and `tests/wikimapia/*.test.ts` still use `.js` relative imports, and the six internal types are still declared in their original modules.

## 1. Context Manifest

Read these files, and only these. Follow the project stack and code style they define: Node ESM, TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`, Zod 4, Vitest with globals, pnpm, ESLint `strictTypeChecked`. **This unit replaces the earlier style rule** "`.js` suffix on relative imports" that the U1 to U5 routing prompts gave. From now on relative imports have no extension.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Section 5 "Code Style" is what this unit implements: extensionless relative imports, and types declared in `src/` live in `types.ts` and are imported with `import type`. |
| 2 | `CLAUDE.md` | Stack and project conventions. |
| 3 | `docs/al4-design/20261020-wikimapia-client-al4.md` | Read only these sections: "0. Scope and Fixed Points" (paragraphs "Single source of truth" and "Code style"), "1.1 Module map" (the `types.ts` row and the paragraph under the table about test imports), "1.3 Component contracts" (the `types.ts` block and the `import type` comments on the `normalize.ts`, `interpret.ts`, `execute.ts` and `client.ts` blocks, plus the paragraph after the code block), "4. Implementation Units" (the "Refactor note" paragraph only), "5. AL2 Guidance" (first two bullets). |
| 4 | `src/wikimapia/normalize.ts` | Declares `Normalized<T>` (to move). Has `.js` relative imports. |
| 5 | `src/wikimapia/interpret.ts` | Declares `Interpretation<T>` (to move). Imports `Normalized` from `./normalize.js` as an inline `type` specifier. |
| 6 | `src/wikimapia/execute.ts` | Declares `ClientResult<T>`, `ExecuteDeps` and the non-exported `TransportOutcome` (to move). Imports `Interpretation` from `./interpret.js`. |
| 7 | `src/wikimapia/client.ts` | Declares the non-exported `Resolved` (to move). Imports `ExecuteDeps` from `./execute.js` as an inline `type` specifier. Also has an `export ... from './runtime.js'` re-export. |
| 8 | `src/wikimapia/issues.ts`, `src/wikimapia/request.ts`, `src/wikimapia/redact.ts`, `src/wikimapia/runtime.ts` | Imports only: each has `.js` relative imports and no own type declarations. |
| 9 | `tests/wikimapia/*.test.ts` (8 files: `client`, `execute`, `interpret`, `issues`, `normalize`, `redact`, `request`, `runtime`) | Every file has `.js` relative imports. `normalize.test.ts`, `interpret.test.ts`, `execute.test.ts` and `client.test.ts` import `Normalized`, `Interpretation`, `ClientResult` or `ExecuteDeps` as inline `type` specifiers from the source modules. |
| 10 | `tsconfig.json`, `eslint.config.js`, `package.json` | Compiler, lint and script settings. `pnpm lint` is `eslint .` over the whole repo. Read them; do not edit them. |

Do not read the AL6 document, `contracts/` files or the fixtures. This unit does not change behaviour, so you need no contract semantics.

## 2. Execution Directives

### 2.1 add-test-writer (only `tests/wikimapia/`)

The job is mechanical import rewriting. **Change no test logic, no assertion, no test name and no helper body**, and add or remove no test. The test count must stay at 583.

1. **Extensionless imports.** In all 8 files under `tests/wikimapia/`, remove the `.js` suffix from every relative module specifier. That covers `../../src/wikimapia/<module>.js`, `../../contracts/wikimapia-client.schema.js` and `../../contracts/wikimapia-client.support.js`. Do not change anything else in those lines. (Verified: there are no dynamic `import()`, `vi.mock` or `require` specifiers in `tests/`.)
2. **Internal types come from `types`.** Take `Normalized`, `Interpretation`, `ClientResult` and `ExecuteDeps` out of the value imports from `normalize`, `interpret` and `execute`. Import them instead with **one top-level** `import type { ... } from '../../src/wikimapia/types'` per file, listing only the types that file uses:
   - `tests/wikimapia/normalize.test.ts`: `Normalized`
   - `tests/wikimapia/interpret.test.ts`: `Interpretation`, `Normalized`
   - `tests/wikimapia/execute.test.ts`: `ClientResult`, `ExecuteDeps`, `Interpretation`
   - `tests/wikimapia/client.test.ts`: `Interpretation`
   Do not use inline `type` specifiers inside a value import for these (AL4 "5. AL2 Guidance", second bullet). If removing a type leaves a value import with no specifiers, remove that import statement. Tests must not import `TransportOutcome` or `Resolved` (AL4 1.3, paragraph after the code block).
3. **Leave alone:** test-local helper types such as `Interpreter` in `interpret.test.ts` and `Overrides` in `execute.test.ts` (`.agrules` section 5 governs `src/`, not test helpers), inline `type` specifiers for contract types imported from the schema file, and every file header comment.
4. **Red check.** `src/wikimapia/types.ts` does not exist yet, so `pnpm exec tsc --noEmit` must fail, and every error must be TS2307 ("Cannot find module") on `../../src/wikimapia/types`, one per importing test file (4 files). Any other error means a rewrite mistake; fix it before handing off. `pnpm exec vitest run --no-color` may still pass with 583 tests, because type-only imports are erased at runtime. **That is expected and acceptable for this unit:** the red signal here is `tsc`, not Vitest. Report the `tsc` output and the Vitest totals in your hand-off.

### 2.2 add-coder (only `src/wikimapia/`)

No behaviour change. Do not touch any function body beyond import lines and the removed type declarations.

1. **Create `src/wikimapia/types.ts`** exactly as the `types.ts` block in AL4 1.3. It has a short file header comment in the style of the other modules (naming AL4 1.1, 1.3 and the section 4 refactor note) and exports the six types `Normalized<T>`, `Interpretation<T>`, `ClientResult<T>`, `ExecuteDeps`, `TransportOutcome` and `Resolved`. Copy each type's definition verbatim from its current module, so that the shapes stay identical. Its only import is a top-level `import type` of `ClientFailure`, `Clock`, `FailureIssue` and `WikimapiaTransport` from `'../../contracts/wikimapia-client.schema'`. It contains no runtime code and does not re-export any contract `z.infer` type.
2. **Remove the declarations from their original modules:**
   - `normalize.ts`: remove `Normalized`; add `import type { Normalized } from './types'`.
   - `interpret.ts`: remove `Interpretation`; replace the inline `type Normalized` specifier in the `./normalize` import with `import type { Interpretation, Normalized } from './types'`.
   - `execute.ts`: remove `ClientResult`, `ExecuteDeps` and `TransportOutcome`; replace the `./interpret` type import with `import type { ClientResult, ExecuteDeps, Interpretation, TransportOutcome } from './types'`.
   - `client.ts`: remove `Resolved`; replace the inline `type ExecuteDeps` specifier in the `./execute` import with `import type { ExecuteDeps, Resolved } from './types'`.
   No module other than `types.ts` may declare or export a `type` or `interface` afterwards, and no module re-exports the moved types.
3. **Prune now-unused contract type imports.** After the move, some contract type specifiers (for example `Clock` or `WikimapiaTransport` in `execute.ts`, or `ClientFailure` where it was used only by a moved type) may become unused. Remove the ones that are no longer referenced, or lint and `tsc` will fail. Keep every one that is still used.
4. **Extensionless imports.** In all 8 existing modules, remove the `.js` suffix from every relative specifier: `../../contracts/wikimapia-client.schema.js` and the `./<module>.js` imports, including the `export { createFetchTransport, systemClock } from './runtime.js'` re-export in `client.ts`. Do not add `.ts` and do not enable `allowImportingTsExtensions`.
5. **Import form.** Use a top-level `import type` statement for `./types`, never a value import and never an inline `type` specifier mixed into a value import (AL4 "5. AL2 Guidance", second bullet). Keep the existing import order style.
6. **Header comments.** If a module's header comment says that a moved type is declared or exported there, update that sentence. Make no other comment changes.
7. **Scope.** Modify only `src/wikimapia/*.ts`. Do not touch `tests/` (add-test-writer already did), `contracts/` or any config file. Add no dependency.

### 2.3 Done when

All of the following hold, run from the repo root:

- `pnpm exec vitest run --no-color` (whole suite: `contracts/` and `tests/`) passes with **583** tests, no failures and no skipped or todo tests. This includes `pnpm exec vitest run --no-color contracts` at 101/101 (66 behavioural + 35 schema/fixture).
- `pnpm exec tsc --noEmit` reports **0 errors** (the TS2307 errors from the red check are gone).
- `pnpm lint` reports **0 problems** (0 errors, 0 warnings).
- A search across `src/`, `tests/` and `contracts/` for relative imports that end in an extension, with the regex `from\s+['"]\.{1,2}/[^'"]*\.(js|ts)['"]`, finds nothing. This also covers `export ... from` re-exports.
- A search in `src/wikimapia/` for type declarations, with the regex `^\s*(export\s+)?(type\s+\w+(<[^>]*>)?\s*=|interface\s+\w+)`, matches only in `src/wikimapia/types.ts`, with exactly the six types listed in AL4 1.1.
- `git diff`, or a file comparison, shows that only import lines, the moved type declarations, now-unused import specifiers and header-comment sentences about the moved types changed. No function body changed.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/wikimapia/`, the support file and both contract test files. `contracts/` is already extensionless (AL5). AL4 "5. AL2 Guidance", last bullet, still mentions `.js` imports in `contracts/`. That remark is outdated; ignore it and do not "fix" anything there.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- add-test-writer edits only `tests/wikimapia/`. add-coder edits only `src/wikimapia/`.
- Do not edit `CLAUDE.md`, `.agrules`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` or `package.json`.
- If extensionless resolution fails in any tool (Vitest, `tsc` or ESLint), or if a moved type turns out not to be assignable where it was before, stop and report it with the exact error. Do not work around it by restoring extensions or redefining types locally.

## 4. Out of Scope

- Any behaviour change, bug fix, rename, reformat or refactor beyond imports and the type move, even if it looks like an improvement. U1 to U5 behaviour is final.
- New tests, or changes to existing test logic or coverage.
- `contracts/` import style (done at AL5) and any change to contract types or schemas.
- Moving types into `types.ts` that are not in AL4 1.1's list, re-exporting contract `z.infer` types, and changing test-local helper types.
- Substeps 2 to 4 (storage, crawl, embeddings) and the open HTTP-framework decision in `CLAUDE.md`.
