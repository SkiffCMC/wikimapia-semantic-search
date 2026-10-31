/**
 * Every type alias and interface of `src/embed/` (AL4 embeddings 1.3; `.agrules` section 5).
 * Contract types are imported, never redefined.
 */
import type {
  DocumentFingerprint,
  EmbeddingClock,
  EmbeddingRunCounts,
  EmbeddingRunOutcome,
  EmbeddingRunRequest,
  EmbeddingService,
  EmbeddingServiceRequest,
  EmbeddingSettings,
  EmbeddingStore,
  FailedPlaceKind,
  FailedPlaceReport,
  PlaceDocument,
} from '../../contracts/embeddings.schema';
import type { QueryEmbeddingRequest } from '../../contracts/hybrid-search.schema';

/** A Place that is Embedding Due and not yet sent, with its Place Document and fingerprint. */
export interface DueItem {
  placeId: number;
  document: PlaceDocument;
  fingerprint: DocumentFingerprint;
}

/** Result of checking the Run's settings (AL4 1.4.5). */
export type Resolution = { ok: true; settings: EmbeddingSettings } | { ok: false; message: string };

/** The Run's counters (AL4 1.4.7); `placesStillDue` and `failedPlaces` are derived. */
export interface Tally {
  considered(kind: 'unchanged' | 'empty' | 'due'): void;
  embedded(count: number, tokens: number): void;
  failed(items: readonly DueItem[], failureKind: FailedPlaceKind, reason: string): void;
  request(): void;
  batch(): void;
  /** Due Places not sent because the Embedding Limit had no room. */
  limitHeld: number;
  summaryOnlySkipped: number;
  readonly failures: readonly FailedPlaceReport[];
  snapshot(): EmbeddingRunCounts;
}

/** Input of `buildReport` (AL4 1.3). */
export interface ReportInput {
  outcome: EmbeddingRunOutcome;
  message?: string;
  startedAt: string;
  endedAt: string;
  counts: EmbeddingRunCounts;
  failedPlaces: readonly FailedPlaceReport[];
}

/** Outcomes a stop can give the Run: `rate_limited`, `interrupted` or `failed` (AL4 1.3). */
export type StopOutcome = Exclude<EmbeddingRunOutcome, 'completed' | 'limit_reached'>;

/** Why the Run stops; `message` is safe to print (never an error's own text). */
export interface Stop {
  outcome: StopOutcome;
  message?: string;
}

/** Result of one Batch (AL4 1.4.4). */
export type BatchResult =
  /** The Batch's Embedding Records are kept. */
  | { kind: 'kept'; tokens: number }
  /** Its Places become Failed Places; the Run goes on. */
  | { kind: 'failed'; failureKind: FailedPlaceKind; reason: string }
  /** Its Places stay due; the Run stops. */
  | { kind: 'stopped'; stop: Stop };

/** Collaborators of one Batch (AL4 1.3). */
export interface SendContext {
  service: EmbeddingService;
  store: EmbeddingStore;
  clock: EmbeddingClock;
  signal: AbortSignal | undefined;
  tally: Tally;
  progress: (line: string) => void;
  batchNumber: number;
}

/** Options of the production Embedding Service over the `voyageai` SDK (AL4 1.4.6). */
export interface VoyageServiceOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutSeconds?: number;
}

/** A request either Voyage adapter sends: a Batch of documents or one search query (AL4 hybrid-search 1.3). */
export type VoyageEmbedRequest = EmbeddingServiceRequest | QueryEmbeddingRequest;

/** Collaborators and settings of the scan-and-send loop of one Run (AL4 1.4.2). */
export interface RunLoopContext {
  service: EmbeddingService;
  store: EmbeddingStore;
  clock: EmbeddingClock;
  signal: AbortSignal | undefined;
  settings: EmbeddingSettings;
  tally: Tally;
  progress: (line: string) => void;
}

/** Result of parsing the Embed Command's arguments (AL4 1.3, 1.4.10). */
export type ParsedEmbedArgs =
  { ok: true; request: EmbeddingRunRequest } | { ok: false; problem: string };
