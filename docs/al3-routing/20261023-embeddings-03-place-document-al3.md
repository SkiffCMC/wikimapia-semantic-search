# AL3 Routing: embeddings, U3 "Place Document builder (public `buildPlaceDocument`)"

- **Feature:** `embeddings` (Stage 1, substep 4)
- **Unit:** U3 of 7 (attempt 1)
- **AL4 source:** `docs/al4-design/20261023-embeddings-al4.md`, section "4. Implementation Units", "U3".
- **AL6 source (background only):** `docs/al6-requirements/20261023-embeddings-al6.md` (stakeholder-approved).
- **Audience:** `add-test-writer` (section 2.1), then `add-coder` (section 2.2).
- **Status:** Routing to AL2 Agents

## 0. Starting state

- U1 and U2 are done and verified. All tests are green. `src/db/embedding-store.ts` exists.
- `src/embed/` and `tests/embed/` do not exist yet. This unit creates them.
- `pnpm exec tsc --noEmit` shows exactly 3 errors today: the unresolved modules `src/embed/command`, `src/embed/place-document` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. After this unit, the `src/embed/place-document` error must be gone and the other 2 must remain (AL4 section 4, "Baseline caveat").
- `contracts/embeddings.test.ts` still cannot load, because `command` and `run-embedding` are missing until U6/U7. Do not run it as a gate. Do not stub the missing modules.
- U3 is pure. It needs no database, no network and no new dependency.

## 1. Context Manifest

Read these files and no others. Follow the stack and code style in `.agrules` section 5 and `CLAUDE.md`:
- Node ESM, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Top-level `import type` for types; extensionless relative imports.
- `unknown` is not needed anywhere in this unit.
- Any type alias or interface you declare in `src/embed/` goes in `src/embed/types.ts`.
- No `console`.

| # | Path | Why |
|---|---|---|
| 1 | `.agrules` | Binding rules. Mainly section 4 (no Commenter IPs, synthetic fixtures only, no live calls, strict types) and section 5 (code style). |
| 2 | `CLAUDE.md` | Stack and decisions. Do not edit it. |
| 3 | `docs/al4-design/20261023-embeddings-al4.md` | Read only these parts. "0. Scope and Fixed Points": the Entry point 2 row, the Constants row, the "Helpers to reuse" row, "Single source of truth", "Code style". "1.1 Module map": the `src/embed/types.ts` and `src/embed/place-document.ts` rows, and the "Unit tests" paragraph. "1.4.1 Place Document" in full. "4. Implementation Units": the intro, "Baseline caveat" and "U3". "5. AL2 Guidance": the bullets "Global regex", "Test files", "Imports", "Do not edit `contracts/`". |
| 4 | `contracts/embeddings.schema.ts` | Lines ~186-248, "Place Document rules": `PLACE_DOCUMENT_LABELS`, `PART_SEPARATOR`, `LIST_SEPARATOR`, `ADDRESS_ITEM_ORDER`, `BARE_WEB_ADDRESS` (global flag), `tidySpacing`, `PlaceDocument`, `BuildPlaceDocumentFn`. Lines ~265-277: `documentFingerprint` (used by tests only). Import these and do not redefine them. |
| 5 | `contracts/storage.schema.ts` | Lines ~250-335: `StoredTag`, `StoredComment` (recursive `replies`, `presence`, `isDeleted`, `isBlocked`, `message`), `DetailedPlace` (`name`, `description`, `tags`, `location`, `comments`). |
| 6 | `contracts/wikimapia-client.schema.ts` | Around line 275, `LocationSchema` only: the address items are optional non-empty strings (`exactOptional`). |
| 7 | `contracts/embeddings.support.ts` | Lines ~355-490: `PLACE_K_ID`, `K_TAGS`, `K_DESCRIPTION`, `K_ADDRESS`, `K_DOCUMENT`, `K_COMMENT_1`/`3`/`4` (their specs show what Place K holds), `storedComments`, `storedTags`, `detailedPlace`, `partsOf`. Around lines 306-315: `locationWith`. These are the test-writer's building blocks. |
| 8 | `contracts/storage.support.ts` | `longMixedDescription` only (line ~255), for the 7,000+ character case. |
| 9 | `contracts/embeddings.test.ts` | Read only lines ~393-653, "3.1 The Place Document" (AC-1 to AC-16). These are the black-box checks that U7 runs against `buildPlaceDocument`. Mirror their inputs and expectations in unit tests. Do not import from this file or run it. |

