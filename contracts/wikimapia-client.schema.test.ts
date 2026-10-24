/**
 * AL5 CONTRACT TESTS: Wikimapia API client (custom validators and fixtures).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261020-wikimapia-client-al6.md (AC-39, AC-40, AC-41, AC-50,
 *           plus the custom refinements and validators behind AC-7, AC-11, AC-45, rule 5 and
 *           rule 8). Plain Zod rules (types, ranges, strict objects) are exercised through the
 *           client in ./wikimapia-client.test.ts, not re-checked here.
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (recorded fixtures with
 *           Wikimapia attribution, no API key, no Commenter IPs).
 */
import {
  BoundingBoxSchema,
  PlaceSummarySchema,
  RawDebugResponseSchema,
  findCommenterIpPaths,
  isWikimapiaPlaceUrl,
  parseRateLimitMessage,
} from './wikimapia-client.schema';
import { FIXTURE_NAMES, at, fixtureText, rawBox, rawDetails } from './wikimapia-client.support';

const BELGRADE = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 };

/** The README section that lists reconstructed fixtures. */
function reconstructedSection(): string {
  const readme = fixtureText('README.md');
  const start = readme.indexOf('## Reconstructed fixtures');
  expect(start).toBeGreaterThan(-1);
  return readme.slice(start);
}

describe('Custom refinements and validators (pass before AL2)', () => {
  it.each([
    ['central Belgrade', BELGRADE, true],
    ['west equals east', { ...BELGRADE, east: BELGRADE.west }, false],
    ['south greater than north', { ...BELGRADE, south: 45, north: 44 }, false],
  ])('BoundingBox ordering refinement (AC-7): %s', (_, bbox, valid) => {
    expect(BoundingBoxSchema.safeParse(bbox).success).toBe(valid);
  });

  it.each([
    ['http://wikimapia.org/1381893/University-Park', 1381893, true],
    ['https://wikimapia.org/1381893/ru/University-Park', 1381893, true],
    ['http://wikimapia.org/13818930/x', 1381893, false],
    ['http://example.org/1381893/x', 1381893, false],
  ])('isWikimapiaPlaceUrl(%s, %i) is %s (rule 8)', (url, placeId, expected) => {
    expect(isWikimapiaPlaceUrl(url, placeId)).toBe(expected);
  });

  it('PlaceSummary rejects a link to another place (rule 8)', () => {
    const summary = {
      placeId: 62587,
      name: 'Square of the Republic',
      url: 'http://wikimapia.org/1381893/University-Park',
      location: { lon: 20.46, lat: 44.81, north: 44.82, south: 44.81, east: 20.47, west: 20.45 },
      outline: [],
    };
    expect(PlaceSummarySchema.safeParse(summary).success).toBe(false);
  });

  it.each([
    [
      'You have reached the limit for this action. You need to wait for 7 seconds.',
      { isRateLimit: true, waitSeconds: 7 },
    ],
    [
      'You have reached the limit for this action. You need to wait for 0 seconds.',
      { isRateLimit: true, waitSeconds: 0 },
    ],
    [
      'You have reached the limit for this action. You need to wait for a few seconds.',
      { isRateLimit: true },
    ],
    ['You need to wait for 7.5 seconds.', { isRateLimit: true }],
    ['Invalid API key.', { isRateLimit: false }],
  ])('parseRateLimitMessage(%j) (rule 5)', (message, expected) => {
    expect(parseRateLimitMessage(message)).toStrictEqual(expected);
  });

  it.each([
    [{ comments: [{ replies: [{ user_ip: 1 }] }] }, ['$.comments[0].replies[0].user_ip']],
    [{ a: [{ userIp: 1 }] }, ['$.a[0].userIp']],
    [{ comments: [{ name: 'Mateja', replies: [] }] }, []],
  ])('findCommenterIpPaths(%j) finds IP keys at any depth (AC-11, AC-45)', (value, expected) => {
    expect(findCommenterIpPaths(value)).toStrictEqual(expected);
  });
});

