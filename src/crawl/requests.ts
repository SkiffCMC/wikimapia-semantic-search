/**
 * One Client call with Connection Failure back-off and classification (AL4 1.3
 * `requestWithBackoff`, 1.4.4; U5). Only the Client's own (already redacted) failure `message` is
 * ever passed on; never Wikimapia's raw text, `issues` or a request address.
 */
import { CONNECTION_RETRY_WAITS_SECONDS } from '../../contracts/hydration.schema';
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
      case 'wikimapia_error':
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
