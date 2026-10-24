/**
 * AL2 unit tests: `src/crawl/gateway.ts` (AL4 1.4.3). Only what the contract tests do not reach:
 * the first stop winning, failing or rejecting heartbeats, and stops or aborts during a long
 * pacing wait. The transport is a stub and the clock the contract `SimulatedCrawlClock`.
 */
import { WAIT_CHUNK_MS, createGateway } from '../../src/crawl/gateway';
import type { HeartbeatOutcome } from '../../src/crawl/types';
import { MINUTE, SimulatedCrawlClock } from '../../contracts/hydration.support';

const REFUSED = 'request not sent by the crawl';
const FAILING = (): Promise<HeartbeatOutcome> =>
  Promise.resolve({ ok: false, message: 'renewal failed' });

function setup(
  options: {
    intervalSeconds?: number;
    heartbeat?: () => Promise<HeartbeatOutcome>;
    signal?: AbortSignal;
    onSleep?: () => void;
  } = {},
) {
  const clock = new SimulatedCrawlClock(
    undefined,
    options.onSleep === undefined ? {} : { onSleep: options.onSleep },
  );
  let sent = 0;
  const gateway = createGateway({
    transport: () => {
      sent += 1;
      return Promise.resolve({ status: 200, body: '{}' });
    },
    clock,
    signal: options.signal,
    minRequestIntervalSeconds: options.intervalSeconds ?? 0,
    requestBudget: 10,
    heartbeat: options.heartbeat ?? (() => Promise.resolve({ ok: true })),
    lastRenewalMs: clock.nowMilliseconds,
  });
  const send = () => gateway.transport({ url: 'https://api.wikimapia.org/' });
  return { clock, gateway, send, sent: () => sent };
}

describe('createGateway', () => {
  it('keeps the first stop with its Wikimapia text and then refuses every request', async () => {
    const { gateway, send, sent } = setup();
    gateway.stop('quota_exhausted', 'quota', 'Key limit');
    gateway.stop('failed', 'later');
    expect(gateway.stopped).toStrictEqual({
      reason: 'quota_exhausted',
      message: 'quota',
      wikimapiaMessage: 'Key limit',
    });
    await expect(send()).rejects.toThrow(REFUSED);
    expect(sent()).toBe(0);
  });

  it('its clock reads the injected clock, and sleep(0) is no Rate-Limit Wait', async () => {
    const { gateway, clock } = setup();
    await gateway.clock.sleep(0);
    expect(gateway.clock.now()).toStrictEqual(clock.now());
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it.each([
    ['answers not ok', FAILING, 'renewal failed'],
    [
      'rejects',
      () => Promise.reject(new Error('db down')),
      'Crawl failed: Last Activity could not be renewed.',
    ],
  ])(
    'a heartbeat that %s stops failed and refuses the request',
    async (_case, heartbeat, message) => {
      const { clock, gateway, send, sent } = setup({ heartbeat });
      clock.advance(MINUTE);
      await expect(send()).rejects.toThrow(REFUSED);
      expect(gateway.stopped).toStrictEqual({ reason: 'failed', message });
      expect(sent()).toBe(0);
    },
  );

  it('a heartbeat failing between chunks of a pacing wait ends the wait and refuses the request', async () => {
    const { clock, gateway, send, sent } = setup({ intervalSeconds: 2000, heartbeat: FAILING });
    await send();
    await expect(send()).rejects.toThrow(REFUSED);
    expect(clock.sleeps.map((s) => s.ms)).toStrictEqual([WAIT_CHUNK_MS]);
    expect(gateway.stopped).toStrictEqual({ reason: 'failed', message: 'renewal failed' });
    expect(sent()).toBe(1);
  });

  it('an abort during a pacing wait ends the wait and refuses the request, interrupted', async () => {
    const controller = new AbortController();
    const { clock, gateway, send, sent } = setup({
      intervalSeconds: 2000,
      signal: controller.signal,
      onSleep: () => {
        controller.abort();
      },
    });
    await send();
    await expect(send()).rejects.toThrow(REFUSED);
    expect(clock.sleeps.map((s) => s.ms)).toStrictEqual([WAIT_CHUNK_MS]);
    expect(gateway.stopped).toStrictEqual({ reason: 'interrupted' });
    expect(sent()).toBe(1);
  });
});
