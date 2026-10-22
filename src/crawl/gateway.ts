/**
 * The Gateway (AL4 1.1 row `gateway.ts`, 1.3 `createGateway`, `WAIT_CHUNK_MS`, `RENEW_AFTER_MS`,
 * 1.4.3; U5): wraps the injected transport and clock that the Wikimapia Client receives. It owns
 * the Request Budget, pacing between request starts, interrupts, request and Rate-Limit Wait
 * counting, and chunked waits with a Last Activity heartbeat. No database, no URL parsing.
 */
import { MAX_HEARTBEAT_INTERVAL_SECONDS } from '../../contracts/hydration.schema';
import type { CrawlClock } from '../../contracts/hydration.schema';
import type { TransportRequest, TransportResponse } from '../../contracts/wikimapia-client.schema';
import type {
  Gateway,
  GatewayCounts,
  GatewayOptions,
  RequestKind,
  Stop,
  StopReason,
} from './types';

/** Longest single wait: one minute less than the Last Activity interval (840000 ms). */
export const WAIT_CHUNK_MS = (MAX_HEARTBEAT_INTERVAL_SECONDS - 60) * 1000;
/** Last Activity is renewed once this long has passed since the last renewal. */
export const RENEW_AFTER_MS = 60_000;

/** Fixed text for a heartbeat that rejects; the rejection's own text is never copied. */
const HEARTBEAT_REJECTED_MESSAGE = 'Crawl failed: Last Activity could not be renewed.';

/** A refused request: no cause, so nothing from the crawl leaks into the Client failure. */
function refused(): Error {
  return new Error('request not sent by the crawl');
}

export function createGateway(options: GatewayOptions): Gateway {
  const inner = options.clock;
  const { signal } = options;

  let stopped: Stop | undefined;
  let sent = 0;
  const byKind: Record<RequestKind, number> = { listing: 0, details: 0 };
  let kind: RequestKind = 'listing';
  let lastStartMs: number | undefined;
  let lastRenewalMs = options.lastRenewalMs;
  let rateLimitWaits = 0;
  let rateLimitWaitMs = 0;

  const nowMs = (): number => inner.now().getTime();
  const aborted = (): boolean => signal?.aborted === true;
  /** Read through a function: `stop` may run during any await (heartbeat, sleep). */
  const isStopped = (): boolean => stopped !== undefined;

  function stop(reason: StopReason, message?: string): void {
    if (stopped !== undefined) return;
    stopped = message === undefined ? { reason } : { reason, message };
  }

  async function renewIfDue(): Promise<void> {
    if (nowMs() - lastRenewalMs < RENEW_AFTER_MS) return;
    try {
      const outcome = await options.heartbeat();
      if (outcome.ok) lastRenewalMs = nowMs();
      else stop('failed', outcome.message);
    } catch {
      stop('failed', HEARTBEAT_REJECTED_MESSAGE);
    }
  }

  async function waitChunked(ms: number): Promise<number> {
    let slept = 0;
    let remaining = ms;
    while (remaining > 0) {
      if (isStopped() || aborted()) break;
      await renewIfDue();
      if (isStopped()) break;
      const chunk = Math.min(remaining, WAIT_CHUNK_MS);
      const before = nowMs();
      await inner.sleep(chunk);
      const actual = Math.min(Math.max(nowMs() - before, 0), chunk);
      slept += actual;
      remaining -= chunk;
    }
    return slept;
  }

  async function transport(request: TransportRequest): Promise<TransportResponse> {
    if (isStopped()) throw refused();
    if (aborted()) {
      stop('interrupted');
      throw refused();
    }
    if (sent >= options.requestBudget) {
      stop('budget_reached', `Request Budget of ${String(options.requestBudget)} used up.`);
      throw refused();
    }
    if (lastStartMs !== undefined) {
      const dueMs = lastStartMs + options.minRequestIntervalSeconds * 1000 - nowMs();
      if (dueMs > 0) await waitChunked(dueMs);
      if (isStopped()) throw refused();
      if (aborted()) {
        stop('interrupted');
        throw refused();
      }
    }
    await renewIfDue();
    if (isStopped()) throw refused();
    lastStartMs = nowMs();
    sent += 1;
    byKind[kind] += 1;
    return options.transport(request);
  }

  const clock: CrawlClock = {
    now: () => inner.now(),
    sleep: async (ms: number): Promise<void> => {
      if (ms <= 0) return;
      rateLimitWaits += 1;
      rateLimitWaitMs += await waitChunked(ms);
    },
  };

  return {
    transport,
    clock,
    setKind(next: RequestKind): void {
      kind = next;
    },
    stop,
    get stopped(): Stop | undefined {
      return stopped;
    },
    get requestsSent(): number {
      return sent;
    },
    counts(): GatewayCounts {
      return {
        listingRequests: byKind.listing,
        detailsRequests: byKind.details,
        rateLimitWaits,
        rateLimitWaitMs,
      };
    },
    wait: waitChunked,
  };
}
