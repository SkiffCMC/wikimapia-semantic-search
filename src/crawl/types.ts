/**
 * Internal types of the Crawl (AL4 1.1 Module map, 1.3 `src/crawl/types.ts` block): every type
 * alias and interface declared in `src/crawl/`. Types only, no runtime code. Contract `z.infer`
 * types stay in the schema files and are not re-exported here. U5 adds the Gateway and request
 * types (`RequestKind` .. `ClientCall<T>`); U6 adds the Run context types (`PassCursor`,
 * `RunContext`) shared by the Listing and Details Phases. U7 adds `ParsedCrawlArgs`, the result
 * of the Crawl Command's argument parsing.
 */
import type {
  ClientFailure,
  WikimapiaClient,
  WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema';
import type {
  CrawlClock,
  CrawlConfiguration,
  CrawlRequest,
  FailedItem,
  ItemFailureKind,
  ItemFailureReport,
  Region,
  RunCounts,
  RunOutcome,
  TilePlan,
} from '../../contracts/hydration.schema';
import type { CrawlRepository } from '../db/types';

/** Why a Run stopped early: budget_reached | rate_limited | interrupted | failed. */
export type StopReason = Exclude<RunOutcome, 'completed' | 'planned'>;

export interface Stop {
  reason: StopReason;
  message?: string;
}

/** Which kind of Wikimapia Request the Gateway counts the following transport calls as. */
export type RequestKind = 'listing' | 'details';

/** A Run request resolved against the validated Crawl Configuration (overrides applied). */
export interface ResolvedRun {
  regionName: string;
  region: Region;
  configuration: CrawlConfiguration;
  plan: TilePlan;
  dryRun: boolean;
  relist: boolean;
}

/** `regionName` on failure: the (trimmed) name asked for, if any. */
export type Resolution =
  { ok: true; run: ResolvedRun } | { ok: false; message: string; regionName?: string };

/** Result of one Last Activity renewal. */
export type HeartbeatOutcome = { ok: true } | { ok: false; message: string };

export interface GatewayOptions {
  transport: WikimapiaTransport;
  clock: CrawlClock;
  signal: AbortSignal | undefined;
  minRequestIntervalSeconds: number;
  requestBudget: number;
  /** Renews Last Activity. */
  heartbeat: () => Promise<HeartbeatOutcome>;
  /** The last renewal, in clock milliseconds (the Run start: Run Record insert). */
  lastRenewalMs: number;
}

/** Request and Rate-Limit Wait counts kept by the Gateway. */
export interface GatewayCounts {
  listingRequests: number;
  detailsRequests: number;
  rateLimitWaits: number;
  rateLimitWaitMs: number;
}

/** Wraps the injected transport and clock (AL4 1.4.3). */
export interface Gateway {
  /** Handed to the Client: every call is one Wikimapia Request. */
  readonly transport: WikimapiaTransport;
  /** Handed to the Client: every `sleep` with `ms > 0` is one Rate-Limit Wait. */
  readonly clock: CrawlClock;
  setKind(kind: RequestKind): void;
  /** The first stop wins. */
  stop(reason: StopReason, message?: string): void;
  readonly stopped: Stop | undefined;
  readonly requestsSent: number;
  counts(): GatewayCounts;
  /** The crawl's own wait (back-off); resolves with the milliseconds actually waited. */
  wait(ms: number): Promise<number>;
}

/** Classified outcome of one Client call (AL4 1.4.4). */
export type Requested<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'item_failure'; failureKind: ItemFailureKind; message: string }
  | { kind: 'stopped' };

export type ClientCall<T> = () => Promise<
  { ok: true; value: T } | { ok: false; failure: ClientFailure }
>;

/** Run tally: counters, distinct Places listed and Item Failures in the order met. */
export interface Tally {
  pageSaved(placeIds: readonly number[], createdCount: number, tileFinished: boolean): void;
  detailsSaved(changed: boolean): void;
  itemFailure(item: FailedItem, failureKind: ItemFailureKind, message: string): void;
  readonly failures: readonly ItemFailureReport[];
  snapshot(
    gateway: GatewayCounts,
    extra: { tilesUnfinished: number; placesStillDue: number },
  ): RunCounts;
}

/** The current Listing Pass as the Listing Phase walks it (built from the start step's `PassState`). */
export interface PassCursor {
  passNumber: number;
  tileCount: number;
  finishedTiles: Set<number>;
  /** Tile Number -> last Finished Page. */
  lastFinishedPage: Map<number, number>;
}

/** Shared by the two phases of one Run (AL4 1.3). */
export interface RunContext {
  run: ResolvedRun;
  runId: number;
  startMs: number;
  dueBefore: string;
  gateway: Gateway;
  /** Built by `createWikimapiaClient` over the Gateway's transport and clock. */
  client: WikimapiaClient;
  repo: CrawlRepository;
  tally: Tally;
  clock: CrawlClock;
  signal: AbortSignal | undefined;
  progress: (line: string) => void;
}

/** Result of `parseCrawlArgs`: the Run request, or a short problem naming the option or token. */
export type ParsedCrawlArgs = { ok: true; request: CrawlRequest } | { ok: false; problem: string };
