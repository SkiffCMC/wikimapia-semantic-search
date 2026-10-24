/**
 * AL2 unit tests: `src/crawl/command.ts` without a database (AL4 1.4.10; crawl-run1-fixes AL4
 * 1.4.10, 1.4.11). The contract tests only pass valid command lines, so this covers argument
 * problems, the leading `--`, unparsable numbers, the system-clock fallback, the never-rejects
 * guard and a `--retry-parked` Dry Run whose parked count cannot be read. No network: Dry Runs
 * and parse failures send nothing.
 */
import { parseCrawlArgs, runCrawlCommand } from '../../src/crawl/command';
import { knownRegionNames, usageMessage } from '../../src/crawl/config';
import {
  DEFAULT_CRAWL_CONFIGURATION,
  toMoment,
  type CrawlCommandIO,
} from '../../contracts/hydration.schema';
import { RUN_START, SimulatedCrawlClock } from '../../contracts/hydration.support';

const USAGE = usageMessage(knownRegionNames(DEFAULT_CRAWL_CONFIGURATION));
const INTERNAL_ERROR = 'Crawl failed: internal error';

function io(extra: Partial<CrawlCommandIO> = {}): CrawlCommandIO & { output: string[] } {
  const output: string[] = [];
  return {
    env: {},
    write: (line) => {
      output.push(line);
    },
    clock: new SimulatedCrawlClock(),
    ...extra,
    output,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseCrawlArgs', () => {
  it.each([
    [['--dry-run', '--dry-run'], 'option --dry-run given twice'],
    [['--budget', '1', '--budget', '2'], 'option --budget given twice'],
    [['--region'], 'missing value for --region'],
    [['--region', 'x', '--'], 'unknown option "--"'],
    [['belgrade'], 'unknown option "belgrade"'],
  ])('%j is the problem %j', (argv, problem) => {
    expect(parseCrawlArgs(argv)).toStrictEqual({ ok: false, problem });
  });

  it.each([
    [['--', '--region', 'x'], { regionName: 'x' }],
    [['--retry-parked', '--budget', '1e3'], { retryParked: true, requestBudget: Number.NaN }],
  ])('%j gives %j', (argv, request) => {
    expect(parseCrawlArgs(argv)).toStrictEqual({ ok: true, request });
  });
});

describe('runCrawlCommand', () => {
  it.each([
    ['the injected clock', true, RUN_START],
    ['the system clock', false, '2026-12-24T18:00:07Z'],
  ])('a parse problem ends Failed with the usage, at the moment of %s', async (_c, inject, at) => {
    vi.useFakeTimers({ now: Date.parse('2026-12-24T18:00:07Z'), toFake: ['Date'] });
    const commandIo = io();
    if (!inject) delete commandIo.clock;
    const { exitCode, report } = await runCrawlCommand(['--regoin'], commandIo);
    expect(exitCode).toBe(1);
    expect(report.message).toBe(`unknown option "--regoin". ${USAGE}`);
    expect(report.summary.startedAt).toBe(toMoment(new Date(at)));
    expect(commandIo.output).toStrictEqual([report.message, ...report.summaryText.split('\n')]);
  });

  it.each([
    ['a parse problem', ['--regoin']],
    ['a Dry Run', ['--region', 'belgrade-small', '--dry-run']],
  ])('a throwing write during %s resolves Failed with the internal error', async (_c, argv) => {
    const write = vi.fn(() => {
      throw new Error('stdout is closed');
    });
    const { exitCode, report } = await runCrawlCommand(argv, io({ write }));
    expect(exitCode).toBe(1);
    expect(report.message).toBe(INTERNAL_ERROR);
    expect(report.summary.startedAt).toBe(RUN_START);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a --retry-parked Dry Run without a database ends Failed with no parked line', async () => {
    const commandIo = io();
    const { exitCode, report } = await runCrawlCommand(
      ['--region', 'belgrade-small', '--dry-run', '--retry-parked'],
      commandIo,
    );
    expect(exitCode).toBe(1);
    expect(report.outcome).toBe('failed');
    expect(report).not.toHaveProperty('parkedPlacesInRegion');
    expect(commandIo.output.some((line) => line.startsWith('Parked places that'))).toBe(false);
  });
});
