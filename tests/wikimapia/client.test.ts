/**
 * AL2 unit tests: `src/wikimapia/client.ts`. Only the branches the AL5 contract tests never
 * reach: options that are not an object, the runtime defaults (transport, clock) and the
 * internal-error guard. `globalThis.fetch` is stubbed in every test; the real network is never used.
 */
import { createWikimapiaClient } from '../../src/wikimapia/client';
import type {
  PlaceDetailsInput,
  PlaceDetailsResult,
  WikimapiaClientOptions,
} from '../../contracts/wikimapia-client.schema';
import {
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  fixtureAnswer,
  fixtureText,
  rateLimitAnswer,
} from '../../contracts/wikimapia-client.support';

const DETAILS = { placeId: 62587 } as const;

function spyOnFetch() {
  return vi.spyOn(globalThis, 'fetch');
}

let fetchSpy: ReturnType<typeof spyOnFetch>;

beforeEach(() => {
  fetchSpy = spyOnFetch().mockImplementation(() =>
    Promise.reject(new Error('real network is disabled in unit tests')),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function failureKind(result: PlaceDetailsResult): string {
  return result.ok ? 'ok' : result.failure.kind;
}

it.each([undefined, null])(
  'options %s: never throws, every call is a configuration failure',
  async (raw) => {
    const client = createWikimapiaClient(raw as unknown as WikimapiaClientOptions);
    expect(failureKind(await client.getPlaceDetails(DETAILS))).toBe('configuration');
    expect(fetchSpy).not.toHaveBeenCalled();
  },
);

it('without a transport, the call goes through globalThis.fetch', async () => {
  fetchSpy.mockResolvedValue(new Response(fixtureText('getbyid-62587.json'), { status: 200 }));
  const client = createWikimapiaClient({ apiKey: TEST_API_KEY, clock: new SimulatedClock() });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(failureKind(await client.getPlaceDetails(DETAILS))).toBe('ok');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('without a clock, the stated wait elapses in (fake) real time', async () => {
  vi.useFakeTimers();
  const wikimapia = new SimulatedWikimapia([
    rateLimitAnswer(7),
    fixtureAnswer('getbyid-62587.json'),
  ]);
  const client = createWikimapiaClient({ apiKey: TEST_API_KEY, transport: wikimapia.transport });
  const call = client.getPlaceDetails(DETAILS);
  await vi.advanceTimersByTimeAsync(6999);
  expect(wikimapia.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(failureKind(await call)).toBe('ok');
  expect(wikimapia.requests).toHaveLength(2);
});

it('an input getter that throws resolves to an internal unexpected_response, nothing sent', async () => {
  const wikimapia = new SimulatedWikimapia([]);
  const client = createWikimapiaClient({
    apiKey: TEST_API_KEY,
    transport: wikimapia.transport,
    clock: new SimulatedClock(),
  });
  const hostile = {
    get placeId(): number {
      throw new Error(`getter failure ${TEST_API_KEY}`);
    },
  } as PlaceDetailsInput;
  const result = await client.getPlaceDetails(hostile);
  expect(result).toStrictEqual({
    ok: false,
    failure: {
      kind: 'unexpected_response',
      message: 'Unexpected Wikimapia response: (whole answer): internal client error',
      issues: [{ path: [], message: 'internal client error' }],
    },
  });
  expect(wikimapia.requests).toHaveLength(0);
});
