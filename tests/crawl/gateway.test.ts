/**
 * AL2 unit tests: `src/crawl/gateway.ts` (AL4 1.1 row `gateway.ts`, 1.3 `GatewayOptions`/`Gateway`,
 * `WAIT_CHUNK_MS`, `RENEW_AFTER_MS`; 1.4.3 Gateway; section 3; AL6 AC-39 .. AC-43, AC-46 request
 * side, AC-51, AC-52, AC-70, AC-71; U5).
 *
 * The real Wikimapia Client runs over the Gateway's wrapped transport and clock. The injected
 * collaborators are the contract doubles: `SimulatedCrawlClock` and `CrawlWikimapia`. The
 * heartbeat is a fake that records the Simulated Clock reading at each call. No database, no
 * network, no real time. Answers are synthetic or recorded fixtures; the API key is `TEST_API_KEY`.
 */
import { RENEW_AFTER_MS, WAIT_CHUNK_MS, createGateway } from '../../src/crawl/gateway';
import type { HeartbeatOutcome } from '../../src/crawl/types';
import { createWikimapiaClient } from '../../src/wikimapia/client';
import {
  CRAWL_QUOTA_SHARE,
  DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
  DEFAULT_REQUEST_BUDGET,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  findPacingIssues,
} from '../../contracts/hydration.schema';
import {
  DEFAULT_FALLBACK_WAIT_SECONDS,
  type TransportResponse,
} from '../../contracts/wikimapia-client.schema';
import {
  CrawlWikimapia,
  HOUR,
  MINUTE,
  RUN_START,
  SECOND,
  SMALL_BBOX,
  SimulatedCrawlClock,
  T1_TILES,
  TEST_API_KEY,
  at,
  listingAnswer,
  rateLimitAnswer,
  scripted,
  syntheticBoxPlace,
  type Responder,
  type Script,
} from '../../contracts/hydration.support';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  /** Answers by Tile 1 page and Place ID; unscripted pages are empty, unscripted Places synthetic. */
  script?: Omit<Script, 'tiles'>;
  /** Replaces the scripted responder entirely. */
  responder?: Responder;
  minRequestIntervalSeconds?: number;
  requestBudget?: number;
  signal?: AbortSignal;
  heartbeat?: () => Promise<HeartbeatOutcome>;
  onSleep?: (atMs: number, ms: number) => void | Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const clock = new SimulatedCrawlClock(
    RUN_START,
    options.onSleep === undefined ? {} : { onSleep: options.onSleep },
  );
  const wikimapia = new CrawlWikimapia(
    clock,
    options.responder ?? scripted({ tiles: T1_TILES, ...options.script }),
  );
  const heartbeats: number[] = [];
  const inner = options.heartbeat ?? (() => Promise.resolve<HeartbeatOutcome>({ ok: true }));
  const gateway = createGateway({
    transport: wikimapia.transport,
    clock,
    signal: options.signal,
    minRequestIntervalSeconds:
      options.minRequestIntervalSeconds ?? DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
    requestBudget: options.requestBudget ?? DEFAULT_REQUEST_BUDGET,
    heartbeat: () => {
      heartbeats.push(clock.nowMilliseconds);
      return inner();
    },
    lastRenewalMs: clock.nowMilliseconds,
  });
  const client = createWikimapiaClient({
    apiKey: TEST_API_KEY,
    transport: gateway.transport,
    clock: gateway.clock,
  });
  const T0 = clock.nowMilliseconds;
  return { clock, wikimapia, gateway, client, heartbeats, T0 };
}

/** A synthetic `box` answer for `page` of Tile 1 holding one Place. */
function pageAnswer(page: number): TransportResponse {
  return listingAnswer([syntheticBoxPlace(9000 + page, 20.457, 44.817)], page, 100, 300);
}

function listPage(client: ReturnType<typeof harness>['client'], page: number) {
  return client.listPlaces({ bbox: SMALL_BBOX, page });
}

