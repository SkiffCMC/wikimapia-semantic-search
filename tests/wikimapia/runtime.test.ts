/**
 * AL2 unit tests: `src/wikimapia/runtime.ts` (AL4 1.1 row `runtime.ts`, 1.3 `runtime.ts` block,
 * 1.4.10 Runtime defaults, section 3 timeout column; U5).
 *
 * The real network is never reached: every test runs with `globalThis.fetch` replaced by a
 * `vi.spyOn` spy whose default implementation rejects, and tests that exercise the transport
 * override that implementation per test. `systemClock` is only exercised under
 * `vi.useFakeTimers()`; no test waits on real timers. Only synthetic keys are used.
 */
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  createFetchTransport,
  systemClock,
} from '../../src/wikimapia/runtime.js';
import {
  TransportResponseSchema,
  type WikimapiaTransport,
} from '../../contracts/wikimapia-client.schema.js';
import { TEST_API_KEY, fixtureText } from '../../contracts/wikimapia-client.support.js';

// ---------------------------------------------------------------------------
// Network guard and helpers
// ---------------------------------------------------------------------------

const NETWORK_DISABLED = 'real network is disabled in unit tests';

/** A keyed request address, as the client builds it (synthetic key only). */
const TEST_URL = `http://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&format=json&id=62587&data_blocks=main%2Cgeometry%2Clocation%2Ccomments`;

let fetchSpy: ReturnType<typeof spyOnFetch>;

function spyOnFetch() {
  return vi.spyOn(globalThis, 'fetch');
}

