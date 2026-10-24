/**
 * AL5 CONTRACT: Embeddings, the Embedding Run (feature `embeddings`, Stage 1 substep 4).
 *
 * Layer:    AL5 (Contracts). Source of truth for AL4 design and AL2 implementation.
 * Derives:  docs/al6-requirements/20261023-embeddings-al6.md (revision 2, AC-1 .. AC-62, rules
 *           1 .. 13, R1, R2, stakeholder decisions Q1 .. Q8, D9, D10), intent
 *           docs/al7-intent/20261023-embeddings-al7.md. Voyage limits (AL6 assumption 9) taken
 *           from docs.voyageai.com/reference/embeddings-api (fetched 2026-10-23): at most 1,000
 *           texts and 320,000 tokens per request for `voyage-4`, output dimension 1024 (default).
 * Enforces: .agrules section 1 "Offline Ingestion" (an offline batch job, idempotent by Document
 *           Fingerprint, resumable because every Batch is kept before the next request; search
 *           never embeds stored content), section 2 "One Embedding Model per Column" (exactly
 *           1024 finite numbers from `voyage-4`, the model name kept with every Embedding,
 *           stored text sent as `inputType: "document"`; every other length is rejected by
 *           EmbeddingSchema and by the Place Store), section 2 "Validated output" (every
 *           Embedding Service answer is parsed with EmbeddingAnswerSchema before use; an invalid
 *           one is a handled Invalid Embedding Answer), section 3 (all SQL, including the R2
 *           read and the HNSW cosine index, lives in `src/db/`; the storage is added by a
 *           versioned Schema Setup step), section 4 "Licensing" (Embeddings stay linked to their
 *           Place, which keeps its Wikimapia Link), "No Data or Secrets in Git", "No Commenter
 *           IPs", "No Live External Calls in Tests" and "Strict Types Only" (all I/O typed
 *           through `z.infer`).
 *
 * Reuses the Place Store shapes from ./storage.schema (DetailedPlace, results, WriteHook,
 * StoreConfig) and the Crawl's clock and moments from ./hydration.schema (CrawlClock, Moment,
 * toMoment, the 30 / 60 second retry waits).
 *
 * Public entry points (black box for ./embeddings.test.ts):
 * - `src/embed/run-embedding.ts`  exports `runEmbedding: RunEmbeddingFn`             (ENTRY_POINT)
 * - `src/embed/place-document.ts` exports `buildPlaceDocument: BuildPlaceDocumentFn` (PLACE_DOCUMENT_ENTRY_POINT)
 * - `src/embed/command.ts`        exports `runEmbedCommand: RunEmbedCommandFn`       (EMBED_COMMAND_ENTRY_POINT)
 * - `src/db/embedding-store.ts`   exports `createEmbeddingStore: CreateEmbeddingStoreFn` (EMBEDDING_STORE_ENTRY_POINT)
 * - `src/db/schema-setup.ts`      exports `createSchemaSetup` (finished; its newest step adds the
 *   Embedding Record storage, and `emptyStore()` also removes every Embedding Record, AC-58)
 * - `package.json` script `embed` runs the Embed Command through `tsx` (EMBED_SCRIPT, AC-49).
 *
 * How the requirements on earlier substeps are closed (AL6 section 5):
 * - R1 (Schema Setup, storage checks): a new Schema Setup step, the newest, creates the table
 *   EMBEDDING_TABLE with one row per Place (EMBEDDING_COLUMNS, `embedding vector(1024)`) and an
 *   HNSW index with operator class `vector_cosine_ops` over the whole column. Storage AC-5 (as
 *   narrowed by Hydration AC-55) is replaced in ./storage.test.ts by "the only vector column is
 *   `place_embeddings.embedding`" (AC-57); its 1024 dimensions are checked in ./embeddings.test.ts
 *   through `EmbeddingStore.inspectEmbeddingStorage`. crawl-run1-fixes AC-41 in
 *   ./crawl-run1-fixes.test.ts undoes newest-first until its table is gone, as Hydration AC-56
 *   already did, because its step is no longer the newest.
 * - R2 (Place Store read): the finished `PlaceStore` interface is left unchanged. The new
 *   EmbeddingStore (in `src/db/`) reads Detailed Places in ascending Place ID, each in exactly
 *   the `DetailedPlace` read-back shape of Storage AC-49 together with its Embedding Record, and
 *   keeps the Embedding Records of a Batch in one all-or-nothing step.
 *
 * Embedding Service seam: the Run talks to Voyage only through `EmbeddingService`, whose single
 * method has the name and request shape of the `voyageai` package's `VoyageAIClient.embed`
 * (camelCase: `input`, `model`, `inputType`, `outputDimension`, `truncation`). Production code
 * passes a `VoyageAIClient` built with VOYAGE_API_KEY (or a thin adapter to it); every test
 * passes a Simulated Embedding Service (./embeddings.support.ts). The answer is untrusted and
 * parsed with EmbeddingAnswerSchema; a thrown error is classified by
 * `classifyEmbeddingServiceError`.
 *
 * Over-long single texts (AL6 assumption 9): requests leave Voyage's `truncation` at its default
 * (`true`), so a Place Document longer than the model's context is truncated by the service, not
 * rejected. A Place Document whose estimate alone exceeds the Batch Token Limit is sent in a
 * Batch of its own. With the expected sizes (at most several thousand characters) neither case
 * occurs in practice.
 *
 * Every entry point resolves (never rejects): `runEmbedding` and `runEmbedCommand` to an
 * `EmbeddingRunReport`; EmbeddingStore calls to a Store result; `buildPlaceDocument` returns.
 *
 * Embeddings and Place Documents are derived from Wikimapia data, CC BY-NC-SA 3.0,
 * non-commercial only; never committed, never bulk-exported.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONNECTION_RETRY_WAITS_SECONDS, MomentSchema, type CrawlClock } from './hydration.schema';
import {
  DetailedPlaceSchema,
  storeResultSchema,
  type DetailedPlace,
  type StoreConfig,
  type WriteHook,
} from './storage.schema';
import { PlaceIdSchema } from './wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Entry points, environment and fixed names
// ---------------------------------------------------------------------------

/** Module path that must export the Embedding Run. */
export const ENTRY_POINT = {
  module: 'src/embed/run-embedding.ts',
  export: 'runEmbedding',
} as const;

