/**
 * Internal types (AL4 1.1 Module map, 1.3 `types.ts` block, section 4 refactor note): every type
 * alias and interface declared in `src/wikimapia/`. Types only, no runtime code. Contract
 * `z.infer` types stay in the schema file and are not re-exported here.
 */
import type {
  ClientFailure,
  Clock,
  FailureIssue,
  TransportResponse,
  WikimapiaClientOptions,
  WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema';

export type Normalized<T> = { ok: true; value: T } | { ok: false; issues: FailureIssue[] };

export type Interpretation<T> =
  | { kind: 'data'; value: T }
  | { kind: 'rate_limit'; waitSeconds: number | undefined }
  | { kind: 'wikimapia_error'; message: string }
  | { kind: 'unexpected'; issues: FailureIssue[] };

export type ClientResult<T> = { ok: true; value: T } | { ok: false; failure: ClientFailure };

export interface ExecuteDeps {
  transport: WikimapiaTransport;
  clock: Clock;
  apiKey: string;
  retryLimit: number;
  fallbackWaitSeconds: number;
}

/** Used by `execute.ts` only. */
export type TransportOutcome = { ok: true; response: TransportResponse } | { ok: false; error: unknown };

/** Used by `client.ts` only. */
export type Resolved =
  | { ok: true; deps: ExecuteDeps; language: string | undefined }
  | { ok: false; failure: ClientFailure };

/**
 * Used by `client.ts` only (unit 07). The contract-typed options as the factory must tolerate
 * them at runtime (1.4.1): casts may leave out fields (AC-31 `{}`) or pass `null` / `undefined`.
 */
export type UncheckedOptions = Partial<WikimapiaClientOptions> | null | undefined;