Do not read `src/db/`, `src/crawl/`, `src/wikimapia/` or the migrations. U3 does not touch them.

**Never open, print, copy, rewrite or delete `.env`.** It holds the user's API keys.

## 2. Execution Directives

### 2.1 add-test-writer

Create **`tests/embed/place-document.test.ts`** (new, pure, no database). It covers AL4 1.4.1 and AL4 U3 "Unit tests must cover".

General rules:
- Build every input in the read-back shape with `detailedPlace`, `storedTags` and `storedComments` from `contracts/embeddings.support.ts`, and assert on `partsOf(...)` or the whole string.
- Import the subject from `../../src/embed/place-document`, and type it as `BuildPlaceDocumentFn` to pin the signature.
- Use synthetic values only. No network, no database, no fixture files, no Commenter IP fields.

Test groups, with the behaviour each one must pin down:

1. **AC-1 Place K, read-back shape.** Build Place K directly with `detailedPlace`:
   - `placeId: PLACE_K_ID`, name `Kalemegdan Park`, `K_DESCRIPTION`, address `K_ADDRESS`.
   - Tags park and fortress Present, and garden Gone.
   - Comments per `K_COMMENT_1` (with its Reply), `K_COMMENT_3` as `presence: 'gone'`, and `K_COMMENT_4` (deleted).

   The result equals `K_DOCUMENT` exactly, and does not start or end with `\n`.
2. **AC-2 order and labels.** Use the full six-item address and two Tags in non-alphabetical order (Tag order kept as given). The Parts are Name, `Tags: `, `Address: ` (street, houseNumber, city, place, state, country), `Description: `, then `Comment: ` lines. They are joined by a single `\n`.
3. **AC-3 name only.**
   - A Place with only a name gives exactly the name.
   - A Place with only Gone Tags and Gone Comments also gives exactly the name.
4. **AC-5 address dedupe.**
   - city = place = `Belgrade` appears once, at the first position.
   - `Belgrade` and `belgrade` are both kept (exact comparison).
   - Values that become equal only after tidying (e.g. `' Belgrade '` and `'Belgrade'`) appear once.
   - Items that become blank after tidying are left out.
   - An address where every item is blank gives no Address Part.
5. **AC-6 / AC-7 Bare Web Addresses in descriptions.** Cover every contract case: `See http://example.org/a for more.`, `Visit www.Example.org today`, `HTTPS://example.org/x` (no Part), `Info: https://a.rs/b?c=1, http://d.rs`, and `Birds go awww. at dusk` (kept). Also cover the three AC-7 only-a-URL descriptions (the result is the name only). Also `a http://x b` gives `Description: a b`, so no words are glued together.
6. **AC-8 tidying of every Part kind.** Use CR LF, tabs, runs of spaces and leading/trailing spacing in the name, a Tag title, address items, the description and Comment messages. Include a blank Tag title (left out of the list) and a whitespace-only Comment (no Part). Mirror the contract's AC-8 expected Parts exactly.
7. **AC-9 kept as stored.** HTML entities (`&quot;`, `&amp;`), Cyrillic and Latin diacritics come out byte-identical.
8. **AC-10 long description.** `longMixedDescription(...)` (7,000+ characters) gives `Description: ` plus the whole text with only spacing tidied. Nothing is cut.
9. **AC-11 Comment inclusion.**
   - Deleted, blocked and Gone Comments are left out.
   - A Present Reply of a deleted Comment, and a Present Reply of a Gone Comment, are still included.
   - A Gone Reply, and a deleted or blocked Reply, are left out.