/** Module path that must export the pure Place Document builder. */
export const PLACE_DOCUMENT_ENTRY_POINT = {
  module: 'src/embed/place-document.ts',
  export: 'buildPlaceDocument',
} as const;

/** Module path that must export the Embed Command (argument parsing, env, output, exit code). */
export const EMBED_COMMAND_ENTRY_POINT = {
  module: 'src/embed/command.ts',
  export: 'runEmbedCommand',
} as const;

/** Module path that must export the Embedding Record store (R2; all SQL in `src/db/`). */
export const EMBEDDING_STORE_ENTRY_POINT = {
  module: 'src/db/embedding-store.ts',
  export: 'createEmbeddingStore',
} as const;

/** AC-49: `pnpm embed` runs the Embed Command through `tsx`. */
export const EMBED_SCRIPT = { name: 'embed', runner: 'tsx' } as const;

/** Environment variables (`.agrules` section 4, AL6 rule 11, AC-52). */
export const VOYAGE_API_KEY_ENV = 'VOYAGE_API_KEY';
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const DATABASE_URL_ENV = 'DATABASE_URL';
/** Example environment settings file at the repository root (AC-52). */
export const ENV_EXAMPLE_FILE = '.env.example';
/**
 * Lines `.env.example` carried before this feature, kept exactly as they were (AC-52), given as
 * the lower-case hex SHA-256 of each whole line so the contract does not repeat the local
 * connection string.
 */
export const ENV_EXAMPLE_EXISTING_LINES_SHA256 = {
  WIKIMAPIA_API_KEY: 'ead34b03dab9689734376c9d0e393211138605e25d97f6aad36050d158106098',
  DATABASE_URL: 'b20ccca08d1283d371c2ab895241225bf397db6d3f3dd753cc163c8530d2a32d',
} as const;

/**
 * R1, AC-53, AC-54, AC-57: the Embedding Record storage. One row per Place (`place_id` is the
 * key, referring to `places`), at most one Embedding Record per Place. `embedding` is
 * `vector(1024)`, the only vector column of the store. Other columns are allowed.
 */
export const EMBEDDING_TABLE = 'place_embeddings';
export const EMBEDDING_COLUMN = 'embedding';
export const EMBEDDING_COLUMNS = [
  'place_id',
  'embedding',
  'embedding_model',
  'document_fingerprint',
  'embedded_at',
] as const;
/** `embedded_at` holds a UTC moment (`information_schema.columns.udt_name`). */
export const EMBEDDED_AT_UDT_NAME = 'timestamptz';
/** AC-54: the similarity index is pgvector HNSW with cosine distance. */
export const SIMILARITY_INDEX = { method: 'hnsw', operatorClass: 'vector_cosine_ops' } as const;

// ---------------------------------------------------------------------------
// Constants (AL6 glossary, rules, decisions, Voyage documentation)
// ---------------------------------------------------------------------------

/** The one Embedding Model (`.agrules` section 2, CLAUDE.md Decisions). */
export const EMBEDDING_MODEL = 'voyage-4';
/** Length of every Embedding (`.agrules` section 2). */
export const EMBEDDING_DIMENSIONS = 1024;
/** Document Kind of stored text; search queries (Stage 2) use `query`. */
export const DOCUMENT_INPUT_TYPE = 'document';
export const QUERY_INPUT_TYPE = 'query';

/** Voyage: at most this many texts per request (glossary "Batch"). */
export const VOYAGE_MAX_TEXTS_PER_REQUEST = 1000;
/** Voyage: at most this many tokens in total per request for `voyage-4` (assumption 9). */
export const VOYAGE_MAX_TOKENS_PER_REQUEST = 320_000;
/** Batch Token Limit when the Run is given none (AC-28 overrides it for the test). */
export const DEFAULT_BATCH_TOKEN_LIMIT = VOYAGE_MAX_TOKENS_PER_REQUEST;

/** Decision Q1: the Embedding Limit of a Run without override. */
export const DEFAULT_EMBEDDING_LIMIT = 1000;

/** Rule 8 (D10): Connection Failures and Service Rate Limits get 2 extra tries after 30, 60 s. */
export const EMBEDDING_RETRY_WAITS_SECONDS = CONNECTION_RETRY_WAITS_SECONDS;

/**
 * Size estimate of one Place Document in tokens, used to keep every Batch within the Batch
 * Token Limit before it is sent (assumption 9). Voyage's tokenizer needs at least one UTF-8
 * byte per token, so the byte length is an upper bound of the text's tokens; the margin covers
 * the per-text tokens Voyage adds for `inputType` (its retrieval prompt) and special tokens.
 */
export const DOCUMENT_TOKEN_MARGIN = 16;

export function estimateDocumentTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8') + DOCUMENT_TOKEN_MARGIN;
}

// ---------------------------------------------------------------------------
// Place Document rules (AL6 rules 2 .. 4, D9; AC-1 .. AC-16)
// ---------------------------------------------------------------------------

