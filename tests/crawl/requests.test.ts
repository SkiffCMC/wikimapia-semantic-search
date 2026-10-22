/**
 * AL2 unit tests: `src/crawl/requests.ts` (AL4 1.3 `Requested<T>`, `ClientCall<T>`,
 * `requestWithBackoff`; 1.4.4 One Client call with back-off and classification; section 3;
 * AL6 AC-17, AC-18, AC-43, AC-44, AC-46, AC-48; U5).
 *
 * The real Wikimapia Client runs over a real Gateway (`createGateway`) that wraps the contract
 * doubles `SimulatedCrawlClock` and `CrawlWikimapia`; a few classification cases use a
 * hand-written `ClientCall`. The heartbeat is a fake that always succeeds. No database, no
 * network, no real time. Answers are synthetic or recorded fixtures; the API key is `TEST_API_KEY`.
 */
import { createGateway } from '../../src/crawl/gateway';
import { requestWithBackoff } from '../../src/crawl/requests';
import type { ClientCall, HeartbeatOutcome } from '../../src/crawl/types';
import { createWikimapiaClient } from '../../src/wikimapia/client';
import {
  CONNECTION_RETRY_WAITS_SECONDS,
  DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
  DEFAULT_REQUEST_BUDGET,
} from '../../contracts/hydration.schema';
import {
  DEFAULT_RETRY_LIMIT,
  type ClientFailure,
  type TransportResponse,
} from '../../contracts/wikimapia-client.schema';
import {
  CrawlWikimapia,
  RUN_START,
  SECOND,
  SMALL_BBOX,
  SimulatedCrawlClock,
  T1_TILES,
  TEST_API_KEY,
  UNREACHABLE,
  at,
  detailsAnswer,
  listingAnswer,
  rateLimitAnswer,
  rateLimitForever,
  scripted,
  syntheticBoxPlace,
  unexpectedAnswer,
  wikimapiaErrorAnswer,
  type SimulatedAnswer,
  type Script,
} from '../../contracts/hydration.support';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  script?: Omit<Script, 'tiles'>;
  minRequestIntervalSeconds?: number;
  requestBudget?: number;
  signal?: AbortSignal;
  onSleep?: (atMs: number, ms: number) => void | Promise<void>;
  apiKey?: string;
}

function harness(options: HarnessOptions = {}) {
  const clock = new SimulatedCrawlClock(
    RUN_START,
    options.onSleep === undefined ? {} : { onSleep: options.onSleep },
  );
  const wikimapia = new CrawlWikimapia(clock, scripted({ tiles: T1_TILES, ...options.script }));
  const heartbeats: number[] = [];
  const gateway = createGateway({
    transport: wikimapia.transport,
    clock,
    signal: options.signal,
    minRequestIntervalSeconds:
      options.minRequestIntervalSeconds ?? DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
    requestBudget: options.requestBudget ?? DEFAULT_REQUEST_BUDGET,
    heartbeat: () => {
      heartbeats.push(clock.nowMilliseconds);
      return Promise.resolve<HeartbeatOutcome>({ ok: true });
    },
    lastRenewalMs: clock.nowMilliseconds,
  });
  const client = createWikimapiaClient({
    apiKey: options.apiKey ?? TEST_API_KEY,
    transport: gateway.transport,
    clock: gateway.clock,
  });
  return { clock, wikimapia, gateway, client, heartbeats };
}

function pageAnswer(page: number): TransportResponse {
  return listingAnswer([syntheticBoxPlace(9000 + page, 20.457, 44.817)], page, 100, 300);
}

/** Answers every request with `answers` (the last repeats) for Tile 1 page 1. */
function page1(...answers: SimulatedAnswer[]): Omit<Script, 'tiles'> {
  return { listing: { 1: [answers.length === 1 ? at(answers, 0) : answers] } };
}

/** The Client's own failure for one answer, without Gateway or crawl (for message comparison). */
async function directFailure(
  answerWith: SimulatedAnswer,
  input: { pageSize?: number } = {},
  apiKey: string = TEST_API_KEY,
): Promise<ClientFailure> {
  const clock = new SimulatedCrawlClock();
  const wikimapia = new CrawlWikimapia(clock, () => answerWith);
  const client = createWikimapiaClient({ apiKey, transport: wikimapia.transport, clock });
  const result = await client.listPlaces({ bbox: SMALL_BBOX, page: 1, ...input });
  if (result.ok) throw new Error('expected the Client to fail');
  return result.failure;
}

// ---------------------------------------------------------------------------
// Connection Failures and back-off (AC-17)
// ---------------------------------------------------------------------------

