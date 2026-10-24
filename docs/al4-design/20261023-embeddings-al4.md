# AL4 Design: Embeddings (the Embedding Run)

- **Feature:** `embeddings` (Stage 1, substep 4)
- **AL7 source:** `docs/al7-intent/20261023-embeddings-al7.md`
- **AL6 source:** `docs/al6-requirements/20261023-embeddings-al6.md` (revision 2, AC-1 .. AC-62, rules 1 .. 13, R1, R2, decisions Q1 .. Q8, D9, D10)
- **AL5 sources:** `contracts/embeddings.schema.ts` (entry points, constants, schemas, `tidySpacing`, `BARE_WEB_ADDRESS`, `documentFingerprint`, `isEmbeddingDue`, `estimateDocumentTokens`, `findEmbeddingAnswerIssues`, `classifyEmbeddingServiceError`, `findBatchIssues`, `embedExitCodeFor`, labels), `contracts/embeddings.test.ts` (behaviour, black box, Test Database), `contracts/embeddings.schema.test.ts` (schema-only, green before AL2), `contracts/embeddings.support.ts` (Simulated Embedding Service, Simulated Clock, synthetic Places). Amended prior contracts: `contracts/storage.schema.ts` (`emptyStore()` also removes Embedding Records), `contracts/storage.test.ts` (storage AC-5 replaced: the only vector column is `place_embeddings.embedding`), `contracts/crawl-run1-fixes.test.ts` (AC-41 undoes newest-first until its table is gone).
- **Builds on:** `docs/al4-design/20261021-storage-al4.md` (`src/db/`, extended), `docs/al4-design/20261022-hydration-al4.md` and `docs/al4-design/20261022-crawl-run1-fixes-al4.md` (Schema Setup steps 5 and 6, `undoLast`, the `guarded` store pattern, the Run-wide write hook, the command/script pattern, `createSystemCrawlClock`).
- **Binding rules:** `.agrules` sections 1 (offline batch job, idempotent, resumable, backs off), 2 (one embedding model per column, 1024 dims, `document` input type, every service answer validated with Zod), 3 (all SQL in `src/db/`, parameterized, versioned migrations), 4 (licensing, no secrets, no Commenter IPs, no live calls in tests, strict types), 5 (extensionless imports, `unknown` only where allowed, types in `types.ts`).
- **Status:** Ready for AL3 Routing

## 0. Scope and Fixed Points

This feature adds the **Embedding Run**: a command (`pnpm embed [--limit <n>]`) that reads every Detailed Place from the Place Store in ascending Place ID, builds its Place Document, skips Unchanged Places, Summary-Only Places and Empty Documents, sends the remaining Place Documents to Voyage AI `voyage-4` (`inputType: "document"`, 1024 dims) in Batches within Voyage's limits and the Run's Embedding Limit, and keeps each Batch's Embedding Records (embedding, model, Document Fingerprint, Embedded At) before the next request. A new Schema Setup step adds `place_embeddings` with a `vector(1024)` column and an HNSW cosine index. The Run is resumable by construction (skip by fingerprint), never rejects, and ends with an exact Run Summary.

Fixed by AL5, not to be changed by AL3/AL2:

| Item | Value |
|---|---|
| Entry point 1 | `src/embed/run-embedding.ts` exports `runEmbedding: RunEmbeddingFn` |
| Entry point 2 | `src/embed/place-document.ts` exports `buildPlaceDocument: BuildPlaceDocumentFn` |
| Entry point 3 | `src/embed/command.ts` exports `runEmbedCommand: RunEmbedCommandFn` |
| Entry point 4 | `src/db/embedding-store.ts` exports `createEmbeddingStore: CreateEmbeddingStoreFn` |
| Schema Setup | `src/db/schema-setup.ts` `createSchemaSetup` (newest step adds Embedding Record storage; `emptyStore()` also removes every Embedding Record) |
| Script | `package.json` `scripts.embed` starts with `tsx ` (`EMBED_SCRIPT`) |
| Storage names | `EMBEDDING_TABLE` = `place_embeddings`, `EMBEDDING_COLUMN` = `embedding`, `EMBEDDING_COLUMNS`, `EMBEDDED_AT_UDT_NAME` = `timestamptz`, `SIMILARITY_INDEX` = `{ hnsw, vector_cosine_ops }` |
| Env vars | `VOYAGE_API_KEY` (`VOYAGE_API_KEY_ENV`), `DATABASE_URL` (`DATABASE_URL_ENV`); `.env.example` gains `VOYAGE_API_KEY=` and `ANTHROPIC_API_KEY=` |
| Constants | `EMBEDDING_MODEL` = `voyage-4`, `EMBEDDING_DIMENSIONS` = 1024, `DOCUMENT_INPUT_TYPE`, `VOYAGE_MAX_TEXTS_PER_REQUEST` = 1000, `DEFAULT_BATCH_TOKEN_LIMIT` = 320,000, `DEFAULT_EMBEDDING_LIMIT` = 1000, `EMBEDDING_RETRY_WAITS_SECONDS` = [30, 60], `MAX_PLACES_PER_STORE_CALL` = 1000, `EMBED_COMMAND_OPTIONS`, `EMBED_SUMMARY_LABELS`, `EMBEDDING_OUTCOME_LABELS`, `FAILED_PLACE_LABELS`, `PLACE_DOCUMENT_LABELS`, `PART_SEPARATOR`, `LIST_SEPARATOR`, `ADDRESS_ITEM_ORDER` |
| Helpers to reuse (never re-implement) | `tidySpacing`, `BARE_WEB_ADDRESS`, `documentFingerprint`, `isEmbeddingDue`, `estimateDocumentTokens`, `findEmbeddingAnswerIssues`, `classifyEmbeddingServiceError`, `embedExitCodeFor`, `findBatchIssues` (unit tests only), `EmbeddingAnswerSchema`, `EmbeddingRunRequestSchema`, `EmbeddingSettingsSchema`, `EmbeddingRunReportSchema`, `ZERO_EMBEDDING_COUNTS`, every Embedding Store input/value schema; from hydration: `toMoment`; from storage: `storeResultSchema`, `StoreConfigSchema`, `WriteHook`; from `src/crawl/runtime.ts`: `createSystemCrawlClock` |

**Approved contract decisions (stakeholder, 2026-10-23), designed in as-is:** (1) a Batch answered with Service Refused stops the Run (Failed); its Places are not Failed Places and stay Embedding Due; (2) HTTP 429 = Service Rate Limit; 401/403 and every other non-408 4xx = Service Refused; 408, 5xx and errors without a status = Connection Failure (`classifyEmbeddingServiceError`); (3) an answer naming a model other than `voyage-4` is an Invalid Embedding Answer; (4) Batch size estimate = UTF-8 bytes + 16 per text, greedy, limit 320,000 by default, a Place Document whose estimate alone exceeds the limit is sent in a Batch of its own, and Voyage's `truncation: true` handles over-long single texts; (5) the existing `.env.example` lines are checked by hash.

**Single source of truth.** `src/embed/*` imports schemas, types and helpers from `../../contracts/embeddings.schema`, `../../contracts/storage.schema` and `../../contracts/hydration.schema`; `src/db/*` from `../../contracts/...`. AL2 never copies or redefines them. Contract `z.infer` types are imported with `import type`.

**Code style (`.agrules` section 5).** Extensionless relative imports. Every type alias/interface declared in `src/embed/` lives in `src/embed/types.ts`; every one declared in `src/db/` lives in `src/db/types.ts`. `unknown` only for caught errors, the raw Embedding Service answer (parsed with `EmbeddingAnswerSchema` on the next step), raw Knex/pg results parsed with Zod on the next line, and validator parameters for untrusted input.

**HTTP framework:** not needed (the Embedding Run is a command, no server). The open decision in `CLAUDE.md` stays open.

**Current red state resolved by the units:** `contracts/embeddings.test.ts` cannot resolve `src/db/embedding-store`, `src/embed/command`, `src/embed/place-document`, `src/embed/run-embedding` (4 unresolved-import lint errors and matching tsc errors; fixed as the modules appear in U2, U3, U6, U7). `contracts/storage.test.ts` "AC-5 Vectors only in the Embedding Record of a Place" fails at runtime until U1 (no vector column yet). `contracts/storage.test.ts` imports only constants from `./embeddings.schema`, so it runs from U1 on.

### 0.1 Decisions made by this design (for the orchestrator to record in `CLAUDE.md`)

| Decision | Choice |
|---|---|
| Embed command | `pnpm embed [--limit <n>]`, script `tsx scripts/embed.ts`; reads `.env` (shell wins); scheduled (if ever) by OS cron / Task Scheduler, never chained to the Crawl automatically |
| Embedding storage | Schema Setup step 7 `20261023_01_create_place_embeddings`: table `place_embeddings` (`place_id` PK and FK -> `places` `ON DELETE CASCADE`, `embedding vector(1024)`, `embedding_model`, `document_fingerprint`, `embedded_at timestamptz(0)`), HNSW index `place_embeddings_embedding_hnsw_idx` with `vector_cosine_ops` (pgvector defaults `m = 16`, `ef_construction = 64`); no Objection model (Knex builder + Zod row schemas, like the crawl tables) |
| Vector encoding | `pgvector` npm package (`toSql` / `fromSql`), wrapped in `src/db/vector.ts`; written as `?::vector` bindings, read back as `embedding::text` |
| Voyage client | `voyageai` npm package (exact version pinned), loaded lazily by a thin adapter `src/embed/voyage-service.ts` that disables the SDK's own retries (`maxRetries: 0`) and sets a 120 s timeout per request; the Run's 30 s / 60 s retries are the only retries |
| Pacing | none client-side: one request in flight at a time, sequential; Voyage 429s are handled by the retry rule |
| Write-hook numbering | One store-wide counter per Embedding Store (one store per Run): `runWideHook` moves from `crawl-repository.ts` to `writer.ts` as `createRunWideHook` and is shared |
| HTTP framework | Still open (not needed here) |

