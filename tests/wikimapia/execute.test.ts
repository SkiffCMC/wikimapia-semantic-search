/**
 * AL2 unit tests: `src/wikimapia/execute.ts`. Only what the AL5 contract tests
 * (`contracts/wikimapia-client.test.ts`) do not pin down: the Key Quota mapping and its message
 * (crawl-run1-fixes AL4 1.4.2), transport error cause codes, malformed transport results and the
 * internal-error guard. Retry, wait and status behaviour are covered by the contract tests.
 */
import { executeRequest } from '../../src/wikimapia/execute';
import { interpretPlaceDetailsAnswer } from '../../src/wikimapia/interpret';
import type { ExecuteDeps } from '../../src/wikimapia/types';
import type {
  ClientFailure,
  Clock,
  TransportResponse,
  WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema';
import {
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  keyQuotaAnswer,
  keyQuotaVariant,
  rateLimitAnswer,
  type SimulatedAnswer,
} from '../../contracts/wikimapia-client.support';

const URL = `https://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=62587`;
const QUOTA_PREFIX = 'Wikimapia key quota exhausted (code 1004)';

function deps(transport: WikimapiaTransport, clock: Clock = new SimulatedClock()): ExecuteDeps {
  return { transport, clock, apiKey: TEST_API_KEY, retryLimit: 5, fallbackWaitSeconds: 60 };
}

async function failureOf(transport: WikimapiaTransport, clock?: Clock): Promise<ClientFailure> {
  const result = await executeRequest(URL, interpretPlaceDetailsAnswer, deps(transport, clock));
  if (result.ok) throw new Error('expected a failure');
  return result.failure;
}

async function simulatedFailure(answers: readonly SimulatedAnswer[]) {
  const wikimapia = new SimulatedWikimapia(answers, { repeatLast: true });
  const clock = new SimulatedClock();
  const failure = await failureOf(wikimapia.transport, clock);
  return { failure, requests: wikimapia.requests.length, sleeps: clock.sleeps };
}

describe('Key Quota (code 1004): never retried, message built from the redacted Wikimapia text', () => {
  it.each([
    [
      'a message',
      'Key limit has been reached',
      `${QUOTA_PREFIX}: Key limit has been reached`,
      'Key limit has been reached',
    ],
    ['a whitespace-only message', ' \t', QUOTA_PREFIX, ' \t'],
    [
      'the API key',
      `Key ${TEST_API_KEY} used up`,
      `${QUOTA_PREFIX}: Key [key removed] used up`,
      'Key [key removed] used up',
    ],
  ])('%s', async (_, sent, message, wikimapiaMessage) => {
    const { failure, requests, sleeps } = await simulatedFailure([
      keyQuotaVariant({ message: sent }),
    ]);
    expect(failure).toStrictEqual({
      kind: 'key_quota_exhausted',
      message,
      wikimapiaMessage,
      code: 1004,
    });
    expect(requests).toBe(1);
    expect(sleeps).toStrictEqual([]);
  });

  it('after a rate-limit wait, Key Quota ends the call at once', async () => {
    const { failure, requests, sleeps } = await simulatedFailure([
      rateLimitAnswer(7),
      keyQuotaAnswer(),
    ]);
    expect(failure.kind).toBe('key_quota_exhausted');
    expect(requests).toBe(2);
    expect(sleeps).toStrictEqual([7000]);
  });
});

describe('transport rejection: only a well-formed upper-case cause code is quoted', () => {
  it.each([
    [
      'an upper-case cause code',
      new Error(`failed ${URL}`, { cause: { code: 'ECONNREFUSED' } }),
      'Wikimapia could not be reached (ECONNREFUSED)',
    ],
    [
      'a malformed cause code',
      new Error(`failed ${URL}`, { cause: { code: `bad-${TEST_API_KEY}` } }),
      'Wikimapia could not be reached',
    ],
    [
      'a numeric cause code',
      new Error(`failed ${URL}`, { cause: { code: 111 } }),
      'Wikimapia could not be reached',
    ],
    ['a non-Error value', `cannot reach ${URL}`, 'Wikimapia could not be reached'],
  ])('%s', async (_, error, message) => {
    expect(await failureOf(() => Promise.reject(error as Error))).toStrictEqual({
      kind: 'connection',
      message,
    });
  });
});

it('a malformed transport result is an unexpected_response at path []', async () => {
  const failure = await failureOf(() => Promise.resolve({ status: 200 } as TransportResponse));
  expect(failure).toMatchObject({
    kind: 'unexpected_response',
    issues: [{ path: [], message: 'transport returned a malformed response' }],
  });
});

it('a clock that rejects resolves to an internal unexpected_response without its text', async () => {
  const wikimapia = new SimulatedWikimapia([rateLimitAnswer(7)]);
  const clock: Clock = { sleep: () => Promise.reject(new Error(`timer broke ${TEST_API_KEY}`)) };
  expect(await failureOf(wikimapia.transport, clock)).toStrictEqual({
    kind: 'unexpected_response',
    message: 'Unexpected Wikimapia response: (whole answer): internal client error',
    issues: [{ path: [], message: 'internal client error' }],
  });
});