10. **AC-12 depth-first order.** Comments A (Replies A1 with Reply A1x, then A2) and B give `A, A1, A1x, A2, B`.
11. **AC-13 Gone Tags.** A Gone Tag title appears nowhere in the Document. A Place whose only Tags are Gone has no Tags Part.
12. **AC-14 Comments keep web addresses.** `great photos at http://example.org` is kept whole. Web addresses in the name, a Tag title and an address item are kept too.
13. **Empty Document.** An all-blank Place gives `''`: blank or whitespace name, no Present Tags, blank address, a URL-only description, and no includable Comment.
14. **Deleted Place (Q4).** `isDeleted: true` on the Place gives the same Document as the same Place with `isDeleted: false`.
15. **Fields that are never read (AC-20/21, pure side).** Changing author, votes, `postedAtEpochSeconds`, outline, lon/lat bounds, `wikipediaUrl`, `detailsFetchedAt` or `isBuilding` leaves the Document unchanged. Build the variants with spreads of a base `detailedPlace(...)`.
16. **AC-16 determinism and the global regex.**
    - Calling the builder twice on the same URL-bearing input gives identical text and identical `documentFingerprint`.
    - The same holds for several different URL-bearing Places built one after another. This guards against `lastIndex` state.
17. **No mutation.** Take a `structuredClone` of the input before the call. After the call, the input is `toStrictEqual` to the clone.

Tests are expected to fail until `add-coder` finishes. Do not stub the production module.

### 2.2 add-coder

Implement AL4 1.4.1 exactly. Import from `../../contracts/embeddings.schema`: `PLACE_DOCUMENT_LABELS`, `PART_SEPARATOR`, `LIST_SEPARATOR`, `ADDRESS_ITEM_ORDER`, `BARE_WEB_ADDRESS`, `tidySpacing`, and the types `BuildPlaceDocumentFn` and `PlaceDocument`. Import the `DetailedPlace`, `StoredComment` and `StoredTag` types from `../../contracts/storage.schema`, using `import type`. Never copy, redefine or re-implement any of them (no own whitespace regex, no own URL regex, no literal labels or separators).

1. **`src/embed/place-document.ts`** (new): `export const buildPlaceDocument: BuildPlaceDocumentFn`, following the pseudocode in AL4 1.4.1 step by step:
   - The Name Part has no label. Tags are the Present ones only, tidied, with blanks dropped.
   - Address items are read in `ADDRESS_ITEM_ORDER`. Skip `undefined`, tidy each item, drop blanks, and drop exact duplicates of earlier tidied items.
   - Description: `place.description.replace(BARE_WEB_ADDRESS, ' ')`, then `tidySpacing`.
   - Comments: walk depth first in read-back order. Include a Comment only if it is Present, not deleted and not blocked, and its tidied message is non-empty. Always recurse into `replies`, including the replies of a Comment that was left out.
   - Join the Parts with `PART_SEPARATOR`. `''` is the Empty Document.
2. **Regex rule.** Use `BARE_WEB_ADDRESS` only with `String.prototype.replace`, never with `.test`, `.exec`, `.match` or `matchAll` (it has the `g` flag).
3. **Purity.** No I/O, no clock, no logging, no module state. Do not mutate the input: no `sort`, `reverse` or `splice` on input arrays, and no writes to input objects. Read only `name`, `tags`, `location` (the six address keys), `description` and `comments` (`presence`, `isDeleted`, `isBlocked`, `message`, `replies`). Never read `isDeleted` of the Place itself. Never decode entities, change case, normalise Unicode or cut text.
4. **`src/embed/types.ts`**: create it only if `place-document.ts` declares a type alias or interface (e.g. a named type for the walker). If it does not, do not create the file. Never add the other types of AL4 1.3 (`DueItem`, `Tally`, ...); they belong to U4 and later units.
5. Do not touch `src/db/`, `src/crawl/`, `src/wikimapia/`, `scripts/`, `package.json`, the lockfile, `.env.example`, or config and docker files. Do not create any other `src/embed/` module.
6. **Stop and report, do not work around**, if any of these happens:
   - A contract expectation in `contracts/embeddings.test.ts` lines ~393-653 or `K_DOCUMENT` cannot be met by AL4 1.4.1 as written.
   - A contract type makes the pseudocode untypeable without a cast.
