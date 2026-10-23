/**
 * AL2 unit tests: `src/crawl/command.ts` (`runCrawlCommand`) end to end through `runCrawl` and the
 * Test Database (AL4 hydration 1.4.10 Crawl Command and script, 1.4.8 progress and summary
 * lines; AL6 AC-45, AC-47, AC-49, AC-59, AC-61). AL3 routing 20261022-hydration-07-command,
 * section 2.1, `tests/crawl/command.db.test.ts`.
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`), emptied before every test. Every
 * call gets an injected `SimulatedCrawlClock` and the `CrawlWikimapia` transport (scripted
 * answers, recorded fixtures through the support helpers). Global `fetch` is a rejecting spy:
 * nothing reaches the network. Every result is parsed with `CrawlCommandResultSchema`; Crawl
 * Progress is read only through the public Crawl Store.
 *
 * crawl-run1-fixes (AL4 1.4.10, 1.4.11, U7; AL3 20261022-crawl-run1-fixes-07-command, 2.1 B):
 * `--retry-parked` Dry Run parked line, Explicit Retry through the command, Quota Run exit 0.
 */
import { runCrawlCommand } from '../../src/crawl/command';
import { createCrawlStore } from '../../src/db/crawl-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import {
  CRAWL_COMMAND_OPTIONS,
  CrawlCommandResultSchema,
  CrawlProgressResultSchema,
  OUTCOME_LABELS,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
  exitCodeFor,
  type CrawlCommandIO,
  type CrawlCommandResult,
  type CrawlProgressView,
  type CrawlStore,
  type RunCrawlCommandFn,
  type Tile,
} from '../../contracts/hydration.schema';
import {
  CrawlWikimapia,
  HOUR,
  RUN_START,
  SECOND,
  SimulatedCrawlClock,
  TEST_API_KEY,
  at,
  emptyRecordedPage,
  listingAnswer,
  rateLimitForever,
  scripted,
  syntheticBoxPlace,
  tileNumberOf,
  wikimapiaErrorAnswer,
  type Responder,
  type WikimapiaCall,
} from '../../contracts/hydration.support';
import {
  EmptyResultSchema,
  SchemaStepsResultSchema,
  type SchemaSetup,
} from '../../contracts/storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import { keyQuotaAnswer } from '../../contracts/wikimapia-client.support';

// Compile-time check: the entry point has the contract's signature.
const command: RunCrawlCommandFn = runCrawlCommand;

const T0 = Date.parse(RUN_START);
const UNREACHABLE_TIMEOUT_MS = 60_000;

/** The default `belgrade-small` Region's Tile Plan (AL6 AC-1), in Tile Number order. */
const BELGRADE_SMALL_TILES: readonly Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.457, north: 44.819 } },
  { tileNumber: 2, bbox: { west: 20.457, south: 44.814, east: 20.462, north: 44.819 } },
  { tileNumber: 3, bbox: { west: 20.452, south: 44.819, east: 20.457, north: 44.82 } },
  { tileNumber: 4, bbox: { west: 20.457, south: 44.819, east: 20.462, north: 44.82 } },
];

// ---------------------------------------------------------------------------
// Lifecycle: one Test Database, every Schema Setup step applied, emptied before every test
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let crawlStore: CrawlStore;
const fetchSpy = vi.fn((input: unknown) =>
  Promise.reject(new Error(`network is disabled in command tests: ${String(input)}`)),
);

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  if (!applied.ok) throw new Error(`Schema Setup failed: ${applied.failure.message}`);
  crawlStore = createCrawlStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
});

