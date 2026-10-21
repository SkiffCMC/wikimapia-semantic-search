/**
 * AL2 unit tests: `src/wikimapia/execute.ts` (AL4 1.2 steps 4 and 5, 1.3 `execute.ts` block and
 * the assignability note, 1.4.7 Rate limiting and retries, 1.4.8 Transport and failure mapping,
 * 1.4.9 first paragraph, 1.5 Transaction boundaries; U4).
 *
 * `executeRequest` is driven with a fixed, already built test URL, the real U2 interpreters and
 * injected collaborators only: every transport is a `SimulatedWikimapia` (or a small inline fake
 * for malformed or throwing transports) and every clock is a `SimulatedClock` (or an inline fake
 * for the rejecting case). No network, no real timers, no real keys (`TEST_API_KEY` only).
 */
import type { z } from 'zod';
import { executeRequest } from '../../src/wikimapia/execute';
import {
  interpretBoxAnswer,
  interpretPlaceDetailsAnswer,
} from '../../src/wikimapia/interpret';
import { buildBoxUrl, buildPlaceDetailsUrl } from '../../src/wikimapia/request';
import type { ClientResult, ExecuteDeps, Interpretation } from '../../src/wikimapia/types';
import {
  DEFAULT_FALLBACK_WAIT_SECONDS,
  DEFAULT_RETRY_LIMIT,
  ListPlacesResultSchema,
  PlaceDetailsResultSchema,
  type ClientFailure,
  type Clock,
  type FailureIssue,
  type ListPlacesResult,
  type ListingPage,
  type PlaceDetails,
  type PlaceDetailsResult,
  type TransportResponse,
  type WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema';
import {
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  answer,
  fixtureAnswer,
  fixtureText,
  rateLimitAnswer,
  rawDetails,
  settle,
  type FixtureName,
  type SimulatedAnswer,
} from '../../contracts/wikimapia-client.support';

// ---------------------------------------------------------------------------
// Fixed test URLs and helpers
// ---------------------------------------------------------------------------

/** The one place-details URL used by the whole file (built once, contains the test key). */
const DETAILS_URL = buildPlaceDetailsUrl({ apiKey: TEST_API_KEY, placeId: 62587 });

/** The one listing URL used by the whole file (central Belgrade, page 1). */
const BOX_URL = buildBoxUrl({
  apiKey: TEST_API_KEY,
  bbox: { west: 20.452, south: 44.814, east: 20.462, north: 44.82 },
  page: 1,
  pageSize: 100,
});

const DETAILS_FIXTURE: FixtureName = 'getbyid-62587.json';
const BOX_FIXTURE: FixtureName = 'box-belgrade-page1.json';

const CONNECTION_MESSAGE = 'Wikimapia could not be reached';
const MALFORMED_ISSUES: FailureIssue[] = [
  { path: [], message: 'transport returned a malformed response' },
];
const INTERNAL_ISSUES: FailureIssue[] = [{ path: [], message: 'internal client error' }];

type Overrides = Partial<Pick<ExecuteDeps, 'retryLimit' | 'fallbackWaitSeconds'>>;

/** `ExecuteDeps` with the contract defaults passed explicitly (U4 has no defaults of its own). */
function makeDeps(
  transport: WikimapiaTransport,
  clock: Clock,
  overrides: Overrides = {},
): ExecuteDeps {
  return {
    transport,
    clock,
    apiKey: TEST_API_KEY,
    retryLimit: DEFAULT_RETRY_LIMIT,
    fallbackWaitSeconds: DEFAULT_FALLBACK_WAIT_SECONDS,
    ...overrides,
  };
}

type RunOptions = Overrides & { repeatLast?: boolean };

function simulated(answers: readonly SimulatedAnswer[], repeatLast: boolean | undefined) {
  return new SimulatedWikimapia(answers, repeatLast === undefined ? {} : { repeatLast });
}

/** Runs `executeRequest` for place details against a Simulated Wikimapia and Simulated Clock. */
async function runDetails(answers: readonly SimulatedAnswer[], options: RunOptions = {}) {
  const { repeatLast, ...overrides } = options;
  const wikimapia = simulated(answers, repeatLast);
  const clock = new SimulatedClock();
  const result = await executeRequest(
    DETAILS_URL,
    interpretPlaceDetailsAnswer,
    makeDeps(wikimapia.transport, clock, overrides),
  );
  return { wikimapia, clock, result };
}

/** Runs `executeRequest` for a listing page against a Simulated Wikimapia and Simulated Clock. */
async function runBox(answers: readonly SimulatedAnswer[], options: RunOptions = {}) {
  const { repeatLast, ...overrides } = options;
  const wikimapia = simulated(answers, repeatLast);
  const clock = new SimulatedClock();
  const result = await executeRequest(
    BOX_URL,
    interpretBoxAnswer,
    makeDeps(wikimapia.transport, clock, overrides),
  );
  return { wikimapia, clock, result };
}

/** Runs `executeRequest` for place details with an inline transport (counted through `vi.fn`). */
async function runWithTransport(impl: WikimapiaTransport, options: Overrides = {}) {
  const transport = vi.fn<WikimapiaTransport>(impl);
  const clock = new SimulatedClock();
  const result = await executeRequest(
    DETAILS_URL,
    interpretPlaceDetailsAnswer,
    makeDeps(transport, clock, options),
  );
  return { transport, clock, result };
}

function assertNoLeak(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain(TEST_API_KEY);
  expect(json).not.toMatch(/[?&]key=/);
}

/**
 * Asserts a strict failure result: passes the matching contract result schema, has exactly the
 * keys `ok` and `failure`, is of the expected kind, and leaks neither the key nor a keyed URL.
 */
function expectFailure<K extends ClientFailure['kind']>(
  result: ClientResult<unknown>,
  kind: K,
  schema: z.ZodType = PlaceDetailsResultSchema,
): Extract<ClientFailure, { kind: K }> {
  expect(schema.safeParse(result).success).toBe(true);
  expect(Object.keys(result).sort()).toStrictEqual(['failure', 'ok']);
  if (result.ok) throw new Error(`expected a ${kind} failure, got a success`);
  expect(result.failure.kind).toBe(kind);
  assertNoLeak(result);
  if (result.failure.kind !== kind) throw new Error(`expected ${kind}`);
  return result.failure as Extract<ClientFailure, { kind: K }>;
}

function directData<T>(interpretation: Interpretation<T>): T {
  if (interpretation.kind !== 'data') {
    throw new Error(`fixture did not interpret as data: ${JSON.stringify(interpretation)}`);
  }
  return interpretation.value;
}

/** Asserts a success that passes the result schema and equals the direct interpretation. */
function expectDetailsSuccess(result: ClientResult<PlaceDetails>, body?: string): PlaceDetails {
  expect(PlaceDetailsResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  expect(result.value).toStrictEqual(
    directData(interpretPlaceDetailsAnswer(body ?? fixtureText(DETAILS_FIXTURE))),
  );
  return result.value;
}

function expectBoxSuccess(result: ClientResult<ListingPage>): ListingPage {
  expect(ListPlacesResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  expect(result.value).toStrictEqual(directData(interpretBoxAnswer(fixtureText(BOX_FIXTURE))));
  return result.value;
}

function directIssues(body: string): FailureIssue[] {
  const interpretation = interpretPlaceDetailsAnswer(body);
  if (interpretation.kind !== 'unexpected') {
    throw new Error(`body did not interpret as unexpected: ${interpretation.kind}`);
  }
  return interpretation.issues;
}

const detailsData = (): TransportResponse => fixtureAnswer(DETAILS_FIXTURE);
const boxData = (): TransportResponse => fixtureAnswer(BOX_FIXTURE);

// ---------------------------------------------------------------------------
// 1. Plain success (AC-29)
// ---------------------------------------------------------------------------

describe('plain success (AC-29)', () => {
  it('place details: one request with exactly { url }, no sleep', async () => {
    const { wikimapia, clock, result } = await runDetails([detailsData()]);
    expectDetailsSuccess(result);
    expect(wikimapia.requests).toHaveLength(1);
    expect(wikimapia.requests[0]?.url).toBe(DETAILS_URL);
    expect(wikimapia.requests[0]).toStrictEqual({ url: DETAILS_URL });
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('listing page: one request with exactly { url }, no sleep', async () => {
    const { wikimapia, clock, result } = await runBox([boxData()]);
    expectBoxSuccess(result);
    expect(wikimapia.requests).toHaveLength(1);
    expect(wikimapia.requests[0]).toStrictEqual({ url: BOX_URL });
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('the success result has only the keys ok and value', async () => {
    const { result } = await runDetails([detailsData()]);
    expect(Object.keys(result).sort()).toStrictEqual(['ok', 'value']);
  });
});

// ---------------------------------------------------------------------------
// 2. Wait then success (AC-22, AC-23)
// ---------------------------------------------------------------------------

describe('wait then success (AC-22, AC-23)', () => {
  it('place details: sleeps 7000 ms, then repeats the identical request', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer(7), detailsData()]);
    expectDetailsSuccess(result);
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
    expect(wikimapia.requests[1]?.url).toBe(wikimapia.requests[0]?.url);
    expect(wikimapia.requests[1]).toStrictEqual({ url: DETAILS_URL });
  });

  it('listing page: sleeps 7000 ms, then repeats the identical request', async () => {
    const { wikimapia, clock, result } = await runBox([rateLimitAnswer(7), boxData()]);
    expectBoxSuccess(result);
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
    expect(wikimapia.requests[1]?.url).toBe(wikimapia.requests[0]?.url);
    expect(wikimapia.requests[1]).toStrictEqual({ url: BOX_URL });
  });
});

// ---------------------------------------------------------------------------
// 3. Several limits (AC-25)
// ---------------------------------------------------------------------------

describe('several rate limits in a row (AC-25)', () => {
  it('waits 3 s then 5 s, then succeeds on the third request', async () => {
    const { wikimapia, clock, result } = await runDetails([
      rateLimitAnswer(3),
      rateLimitAnswer(5),
      detailsData(),
    ]);
    expectDetailsSuccess(result);
    expect(clock.sleeps).toStrictEqual([3000, 5000]);
    expect(clock.totalMilliseconds).toBe(8000);
    expect(wikimapia.requests).toHaveLength(3);
    for (const request of wikimapia.requests) expect(request).toStrictEqual({ url: DETAILS_URL });
  });
});

// ---------------------------------------------------------------------------
// 4. Retry limit (AC-26)
// ---------------------------------------------------------------------------

describe('retry limit (AC-26)', () => {
  it('default limit: 6 requests, 5 sleeps of 3000 ms, attempts 6, lastWaitSeconds 3', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer(3)], {
      repeatLast: true,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(DEFAULT_RETRY_LIMIT + 1);
    expect(wikimapia.requests).toHaveLength(6);
    expect(clock.sleeps).toStrictEqual([3000, 3000, 3000, 3000, 3000]);
    expect(failure.attempts).toBe(6);
    expect(failure.lastWaitSeconds).toBe(3);
  });

  it('retryLimit 1: no sleep after the last answer, lastWaitSeconds from that answer', async () => {
    const { wikimapia, clock, result } = await runDetails(
      [rateLimitAnswer(2), rateLimitAnswer(9)],
      { retryLimit: 1 },
    );
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.sleeps).toStrictEqual([2000]);
    expect(failure.attempts).toBe(2);
    expect(failure.lastWaitSeconds).toBe(9);
  });

  it('listing page: exhaustion passes ListPlacesResultSchema', async () => {
    const { wikimapia, result } = await runBox([rateLimitAnswer(3)], {
      repeatLast: true,
      retryLimit: 1,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted', ListPlacesResultSchema);
    expect(failure.attempts).toBe(2);
    expect(wikimapia.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Retry limit 0 (AC-24)
// ---------------------------------------------------------------------------

describe('retry limit 0 (AC-24)', () => {
  it('the first rate-limit answer is exhausted at once, without sleeping', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer(7), detailsData()], {
      retryLimit: 0,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(failure.kind).not.toBe('unexpected_response');
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
    expect(failure.attempts).toBe(1);
    expect(failure.lastWaitSeconds).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 6. Unreadable wait (AC-27, AC-49)
// ---------------------------------------------------------------------------

describe('unreadable wait time falls back (AC-27, AC-49)', () => {
  it('waits the default fallback of 60 s, then succeeds', async () => {
    const { wikimapia, clock, result } = await runDetails([
      rateLimitAnswer('a few'),
      detailsData(),
    ]);
    expectDetailsSuccess(result);
    expect(clock.sleeps).toStrictEqual([60_000]);
    expect(wikimapia.requests).toHaveLength(2);
  });

  it('exhaustion reports the fallback as lastWaitSeconds', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer('a few')], {
      repeatLast: true,
      retryLimit: 1,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.sleeps).toStrictEqual([60_000]);
    expect(failure.attempts).toBe(2);
    expect(failure.lastWaitSeconds).toBe(60);
  });

  it('uses the given fallbackWaitSeconds', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer('several')], {
      repeatLast: true,
      retryLimit: 2,
      fallbackWaitSeconds: 10,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(3);
    expect(clock.sleeps).toStrictEqual([10_000, 10_000]);
    expect(failure.attempts).toBe(3);
    expect(failure.lastWaitSeconds).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 7. Wait of zero (AC-28)
// ---------------------------------------------------------------------------

describe('wait time of zero (AC-28)', () => {
  it('retries without calling sleep at all', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer(0), detailsData()]);
    expectDetailsSuccess(result);
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('zero waits still count as attempts', async () => {
    const { wikimapia, clock, result } = await runDetails([rateLimitAnswer(0)], {
      repeatLast: true,
      retryLimit: 2,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(3);
    expect(failure.attempts).toBe(3);
    expect(failure.lastWaitSeconds).toBe(0);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. No cap (AC-48)
// ---------------------------------------------------------------------------

describe('wait time is not capped (AC-48)', () => {
  it('waits a full day when told so', async () => {
    const { clock, result } = await runDetails([rateLimitAnswer(86400), detailsData()]);
    expectDetailsSuccess(result);
    expect(clock.sleeps).toStrictEqual([86_400_000]);
  });
});

// ---------------------------------------------------------------------------
// 9. No early retry (AC-30)
// ---------------------------------------------------------------------------

describe('no request is sent while waiting (AC-30)', () => {
  it('orders request, sleep, request', async () => {
    const log: string[] = [];
    const wikimapia = new SimulatedWikimapia([rateLimitAnswer(7), detailsData()], { log });
    const clock = new SimulatedClock({ manual: true, log });
    const promise = executeRequest(
      DETAILS_URL,
      interpretPlaceDetailsAnswer,
      makeDeps(wikimapia.transport, clock),
    );

    await settle();
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.pendingWaits).toBe(1);

    await settle(20);
    expect(wikimapia.requests).toHaveLength(1);

    clock.elapseAll();
    const result = await promise;
    expectDetailsSuccess(result);
    expect(log).toStrictEqual(['request', 'sleep:7000', 'request']);
  });
});

// ---------------------------------------------------------------------------
// 10. Rate-limit exhausted message
// ---------------------------------------------------------------------------

describe('rate-limit exhausted message', () => {
  it('names the attempts and the last wait, and contains no URL', async () => {
    const { result } = await runDetails([rateLimitAnswer(13)], {
      repeatLast: true,
      retryLimit: 3,
    });
    const failure = expectFailure(result, 'rate_limit_exhausted');
    expect(failure.attempts).toBe(4);
    expect(failure.lastWaitSeconds).toBe(13);
    expect(failure.message.length).toBeGreaterThan(0);
    expect(failure.message).toContain(String(failure.attempts));
    expect(failure.message).toContain(String(failure.lastWaitSeconds));
    expect(failure.message).not.toMatch(/https?:\/\//);
  });
});

// ---------------------------------------------------------------------------
// 11. Unreachable (AC-33, AC-36)
// ---------------------------------------------------------------------------

describe('Wikimapia unreachable (AC-33, AC-36)', () => {
  it('gives connection without status, no retry, no leak of the error message', async () => {
    const { wikimapia, clock, result } = await runDetails([{ unreachable: true }], {
      repeatLast: true,
    });
    const failure = expectFailure(result, 'connection');
    expect('status' in failure).toBe(false);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
    expect(failure.message.startsWith(CONNECTION_MESSAGE)).toBe(true);
    const json = JSON.stringify(failure);
    expect(json).not.toContain(TEST_API_KEY);
    expect(json).not.toContain('api.wikimapia.org');
    expect(json).not.toContain('ECONNREFUSED while requesting');
  });

  it('listing page: unreachable passes ListPlacesResultSchema', async () => {
    const { result } = await runBox([{ unreachable: true }], { repeatLast: true });
    const failure = expectFailure(result, 'connection', ListPlacesResultSchema);
    expect('status' in failure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Error cause code
// ---------------------------------------------------------------------------

describe('transport error cause code', () => {
  it('may name an upper-case cause code, never the URL or key', async () => {
    const { transport, clock, result } = await runWithTransport(() =>
      Promise.reject(
        new Error(`fetch failed for ${DETAILS_URL}`, { cause: { code: 'ECONNREFUSED' } }),
      ),
    );
    const failure = expectFailure(result, 'connection');
    expect('status' in failure).toBe(false);
    expect(failure.message.startsWith(CONNECTION_MESSAGE)).toBe(true);
    expect(failure.message).not.toContain('fetch failed');
    expect(JSON.stringify(failure)).not.toContain('api.wikimapia.org');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('accepts other well-formed codes such as UND_ERR_CONNECT_TIMEOUT', async () => {
    const { result } = await runWithTransport(() =>
      Promise.reject(
        new Error(`timeout ${DETAILS_URL}`, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
      ),
    );
    const failure = expectFailure(result, 'connection');
    expect(failure.message.startsWith(CONNECTION_MESSAGE)).toBe(true);
    expect(failure.message).not.toContain('timeout');
  });

  it('does not copy a lower-case cause code that contains the key', async () => {
    const code = `bad-code-${TEST_API_KEY}`;
    const { result } = await runWithTransport(() =>
      Promise.reject(new Error(`failed ${DETAILS_URL}`, { cause: { code } })),
    );
    const failure = expectFailure(result, 'connection');
    expect(failure.message).toBe(CONNECTION_MESSAGE);
    expect(failure.message).not.toContain('bad-code');
  });

  it('does not copy a numeric cause code', async () => {
    const { result } = await runWithTransport(() =>
      Promise.reject(new Error(`failed ${DETAILS_URL}`, { cause: { code: 111 } })),
    );
    const failure = expectFailure(result, 'connection');
    expect(failure.message).toBe(CONNECTION_MESSAGE);
    expect(failure.message).not.toContain('111');
  });

  it('a rejection with a non-Error value still gives connection without leaking it', async () => {
    const { transport, result } = await runWithTransport(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
      Promise.reject(`cannot reach ${DETAILS_URL} with ${TEST_API_KEY}`),
    );
    const failure = expectFailure(result, 'connection');
    expect('status' in failure).toBe(false);
    expect(failure.message).not.toContain('cannot reach');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 13. Non-2xx status (AC-33)
// ---------------------------------------------------------------------------

describe('non-2xx HTTP status (AC-33)', () => {
  it.each([404, 500, 502, 503])('status %i gives connection with that status', async (status) => {
    const { wikimapia, clock, result } = await runDetails(
      [answer(fixtureText(DETAILS_FIXTURE), status)],
      { repeatLast: true },
    );
    const failure = expectFailure(result, 'connection');
    expect(failure.status).toBe(status);
    expect(failure.message).toBe(`Wikimapia answered with HTTP status ${String(status)}`);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it.each([199, 300])('edge status %i gives connection with that status', async (status) => {
    const { wikimapia, result } = await runDetails([answer(fixtureText(DETAILS_FIXTURE), status)], {
      repeatLast: true,
    });
    const failure = expectFailure(result, 'connection');
    expect(failure.status).toBe(status);
    expect(wikimapia.requests).toHaveLength(1);
  });

  it.each([200, 201, 299])('status %i with a valid data body is a success', async (status) => {
    const { wikimapia, result } = await runDetails([answer(fixtureText(DETAILS_FIXTURE), status)]);
    expectDetailsSuccess(result);
    expect(wikimapia.requests).toHaveLength(1);
  });

  it('a non-2xx status carrying a rate-limit body is not retried', async () => {
    const limited = rateLimitAnswer(7);
    const { wikimapia, clock, result } = await runDetails([{ status: 503, body: limited.body }], {
      repeatLast: true,
    });
    const failure = expectFailure(result, 'connection');
    expect(failure.status).toBe(503);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 14. Malformed transport result
// ---------------------------------------------------------------------------

describe('malformed transport result', () => {
  const malformed: readonly [string, unknown][] = [
    ['no body', { status: 200 }],
    ['numeric body', { status: 200, body: 5 }],
    ['non-integer status', { status: 1.5, body: '' }],
    ['extra key', { status: 200, body: '', extra: 1 }],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(malformed)('%s gives unexpected_response at path []', async (_label, value) => {
    const { transport, clock, result } = await runWithTransport(() =>
      Promise.resolve(value as TransportResponse),
    );
    const failure = expectFailure(result, 'unexpected_response');
    expect(failure.issues).toStrictEqual(MALFORMED_ISSUES);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 15. Synchronous throw
// ---------------------------------------------------------------------------

describe('transport that throws synchronously', () => {
  it('still resolves to connection without status and without leaking', async () => {
    const throwing: WikimapiaTransport = () => {
      throw new Error(`synchronous failure for ${DETAILS_URL}`);
    };
    const promise = runWithTransport(throwing);
    await expect(promise).resolves.toBeDefined();
    const { transport, result } = await promise;
    const failure = expectFailure(result, 'connection');
    expect('status' in failure).toBe(false);
    expect(failure.message).not.toContain('synchronous failure');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 16. Never rejects
// ---------------------------------------------------------------------------

describe('never rejects (AL4 1.4.8 last bullet)', () => {
  it('a rejecting clock gives unexpected_response "internal client error"', async () => {
    const wikimapia = new SimulatedWikimapia([rateLimitAnswer(7), detailsData()]);
    const clock: Clock = {
      sleep: () =>
        Promise.reject(new Error(`timer broke for key ${TEST_API_KEY} at ${DETAILS_URL}`)),
    };
    const promise = executeRequest(
      DETAILS_URL,
      interpretPlaceDetailsAnswer,
      makeDeps(wikimapia.transport, clock),
    );
    await expect(promise).resolves.toMatchObject({ ok: false });
    const failure = expectFailure(await promise, 'unexpected_response');
    expect(failure.issues).toStrictEqual(INTERNAL_ISSUES);
    expect(failure.message).not.toContain('timer broke');
    expect(wikimapia.requests).toHaveLength(1);
  });

  it('a throwing interpreter gives unexpected_response "internal client error"', async () => {
    const wikimapia = new SimulatedWikimapia([detailsData()]);
    const clock = new SimulatedClock();
    const interpret = (): Interpretation<PlaceDetails> => {
      throw new Error(`interpreter bug near ${DETAILS_URL}`);
    };
    const promise = executeRequest(DETAILS_URL, interpret, makeDeps(wikimapia.transport, clock));
    await expect(promise).resolves.toMatchObject({ ok: false });
    const failure = expectFailure(await promise, 'unexpected_response');
    expect(failure.issues).toStrictEqual(INTERNAL_ISSUES);
    expect(failure.message).not.toContain('interpreter bug');
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 17. No retry for other failures (AC-32, AC-34)
// ---------------------------------------------------------------------------

describe('no retry for Wikimapia errors or unexpected responses (AC-32, AC-34)', () => {
  it('a Wikimapia error is reported with its message unchanged, once', async () => {
    const { wikimapia, clock, result } = await runDetails([fixtureAnswer('debug-error.json')], {
      repeatLast: true,
    });
    const failure = expectFailure(result, 'wikimapia_error');
    expect(failure.wikimapiaMessage).toBe('Invalid API key.');
    expect(failure.message.length).toBeGreaterThan(0);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  const truncated = fixtureText(DETAILS_FIXTURE).slice(0, 200);
  const bodies: readonly [string, string][] = [
    ['HTML body', '<html><body><h1>502 Bad Gateway</h1></body></html>'],
    ['empty body', ''],
    ['truncated JSON', truncated],
    ['JSON array', '[]'],
  ];

  it.each(bodies)(
    '%s gives unexpected_response once, issues carried over',
    async (_label, body) => {
      const { wikimapia, clock, result } = await runDetails([answer(body)], { repeatLast: true });
      const failure = expectFailure(result, 'unexpected_response');
      expect(failure.issues).toStrictEqual(directIssues(body));
      expect(failure.message.length).toBeGreaterThan(0);
      expect(wikimapia.requests).toHaveLength(1);
      expect(clock.sleeps).toStrictEqual([]);
    },
  );

  it('the HTML body issue is at path []', async () => {
    const { result } = await runDetails([answer('<html><body>oops</body></html>')]);
    const failure = expectFailure(result, 'unexpected_response');
    expect(failure.issues.some((issue) => issue.path.length === 0)).toBe(true);
  });

  it('a details body without title names ["title"], once', async () => {
    const raw = rawDetails(DETAILS_FIXTURE);
    Reflect.deleteProperty(raw, 'title');
    const body = JSON.stringify(raw);
    const { wikimapia, clock, result } = await runDetails([answer(body)], { repeatLast: true });
    const failure = expectFailure(result, 'unexpected_response');
    expect(failure.issues).toStrictEqual(directIssues(body));
    expect(failure.issues.some((issue) => JSON.stringify(issue.path) === '["title"]')).toBe(true);
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('listing page: an unexpected response passes ListPlacesResultSchema', async () => {
    const { wikimapia, result } = await runBox([answer('[]')], { repeatLast: true });
    expectFailure(result, 'unexpected_response', ListPlacesResultSchema);
    expect(wikimapia.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 18. Redaction applied (AC-36)
// ---------------------------------------------------------------------------

describe('every failure is redacted (AC-36)', () => {
  it('a Wikimapia message containing the key loses the key', async () => {
    const { result } = await runDetails([
      answer({ debug: { message: `Key ${TEST_API_KEY} is not valid` } }),
    ]);
    const failure = expectFailure(result, 'wikimapia_error');
    expect(failure.wikimapiaMessage).not.toContain(TEST_API_KEY);
    expect(failure.wikimapiaMessage.length).toBeGreaterThan(0);
  });

  it('an HTML body containing the keyed URL does not leak', async () => {
    const { result } = await runDetails([
      answer(`<html><body>Error while serving ${DETAILS_URL}</body></html>`),
    ]);
    expectFailure(result, 'unexpected_response');
  });

  it('a 502 with an empty body gives connection with status 502, no leak', async () => {
    const { result } = await runDetails([answer('', 502)]);
    const failure = expectFailure(result, 'connection');
    expect(failure.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// 19. No shared state (AL4 1.4.7 last bullet, 1.5)
// ---------------------------------------------------------------------------

describe('no state is shared between calls (AL4 1.4.7, 1.5)', () => {
  it('each call gets its own full retry budget', async () => {
    const wikimapia = new SimulatedWikimapia([
      rateLimitAnswer(7),
      detailsData(),
      rateLimitAnswer(7),
      detailsData(),
    ]);
    const clock = new SimulatedClock();
    const deps = makeDeps(wikimapia.transport, clock, { retryLimit: 1 });

    const first = await executeRequest(DETAILS_URL, interpretPlaceDetailsAnswer, deps);
    const second = await executeRequest(DETAILS_URL, interpretPlaceDetailsAnswer, deps);

    expectDetailsSuccess(first);
    expectDetailsSuccess(second);
    expect(wikimapia.requests).toHaveLength(4);
    expect(clock.sleeps).toStrictEqual([7000, 7000]);
  });
});

// ---------------------------------------------------------------------------
// 20. Type-level assignability (AL4 1.3 note)
// ---------------------------------------------------------------------------

describe('ClientResult is assignable to the contract result types (AL4 1.3)', () => {
  it('compiles and runs with contract-typed variables', async () => {
    const detailsResult = await executeRequest(
      DETAILS_URL,
      interpretPlaceDetailsAnswer,
      makeDeps(new SimulatedWikimapia([detailsData()]).transport, new SimulatedClock()),
    );
    const listingResult = await executeRequest(
      BOX_URL,
      interpretBoxAnswer,
      makeDeps(new SimulatedWikimapia([boxData()]).transport, new SimulatedClock()),
    );

    // Compile-time checks: tsc rejects these assignments if the types are not assignable.
    const details: PlaceDetailsResult = detailsResult;
    const listing: ListPlacesResult = listingResult;
    const toDetails: (r: ClientResult<PlaceDetails>) => PlaceDetailsResult = (r) => r;
    const toListing: (r: ClientResult<ListingPage>) => ListPlacesResult = (r) => r;

    expect(PlaceDetailsResultSchema.safeParse(details).success).toBe(true);
    expect(ListPlacesResultSchema.safeParse(listing).success).toBe(true);
    expect(toDetails(detailsResult)).toBe(detailsResult);
    expect(toListing(listingResult)).toBe(listingResult);
  });
});