7. Run every check in 2.3 in order, and report each result with its exit code and the relevant output lines.

### 2.3 Done when

Run all commands from `D:\Programming\wikimapia-semantic-search` in PowerShell. This unit needs no database:
- Do not run `pnpm db:*`, `pnpm crawl`, `pnpm test:db` or anything against the Development Database.
- Do not set `DATABASE_URL`.

1. `pnpm exec vitest run --no-color tests/embed/place-document.test.ts contracts/embeddings.schema.test.ts` passes, with no failures and no skipped or todo tests.
2. Regression (pure suites): `pnpm exec vitest run --no-color tests/crawl/tile-plan.test.ts tests/crawl/report.test.ts tests/crawl/config.test.ts tests/db/vector.test.ts tests/db/writer.test.ts tests/db/validate.test.ts` passes.
3. `pnpm exec eslint src/embed tests/embed` reports no problems.
4. `pnpm exec tsc --noEmit` reports exactly 2 errors: the unresolved modules `src/embed/command` and `src/embed/run-embedding` in `contracts/embeddings.test.ts`. The `src/embed/place-document` error is gone. `pnpm lint` reports problems only in `contracts/embeddings.test.ts`, and only those caused by the same 2 missing modules.
5. Guards. Each of these must return nothing:
   - `Select-String -Path src/embed/*.ts -Pattern "console\.|: any|as any|as unknown|ts-expect-error|eslint-disable|unknown"`
   - `Select-String -Path src/embed/*.ts -Pattern "BARE_WEB_ADDRESS\.(test|exec)|match\(BARE_WEB_ADDRESS|matchAll\(BARE_WEB_ADDRESS"`
   - `Select-String -Path src/embed/*.ts -Pattern "\\s\+|'Tags: '|'Comment: '|https\?"` (no re-implemented tidy, labels or URL regex)
   - `Select-String -Path src/embed/*.ts -Pattern "\.(sort|reverse|splice)\("`
6. `Get-ChildItem src/embed` lists only `place-document.ts`, and `types.ts` if one was needed.

Do not run `contracts/embeddings.test.ts` as a gate: it cannot load before U7.

## 3. Boundary Enforcement (The Iron Rule)

- You MUST NOT create, modify, rename or delete anything under `docs/al4-design/`, `docs/al6-requirements/` or `contracts/`, including `contracts/fixtures/` and the `*.support.ts` files.
- Your code MUST pass the tests and schemas defined in AL5. If the code fails, fix the code, not the contract. Do not skip, weaken or `.todo` any test.
- Files you may change: exactly those in AL4 U3 "Files":
  - `src/embed/place-document.ts`
  - `src/embed/types.ts` (only if needed)
  - `tests/embed/place-document.test.ts`
- Never open, write or print `.env`. Never put a real key, password or connection string in code, tests or output.
- Do not edit `CLAUDE.md`, `.agrules`, `package.json`, or any earlier AL3 prompt.

## 4. Out of Scope

- **U4:** `settings.ts`, `batches.ts` (`cutBatch`), `report.ts`, and the run types of AL4 1.3 in `src/embed/types.ts` (`DueItem`, `Stop`, `Resolution`, `BatchResult`, `Tally`, `SendContext`, ...).
- **U5:** the `voyageai` dependency, `voyage-service.ts`, `send-batch.ts`.
- **U6:** `runEmbedding`, the scan-and-send loop, and the use of `isEmbeddingDue` / `documentFingerprint` in production code (tests may call `documentFingerprint`).
- **U7:** `command.ts`, `scripts/embed.ts`, package scripts, `.env.example`, and the Place-Store-backed checks of AC-1, AC-4 and AC-10 to AC-13 (verified end to end through `contracts/embeddings.test.ts`).
- Any change to `src/db/` (U1/U2 are finished), and recording the AL4 0.1 decisions in `CLAUDE.md` (the orchestrator does this).
