/**
 * AL2 unit tests: `src/crawl/runtime.ts` (AL4 1.1 row `runtime.ts`, 1.3 `createSystemCrawlClock`
 * and `defaultTransport`, 1.4.3 "Interrupt" bullet; AL6 AC-46; U5).
 *
 * The real network is never reached: `globalThis.fetch` is replaced by a `vi.spyOn` spy whose
 * default implementation rejects; the transport test overrides it with a synthetic answer. The
 * clock is only exercised under `vi.useFakeTimers()`; no test waits on real timers. Only the
 * synthetic `TEST_API_KEY` is used.
 */
import { createSystemCrawlClock, defaultTransport } from '../../src/crawl/runtime';
import { RUN_START, TEST_API_KEY } from '../../contracts/hydration.support';

// ---------------------------------------------------------------------------
// Network guard and helpers
// ---------------------------------------------------------------------------

const NETWORK_DISABLED = 'real network is disabled in unit tests';

/** A keyed request address, as the Client builds it (synthetic key only). */
const TEST_URL = `https://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&format=json&id=62587`;

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

/** Tracks whether a promise has resolved or rejected, without letting it float. */
function track(promise: Promise<void>): { readonly settled: boolean; readonly rejected: boolean } {
  const state = { settled: false, rejected: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
      state.rejected = true;
    },
  );
  return state;
}

/** Lets pending promise callbacks run without advancing any timer. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// createSystemCrawlClock
// ---------------------------------------------------------------------------

describe('createSystemCrawlClock', () => {
  it('now() reads the system time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(RUN_START));
    const clock = createSystemCrawlClock();
    const now = clock.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBe(Date.parse(RUN_START));
    vi.setSystemTime(Date.parse(RUN_START) + 5000);
    expect(clock.now().getTime()).toBe(Date.parse(RUN_START) + 5000);
  });

  it('sleep(1000) resolves only after 1000 ms have passed', async () => {
    vi.useFakeTimers();
    const clock = createSystemCrawlClock();
    const sleeping = track(clock.sleep(1000));
    await vi.advanceTimersByTimeAsync(999);
    expect(sleeping.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeping.settled).toBe(true);
    expect(sleeping.rejected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sleep(0) and negative values resolve at once without a timer', async () => {
    vi.useFakeTimers();
    const clock = createSystemCrawlClock();
    const zero = track(clock.sleep(0));
    const negative = track(clock.sleep(-250));
    await flushMicrotasks();
    expect(zero.settled).toBe(true);
    expect(negative.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sleep with a signal still waits the full time when nothing aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const clock = createSystemCrawlClock(controller.signal);
    const sleeping = track(clock.sleep(2000));
    await vi.advanceTimersByTimeAsync(1999);
    expect(sleeping.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeping.settled).toBe(true);
    expect(sleeping.rejected).toBe(false);
  });

  it('an abort during sleep resolves it promptly, without rejecting, and leaves no timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const clock = createSystemCrawlClock(controller.signal);
    const sleeping = track(clock.sleep(10_000));
    await flushMicrotasks();
    expect(sleeping.settled).toBe(false);
    controller.abort();
    await flushMicrotasks();
    expect(sleeping.settled).toBe(true);
    expect(sleeping.rejected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an already aborted signal makes sleep resolve at once', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const clock = createSystemCrawlClock(controller.signal);
    const sleeping = track(clock.sleep(10_000));
    await flushMicrotasks();
    expect(sleeping.settled).toBe(true);
    expect(sleeping.rejected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a later sleep on the same clock after an abort also resolves at once', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const clock = createSystemCrawlClock(controller.signal);
    const first = track(clock.sleep(10_000));
    controller.abort();
    await flushMicrotasks();
    const second = track(clock.sleep(10_000));
    await flushMicrotasks();
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// defaultTransport
// ---------------------------------------------------------------------------

describe('defaultTransport', () => {
  it('returns a transport function; creating it sends nothing', () => {
    const transport = defaultTransport();
    expect(typeof transport).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a call goes through the global fetch once and returns status and body', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('{"synthetic":true}', { status: 200 })),
    );
    const transport = defaultTransport();
    const response = await transport({ url: TEST_URL });
    expect(response).toStrictEqual({ status: 200, body: '{"synthetic":true}' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(TEST_URL);
  });

  it('a fetch rejection propagates (the Client maps it to a connection failure)', async () => {
    const transport = defaultTransport();
    await expect(transport({ url: TEST_URL })).rejects.toThrow(NETWORK_DISABLED);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