afterAll(async () => {
  await crawlStore.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CommandExtra {
  env?: CrawlCommandIO['env'];
  signal?: AbortSignal;
  clock?: SimulatedCrawlClock;
}

interface CommandRun {
  result: CrawlCommandResult;
  output: string[];
  wikimapia: CrawlWikimapia;
}

async function runCommand(
  argv: readonly string[],
  responder: Responder,
  extra: CommandExtra = {},
): Promise<CommandRun> {
  const clock = extra.clock ?? new SimulatedCrawlClock();
  const wikimapia = new CrawlWikimapia(clock, responder);
  const output: string[] = [];
  const io: CrawlCommandIO = {
    env: extra.env ?? { WIKIMAPIA_API_KEY: TEST_API_KEY, DATABASE_URL: testUrl },
    write: (line: string) => {
      output.push(line);
    },
    transport: wikimapia.transport,
    clock,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  };
  const result = CrawlCommandResultSchema.parse(await command(argv, io));
  expect(result.exitCode).toBe(exitCodeFor(result.report.outcome));
  for (const line of output) expect(line).not.toContain('\n');
  return { result, output, wikimapia };
}

/** Every Tile's first page is the recorded empty page; everything else uses the defaults. */
function emptyScript(): Responder {
  return scripted({
    tiles: BELGRADE_SMALL_TILES,
    listing: {
      1: [emptyRecordedPage()],
      2: [emptyRecordedPage()],
      3: [emptyRecordedPage()],
      4: [emptyRecordedPage()],
    },
  });
}

function listingPages(calls: readonly WikimapiaCall[]): string[] {
  return calls
    .filter((c) => c.fn === 'box')
    .map((c) => `tile ${String(tileNumberOf(BELGRADE_SMALL_TILES, c.bbox))} page ${String(c.page)}`);
}

async function progress(regionName: string): Promise<CrawlProgressView> {
  const result = CrawlProgressResultSchema.parse(await crawlStore.readCrawlProgress({ regionName }));
  if (!result.ok) throw new Error(`readCrawlProgress failed: ${result.failure.message}`);
  return result.value;
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toContain('key=');
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
}

function outcomeLine(result: CrawlCommandResult): string {
  return `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS[result.report.outcome]}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCrawlCommand with the Test Database', () => {
  it('Completed: exit 0, the Run start progress line comes before the summary lines', async () => {
    const { result, output, wikimapia } = await runCommand(
      ['--region', 'belgrade-small'],
      emptyScript(),
    );
    expect(result.report.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(listingPages(wikimapia.calls)).toStrictEqual([
      'tile 1 page 1',
      'tile 2 page 1',
      'tile 3 page 1',
      'tile 4 page 1',
    ]);

    const runId = result.report.runId;
    expect(runId).toBeDefined();
    const startIndex = output.findIndex((line) =>
      line.startsWith(`Run ${String(runId)} started for region belgrade-small`),
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);

    const lines = result.report.summaryText.split('\n');
    expect(output.slice(output.length - lines.length)).toStrictEqual(lines);
    expect(startIndex).toBeLessThan(output.length - lines.length);
    expect(output).toContain(outcomeLine(result));
    expect(output).toContain('Run outcome: Completed');
  });

  it('Budget Reached: --budget 1 sends exactly 1 request and exits 0', async () => {
    const { result, output, wikimapia } = await runCommand(
      ['--region', 'belgrade-small', '--budget', '1'],
      emptyScript(),
    );
    expect(result.report.outcome).toBe('budget_reached');
    expect(result.exitCode).toBe(0);
    expect(wikimapia.calls).toHaveLength(1);
    expect(output).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.budget_reached}`);
  });

  it('Rate Limited: a rate limit on every attempt ends Rate Limited, exit 0', async () => {
    const { result, output } = await runCommand(['--region', 'belgrade-small'], () =>
      rateLimitForever(),
    );
    expect(result.report.outcome).toBe('rate_limited');
    expect(result.exitCode).toBe(0);
    expect(output).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.rate_limited}`);
  });

  it('Interrupted: a signal aborted before the call sends nothing and exits 1', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, output, wikimapia } = await runCommand(
      ['--region', 'belgrade-small'],
      emptyScript(),
      { signal: controller.signal },
    );
    expect(result.report.outcome).toBe('interrupted');
    expect(result.exitCode).toBe(1);
    expect(wikimapia.calls).toHaveLength(0);
    expect(output).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.interrupted}`);
  });

  it('overrides reach the Run: --min-interval 1 --budget 2 sends 2 requests 1 s apart', async () => {
    const { result, wikimapia } = await runCommand(
      ['--region', 'belgrade-small', '--min-interval', '1', '--budget', '2'],
      emptyScript(),
    );
    expect(result.report.outcome).toBe('budget_reached');
    expect(wikimapia.calls).toHaveLength(2);
    expect(at(wikimapia.calls, 1).startedAtMs - at(wikimapia.calls, 0).startedAtMs).toBe(SECOND);
  });

  it('--relist after a complete pass lists tile 1 page 1 again and keeps 2 passes', async () => {
    const first = await runCommand(['--region', 'belgrade-small'], emptyScript());
    expect(first.result.report.outcome).toBe('completed');

    const relisted = await runCommand(
      ['--region', 'belgrade-small', '--relist', '--budget', '1'],
      emptyScript(),
      { clock: new SimulatedCrawlClock(T0 + HOUR) },
    );
    expect(relisted.result.report.outcome).toBe('budget_reached');
    expect(relisted.result.exitCode).toBe(0);
    expect(listingPages(relisted.wikimapia.calls)).toStrictEqual(['tile 1 page 1']);
    expect((await progress('belgrade-small')).passes).toHaveLength(2);
  });

  it(
    'an unreachable database ends Failed, exit 1, sends nothing and shows no secrets',
    async () => {
      const { result, output, wikimapia } = await runCommand(
        ['--region', 'belgrade-small'],
        emptyScript(),
        { env: { WIKIMAPIA_API_KEY: TEST_API_KEY, DATABASE_URL: UNREACHABLE_DATABASE_URL } },
      );
      expect(result.report.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(wikimapia.calls).toHaveLength(0);
      expectNoSecrets(output.join('\n'));
      expectNoSecrets(JSON.stringify(result));
      const lines = result.report.summaryText.split('\n');
      expect(output.slice(output.length - lines.length - 1)).toStrictEqual([
        result.report.message,
        ...lines,
      ]);
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// --retry-parked and the Quota Run (crawl-run1-fixes AL4 1.4.10, 1.4.11, U7;
// AL3 20261022-crawl-run1-fixes-07-command, section 2.1 B)
// ---------------------------------------------------------------------------

/** A synthetic Place inside Tile 1 of `belgrade-small`. */
const PARKED_ID = 7_000_001;
const PARKED_PLACE = syntheticBoxPlace(PARKED_ID, 20.454, 44.816);

function parkedLine(n: number): string {
  return `Parked places that ${CRAWL_COMMAND_OPTIONS.retryParked} would release: ${String(n)}`;
}

/** Tile 1 lists PARKED_PLACE; its Details request gets a Wikimapia Error. */
function failingScript(): Responder {
  return scripted({
    tiles: BELGRADE_SMALL_TILES,
    listing: {
      1: [listingAnswer([PARKED_PLACE])],
      2: [emptyRecordedPage()],
      3: [emptyRecordedPage()],
      4: [emptyRecordedPage()],
    },
    details: { [PARKED_ID]: wikimapiaErrorAnswer() },
  });
}

/** Tile 1 lists PARKED_PLACE; its Details request gets synthetic Place Details. */
function succeedingScript(): Responder {
  return scripted({
    tiles: BELGRADE_SMALL_TILES,
    listing: {
      1: [listingAnswer([PARKED_PLACE])],
      2: [emptyRecordedPage()],
      3: [emptyRecordedPage()],
      4: [emptyRecordedPage()],
    },
  });
}

function clockAt(hours: number): SimulatedCrawlClock {
  return new SimulatedCrawlClock(T0 + hours * HOUR);
}

/** Three plain Runs, one per hour from hour 0, each failing PARKED_ID: the Place is Parked. */
async function parkOnePlaceThroughTheCommand(): Promise<void> {
  for (const hours of [0, 1, 2]) {
    const { result, wikimapia } = await runCommand(
      [CRAWL_COMMAND_OPTIONS.region, 'belgrade-small'],
      failingScript(),
      { clock: clockAt(hours) },
    );
    expect(result.exitCode).toBe(0);
    expect(wikimapia.detailsIds).toStrictEqual([PARKED_ID]);
  }
}

function dryRetryArgv(): string[] {
  return [
    CRAWL_COMMAND_OPTIONS.region,
    'belgrade-small',
    CRAWL_COMMAND_OPTIONS.dryRun,
    CRAWL_COMMAND_OPTIONS.retryParked,
  ];
}

function expectDryRetryOutput(result: CrawlCommandResult, output: readonly string[], n: number) {
  const lines = result.report.summaryText.split('\n');
  expect(output).toHaveLength(1 + BELGRADE_SMALL_TILES.length + 1 + lines.length);
  expect(output[0]).toBe('Region belgrade-small: 4 tiles');
  output.slice(1, 5).forEach((line, i) => {
    expect(line).toMatch(new RegExp(`^Tile ${String(i + 1)}: west `));
  });
  expect(output[5]).toBe(parkedLine(n));
  expect(output.slice(6)).toStrictEqual(lines);
  expect(output.filter((line) => line.startsWith('Parked places that'))).toStrictEqual([
    parkedLine(n),
  ]);
  expect(result.report.summaryText).not.toContain('Parked places that');
}

describe('runCrawlCommand --retry-parked with the Test Database', () => {
  it('Dry Run: the plan, one parked line, then the summary; nothing changes', async () => {
    await parkOnePlaceThroughTheCommand();
    const runsBefore = (await progress('belgrade-small')).runs;

    const { result, output, wikimapia } = await runCommand(dryRetryArgv(), succeedingScript(), {
      clock: clockAt(3),
    });
    expect(result.report.outcome).toBe('planned');
    expect(result.exitCode).toBe(0);
    expect(result.report.parkedPlacesInRegion).toBe(1);
    expect(result.report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(wikimapia.calls).toHaveLength(0);
    expectDryRetryOutput(result, output, 1);
    expect((await progress('belgrade-small')).runs).toStrictEqual(runsBefore);

    // The Place is still Parked: a plain Run does not request it.
    const plain = await runCommand(
      [CRAWL_COMMAND_OPTIONS.region, 'belgrade-small'],
      succeedingScript(),
      { clock: clockAt(4) },
    );
    expect(plain.result.exitCode).toBe(0);
    expect(plain.wikimapia.detailsIds).not.toContain(PARKED_ID);
  });

  it('Dry Run with nothing Parked prints "would release: 0" and exits 0', async () => {
    const { result, output, wikimapia } = await runCommand(dryRetryArgv(), emptyScript());
    expect(result.report.outcome).toBe('planned');
    expect(result.exitCode).toBe(0);
    expect(result.report.parkedPlacesInRegion).toBe(0);
    expect(result.report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(wikimapia.calls).toHaveLength(0);
    expectDryRetryOutput(result, output, 0);
  });

  it('--retry-parked --budget 10 releases and requests the Place; the retry line precedes the summary', async () => {
    await parkOnePlaceThroughTheCommand();

    const { result, output, wikimapia } = await runCommand(
      [
        CRAWL_COMMAND_OPTIONS.region,
        'belgrade-small',
        CRAWL_COMMAND_OPTIONS.retryParked,
        CRAWL_COMMAND_OPTIONS.budget,
        '10',
      ],
      succeedingScript(),
      { clock: clockAt(3) },
    );
    expect(result.exitCode).toBe(0);
    expect(wikimapia.detailsIds).toStrictEqual([PARKED_ID]);
    expect(result.report.summary.counts.placesReleased).toBe(1);
    expect('parkedPlacesInRegion' in result.report).toBe(false);

    const retryLine = 'Explicit retry: released 1 parked places of region belgrade-small';
    const retryIndex = output.indexOf(retryLine);
    expect(retryIndex).toBeGreaterThanOrEqual(0);
    const lines = result.report.summaryText.split('\n');
    expect(output.slice(output.length - lines.length)).toStrictEqual(lines);
    expect(retryIndex).toBeLessThan(output.length - lines.length);
    expect(output.some((line) => line.startsWith('Parked places that'))).toBe(false);
  });
});

describe('runCrawlCommand: Quota Run with the Test Database (crawl-run1-fixes U7)', () => {
  it('the first request answered with the Key Quota: exit 0, Quota Exhausted, the Wikimapia line, no secrets', async () => {
    const { result, output, wikimapia } = await runCommand(
      [CRAWL_COMMAND_OPTIONS.region, 'belgrade-small'],
      () => keyQuotaAnswer(),
    );
    expect(result.report.outcome).toBe('quota_exhausted');
    expect(result.exitCode).toBe(0);
    expect(wikimapia.calls).toHaveLength(1);
    expect(outcomeLine(result)).toBe(
      `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`,
    );
    expect(output).toContain(outcomeLine(result));
    expect(output.some((line) => line.startsWith(`${SUMMARY_LABELS.wikimapiaMessage}: `))).toBe(
      true,
    );
    expectNoSecrets(output.join('\n'));
    expectNoSecrets(JSON.stringify(result));
  });
});