describe('requestWithBackoff: Connection Failures', () => {
  it('always unreachable: 3 calls, 30 s then 60 s apart, then an Item Failure connection', async () => {
    const { client, gateway, wikimapia, clock } = harness({
      minRequestIntervalSeconds: 0,
      script: page1(UNREACHABLE),
    });
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(wikimapia.calls).toHaveLength(1 + CONNECTION_RETRY_WAITS_SECONDS.length);
    expect(wikimapia.calls).toHaveLength(3);
    expect(at(wikimapia.startTimes, 1) - at(wikimapia.startTimes, 0)).toBe(30 * SECOND);
    expect(at(wikimapia.startTimes, 2) - at(wikimapia.startTimes, 1)).toBe(60 * SECOND);
    expect(clock.sleeps.map((s) => s.ms)).toStrictEqual([30 * SECOND, 60 * SECOND]);

    const direct = await directFailure(UNREACHABLE);
    expect(result).toStrictEqual({
      kind: 'item_failure',
      failureKind: 'connection',
      message: direct.message,
    });
    if (result.kind !== 'item_failure') throw new Error('expected an Item Failure');
    expect(result.message).not.toContain('key=');
    expect(result.message).not.toContain(TEST_API_KEY);
    expect(result.message).not.toContain('ECONNREFUSED while requesting');
    expect(gateway.counts().rateLimitWaits).toBe(0);
    expect(gateway.counts().rateLimitWaitMs).toBe(0);
    expect(gateway.stopped).toBeUndefined();
  });

  it('unreachable once, then answered: 2 calls and ok', async () => {
    const { client, gateway, wikimapia } = harness({
      minRequestIntervalSeconds: 0,
      script: page1(UNREACHABLE, pageAnswer(1)),
    });
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(wikimapia.calls).toHaveLength(2);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.places.map((p) => p.placeId)).toStrictEqual([9001]);
    expect(gateway.stopped).toBeUndefined();
  });

  it('an aborted signal on a Connection Failure stops interrupted without backing off', async () => {
    const { gateway, clock } = harness();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const call: ClientCall<string> = () => {
      calls += 1;
      return Promise.resolve({ ok: false, failure: { kind: 'connection', message: 'gone' } });
    };
    const result = await requestWithBackoff(gateway, 'listing', controller.signal, call);
    expect(result).toStrictEqual({ kind: 'stopped' });
    expect(calls).toBe(1);
    expect(clock.sleeps).toStrictEqual([]);
    expect(gateway.stopped?.reason).toBe('interrupted');
  });

  it('an abort during the 30 s back-off: stopped, interrupted, no further call', async () => {
    const controller = new AbortController();
    const { client, gateway, wikimapia, clock } = harness({
      minRequestIntervalSeconds: 0,
      signal: controller.signal,
      onSleep: () => {
        controller.abort();
      },
      script: page1(UNREACHABLE),
    });
    const result = await requestWithBackoff(gateway, 'listing', controller.signal, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(result).toStrictEqual({ kind: 'stopped' });
    expect(gateway.stopped?.reason).toBe('interrupted');
    expect(wikimapia.calls).toHaveLength(1);
    expect(clock.sleeps).toHaveLength(1);
    expect(at(clock.sleeps, 0).ms).toBe(30 * SECOND);
  });
});

// ---------------------------------------------------------------------------
// Failures that are not retried (AC-18)
// ---------------------------------------------------------------------------

describe('requestWithBackoff: failures without retry', () => {
  for (const [kind, answerFor] of [
    ['wikimapia_error', wikimapiaErrorAnswer],
    ['unexpected_response', unexpectedAnswer],
  ] as const) {
    it(`a ${kind} makes 1 call and is an Item Failure ${kind} with the Client's message`, async () => {
      const { client, gateway, wikimapia } = harness({ script: page1(answerFor()) });
      const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
        client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
      );
      expect(wikimapia.calls).toHaveLength(1);
      const direct = await directFailure(answerFor());
      expect(result).toStrictEqual({ kind: 'item_failure', failureKind: kind, message: direct.message });
      expect(gateway.stopped).toBeUndefined();
    });
  }

  it('an invalid request makes no call and is an Item Failure invalid_request', async () => {
    const { client, gateway, wikimapia } = harness();
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1, pageSize: 0 }),
    );
    expect(wikimapia.calls).toHaveLength(0);
    const direct = await directFailure(pageAnswer(1), { pageSize: 0 });
    expect(result).toStrictEqual({
      kind: 'item_failure',
      failureKind: 'invalid_request',
      message: direct.message,
    });
    expect(gateway.stopped).toBeUndefined();
  });

  it("uses only the Client's failure message, never wikimapiaMessage or issues", async () => {
    const { gateway } = harness();
    const call: ClientCall<string> = () =>
      Promise.resolve({
        ok: false,
        failure: {
          kind: 'wikimapia_error',
          message: 'Wikimapia answered with an error',
          wikimapiaMessage: 'RAW-WIKIMAPIA-TEXT',
        },
      });
    const result = await requestWithBackoff(gateway, 'listing', undefined, call);
    expect(result).toStrictEqual({
      kind: 'item_failure',
      failureKind: 'wikimapia_error',
      message: 'Wikimapia answered with an error',
    });
    expect(JSON.stringify(result)).not.toContain('RAW-WIKIMAPIA-TEXT');

    const unexpected: ClientCall<string> = () =>
      Promise.resolve({
        ok: false,
        failure: {
          kind: 'unexpected_response',
          message: 'Unexpected Wikimapia response',
          issues: [{ path: ['RAW-ISSUE-PATH'], message: 'RAW-ISSUE' }],
        },
      });
    const second = await requestWithBackoff(gateway, 'listing', undefined, unexpected);
    expect(second).toStrictEqual({
      kind: 'item_failure',
      failureKind: 'unexpected_response',
      message: 'Unexpected Wikimapia response',
    });
  });
});

