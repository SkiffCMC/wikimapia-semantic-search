/**
 * Output lines of the Search Command (AL4 hybrid-search 1.4.7; AC-42, AC-43, AC-71). Pure.
 * Every line text comes from the contract's constants and line builders.
 */
import {
  ATTRIBUTION_LINE,
  MODE_LINES,
  NO_RESULTS_LINE,
  SEARCH_FAILURE_LABELS,
  SEARCH_OPTION_FOR_PARAMETER,
  SEARCH_PARAMETERS,
  resultCountLine,
  searchResultBlock,
} from '../../contracts/hybrid-search.schema';
import type {
  SearchFailure,
  SearchMode,
  SearchOutcome,
} from '../../contracts/hybrid-search.schema';

const FAILURE_PREFIX = 'Search failed: ';

/** The command option a parameter is reported under; the parameter itself when unknown. */
function optionFor(parameter: string): string {
  if (parameter === SEARCH_PARAMETERS.request) return parameter;
  if (!Object.hasOwn(SEARCH_OPTION_FOR_PARAMETER, parameter)) return parameter;
  return (SEARCH_OPTION_FOR_PARAMETER as Readonly<Record<string, string>>)[parameter] ?? parameter;
}

/** The one line of a Search Failure: `Search failed: <label>: [<option>: ]<message>`. */
export function failureLine(failure: SearchFailure): string {
  const label = SEARCH_FAILURE_LABELS[failure.kind];
  if (failure.kind === 'invalid_request') {
    return `${FAILURE_PREFIX}${label}: ${optionFor(failure.parameter)}: ${failure.message}`;
  }
  return `${FAILURE_PREFIX}${label}: ${failure.message}`;
}

/** Every output line of a Search Outcome, in the AC-42 layout. */
export function outcomeLines(mode: SearchMode, outcome: SearchOutcome): string[] {
  if (!outcome.ok) return [failureLine(outcome.failure)];
  const { results } = outcome;
  if (results.length === 0) return [MODE_LINES[mode], NO_RESULTS_LINE, ATTRIBUTION_LINE];
  return [
    MODE_LINES[mode],
    ...results.flatMap((result, i) => searchResultBlock(i + 1, result)),
    resultCountLine(results.length),
    ATTRIBUTION_LINE,
  ];
}