## 1. Architecture & Subsystems

### 1.1 Module map

Files lower in each table depend only on files above them (and on the modules noted).

**Database side (`src/db/`, all SQL of the feature):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/db/migrations/20261023_01_create_place_embeddings.ts` | migration | Table, checks, FK, HNSW index (section 2). Names are frozen literals, not imported from the contract. | `up`, `down` |
| `src/db/migrations/index.ts` | migration source | Append the new step as the 7th, newest entry of `MIGRATIONS`. | unchanged names |
| `src/db/schema-setup.ts` | factory (**public**, changed) | `emptyStore()` also truncates `place_embeddings` when it exists (1.4.9). | unchanged |
| `src/db/writer.ts` | pure (extended) | Adds `createRunWideHook(onWrite)` (moved from `crawl-repository.ts`, behaviour unchanged). | adds `createRunWideHook` |
| `src/db/crawl-repository.ts` | factory (refactor only) | Uses `createRunWideHook` from `writer.ts` instead of its private `runWideHook`. | unchanged |
| `src/db/vector.ts` | pure | The only module that knows the pgvector text format. | `toVectorLiteral`, `parseVectorText` |
| `src/db/rows.ts` | Zod (internal, extended) | Row schemas for the embedding queries. | adds `EmbeddingRowSchema`, `EmbeddingCountsRowSchema`, `TypmodRowSchema`, `KeyColumnRowSchema`, `VectorIndexRowSchema` |
| `src/db/validate.ts` | pure (extended) | Validators for the Embedding Store inputs. | adds `validateEmbeddingCandidatesInput`, `validateSaveEmbeddingRecordsInput` |
| `src/db/read.ts` | SQL (read, extended) | Export the existing `PLACE_COLUMNS` and `FETCHED_AT_TEXT_SQL`; add multi-Place loaders used by the candidates read. Existing functions unchanged. | adds `selectTagLinksOfPlaces`, `selectCommentRowsOfPlaces` |
| `src/db/embedding-read.ts` | SQL (read) | R2 candidates read, one record read, counts, storage inspection. | `selectEmbeddingCandidates`, `selectEmbeddingRecord`, `countEmbeddingStoreRows`, `readEmbeddingStorageInfo` |
| `src/db/embedding-save.ts` | SQL (write step) | Keep one Batch's Embedding Records, all or nothing. | `saveEmbeddingRecordsStep` |
| `src/db/embedding-store.ts` | factory (**public**) | `createEmbeddingStore`: the six methods of `EmbeddingStore`, guarded, never rejects. | `createEmbeddingStore` |

**Embedding side (`src/embed/`, no SQL; network only through the Voyage adapter):**

| File | Kind | Responsibility | Exports |
|---|---|---|---|
| `src/embed/types.ts` | types only | Every type alias/interface of `src/embed/`. | section 1.3 |
| `src/embed/place-document.ts` | pure (**public**) | The Place Document (1.4.1). | `buildPlaceDocument` |
| `src/embed/batches.ts` | pure | Greedy Batch cutting (1.4.3). | `cutBatch` |
| `src/embed/settings.ts` | pure | Validates the request and the Batch Token Limit, missing-key rule, messages. | `resolveSettings`, `isMissingApiKey`, `MISSING_KEY_MESSAGE`, `usageMessage` |
| `src/embed/report.ts` | pure | Tally, counts snapshot, summary text, report builders. | `createTally`, `formatSummaryText`, `buildReport`, `failedReport` |
| `src/embed/voyage-service.ts` | I/O adapter | Builds the production `EmbeddingService` from the `voyageai` SDK (1.4.6). | `createVoyageEmbeddingService`, `normaliseVoyageAnswer` |
| `src/embed/send-batch.ts` | orchestration helper | One Batch: request, retries, classification, answer validation, mapping, save (1.4.4). | `sendBatch` |
| `src/embed/run-embedding.ts` | factory (**public**) | The Run (1.2). Never rejects. | `runEmbedding` |
| `src/embed/command.ts` | CLI core (**public**) | Argument parsing, env, output lines, exit code. Never rejects. | `runEmbedCommand`, `parseEmbedArgs` |
| `scripts/embed.ts` | script (`tsx`) | Loads `.env`, wires argv, env, stdout, SIGINT/SIGTERM, `process.exitCode`. | none |

Unit tests: `tests/embed/<module>.test.ts` (pure, Simulated Embedding Service and Clock from `contracts/embeddings.support.ts`), `tests/embed/<topic>.db.test.ts` and `tests/db/embedding-*.db.test.ts` (Test Database; Schema Setup applied in `beforeAll`, `emptyStore()` in `beforeEach`). Tests never edit `contracts/`. No test file may contain a literal list of 1024 numbers or exceed 512 KB (contract AC-59 scans `tests/`); vectors are generated in code (`fakeEmbedding`, `fakeVector`).

### 1.2 Run flow

```
runEmbedding(request, deps)                                     (never rejects; outer try/catch -> failedReport 'Embedding run failed: internal error')
  clock = deps.clock ?? createSystemCrawlClock(deps.signal); startedAt = toMoment(clock.now())
  1. settings = resolveSettings(request, deps.batchTokenLimit)    pure; no DB, no request
       invalid -> Failed, message names `embeddingLimit` or `batchTokenLimit` (AC-41)
  2. isMissingApiKey(deps.apiKey) -> Failed MISSING_KEY_MESSAGE (names VOYAGE_API_KEY, AC-40)   checked even when a service is injected
  3. deps.signal?.aborted -> Interrupted, zero counts, nothing opened (AC-43 second case)
  4. service = deps.embeddingService ?? await createVoyageEmbeddingService({ apiKey: deps.apiKey.trim() })
       adapter cannot be loaded -> Failed 'Embedding Service client could not be loaded' (no detail)
  5. store = createEmbeddingStore({ connectionString, onWrite: deps.onWrite })      try { ... } finally { store.close() }
  6. totals = store.countEmbeddingStore()   failure -> Failed with failure.message (AC-42 first case)
       tally.summaryOnlySkipped = totals.summaryOnlyPlaces
  7. scan-and-send loop (1.4.2)
  8. outcome = stop?.outcome ?? (tally.limitHeld > 0 ? 'limit_reached' : 'completed')
  9. buildReport(...) gated with EmbeddingRunReportSchema; a failing gate -> failedReport 'internal error (report check)'
```

The Run talks to the database only through the public `EmbeddingStore` (one per Run). It never uses the `PlaceStore`.

### 1.3 Component contracts (signatures)

```ts
// ---------------------------------------------------------------- src/embed/types.ts (types only)
import type { DocumentFingerprint, EmbeddingFailureKind, EmbeddingRunOutcome, EmbeddingSettings,
  FailedPlaceKind, FailedPlaceReport, EmbeddingRunCounts, PlaceDocument } from '../../contracts/embeddings.schema';

export interface DueItem { placeId: number; document: PlaceDocument; fingerprint: DocumentFingerprint }
export type StopOutcome = Exclude<EmbeddingRunOutcome, 'completed' | 'limit_reached'>;   // rate_limited | interrupted | failed
export interface Stop { outcome: StopOutcome; message?: string }
export type Resolution = { ok: true; settings: EmbeddingSettings } | { ok: false; message: string };
export type BatchResult =
  | { kind: 'kept'; tokens: number }
  | { kind: 'failed'; failureKind: FailedPlaceKind; reason: string }     // its Places become Failed Places
  | { kind: 'stopped'; stop: Stop };                                    // its Places stay due, the Run stops
export interface Tally {
  considered(kind: 'unchanged' | 'empty' | 'due'): void;
  embedded(count: number, tokens: number): void;
  failed(items: readonly DueItem[], failureKind: FailedPlaceKind, reason: string): void;
  request(): void; batch(): void;
  limitHeld: number;                                                    // due Places not sent because the limit had no room
  summaryOnlySkipped: number;
  readonly failures: readonly FailedPlaceReport[];
  snapshot(): EmbeddingRunCounts;                                       // placesStillDue derived (1.4.7)
}
export interface SendContext {
  service: EmbeddingService; store: EmbeddingStore; clock: EmbeddingClock;
  signal: AbortSignal | undefined; tally: Tally; progress: (line: string) => void; batchNumber: number;
}
export interface VoyageServiceOptions { apiKey: string; baseUrl?: string; timeoutSeconds?: number }
export type ParsedEmbedArgs = { ok: true; request: EmbeddingRunRequest } | { ok: false; problem: string };

// ---------------------------------------------------------------- src/embed/*.ts
export const buildPlaceDocument: BuildPlaceDocumentFn;                                       // place-document.ts
export function cutBatch(queue: readonly DueItem[], room: number, tokenLimit: number,
  scanDone: boolean): number;                                                                // batches.ts: items to take now, 0 = none yet
