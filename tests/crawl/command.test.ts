/**
 * AL2 unit tests: `src/crawl/command.ts` (`parseCrawlArgs`, `runCrawlCommand`), the paths that
 * need no database (AL4 hydration 1.4.10 Crawl Command and script, 1.4.1 `usageMessage`, 1.4.8
 * progress and summary lines; AL6 AC-45, AC-49, AC-59, AC-60, AC-61). AL3 routing
 * 20261022-hydration-07-command, section 2.1 A and B.
 *
 * `parseCrawlArgs` is pure. `runCrawlCommand` always gets an injected `SimulatedCrawlClock` and
 * the `CrawlWikimapia` transport, and an `env` without `DATABASE_URL` (so no database is ever
 * opened here). Global `fetch` is a rejecting spy: nothing reaches the network. Every result is
 * parsed with `CrawlCommandResultSchema`. Runs that need the Test Database live in
 * `./command.db.test.ts`.
 */
import { parseCrawlArgs, runCrawlCommand } from '../../src/crawl/command';
import { knownRegionNames, usageMessage } from '../../src/crawl/config';
import {
  CRAWL_COMMAND_OPTIONS,
  CrawlCommandResultSchema,
  DEFAULT_CRAWL_CONFIGURATION,
  OUTCOME_LABELS,
  SUMMARY_LABELS,
  TilePlanSchema,
  exitCodeFor,
  toMoment,
  type CrawlCommandIO,
  type CrawlCommandResult,
  type RunCrawlCommandFn,
  type Tile,
} from '../../contracts/hydration.schema';
import {
  CrawlWikimapia,
  RUN_START,
  SimulatedCrawlClock,
  TEST_API_KEY,
  emptyRecordedPage,
  scripted,
  type Responder,
} from '../../contracts/hydration.support';
import { UNREACHABLE_PASSWORD } from '../../contracts/storage.support';

// Compile-time check: the entry point has the contract's signature.
const command: RunCrawlCommandFn = runCrawlCommand;

const INTERNAL_ERROR_MESSAGE = 'Crawl failed: internal error';

/** The default `belgrade-small` Region's Tile Plan (AL6 AC-1), in Tile Number order. */
const BELGRADE_SMALL_TILES: readonly Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.457, north: 44.819 } },
  { tileNumber: 2, bbox: { west: 20.457, south: 44.814, east: 20.462, north: 44.819 } },
  { tileNumber: 3, bbox: { west: 20.452, south: 44.819, east: 20.457, north: 44.82 } },
  { tileNumber: 4, bbox: { west: 20.457, south: 44.819, east: 20.462, north: 44.82 } },
];

/** A valid key and no database: every non-dry Run ends before any Wikimapia request. */
const NO_DATABASE_ENV: CrawlCommandIO['env'] = { WIKIMAPIA_API_KEY: TEST_API_KEY };

// ---------------------------------------------------------------------------
// Lifecycle: no network
// ---------------------------------------------------------------------------

const fetchSpy = vi.fn((input: unknown) =>
  Promise.reject(new Error(`network is disabled in command tests: ${String(input)}`)),
);