/**
 * Part labels (rule 2). The Name Part has no label. Parts are joined by a single `\n`, with no
 * line break before the first Part or after the last. A Part with no content is left out.
 */
export const PLACE_DOCUMENT_LABELS = {
  tags: 'Tags: ',
  address: 'Address: ',
  description: 'Description: ',
  comment: 'Comment: ',
} as const;
export const PART_SEPARATOR = '\n';
/** Separator between Tag titles and between address items. */
export const LIST_SEPARATOR = ', ';

/** AC-2: address items in this order; a value equal to an earlier one is left out (AC-5). */
export const ADDRESS_ITEM_ORDER = [
  'street',
  'houseNumber',
  'city',
  'place',
  'state',
  'country',
] as const;

/**
 * Bare Web Address (glossary, AC-6, AC-7): a maximal run of non-spacing characters whose first
 * characters are `http://`, `https://` or `www.`, in any case. Removed from the description
 * only (decision Q3). A run that merely contains `http` or `www` (e.g. `awww.`) is kept.
 */
export const BARE_WEB_ADDRESS = /(?<!\S)(?:https?:\/\/|www\.)\S*/giu;

/**
 * Spacing tidy (AC-8): every run of spacing (spaces, tabs, line breaks including `\r\n`, other
 * Unicode white space) becomes one space, and the result is trimmed. Applied to the Place
 * Name, every Tag title, every address item, the description (after removing Bare Web
 * Addresses) and every Comment message. Repeated address values are compared after tidying,
 * character for character (AC-5). Nothing else is changed: no entity decoding (Q5), no change
 * of letters, no cutting (AC-9, AC-10).
 */
export function tidySpacing(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The Place Document: one string, `''` for an Empty Document (no Parts, AC-24).
 * Included (rule 4, Q2): Present Tags; Present Comments and Replies at any depth that Wikimapia
 * has not marked deleted or blocked, depth first in read-back order (AC-12), also when their
 * parent is left out (AC-11). Places marked deleted are embedded like others (Q4).
 */
export const PlaceDocumentSchema = z.string();
export type PlaceDocument = z.infer<typeof PlaceDocumentSchema>;

/**
 * Pure Place Document builder, exported as `buildPlaceDocument` from
 * `src/embed/place-document.ts`. Input is a Detailed Place as the Place Store reads it back;
 * the same input always gives the same text (AC-16).
 */
export type BuildPlaceDocumentFn = (place: DetailedPlace) => PlaceDocument;

// ---------------------------------------------------------------------------
// Primitives: Embedding, Document Fingerprint, Embedding Record
// ---------------------------------------------------------------------------

/**
 * Embedding: exactly 1024 finite numbers (`.agrules` section 2). Zod 4 `z.number()` rejects
 * NaN and infinities. Every other length (1023, 1025, 1536, ...) is rejected.
 */
export const EmbeddingSchema = z.array(z.number()).length(EMBEDDING_DIMENSIONS);
export type Embedding = z.infer<typeof EmbeddingSchema>;

/** Pure gate: true only for exactly 1024 finite numbers. */
export function isValidEmbedding(value: unknown): value is Embedding {
  return EmbeddingSchema.safeParse(value).success;
}

/**
 * Document Fingerprint (glossary, stakeholder "a hash of the document text"): lower-case hex
 * SHA-256 of the Place Document's UTF-8 bytes. Same text, same fingerprint; different text,
 * different fingerprint.
 */
export const DocumentFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected a lower-case hex SHA-256');
export type DocumentFingerprint = z.infer<typeof DocumentFingerprintSchema>;

export function documentFingerprint(text: PlaceDocument): DocumentFingerprint {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Embedding Model name as kept. Any non-empty name is accepted by the Place Store (so a Place
 * can hold an Embedding of an older model, AC-23); the Run only ever writes EMBEDDING_MODEL.
 */
export const EmbeddingModelSchema = z.string().min(1);

/**
 * Embedding Record (glossary, AC-18, AC-39, AC-45): Embedding, Embedding Model, Document
 * Fingerprint and Embedded At, all from the same answer. Embedded At is the Clock reading when
 * the answer was received, truncated to the second (`toMoment`).
 */
export const EmbeddingRecordSchema = z.strictObject({
  placeId: PlaceIdSchema,
  embedding: EmbeddingSchema,
  model: EmbeddingModelSchema,
  documentFingerprint: DocumentFingerprintSchema,
  embeddedAt: MomentSchema,
});
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>;

/**
 * Embedding Due (glossary): a Detailed Place with a non-empty Place Document and no Embedding
 * Record, or one whose Document Fingerprint or Embedding Model differs. Pure rule.
 */
export function isEmbeddingDue(
  document: PlaceDocument,
  record: Pick<EmbeddingRecord, 'model' | 'documentFingerprint'> | undefined,
): boolean {
  if (document === '') return false;
  if (record === undefined) return true;
  return (
    record.model !== EMBEDDING_MODEL || record.documentFingerprint !== documentFingerprint(document)
  );
}

// ---------------------------------------------------------------------------
// Embedding Service seam (Voyage AI via the `voyageai` package; Simulated in tests)
// ---------------------------------------------------------------------------

/**
 * One Embedding Request as the Run sends it: 1 .. 1,000 Place Documents (never empty), model
 * `voyage-4`, Document Kind `document`, output dimension 1024. `truncation` may only be left
 * out or `true` (Voyage's default).
 */
export const EmbeddingServiceRequestSchema = z.strictObject({
  input: z.array(z.string().min(1)).min(1).max(VOYAGE_MAX_TEXTS_PER_REQUEST),
  model: z.literal(EMBEDDING_MODEL),
  inputType: z.literal(DOCUMENT_INPUT_TYPE),
  outputDimension: z.literal(EMBEDDING_DIMENSIONS),
  truncation: z.literal(true).exactOptional(),
});
export type EmbeddingServiceRequest = z.infer<typeof EmbeddingServiceRequestSchema>;

/**
 * The Embedding Service. `embed` resolves with the raw answer (untrusted, parsed with
 * EmbeddingAnswerSchema on the next step) or throws / rejects with an error classified by
 * `classifyEmbeddingServiceError`. Structurally satisfied by `VoyageAIClient` of `voyageai`.
 */
export interface EmbeddingService {
  embed(request: EmbeddingServiceRequest): Promise<unknown>;
}

/**
 * A readable answer (Voyage's response as the `voyageai` package returns it): `data` with one
 * item per input text, each `embedding` and optionally `index` (the position of its text in
 * `input`); `model`; `usage.totalTokens`. Extra keys (`object`) are ignored.
 */
export const EmbeddingAnswerSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative().exactOptional(),
    }),
  ),
  model: z.string().exactOptional(),
  usage: z.looseObject({ totalTokens: z.number().int().nonnegative() }),
});
export type EmbeddingAnswer = z.infer<typeof EmbeddingAnswerSchema>;

