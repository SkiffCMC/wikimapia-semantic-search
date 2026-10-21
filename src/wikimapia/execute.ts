/**
 * Execution core (AL4 1.2 steps 4 and 5, 1.3 `execute.ts` block, 1.4.7 Rate limiting and
 * retries, 1.4.8 Transport and failure mapping, 1.4.9 first paragraph, 1.5 Transaction
 * boundaries): runs one client call through the transport, checks the status, interprets the
 * body, waits and retries on rate limits, and redacts every failure. Never rejects and keeps no
 * state between calls.
 */
import {
  TransportResponseSchema,
  type ClientFailure,
  type Clock,
  type FailureIssue,
  type TransportResponse,
  type WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema.js';
import type { Interpretation } from './interpret.js';
import { describeIssues } from './issues.js';
import { redactFailure } from './redact.js';

export type ClientResult<T> = { ok: true; value: T } | { ok: false; failure: ClientFailure };

export interface ExecuteDeps {
  transport: WikimapiaTransport;
  clock: Clock;
  apiKey: string;
  retryLimit: number;
  fallbackWaitSeconds: number;
}

const UNEXPECTED_PREFIX = 'Unexpected Wikimapia response';
const CONNECTION_MESSAGE = 'Wikimapia could not be reached';
const WIKIMAPIA_ERROR_MESSAGE = 'Wikimapia reported an error';
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const MALFORMED_ISSUES: readonly FailureIssue[] = [
  { path: [], message: 'transport returned a malformed response' },
];
const INTERNAL_ISSUES: readonly FailureIssue[] = [{ path: [], message: 'internal client error' }];

function unexpectedResponse(issues: readonly FailureIssue[]): ClientFailure {
  return {
    kind: 'unexpected_response',
    message: describeIssues(UNEXPECTED_PREFIX, issues),
    issues: issues.map((issue) => ({ path: [...issue.path], message: issue.message })),
  };
}

/** Reads `error.cause.code` only when it is a well-formed upper-case code; never copies anything else. */
function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  const code: unknown = cause.code;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

function connectionFailure(error: unknown): ClientFailure {
  const code = causeCode(error);
  return {
    kind: 'connection',
    message: code === undefined ? CONNECTION_MESSAGE : `${CONNECTION_MESSAGE} (${code})`,
  };
}

type TransportOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };

async function callTransport(
  transport: WikimapiaTransport,
  url: string,
): Promise<TransportOutcome> {
  try {
    const response: TransportResponse = await transport({ url });
    return { ok: true, response };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function run<T>(
  url: string,
  interpret: (body: string) => Interpretation<T>,
  deps: ExecuteDeps,
): Promise<{ ok: true; value: T } | { ok: false; failure: ClientFailure }> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await callTransport(deps.transport, url);
    if (!outcome.ok) return { ok: false, failure: connectionFailure(outcome.error) };

    const parsed = TransportResponseSchema.safeParse(outcome.response);
    if (!parsed.success) return { ok: false, failure: unexpectedResponse(MALFORMED_ISSUES) };

    const { status, body } = parsed.data;
    if (status < 200 || status > 299) {
      return {
        ok: false,
        failure: {
          kind: 'connection',
          message: `Wikimapia answered with HTTP status ${String(status)}`,
          status,
        },
      };
    }

    const interpretation = interpret(body);
    switch (interpretation.kind) {
      case 'data':
        return { ok: true, value: interpretation.value };
      case 'wikimapia_error':
        return {
          ok: false,
          failure: {
            kind: 'wikimapia_error',
            message: WIKIMAPIA_ERROR_MESSAGE,
            wikimapiaMessage: interpretation.message,
          },
        };
      case 'unexpected':
        return { ok: false, failure: unexpectedResponse(interpretation.issues) };
      case 'rate_limit': {
        const wait = interpretation.waitSeconds ?? deps.fallbackWaitSeconds;
        if (attempt > deps.retryLimit) {
          return {
            ok: false,
            failure: {
              kind: 'rate_limit_exhausted',
              message: `Wikimapia rate limit still in effect after ${String(attempt)} attempts (last wait ${String(wait)} s)`,
              attempts: attempt,
              lastWaitSeconds: wait,
            },
          };
        }
        if (wait > 0) await deps.clock.sleep(Math.round(wait * 1000));
        break;
      }
      default: {
        const unreachable: never = interpretation;
        return unreachable;
      }
    }
  }
}

export async function executeRequest<T>(
  url: string,
  interpret: (body: string) => Interpretation<T>,
  deps: ExecuteDeps,
): Promise<ClientResult<T>> {
  let result: { ok: true; value: T } | { ok: false; failure: ClientFailure };
  try {
    result = await run(url, interpret, deps);
  } catch {
    result = { ok: false, failure: unexpectedResponse(INTERNAL_ISSUES) };
  }
  if (result.ok) return result;
  return { ok: false, failure: redactFailure(result.failure, deps.apiKey) };
}
