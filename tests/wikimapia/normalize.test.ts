/**
 * AL2 unit tests: `src/wikimapia/normalize.ts` (AL4 1.4.6). Only what the AL5 contract tests
 * (`contracts/wikimapia-client.test.ts`) do not reach: the semantic checks, optional location
 * fields left out, and missing or null Tags (crawl-run1-fixes AL4 1.4.1). Field mapping, replies,
 * the allow-list and Commenter IP removal are contract-tested.
 */
import { normalizeListingPage, normalizePlaceDetails } from '../../src/wikimapia/normalize';
import type { RawBoxResponse, RawPlaceDetails } from '../../contracts/wikimapia-client.schema';
import { at, rawBox, rawDetails } from '../../contracts/wikimapia-client.support';

/** A digit string above Number.MAX_SAFE_INTEGER (passes the raw digit regexes). */
const UNSAFE = '9007199254740993';
const UNSAFE_ID = 'id is not a safe whole number';

describe('normalizeListingPage semantic checks', () => {
  it.each<[string, (raw: RawBoxResponse) => void, { path: (string | number)[]; message: string }]>([
    [
      'page 0',
      (raw) => {
        raw.page = '0';
      },
      { path: ['page'], message: 'page must be at least 1' },
    ],
    [
      'count 101',
      (raw) => {
        raw.count = 101;
      },
      { path: ['count'], message: 'count must be between 1 and 100' },
    ],
    [
      'unsafe found',
      (raw) => {
        raw.found = UNSAFE;
      },
      { path: ['found'], message: 'found is not a safe whole number' },
    ],
    [
      'unsafe place id',
      (raw) => {
        at(raw.folder, 0).id = UNSAFE;
      },
      { path: ['folder', 0, 'id'], message: UNSAFE_ID },
    ],
    [
      'url of another place',
      (raw) => {
        at(raw.folder, 2).url = 'http://wikimapia.org/55/Eiffel-Tower';
      },
      { path: ['folder', 2, 'url'], message: 'url is not the Wikimapia page link of this place' },
    ],
  ])('%s fails with that issue and no value', (_, change, issue) => {
    const raw = rawBox('box-belgrade-page1.json');
    change(raw);
    const result = normalizeListingPage(raw);
    expect(result).not.toHaveProperty('value');
    expect(result.ok ? [] : result.issues).toContainEqual(issue);
  });
});

it.each(['id', 'parent_id'] as const)('normalizePlaceDetails: unsafe %s fails', (field) => {
  const raw = rawDetails('getbyid-62587.json');
  raw[field] = UNSAFE;
  expect(normalizePlaceDetails(raw)).toStrictEqual({
    ok: false,
    issues: [{ path: [field], message: UNSAFE_ID }],
  });
});

it('absent, null or empty city, place, state and country give no location key', () => {
  const raw = rawDetails('getbyid-55.json');
  raw.location.city = null;
  raw.location.place = '';
  Reflect.deleteProperty(raw.location, 'state');
  Reflect.deleteProperty(raw.location, 'country');
  const result = normalizePlaceDetails(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(Object.keys(result.value.location).sort()).toStrictEqual([
    'east',
    'houseNumber',
    'lat',
    'lon',
    'north',
    'south',
    'street',
    'west',
  ]);
});

it.each<[string, (raw: RawPlaceDetails) => void]>([
  ['missing (as recorded)', () => undefined],
  [
    'null',
    (raw) => {
      raw.tags = null;
    },
  ],
])('Tags %s read as an empty list (crawl-run1-fixes)', (_, change) => {
  const raw = rawDetails('getbyid-8918979-no-tags.json');
  change(raw);
  const result = normalizePlaceDetails(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(result.value.tags).toStrictEqual([]);
});