/**
 * Pure validator of an answer for a Batch of `batchSize` Place Documents (glossary "Invalid
 * Embedding Answer", AC-26, AC-38). Empty when the answer is usable. Rules:
 * - it parses with EmbeddingAnswerSchema ("cannot be read" otherwise);
 * - exactly `batchSize` items in `data`;
 * - either every item has an `index` and the indexes are exactly 0 .. batchSize-1 (then the
 *   index decides which Place Document an Embedding belongs to), or no item has one (then the
 *   position decides);
 * - every `embedding` is exactly 1024 finite numbers;
 * - `model`, when present, is `voyage-4` (the model kept with the Embedding is the one that
 *   produced it, `.agrules` section 2).
 */
export function findEmbeddingAnswerIssues(answer: unknown, batchSize: number): string[] {
  const parsed = EmbeddingAnswerSchema.safeParse(answer);
  if (!parsed.success) return ['the answer cannot be read'];
  const { data, model } = parsed.data;
  const issues: string[] = [];
  if (data.length !== batchSize) {
    issues.push(`expected ${String(batchSize)} embeddings, got ${String(data.length)}`);
  }
  const indexed = data.filter((item) => item.index !== undefined).length;
  if (indexed !== 0 && indexed !== data.length) {
    issues.push('only some embeddings say which text they belong to');
  } else if (indexed === data.length && data.length > 0) {
    const indexes = data.map((item) => item.index ?? -1).sort((a, b) => a - b);
    if (!indexes.every((value, i) => value === i)) {
      issues.push(`indexes are not exactly 0 .. ${String(data.length - 1)}`);
    }
  }
  data.forEach((item, i) => {
    if (!isValidEmbedding(item.embedding)) {
      issues.push(`embedding ${String(i)} is not ${String(EMBEDDING_DIMENSIONS)} finite numbers`);
    }
  });
  if (model !== undefined && model !== EMBEDDING_MODEL) {
    issues.push(`the answer comes from model ${model}, not ${EMBEDDING_MODEL}`);
  }
  return issues;
}

/** Embedding Failure kinds (glossary). */
export const EmbeddingFailureKindSchema = z.enum([
  'connection',
  'rate_limit',
  'refused',
  'invalid_answer',
]);
export type EmbeddingFailureKind = z.infer<typeof EmbeddingFailureKindSchema>;

/**
 * Classifies what `EmbeddingService.embed` threw or rejected with (the `voyageai` package
 * throws errors carrying a numeric `statusCode`; network errors and timeouts carry none):
 * - `statusCode` 429                     -> `rate_limit`  (Service Rate Limit)
 * - `statusCode` 401 or 403              -> `refused`     (Service Refused: key or account)
 * - `statusCode` 408 or 500 and above    -> `connection`  (temporarily unavailable)
 * - any other `statusCode` (other 4xx)   -> `refused`     (the service refused the request;
 *                                                          the Run stops instead of spending)
 * - no numeric `statusCode`              -> `connection`  (no answer)
 */
export function classifyEmbeddingServiceError(
  error: unknown,
): Exclude<EmbeddingFailureKind, 'invalid_answer'> {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode
      : undefined;
  if (typeof status !== 'number') return 'connection';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status >= 500) return 'connection';
  return 'refused';
}

/**
 * Pure validator of a Batch split (AC-27, AC-28): `batches` hold every one of `documents`
 * exactly once, in order; each Batch holds 1 .. 1,000 Place Documents; and each Batch's
 * estimated size (sum of `estimateDocumentTokens`) is within `tokenLimit`, except a Batch of a
 * single Place Document. Empty when the split is valid.
 *
 * The Run builds Batches greedily in Embedding Order: a Batch is closed when the next Place
 * Document would make it exceed the Batch Token Limit or 1,000 texts, or when the Embedding
 * Limit leaves no room for it.
 */