export function resolveSettings(request: EmbeddingRunRequest, batchTokenLimit: number | undefined): Resolution;  // settings.ts
export function isMissingApiKey(apiKey: string | undefined): boolean;                       // undefined, '' or blank
export const MISSING_KEY_MESSAGE: string;   // `Embedding Service key is missing: set ${VOYAGE_API_KEY_ENV}.`
export function usageMessage(): string;     // `Usage: pnpm embed [${EMBED_COMMAND_OPTIONS.limit} <n>]`
export function createTally(): Tally;                                                        // report.ts
export function formatSummaryText(summary: EmbeddingRunSummary): string;
export function buildReport(input: { outcome: EmbeddingRunOutcome; message?: string; startedAt: string; endedAt: string;
  counts: EmbeddingRunCounts; failedPlaces: readonly FailedPlaceReport[] }): EmbeddingRunReport;
export function failedReport(message: string, startedAt: string, endedAt: string): EmbeddingRunReport;  // zero counts
export function createVoyageEmbeddingService(options: VoyageServiceOptions): Promise<EmbeddingService>; // voyage-service.ts
export function normaliseVoyageAnswer(answer: unknown): unknown;
export function sendBatch(ctx: SendContext, items: readonly DueItem[]): Promise<BatchResult>;  // send-batch.ts
export const runEmbedding: RunEmbeddingFn;                                                   // run-embedding.ts
export function parseEmbedArgs(argv: readonly string[]): ParsedEmbedArgs;                    // command.ts
export const runEmbedCommand: RunEmbedCommandFn;

// ---------------------------------------------------------------- src/db/*.ts (additions)
export function createRunWideHook(onWrite: WriteHook | undefined): WriteHook | undefined;    // writer.ts
export function toVectorLiteral(embedding: Embedding): string;                               // vector.ts ('[v1,...,v1024]')
export function parseVectorText(text: string): number[];                                     // vector.ts (caller gates with EmbeddingSchema)
export function selectTagLinksOfPlaces(db: Knex | Knex.Transaction, placeIds: readonly number[]): Promise<TagLinkRow[]>;   // read.ts
export function selectCommentRowsOfPlaces(db: Knex | Knex.Transaction, placeIds: readonly number[]): Promise<CommentRow[]>;
export function selectEmbeddingCandidates(trx: Knex.Transaction, input: EmbeddingCandidatesInput): Promise<EmbeddingCandidatesValue>;  // embedding-read.ts
export function selectEmbeddingRecord(db: Knex, placeId: number): Promise<ReadEmbeddingRecordValue>;
export function countEmbeddingStoreRows(db: Knex): Promise<EmbeddingStoreCounts>;
export function readEmbeddingStorageInfo(db: Knex): Promise<EmbeddingStorageInfo>;
export function saveEmbeddingRecordsStep(db: Knex, input: SaveEmbeddingRecordsInput,
  hook: WriteHook | undefined): Promise<SaveEmbeddingRecordsValue>;                          // embedding-save.ts; throws InvalidDataError or DB errors
export function validateEmbeddingCandidatesInput(input: unknown): Validated<EmbeddingCandidatesInput>;  // validate.ts
export function validateSaveEmbeddingRecordsInput(input: unknown): Validated<SaveEmbeddingRecordsInput>;
export const createEmbeddingStore: CreateEmbeddingStoreFn;                                   // embedding-store.ts

// ---------------------------------------------------------------- src/db/types.ts (additions)
export type EmbeddingRow = z.infer<typeof EmbeddingRowSchema>;   // and EmbeddingCountsRow, TypmodRow, KeyColumnRow, VectorIndexRow
export interface EmbeddingRowColumns {                            // one upsert row; embedding as Knex.Raw ('?::vector')
  place_id: number; embedding: Knex.Raw; embedding_model: string; document_fingerprint: string; embedded_at: string;
}
```

`InvalidDataError` (in `src/db/embedding-save.ts`, a class carrying `StoreIssue[]`, its type in `src/db/types.ts` if exported) lets the save step roll back and the store map it to `invalid_data` with those issues; every other throw maps to `store_unavailable` via `unavailableFrom`.

### 1.4 Detailed behaviour per subsystem

#### 1.4.1 Place Document (`place-document.ts`; AC-1 .. AC-16, rules 2 .. 4, D9)

Pure, deterministic, no I/O. Input is the `DetailedPlace` read-back shape (Tags and Comments already in read-back order).

```
buildPlaceDocument(place):
  parts: string[] = []
  name = tidySpacing(place.name);                         if name !== '' parts.push(name)              (no label)
  tags = place.tags.filter(t => t.presence === 'present').map(t => tidySpacing(t.title)).filter(nonEmpty)
                                                          if tags.length parts.push(LABELS.tags + tags.join(LIST_SEPARATOR))
  items = []
  for key of ADDRESS_ITEM_ORDER:                          street, houseNumber, city, place, state, country
     v = place.location[key]; if v === undefined continue
     t = tidySpacing(v); if t === '' or items.includes(t) continue                (exact comparison after tidying, AC-5)
     items.push(t)
                                                          if items.length parts.push(LABELS.address + items.join(LIST_SEPARATOR))
  d = tidySpacing(place.description.replace(BARE_WEB_ADDRESS, ' '))              (replace, never .test/.exec: the regex is global)
                                                          if d !== '' parts.push(LABELS.description + d)
  walk(siblings): for c of siblings (read-back order):
     if c.presence === 'present' && !c.isDeleted && !c.isBlocked:
        m = tidySpacing(c.message); if m !== '' parts.push(LABELS.comment + m)    (web addresses kept, Q3)
     walk(c.replies)                                       (replies of a left-out Comment are still walked, AC-11)
  walk(place.comments)
  return parts.join(PART_SEPARATOR)                       ('' = Empty Document)
```

- Bare Web Addresses are replaced by a space (then tidied), so `a http://x b` never glues `a` and `b`. Comment messages, names, Tag titles and address items keep them.
- No entity decoding, no case change, no Unicode normalisation, no cutting (AC-9, AC-10).
- `isDeleted` of the Place itself is ignored (Q4). Commenter IPs do not exist in the read-back shape; author names, votes, dates, outline, location, Wikipedia link and `detailsFetchedAt` are never read, so changes to them never change the Document (AC-20, AC-21).

#### 1.4.2 Scan-and-send loop (`run-embedding.ts`; AC-17 .. AC-33, AC-36, AC-43, rule 6, rule 10)

State: `queue: DueItem[]` (due, not yet sent, Embedding Order), `room = settings.embeddingLimit` (Places that may still be sent), `after: number | undefined` (last Place ID read), `scanDone = false`, `stop: Stop | undefined`, `batchNumber = 0`.

```
while true:
  if !scanDone and !scanHalted(stop):                       scanHalted = stop is 'interrupted' or a store failure
     r = store.listEmbeddingCandidates({ afterPlaceId: after, limit: MAX_PLACES_PER_STORE_CALL })   (afterPlaceId only when defined)
     !r.ok -> stop = { failed, r.failure.message }; continue (scan now halted)
     for c of r.value.places:
        document = buildPlaceDocument(c.place)
        if document === ''                          -> tally.considered('empty')
        else if !isEmbeddingDue(document, c.embeddingRecord) -> tally.considered('unchanged')
        else tally.considered('due');
             if stop !== undefined        -> nothing more (still due)
             else if room === 0           -> tally.limitHeld += 1                     (held back by the limit)
             else queue.push({ placeId, document, fingerprint: documentFingerprint(document) })
     after = last placeId of the page (if any); scanDone = r.value.places.length < MAX_PLACES_PER_STORE_CALL
  while stop === undefined:
     n = cutBatch(queue, room, settings.batchTokenLimit, scanDone); if n === 0 break
     if signal?.aborted -> stop = { interrupted }; break
     items = queue.splice(0, n); room -= n; batchNumber += 1
     res = await sendBatch(ctx, items)
     'kept'    -> (tally updated inside)                    progress `Batch k: kept n embeddings`
     'failed'  -> tally.failed(items, kind, reason)         Run goes on (AC-35, AC-38)
     'stopped' -> stop = res.stop                           items stay due (AC-36, AC-37, AC-42)
     if signal?.aborted and stop === undefined -> stop = { interrupted }   (in-flight Batch already kept or not, AC-43)
  if room === 0 and stop === undefined: tally.limitHeld += queue.length; queue = []   (due but no room, AC-29)
  if stop !== undefined: queue = []                                                    (unsent, still due; not limitHeld)
  if scanDone or scanHalted(stop): break
```

`tally.limitHeld` counts only Places held back by the limit; Places left unsent by a stop are simply still due. Rules that follow:

- **Reading continues after a stop or a used-up limit** (reads only, no requests) so the summary counts stay exact (AC-29: 2 still due; AC-36: 2 still due), except after `interrupted` (the Operator wants the process to end) and after a store failure (the store cannot be read). Counts then cover the Places read so far; the count invariants still hold.
- **Batches may span pages**: `cutBatch` returns 0 while the open Batch could still grow and the scan is not done, so a page boundary never closes a Batch (AC-27 gives 1000, 1000, 500 either way).
- **Limit counts Places sent**, Failed Places included (AC-32); Unchanged, Summary-Only and Empty never count (AC-30). Outcome `limit_reached` only when at least one due Place was held back by the limit (`limitHeld > 0`); exactly matching the limit ends `completed` (AC-31).
- **Kept before the next request** (AC-33): `sendBatch` awaits the save before it returns.
- **No transaction is open while a request or a wait is in progress**: every store call is its own short transaction (AC-44: a gated Run blocks nothing).

#### 1.4.3 Batch cutting (`batches.ts`; AC-27, AC-28, approved decision 4)