beforeAll(() => {
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CommandExtra {
  env?: CrawlCommandIO['env'];
  signal?: AbortSignal;
  clock?: SimulatedCrawlClock;
  write?: (line: string) => void;
}

interface CommandRun {
  result: CrawlCommandResult;
  output: string[];
  wikimapia: CrawlWikimapia;
}

/**
 * Runs the command with a Simulated Clock and Simulated Wikimapia. Checks the invariants every
 * result must keep: the contract schema, `exitCodeFor` agreement and single-line writes.
 */
async function runCommand(
  argv: readonly string[],
  responder: Responder = smallScript(),
  extra: CommandExtra = {},
): Promise<CommandRun> {
  const clock = extra.clock ?? new SimulatedCrawlClock();
  const wikimapia = new CrawlWikimapia(clock, responder);
  const output: string[] = [];
  const io: CrawlCommandIO = {
    env: extra.env ?? NO_DATABASE_ENV,
    write:
      extra.write ??
      ((line: string) => {
        output.push(line);
      }),
    transport: wikimapia.transport,
    clock,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  };
  const result = CrawlCommandResultSchema.parse(await command(argv, io));
  expect(result.exitCode).toBe(exitCodeFor(result.report.outcome));
  for (const line of output) expect(line).not.toContain('\n');
  return { result, output, wikimapia };
}

function smallScript(): Responder {
  return scripted({
    tiles: BELGRADE_SMALL_TILES,
    listing: { 1: [emptyRecordedPage()], 2: [emptyRecordedPage()] },
  });
}

function summaryLines(result: CrawlCommandResult): string[] {
  return result.report.summaryText.split('\n');
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toContain('key=');
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
}

function parsedRequest(argv: readonly string[]) {
  const parsed = parseCrawlArgs(Object.freeze([...argv]));
  if (!parsed.ok) throw new Error(`expected a request, got the problem: ${parsed.problem}`);
  return parsed.request;
}

function parsedProblem(argv: readonly string[]): string {
  const parsed = parseCrawlArgs(Object.freeze([...argv]));
  if (parsed.ok) throw new Error(`expected a problem, got ${JSON.stringify(parsed.request)}`);
  return parsed.problem;
}

const USAGE = (): string => usageMessage(knownRegionNames(DEFAULT_CRAWL_CONFIGURATION));

// ---------------------------------------------------------------------------
// A. parseCrawlArgs
// ---------------------------------------------------------------------------

describe('parseCrawlArgs: options (A1)', () => {
  it.each([
    [['--region', 'belgrade'], { regionName: 'belgrade' }],
    [['--dry-run'], { dryRun: true }],
    [['--relist'], { relist: true }],
    [['--budget', '20'], { requestBudget: 20 }],
    [['--min-interval', '2'], { minRequestIntervalSeconds: 2 }],
    [['--refresh-age', '7'], { refreshAgeDays: 7 }],
  ] as const)('%j alone gives exactly %j', (argv, expected) => {
    expect(parseCrawlArgs(Object.freeze([...argv]))).toStrictEqual({ ok: true, request: expected });
  });

  it('every option together gives every key', () => {
    expect(
      parsedRequest([
        '--region',
        'belgrade-small',
        '--dry-run',
        '--relist',
        '--budget',
        '20',
        '--min-interval',
        '2.5',
        '--refresh-age',
        '7',
      ]),
    ).toStrictEqual({
      regionName: 'belgrade-small',
      dryRun: true,
      relist: true,
      requestBudget: 20,
      minRequestIntervalSeconds: 2.5,
      refreshAgeDays: 7,
    });
  });

  it('the order of the options does not matter', () => {
    expect(
      parsedRequest(['--refresh-age', '3', '--relist', '--budget', '5', '--region', 'belgrade']),
    ).toStrictEqual({ regionName: 'belgrade', relist: true, requestBudget: 5, refreshAgeDays: 3 });
  });

  it('accepts the option names of CRAWL_COMMAND_OPTIONS', () => {
    expect(
      parsedRequest([
        CRAWL_COMMAND_OPTIONS.region,
        'belgrade',
        CRAWL_COMMAND_OPTIONS.dryRun,
        CRAWL_COMMAND_OPTIONS.relist,
        CRAWL_COMMAND_OPTIONS.budget,
        '1',
        CRAWL_COMMAND_OPTIONS.minInterval,
        '1',
        CRAWL_COMMAND_OPTIONS.refreshAge,
        '1',
      ]),
    ).toStrictEqual({
      regionName: 'belgrade',
      dryRun: true,
      relist: true,
      requestBudget: 1,
      minRequestIntervalSeconds: 1,
      refreshAgeDays: 1,
    });
  });

  it('keeps the Region text as given (no trimming, no case change)', () => {
    expect(parsedRequest(['--region', ' Belgrade '])).toStrictEqual({ regionName: ' Belgrade ' });
    expect(parsedRequest(['--region', ''])).toStrictEqual({ regionName: '' });
  });

  it('does not change the given argv', () => {
    const argv = ['--', '--region', 'belgrade', '--budget', '3'];
    const copy = [...argv];
    parseCrawlArgs(argv);
    expect(argv).toStrictEqual(copy);
  });
});

describe('parseCrawlArgs: leading -- (A2)', () => {
  it('drops one leading --', () => {
    expect(parseCrawlArgs(['--', '--region', 'belgrade'])).toStrictEqual({
      ok: true,
      request: { regionName: 'belgrade' },
    });
    expect(parseCrawlArgs(['--'])).toStrictEqual({ ok: true, request: {} });
  });

  it('a -- anywhere else is an unknown option', () => {
    expect(parsedProblem(['--region', 'belgrade', '--'])).toBe('unknown option "--"');
    expect(parsedProblem(['--', '--'])).toBe('unknown option "--"');
    expect(parsedProblem(['--dry-run', '--', '--region', 'belgrade'])).toBe('unknown option "--"');
  });
});

describe('parseCrawlArgs: values that look like options (A3)', () => {
  it('--refresh-age -1 reads -1 as the value', () => {
    expect(parsedRequest(['--refresh-age', '-1'])).toStrictEqual({ refreshAgeDays: -1 });
  });

  it('--budget --relist takes --relist as the value, which is NaN; relist is not set', () => {
    const request = parsedRequest(['--budget', '--relist']);
    expect(Object.keys(request)).toStrictEqual(['requestBudget']);
    expect(Number.isNaN(request.requestBudget)).toBe(true);
  });

  it('--region --dry-run takes --dry-run as the Region text', () => {
    expect(parsedRequest(['--region', '--dry-run'])).toStrictEqual({ regionName: '--dry-run' });
  });
});

describe('parseCrawlArgs: numbers (A4)', () => {
  it.each([
    ['2', 2],
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['20', 20],
  ])('%j parses to %d for every numeric option', (text, value) => {
    expect(
      parsedRequest(['--budget', text, '--min-interval', text, '--refresh-age', text]),
    ).toStrictEqual({ requestBudget: value, minRequestIntervalSeconds: value, refreshAgeDays: value });
  });

  it.each(['', 'abc', '1e3', '0x10', ' 2', '2 ', '1.', '.5', '+2', 'Infinity', '1,5'])(
    '%j gives NaN for every numeric option',
    (text) => {
      const request = parsedRequest(['--budget', text, '--min-interval', text, '--refresh-age', text]);
      expect(Object.keys(request).sort()).toStrictEqual(
        ['minRequestIntervalSeconds', 'refreshAgeDays', 'requestBudget'],
      );
      expect(Number.isNaN(request.requestBudget)).toBe(true);
      expect(Number.isNaN(request.minRequestIntervalSeconds)).toBe(true);
      expect(Number.isNaN(request.refreshAgeDays)).toBe(true);
    },
  );
});

describe('parseCrawlArgs: problems (A5)', () => {
  it('an unknown option names the token', () => {
    expect(parsedProblem(['--regoin', 'belgrade'])).toBe('unknown option "--regoin"');
    expect(parsedProblem(['--region', 'belgrade', '-x'])).toBe('unknown option "-x"');
  });

  it('a bare word is an unknown option', () => {
    expect(parsedProblem(['belgrade'])).toBe('unknown option "belgrade"');
    expect(parsedProblem(['--region', 'belgrade', 'extra'])).toBe('unknown option "extra"');
  });

  it.each(['--region', '--budget', '--min-interval', '--refresh-age'])(
    'a missing value for %s names the option',
    (option) => {
      expect(parsedProblem(['--dry-run', option])).toBe(`missing value for ${option}`);
    },
  );

  it.each([
    [['--region', 'a', '--region', 'b'], '--region'],
    [['--dry-run', '--dry-run'], '--dry-run'],
    [['--relist', '--region', 'a', '--relist'], '--relist'],
    [['--budget', '1', '--budget', '1'], '--budget'],
    [['--min-interval', '1', '--min-interval', '2'], '--min-interval'],
    [['--refresh-age', '1', '--refresh-age', '2'], '--refresh-age'],
  ] as const)('%j: an option given twice names it', (argv, option) => {
    expect(parsedProblem(argv)).toBe(`option ${option} given twice`);
  });

  it('a problem result carries no request', () => {
    expect(parseCrawlArgs(['--regoin'])).toStrictEqual({
      ok: false,
      problem: 'unknown option "--regoin"',
    });
  });
});

describe('parseCrawlArgs: no arguments (A6)', () => {
  it('[] gives an empty request', () => {
    expect(parseCrawlArgs([])).toStrictEqual({ ok: true, request: {} });
  });
});

// ---------------------------------------------------------------------------
// B. runCrawlCommand without a database
// ---------------------------------------------------------------------------

describe('runCrawlCommand: unknown option (B1)', () => {
  it('ends Failed, exit 1, with the problem and the usage, and sends nothing', async () => {
    const { result, output, wikimapia } = await runCommand(['--regoin', 'belgrade-small']);
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toBe(`unknown option "--regoin". ${USAGE()}`);
    for (const text of [result.report.message ?? '', output.join('\n')]) {
      expect(text).toContain('unknown option "--regoin"');
      expect(text).toContain(CRAWL_COMMAND_OPTIONS.region);
      expect(text).toContain('belgrade');
      expect(text).toContain('belgrade-small');
    }
    expect(wikimapia.calls).toHaveLength(0);
    expect('regionName' in result.report.summary).toBe(false);
    expect(result.report.summary.startedAt).toBe(RUN_START);
    expect(result.report.summary.endedAt).toBe(RUN_START);
  });

  it('a missing value and a repeated option end the same way', async () => {
    const missing = await runCommand(['--region', 'belgrade-small', '--budget']);
    expect(missing.result.report.outcome).toBe('failed');
    expect(missing.result.exitCode).toBe(1);
    expect(missing.result.report.message).toBe(`missing value for --budget. ${USAGE()}`);
    expect(missing.wikimapia.calls).toHaveLength(0);

    const twice = await runCommand(['--region', 'a', '--region', 'b']);
    expect(twice.result.report.outcome).toBe('failed');
    expect(twice.result.exitCode).toBe(1);
    expect(twice.result.report.message).toBe(`option --region given twice. ${USAGE()}`);
    expect(twice.wikimapia.calls).toHaveLength(0);
  });

  it('uses the injected clock for the moments of the failed report', async () => {
    const clock = new SimulatedCrawlClock('2026-11-01T10:20:30Z');
    const { result } = await runCommand(['--bogus'], smallScript(), { clock });
    expect(result.report.summary.startedAt).toBe('2026-11-01T10:20:30Z');
    expect(result.report.summary.endedAt).toBe('2026-11-01T10:20:30Z');
  });

  it('falls back to the system clock when io.clock is absent', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-12-24T18:00:07.400Z'), toFake: ['Date'] });
    const output: string[] = [];
    const result = CrawlCommandResultSchema.parse(
      await command(['--bogus'], {
        env: NO_DATABASE_ENV,
        write: (line) => {
          output.push(line);
        },
      }),
    );
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.summary.startedAt).toBe(toMoment(new Date('2026-12-24T18:00:07.400Z')));
    expect(output[0]).toBe(result.report.message);
  });
});

