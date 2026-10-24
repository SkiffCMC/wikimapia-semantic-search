/**
 * AL2 unit tests: `src/wikimapia/runtime.ts` (AL4 1.4.10). The contract tests always inject a
 * transport and a clock, so the runtime defaults are only tested here: `globalThis.fetch` is
 * stubbed and `systemClock` runs under fake timers.
 */
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  createFetchTransport,
  systemClock,
} from '../../src/wikimapia/runtime';
import { TEST_API_KEY } from '../../contracts/wikimapia-client.support';

const URL = `https://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=62587`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ['default', undefined, DEFAULT_REQUEST_TIMEOUT_MS],
  ['given', { timeoutMs: 5000 }, 5000],
])(
  'createFetchTransport (%s timeout): one GET with a timeout signal, mapped to { status, body }',
  async (_, options, timeoutMs) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>busy</html>', { status: 503 }));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const transport = createFetchTransport(options);
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(await transport({ url: URL })).toStrictEqual({ status: 503, body: '<html>busy</html>' });
    expect(timeoutSpy).toHaveBeenCalledWith(timeoutMs);
    const signal: unknown = timeoutSpy.mock.results[0]?.value;
    expect(fetchSpy).toHaveBeenCalledWith(URL, { method: 'GET', redirect: 'follow', signal });
  },
);

it('systemClock.sleep above the Node timer limit waits the full time in chunks', async () => {
  vi.useFakeTimers();
  let settled = false;
  const sleeping = systemClock.sleep(MAX_TIMER_DELAY_MS + 5000).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS + 4999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await sleeping;
  expect(settled).toBe(true);
});
