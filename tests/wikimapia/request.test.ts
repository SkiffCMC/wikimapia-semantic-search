/**
 * AL2 unit tests: `src/wikimapia/request.ts` (AL4 1.3 `request.ts` block, 1.4.3 Request
 * building, section 3 request column; U3; AC-3, AC-4 URL side, AC-5, AC-17).
 *
 * Pure and synchronous: each test builds a URL string and reads it back with `new URL(...)`
 * and `searchParams`, never by substring matching on the raw string. No transport, no clock,
 * no network, no real keys.
 */
import { buildBoxUrl, buildPlaceDetailsUrl } from '../../src/wikimapia/request';
import {
  PLACE_DETAILS_DATA_BLOCKS,
  TransportRequestSchema,
  WIKIMAPIA_API_URL,
  type BoundingBox,
} from '../../contracts/wikimapia-client.schema';
import { TEST_API_KEY } from '../../contracts/wikimapia-client.support';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BBOX: BoundingBox = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 };
const NEGATIVE_BBOX: BoundingBox = { west: -74.02, south: -34.61, east: -73.99, north: -34.58 };
const PLACE_ID = 62587;

const BOX_KEYS = ['function', 'key', 'format', 'bbox', 'page', 'count'] as const;
const DETAILS_KEYS = ['function', 'key', 'format', 'id', 'data_blocks'] as const;
const BOX_KEYS_WITH_LANGUAGE = ['function', 'key', 'format', 'language', 'bbox', 'page', 'count'];
const DETAILS_KEYS_WITH_LANGUAGE = ['function', 'key', 'format', 'language', 'id', 'data_blocks'];

function box(
  overrides: { apiKey?: string; bbox?: BoundingBox; page?: number; pageSize?: number } = {},
): string {
  return buildBoxUrl({
    apiKey: overrides.apiKey ?? TEST_API_KEY,
    bbox: overrides.bbox ?? BBOX,
    page: overrides.page ?? 3,
    pageSize: overrides.pageSize ?? 25,
  });
}

function details(overrides: { apiKey?: string; placeId?: number } = {}): string {
  return buildPlaceDetailsUrl({
    apiKey: overrides.apiKey ?? TEST_API_KEY,
    placeId: overrides.placeId ?? PLACE_ID,
  });
}

function boxWithLanguage(language: string): string {
  return buildBoxUrl({ apiKey: TEST_API_KEY, language, bbox: BBOX, page: 3, pageSize: 25 });
}

function detailsWithLanguage(language: string): string {
  return buildPlaceDetailsUrl({ apiKey: TEST_API_KEY, language, placeId: PLACE_ID });
}

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function paramNames(url: string): string[] {
  return [...params(url).keys()];
}

const BUILDERS: readonly [string, () => string][] = [
  ['buildBoxUrl', () => box()],
  ['buildPlaceDetailsUrl', () => details()],
];

// ---------------------------------------------------------------------------
// 1. Base
// ---------------------------------------------------------------------------

