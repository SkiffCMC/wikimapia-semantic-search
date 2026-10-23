/**
 * One Client call with Connection Failure back-off and classification (AL4 1.3
 * `requestWithBackoff`, 1.4.4; crawl-run1-fixes AL4 1.4.3). The Client's own (already redacted)
 * failure `message` is passed on, and for Wikimapia Errors and Key Quota stops also the
 * Client-redacted `wikimapiaMessage` (AL4 0.1 "Item Failure messages"); never `issues` or a
 * request address.
 */
import { CONNECTION_RETRY_WAITS_SECONDS } from '../../contracts/hydration.schema';
import { oneLine } from './report';
import type { ClientCall, Gateway, RequestKind, Requested } from './types';

const STOPPED = { kind: 'stopped' } as const;

/** Read through functions: the Gateway may stop and the signal may abort during any await. */
function isStopped(gateway: Gateway): boolean {
  return gateway.stopped !== undefined;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function requestWithBackoff<T>(
  gateway: Gateway,
  kind: RequestKind,
  signal: AbortSignal | undefined,
  call: ClientCall<T>,
): Promise<Requested<T>> {
  gateway.setKind(kind);
  for (let attempt = 0; ; attempt += 1) {
    const result = await call();
    if (isStopped(gateway)) return STOPPED;
    if (result.ok) return { kind: 'ok', value: result.value };

    const failure = result.failure;
    switch (failure.kind) {
      case 'rate_limit_exhausted':
        gateway.stop(
          'rate_limited',
          `Wikimapia kept answering with its rate limit after ${String(failure.attempts)} attempts.`,
        );
        return STOPPED;
      case 'key_quota_exhausted':
        gateway.stop('quota_exhausted', failure.message, failure.wikimapiaMessage);
        return STOPPED;
      case 'configuration':
        gateway.stop('failed', failure.message);
        return STOPPED;
      case 'connection': {
        if (isAborted(signal)) {
          gateway.stop('interrupted');
          return STOPPED;
        }
        const waitSeconds = CONNECTION_RETRY_WAITS_SECONDS[attempt];
        if (waitSeconds !== undefined) {
          await gateway.wait(waitSeconds * 1000);
          if (isStopped(gateway)) return STOPPED;
          if (isAborted(signal)) {
            gateway.stop('interrupted');
            return STOPPED;
          }
          continue;
        }
        return { kind: 'item_failure', failureKind: 'connection', message: failure.message };
      }
      case 'wikimapia_error': {
        const text = oneLine(failure.wikimapiaMessage);
        const message = text === '' ? failure.message : `${failure.message}: ${text}`;
        return { kind: 'item_failure', failureKind: failure.kind, message };
      }
      case 'unexpected_response':
      case 'invalid_request':
        return { kind: 'item_failure', failureKind: failure.kind, message: failure.message };
      default: {
        const unreachable: never = failure;
        return unreachable;
      }
    }
  }
}
