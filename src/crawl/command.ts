/**
 * The Crawl Command (AL4 1.4.10; AC-45, AC-47, AC-49, AC-59 .. AC-61; U7): parses the command
 * line into a `CrawlRequest`, runs `runCrawl` with the default Crawl Configuration, writes the
 * output lines (failure message, Dry Run plan, plain-text Run Summary) and maps the Run Outcome
 * to the exit code. Never rejects. Reads only the API key and database URL from `io.env` and
 * hands them to `runCrawl` unprinted. No SQL, no network of its own.
 *
 * `--retry-parked` (crawl-run1-fixes AL4 1.4.10, 1.4.11; AC-40) sets `retryParked` on the
 * request. For a Planned report that carries `parkedPlacesInRegion` (a Dry Run with the option),
 * one extra line `Parked places that --retry-parked would release: <n>` is written after the plan
 * lines and before the summary lines; it is never part of `summaryText`.
 */
import {
  API_KEY_ENV,
  CRAWL_COMMAND_OPTIONS,
  DATABASE_URL_ENV,
  DEFAULT_CRAWL_CONFIGURATION,
  exitCodeFor,
  toMoment,
  type CrawlClock,
  type CrawlCommandIO,
  type CrawlDependencies,
  type CrawlRequest,
  type RunCrawlCommandFn,
  type RunReport,
} from '../../contracts/hydration.schema';
import { knownRegionNames, usageMessage } from './config';
import { failedReport, formatPlanLines } from './report';
import { runCrawl } from './run-crawl';
import { createSystemCrawlClock } from './runtime';
import type { ParsedCrawlArgs } from './types';

const INTERNAL_ERROR_MESSAGE = 'Crawl failed: internal error';

const PASSTHROUGH_SEPARATOR = '--';

const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

const FLAG_OPTIONS: readonly string[] = [
  CRAWL_COMMAND_OPTIONS.dryRun,
  CRAWL_COMMAND_OPTIONS.relist,
  CRAWL_COMMAND_OPTIONS.retryParked,
];

const VALUED_OPTIONS: readonly string[] = [
  CRAWL_COMMAND_OPTIONS.region,
  CRAWL_COMMAND_OPTIONS.budget,
  CRAWL_COMMAND_OPTIONS.minInterval,
  CRAWL_COMMAND_OPTIONS.refreshAge,
];

/** `Number(text)` for plain decimals (`2`, `-1`, `1.5`); `NaN` for anything else. */
function toNumber(text: string): number {
  return NUMBER_PATTERN.test(text) ? Number(text) : Number.NaN;
}

/** Turns the command-line arguments into a `CrawlRequest` (keys only for the options given). */
export function parseCrawlArgs(argv: readonly string[]): ParsedCrawlArgs {
  const tokens = argv[0] === PASSTHROUGH_SEPARATOR ? argv.slice(1) : argv;
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (FLAG_OPTIONS.includes(token)) {
      if (flags.has(token)) return { ok: false, problem: `option ${token} given twice` };
      flags.add(token);
    } else if (VALUED_OPTIONS.includes(token)) {
      if (values.has(token)) return { ok: false, problem: `option ${token} given twice` };
      const value = tokens[i + 1];
      if (value === undefined) return { ok: false, problem: `missing value for ${token}` };
      values.set(token, value);
      i += 1;
    } else {
      return { ok: false, problem: `unknown option "${token}"` };
    }
  }

  const regionName = values.get(CRAWL_COMMAND_OPTIONS.region);
  const budget = values.get(CRAWL_COMMAND_OPTIONS.budget);
  const minInterval = values.get(CRAWL_COMMAND_OPTIONS.minInterval);
  const refreshAge = values.get(CRAWL_COMMAND_OPTIONS.refreshAge);
  const request: CrawlRequest = {
    ...(regionName !== undefined ? { regionName } : {}),
    ...(flags.has(CRAWL_COMMAND_OPTIONS.dryRun) ? { dryRun: true } : {}),
    ...(flags.has(CRAWL_COMMAND_OPTIONS.relist) ? { relist: true } : {}),
    ...(flags.has(CRAWL_COMMAND_OPTIONS.retryParked) ? { retryParked: true } : {}),
    ...(budget !== undefined ? { requestBudget: toNumber(budget) } : {}),
    ...(minInterval !== undefined ? { minRequestIntervalSeconds: toNumber(minInterval) } : {}),
    ...(refreshAge !== undefined ? { refreshAgeDays: toNumber(refreshAge) } : {}),
  };
  return { ok: true, request };
}

/** The current moment from the injected clock, or from the real clock when none is injected. */
function momentNow(clock: CrawlClock | undefined, signal: AbortSignal | undefined): string {
  return toMoment((clock ?? createSystemCrawlClock(signal)).now());
}

function dependenciesFrom(io: CrawlCommandIO): CrawlDependencies {
  const apiKey = io.env[API_KEY_ENV];
  return {
    connectionString: io.env[DATABASE_URL_ENV] ?? '',
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(io.transport !== undefined ? { transport: io.transport } : {}),
    ...(io.clock !== undefined ? { clock: io.clock } : {}),
    ...(io.signal !== undefined ? { signal: io.signal } : {}),
    onProgress: io.write,
  };
}

function writeReport(report: RunReport, write: (line: string) => void): void {
  if (report.message !== undefined) write(report.message);
  if (report.outcome === 'planned' && report.plan !== undefined) {
    write(`Region ${report.plan.regionName}: ${String(report.plan.tiles.length)} tiles`);
    for (const line of formatPlanLines(report.plan)) write(line);
  }
  if (report.outcome === 'planned' && report.parkedPlacesInRegion !== undefined) {
    write(
      `Parked places that ${CRAWL_COMMAND_OPTIONS.retryParked} would release: ${String(report.parkedPlacesInRegion)}`,
    );
  }
  for (const line of report.summaryText.split('\n')) write(line);
}

export const runCrawlCommand: RunCrawlCommandFn = async (argv, io) => {
  let now: string | undefined;
  try {
    const parsed = parseCrawlArgs(argv);
    let report: RunReport;
    if (parsed.ok) {
      report = await runCrawl(parsed.request, dependenciesFrom(io));
    } else {
      now = momentNow(io.clock, io.signal);
      report = failedReport(
        `${parsed.problem}. ${usageMessage(knownRegionNames(DEFAULT_CRAWL_CONFIGURATION))}`,
        undefined,
        now,
      );
    }
    writeReport(report, io.write);
    return { exitCode: exitCodeFor(report.outcome), report };
  } catch {
    if (now === undefined) {
      try {
        now = momentNow(io.clock, io.signal);
      } catch {
        now = momentNow(undefined, undefined);
      }
    }
    return {
      exitCode: exitCodeFor('failed'),
      report: failedReport(INTERNAL_ERROR_MESSAGE, undefined, now),
    };
  }
};