describe('runCrawlCommand: unparsable numbers (B2)', () => {
  it.each(['abc', ''])('--budget %j ends Failed naming requestBudget, exit 1', async (value) => {
    const { result, wikimapia } = await runCommand(['--region', 'belgrade-small', '--budget', value]);
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toContain('requestBudget');
    expect(wikimapia.calls).toHaveLength(0);
  });

  it('--refresh-age -1 reaches the Run and fails naming refreshAgeDays', async () => {
    const { result, wikimapia } = await runCommand([
      '--region',
      'belgrade-small',
      '--refresh-age',
      '-1',
    ]);
    expect(result.report.outcome).toBe('failed');
    expect(result.report.message).toContain('refreshAgeDays');
    expect(wikimapia.calls).toHaveLength(0);
  });
});

describe('runCrawlCommand: no Region (B3)', () => {
  it('[] ends Failed with the usage listing the known Region Names, and sends nothing', async () => {
    const { result, output, wikimapia } = await runCommand([]);
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toBe(USAGE());
    expect(output.join('\n')).toContain(USAGE());
    for (const name of knownRegionNames(DEFAULT_CRAWL_CONFIGURATION)) {
      expect(result.report.message).toContain(name);
    }
    expect(result.report.message).toContain('belgrade-small');
    expect(result.report.message).toContain(CRAWL_COMMAND_OPTIONS.region);
    expect(wikimapia.calls).toHaveLength(0);
    expect('regionName' in result.report.summary).toBe(false);
  });

  it('a leading -- alone is the same as no arguments', async () => {
    const { result } = await runCommand(['--']);
    expect(result.report.outcome).toBe('failed');
    expect(result.report.message).toBe(USAGE());
  });
});

