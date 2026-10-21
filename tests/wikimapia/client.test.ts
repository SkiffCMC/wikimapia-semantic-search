/**
 * AL2 unit tests: `src/wikimapia/client.ts` (AL4 1.1 row `client.ts`, 1.2 steps 1 to 3 and 5,
 * 1.4.1 Configuration, 1.4.2 Input validation, 1.4.8 last bullet "Never rejects" (method side),
 * 1.4.10 Runtime defaults, 1.5 Transaction boundaries; U5).
 *
 * The client is driven through injected collaborators (`SimulatedWikimapia`, `SimulatedClock`),
 * except in the groups that exercise the runtime defaults. The real network is never reached:
 * `globalThis.fetch` is spied in every test with a default implementation that rejects, and the
 * default-transport tests override it per test. The default clock is exercised only under
 * `vi.useFakeTimers()`. Only `TEST_API_KEY` and obviously synthetic keys are used.
 */
import type { z } from 'zod';
import {
  createFetchTransport,
  createWikimapiaClient,
  systemClock,
} from '../../src/wikimapia/client';
import {
  createFetchTransport as runtimeCreateFetchTransport,
  systemClock as runtimeSystemClock,
} from '../../src/wikimapia/runtime';
import {
  interpretBoxAnswer,
  interpretPlaceDetailsAnswer,
} from '../../src/wikimapia/interpret';
import type { Interpretation } from '../../src/wikimapia/types';
import {
  DEFAULT_FALLBACK_WAIT_SECONDS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETRY_LIMIT,
  ListPlacesResultSchema,
  PlaceDetailsResultSchema,
  type ClientFailure,
  type Clock,
  type CreateWikimapiaClientFn,
  type ListPlacesInput,
  type ListPlacesResult,
  type ListingPage,
  type PlaceDetails,
  type PlaceDetailsInput,
  type PlaceDetailsResult,
  type WikimapiaClient,
  type WikimapiaClientOptions,
  type WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema';
import {
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  answer,
  at,
  fixtureAnswer,
  fixtureText,
  rateLimitAnswer,
  type FixtureName,
  type SimulatedAnswer,
} from '../../contracts/wikimapia-client.support';

// ---------------------------------------------------------------------------
// Entry point (compile-time check)
// ---------------------------------------------------------------------------

const create: CreateWikimapiaClientFn = createWikimapiaClient;

// ---------------------------------------------------------------------------
// Network guard
// ---------------------------------------------------------------------------

const NETWORK_DISABLED = 'real network is disabled in unit tests';

let fetchSpy: ReturnType<typeof spyOnFetch>;

function spyOnFetch() {
  return vi.spyOn(globalThis, 'fetch');
}

beforeEach(() => {
  fetchSpy = spyOnFetch().mockImplementation(() => Promise.reject(new Error(NETWORK_DISABLED)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Central Belgrade, the bbox of the recorded `box` page. */
const BELGRADE = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 } as const;
const BELGRADE_BBOX_PARAM = [BELGRADE.west, BELGRADE.south, BELGRADE.east, BELGRADE.north]
  .map(String)
  .join(',');

const BOX_FIXTURE: FixtureName = 'box-belgrade-page1.json';
const DETAILS_FIXTURE: FixtureName = 'getbyid-62587.json';

const VALID_LIST_INPUT: ListPlacesInput = { bbox: BELGRADE, page: 1 };
const VALID_DETAILS_INPUT: PlaceDetailsInput = { placeId: 62587 };

type ExtraOptions = Omit<WikimapiaClientOptions, 'apiKey' | 'transport' | 'clock'>;

/** A client with the test key and injected doubles (mirrors the contract `setup`). */
function setup(
  answers: readonly SimulatedAnswer[],
  options: ExtraOptions & { repeatLast?: boolean; apiKey?: string } = {},
) {
  const { repeatLast, apiKey, ...clientOptions } = options;
  const wikimapia = new SimulatedWikimapia(answers, repeatLast === undefined ? {} : { repeatLast });
  const clock = new SimulatedClock();
  const client = create({
    apiKey: apiKey ?? TEST_API_KEY,
    transport: wikimapia.transport,
    clock,
    ...clientOptions,
  });
  return { wikimapia, clock, client };
}

/** Simulated doubles plus a client built from raw (possibly invalid) options. */
function setupRaw(rawOptions: Record<string, unknown>, answers: readonly SimulatedAnswer[] = []) {
  const wikimapia = new SimulatedWikimapia(answers, { repeatLast: true });
  const clock = new SimulatedClock();
  const options = {
    transport: wikimapia.transport,
    clock,
    ...rawOptions,
  } as unknown as WikimapiaClientOptions;
  return { wikimapia, clock, options };
}

function assertNoLeak(value: unknown, apiKey: string = TEST_API_KEY): void {
  const json = JSON.stringify(value);
  if (apiKey.trim() !== '') expect(json).not.toContain(apiKey.trim());
  expect(json).not.toContain(TEST_API_KEY);
  expect(json).not.toMatch(/[?&]key=/);
}

/**
 * Asserts a strict failure result: passes the matching contract result schema, has exactly the
 * keys `ok` and `failure`, is of the expected kind, and leaks neither the key nor a keyed URL.
 */
function expectFailure<K extends ClientFailure['kind']>(
  result: ListPlacesResult | PlaceDetailsResult,
  kind: K,
  schema: z.ZodType,
  apiKey: string = TEST_API_KEY,
): Extract<ClientFailure, { kind: K }> {
  expect(schema.safeParse(result).success).toBe(true);
  expect(Object.keys(result)).toStrictEqual(['ok', 'failure']);
  if (result.ok) throw new Error(`expected a ${kind} failure, got a success`);
  expect(result.failure.kind).toBe(kind);
  assertNoLeak(result, apiKey);
  if (result.failure.kind !== kind) throw new Error(`expected ${kind}`);
  return result.failure as Extract<ClientFailure, { kind: K }>;
}

function expectListFailure<K extends ClientFailure['kind']>(
  result: ListPlacesResult,
  kind: K,
  apiKey?: string,
): Extract<ClientFailure, { kind: K }> {
  return expectFailure(result, kind, ListPlacesResultSchema, apiKey);
}

function expectDetailsFailure<K extends ClientFailure['kind']>(
  result: PlaceDetailsResult,
  kind: K,
  apiKey?: string,
): Extract<ClientFailure, { kind: K }> {
  return expectFailure(result, kind, PlaceDetailsResultSchema, apiKey);
}

function directData<T>(interpretation: Interpretation<T>): T {
  if (interpretation.kind !== 'data') {
    throw new Error(`fixture did not interpret as data: ${JSON.stringify(interpretation)}`);
  }
  return interpretation.value;
}

function expectListing(result: ListPlacesResult): ListingPage {
  expect(ListPlacesResultSchema.safeParse(result).success).toBe(true);
  expect(Object.keys(result)).toStrictEqual(['ok', 'value']);
  if (!result.ok) throw new Error(`expected a Listing Page, got ${JSON.stringify(result.failure)}`);
  return result.value;
}

function expectDetails(result: PlaceDetailsResult): PlaceDetails {
  expect(PlaceDetailsResultSchema.safeParse(result).success).toBe(true);
  expect(Object.keys(result)).toStrictEqual(['ok', 'value']);
  if (!result.ok) throw new Error(`expected Place Details, got ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** The address of a `fetch` input, as a real network error message would quote it. */
function requestAddress(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Tracks whether a promise has settled, without letting it float. */
function track(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/** Calls both functions with valid input and asserts both are `configuration` failures. */
async function expectUnconfigured(client: WikimapiaClient, apiKey?: string): Promise<string[]> {
  const list = expectListFailure(
    await client.listPlaces(VALID_LIST_INPUT),
    'configuration',
    apiKey,
  );
  const details = expectDetailsFailure(
    await client.getPlaceDetails(VALID_DETAILS_INPUT),
    'configuration',
    apiKey,
  );
  return [list.message, details.message];
}

// ---------------------------------------------------------------------------
// 1. Entry point and re-exports
// ---------------------------------------------------------------------------

describe('entry point (AL4 0, 1.1)', () => {
  it('createWikimapiaClient has the contract signature and returns both functions', () => {
    const client = create({
      apiKey: TEST_API_KEY,
      transport: new SimulatedWikimapia([]).transport,
      clock: new SimulatedClock(),
    });
    expect(typeof client.listPlaces).toBe('function');
    expect(typeof client.getPlaceDetails).toBe('function');
  });

  it('re-exports createFetchTransport and systemClock from runtime.ts (same references)', () => {
    expect(createFetchTransport).toBe(runtimeCreateFetchTransport);
    expect(systemClock).toBe(runtimeSystemClock);
  });
});

// ---------------------------------------------------------------------------
// 2. Configuration failure (AC-31, 1.4.1)
// ---------------------------------------------------------------------------

describe('configuration failure (AC-31, 1.4.1)', () => {
  /** [label, raw data options, field named in the message, value that must not appear] */
  const cases: [string, Record<string, unknown>, string, string | undefined][] = [
    ['missing apiKey ({})', {}, 'apiKey', undefined],
    ["apiKey ''", { apiKey: '' }, 'apiKey', undefined],
    ["apiKey '   '", { apiKey: '   ' }, 'apiKey', undefined],
    ["language 'eng'", { apiKey: TEST_API_KEY, language: 'eng' }, 'language', 'eng'],
    ["language 'EN'", { apiKey: TEST_API_KEY, language: 'EN' }, 'language', 'EN'],
    ['retryLimit -1', { apiKey: TEST_API_KEY, retryLimit: -1 }, 'retryLimit', '-1'],
    ['retryLimit 1.5', { apiKey: TEST_API_KEY, retryLimit: 1.5 }, 'retryLimit', '1.5'],
    [
      'fallbackWaitSeconds -1',
      { apiKey: TEST_API_KEY, fallbackWaitSeconds: -1 },
      'fallbackWaitSeconds',
      '-1',
    ],
    ['apiKey of a wrong type (number)', { apiKey: 987654321 }, 'apiKey', '987654321'],
  ];

  it.each(cases)(
    '%s: creation does not throw, both calls are configuration failures, nothing sent',
    async (_, rawOptions, field, forbidden) => {
      const { wikimapia, options } = setupRaw(rawOptions, [fixtureAnswer(DETAILS_FIXTURE)]);
      let client: WikimapiaClient | undefined;
      expect(() => {
        client = create(options);
      }).not.toThrow();
      if (client === undefined) throw new Error('no client');
      const messages = await expectUnconfigured(client);
      expect(wikimapia.requests).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const message of messages) {
        expect(message.length).toBeGreaterThan(0);
        expect(message).toContain(field);
        if (forbidden !== undefined) expect(message).not.toContain(forbidden);
      }
    },
  );

  it('the configuration message starts with the fixed prefix', async () => {
    const { options } = setupRaw({ apiKey: '' });
    const [message] = await expectUnconfigured(create(options));
    expect(message?.startsWith('Wikimapia client is not configured')).toBe(true);
  });

  it('every call of an unconfigured client keeps failing (no state change)', async () => {
    const { wikimapia, options } = setupRaw({ apiKey: '' }, [fixtureAnswer(DETAILS_FIXTURE)]);
    const client = create(options);
    await expectUnconfigured(client);
    await expectUnconfigured(client);
    expect(wikimapia.requests).toHaveLength(0);
  });

  it('a non-empty but invalid configuration does not leak the configured key', async () => {
    const key = 'wm-synthetic-key-for-config-test';
    const { options } = setupRaw({ apiKey: key, language: 'eng' });
    const client = create(options);
    expectListFailure(await client.listPlaces(VALID_LIST_INPUT), 'configuration', key);
    expectDetailsFailure(await client.getPlaceDetails(VALID_DETAILS_INPUT), 'configuration', key);
  });
});

describe('configuration is checked before input (1.2 steps 1 and 2)', () => {
  it('an unconfigured client with invalid input reports configuration, not invalid_request', async () => {
    const { wikimapia, options } = setupRaw({ apiKey: '' });
    const client = create(options);
    expectDetailsFailure(await client.getPlaceDetails({ placeId: 0 }), 'configuration');
    expectListFailure(
      await client.listPlaces({ bbox: { ...BELGRADE, west: Number.NaN }, page: 1 }),
      'configuration',
    );
    expect(wikimapia.requests).toHaveLength(0);
  });
});

describe('factory robustness (1.4.1)', () => {
  const variants: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
  ];

  it.each(variants)(
    'options %s: creation does not throw, calls are configuration failures',
    async (_, raw) => {
      let client: WikimapiaClient | undefined;
      expect(() => {
        client = create(raw as WikimapiaClientOptions);
      }).not.toThrow();
      if (client === undefined) throw new Error('no client');
      await expectUnconfigured(client);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Only the four data fields are validated (1.4.1)
// ---------------------------------------------------------------------------

describe('only the four data fields are validated (1.4.1)', () => {
  it('an extra unknown option key is ignored', async () => {
    const { wikimapia, options } = setupRaw({ apiKey: TEST_API_KEY, somethingElse: 'ignored' }, [
      fixtureAnswer(DETAILS_FIXTURE),
    ]);
    expectDetails(await create(options).getPlaceDetails(VALID_DETAILS_INPUT));
    expect(wikimapia.requests).toHaveLength(1);
  });

  it('language: undefined is valid and sends no language parameter', async () => {
    const { wikimapia, options } = setupRaw({ apiKey: TEST_API_KEY, language: undefined }, [
      fixtureAnswer(DETAILS_FIXTURE),
    ]);
    expectDetails(await create(options).getPlaceDetails(VALID_DETAILS_INPUT));
    expect(wikimapia.params(0).has('language')).toBe(false);
  });

  it('retryLimit: undefined is valid and the default retry limit applies', async () => {
    const { wikimapia, clock, options } = setupRaw(
      { apiKey: TEST_API_KEY, retryLimit: undefined },
      [rateLimitAnswer(1)],
    );
    const f = expectDetailsFailure(
      await create(options).getPlaceDetails(VALID_DETAILS_INPUT),
      'rate_limit_exhausted',
    );
    expect(f.attempts).toBe(DEFAULT_RETRY_LIMIT + 1);
    expect(wikimapia.requests).toHaveLength(DEFAULT_RETRY_LIMIT + 1);
    expect(clock.sleeps).toHaveLength(DEFAULT_RETRY_LIMIT);
  });

  it('fallbackWaitSeconds: undefined is valid and the default fallback applies', async () => {
    const { clock, options } = setupRaw({ apiKey: TEST_API_KEY, fallbackWaitSeconds: undefined }, [
      rateLimitAnswer('a few'),
      fixtureAnswer(DETAILS_FIXTURE),
    ]);
    expectDetails(await create(options).getPlaceDetails(VALID_DETAILS_INPUT));
    expect(clock.sleeps).toStrictEqual([DEFAULT_FALLBACK_WAIT_SECONDS * 1000]);
  });

  it('passing transport and clock never produces a configuration failure', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)], {
      language: 'en',
      retryLimit: 1,
      fallbackWaitSeconds: 2,
    });
    expectListing(await client.listPlaces(VALID_LIST_INPUT));
    expect(wikimapia.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Trimmed key (1.4.1)
// ---------------------------------------------------------------------------

describe('trimmed API key (1.4.1)', () => {
  const PADDED_KEY = '  wm-trim-test-key  ';
  const TRIMMED_KEY = 'wm-trim-test-key';

  it('sends the trimmed key', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(DETAILS_FIXTURE)], { apiKey: PADDED_KEY });
    expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(wikimapia.params(0).get('key')).toBe(TRIMMED_KEY);
  });

  it('a failure echoing the trimmed key does not contain it', async () => {
    const { client } = setup([answer({ debug: { message: `Key ${TRIMMED_KEY} is not valid` } })], {
      apiKey: PADDED_KEY,
    });
    const result = await client.getPlaceDetails(VALID_DETAILS_INPUT);
    expectDetailsFailure(result, 'wikimapia_error', TRIMMED_KEY);
    expect(JSON.stringify(result)).not.toContain(TRIMMED_KEY);
  });

  it('a connection failure does not contain the trimmed key', async () => {
    const { client } = setup([{ unreachable: true }], { apiKey: PADDED_KEY });
    const result = await client.listPlaces(VALID_LIST_INPUT);
    const f = expectListFailure(result, 'connection', TRIMMED_KEY);
    expect(f).not.toHaveProperty('status');
    expect(JSON.stringify(result)).not.toContain(TRIMMED_KEY);
  });
});

// ---------------------------------------------------------------------------
// 5. Defaults and configured limits (AC-26, AC-27, AC-49)
// ---------------------------------------------------------------------------

describe('retry defaults and configured limits (AC-26, AC-27, AC-49)', () => {
  it('default retry limit: 6 requests, five sleeps of 3000 ms, attempts 6', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer(3)], { repeatLast: true });
    const f = expectDetailsFailure(
      await client.getPlaceDetails(VALID_DETAILS_INPUT),
      'rate_limit_exhausted',
    );
    expect(wikimapia.requests).toHaveLength(6);
    expect(clock.sleeps).toStrictEqual([3000, 3000, 3000, 3000, 3000]);
    expect(f.attempts).toBe(6);
    expect(f.lastWaitSeconds).toBe(3);
  });

  it('default fallback wait: an unreadable wait time sleeps 60000 ms', async () => {
    const { client, clock } = setup([rateLimitAnswer('a few'), fixtureAnswer(DETAILS_FIXTURE)]);
    expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(clock.sleeps).toStrictEqual([60000]);
  });

  it('configured retryLimit 0: the first rate-limit answer is exhausted after 1 request', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer(3)], {
      repeatLast: true,
      retryLimit: 0,
    });
    const f = expectListFailure(await client.listPlaces(VALID_LIST_INPUT), 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
    expect(f.attempts).toBe(1);
  });

  it('configured retryLimit 2 and fallbackWaitSeconds 10: 3 requests, two 10 s sleeps', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer('several')], {
      repeatLast: true,
      retryLimit: 2,
      fallbackWaitSeconds: 10,
    });
    const f = expectDetailsFailure(
      await client.getPlaceDetails(VALID_DETAILS_INPUT),
      'rate_limit_exhausted',
    );
    expect(wikimapia.requests).toHaveLength(3);
    expect(clock.sleeps).toStrictEqual([10000, 10000]);
    expect(f.attempts).toBe(3);
    expect(f.lastWaitSeconds).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 6. Input validation (AC-7, AC-8, AC-18, 1.4.2)
// ---------------------------------------------------------------------------

function expectInvalidRequest(
  f: Extract<ClientFailure, { kind: 'invalid_request' }>,
  field: string,
): void {
  expect(f.issues.length).toBeGreaterThan(0);
  expect(f.issues.some((issue) => issue.path[0] === field)).toBe(true);
  expect(f.message.startsWith('Invalid request')).toBe(true);
}

describe('input validation, listPlaces (AC-7, AC-8, 1.4.2)', () => {
  const bboxCases: [string, Record<string, number>][] = [
    ['west equals east', { ...BELGRADE, east: BELGRADE.west }],
    ['west greater than east', { ...BELGRADE, west: 20.5, east: 20.4 }],
    ['south equals north', { ...BELGRADE, north: BELGRADE.south }],
    ['south greater than north', { ...BELGRADE, south: 45, north: 44 }],
    ['longitude above 180', { ...BELGRADE, east: 180.5 }],
    ['longitude below -180', { ...BELGRADE, west: -181 }],
    ['latitude above 90', { ...BELGRADE, north: 90.5 }],
    ['latitude below -90', { ...BELGRADE, south: -91 }],
    ['west is NaN', { ...BELGRADE, west: Number.NaN }],
  ];

  it.each(bboxCases)('bbox %s: invalid_request on bbox, nothing sent', async (_, bbox) => {
    const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)]);
    const input = { bbox, page: 1 } as unknown as ListPlacesInput;
    const f = expectListFailure(await client.listPlaces(input), 'invalid_request');
    expectInvalidRequest(f, 'bbox');
    expect(wikimapia.requests).toHaveLength(0);
  });

  const pagingCases: [string, { page: number; pageSize?: number }, string][] = [
    ['page 0', { page: 0 }, 'page'],
    ['page -1', { page: -1 }, 'page'],
    ['page 1.5', { page: 1.5 }, 'page'],
    ['pageSize 0', { page: 1, pageSize: 0 }, 'pageSize'],
    ['pageSize 101', { page: 1, pageSize: 101 }, 'pageSize'],
    ['pageSize 2.5', { page: 1, pageSize: 2.5 }, 'pageSize'],
  ];

  it.each(pagingCases)(
    '%s: invalid_request on the field, nothing sent',
    async (_, paging, field) => {
      const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)]);
      const f = expectListFailure(
        await client.listPlaces({ bbox: BELGRADE, ...paging }),
        'invalid_request',
      );
      expectInvalidRequest(f, field);
      expect(wikimapia.requests).toHaveLength(0);
    },
  );

  it('an unknown extra input key is invalid_request, nothing sent', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)]);
    const input = { bbox: BELGRADE, page: 1, extra: true } as unknown as ListPlacesInput;
    const f = expectListFailure(await client.listPlaces(input), 'invalid_request');
    expect(f.message.startsWith('Invalid request')).toBe(true);
    expect(wikimapia.requests).toHaveLength(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('input %s: invalid_request without throwing', async (_, raw) => {
    const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)]);
    const call = client.listPlaces(raw as unknown as ListPlacesInput);
    await expect(call).resolves.toBeDefined();
    const f = expectListFailure(await call, 'invalid_request');
    expect(f.message.startsWith('Invalid request')).toBe(true);
    expect(wikimapia.requests).toHaveLength(0);
  });
});

describe('input validation, getPlaceDetails (AC-18, 1.4.2)', () => {
  it.each([
    ['0', 0],
    ['-5', -5],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
  ])('placeId %s: invalid_request on placeId, nothing sent', async (_, placeId) => {
    const { client, wikimapia } = setup([fixtureAnswer(DETAILS_FIXTURE)]);
    const f = expectDetailsFailure(await client.getPlaceDetails({ placeId }), 'invalid_request');
    expectInvalidRequest(f, 'placeId');
    expect(wikimapia.requests).toHaveLength(0);
  });

  it('an unknown extra input key is invalid_request, nothing sent', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(DETAILS_FIXTURE)]);
    const input = { placeId: 62587, extra: 1 } as unknown as PlaceDetailsInput;
    const f = expectDetailsFailure(await client.getPlaceDetails(input), 'invalid_request');
    expect(f.message.startsWith('Invalid request')).toBe(true);
    expect(wikimapia.requests).toHaveLength(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('input %s: invalid_request without throwing', async (_, raw) => {
    const { client, wikimapia } = setup([fixtureAnswer(DETAILS_FIXTURE)]);
    const call = client.getPlaceDetails(raw as unknown as PlaceDetailsInput);
    await expect(call).resolves.toBeDefined();
    const f = expectDetailsFailure(await call, 'invalid_request');
    expect(f.message.startsWith('Invalid request')).toBe(true);
    expect(wikimapia.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Page size, language, wiring (AC-3, AC-4, AC-5, AC-17)
// ---------------------------------------------------------------------------

describe('page size (AC-3, AC-4)', () => {
  it('no pageSize sends count = DEFAULT_PAGE_SIZE (100)', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)]);
    expectListing(await client.listPlaces(VALID_LIST_INPUT));
    expect(DEFAULT_PAGE_SIZE).toBe(100);
    expect(wikimapia.params(0).get('count')).toBe(String(DEFAULT_PAGE_SIZE));
  });

  it('pageSize 25 and page 3 send count=25, page=3 and bbox W,S,E,N', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(BOX_FIXTURE)]);
    await client.listPlaces({ bbox: BELGRADE, page: 3, pageSize: 25 });
    expect(wikimapia.requests).toHaveLength(1);
    const params = wikimapia.params(0);
    expect(params.get('count')).toBe('25');
    expect(params.get('page')).toBe('3');
    expect(params.get('bbox')).toBe(BELGRADE_BBOX_PARAM);
  });
});

describe('language (AC-5)', () => {
  it("with language 'en' both functions send language=en", async () => {
    const { client, wikimapia } = setup(
      [fixtureAnswer(BOX_FIXTURE), fixtureAnswer(DETAILS_FIXTURE)],
      { language: 'en' },
    );
    expectListing(await client.listPlaces(VALID_LIST_INPUT));
    expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(wikimapia.params(0).get('language')).toBe('en');
    expect(wikimapia.params(1).get('language')).toBe('en');
  });

  it('without language neither function sends a language parameter', async () => {
    const { client, wikimapia } = setup([
      fixtureAnswer(BOX_FIXTURE),
      fixtureAnswer(DETAILS_FIXTURE),
    ]);
    expectListing(await client.listPlaces(VALID_LIST_INPUT));
    expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(wikimapia.params(0).has('language')).toBe(false);
    expect(wikimapia.params(1).has('language')).toBe(false);
  });
});

describe('wiring of both functions (1.2 steps 3 and 4)', () => {
  it('listPlaces sends function=box and returns the Listing Page of the fixture', async () => {
    const { client, wikimapia, clock } = setup([fixtureAnswer(BOX_FIXTURE)]);
    const page = expectListing(await client.listPlaces(VALID_LIST_INPUT));
    expect(page).toStrictEqual(directData(interpretBoxAnswer(fixtureText(BOX_FIXTURE))));
    expect(page.pageSize).toBe(10);
    expect(page.totalFound).toBe(290);
    expect(wikimapia.requests).toHaveLength(1);
    const params = wikimapia.params(0);
    expect(params.get('function')).toBe('box');
    expect(params.get('key')).toBe(TEST_API_KEY);
    expect(params.get('page')).toBe('1');
    expect(params.get('bbox')).toBe(BELGRADE_BBOX_PARAM);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('getPlaceDetails sends function=place.getbyid with id and returns Place Details', async () => {
    const { client, wikimapia, clock } = setup([fixtureAnswer(DETAILS_FIXTURE)]);
    const details = expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(details).toStrictEqual(
      directData(interpretPlaceDetailsAnswer(fixtureText(DETAILS_FIXTURE))),
    );
    expect(details.placeId).toBe(62587);
    expect(wikimapia.requests).toHaveLength(1);
    const params = wikimapia.params(0);
    expect(params.get('function')).toBe('place.getbyid');
    expect(params.get('id')).toBe('62587');
    expect(params.get('key')).toBe(TEST_API_KEY);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('a retried request repeats the identical URL (built once)', async () => {
    const { client, wikimapia } = setup([rateLimitAnswer(7), fixtureAnswer(BOX_FIXTURE)]);
    expectListing(await client.listPlaces({ bbox: BELGRADE, page: 2, pageSize: 10 }));
    expect(wikimapia.requests).toHaveLength(2);
    expect(at(wikimapia.requests, 1).url).toBe(at(wikimapia.requests, 0).url);
  });
});

// ---------------------------------------------------------------------------
// 8. Default transport with stubbed fetch (AC-38, 1.4.1 last bullet)
// ---------------------------------------------------------------------------

describe('default transport, stubbed fetch (AC-38, 1.4.1)', () => {
  it('creating a client without a transport does not call fetch', () => {
    create({ apiKey: TEST_API_KEY, clock: new SimulatedClock() });
    create({ apiKey: TEST_API_KEY });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('getPlaceDetails goes through fetch once with the configured key and succeeds', async () => {
    const body = fixtureText(DETAILS_FIXTURE);
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(body, { status: 200 })));
    const client = create({ apiKey: TEST_API_KEY, clock: new SimulatedClock() });
    expect(fetchSpy).not.toHaveBeenCalled();
    const details = expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(details.placeId).toBe(62587);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const input = fetchSpy.mock.calls[0]?.[0];
    if (typeof input !== 'string') throw new Error('fetch was not called with a URL string');
    const url = new URL(input);
    expect(url.searchParams.get('key')).toBe(TEST_API_KEY);
    expect(url.searchParams.get('function')).toBe('place.getbyid');
    expect(url.searchParams.get('id')).toBe('62587');
  });

  it('a rejecting fetch becomes connection without status and without a leak', async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.reject(
        new TypeError(`fetch failed for ${requestAddress(input)}`, {
          cause: { code: 'ECONNREFUSED' },
        }),
      ),
    );
    const client = create({ apiKey: TEST_API_KEY, clock: new SimulatedClock() });
    const call = client.getPlaceDetails(VALID_DETAILS_INPUT);
    await expect(call).resolves.toBeDefined();
    const f = expectDetailsFailure(await call, 'connection');
    expect(f).not.toHaveProperty('status');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('with an injected transport, fetch is never called', async () => {
    const { client } = setup([
      rateLimitAnswer(30),
      fixtureAnswer(BOX_FIXTURE),
      fixtureAnswer(DETAILS_FIXTURE),
    ]);
    expectListing(await client.listPlaces(VALID_LIST_INPUT));
    expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. Default clock with fake timers (1.4.10)
// ---------------------------------------------------------------------------

describe('default clock, fake timers (1.4.10)', () => {
  it('without a clock, the client waits the stated 7 s in (fake) real time', async () => {
    vi.useFakeTimers();
    const wikimapia = new SimulatedWikimapia([rateLimitAnswer(7), fixtureAnswer(DETAILS_FIXTURE)]);
    const client = create({ apiKey: TEST_API_KEY, transport: wikimapia.transport });
    const call = client.getPlaceDetails(VALID_DETAILS_INPUT);
    const state = track(call);
    await vi.advanceTimersByTimeAsync(6999);
    expect(state.settled).toBe(false);
    expect(wikimapia.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expectDetails(await call);
    expect(wikimapia.requests).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. Never rejects (1.4.8 last bullet)
// ---------------------------------------------------------------------------

describe('never rejects (1.4.8)', () => {
  it('a transport that throws synchronously resolves to connection', async () => {
    const transport: WikimapiaTransport = () => {
      throw new Error(`sync failure for http://api.wikimapia.org/?key=${TEST_API_KEY}`);
    };
    const client = create({ apiKey: TEST_API_KEY, transport, clock: new SimulatedClock() });
    const call = client.getPlaceDetails(VALID_DETAILS_INPUT);
    await expect(call).resolves.toBeDefined();
    const f = expectDetailsFailure(await call, 'connection');
    expect(f).not.toHaveProperty('status');
  });

  it('a clock whose sleep rejects resolves to unexpected_response', async () => {
    const wikimapia = new SimulatedWikimapia([rateLimitAnswer(7), fixtureAnswer(BOX_FIXTURE)]);
    const clock: Clock = {
      sleep: () => Promise.reject(new Error(`clock broke while waiting on key ${TEST_API_KEY}`)),
    };
    const client = create({ apiKey: TEST_API_KEY, transport: wikimapia.transport, clock });
    const call = client.listPlaces(VALID_LIST_INPUT);
    await expect(call).resolves.toBeDefined();
    const f = expectListFailure(await call, 'unexpected_response');
    expect(f.issues).toStrictEqual([{ path: [], message: 'internal client error' }]);
  });

  it('input whose property getter throws still resolves to a failure', async () => {
    const { client, wikimapia } = setup([fixtureAnswer(DETAILS_FIXTURE)]);
    const hostile = {
      get placeId(): number {
        throw new Error(`getter failure ${TEST_API_KEY}`);
      },
    } as PlaceDetailsInput;
    const call = client.getPlaceDetails(hostile);
    await expect(call).resolves.toBeDefined();
    const result = await call;
    expect(PlaceDetailsResultSchema.safeParse(result).success).toBe(true);
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).toStrictEqual(['ok', 'failure']);
    assertNoLeak(result);
    expect(wikimapia.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. No shared state (1.5)
// ---------------------------------------------------------------------------

describe('no shared state between calls or clients (1.5)', () => {
  const KEY_A = 'wm-synthetic-key-client-a';
  const KEY_B = 'wm-synthetic-key-client-b';

  it('two clients with different keys each use only their own key and full budget', async () => {
    const a = setup([rateLimitAnswer(1)], { repeatLast: true, apiKey: KEY_A });
    const b = setup([rateLimitAnswer(1)], { repeatLast: true, apiKey: KEY_B });
    const [resultA, resultB] = await Promise.all([
      a.client.getPlaceDetails(VALID_DETAILS_INPUT),
      b.client.listPlaces(VALID_LIST_INPUT),
    ]);
    const fa = expectDetailsFailure(resultA, 'rate_limit_exhausted', KEY_A);
    const fb = expectListFailure(resultB, 'rate_limit_exhausted', KEY_B);
    expect(fa.attempts).toBe(DEFAULT_RETRY_LIMIT + 1);
    expect(fb.attempts).toBe(DEFAULT_RETRY_LIMIT + 1);
    expect(a.wikimapia.requests).toHaveLength(DEFAULT_RETRY_LIMIT + 1);
    expect(b.wikimapia.requests).toHaveLength(DEFAULT_RETRY_LIMIT + 1);
    a.wikimapia.requests.forEach((_, i) => {
      expect(a.wikimapia.params(i).get('key')).toBe(KEY_A);
    });
    b.wikimapia.requests.forEach((_, i) => {
      expect(b.wikimapia.params(i).get('key')).toBe(KEY_B);
    });
    expect(JSON.stringify(a.wikimapia.requests)).not.toContain(KEY_B);
    expect(JSON.stringify(b.wikimapia.requests)).not.toContain(KEY_A);
    assertNoLeak(resultA, KEY_B);
    assertNoLeak(resultB, KEY_A);
  });

  it('one client called twice gets a full retry budget for each call', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer(2)], { repeatLast: true });
    const first = expectDetailsFailure(
      await client.getPlaceDetails(VALID_DETAILS_INPUT),
      'rate_limit_exhausted',
    );
    const second = expectDetailsFailure(
      await client.getPlaceDetails(VALID_DETAILS_INPUT),
      'rate_limit_exhausted',
    );
    expect(first.attempts).toBe(DEFAULT_RETRY_LIMIT + 1);
    expect(second.attempts).toBe(DEFAULT_RETRY_LIMIT + 1);
    expect(wikimapia.requests).toHaveLength(2 * (DEFAULT_RETRY_LIMIT + 1));
    expect(clock.sleeps).toHaveLength(2 * DEFAULT_RETRY_LIMIT);
  });

  it('a success after an exhausted call is not affected by the earlier call', async () => {
    const { client, wikimapia } = setup([rateLimitAnswer(1), fixtureAnswer(DETAILS_FIXTURE)], {
      retryLimit: 0,
    });
    expectDetailsFailure(await client.getPlaceDetails(VALID_DETAILS_INPUT), 'rate_limit_exhausted');
    expectDetails(await client.getPlaceDetails(VALID_DETAILS_INPUT));
    expect(wikimapia.requests).toHaveLength(2);
  });
});