// ---------------------------------------------------------------------------
// Stops (AC-43, AC-44, AC-48)
// ---------------------------------------------------------------------------

describe('requestWithBackoff: stops', () => {
  it('Rate Limit Exhausted: Retry Limit + 1 calls, stopped, the Gateway rate_limited', async () => {
    const { client, gateway, wikimapia } = harness({ script: page1(rateLimitForever()) });
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(wikimapia.calls).toHaveLength(DEFAULT_RETRY_LIMIT + 1);
    expect(result).toStrictEqual({ kind: 'stopped' });
    expect(gateway.stopped).toStrictEqual({
      reason: 'rate_limited',
      message: `Wikimapia kept answering with its rate limit after ${String(DEFAULT_RETRY_LIMIT + 1)} attempts.`,
    });
  });

  it('a Configuration Failure: no call, stopped, the Gateway failed with the Client message', async () => {
    const { client, gateway, wikimapia } = harness({ apiKey: ' \t ' });
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(wikimapia.calls).toHaveLength(0);
    expect(result).toStrictEqual({ kind: 'stopped' });
    const direct = await directFailure(pageAnswer(1), {}, ' \t ');
    expect(direct.kind).toBe('configuration');
    expect(gateway.stopped).toStrictEqual({ reason: 'failed', message: direct.message });
  });

  it('the budget running out inside a Client retry: stopped, not an Item Failure', async () => {
    const { client, gateway, wikimapia } = harness({
      requestBudget: 1,
      script: page1(rateLimitAnswer(1), pageAnswer(1)),
    });
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(result).toStrictEqual({ kind: 'stopped' });
    expect(wikimapia.calls).toHaveLength(1);
    expect(gateway.stopped?.reason).toBe('budget_reached');
  });

  it('an already stopped Gateway: stopped, the transport is never reached, the first stop kept', async () => {
    const { client, gateway, wikimapia } = harness();
    gateway.stop('failed', 'stopped earlier');
    const result = await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(result).toStrictEqual({ kind: 'stopped' });
    expect(wikimapia.calls).toHaveLength(0);
    expect(gateway.stopped).toStrictEqual({ reason: 'failed', message: 'stopped earlier' });
  });

  it('checks the Gateway stop before the result: an ok result of a stopped Gateway is stopped', async () => {
    const { gateway } = harness();
    const call: ClientCall<string> = () => {
      gateway.stop('failed', 'stopped during the call');
      return Promise.resolve({ ok: true, value: 'value' });
    };
    const result = await requestWithBackoff(gateway, 'listing', undefined, call);
    expect(result).toStrictEqual({ kind: 'stopped' });
  });
});

// ---------------------------------------------------------------------------
// ok, interrupt and kinds (AC-46)
// ---------------------------------------------------------------------------

describe('requestWithBackoff: ok and kinds', () => {
  it('an answer that arrives after an abort is still ok', async () => {
    const controller = new AbortController();
    const { client, gateway, wikimapia } = harness({
      signal: controller.signal,
      script: page1({
        effect: () => {
          controller.abort();
        },
        then: pageAnswer(1),
      }),
    });
    const result = await requestWithBackoff(gateway, 'listing', controller.signal, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(result.kind).toBe('ok');
    expect(wikimapia.calls).toHaveLength(1);
  });

  it("counts a 'details' call and its retries as detailsRequests", async () => {
    const { client, gateway, wikimapia } = harness({
      minRequestIntervalSeconds: 0,
      script: {
        details: {
          62587: [UNREACHABLE, rateLimitAnswer(0), detailsAnswer('getbyid-62587.json')],
        },
      },
    });
    const result = await requestWithBackoff(gateway, 'details', undefined, () =>
      client.getPlaceDetails({ placeId: 62587 }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.placeId).toBe(62587);
    expect(wikimapia.calls).toHaveLength(3);
    expect(gateway.counts().detailsRequests).toBe(3);
    expect(gateway.counts().listingRequests).toBe(0);
    expect(gateway.requestsSent).toBe(3);
  });

  it('sets the kind before the call', async () => {
    const { client, gateway } = harness({ minRequestIntervalSeconds: 0 });
    gateway.setKind('details');
    await requestWithBackoff(gateway, 'listing', undefined, () =>
      client.listPlaces({ bbox: SMALL_BBOX, page: 1 }),
    );
    expect(gateway.counts().listingRequests).toBe(1);
    expect(gateway.counts().detailsRequests).toBe(0);
  });
});
