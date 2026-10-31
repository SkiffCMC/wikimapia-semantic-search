/**
 * AL2 unit tests: command-line parsing of the Search Command (`src/search/args.ts`; AL4
 * hybrid-search 1.4.6, U5). Pure: no database, no Embedding Service, no network. Out-of-range
 * values are not usage problems here; Place Search refuses them later (AC-43).
 */
import { parseSearchArgs, usageLine } from '../../src/search/args';
import {
  SEARCH_COMMAND_FORM,
  SEARCH_COMMAND_OPTIONS,
  SEARCH_USAGE_PREFIX,
  SearchRequestDraftSchema,
  isSearchUsageLine,
  type SearchRequestDraft,
} from '../../contracts/hybrid-search.schema';
import { AREA_B } from '../../contracts/hybrid-search.support';

const { near, radius, bbox, tag, limit, approximate } = SEARCH_COMMAND_OPTIONS;
const NEAR_S = [near, '44.817,20.457'];

/** The draft of a well-formed argv; it must also pass the strict draft schema as it is. */
function draftOf(argv: readonly string[]): SearchRequestDraft {
  const parsed = parseSearchArgs(argv);
  if (!parsed.ok) throw new Error(`expected a draft, got the problem "${parsed.problem}"`);
  expect(SearchRequestDraftSchema.safeParse(parsed.draft).success).toBe(true);
  return parsed.draft;
}

describe('AC-41 forms', () => {
  it('`museum --near 44.817,20.457 --radius 500`: latitude first, no other keys', () => {
    const draft = draftOf(['museum', ...NEAR_S, radius, '500']);
    expect(draft).toStrictEqual({
      queryText: 'museum',
      centre: { lat: 44.817, lon: 20.457 },
      radiusMetres: 500,
    });
    for (const key of ['mode', 'limit', 'area', 'tags']) expect(draft).not.toHaveProperty(key);
  });

  it.each<[string, string[], SearchRequestDraft]>([
    ['--bbox south,west,north,east', ['museum', bbox, '44.816,20.456,44.82,20.458'], { queryText: 'museum', area: AREA_B }],
    ['repeated --tag keeps order and text', ['museum', tag, 'museum', tag, ' Hotel '], { queryText: 'museum', tags: ['museum', ' Hotel '] }],
    ['--limit 3', ['museum', limit, '3'], { queryText: 'museum', limit: 3 }],
    ['options before the Query Text', [limit, '3', tag, 'park', 'museum'], { queryText: 'museum', limit: 3, tags: ['park'] }],
    ['one leading -- dropped', ['--', 'museum', limit, '3'], { queryText: 'museum', limit: 3 }],
    ['negative coordinates', ['museum', near, '-33.86,151.2', radius, '10'], { queryText: 'museum', centre: { lat: -33.86, lon: 151.2 }, radiusMetres: 10 }],
    ['spaces around --near parts', ['museum', near, ' 44.817 , 20.457 ', radius, '500'], { queryText: 'museum', centre: { lat: 44.817, lon: 20.457 }, radiusMetres: 500 }],
    ['--approximate', ['museum', approximate], { queryText: 'museum', mode: 'approximate' }],
    ['--approximate twice', [approximate, 'museum', approximate], { queryText: 'museum', mode: 'approximate' }],
  ])('%s', (_, argv, expected) => {
    expect(draftOf(argv)).toStrictEqual(expected);
  });
});

describe('AC-44 usage problems', () => {
  it.each<[string, string[]]>([
    ['no Query Text', [...NEAR_S, radius, '500']],
    ['an unknown option', ['museum', '--fast']],
    ['a value given to --approximate', ['museum', `${approximate}=yes`]],
    ['a second leading --', ['--', '--', 'museum']],
    ['--radius alone', ['museum', radius, '500']],
    ['--near alone', ['museum', ...NEAR_S]],
    ['--near and --bbox', ['museum', ...NEAR_S, radius, '500', bbox, '44.816,20.456,44.82,20.458']],
    ['--limit ten', ['museum', limit, 'ten']],
    ['--limit Infinity', ['museum', limit, 'Infinity']],
    ['--limit NaN', ['museum', limit, 'NaN']],
    ['--radius 1e999', ['museum', ...NEAR_S, radius, '1e999']],
    ['--near abc,20.457', ['museum', near, 'abc,20.457', radius, '500']],
    ['--near with 3 parts', ['museum', near, '1,2,3', radius, '500']],
    ['--bbox with 3 parts', ['museum', bbox, '1,2,3']],
    ['--limit twice', ['museum', limit, '3', limit, '4']],
    ['a valued option without a value', ['museum', limit]],
    ['two Query Texts', ['museum', 'hotel']],
  ])('%s', (_, argv) => {
    const parsed = parseSearchArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.trim()).not.toBe('');
  });

  it('a problem names the option, never the value given', () => {
    const parsed = parseSearchArgs(['museum', near, 'abc,20.457', radius, '500']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).not.toContain('abc');
  });
});

describe('well-formed but out of range: a draft, not a usage problem', () => {
  it.each<[string, string[], SearchRequestDraft]>([
    ['--radius 0', ['museum', ...NEAR_S, radius, '0'], { queryText: 'museum', centre: { lat: 44.817, lon: 20.457 }, radiusMetres: 0 }],
    ['--limit 2.5', ['museum', limit, '2.5'], { queryText: 'museum', limit: 2.5 }],
    ['--limit 51', ['museum', limit, '51'], { queryText: 'museum', limit: 51 }],
    ['--near 91,20', ['museum', near, '91,20', radius, '5'], { queryText: 'museum', centre: { lat: 91, lon: 20 }, radiusMetres: 5 }],
    ['--bbox south >= north', ['museum', bbox, '44.82,20.456,44.816,20.458'], { queryText: 'museum', area: { south: 44.82, west: 20.456, north: 44.816, east: 20.458 } }],
    ['--tag " "', ['museum', tag, ' '], { queryText: 'museum', tags: [' '] }],
    ['an empty Query Text', [''], { queryText: '' }],
  ])('%s', (_, argv, expected) => {
    expect(draftOf(argv)).toStrictEqual(expected);
  });
});

describe('usage line (AL4 1.4.6, revision 4; rule 13, AC-44, AC-72)', () => {
  it('passes isSearchUsageLine', () => {
    expect(isSearchUsageLine(usageLine())).toBe(true);
  });

  it('starts with SEARCH_USAGE_PREFIX and with `Usage: ` + SEARCH_COMMAND_FORM', () => {
    expect(usageLine().startsWith(SEARCH_USAGE_PREFIX)).toBe(true);
    expect(usageLine().startsWith(`Usage: ${SEARCH_COMMAND_FORM}`)).toBe(true);
  });

  it('is the 1.4.6 text: the form, then the option list', () => {
    expect(usageLine()).toBe(
      `Usage: ${SEARCH_COMMAND_FORM} where options are ` +
        `[${near} <lat>,<lon> ${radius} <metres> | ${bbox} <south>,<west>,<north>,<east>] ` +
        `[${tag} <title>]... [${limit} <n>] [${approximate}]`,
    );
  });

  it('never shows the npm registry form, and is one line without trailing whitespace', () => {
    const line = usageLine();
    expect(line).not.toContain('pnpm search ');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).toBe(line.trimEnd());
  });

  it.each<[string, string[]]>([
    ['--fast', ['--fast']],
    ['-- --fast', ['--', '--fast']],
  ])('the AC-72 argv `%s` is a usage problem', (_, argv) => {
    const parsed = parseSearchArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.trim()).not.toBe('');
  });
});