describe('runCrawlCommand: Dry Run (B4)', () => {
  it('plans belgrade-small with no key and no database: plan lines, then the summary', async () => {
    const { result, output, wikimapia } = await runCommand(
      ['--region', 'belgrade-small', '--dry-run'],
      smallScript(),
      { env: {} },
    );
    expect(result.report.outcome).toBe('planned');
    expect(result.exitCode).toBe(0);
    expect(wikimapia.calls).toHaveLength(0);

    const plan = TilePlanSchema.parse(result.report.plan);
    expect(plan.tiles.map((t) => t.tileNumber)).toStrictEqual([1, 2, 3, 4]);

    const lines = summaryLines(result);
    expect(output).toHaveLength(1 + 4 + lines.length);
    expect(output[0]).toBe('Region belgrade-small: 4 tiles');
    const tileLines = output.slice(1, 5);
    tileLines.forEach((line, i) => {
      expect(line).toMatch(new RegExp(`^Tile ${String(i + 1)}: west `));
    });
    expect(tileLines[0]).toBe('Tile 1: west 20.452, south 44.814, east 20.457, north 44.819');
    expect(tileLines[3]).toBe('Tile 4: west 20.457, south 44.819, east 20.462, north 44.82');
    expect(output.slice(5)).toStrictEqual(lines);
    expect(output).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.planned}`);
    expect(output).toContain(`${SUMMARY_LABELS.wikimapiaRequests}: 0`);
  });

  it('a Dry Run with an unreachable-looking database URL still plans', async () => {
    const { result, wikimapia } = await runCommand(
      ['--', '--dry-run', '--region', 'belgrade-small'],
      smallScript(),
      { env: { DATABASE_URL: 'postgres://nobody:none@127.0.0.1:1/none' } },
    );
    expect(result.report.outcome).toBe('planned');
    expect(result.exitCode).toBe(0);
    expect(wikimapia.calls).toHaveLength(0);
  });
});

describe('runCrawlCommand: no database and no Dry Run (B5)', () => {
  it.each([
    ['without DATABASE_URL', { WIKIMAPIA_API_KEY: TEST_API_KEY }],
    ['with an empty DATABASE_URL', { WIKIMAPIA_API_KEY: TEST_API_KEY, DATABASE_URL: '' }],
  ] as const)('%s: ends Failed, exit 1, sends nothing, shows no secrets', async (_label, env) => {
    const { result, output, wikimapia } = await runCommand(['--region', 'belgrade-small'], smallScript(), {
      env,
    });
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(wikimapia.calls).toHaveLength(0);
    expectNoSecrets(output.join('\n'));
    expectNoSecrets(JSON.stringify(result));
  });
});

describe('runCrawlCommand: output order (B6)', () => {
  it('a parse failure writes the message, then each summary line as its own write', async () => {
    const { result, output } = await runCommand(['--regoin']);
    expect(output).toStrictEqual([result.report.message, ...summaryLines(result)]);
  });

  it('a Run failure writes the message after any progress lines, then the summary lines', async () => {
    const { result, output } = await runCommand(['--region', 'belgrade-small']);
    const lines = summaryLines(result);
    const tail = output.slice(output.length - lines.length - 1);
    expect(tail).toStrictEqual([result.report.message, ...lines]);
  });

  it('the summary of a failed report has no region line when no region was asked', async () => {
    const { result, output } = await runCommand([]);
    expect(output.some((line) => line.startsWith(`${SUMMARY_LABELS.regionName}:`))).toBe(false);
    expect(output).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.failed}`);
    expect(output).toStrictEqual([result.report.message, ...summaryLines(result)]);
  });
});

