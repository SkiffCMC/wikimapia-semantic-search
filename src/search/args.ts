/**
 * Command-line parsing of the Search Command (AL4 hybrid-search 1.4.6; AC-41, AC-44, AC-71).
 * Pure. Turns argv into a `SearchRequestDraft`, or a usage problem that names options only and
 * never echoes a value. Well-formed but out-of-range values are not problems: Place Search
 * refuses them later (AC-43).
 */
import { SEARCH_COMMAND_FORM, SEARCH_COMMAND_OPTIONS } from '../../contracts/hybrid-search.schema';
import type { SearchRequestDraft } from '../../contracts/hybrid-search.schema';
import type { ParsedSearchArgs } from './types';

const PASSTHROUGH_SEPARATOR = '--';
const OPTION_PREFIX = '--';

const { near, radius, bbox, tag, limit, approximate } = SEARCH_COMMAND_OPTIONS;

/** Options that take the next token as their value (even when it starts with `-`). */
const VALUED_OPTIONS: readonly string[] = [near, radius, bbox, limit, tag];

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The finite number written as `text`, or undefined when `text` is not such a number. */
function finiteNumber(text: string): number | undefined {
  if (!NUMBER_PATTERN.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** `text` split on `,` into exactly `count` trimmed finite numbers, or undefined. */
function numberList(text: string, count: number): number[] | undefined {
  const parts = text.split(',');
  if (parts.length !== count) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    const value = finiteNumber(part.trim());
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function problem(text: string): ParsedSearchArgs {
  return { ok: false, problem: text };
}

function needsNumber(option: string): ParsedSearchArgs {
  return problem(`${option} needs a number`);
}

/** Turns the command-line arguments into a Search Request draft (keys only when given). */
export function parseSearchArgs(argv: readonly string[]): ParsedSearchArgs {
  const tokens = argv[0] === PASSTHROUGH_SEPARATOR ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  const tags: string[] = [];
  let queryText: string | undefined;
  let isApproximate = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (VALUED_OPTIONS.includes(token)) {
      const value = tokens[i + 1];
      if (value === undefined) return problem(`missing value for ${token}`);
      i += 1;
      if (token === tag) {
        tags.push(value);
      } else if (values.has(token)) {
        return problem(`option ${token} given twice`);
      } else {
        values.set(token, value);
      }
    } else if (token === approximate) {
      isApproximate = true;
    } else if (token.startsWith(OPTION_PREFIX)) {
      return problem(`unknown option "${token}"`);
    } else if (queryText !== undefined) {
      return problem('more than one query text');
    } else {
      queryText = token;
    }
  }

  if (queryText === undefined) return problem('missing query text');

  const nearText = values.get(near);
  const radiusText = values.get(radius);
  const bboxText = values.get(bbox);
  const limitText = values.get(limit);

  if (nearText !== undefined && bboxText !== undefined) {
    return problem(`give either ${near} with ${radius}, or ${bbox}, not both`);
  }
  if (radiusText !== undefined && nearText === undefined) {
    return problem(`${radius} needs ${near}`);
  }
  if (nearText !== undefined && radiusText === undefined) {
    return problem(`${near} needs ${radius}`);
  }

  let centre: SearchRequestDraft['centre'];
  if (nearText !== undefined) {
    const parts = numberList(nearText, 2);
    const [lat, lon] = parts ?? [];
    if (lat === undefined || lon === undefined) return needsNumber(near);
    centre = { lat, lon };
  }

  let radiusMetres: number | undefined;
  if (radiusText !== undefined) {
    radiusMetres = finiteNumber(radiusText);
    if (radiusMetres === undefined) return needsNumber(radius);
  }

  let area: SearchRequestDraft['area'];
  if (bboxText !== undefined) {
    const parts = numberList(bboxText, 4);
    const [south, west, north, east] = parts ?? [];
    if (south === undefined || west === undefined || north === undefined || east === undefined) {
      return needsNumber(bbox);
    }
    area = { south, west, north, east };
  }

  let resultLimit: number | undefined;
  if (limitText !== undefined) {
    resultLimit = finiteNumber(limitText);
    if (resultLimit === undefined) return needsNumber(limit);
  }

  const draft: SearchRequestDraft = {
    queryText,
    ...(centre !== undefined ? { centre } : {}),
    ...(radiusMetres !== undefined ? { radiusMetres } : {}),
    ...(area !== undefined ? { area } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(resultLimit !== undefined ? { limit: resultLimit } : {}),
    ...(isApproximate ? { mode: 'approximate' as const } : {}),
  };
  return { ok: true, draft };
}

/**
 * The usage line printed after a usage problem (rule 13, AC-44, AC-72). It passes
 * `isSearchUsageLine`: it starts with `Usage: ` followed by SEARCH_COMMAND_FORM
 * (`pnpm run search "<Query Text>" [options]`), then the option list. One line, no trailing
 * whitespace.
 */
export function usageLine(): string {
  return (
    `Usage: ${SEARCH_COMMAND_FORM} where options are ` +
    `[${near} <lat>,<lon> ${radius} <metres> | ${bbox} <south>,<west>,<north>,<east>] ` +
    `[${tag} <title>]... [${limit} <n>] [${approximate}]`
  );
}