export function findBatchIssues(
  batches: readonly (readonly string[])[],
  documents: readonly string[],
  tokenLimit: number,
): string[] {
  const issues: string[] = [];
  const flat = batches.flat();
  if (flat.length !== documents.length || flat.some((text, i) => text !== documents[i])) {
    issues.push('batches do not hold every document exactly once, in order');
  }
  batches.forEach((batch, i) => {
    if (batch.length < 1 || batch.length > VOYAGE_MAX_TEXTS_PER_REQUEST) {
      issues.push(`batch ${String(i + 1)} holds ${String(batch.length)} documents`);
    }
    const size = batch.reduce((sum, text) => sum + estimateDocumentTokens(text), 0);
    if (batch.length > 1 && size > tokenLimit) {
      issues.push(`batch ${String(i + 1)} is ${String(size)} tokens, above ${String(tokenLimit)}`);
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Run request and injected collaborators
// ---------------------------------------------------------------------------

/**
 * What one Run is asked for (AC-29, AC-41, AC-49). `embeddingLimit` absent = 1,000. A value that
 * is not a whole number of at least 1 makes the Run end Failed with a message containing
 * `embeddingLimit`, before any request or change (AC-41).
 */
export const EmbeddingRunRequestSchema = z.strictObject({
  embeddingLimit: z.number().exactOptional(),
});
export type EmbeddingRunRequest = z.infer<typeof EmbeddingRunRequestSchema>;

/** The valid form of the settings (checked by the Run). */
export const EmbeddingSettingsSchema = z.strictObject({
  embeddingLimit: z.number().int().min(1),
  batchTokenLimit: z.number().int().min(1),
});
export type EmbeddingSettings = z.infer<typeof EmbeddingSettingsSchema>;

/** Setting keys a failure message names (AC-41). */
export const EMBEDDING_SETTING_KEYS = ['embeddingLimit', 'batchTokenLimit'] as const;

/**
 * Time collaborator: `now()` for start and end moments and Embedded At, `sleep` for every
 * retry wait. Same shape as the Crawl's clock; nothing waits on real time in tests.
 */
export type EmbeddingClock = CrawlClock;

/**
 * Collaborators and settings of one Run.
 * - `connectionString`: the database holding the Place Store and the Embedding Records.
 * - `apiKey`: VOYAGE_API_KEY; absent, empty or blank = missing: the Run ends Failed with a
 *   message containing `VOYAGE_API_KEY`, also when `embeddingService` is given (AC-40).
 * - `embeddingService`: defaults to Voyage (`voyageai`) built with `apiKey`; tests always inject
 *   a Simulated Embedding Service (AC-60).
 * - `clock`: defaults to real time; tests always inject a Simulated Clock.
 * - `signal`: Operator interrupt. Once aborted no new Embedding Request is started; the Batch in
 *   flight is kept in full or not at all; the Run ends Interrupted (AC-43). Already aborted at
 *   the start: nothing is sent.
 * - `batchTokenLimit`: Batch Token Limit override for tests (AC-28, AC-47); default
 *   DEFAULT_BATCH_TOKEN_LIMIT. Validated like `embeddingLimit`, named `batchTokenLimit`.
 * - `onWrite`: fault-injection seam, the Place Store's `WriteHook`: called after every write
 *   statement the Run executes (keeping a Batch's Embedding Records) with its 1-based number
 *   within the Run. If it throws or rejects, that Batch's step is rolled back as a whole and the
 *   Place Store counts as unavailable: no further Embedding Request, the Run ends Failed
 *   (AC-42, AC-45). Production code never passes it.
 * - `onProgress`: progress lines while the Run works (never secrets, AC-51).
 */
export interface EmbeddingDependencies {
  connectionString: string;
  apiKey?: string | undefined;
  embeddingService?: EmbeddingService;
  clock?: EmbeddingClock;
  signal?: AbortSignal;
  batchTokenLimit?: number;
  onWrite?: WriteHook;
  onProgress?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Run Outcome, Failed Places, Run Summary (AC-29, AC-36, AC-37, AC-46 .. AC-48, AC-50)
// ---------------------------------------------------------------------------

/** Embedding Run Outcome (glossary). */
export const EmbeddingRunOutcomeSchema = z.enum([
  'completed',
  'limit_reached',
  'rate_limited',
  'interrupted',
  'failed',
]);
export type EmbeddingRunOutcome = z.infer<typeof EmbeddingRunOutcomeSchema>;

/** Clean Stops (AC-29, AC-36, AC-43): every kept Batch stays, the summary is shown. */
export const EMBEDDING_CLEAN_STOP_OUTCOMES: readonly EmbeddingRunOutcome[] = [
  'limit_reached',
  'rate_limited',
  'interrupted',
];

/** AC-50: success (0) for Completed, Limit Reached, Rate Limited; failure (1) otherwise. */
export function embedExitCodeFor(outcome: EmbeddingRunOutcome): 0 | 1 {
  return outcome === 'failed' || outcome === 'interrupted' ? 1 : 0;
}

/**
 * Why a Place became a Failed Place (glossary, rule 8): a Connection Failure that persisted
 * after its retries, an Invalid Embedding Answer, or Invalid Data from the Place Store. The
 * Places of a Batch that ended in a Service Rate Limit (AC-36) or Service Refused (AC-37) are not
 * Failed Places: the Run stops and they stay Embedding Due.
 */
export const FailedPlaceKindSchema = z.enum(['connection', 'invalid_answer', 'invalid_data']);
export type FailedPlaceKind = z.infer<typeof FailedPlaceKindSchema>;

const CountSchema = z.number().int().nonnegative();

export const FailedPlaceCountsSchema = z.strictObject({
  connection: CountSchema,
  invalid_answer: CountSchema,
  invalid_data: CountSchema,
});
export type FailedPlaceCounts = z.infer<typeof FailedPlaceCountsSchema>;

/**
 * Run Summary numbers (AC-46, AC-47), exact:
 * - `detailedPlacesConsidered`: Detailed Places the Run read.
 * - `placesEmbedded`: Embedding Records kept in this Run.
 * - `unchangedSkipped`, `emptyDocumentsSkipped`: Detailed Places not sent for those reasons.
 * - `summaryOnlySkipped`: Summary-Only Places in the Place Store (never read as candidates).
 * - `failedPlaces` = sum of `failedPlacesByKind`.
 * - `placesStillDue`: considered Places that are Embedding Due at the end (Failed Places,
 *   Places not sent because of the limit or a stop).
 * - `batchesSent`: Batches for which at least one Embedding Request was sent.
 * - `embeddingRequests`: every request, retries included (at most 3 per Batch).
 * - `tokensUsed`: sum of `usage.totalTokens` of the answers that were kept (AC-48).
 */
export const EmbeddingRunCountsSchema = z
  .strictObject({
    detailedPlacesConsidered: CountSchema,
    placesEmbedded: CountSchema,
    unchangedSkipped: CountSchema,
    summaryOnlySkipped: CountSchema,
    emptyDocumentsSkipped: CountSchema,
    failedPlaces: CountSchema,
    failedPlacesByKind: FailedPlaceCountsSchema,
    placesStillDue: CountSchema,
    batchesSent: CountSchema,
    embeddingRequests: CountSchema,
    tokensUsed: CountSchema,
  })
  .refine(
    (c) => c.failedPlaces === Object.values(c.failedPlacesByKind).reduce((a, b) => a + b, 0),
    { message: 'failedPlaces = sum of failedPlacesByKind', path: ['failedPlaces'] },
  )
  .refine(
    (c) =>
      c.detailedPlacesConsidered ===
      c.placesEmbedded + c.unchangedSkipped + c.emptyDocumentsSkipped + c.placesStillDue,
    {
      message: 'every considered Place is embedded, skipped or still due',
      path: ['detailedPlacesConsidered'],
    },
  )
  .refine((c) => c.failedPlaces <= c.placesStillDue, {
    message: 'Failed Places stay Embedding Due',
    path: ['failedPlaces'],
  })
  .refine(
    (c) =>
      c.batchesSent <= c.embeddingRequests &&
      c.embeddingRequests <= c.batchesSent * (1 + EMBEDDING_RETRY_WAITS_SECONDS.length),
    { message: 'each Batch is sent 1 .. 3 times', path: ['embeddingRequests'] },
  );
export type EmbeddingRunCounts = z.infer<typeof EmbeddingRunCountsSchema>;

/** All-zero counts (a Run that failed before reading anything). */
export const ZERO_EMBEDDING_COUNTS: EmbeddingRunCounts = {
  detailedPlacesConsidered: 0,
  placesEmbedded: 0,
  unchangedSkipped: 0,
  summaryOnlySkipped: 0,
  emptyDocumentsSkipped: 0,
  failedPlaces: 0,
  failedPlacesByKind: { connection: 0, invalid_answer: 0, invalid_data: 0 },
  placesStillDue: 0,
  batchesSent: 0,
  embeddingRequests: 0,
  tokensUsed: 0,
};

export const EmbeddingRunSummarySchema = z
  .strictObject({
    outcome: EmbeddingRunOutcomeSchema,
    startedAt: MomentSchema,
    endedAt: MomentSchema,
    embeddingModel: z.literal(EMBEDDING_MODEL),
    counts: EmbeddingRunCountsSchema,
  })
  .refine((s) => Date.parse(s.endedAt) >= Date.parse(s.startedAt), {
    message: 'endedAt is not before startedAt',
    path: ['endedAt'],
  });
export type EmbeddingRunSummary = z.infer<typeof EmbeddingRunSummarySchema>;

/**
 * Labels of the plain-text Run Summary (AC-46): `summaryText` has one `Label: value` line per
 * item, in this order; numbers as plain decimals, moments as MomentSchema text, the outcome as
 * its EMBEDDING_OUTCOME_LABELS text, the model as `voyage-4`. Per-kind Failed Places appear as
 * `Failed places (<FAILED_PLACE_LABELS[kind]>): n`, one line per kind, after `Failed places: n`.
 */
export const EMBED_SUMMARY_LABELS = {
  outcome: 'Run outcome',
  startedAt: 'Started at',
  endedAt: 'Ended at',
  embeddingModel: 'Embedding model',
  detailedPlacesConsidered: 'Detailed places considered',
  placesEmbedded: 'Places embedded',
  unchangedSkipped: 'Unchanged places skipped',
  summaryOnlySkipped: 'Summary-only places skipped',
  emptyDocumentsSkipped: 'Empty documents skipped',
  failedPlaces: 'Failed places',
  placesStillDue: 'Places still due for embedding',
  batchesSent: 'Batches sent',
  embeddingRequests: 'Embedding requests',
  tokensUsed: 'Tokens used',
} as const;

export const EMBEDDING_OUTCOME_LABELS: Record<EmbeddingRunOutcome, string> = {
  completed: 'Completed',
  limit_reached: 'Limit Reached',
  rate_limited: 'Rate Limited',
  interrupted: 'Interrupted',
  failed: 'Failed',
};

export const FAILED_PLACE_LABELS: Record<FailedPlaceKind, string> = {
  connection: 'connection failure',
  invalid_answer: 'invalid embedding answer',
  invalid_data: 'invalid data',
};

/**
 * One Failed Place as reported, in the order met. `message` names the Place ID and the reason;
 * never a key value, password, connection string or Commenter IP (AC-51).
 */
export const FailedPlaceReportSchema = z.strictObject({
  placeId: PlaceIdSchema,
  failureKind: FailedPlaceKindSchema,
  message: z.string().min(1),
});
export type FailedPlaceReport = z.infer<typeof FailedPlaceReportSchema>;

/**
 * What a Run resolves to.
 * - `outcome` equals `summary.outcome`.
 * - `message`: present for `failed` (names the reason: `VOYAGE_API_KEY` missing, the offending
 *   setting, "the Embedding Service refused the request", Place Store unavailable, usage);
 *   may be present for other outcomes.
 * - `failedPlaces`: one entry per Failed Place (`summary.counts.failedPlaces` of them).
 * - `summaryText`: the plain-text Run Summary (EMBED_SUMMARY_LABELS), always present (AC-46).
 */
export const EmbeddingRunReportSchema = z
  .strictObject({
    outcome: EmbeddingRunOutcomeSchema,
    message: z.string().min(1).exactOptional(),
    summary: EmbeddingRunSummarySchema,
    summaryText: z.string().min(1),
    failedPlaces: z.array(FailedPlaceReportSchema),
  })
  .refine((r) => r.outcome === r.summary.outcome, {
    message: 'outcome equals summary.outcome',
    path: ['outcome'],
  })
  .refine((r) => r.outcome !== 'failed' || r.message !== undefined, {
    message: 'a Failed Run says why',
    path: ['message'],
  })
  .refine((r) => r.failedPlaces.length === r.summary.counts.failedPlaces, {
    message: 'one report per Failed Place',
    path: ['failedPlaces'],
  });
export type EmbeddingRunReport = z.infer<typeof EmbeddingRunReportSchema>;

/**
 * The Embedding Run, exported as `runEmbedding` from `src/embed/run-embedding.ts`. Never
 * rejects: every way a Run can end is an EmbeddingRunReport.
 */
export type RunEmbeddingFn = (
  request: EmbeddingRunRequest,
  deps: EmbeddingDependencies,
) => Promise<EmbeddingRunReport>;

// ---------------------------------------------------------------------------
// Embed Command (AC-49 .. AC-51)
// ---------------------------------------------------------------------------

/**
 * Command-line options: `--limit <n>` sets the Embedding Limit for that Run. There is no Dry Run
 * option (Q7). Any other argument ends the Run Failed with a usage message that names
 * `--limit`, and nothing is sent. An unparsable `--limit` value is an invalid setting (AC-41).
 */
export const EMBED_COMMAND_OPTIONS = { limit: '--limit' } as const;

/**
 * What the command reads and writes. `env` stands for `process.env` (only VOYAGE_API_KEY and
 * DATABASE_URL are read). `write` receives every output line (progress, failure message and
 * the plain-text Run Summary). The command needs no input from a person (AC-50).
 */
export interface EmbedCommandIO {
  env: Readonly<Partial<Record<typeof VOYAGE_API_KEY_ENV | typeof DATABASE_URL_ENV, string>>>;
  write: (line: string) => void;
  embeddingService?: EmbeddingService;
  clock?: EmbeddingClock;
  signal?: AbortSignal;
}

export const EmbedCommandResultSchema = z
  .strictObject({
    exitCode: z.union([z.literal(0), z.literal(1)]),
    report: EmbeddingRunReportSchema,
  })
  .refine((r) => r.exitCode === embedExitCodeFor(r.report.outcome), {
    message: 'exit code follows the Run Outcome',
    path: ['exitCode'],
  });
export type EmbedCommandResult = z.infer<typeof EmbedCommandResultSchema>;

/**
 * The Embed Command, exported as `runEmbedCommand` from `src/embed/command.ts`. Runs
 * `runEmbedding` over the Place Store at `env.DATABASE_URL` with `env.VOYAGE_API_KEY`. Never
 * rejects. `scripts.embed` of package.json is `tsx <script>` calling it with
 * `process.argv.slice(2)`, `process.env`, console output, a SIGINT/SIGTERM AbortSignal and
 * `process.exitCode = result.exitCode`.
 */
export type RunEmbedCommandFn = (
  argv: readonly string[],
  io: EmbedCommandIO,
) => Promise<EmbedCommandResult>;

// ---------------------------------------------------------------------------
// Embedding Store (R2, AC-39, AC-53 .. AC-58)
// ---------------------------------------------------------------------------

/** Most Places one candidates read or one save may hold (one full Batch). */
export const MAX_PLACES_PER_STORE_CALL = VOYAGE_MAX_TEXTS_PER_REQUEST;

/**
 * R2 read: Detailed Places with Place ID greater than `afterPlaceId` (all when absent), in
 * ascending Place ID, at most `limit`. Summary-Only Places are never returned.
 */
export const EmbeddingCandidatesInputSchema = z.strictObject({
  afterPlaceId: PlaceIdSchema.exactOptional(),
  limit: z.number().int().min(1).max(MAX_PLACES_PER_STORE_CALL),
});
export type EmbeddingCandidatesInput = z.infer<typeof EmbeddingCandidatesInputSchema>;

/**
 * One candidate: the Detailed Place exactly as `PlaceStore.readPlace` reads it back (Storage
 * AC-49, same Tag and Comment order) and its Embedding Record, absent when it has none.
 */
export const EmbeddingCandidateSchema = z
  .strictObject({
    place: DetailedPlaceSchema,
    embeddingRecord: EmbeddingRecordSchema.exactOptional(),
  })
  .refine((c) => c.embeddingRecord === undefined || c.embeddingRecord.placeId === c.place.placeId, {
    message: 'the Embedding Record belongs to its Place',
    path: ['embeddingRecord', 'placeId'],
  });
export type EmbeddingCandidate = z.infer<typeof EmbeddingCandidateSchema>;

export function isAscendingByPlaceId(placeIds: readonly number[]): boolean {
  return placeIds.every((id, i) => {
    const previous = placeIds[i - 1];
    return previous === undefined || previous < id;
  });
}

export const EmbeddingCandidatesValueSchema = z
  .strictObject({ places: z.array(EmbeddingCandidateSchema) })
  .refine((v) => isAscendingByPlaceId(v.places.map((c) => c.place.placeId)), {
    message: 'Places are listed once each, ascending by Place ID',
    path: ['places'],
  });
export type EmbeddingCandidatesValue = z.infer<typeof EmbeddingCandidatesValueSchema>;

/**
 * Keep the Embedding Records of one Batch (AC-39, AC-45): all or nothing. Each record replaces
 * the Place's earlier one (one per Place, AC-22). Invalid Data, keeping nothing, when any record
 * breaks EmbeddingRecordSchema (issue path `['records', i, ...]`), a Place ID appears twice, or a
 * Place is not a stored Detailed Place.
 */
export const SaveEmbeddingRecordsInputSchema = z
  .strictObject({
    records: z.array(EmbeddingRecordSchema).min(1).max(MAX_PLACES_PER_STORE_CALL),
  })
  .refine((v) => new Set(v.records.map((r) => r.placeId)).size === v.records.length, {
    message: 'each Place appears once',
    path: ['records'],
  });
export type SaveEmbeddingRecordsInput = z.infer<typeof SaveEmbeddingRecordsInputSchema>;

export const SaveEmbeddingRecordsValueSchema = z.strictObject({ saved: CountSchema });
export type SaveEmbeddingRecordsValue = z.infer<typeof SaveEmbeddingRecordsValueSchema>;

export const ReadEmbeddingRecordValueSchema = z.discriminatedUnion('found', [
  z.strictObject({ found: z.literal(true), record: EmbeddingRecordSchema }),
  z.strictObject({ found: z.literal(false), placeId: PlaceIdSchema }),
]);
export type ReadEmbeddingRecordValue = z.infer<typeof ReadEmbeddingRecordValueSchema>;

/** Totals used by the Run Summary and the starting-state checks (AC-17, AC-58). */
export const EmbeddingStoreCountsSchema = z.strictObject({
  summaryOnlyPlaces: CountSchema,
  detailedPlaces: CountSchema,
  embeddingRecords: CountSchema,
});
export type EmbeddingStoreCounts = z.infer<typeof EmbeddingStoreCountsSchema>;

/**
 * The Embedding storage as found in the database (AC-53, AC-54, AC-57): table and vector column,
 * the column's declared dimensions (pgvector type modifier), whether `place_id` is the table's
 * key, and every index on the vector column with its access method, operator class and whether
 * it is partial.
 */
export const EmbeddingStorageInfoSchema = z.strictObject({
  table: z.literal(EMBEDDING_TABLE),
  column: z.literal(EMBEDDING_COLUMN),
  dimensions: z.number().int().positive(),
  onePerPlace: z.boolean(),
  vectorIndexes: z.array(
    z.strictObject({
      name: z.string().min(1),
      method: z.string().min(1),
      operatorClass: z.string().min(1),
      partial: z.boolean(),
    }),
  ),
});
export type EmbeddingStorageInfo = z.infer<typeof EmbeddingStorageInfoSchema>;

export const EmbeddingCandidatesResultSchema = storeResultSchema(EmbeddingCandidatesValueSchema);
export type EmbeddingCandidatesResult = z.infer<typeof EmbeddingCandidatesResultSchema>;

export const SaveEmbeddingRecordsResultSchema = storeResultSchema(SaveEmbeddingRecordsValueSchema);
export type SaveEmbeddingRecordsResult = z.infer<typeof SaveEmbeddingRecordsResultSchema>;

export const ReadEmbeddingRecordResultSchema = storeResultSchema(ReadEmbeddingRecordValueSchema);
export type ReadEmbeddingRecordResult = z.infer<typeof ReadEmbeddingRecordResultSchema>;

export const EmbeddingStoreCountsResultSchema = storeResultSchema(EmbeddingStoreCountsSchema);
export type EmbeddingStoreCountsResult = z.infer<typeof EmbeddingStoreCountsResultSchema>;

export const EmbeddingStorageInfoResultSchema = storeResultSchema(EmbeddingStorageInfoSchema);
export type EmbeddingStorageInfoResult = z.infer<typeof EmbeddingStorageInfoResultSchema>;

/** Inputs are re-validated at runtime; anything else is `invalid_data` and never reaches SQL. */
export interface EmbeddingStoreOptions extends StoreConfig {
  onWrite?: WriteHook;
}

/**
 * The Embedding Store (R2). Calls never reject; an unreachable database is `store_unavailable`
 * without secrets. Listing Saves and Details Saves of the Place Store never change an Embedding
 * Record (AC-56).
 */
export interface EmbeddingStore {
  /** R2: Detailed Places with their Embedding Records, ascending Place ID, paged. */
  listEmbeddingCandidates(input: EmbeddingCandidatesInput): Promise<EmbeddingCandidatesResult>;
  /** Keeps one Batch's Embedding Records, all or nothing (AC-33, AC-39, AC-45). */
  saveEmbeddingRecords(input: SaveEmbeddingRecordsInput): Promise<SaveEmbeddingRecordsResult>;
  /** The Embedding Record of one Place. Not found is an answer, not a failure. */
  readEmbeddingRecord(input: { placeId: number }): Promise<ReadEmbeddingRecordResult>;
  /** Summary-Only Places, Detailed Places and Embedding Records stored. */
  countEmbeddingStore(): Promise<EmbeddingStoreCountsResult>;
  /** The Embedding storage structure (AC-53, AC-54). */
  inspectEmbeddingStorage(): Promise<EmbeddingStorageInfoResult>;
  /** Releases the connection pool. Never rejects. */
  close(): Promise<void>;
}

/** Exported as `createEmbeddingStore` from `src/db/embedding-store.ts`. Never throws. */
export type CreateEmbeddingStoreFn = (options: EmbeddingStoreOptions) => EmbeddingStore;