```
cutBatch(queue, room, tokenLimit, scanDone):
  cap = min(VOYAGE_MAX_TEXTS_PER_REQUEST, room); if cap <= 0 or queue.length === 0 return 0
  size = 0; n = 0
  for item of queue:
    if n === cap -> return n                                          (closed: 1,000 texts or no more room)
    est = estimateDocumentTokens(item.document)
    if n > 0 and size + est > tokenLimit -> return n                  (closed: next one does not fit)
    size += est; n += 1                                               (an oversize Document alone is taken as the 1st item)
  if n === cap -> return n
  return scanDone ? n : 0                                             (open Batch: wait for the next page unless the scan is done)
```

Pure; its unit tests check every result with the contract's `findBatchIssues`.

#### 1.4.4 One Batch (`send-batch.ts`; AC-18, AC-26, AC-34 .. AC-39, AC-45, AC-48, rule 8)

```
sendBatch(ctx, items):
  request: EmbeddingServiceRequest = { input: items.map(document), model: EMBEDDING_MODEL, inputType: DOCUMENT_INPUT_TYPE,
                                       outputDimension: EMBEDDING_DIMENSIONS, truncation: true }
  tally.batch(); progress `Batch k: sending n places`
  for attempt = 0; ; attempt += 1:
    tally.request()
    try answer = await Promise.resolve().then(() => service.embed(request))      (a synchronous throw is caught too)
    catch e:
      kind = classifyEmbeddingServiceError(e)
      'refused' -> return stopped { failed, refusedMessage(e) }                  (no retry, AC-37)
      'connection' | 'rate_limit':
         if attempt < EMBEDDING_RETRY_WAITS_SECONDS.length:
            if signal?.aborted -> return stopped { interrupted }
            progress `Batch k: <connection failure | rate limit>, retrying in <w> s`
            await clock.sleep(w * 1000)
            if signal?.aborted -> return stopped { interrupted }
            continue
         'connection' -> return failed { connection, 'connection failure after 3 tries' }   (AC-35)
         'rate_limit' -> return stopped { rate_limited, 'The Embedding Service kept answering with its rate limit after 3 tries.' }  (AC-36)
    embeddedAt = toMoment(clock.now())                                           (receive moment, AC-18)
    issues = findEmbeddingAnswerIssues(answer, items.length)
    issues.length -> return failed { invalid_answer, issues[0] }                 (no retry, AC-38)
    parsed = EmbeddingAnswerSchema.parse(answer)
    vectors[i] = parsed.data has indexes ? item with index i : parsed.data[i]    (AC-26)
    records = items.map((it, i) => ({ placeId, embedding: vectors[i], model: EMBEDDING_MODEL, documentFingerprint: it.fingerprint, embeddedAt }))
    s = await store.saveEmbeddingRecords({ records })
    ok                -> tally.embedded(n, parsed.usage.totalTokens); return kept  (tokens only for kept answers, AC-48)
    invalid_data      -> return failed { invalid_data, `the Place Store rejected the Embedding Records: ${s.failure.message}` }
    store_unavailable -> return stopped { failed, s.failure.message }            (AC-42)
```

- `refusedMessage(e)` = `The Embedding Service refused the request (HTTP <status>). Check ${VOYAGE_API_KEY_ENV} and the Voyage account.`; `<status>` only when `e.statusCode` is a number. The error's own message is never used: the SDK and simulated errors carry the key (AC-37, AC-51).
- Failed Place reports: one per item, in Batch order, `message` = `Place <id>: <reason>`. `reason` comes from the fixed texts above, `findEmbeddingAnswerIssues` (contract text) or a store failure message (already safe).
- Retry waits use the injected clock only (30 s, then 60 s; at most 3 requests per Batch). An abort during a real-clock wait ends the wait early (`createSystemCrawlClock`).
- The model kept is `EMBEDDING_MODEL`; an answer naming another model never gets this far (approved decision 3).

#### 1.4.5 Settings, key, messages (`settings.ts`; AC-40, AC-41)

```
resolveSettings(request, batchTokenLimit):
  r = EmbeddingRunRequestSchema.safeParse(request)                -> fail settingMessage(first issue)   (NaN, Infinity rejected by z.number)
  candidate = { embeddingLimit: r.data.embeddingLimit ?? DEFAULT_EMBEDDING_LIMIT,
                batchTokenLimit: batchTokenLimit ?? DEFAULT_BATCH_TOKEN_LIMIT }
  s = EmbeddingSettingsSchema.safeParse(candidate)                -> fail settingMessage(first issue)
  ok s.data
settingMessage(issue): key = issue.path[0] if it is in EMBEDDING_SETTING_KEYS
  key  -> `Invalid embedding setting "${key}": ${issue.message}`
  none -> `Invalid embedding request: ${formatIssuePath(issue.path)}: ${issue.message}`      (formatIssuePath from src/wikimapia/issues)
isMissingApiKey(k) = k === undefined || k.trim() === ''
```

Settings are checked before the key, the key before any database access or request. Only Zod messages and paths are used, never input values.

#### 1.4.6 Voyage adapter (`voyage-service.ts`; the SDK seam)

The contract's `EmbeddingService` uses the `voyageai` SDK's camelCase request names (`input`, `model`, `inputType`, `outputDimension`, `truncation`) and answer names (`data[].embedding`, `data[].index`, `model`, `usage.totalTokens`). The REST API is snake_case (`input_type`, `output_dimension`, `usage.total_tokens`); the SDK (Fern-generated `VoyageAIClient`) serializes requests to snake_case and deserializes answers to camelCase. The adapter is still required, because the SDK by default retries 408/429/5xx itself with exponential back-off, which would break the Run's request counts and 30 s / 60 s waits.

```
createVoyageEmbeddingService({ apiKey, baseUrl?, timeoutSeconds = 120 }):
  sdk = await import('voyageai')                              lazy: contract and unit tests that inject a service never load the SDK
  client = new sdk.VoyageAIClient({ apiKey, ...(baseUrl ? { environment: baseUrl } : {}) })
  return {
    embed: async (request) => {
      try   { return normaliseVoyageAnswer(await client.embed({ ...request }, { maxRetries: 0, timeoutInSeconds: timeoutSeconds })) }
      catch (e) { if statusCode(e) is a number in 200..299 return undefined        (unreadable 2xx body -> Invalid Embedding Answer, not Refused)
                  throw e }                                                          (rethrown unchanged: statusCode kept for the classifier)
    }
  }
normaliseVoyageAnswer(a): if a.usage is an object with numeric `total_tokens` and no `totalTokens`, return a copy with
  `usage.totalTokens` set; otherwise return `a` unchanged. (Guards against an SDK build that passes the raw body through.)
```

- **AL2 must verify against the installed SDK** (pin the exact version in `package.json`): the export name `VoyageAIClient`, the client option for the base URL (`environment`, or `baseUrl` in newer Fern builds), the per-request options `maxRetries` and `timeoutInSeconds`, that HTTP errors carry a numeric `statusCode` (`VoyageAIError`) and timeouts/network errors carry none (`VoyageAITimeoutError` / no status), and that `await import('voyageai')` works under `tsx` (`pnpm embed --limit x` reaches the settings failure) and under Vitest. If the ESM entry of the package cannot be loaded, stop and report to AL4; do not add `require`-based workarounds typed `any`.
- The adapter never logs, never reads `process.env` (the key is passed in), and never puts the key into an error.
- Unit tests run the adapter against a local `node:http` server on `127.0.0.1` (not a live call): it returns REST snake_case bodies and records requests.

#### 1.4.7 Tally, Run Summary, report (`report.ts`; AC-46 .. AC-48, AC-50)

- `snapshot()`: `detailedPlacesConsidered` = unchanged + empty + due counted; `placesEmbedded`; `unchangedSkipped`; `emptyDocumentsSkipped`; `summaryOnlySkipped`; `failedPlacesByKind` and `failedPlaces` (their sum); **`placesStillDue = detailedPlacesConsidered - placesEmbedded - unchangedSkipped - emptyDocumentsSkipped`** (so every invariant of `EmbeddingRunCountsSchema` holds by construction; Failed Places are part of it); `batchesSent`; `embeddingRequests`; `tokensUsed`.
- `buildReport`: `summary = { outcome, startedAt, endedAt, embeddingModel: EMBEDDING_MODEL, counts }`, `summaryText = formatSummaryText(summary)`, `failedPlaces = tally.failures`, `message` = stop message (required for `failed`, optional otherwise). Gate with `EmbeddingRunReportSchema.safeParse`; on failure return `failedReport('Embedding run failed: internal error (report check)', startedAt, endedAt)`.
- `failedReport`: `ZERO_EMBEDDING_COUNTS`, no Failed Places, the given moments (before-start failures use one moment for both).
- `endedAt = toMoment(clock.now())` is taken after the loop, before the store is closed (closing never changes the outcome).

`formatSummaryText(summary)`: lines joined with `\n`, one `Label: value` per line, in this order (labels from `EMBED_SUMMARY_LABELS`):

```
Run outcome: <EMBEDDING_OUTCOME_LABELS[outcome]>
Started at: <moment>
Ended at: <moment>
Embedding model: voyage-4
Detailed places considered: n
Places embedded: n
Unchanged places skipped: n
Summary-only places skipped: n
Empty documents skipped: n
Failed places: n
Failed places (connection failure): n           one line per kind in FailedPlaceKindSchema order (connection, invalid_answer, invalid_data)
Failed places (invalid embedding answer): n
Failed places (invalid data): n
Places still due for embedding: n
Batches sent: n
Embedding requests: n
Tokens used: n
```