describe('base address (AL4 1.4.3)', () => {
  const base = new URL(WIKIMAPIA_API_URL);

  it.each(BUILDERS)('%s uses the protocol and host of WIKIMAPIA_API_URL', (_name, build) => {
    const url = new URL(build());
    expect(url.protocol).toBe(base.protocol);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(base.host);
    expect(url.hostname).toBe('api.wikimapia.org');
    expect(url.pathname).toBe('/');
  });

  it.each(BUILDERS)('%s returns a string accepted by TransportRequestSchema', (_name, build) => {
    const url = build();
    expect(typeof url).toBe('string');
    expect(TransportRequestSchema.safeParse({ url }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Common parameters
// ---------------------------------------------------------------------------

describe('common parameters (AL4 1.4.3)', () => {
  it('box: function=box, format=json, key is the given key', () => {
    const p = params(box());
    expect(p.get('function')).toBe('box');
    expect(p.get('format')).toBe('json');
    expect(p.get('key')).toBe(TEST_API_KEY);
  });

  it('place.getbyid: function=place.getbyid, format=json, key is the given key', () => {
    const p = params(details());
    expect(p.get('function')).toBe('place.getbyid');
    expect(p.get('format')).toBe('json');
    expect(p.get('key')).toBe(TEST_API_KEY);
  });

  const SPECIAL_KEY = 'a&b=c d+e/?#%';

  it('box: a key with URL-special characters is encoded and reads back unchanged', () => {
    const url = box({ apiKey: SPECIAL_KEY });
    expect(params(url).get('key')).toBe(SPECIAL_KEY);
    expect(paramNames(url)).toStrictEqual([...BOX_KEYS]);
    expect(new URL(url).hash).toBe('');
  });

  it('place.getbyid: a key with URL-special characters is encoded and reads back unchanged', () => {
    const url = details({ apiKey: SPECIAL_KEY });
    expect(params(url).get('key')).toBe(SPECIAL_KEY);
    expect(paramNames(url)).toStrictEqual([...DETAILS_KEYS]);
    expect(new URL(url).hash).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. Parameter order
// ---------------------------------------------------------------------------

describe('parameter order (AL4 1.4.3)', () => {
  it('box without language', () => {
    expect(paramNames(box())).toStrictEqual([...BOX_KEYS]);
  });

  it('place.getbyid without language', () => {
    expect(paramNames(details())).toStrictEqual([...DETAILS_KEYS]);
  });

  it('box with language: language comes right after format', () => {
    expect(paramNames(boxWithLanguage('en'))).toStrictEqual(BOX_KEYS_WITH_LANGUAGE);
  });

  it('place.getbyid with language: language comes right after format', () => {
    expect(paramNames(detailsWithLanguage('en'))).toStrictEqual(DETAILS_KEYS_WITH_LANGUAGE);
  });
});

// ---------------------------------------------------------------------------
// 4. box (AC-3, AC-4 URL side)
// ---------------------------------------------------------------------------

describe('box parameters (AC-3, AC-4)', () => {
  it('bbox is west,south,east,north', () => {
    expect(params(box()).get('bbox')?.split(',').map(Number)).toStrictEqual([
      20.452, 44.814, 20.462, 44.82,
    ]);
  });

  it('bbox keeps negative coordinates in W,S,E,N order', () => {
    expect(
      params(box({ bbox: NEGATIVE_BBOX }))
        .get('bbox')
        ?.split(',')
        .map(Number),
    ).toStrictEqual([-74.02, -34.61, -73.99, -34.58]);
  });

  it('page and count are the decimal strings of page and pageSize', () => {
    const p = params(box({ page: 3, pageSize: 25 }));
    expect(p.get('page')).toBe('3');
    expect(p.get('count')).toBe('25');
  });

  it('count is "100" for pageSize 100 (the AC-4 value)', () => {
    const p = params(box({ page: 1, pageSize: 100 }));
    expect(p.get('page')).toBe('1');
    expect(p.get('count')).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// 5. place.getbyid (AC-17)
// ---------------------------------------------------------------------------

describe('place.getbyid parameters (AC-17)', () => {
  it('id is the decimal string of placeId', () => {
    expect(params(details()).get('id')).toBe('62587');
    expect(params(details({ placeId: 1381893 })).get('id')).toBe('1381893');
  });

  it('data_blocks lists exactly PLACE_DETAILS_DATA_BLOCKS', () => {
    expect(params(details()).get('data_blocks')?.split(',').sort()).toStrictEqual(
      [...PLACE_DETAILS_DATA_BLOCKS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Language (AC-5)
// ---------------------------------------------------------------------------

describe('language (AC-5)', () => {
  it('box: language=en when given', () => {
    expect(params(boxWithLanguage('en')).get('language')).toBe('en');
  });

  it('place.getbyid: language=en when given', () => {
    expect(params(detailsWithLanguage('en')).get('language')).toBe('en');
  });

  it.each(BUILDERS)('%s: no language parameter when none is given', (_name, build) => {
    expect(params(build()).has('language')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. No extras
// ---------------------------------------------------------------------------

describe('no extra parameters (AL4 1.4.3)', () => {
  const ALL: readonly [string, () => string, readonly string[]][] = [
    ['box', () => box(), BOX_KEYS],
    ['place.getbyid', () => details(), DETAILS_KEYS],
    ['box + language', () => boxWithLanguage('en'), BOX_KEYS_WITH_LANGUAGE],
    ['place.getbyid + language', () => detailsWithLanguage('en'), DETAILS_KEYS_WITH_LANGUAGE],
  ];

  it.each(ALL)('%s: no pack parameter and only the listed names', (_name, build, expected) => {
    const p = params(build());
    expect(p.has('pack')).toBe(false);
    expect([...new Set(p.keys())].sort()).toStrictEqual([...expected].sort());
    expect([...p.keys()]).toHaveLength(expected.length);
  });
});

// ---------------------------------------------------------------------------
// 8. Determinism (AC-22 prerequisite)
// ---------------------------------------------------------------------------

describe('determinism (AC-22 prerequisite)', () => {
  it('box: two builds with the same arguments give identical strings', () => {
    expect(box()).toBe(box());
    expect(boxWithLanguage('en')).toBe(boxWithLanguage('en'));
  });

  it('place.getbyid: two builds with the same arguments give identical strings', () => {
    expect(details()).toBe(details());
    expect(detailsWithLanguage('en')).toBe(detailsWithLanguage('en'));
  });
});
