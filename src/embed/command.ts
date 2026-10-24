/**
 * The Embed Command (AL4 embeddings 1.4.10; AC-40, AC-41, AC-49 .. AC-51; U7): parses the
 * command line into an `EmbeddingRunRequest`, runs `runEmbedding`, writes the output lines
 * (failure message, then the plain-text Run Summary) and maps the Run Outcome to the exit code.
 * Never rejects. Reads only the Voyage key and the database URL from `io.env` and hands them to
 * `runEmbedding` unprinted. No SQL, no network of its own.
 */
import {
  DATABASE_URL_ENV,
  EMBED_COMMAND_OPTIONS,
  VOYAGE_API_KEY_ENV,
  embedExitCodeFor,
  type EmbedCommandIO,
  type EmbeddingClock,
  type EmbeddingDependencies,
  type EmbeddingRunReport,
  type EmbeddingRunRequest,
  type RunEmbedCommandFn,
} from '../../contracts/embeddings.schema';
import { toMoment } from '../../contracts/hydration.schema';
import { createSystemCrawlClock } from '../crawl/runtime';
import { failedReport } from './report';
import { runEmbedding } from './run-embedding';
import { usageMessage } from './settings';
import type { ParsedEmbedArgs } from './types';

const INTERNAL_ERROR_MESSAGE = 'Embedding run failed: internal error';

const PASSTHROUGH_SEPARATOR = '--';

const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** `Number(text)` for plain decimals (`2`, `-1`, `1.5`); `NaN` for anything else. */
function toNumber(text: string): number {
  return NUMBER_PATTERN.test(text) ? Number(text) : Number.NaN;
}

/** Turns the command-line arguments into an `EmbeddingRunRequest` (key only when given). */
export function parseEmbedArgs(argv: readonly string[]): ParsedEmbedArgs {
  const tokens = argv[0] === PASSTHROUGH_SEPARATOR ? argv.slice(1) : argv;
  const limitOption = EMBED_COMMAND_OPTIONS.limit;
  let limit: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === limitOption) {
      if (limit !== undefined) return { ok: false, problem: `option ${token} given twice` };
      const value = tokens[i + 1];
      if (value === undefined) return { ok: false, problem: `missing value for ${token}` };
      limit = value;
      i += 1;
    } else {
      return { ok: false, problem: `unknown option "${token}"` };
    }
  }

  const request: EmbeddingRunRequest = {
    ...(limit !== undefined ? { embeddingLimit: toNumber(limit) } : {}),
  };
  return { ok: true, request };
}

/** The current moment from the injected clock, or from the real clock when none is injected. */
function momentNow(clock: EmbeddingClock | undefined, signal: AbortSignal | undefined): string {
  return toMoment((clock ?? createSystemCrawlClock(signal)).now());
}

function dependenciesFrom(io: EmbedCommandIO): EmbeddingDependencies {
  const apiKey = io.env[VOYAGE_API_KEY_ENV];
  return {
    connectionString: io.env[DATABASE_URL_ENV] ?? '',
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(io.embeddingService !== undefined ? { embeddingService: io.embeddingService } : {}),
    ...(io.clock !== undefined ? { clock: io.clock } : {}),
    ...(io.signal !== undefined ? { signal: io.signal } : {}),
    onProgress: io.write,
  };
}

function writeReport(report: EmbeddingRunReport, write: (line: string) => void): void {
  if (report.message !== undefined) write(report.message);
  for (const line of report.summaryText.split('\n')) write(line);
}

export const runEmbedCommand: RunEmbedCommandFn = async (argv, io) => {
  let now: string | undefined;
  try {
    const parsed = parseEmbedArgs(argv);
    let report: EmbeddingRunReport;
    if (parsed.ok) {
      report = await runEmbedding(parsed.request, dependenciesFrom(io));
    } else {
      now = momentNow(io.clock, io.signal);
      report = failedReport(`${parsed.problem}. ${usageMessage()}`, now, now);
    }
    writeReport(report, io.write);
    return { exitCode: embedExitCodeFor(report.outcome), report };
  } catch {
    if (now === undefined) {
      try {
        now = momentNow(io.clock, io.signal);
      } catch {
        now = momentNow(undefined, undefined);
      }
    }
    return {
      exitCode: embedExitCodeFor('failed'),
      report: failedReport(INTERNAL_ERROR_MESSAGE, now, now),
    };
  }
};