Numbers with `String(n)`. The failure message is reported separately, never inside `summaryText`.

**Progress lines** (`deps.onProgress`, printed by the command): `Embedding run started: <n> summary-only places skipped`, `Batch <k>: sending <n> places`, `Batch <k>: <connection failure|rate limit>, retrying in <w> s`, `Batch <k>: kept <n> embeddings (<t> tokens)`, `Batch <k>: <n> failed places (<FAILED_PLACE_LABELS[kind]>)`, `Stopping: <outcome label>`. Never a key, URL, connection string, error message, Place Document text or Commenter IP.

#### 1.4.8 Embedding Store (`embedding-store.ts`, `embedding-read.ts`, `embedding-save.ts`; R2, AC-39, AC-53 .. AC-58)

Same pattern as `place-store.ts`: the factory never throws; `StoreConfigSchema` on the connection string, `createDb(connectionString, POOL_MAX_STORE)`; each method validates first (invalid input never reaches SQL), then `store_unavailable` "not configured" when there is no db, then the operation; a thrown `ZodError` from a read-back gate -> `store_unavailable` "stored data failed the read-back check"; `InvalidDataError` -> `invalid_data` with its issues; anything else -> `unavailableFrom(error, '<action>')`. One `createRunWideHook(options.onWrite)` per store (numbering across every write of the store's lifetime; the Run opens one store, so numbers are Run-wide). `close()` = `destroyQuietly`, idempotent.

| Method | Validation | Operation |
|---|---|---|
| `listEmbeddingCandidates` | `validateEmbeddingCandidatesInput` (`EmbeddingCandidatesInputSchema`: `limit` 1 .. 1000, `afterPlaceId` positive) | one read-only REPEATABLE READ transaction: `selectEmbeddingCandidates` |
| `saveEmbeddingRecords` | `validateSaveEmbeddingRecordsInput` (`SaveEmbeddingRecordsInputSchema`; issue paths `['records', i, ...]`) | `saveEmbeddingRecordsStep` |
| `readEmbeddingRecord` | existing `validatePlaceRef` | `selectEmbeddingRecord` |
| `countEmbeddingStore` | none | `countEmbeddingStoreRows` |
| `inspectEmbeddingStorage` | none | `readEmbeddingStorageInfo` |

`selectEmbeddingCandidates(trx, { afterPlaceId, limit })`, all bindings:

```
rows   = select <PLACE_COLUMNS>, <FETCHED_AT_TEXT_SQL> from places
         where details_fetched_at is not null [and place_id > ?] order by place_id limit ?
ids    = rows.map(place_id); if empty -> { places: [] }
links  = selectTagLinksOfPlaces(trx, ids)        (same select as TAG_LINKS_OF_PLACE_SQL with `where pt.place_id = any(?)` / whereIn)
cmts   = selectCommentRowsOfPlaces(trx, ids)     (select * from comments whereIn place_id order by place_id, num)
embs   = select place_id, embedding::text as embedding_text, embedding_model, document_fingerprint,
         to_char(embedded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as embedded_at_text
         from place_embeddings where place_id in (ids)
place  = toDetailedPlace(row, links of row, comments of row)     (the readPlace mapper: identical read-back, R2)
record = embs of row ? { placeId, embedding: parseVectorText(embedding_text), model, documentFingerprint, embeddedAt } : absent
gate   = EmbeddingCandidatesValueSchema.parse({ places })
```

Grouping by `place_id` happens in TS; `orderStoredTags` and `buildStoredComments` sort fully, so the multi-Place loaders' row order does not affect the result.

`saveEmbeddingRecordsStep(db, input, hook)`, one READ COMMITTED transaction:

```
db.transaction(async trx => {
  found = select place_id from places where place_id in (ids) and details_fetched_at is not null      (not a write)
  missing ids -> throw InvalidDataError([{ path: ['records', i, 'placeId'], message: 'is not a stored Detailed Place', placeId }])
  writer = createWriter(hook)
  for chunk of records in chunks of 100 (input order):
    await writer.run(trx(EMBEDDING_TABLE).insert(chunk.map(r => ({ place_id: r.placeId,
        embedding: trx.raw('?::vector', [toVectorLiteral(r.embedding)]), embedding_model: r.model,
        document_fingerprint: r.documentFingerprint, embedded_at: r.embeddedAt })))
      .onConflict('place_id').merge(['embedding', 'embedding_model', 'document_fingerprint', 'embedded_at']))
  return { saved: records.length }
})
```

A throw from a statement or the hook rolls the whole Batch back (AC-39, AC-42, AC-45). Each row is written by one statement, so a Place never holds a mixed record, also with two Runs at once (rule 13: last writer wins with a complete record).

`selectEmbeddingRecord`: the `embs` select for one id; gate `ReadEmbeddingRecordValueSchema` (`{ found: false, placeId }` when absent).

`countEmbeddingStoreRows`: `select (select count(*) from places where details_fetched_at is null) as summary_only_places, (select count(*) from places where details_fetched_at is not null) as detailed_places, (select count(*) from place_embeddings) as embedding_records` (int8 parsed by the connection's safe parser), gate `EmbeddingStoreCountsSchema`.

`readEmbeddingStorageInfo` (catalogue reads, table and column names as bindings, `to_regclass(?)`; missing table -> throws -> `store_unavailable`):

```
dimensions   = select a.atttypmod from pg_attribute a where a.attrelid = to_regclass(?) and a.attname = ? and not a.attisdropped
               (pgvector stores the dimension count directly as the type modifier)
key columns  = select a.attname::text from pg_index i cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
               where i.indrelid = to_regclass(?) and i.indisprimary order by k.ord
               onePerPlace = key columns equal ['place_id']
vector index = select ic.relname::text as name, am.amname::text as method, opc.opcname::text as operator_class,
               (i.indpred is not null) as partial
               from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
               cross join lateral unnest(i.indkey::int2[], i.indclass::oid[]) k(attnum, opclass)
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
               join pg_opclass opc on opc.oid = k.opclass
               where i.indrelid = to_regclass(?) and a.attname = ? order by ic.relname
gate         = EmbeddingStorageInfoSchema.parse({ table, column, dimensions, onePerPlace, vectorIndexes })
```

`vector.ts`: `toVectorLiteral` = `pgvector.toSql(embedding)` (input already gated by `EmbeddingSchema`, so only finite numbers); `parseVectorText` = `pgvector.fromSql(text)`; both typed through the package's own declarations. Values are stored as 32-bit floats: a production Embedding reads back rounded to float32 (fine for search); the contract's fake Embeddings are float32-exact and read back unchanged.

#### 1.4.9 Schema Setup change (`schema-setup.ts`; AC-53, AC-55, AC-58)

`emptyStore()` keeps its `_test` guard and its single transaction. Before the store truncate it probes `to_regclass('place_embeddings')` (binding) and runs either `TRUNCATE TABLE place_embeddings, place_tags, comments, tags, places` (table present) or today's `TRUNCATE TABLE place_tags, comments, tags, places`; the crawl-table part is unchanged. Including `place_embeddings` in the same `TRUNCATE` is required: its FK to `places` makes a truncate of `places` alone fail. Both texts are constants. After `undoLast` of step 7 the probe is false and the old path runs; after `undoAll` it still fails `store_unavailable` (existing behaviour). `apply`, `undoAll`, `undoLast`, `inspect` need no change (the step list comes from `MIGRATIONS`).

#### 1.4.10 Embed Command and script (`command.ts`, `scripts/embed.ts`; AC-40, AC-41, AC-49 .. AC-52)

```
parseEmbedArgs(argv):
  tokens = argv; drop one leading '--' (pnpm passthrough)
  only valued option: --limit (next token is the value, even if it starts with '-')
  unknown option or positional, missing value, --limit twice -> { ok: false, problem: `unknown option "x"` | `missing value for --limit` | `option --limit given twice` }
  value: /^-?\d+(?:\.\d+)?$/ -> Number(text), otherwise NaN (runEmbedding then names `embeddingLimit`, AC-41)
  -> { ok: true, request: { embeddingLimit? } }       (key only when given)

runEmbedCommand(argv, io):                            never rejects (try/catch -> failedReport internal error, exit 1)
  p = parseEmbedArgs(argv)
  !ok -> report = failedReport(`${problem}. ${usageMessage()}`, now, now)        (usage names --limit; nothing sent)
  ok  -> report = await runEmbedding(p.request, { connectionString: io.env.DATABASE_URL ?? '', apiKey?: io.env.VOYAGE_API_KEY,
                                                  embeddingService?, clock?, signal?, onProgress: io.write })   (keys only when defined)
  write report.message (if any) as one line, then each summaryText line
  return { exitCode: embedExitCodeFor(report.outcome), report }
```

`now` = `toMoment((io.clock ?? createSystemCrawlClock(io.signal)).now())`.

`scripts/embed.ts`: same shape as `scripts/crawl.ts`: `applyEnvDefaults(readEnvFile(<repo>/.env))`; `AbortController` aborted by `process.once('SIGINT' | 'SIGTERM')`; `write = line => process.stdout.write(line + '\n')`; `env` from `process.env[VOYAGE_API_KEY_ENV]` and `process.env[DATABASE_URL_ENV]` (keys only when defined); `await runEmbedCommand(process.argv.slice(2), { env, write, signal })`; listeners removed in `finally`; `process.exitCode = result.exitCode`. No `console.*`. The real Voyage adapter and clock are used.

`package.json`: `"embed": "tsx scripts/embed.ts"`; `"test:db"` extended with `contracts/embeddings.test.ts tests/embed`; dependencies `voyageai` (exact version) and `pgvector`.

`.env.example`: append `VOYAGE_API_KEY=` and `ANTHROPIC_API_KEY=` (one line each, empty values) after the two existing lines, which stay byte-identical (their hashes are checked, AC-52).

### 1.5 Transaction boundaries

| Operation | Boundary | Isolation / locking | On failure |
|---|---|---|---|
| Candidates read (one page) | one read-only transaction, 4 selects | REPEATABLE READ | `store_unavailable`; Run ends Failed |
| Keep a Batch (`saveEmbeddingRecordsStep`) | one transaction: Detailed-Place check + upsert statements (100 rows each) | READ COMMITTED; row locks of the upserted `place_embeddings` rows only | full rollback: no record of the Batch changes (AC-39, AC-45); `invalid_data` -> Failed Places, otherwise Run ends Failed |
| Record read, counts, storage inspection | single statements | | `store_unavailable` |
| Schema step 7 | one transaction (Knex default) | Knex migration lock | `store_unavailable` |
| `emptyStore` | one transaction (unchanged) | | `store_unavailable` |

No transaction or lock is ever held across an Embedding Request or a retry wait. Place Store saves (Listing, Details) never touch `place_embeddings` (no statement of `save-listing.ts` / `save-details.ts` changes; places are never deleted), so Embedding Records outlive them (AC-56).

## 2. Data Model Design (Declarative)

### 2.1 `place_embeddings` (Embedding Records)

| Column | Type | Null | Rule |
|---|---|---|---|
| `place_id` | `bigint` | not null | PK `place_embeddings_pkey`; FK `place_embeddings_place_id_fkey` -> `places(place_id)` `ON DELETE CASCADE` (an Embedding never outlives its Place, which carries the Wikimapia Link for attribution) |
| `embedding` | `vector(1024)` | not null | pgvector enforces exactly 1024 dimensions and finite values; written only through `?::vector` |
| `embedding_model` | `text` | not null | `CHECK (embedding_model <> '')` (`place_embeddings_embedding_model_not_empty`); any non-empty name (an older model may be stored, AC-23); the Run writes only `voyage-4` |
| `document_fingerprint` | `text` | not null | `CHECK (document_fingerprint ~ '^[0-9a-f]{64}$')` (`place_embeddings_document_fingerprint_valid`) |
| `embedded_at` | `timestamptz(0)` | not null | Embedded At; written as the contract's whole-second ISO text, read with `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` |

Indexes: the PK btree (lookups and the candidates join); `place_embeddings_embedding_hnsw_idx` `USING hnsw (embedding vector_cosine_ops)`, not partial, pgvector default build parameters (`m = 16`, `ef_construction = 64`). Stage 2 queries order by `embedding <=> ?::vector` inside a PostGIS-filtered candidate set and may tune `hnsw.ef_search` per query; that is out of scope here.

Column and table rules: `place_embeddings` is the only table and `embedding` the only column with `vector` type or an `embedding|vector` name (storage AC-5 as replaced, AC-57). No text derived from Wikimapia (no Place Document) is stored: only the vector, the model name, the fingerprint and the moment. No `inet`/`cidr`, no Commenter IP.

No Objection model: the table is written by one upsert and read by a few fixed selects; vector columns need `knex.raw` anyway. Row shapes are parsed with Zod in `rows.ts`: `EmbeddingRowSchema` (`place_id` number, `embedding_text` string, `embedding_model` string, `document_fingerprint` string, `embedded_at_text` string), `EmbeddingCountsRowSchema` (three numbers), `TypmodRowSchema`, `KeyColumnRowSchema`, `VectorIndexRowSchema`.

### 2.2 Migration (Schema Setup step 7)

| Step name | Up | Down |
|---|---|---|
| `20261023_01_create_place_embeddings` | `createTable('place_embeddings')` with `bigInteger('place_id')`, `specificType('embedding', 'vector(1024)')`, `text` columns, `timestamp('embedded_at', { useTz: true, precision: 0 })`, all not null, named PK, FK and checks; then `knex.raw('CREATE INDEX place_embeddings_embedding_hnsw_idx ON place_embeddings USING hnsw (embedding vector_cosine_ops)')` | `dropTable('place_embeddings')` (drops its index) |

Appended to `MIGRATIONS` as the 7th, newest step. It touches no earlier table, so applying or undoing it leaves every Place, Comment, Tag, Place-Tag Link, Crawl Progress entry, Run Record and Failure Record unchanged (AC-53, AC-55); Places start with no Embedding Record. The `vector` extension is already enabled by step 1; `undoAll` undoes step 7 before step 1, so step 1's `DROP EXTENSION vector` (no `CASCADE`) still succeeds. The Docker image's `postgresql-16-pgvector` (PGDG, >= 0.5) supports HNSW.

## 3. Batch & External Calls

The Embedding Run is an offline batch job calling Voyage AI only (no Anthropic, no Wikimapia). All waits run on the injected clock (Simulated Clock in tests; nothing waits on real time in tests, AC-60).

| External call | Unit of work | Limits / pacing | Timeout | Retry / back-off | Stop conditions |
|---|---|---|---|---|---|
| Voyage `POST /v1/embeddings` via `VoyageAIClient.embed` (`model: voyage-4`, `inputType: document`, `outputDimension: 1024`, `truncation: true`) | one Batch: 1 .. 1,000 Place Documents, estimated size <= Batch Token Limit (320,000; estimate = UTF-8 bytes + 16 per text), except one oversize Document alone | sequential, one request in flight; no client-side pacing (a default Run is one request; Voyage's per-minute limits are far above a sequential job); Embedding Limit per Run (default 1,000 Places, `--limit`) | 120 s per request (SDK `timeoutInSeconds`); a timeout is a Connection Failure | SDK retries off (`maxRetries: 0`). Connection Failure (no status, 408, 5xx) and Service Rate Limit (429): 2 extra tries after 30 s, then 60 s. Service Refused (other 4xx): no retry. Invalid Embedding Answer: no retry | Rate Limit persists -> Rate Limited (clean); Refused -> Failed; Store Unavailable -> Failed; interrupt -> Interrupted; limit used up -> Limit Reached. Connection Failure that persists or Invalid Answer -> that Batch's Places are Failed Places, the Run goes on |

**Batch shape per Run:** read Detailed Places in pages of 1,000 in ascending Place ID; build each Place Document; queue the Embedding Due ones; cut Batches greedily across pages; send one Batch, keep its records in one transaction, then send the next.

**Idempotency and resumability:**
- Skip by Document Fingerprint and model (`isEmbeddingDue`): a rerun after any stop or crash sends only Places whose Document changed, that have no record, or whose record is from another model; unchanged text is never re-embedded (AC-19 .. AC-23, AC-44).
- One row per Place (`place_id` PK), written by `INSERT ... ON CONFLICT (place_id) DO UPDATE`: a rerun never duplicates rows (AC-22, AC-53).
- Each Batch is kept in full before the next request (AC-33); a crash loses at most the Batch in flight, which a later Run sends again.
- No progress table is needed (rule 6) and none is added (AC-46: the Run Summary is not stored).
- Two Runs at once are not prevented (Q8); the worst case is a Place embedded twice, never a mixed record (rule 13, AC-45).

**Cost sizing (from AL6 rule 10, not tested):** about 50 tokens per Place Document at the current data profile; 1,000 Places per default Run = about 50,000 tokens, well inside Voyage's 200M free tokens.

**Licensing:** Place Documents are sent to Voyage only for embedding (a decided use, CLAUDE.md); Embeddings are Wikimapia-derived (CC BY-NC-SA 3.0), stay linked to their Place, are never committed and never bulk-exported.

## 4. Implementation Units

Units are ordered by dependency; each fits one AL3 -> AL2 iteration. `contracts/embeddings.test.ts` imports all four entry points, so it can only run once U7 exists; the ACs listed for U1 .. U6 are the ones each unit implements, and U7 verifies them end to end. `contracts/embeddings.schema.test.ts`, `contracts/hydration*.test.ts`, `contracts/crawl-run1-fixes*.test.ts`, `contracts/storage*.test.ts`, `contracts/wikimapia-client*.test.ts` and all existing `tests/` must stay green from the unit where they become green (storage AC-5 from U1).

**Baseline caveat:** until U7, `pnpm exec tsc --noEmit` and `pnpm lint` report only the unresolved-import errors of `contracts/embeddings.test.ts` for the entry modules that do not exist yet (`src/db/embedding-store`, `src/embed/command`, `src/embed/place-document`, `src/embed/run-embedding`). "No new errors" below means only those. **DB precondition** for every unit with a database test: `pnpm db:up` has been run and `.env.test` exists.

### U1. Embedding storage schema step, `emptyStore` extension, existing schema tests

- **Scope:** the new migration step and its registration; `emptyStore()` truncating `place_embeddings`; updating the existing schema tests that assume step 6 is the newest.
- **Files:** `src/db/migrations/20261023_01_create_place_embeddings.ts`, `src/db/migrations/index.ts`, `src/db/schema-setup.ts`, `tests/db/schema-setup.db.test.ts`, `tests/db/crawl-schema.db.test.ts`, `tests/db/embedding-schema.db.test.ts` (new)
- **Design refs:** 1.4.9, 2.1, 2.2
- **Implements ACs:** AC-53, AC-54 (index exists), AC-55, AC-57 (structure side), AC-58 (emptying side); makes `contracts/storage.test.ts` "AC-5 Vectors only in the Embedding Record of a Place" green; keeps storage AC-1 .. AC-4, AC-6, AC-14, AC-61, hydration AC-55 .. AC-57 and crawl-run1-fixes AC-41, AC-42 green
- **Existing tests to update (test-writer owns `tests/`):**
  - `tests/db/schema-setup.db.test.ts`: `STEP_NAMES` gains `20261023_01_create_place_embeddings` (7 steps; "six" in test titles becomes "seven"); add `EMBEDDINGS_STEP` and `UP_TO_FAILURES_STEPS = STEP_NAMES.slice(0, 6)`; every `undoLast` sequence first undoes `EMBEDDINGS_STEP` (the "undoes exactly step 6" case becomes "undoes exactly step 7, then step 6 ..."; the "after undoLast of step 6" and "after two undoLast" `emptyStore` cases get one extra leading `undoLast`); `after.pendingSteps` expectations gain the new step; the "AC-5: no vector or embedding table or column" case is replaced by: the only `vector` column is `place_embeddings.embedding`, and no other table or column name matches `/embedding|vector/i`; `EXPECTED_COLUMNS` gains `place_embeddings` (`place_id int8`, `embedding vector`, `embedding_model text`, `document_fingerprint text`, `embedded_at timestamptz`).
  - `tests/db/crawl-schema.db.test.ts` (line ~487): "step 6 is the newest applied step" becomes "step 6 is applied directly after step 5" (`appliedSteps.indexOf(FAILURES_STEP) === appliedSteps.indexOf(CRAWL_STEP) + 1`), without asserting it is the last.
- **Unit tests must cover (new `embedding-schema.db.test.ts`):** `apply` from nothing returns 7 steps in order; `undoLast` returns exactly `['20261023_01_create_place_embeddings']`, removes `place_embeddings` (and with it every `vector` column) and leaves a stored Place, Tag, Comment and a crawl Run row unchanged, re-`apply` returns that step only; a row inserted through the test's own `testDb()` Knex handle (`?::vector` of a generated 1024-value list) is accepted for a stored Place; inserts are rejected for 1023 values, for a missing Place (FK), for `embedding_model = ''`, for an upper-case or 63-char fingerprint, and for a second row of the same Place (PK); `emptyStore` removes that row together with the Place and still works after `undoLast` of step 7; `pg_indexes` shows `place_embeddings_embedding_hnsw_idx` using `hnsw` and `vector_cosine_ops` (via `setup.inspect()` for columns; the index check may read `pg_indexes` through `testDb()` as the existing tests do for seeding).
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db/schema-setup.db.test.ts tests/db/crawl-schema.db.test.ts tests/db/embedding-schema.db.test.ts contracts/storage.test.ts contracts/storage.schema.test.ts contracts/crawl-run1-fixes.test.ts contracts/hydration.test.ts` passes
  - `pnpm db:migrate` on the Development Database applies one new step; `pnpm db:status` lists 7 applied
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U2. Embedding Store (public `createEmbeddingStore`)

- **Scope:** vector encoding, row schemas, validators, multi-Place read loaders, the R2 candidates read, record read, counts, storage inspection, the all-or-nothing save, the public store; shared Run-wide hook.
- **Files:** `package.json` (add `pgvector`), `src/db/vector.ts`, `src/db/rows.ts`, `src/db/types.ts`, `src/db/validate.ts`, `src/db/read.ts` (exports + two loaders), `src/db/writer.ts` (`createRunWideHook`), `src/db/crawl-repository.ts` (use it; no behaviour change), `src/db/embedding-read.ts`, `src/db/embedding-save.ts`, `src/db/embedding-store.ts`, `tests/db/vector.test.ts`, `tests/db/writer.test.ts` (new cases), `tests/db/validate.test.ts` (new cases), `tests/db/embedding-store.db.test.ts`
- **Depends on:** U1
- **Design refs:** 1.4.8, 1.5, 2.1
- **Implements ACs:** R2, AC-39, AC-53 (one per Place, dimensions), AC-54, AC-56, AC-57 (dimension side), AC-58 (counts)
- **Unit tests must cover:** `toVectorLiteral` / `parseVectorText` round-trip `fakeEmbedding('x')` exactly; `createRunWideHook` numbers 1, 2, 3 across two writers; the R2 contract data set (recorded listing, 1381893, synthetic 300, 62587 with a record) lists `[300, 62587, 1381893]`, each `place` `toStrictEqual` `PlaceStore.readPlace`, the record only on 62587, paging with `afterPlaceId: 300, limit: 1` gives `[62587]`; a Place with Gone Tags, nested Replies and a Gone Comment reads back identically to `readPlace`; `limit` 0 / 1001 and `afterPlaceId` -1 -> `invalid_data` without DB access; unreachable URL -> `store_unavailable` without password or `postgres://`; save of one record then a second for the same Place keeps 1 row with the second's values; every AC-39 bad record (1023/1025/1536 values, NaN, -Infinity, empty model, missing or empty fingerprint) -> `invalid_data`, earlier record unchanged; one bad record among good ones keeps nothing; a Summary-Only or unknown Place -> `invalid_data` with path `['records', i, 'placeId']`; a hook throwing at write 1 rolls back the Batch and resolves `store_unavailable` without the hook's message; 250 records are written in 3 statements (hook called 3 times); a Details Save and a Listing Save after a kept record leave it unchanged (AC-56); `countEmbeddingStore` = `{ summaryOnlyPlaces, detailedPlaces, embeddingRecords }`; `inspectEmbeddingStorage` = dimensions 1024, `onePerPlace` true, one index `hnsw` / `vector_cosine_ops`, not partial; `inspectEmbeddingStorage` after `undoLast` -> `store_unavailable`; `tests/db/crawl-repository.db.test.ts` stays green.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/db` passes
  - `pnpm exec eslint src/db tests/db` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `src/db/embedding-store` import error is gone)

### U3. Place Document builder

- **Scope:** the pure Place Document of 1.4.1.
- **Files:** `src/embed/place-document.ts`, `src/embed/types.ts` (created; only what this module needs, if anything), `tests/embed/place-document.test.ts`
- **Depends on:** none (pure; may run in parallel with U1/U2)
- **Design refs:** 1.4.1
- **Implements ACs:** AC-1 .. AC-14, AC-16 (pure side; AC-1, AC-4, AC-10 .. AC-13 through the Place Store are verified in U7)
- **Unit tests must cover** (`detailedPlace`, `storedTags`, `storedComments` from `contracts/embeddings.support.ts`): the AC-1 document of a read-back-shaped Synthetic Place K equals `K_DOCUMENT`; AC-2 order and labels; AC-3 name only (also with only Gone Tags/Comments); AC-5 repeated and case-differing address values; every AC-6 and AC-7 case including `awww.`; AC-8 tidying of every Part kind incl. CR LF and a blank Tag title; AC-9 entities, Cyrillic, diacritics kept; AC-10 a 7,000+ character description kept whole; AC-11 deleted/blocked/Gone Comments left out while their Present Replies are kept; AC-12 depth-first order A, A1, A1x, A2, B; AC-13; AC-14; an all-blank Place gives `''`; a Place marked deleted is built like others; same input twice gives identical text and `documentFingerprint`; the input object is not mutated; `a http://x b` gives `Description: a b`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/embed/place-document.test.ts contracts/embeddings.schema.test.ts` passes
  - `pnpm exec eslint src/embed tests/embed` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `src/embed/place-document` import error is gone)

### U4. Pure Run core: settings, Batch cutting, tally and summary

- **Scope:** everything of the Run that needs neither database nor network.
- **Files:** `src/embed/types.ts`, `src/embed/settings.ts`, `src/embed/batches.ts`, `src/embed/report.ts`, `tests/embed/settings.test.ts`, `tests/embed/batches.test.ts`, `tests/embed/report.test.ts`
- **Depends on:** U3 (types file)
- **Design refs:** 1.3, 1.4.3, 1.4.5, 1.4.7
- **Implements ACs:** AC-27, AC-28, AC-29 .. AC-32 (cutting side), AC-40, AC-41 (messages), AC-46, AC-47, AC-48 (formatting and counting side), AC-50 (via `embedExitCodeFor`)
- **Unit tests must cover:** `resolveSettings` defaults (1,000 and 320,000); failures naming `embeddingLimit` for 0, -1, 1.5, NaN, Infinity and `batchTokenLimit` for 0 and 2.5, messages free of the input value; `isMissingApiKey` for undefined, '', '   ', ' \t '; `cutBatch`: 2,500 equal small items and room 3,000 give 1000, 1000, 500; a token limit of 2 items gives batches of 2, 2, 1; an oversize first item is taken alone; room 3 caps at 3; with `scanDone` false an open Batch returns 0 and the same queue with `scanDone` true returns all; every split passes `findBatchIssues`; tally of the AC-47 scenario gives exactly its counts and passes `EmbeddingRunCountsSchema`; `formatSummaryText` produces exactly the lines of 1.4.7 in order; `buildReport` passes `EmbeddingRunReportSchema` for completed, limit_reached, failed (with message); `failedReport` has zero counts and no Failed Places.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/embed contracts/embeddings.schema.test.ts` passes
  - `pnpm exec eslint src/embed tests/embed` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U5. Voyage adapter and one Batch

- **Scope:** the production `EmbeddingService` over the `voyageai` SDK, and `sendBatch` (request, retries, classification, answer validation, mapping, save).
- **Files:** `package.json` (add `voyageai`, exact version), `src/embed/types.ts`, `src/embed/voyage-service.ts`, `src/embed/send-batch.ts`, `tests/embed/voyage-service.test.ts`, `tests/embed/send-batch.db.test.ts`
- **Depends on:** U2, U4
- **Design refs:** 1.4.4, 1.4.6, section 3
- **Implements ACs:** AC-18 (request shape, Embedded At), AC-26, AC-34 .. AC-39, AC-45, AC-48 (Batch side), AC-51 (no error text copied)
- **Unit tests must cover:**
  - `voyage-service.test.ts` (local `node:http` server on `127.0.0.1`, `baseUrl` option, synthetic key `TEST_VOYAGE_API_KEY`, vectors generated in code): the request body is snake_case with `input`, `model: voyage-4`, `input_type: document`, `output_dimension: 1024`, `truncation: true` and the header `Authorization: Bearer <synthetic key>`; a REST answer with `usage.total_tokens` comes back with `usage.totalTokens` and passes `findEmbeddingAnswerIssues`; 401, 403, 400 throw errors whose `statusCode` makes `classifyEmbeddingServiceError` return `refused`, 429 `rate_limit`, 503 and 408 `connection`; each of those sends exactly 1 HTTP request (SDK retries off); a closed port and a server slower than a 1 s test timeout throw without `statusCode` (`connection`); a 200 with a non-JSON body resolves to something `findEmbeddingAnswerIssues` rejects; `normaliseVoyageAnswer` pure cases. No `fetch` is stubbed; nothing leaves `127.0.0.1`.
  - `send-batch.db.test.ts` (Test Database, real `createEmbeddingStore`, `SimulatedEmbeddingService` and `SimulatedEmbeddingClock`): a normal answer keeps records with `embeddedAt` = the Simulated Clock moment after a 5 s delayed answer and adds its tokens; connection failure then normal waits 30 s and makes 2 requests; persistent connection failure makes 3 requests 30 s and 60 s apart and returns `failed` `connection`; persistent 429 returns `stopped` `rate_limited`; 401 returns `stopped` `failed` with a message matching `/Embedding Service refused/i` and without the key or `Bearer`; every AC-38 answer returns `failed` `invalid_answer` after 1 request and keeps nothing; an answer from model `voyage-3.5` is `invalid_answer`; indexed answers out of order map by index; an aborted signal before a retry returns `stopped` `interrupted` without a further request; a hook failing on the save returns `stopped` `failed`.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/embed tests/db/embedding-store.db.test.ts` passes
  - `pnpm exec tsx -e "await import('voyageai')"` (or an equivalent one-line probe) loads the SDK without error
  - `pnpm exec eslint src/embed tests/embed` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors

### U6. The Run: `runEmbedding`

- **Scope:** orchestration of 1.2 and the scan-and-send loop of 1.4.2: settings, key, interrupt at start, default service, store lifecycle, scanning, Batches, stops, report.
- **Files:** `src/embed/run-embedding.ts`, `src/embed/types.ts`, `tests/embed/run-embedding.db.test.ts`
- **Depends on:** U3, U4, U5
- **Design refs:** 1.2, 1.4.2, 1.4.7, 1.5
- **Implements ACs:** AC-15, AC-17 .. AC-48 (end to end through `runEmbedding`), AC-51 (Run output), AC-60 (no service built when injected)
- **Unit tests must cover** (Test Database, Simulated Embedding Service and Clock; a small subset, the contract file is the full net): the AC-47 scenario gives exactly its counts and `completed`; 5 due with limit 3 ends `limit_reached`, 3 embedded, 2 still due, and the next Run sends 2 and ends `completed`; exactly 3 due with limit 3 ends `completed`; 1,001 small Places spanning two pages with the default limit end `limit_reached` with 1 still due; a Batch that is open at a page boundary is not closed by it (seed 1,000 Unchanged then 2 due: one request of 2); a persistent rate limit on Batch 2 of 3 stops `rate_limited` with 2 still due and no request for Batch 3; refused on Batch 2 ends `failed` with Batch 1 kept; an injected `onWrite` failing on the second Batch ends `failed` after exactly 2 requests; an aborted signal at the start sends nothing and opens no pool; an unreachable connection string ends `failed` with the summary text and no secrets; a missing key with an injected service ends `failed` naming `VOYAGE_API_KEY`; every Run closes its pool (30 Runs in a loop keep the test database's `pg_stat_activity` count bounded, read through the test's `testDb()` handle); progress lines and the JSON report contain no key, `Bearer`, password, `postgres://` or Place Document text.
- **Done when:**
  - `pnpm exec vitest run --no-color tests/embed tests/db` passes
  - `pnpm exec eslint src/embed tests/embed` reports no problems
  - `pnpm exec tsc --noEmit` reports no new errors (the `src/embed/run-embedding` import error is gone)

### U7. Embed Command, script, environment file and contract green

- **Scope:** argument parsing, output, exit codes, the `tsx` script, package scripts, `.env.example`; full contract verification.
- **Files:** `src/embed/command.ts`, `src/embed/types.ts`, `scripts/embed.ts`, `package.json` (`embed`, extended `test:db`), `.env.example`, `tests/embed/command.test.ts`
- **Depends on:** U6
- **Design refs:** 1.4.10, 0.1
- **Implements ACs:** AC-49, AC-50, AC-51 (command), AC-52; all ACs end to end
- **Unit tests must cover** (`parseEmbedArgs` pure; `runEmbedCommand` with the Simulated Embedding Service and Clock): no options; `--limit 2`; a leading `--` ignored; `--limit` twice, `--limit` without value, `--dry-run`, `--region`, `extra` -> Failed with a usage message containing `--limit`, exit 1, nothing sent; `--limit abc`, `0`, `-3`, `2.5` -> Failed naming the setting; the written lines contain every `summaryText` line; exit codes follow `embedExitCodeFor` for Completed, Limit Reached, Rate Limited (0), Failed, Interrupted (1); an env without `VOYAGE_API_KEY` fails naming it; an env without `DATABASE_URL` fails without secrets.
- **Done when:**
  - `pnpm exec vitest run --no-color contracts/embeddings.test.ts contracts/embeddings.schema.test.ts contracts/storage.test.ts contracts/crawl-run1-fixes.test.ts contracts/hydration.test.ts` passes
  - `pnpm exec vitest run --no-color` (whole suite: `contracts/` and `tests/`) passes
  - `pnpm embed --limit abc` prints a message naming the setting and `Run outcome: Failed`, exits 1, and sends nothing; `pnpm embed` with `VOYAGE_API_KEY` unset in the shell and in `.env` prints the missing-key message and exits 1 (no live Voyage call is made by the developer as part of AL2 verification)
  - `pnpm exec tsc --noEmit` reports **0 errors**
  - `pnpm lint` reports **0 problems**

## 5. AL2 Guidance (pitfalls)

- **Never copy error messages** from the Embedding Service, the SDK, Knex, pg or the hook into a message, a Failed Place report or a progress line. The simulated errors deliberately carry `Bearer <key>`; AC-37, AC-42 and AC-51 check for it.
- **SDK retries off.** Every `client.embed` call passes `maxRetries: 0`; otherwise request counts (AC-34, AC-35, AC-48) and waits are wrong and a 429 is waited out twice.
- **Lazy SDK import.** `voyageai` is imported only inside `createVoyageEmbeddingService` (`await import`), with `import type` for its types elsewhere; the Run builds it only when no service is injected and the key is present.
- **No transaction across requests or waits.** Each store call is its own short transaction; the AC-44 test runs a second Run while the first is blocked inside a request.
- **Global regex.** `BARE_WEB_ADDRESS` has the `g` flag: use it only with `String.prototype.replace`, never `.test` or `.exec` (they keep `lastIndex` state).
- **Moments:** always `toMoment(clock.now())`; Embedded At is taken after the answer resolved, before validation and save.
- **`exactOptionalPropertyTypes`:** build `EmbeddingDependencies`, `EmbeddingRunRequest`, `EmbeddingCandidatesInput.afterPlaceId`, `EmbeddingCandidate.embeddingRecord` and report `message` with conditional spreads; never assign `undefined`.
- **Counts by construction:** derive `placesStillDue` and `failedPlaces` (1.4.7) instead of counting them separately, so `EmbeddingRunCountsSchema` cannot fail.
- **Close every pool:** `runEmbedding` opens exactly one Embedding Store (after the before-start checks) and closes it in `finally`.
- **Test files:** never paste vectors as literals (AC-59 scans `tests/` for runs of 1024 numbers and for files over 512 KB); never call Voyage, Anthropic or Wikimapia; the adapter test talks only to its own `127.0.0.1` server with the synthetic key.
- **Imports:** `import knex from 'knex'` + `import type { Knex } from 'knex'`, `import pg from 'pg'` as in the storage design; check the `pgvector` import form against its typings (`import pgvector from 'pgvector'`); relative imports extensionless; check `pnpm embed` under `tsx` (Vitest interop hides ESM import problems).
- **`unknown`:** only for caught errors, the raw service answer, raw Knex/pg results parsed on the next line (catalogue reads, counts, `to_regclass`), and the two new validators' parameters.
- **Output:** `process.stdout.write` only (ESLint `no-console`); the command prints through `io.write`.
- Do not edit `contracts/` or its fixtures. If a contract looks wrong, stop and report it (`.agrules` section 0).