const FAILING: () => Promise<HeartbeatOutcome> = () =>
  Promise.resolve({ ok: false, message: 'renewal failed' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('WAIT_CHUNK_MS is MAX_HEARTBEAT_INTERVAL_SECONDS minus one minute, RENEW_AFTER_MS one minute', () => {
    expect(WAIT_CHUNK_MS).toBe((MAX_HEARTBEAT_INTERVAL_SECONDS - 60) * 1000);
    expect(WAIT_CHUNK_MS).toBe(840_000);
    expect(RENEW_AFTER_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// A. Pacing (AC-39, AC-40, AC-71)
// ---------------------------------------------------------------------------

describe('pacing', () => {
  it('interval 2 s, 5 instant answers: starts exactly 2 s apart, the first not delayed', async () => {
    const { client, wikimapia, gateway, clock, heartbeats, T0 } = harness({
      minRequestIntervalSeconds: 2,
      script: { listing: { 1: [1, 2, 3, 4, 5].map(pageAnswer) } },
    });
    for (let page = 1; page <= 5; page += 1) {
      expect((await listPage(client, page)).ok).toBe(true);
    }
    expect(wikimapia.startTimes).toStrictEqual([
      T0,
      T0 + 2 * SECOND,
      T0 + 4 * SECOND,
      T0 + 6 * SECOND,
      T0 + 8 * SECOND,
    ]);
    expect(findPacingIssues(wikimapia.startTimes, 2)).toStrictEqual([]);
    expect(clock.sleeps.every((s) => s.ms <= 2 * SECOND)).toBe(true);
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(gateway.counts().rateLimitWaitMs).toBe(0);
    expect(heartbeats).toStrictEqual([]);
    expect(gateway.stopped).toBeUndefined();
  });

  it('a 3 s answer adds no further delay: the next start is exactly 3 s later, no pacing sleep', async () => {
    const { client, wikimapia, clock } = harness({
      minRequestIntervalSeconds: 2,
      script: { listing: { 1: [{ delayMs: 3 * SECOND, then: pageAnswer(1) }, pageAnswer(2)] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    expect((await listPage(client, 2)).ok).toBe(true);
    expect(wikimapia.calls).toHaveLength(2);
    expect(at(wikimapia.startTimes, 1) - at(wikimapia.startTimes, 0)).toBe(3 * SECOND);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('paces a Client retry after a Rate-Limit Response as well', async () => {
    const { client, wikimapia, gateway } = harness({
      minRequestIntervalSeconds: 2,
      script: { listing: { 1: [[rateLimitAnswer(0), pageAnswer(1)]] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    expect(wikimapia.calls).toHaveLength(2);
    expect(at(wikimapia.calls, 0).page).toBe(1);
    expect(at(wikimapia.calls, 1).page).toBe(1);
    expect(at(wikimapia.calls, 1).attempt).toBe(2);
    expect(at(wikimapia.startTimes, 1) - at(wikimapia.startTimes, 0)).toBeGreaterThanOrEqual(
      2 * SECOND,
    );
    expect(findPacingIssues(wikimapia.startTimes, 2)).toStrictEqual([]);
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(gateway.requestsSent).toBe(2);
  });

  it('default interval: 60 requests never break the interval nor the Crawl Quota Share window', async () => {
    const { client, wikimapia, gateway } = harness();
    gateway.setKind('details');
    for (let id = 9001; id <= 9060; id += 1) {
      expect((await client.getPlaceDetails({ placeId: id })).ok).toBe(true);
    }
    expect(wikimapia.calls).toHaveLength(60);
    expect(
      findPacingIssues(wikimapia.startTimes, DEFAULT_MIN_REQUEST_INTERVAL_SECONDS, {
        windowSeconds: CRAWL_QUOTA_SHARE.windowSeconds,
        maxPerWindow: CRAWL_QUOTA_SHARE.requests,
      }),
    ).toStrictEqual([]);
    expect(gateway.requestsSent).toBe(60);
  });

  it('interval 0 never sleeps for pacing', async () => {
    const { client, wikimapia, clock, T0 } = harness({
      minRequestIntervalSeconds: 0,
      script: { listing: { 1: [1, 2, 3, 4, 5].map(pageAnswer) } },
    });
    for (let page = 1; page <= 5; page += 1) {
      expect((await listPage(client, page)).ok).toBe(true);
    }
    expect(wikimapia.startTimes).toStrictEqual([T0, T0, T0, T0, T0]);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. Budget and counting (AC-41, AC-42, AC-43, AC-51, AC-52)
// ---------------------------------------------------------------------------

describe('Request Budget', () => {
  it('budget 3: exactly 3 transport calls, the 4th Client call is a connection failure, budget_reached', async () => {
    const { client, wikimapia, gateway } = harness({
      minRequestIntervalSeconds: 0,
      requestBudget: 3,
      script: { listing: { 1: [1, 2, 3, 4].map(pageAnswer) } },
    });
    for (let page = 1; page <= 3; page += 1) {
      expect((await listPage(client, page)).ok).toBe(true);
    }
    expect(gateway.stopped).toBeUndefined();
    const fourth = await listPage(client, 4);
    expect(fourth).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(3);
    expect(gateway.stopped).toStrictEqual({
      reason: 'budget_reached',
      message: 'Request Budget of 3 used up.',
    });
    expect(gateway.requestsSent).toBe(3);
  });

  it('budget 0: the first request is refused, nothing is sent, no pacing sleep', async () => {
    const { client, wikimapia, gateway, clock } = harness({
      minRequestIntervalSeconds: 2,
      requestBudget: 0,
    });
    const result = await listPage(client, 1);
    expect(result).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(0);
    expect(gateway.stopped).toStrictEqual({
      reason: 'budget_reached',
      message: 'Request Budget of 0 used up.',
    });
    expect(gateway.requestsSent).toBe(0);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('includes Client retries and is checked before pacing (budget 2)', async () => {
    const { client, wikimapia, gateway, clock, T0 } = harness({
      minRequestIntervalSeconds: 2,
      requestBudget: 2,
      script: { listing: { 1: [pageAnswer(1), [rateLimitAnswer(1), pageAnswer(2)]] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    const second = await listPage(client, 2);
    expect(second).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(2);
    expect(gateway.stopped?.reason).toBe('budget_reached');
    expect(gateway.requestsSent).toBe(2);
    // pacing before request 2, then the 1 s Rate-Limit Wait; nothing after the refusal
    expect(clock.sleeps).toStrictEqual([
      { atMs: T0, ms: 2 * SECOND },
      { atMs: T0 + 2 * SECOND, ms: 1 * SECOND },
    ]);
  });

  it('a stopped Gateway sends nothing further', async () => {
    const { client, wikimapia, gateway } = harness({ minRequestIntervalSeconds: 0 });
    gateway.stop('failed', 'stopped by the test');
    const result = await listPage(client, 1);
    expect(result).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(0);
    expect(gateway.requestsSent).toBe(0);
    expect(gateway.stopped).toStrictEqual({ reason: 'failed', message: 'stopped by the test' });
  });
});

describe('counting', () => {
  it('counts requests by the kind set with setKind; the sum equals requestsSent and the calls', async () => {
    const { client, wikimapia, gateway } = harness({
      minRequestIntervalSeconds: 0,
      script: { listing: { 1: [pageAnswer(1), pageAnswer(2)] } },
    });
    gateway.setKind('listing');
    expect((await listPage(client, 1)).ok).toBe(true);
    expect((await listPage(client, 2)).ok).toBe(true);
    gateway.setKind('details');
    for (const placeId of [9101, 9102, 9103]) {
      expect((await client.getPlaceDetails({ placeId })).ok).toBe(true);
    }
    const counts = gateway.counts();
    expect(counts).toStrictEqual({
      listingRequests: 2,
      detailsRequests: 3,
      rateLimitWaits: 0,
      rateLimitWaitMs: 0,
    });
    expect(counts.listingRequests + counts.detailsRequests).toBe(gateway.requestsSent);
    expect(gateway.requestsSent).toBe(wikimapia.calls.length);
  });

  it('counts a request as listing until setKind is called', async () => {
    const { client, gateway } = harness({ minRequestIntervalSeconds: 0 });
    expect((await client.getPlaceDetails({ placeId: 9201 })).ok).toBe(true);
    expect(gateway.counts().listingRequests).toBe(1);
    expect(gateway.counts().detailsRequests).toBe(0);
  });

  it('a 1 s Rate-Limit Response is one more request and one Rate-Limit Wait of 1000 ms', async () => {
    const { client, gateway } = harness({
      minRequestIntervalSeconds: 0,
      script: { listing: { 1: [[rateLimitAnswer(1), pageAnswer(1)]] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    expect(gateway.counts().rateLimitWaits).toBe(1);
    expect(gateway.counts().rateLimitWaitMs).toBe(1000);
    expect(gateway.requestsSent).toBe(2);
  });

  it('a 0 s Rate-Limit Response adds no Rate-Limit Wait', async () => {
    const { client, gateway, clock } = harness({
      minRequestIntervalSeconds: 0,
      script: { listing: { 1: [[rateLimitAnswer(0), pageAnswer(1)]] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(gateway.counts().rateLimitWaitMs).toBe(0);
    expect(gateway.requestsSent).toBe(2);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('a Rate-Limit Response without readable seconds counts one Fallback Wait', async () => {
    const { client, gateway } = harness({
      minRequestIntervalSeconds: 0,
      script: { listing: { 1: [[rateLimitAnswer('a few'), pageAnswer(1)]] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    expect(gateway.counts().rateLimitWaits).toBe(1);
    expect(gateway.counts().rateLimitWaitMs).toBe(DEFAULT_FALLBACK_WAIT_SECONDS * 1000);
  });

  it('pacing sleeps are not Rate-Limit Waits', async () => {
    const { client, gateway, clock } = harness({
      minRequestIntervalSeconds: 2,
      script: { listing: { 1: [pageAnswer(1), pageAnswer(2)] } },
    });
    await listPage(client, 1);
    await listPage(client, 2);
    expect(clock.sleeps).toHaveLength(1);
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(gateway.counts().rateLimitWaitMs).toBe(0);
  });

  it("the crawl's own wait returns the time waited and is not a Rate-Limit Wait", async () => {
    const { gateway, clock, T0 } = harness();
    await expect(gateway.wait(30_000)).resolves.toBe(30_000);
    expect(clock.nowMilliseconds).toBe(T0 + 30_000);
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(gateway.counts().rateLimitWaitMs).toBe(0);
    expect(gateway.requestsSent).toBe(0);
  });

  it('wait(0) and gateway.clock.sleep(0) do not sleep and count nothing', async () => {
    const { gateway, clock } = harness();
    await expect(gateway.wait(0)).resolves.toBe(0);
    await gateway.clock.sleep(0);
    expect(clock.sleeps).toStrictEqual([]);
    expect(gateway.counts().rateLimitWaits).toBe(0);
  });

  it('gateway.clock.now() reads the injected clock', () => {
    const { gateway, clock } = harness();
    clock.advance(5 * SECOND);
    expect(gateway.clock.now().getTime()).toBe(clock.nowMilliseconds);
  });
});

// ---------------------------------------------------------------------------
// C. Chunked waits and heartbeat (AC-70)
// ---------------------------------------------------------------------------

describe('chunked waits and Last Activity heartbeat', () => {
  it('a 3-hour Rate-Limit Wait is slept in chunks of at most 840 s, with a heartbeat before every chunk after the first minute', async () => {
    const { client, gateway, clock, heartbeats, T0 } = harness({
      script: { listing: { 1: [[rateLimitAnswer(3 * 3600), pageAnswer(1)]] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);

    expect(clock.sleeps.length).toBeGreaterThan(1);
    expect(clock.sleeps.every((s) => s.ms > 0 && s.ms <= WAIT_CHUNK_MS)).toBe(true);
    expect(clock.sleeps.reduce((sum, s) => sum + s.ms, 0)).toBe(3 * HOUR);
    expect(gateway.counts().rateLimitWaits).toBe(1);
    expect(gateway.counts().rateLimitWaitMs).toBe(3 * HOUR);
    expect(gateway.requestsSent).toBe(2);

    // the first chunk starts at the Run start (no renewal due); every later chunk and the retry
    // request renew first
    expect(at(clock.sleeps, 0).atMs).toBe(T0);
    expect(heartbeats).toStrictEqual([
      ...clock.sleeps.slice(1).map((s) => s.atMs),
      T0 + 3 * HOUR,
    ]);

    for (const sleep of clock.sleeps) {
      const lastRenewal = Math.max(T0, ...heartbeats.filter((h) => h <= sleep.atMs));
      expect(sleep.atMs + sleep.ms - lastRenewal).toBeLessThanOrEqual(
        MAX_HEARTBEAT_INTERVAL_SECONDS * SECOND,
      );
    }
  });

  it('no heartbeat within the first minute; the first request 60 s after the last renewal renews first', async () => {
    const events: string[] = [];
    const base = scripted({ tiles: T1_TILES });
    const { client, clock, heartbeats, T0 } = harness({
      minRequestIntervalSeconds: 0,
      responder: (call) => {
        events.push('request');
        return base(call);
      },
      heartbeat: () => {
        events.push('heartbeat');
        return Promise.resolve({ ok: true });
      },
    });

    await listPage(client, 1);
    clock.advance(59 * SECOND);
    await listPage(client, 2);
    expect(heartbeats).toStrictEqual([]);

    clock.advance(1 * SECOND);
    await listPage(client, 3);
    expect(heartbeats).toStrictEqual([T0 + MINUTE]);
    expect(events).toStrictEqual(['request', 'request', 'heartbeat', 'request']);

    // the renewal restarts the minute
    clock.advance(30 * SECOND);
    await listPage(client, 4);
    expect(heartbeats).toStrictEqual([T0 + MINUTE]);
  });

  it('a heartbeat that fails stops the Gateway failed and the request that triggered it is not sent', async () => {
    const { client, wikimapia, gateway, clock, heartbeats } = harness({ heartbeat: FAILING });
    expect((await listPage(client, 1)).ok).toBe(true);
    clock.advance(MINUTE);
    const second = await listPage(client, 2);
    expect(second).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(heartbeats).toHaveLength(1);
    expect(wikimapia.calls).toHaveLength(1);
    expect(gateway.requestsSent).toBe(1);
    expect(gateway.stopped).toStrictEqual({ reason: 'failed', message: 'renewal failed' });
  });

  it('a heartbeat that fails ends a Rate-Limit Wait in progress: no further chunk, no retry', async () => {
    const { client, wikimapia, gateway, clock, heartbeats, T0 } = harness({
      heartbeat: FAILING,
      script: { listing: { 1: [[rateLimitAnswer(3 * 3600), pageAnswer(1)]] } },
    });
    const result = await listPage(client, 1);
    expect(result.ok).toBe(false);
    expect(clock.sleeps).toStrictEqual([{ atMs: T0, ms: WAIT_CHUNK_MS }]);
    expect(heartbeats).toStrictEqual([T0 + WAIT_CHUNK_MS]);
    expect(wikimapia.calls).toHaveLength(1);
    expect(gateway.stopped).toStrictEqual({ reason: 'failed', message: 'renewal failed' });
    expect(gateway.counts().rateLimitWaits).toBe(1);
    expect(gateway.counts().rateLimitWaitMs).toBe(WAIT_CHUNK_MS);
  });

  it("a heartbeat that fails ends the crawl's own wait early", async () => {
    const { gateway, clock, T0 } = harness({ heartbeat: FAILING });
    await expect(gateway.wait(3 * HOUR)).resolves.toBe(WAIT_CHUNK_MS);
    expect(clock.sleeps).toStrictEqual([{ atMs: T0, ms: WAIT_CHUNK_MS }]);
    expect(gateway.stopped?.reason).toBe('failed');
  });

  describe('a heartbeat that rejects', () => {
    const LEAK = 'postgres://user:secret@host/db';
    const rejecting = (): Promise<HeartbeatOutcome> => Promise.reject(new Error(LEAK));

    it('before a request: stops failed, never rejects into the Client, copies no error text', async () => {
      const { client, wikimapia, gateway, clock } = harness({ heartbeat: rejecting });
      expect((await listPage(client, 1)).ok).toBe(true);
      clock.advance(MINUTE);
      const second = await listPage(client, 2);
      expect(second).toMatchObject({ ok: false, failure: { kind: 'connection' } });
      expect(wikimapia.calls).toHaveLength(1);
      expect(gateway.stopped?.reason).toBe('failed');
      expect(gateway.stopped?.message).toEqual(expect.any(String));
      expect(gateway.stopped?.message?.length).toBeGreaterThan(0);
      const text = JSON.stringify(gateway.stopped);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('postgres://');
      expect(JSON.stringify(second)).not.toContain('secret');
    });

    it('during a Rate-Limit Wait: the Client call still resolves, no further chunk', async () => {
      const { client, wikimapia, gateway, clock } = harness({
        heartbeat: rejecting,
        script: { listing: { 1: [[rateLimitAnswer(3 * 3600), pageAnswer(1)]] } },
      });
      const result = await listPage(client, 1);
      expect(result.ok).toBe(false);
      expect(clock.sleeps).toHaveLength(1);
      expect(wikimapia.calls).toHaveLength(1);
      expect(gateway.stopped?.reason).toBe('failed');
      expect(JSON.stringify(gateway.stopped)).not.toContain('secret');
    });

    it("during the crawl's own wait: resolves with the time waited", async () => {
      const { gateway, clock } = harness({ heartbeat: rejecting });
      clock.advance(MINUTE);
      await expect(gateway.wait(2 * WAIT_CHUNK_MS)).resolves.toBe(0);
      expect(clock.sleeps).toStrictEqual([]);
      expect(gateway.stopped?.reason).toBe('failed');
    });
  });
});

describe('stop', () => {
  it('is undefined until stopped', () => {
    const { gateway } = harness();
    expect(gateway.stopped).toBeUndefined();
  });

  it('keeps the first stop', () => {
    const { gateway } = harness();
    gateway.stop('budget_reached', 'Request Budget of 3 used up.');
    gateway.stop('failed', 'later failure');
    gateway.stop('interrupted');
    expect(gateway.stopped).toStrictEqual({
      reason: 'budget_reached',
      message: 'Request Budget of 3 used up.',
    });
  });

  // crawl-run1-fixes AL4 1.4.3, U5: the stop keeps the optional Wikimapia text.
  it("stop('quota_exhausted', message, wikimapiaMessage) keeps all three", () => {
    const { gateway } = harness();
    gateway.stop('quota_exhausted', 'm', 'w');
    expect(gateway.stopped).toStrictEqual({
      reason: 'quota_exhausted',
      message: 'm',
      wikimapiaMessage: 'w',
    });
  });

  it('the first stop wins with its wikimapiaMessage: later stops change nothing', () => {
    const { gateway } = harness();
    gateway.stop('quota_exhausted', 'first message', 'first Wikimapia text');
    gateway.stop('quota_exhausted', 'second message', 'second Wikimapia text');
    gateway.stop('failed', 'later failure');
    gateway.stop('interrupted');
    expect(gateway.stopped).toStrictEqual({
      reason: 'quota_exhausted',
      message: 'first message',
      wikimapiaMessage: 'first Wikimapia text',
    });
  });

  it('a first stop without a Wikimapia text is not completed by a later one', () => {
    const { gateway } = harness();
    gateway.stop('budget_reached', 'Request Budget of 3 used up.');
    gateway.stop('quota_exhausted', 'quota message', 'Key limit has been reached');
    expect(gateway.stopped).toStrictEqual({
      reason: 'budget_reached',
      message: 'Request Budget of 3 used up.',
    });
    expect(Object.keys(gateway.stopped ?? {})).not.toContain('wikimapiaMessage');
  });

  it('absent arguments are absent keys, not undefined', () => {
    const interrupted = harness().gateway;
    interrupted.stop('interrupted');
    expect(interrupted.stopped).toStrictEqual({ reason: 'interrupted' });
    expect(Object.keys(interrupted.stopped ?? {})).toStrictEqual(['reason']);

    const failed = harness().gateway;
    failed.stop('failed', 'm');
    expect(failed.stopped).toStrictEqual({ reason: 'failed', message: 'm' });
    expect(Object.keys(failed.stopped ?? {}).sort()).toStrictEqual(['message', 'reason']);
  });

  it("an empty wikimapiaMessage is kept as ''", () => {
    const { gateway } = harness();
    gateway.stop('quota_exhausted', 'm', '');
    expect(gateway.stopped).toStrictEqual({
      reason: 'quota_exhausted',
      message: 'm',
      wikimapiaMessage: '',
    });
    expect(Object.keys(gateway.stopped ?? {})).toContain('wikimapiaMessage');
  });

  it('after a quota_exhausted stop, further requests are refused without a transport call', async () => {
    const { gateway, client, wikimapia } = harness({
      script: { listing: { 1: [pageAnswer(1)] } },
    });
    gateway.stop('quota_exhausted', 'm', 'w');
    const result = await listPage(client, 1);
    expect(result).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(0);
    expect(gateway.requestsSent).toBe(0);
    expect(gateway.stopped).toStrictEqual({
      reason: 'quota_exhausted',
      message: 'm',
      wikimapiaMessage: 'w',
    });
  });
});

// ---------------------------------------------------------------------------
// D. Interrupt (AC-46, request side)
// ---------------------------------------------------------------------------

describe('interrupt', () => {
  it('a signal aborted before the first request: nothing is sent, interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, wikimapia, gateway } = harness({ signal: controller.signal });
    const result = await listPage(client, 1);
    expect(result).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(0);
    expect(gateway.requestsSent).toBe(0);
    expect(gateway.stopped?.reason).toBe('interrupted');
  });

  it('an abort during an answer: that answer still arrives, the next request is refused', async () => {
    const controller = new AbortController();
    const { client, wikimapia, gateway } = harness({
      signal: controller.signal,
      minRequestIntervalSeconds: 0,
      script: {
        listing: {
          1: [
            {
              effect: () => {
                controller.abort();
              },
              then: pageAnswer(1),
            },
            pageAnswer(2),
          ],
        },
      },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    const second = await listPage(client, 2);
    expect(second).toMatchObject({ ok: false, failure: { kind: 'connection' } });
    expect(wikimapia.calls).toHaveLength(1);
    expect(gateway.stopped?.reason).toBe('interrupted');
  });

  it('an abort during a long Rate-Limit Wait: no further chunk, no further request', async () => {
    const controller = new AbortController();
    const { client, wikimapia, gateway, clock, heartbeats } = harness({
      signal: controller.signal,
      onSleep: () => {
        controller.abort();
      },
      script: { listing: { 1: [[rateLimitAnswer(3 * 3600), pageAnswer(1)]] } },
    });
    const result = await listPage(client, 1);
    expect(result.ok).toBe(false);
    expect(clock.sleeps).toHaveLength(1);
    expect(wikimapia.calls).toHaveLength(1);
    expect(heartbeats).toStrictEqual([]);
    expect(gateway.stopped?.reason).toBe('interrupted');
    expect(gateway.counts().rateLimitWaits).toBe(1);
    expect(gateway.counts().rateLimitWaitMs).toBe(WAIT_CHUNK_MS);
  });

  it('an abort during a pacing wait: the paced request is not sent', async () => {
    const controller = new AbortController();
    const { client, wikimapia, gateway } = harness({
      signal: controller.signal,
      minRequestIntervalSeconds: 2,
      onSleep: () => {
        controller.abort();
      },
      script: { listing: { 1: [pageAnswer(1), pageAnswer(2)] } },
    });
    expect((await listPage(client, 1)).ok).toBe(true);
    const second = await listPage(client, 2);
    expect(second.ok).toBe(false);
    expect(wikimapia.calls).toHaveLength(1);
    expect(gateway.requestsSent).toBe(1);
    expect(gateway.stopped?.reason).toBe('interrupted');
  });
});