describe('AC-39 Recorded fixtures', () => {
  it('the box page is trimmed, keeps University Park and Total Found "290"', () => {
    const box = rawBox('box-belgrade-page1.json');
    expect(box.found).toBe('290');
    expect(box.folder.length).toBeGreaterThan(0);
    expect(box.folder.length).toBeLessThan(10);
    expect(box.folder.map((p) => p.name)).toContain('University Park');
  });

  it('the getbyid fixtures parse with the wire schema; place 55 keeps a few comments', () => {
    expect(rawDetails('getbyid-62587.json').comments).toHaveLength(2);
    expect(rawDetails('getbyid-1381893.json').comments).toHaveLength(0);
    const eiffel = rawDetails('getbyid-55.json');
    expect(eiffel.comments.length).toBeGreaterThanOrEqual(2);
    expect(eiffel.comments.length).toBeLessThanOrEqual(5);
    expect(eiffel.comments.map((c) => c.name)).toContain('Paul');
  });

  it.each(FIXTURE_NAMES)('%s contains no Commenter IP and no API key', (name) => {
    const text = fixtureText(name);
    expect(findCommenterIpPaths(JSON.parse(text))).toStrictEqual([]);
    expect(text).not.toMatch(/user_ip/i);
    expect(text).not.toMatch(/[?&]key=/);
    expect(text).not.toMatch(/api[_-]?key"\s*:/i);
  });

  it('the README credits Wikimapia under CC BY-NC-SA 3.0', () => {
    const readme = fixtureText('README.md');
    expect(readme).toContain('Wikimapia');
    expect(readme).toContain('CC BY-NC-SA 3.0');
  });
});

describe('AC-40 Rate-Limit fixture', () => {
  it('is the body quoted in CLAUDE.md, with N = 7', () => {
    const body = RawDebugResponseSchema.parse(JSON.parse(fixtureText('debug-rate-limit.json')));
    expect(body.debug.message).toBe(
      'You have reached the limit for this action. You need to wait for 7 seconds.',
    );
  });

  it('is marked in the README as reconstructed from documentation', () => {
    const section = reconstructedSection();
    expect(section).toContain('debug-rate-limit.json');
    expect(section).toMatch(/Documentation only/);
  });
});

describe('AC-41 Other Reconstructed Fixtures', () => {
  it('the non-rate-limit error uses the debug message form and is not a rate limit', () => {
    const body = RawDebugResponseSchema.parse(JSON.parse(fixtureText('debug-error.json')));
    expect(parseRateLimitMessage(body.debug.message).isRateLimit).toBe(false);
  });

  it('the empty box page differs from the recorded page only by its emptied list and page number', () => {
    const page = rawBox('box-belgrade-page1.json');
    const empty = rawBox('box-belgrade-empty-page.json');
    expect(empty.folder).toStrictEqual([]);
    expect({ ...empty, folder: page.folder, page: page.page }).toStrictEqual(page);
  });

  it.each([
    'debug-error.json',
    'box-belgrade-empty-page.json',
    'Deleted place',
    'Deleted / blocked comment',
    'Non-zero parent',
    'Wrong shape',
  ])('README marks "%s" as reconstructed', (entry) => {
    expect(reconstructedSection()).toContain(entry);
  });
});

describe('AC-50 Nested-replies fixture', () => {
  it('nests recorded Serbia under Mateja and recorded place-55 Paul under Serbia, nothing else changed', () => {
    const base = rawDetails('getbyid-62587.json');
    const mateja = at(base.comments, 0);
    const serbia = at(base.comments, 1);
    const paul = rawDetails('getbyid-55.json').comments.find((c) => c.name === 'Paul');
    expect(paul).toBeDefined();
    const expected = {
      ...base,
      comments: [{ ...mateja, replies: [{ ...serbia, replies: [paul] }] }],
    };
    expect(rawDetails('getbyid-62587-nested-replies.json')).toStrictEqual(expected);
  });

  it('is marked in the README as reconstructed', () => {
    expect(reconstructedSection()).toContain('getbyid-62587-nested-replies.json');
  });
});
