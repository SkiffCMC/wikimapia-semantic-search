/**
 * Runtime defaults of the Crawl (AL4 1.1 row `runtime.ts`, 1.3 `createSystemCrawlClock` and
 * `defaultTransport`, 1.4.3 "Interrupt" bullet; U5): the real-time `CrawlClock`, whose `sleep`
 * ends early (never rejects) when the Run's signal aborts, and the default HTTPS transport.
 * Tests never use these through a Run; their unit tests stub `fetch` and use fake timers.
 */
import type { CrawlClock } from '../../contracts/hydration.schema';
import type { WikimapiaTransport } from '../../contracts/wikimapia-client.schema';
import { createFetchTransport } from '../wikimapia/client';
import { MAX_TIMER_DELAY_MS } from '../wikimapia/runtime';

/**
 * Waits `ms` on the global `setTimeout` (so Vitest fake timers apply). Resolves early when
 * `signal` aborts, clearing the timer and removing its listener.
 */
function waitOnce(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Real-time clock; `sleep` resolves at once for `ms <= 0` or an aborted signal. */
export function createSystemCrawlClock(signal?: AbortSignal): CrawlClock {
  return {
    now: () => new Date(),
    sleep: async (ms: number): Promise<void> => {
      let remaining = ms;
      while (remaining > 0 && signal?.aborted !== true) {
        const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
        await waitOnce(chunk, signal);
        remaining -= chunk;
      }
    },
  };
}

/** The default transport: real HTTPS through the global `fetch`. Creating it sends nothing. */
export const defaultTransport = (): WikimapiaTransport => createFetchTransport();
