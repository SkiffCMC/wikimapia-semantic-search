/**
 * Runtime defaults (AL4 1.3 `runtime.ts` block, 1.4.10 Runtime defaults, AC-38): the real
 * HTTP transport built on `globalThis.fetch` and the real-time clock. Tests never use these
 * through the client; their unit tests stub `fetch` and use fake timers.
 */
import type { Clock, WikimapiaTransport } from '../../contracts/wikimapia-client.schema.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Largest delay a Node timer accepts; larger values are clamped to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Returns a transport that reads `globalThis.fetch` at call time. Creating it sends nothing.
 * Rejections propagate; `execute.ts` maps them to `connection`.
 */
export function createFetchTransport(options?: { timeoutMs?: number }): WikimapiaTransport {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return async ({ url }) => {
    const response = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}

/**
 * Wraps the global `setTimeout` (routing 2.2 fallback: Vitest fake timers do not intercept
 * `node:timers/promises` in this setup).
 */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sleep(ms: number): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await wait(chunk);
    remaining -= chunk;
  }
}

export const systemClock: Clock = { sleep };
