/**
 * AL2 unit tests: `src/crawl/requests.ts` (AL4 1.4.4; crawl-run1-fixes AL4 1.4.3). Only the
 * classification branches the contract tests do not reach: stops from Key Quota and
 * Configuration failures, an abort during the Connection Failure back-off, and the Wikimapia Error message
 * rules. Hand-written `ClientCall`s over a real Gateway; no network, no real time.
 */
import { createGateway } from '../../src/crawl/gateway';
import { requestWithBackoff } from '../../src/crawl/requests';
import type { ClientCall } from '../../src/crawl/types';
import type { ClientFailure } from '../../contracts/wikimapia-client.schema';
import { SimulatedCrawlClock } from '../../contracts/hydration.support';

function setup(signal?: AbortSignal, onSleep?: () => void) {
  const clock = new SimulatedCrawlClock(undefined, onSleep === undefined ? {} : { onSleep });
  const gateway = createGateway({
    transport: () => Promise.reject(new Error('not used')),
    clock,
    signal,
    minRequestIntervalSeconds: 0,
    requestBudget: 10,
    heartbeat: () => Promise.resolve({ ok: true }),
    lastRenewalMs: clock.nowMilliseconds,
  });
  return { clock, gateway };
}

function failingCall(failure: ClientFailure): ClientCall<string> & { calls: number } {
  const call = Object.assign(
    () => {
      call.calls += 1;
      return Promise.resolve({ ok: false as const, failure });
    },
    { calls: 0 },
  );
  return call;
}

describe('requestWithBackoff', () => {
  it.each<[string, ClientFailure, object]>([
    [
      'key_quota_exhausted',
      { kind: 'key_quota_exhausted', message: 'quota', wikimapiaMessage: 'Key limit', code: 1004 },
      { reason: 'quota_exhausted', message: 'quota', wikimapiaMessage: 'Key limit' },
    ],
    [
      'configuration',
      { kind: 'configuration', message: 'no key' },
      { reason: 'failed', message: 'no key' },
    ],
  ])('a %s failure stops the Gateway after 1 call', async (_kind, failure, stop) => {
    const { gateway, clock } = setup();
    const call = failingCall(failure);
    expect(await requestWithBackoff(gateway, 'details', undefined, call)).toStrictEqual({
      kind: 'stopped',
    });
    expect(gateway.stopped).toStrictEqual(stop);
    expect(call.calls).toBe(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('an abort during the Connection Failure back-off stops interrupted without another call', async () => {
    const controller = new AbortController();
    const { gateway, clock } = setup(controller.signal, () => {
      controller.abort();
    });
    const call = failingCall({ kind: 'connection', message: 'gone' });
    expect(await requestWithBackoff(gateway, 'listing', controller.signal, call)).toStrictEqual({
      kind: 'stopped',
    });
    expect(gateway.stopped).toStrictEqual({ reason: 'interrupted' });
    expect(call.calls).toBe(1);
    expect(clock.sleeps.map((s) => s.ms)).toStrictEqual([30_000]);
  });

  it.each([
    ['', 'Wikimapia reported an error'],
    [' \n\t ', 'Wikimapia reported an error'],
    ['Bad\n\tkey  here ', 'Wikimapia reported an error: Bad key here'],
  ])('a Wikimapia Error with text %j is an Item Failure %j', async (text, message) => {
    const { gateway } = setup();
    const call = failingCall({
      kind: 'wikimapia_error',
      message: 'Wikimapia reported an error',
      wikimapiaMessage: text,
    });
    expect(await requestWithBackoff(gateway, 'listing', undefined, call)).toStrictEqual({
      kind: 'item_failure',
      failureKind: 'wikimapia_error',
      message,
    });
    expect(gateway.stopped).toBeUndefined();
  });
});
