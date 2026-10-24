/**
 * AL2 unit tests: `src/crawl/runtime.ts` (AL4 1.3 `createSystemCrawlClock`, `defaultTransport`,
 * 1.4.3 "Interrupt"). The contract tests always inject a clock and transport, so these defaults
 * are only reached here. Fake timers and a stubbed `fetch`; no real network or time.
 */
import { createSystemCrawlClock, defaultTransport } from '../../src/crawl/runtime';
import { RUN_START } from '../../contracts/hydration.support';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Resolves to whether `promise` settled within the pending microtasks. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return done;
}

describe('createSystemCrawlClock', () => {
  it('now() reads the system time and sleep(ms) waits exactly ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(RUN_START));
    const clock = createSystemCrawlClock(new AbortController().signal);
    expect(clock.now().getTime()).toBe(Date.parse(RUN_START));
    const sleeping = clock.sleep(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(await settled(sleeping)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(sleeping)).toBe(true);
  });

  it.each([
    ['ms <= 0', -5, false],
    ['an already aborted signal', 10_000, true],
  ])('sleep resolves at once without a timer for %s', async (_case, ms, abort) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (abort) controller.abort();
    expect(await settled(createSystemCrawlClock(controller.signal).sleep(ms))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort during sleep resolves it at once and clears the timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = createSystemCrawlClock(controller.signal).sleep(10_000);
    expect(await settled(sleeping)).toBe(false);
    controller.abort();
    expect(await settled(sleeping)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('defaultTransport', () => {
  it('sends through the global fetch and returns status and body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"synthetic":true}', { status: 200 }));
    const url = 'https://api.wikimapia.org/?function=box';
    expect(await defaultTransport()({ url })).toStrictEqual({
      status: 200,
      body: '{"synthetic":true}',
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(url);
  });
});
