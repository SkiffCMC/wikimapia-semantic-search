/**
 * The Search Command (AL4 hybrid-search 1.4.7; AC-41 .. AC-45, AC-71): parses the command line,
 * runs `searchPlaces`, writes the output lines and maps the outcome to the exit code. Never
 * rejects. Reads the Voyage key and the database URL only from `io.env` and never prints them.
 * No SQL, no network of its own.
 */
import {
  DATABASE_URL_ENV,
  VOYAGE_API_KEY_ENV,
  effectiveMode,
} from '../../contracts/hybrid-search.schema';
import type {
  RunSearchCommandFn,
  SearchCommandIO,
  SearchDependencies,
} from '../../contracts/hybrid-search.schema';
import { parseSearchArgs, usageLine } from './args';
import { outcomeLines } from './output';
import { searchPlaces } from './search-places';

const FAILURE_PREFIX = 'Search failed: ';
const INTERNAL_ERROR_LINE = `${FAILURE_PREFIX}internal error`;

function dependenciesFrom(io: SearchCommandIO): SearchDependencies {
  const apiKey = io.env[VOYAGE_API_KEY_ENV];
  return {
    connectionString: io.env[DATABASE_URL_ENV] ?? '',
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(io.embeddingService !== undefined ? { embeddingService: io.embeddingService } : {}),
  };
}

/** The Search Command. Resolves with the exit code (and the request and outcome of a search). */
export const runSearchCommand: RunSearchCommandFn = async (argv, io) => {
  try {
    const parsed = parseSearchArgs(argv);
    if (!parsed.ok) {
      io.write(`${FAILURE_PREFIX}${parsed.problem}`);
      io.write(usageLine());
      return { exitCode: 1 };
    }
    const outcome = await searchPlaces(parsed.draft, dependenciesFrom(io));
    for (const line of outcomeLines(effectiveMode(parsed.draft), outcome)) io.write(line);
    return { exitCode: outcome.ok ? 0 : 1, request: parsed.draft, outcome };
  } catch {
    try {
      io.write(INTERNAL_ERROR_LINE);
    } catch {
      // Best effort: a failing output must not make the command reject.
    }
    return { exitCode: 1 };
  }
};