describe('runCrawlCommand: exitCodeFor agreement (B7)', () => {
  it('every outcome reachable without a database maps through exitCodeFor', async () => {
    const runs = await Promise.all([
      runCommand(['--region', 'belgrade-small', '--dry-run'], smallScript(), { env: {} }),
      runCommand(['--region', 'atlantis']),
      runCommand(['--nope']),
      runCommand([]),
    ]);
    expect(runs.map((r) => r.result.report.outcome)).toStrictEqual([
      'planned',
      'failed',
      'failed',
      'failed',
    ]);
    for (const { result } of runs) {
      expect(result.exitCode).toBe(exitCodeFor(result.report.outcome));
    }
  });
});

describe('runCrawlCommand: never rejects (B8)', () => {
  it('a write that throws on its first call ends Failed with exit 1 and writes nothing more', async () => {
    const write = vi.fn((line: string): void => {
      if (write.mock.calls.length === 1) throw new Error(`stdout is closed (${line})`);
    });
    const { result } = await runCommand(['--regoin'], smallScript(), { write });
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('stdout is closed');
  });

  it('a throwing write during a Dry Run also resolves Failed, exit 1, without the error text', async () => {
    const write = vi.fn((): void => {
      throw new Error('stdout is closed');
    });
    const { result, wikimapia } = await runCommand(
      ['--region', 'belgrade-small', '--dry-run'],
      smallScript(),
      { env: {}, write },
    );
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('stdout is closed');
    expect(wikimapia.calls).toHaveLength(0);
  });
});