beforeEach(() => {
  fetchSpy = spyOnFetch().mockImplementation(() => Promise.reject(new Error(NETWORK_DISABLED)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Makes the spied `fetch` answer every call with a fresh `Response`. */
function fetchAnswers(body: string, status = 200): void {
  fetchSpy.mockImplementation(() => Promise.resolve(new Response(body, { status })));
}

/** The `[input, init]` of the `index`-th `fetch` call, failing loudly when absent. */
function fetchCall(index: number): [unknown, RequestInit | undefined] {
  const call = fetchSpy.mock.calls[index];
  if (call === undefined) throw new Error(`fetch was not called ${String(index + 1)} time(s)`);
  return [call[0], call[1]];
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

const DETAILS_BODY = (): string => fixtureText('getbyid-62587.json');

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

describe('constants (1.3, 1.4.10)', () => {
  it('DEFAULT_REQUEST_TIMEOUT_MS is 30 seconds', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('MAX_TIMER_DELAY_MS is the Node timer limit 2^31 - 1', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
  });
});

// ---------------------------------------------------------------------------
// 2. createFetchTransport
// ---------------------------------------------------------------------------

describe('createFetchTransport: creation (AC-38)', () => {
  it('creating a transport without options does not call fetch', () => {
    const transport = createFetchTransport();
    expect(typeof transport).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creating a transport with options does not call fetch', () => {
    const transport = createFetchTransport({ timeoutMs: 5000 });
    expect(typeof transport).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creating a transport does not create a timeout signal yet', () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    createFetchTransport();
    createFetchTransport({ timeoutMs: 5000 });
    expect(timeoutSpy).not.toHaveBeenCalled();
  });
});

describe('createFetchTransport: request shape (1.4.10)', () => {
  it('calls fetch exactly once with the unchanged URL string and a GET init', async () => {
    fetchAnswers(DETAILS_BODY());
    const transport = createFetchTransport();
    await transport({ url: TEST_URL });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(0);
    expect(input).toBe(TEST_URL);
    expect(init).toBeDefined();
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('follow');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sets no custom headers', async () => {
    fetchAnswers(DETAILS_BODY());
    await createFetchTransport()({ url: TEST_URL });
    const [, init] = fetchCall(0);
    expect(init).not.toHaveProperty('headers');
  });

  it('sends one fetch per transport call', async () => {
    fetchAnswers(DETAILS_BODY());
    const transport = createFetchTransport();
    await transport({ url: TEST_URL });
    await transport({ url: TEST_URL });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchCall(1)[0]).toBe(TEST_URL);
  });
});

describe('createFetchTransport: response mapping (1.4.10)', () => {
  it('status 200: resolves to exactly { status, body } with the response text', async () => {
    const body = DETAILS_BODY();
    fetchAnswers(body);
    const result = await createFetchTransport()({ url: TEST_URL });
    expect(result).toStrictEqual({ status: 200, body });
    expect(Object.keys(result).sort()).toStrictEqual(['body', 'status']);
    expect(TransportResponseSchema.safeParse(result).success).toBe(true);
  });

  it('non-2xx status (503, HTML body): mapped without throwing', async () => {
    const body = '<html><body>Service Unavailable</body></html>';
    fetchAnswers(body, 503);
    const result = await createFetchTransport()({ url: TEST_URL });
    expect(result).toStrictEqual({ status: 503, body });
    expect(TransportResponseSchema.safeParse(result).success).toBe(true);
  });

  it('non-2xx status (404, empty body): mapped without throwing', async () => {
    fetchAnswers('', 404);
    const result = await createFetchTransport()({ url: TEST_URL });
    expect(result).toStrictEqual({ status: 404, body: '' });
    expect(TransportResponseSchema.safeParse(result).success).toBe(true);
  });
});

describe('createFetchTransport: timeout (1.4.10, section 3)', () => {
  it('uses DEFAULT_REQUEST_TIMEOUT_MS by default, and the signal it creates', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchAnswers(DETAILS_BODY());
    await createFetchTransport()({ url: TEST_URL });
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_REQUEST_TIMEOUT_MS);
    const created = timeoutSpy.mock.results[0];
    expect(created?.type).toBe('return');
    expect(fetchCall(0)[1]?.signal).toBe(created?.value);
  });

  it('uses DEFAULT_REQUEST_TIMEOUT_MS when options are given without timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchAnswers(DETAILS_BODY());
    await createFetchTransport({})({ url: TEST_URL });
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('uses the given timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchAnswers(DETAILS_BODY());
    await createFetchTransport({ timeoutMs: 5000 })({ url: TEST_URL });
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
  });

  it('creates a fresh timeout signal for every call', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchAnswers(DETAILS_BODY());
    const transport = createFetchTransport();
    await transport({ url: TEST_URL });
    await transport({ url: TEST_URL });
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(fetchCall(0)[1]?.signal).not.toBe(fetchCall(1)[1]?.signal);
  });
});

describe('createFetchTransport: rejection propagates (1.4.8, 1.4.10)', () => {
  it('a rejecting fetch rejects the transport with that same error', async () => {
    const error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    fetchSpy.mockImplementation(() => Promise.reject(error));
    await expect(createFetchTransport()({ url: TEST_URL })).rejects.toBe(error);
  });

  it('a timeout abort rejects the transport with that same error', async () => {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    fetchSpy.mockImplementation(() => Promise.reject(error));
    await expect(createFetchTransport()({ url: TEST_URL })).rejects.toBe(error);
  });

  it('a rejecting response.text() rejects the transport with that same error', async () => {
    const error = new TypeError('terminated');
    const response = {
      status: 200,
      ok: true,
      text: () => Promise.reject(error),
    } as unknown as Response;
    fetchSpy.mockImplementation(() => Promise.resolve(response));
    await expect(createFetchTransport()({ url: TEST_URL })).rejects.toBe(error);
  });
});

describe('createFetchTransport: late binding of globalThis.fetch (1.4.1, 1.4.10)', () => {
  it('uses the fetch implementation in place at call time, not at creation time', async () => {
    const transport = createFetchTransport();
    fetchAnswers('{"late":"binding"}', 200);
    await expect(transport({ url: TEST_URL })).resolves.toStrictEqual({
      status: 200,
      body: '{"late":"binding"}',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reads globalThis.fetch on every call (a replaced global is used)', async () => {
    const transport: WikimapiaTransport = createFetchTransport();
    const replacement = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('replaced', { status: 200 })),
    );
    vi.stubGlobal('fetch', replacement);
    await expect(transport({ url: TEST_URL })).resolves.toStrictEqual({
      status: 200,
      body: 'replaced',
    });
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement.mock.calls[0]?.[0]).toBe(TEST_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. systemClock (fake timers only)
// ---------------------------------------------------------------------------

describe('systemClock.sleep (1.4.10, fake timers)', () => {
  it('waits the full time: pending at 6999 ms, resolved at 7000 ms', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(7000);
    const state = track(sleeping);
    await vi.advanceTimersByTimeAsync(6999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    await expect(sleeping).resolves.toBeUndefined();
  });

  it('a delay above MAX_TIMER_DELAY_MS is chunked, not clamped', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(MAX_TIMER_DELAY_MS + 5000);
    const state = track(sleeping);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    await expect(sleeping).resolves.toBeUndefined();
  });

  it('a delay of exactly MAX_TIMER_DELAY_MS waits the full time', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(MAX_TIMER_DELAY_MS);
    const state = track(sleeping);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
  });

  it('sleep(0) resolves without hanging (advance 0 ms)', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(0);
    const state = track(sleeping);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe(true);
    await expect(sleeping).resolves.toBeUndefined();
  });

  it('sleep(0) resolves after running pending timers', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(0);
    await vi.runAllTimersAsync();
    await expect(sleeping).resolves.toBeUndefined();
  });

  it('a negative delay resolves without a long wait', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(-5);
    const state = track(sleeping);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe(true);
  });

  it('sleeping does not call fetch', async () => {
    vi.useFakeTimers();
    const sleeping = systemClock.sleep(10);
    await vi.advanceTimersByTimeAsync(10);
    await sleeping;
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
