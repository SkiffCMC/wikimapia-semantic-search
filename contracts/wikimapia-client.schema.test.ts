/**
 * AL5 CONTRACT TESTS: Wikimapia API client (schemas, validators and fixtures).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261020-wikimapia-client-al6.md (AC-39, AC-40, AC-41, AC-50,
 *           plus the boundary invariants behind AC-7, AC-8, AC-11, AC-16, AC-18, AC-35, AC-45)
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (recorded fixtures with
 *           Wikimapia attribution, no API key, no Commenter IPs).
 */
import {
  BoundingBoxSchema,
  ClientConfigSchema,
  ClientFailureSchema,
  CommentSchema,
  ListPlacesInputSchema,
  ListPlacesResultSchema,
  PlaceDetailsInputSchema,
  PlaceDetailsSchema,
  PlaceSummarySchema,
  RawDebugResponseSchema,
  WIKIMAPIA_API_URL,
  findCommenterIpPaths,
  isWikimapiaPlaceUrl,
  parseRateLimitMessage,
  type Comment,
  type PlaceDetails,
} from './wikimapia-client.schema.js';
import { FIXTURE_NAMES, at, fixtureText, rawBox, rawDetails } from './wikimapia-client.support.js';

const BELGRADE = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 };

const COMMENT: Comment = {
  placeId: 62587,
  num: 1,
  langId: 0,
  author: 'Mateja',
  authorUserId: 0,
  message: 'Everybodey is waiting for someone here',
  goodVotes: 5,
  badVotes: 15,
  isBlocked: false,
  isDeleted: false,
  postedAtEpochSeconds: 1169755601,
  moderatorUserId: 0,
  replies: [],
};

const DETAILS: PlaceDetails = {
  placeId: 1381893,
  title: 'University Park',
  description: 'Belgrade,Serbia.',
  tags: [{ id: 194, title: 'park' }],
  isBuilding: false,
  isRegion: false,
  isDeleted: false,
  outline: [{ lon: 20.456688, lat: 44.8198 }],
  location: {
    lon: 20.457876,
    lat: 44.819524,
    north: 44.820321,
    south: 44.818727,
    east: 20.459064,
    west: 20.456688,
  },
  comments: [COMMENT],
};

/** The README section that lists reconstructed fixtures. */
function reconstructedSection(): string {
  const readme = fixtureText('README.md');
  const start = readme.indexOf('## Reconstructed fixtures');
  expect(start).toBeGreaterThan(-1);
  return readme.slice(start);
}

describe('Schemas and validators (pass before AL2)', () => {
  it('the Wikimapia API base address uses HTTPS on api.wikimapia.org (API key encrypted)', () => {
    const base = new URL(WIKIMAPIA_API_URL);
    expect(base.protocol).toBe('https:');
    expect(base.hostname).toBe('api.wikimapia.org');
  });

  it('BoundingBox accepts central Belgrade and rejects the AC-7 cases', () => {
    expect(BoundingBoxSchema.safeParse(BELGRADE).success).toBe(true);
    for (const bad of [
      { ...BELGRADE, east: BELGRADE.west },
      { ...BELGRADE, north: BELGRADE.south },
      { ...BELGRADE, east: 181 },
      { ...BELGRADE, west: -180.1 },
      { ...BELGRADE, north: 90.1 },
      { ...BELGRADE, south: -90.1 },
      { ...BELGRADE, west: Number.NaN },
    ]) {
      expect(BoundingBoxSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('ListPlacesInput enforces whole page >= 1 and page size 1..100 (AC-8)', () => {
    expect(ListPlacesInputSchema.safeParse({ bbox: BELGRADE, page: 1 }).success).toBe(true);
    expect(
      ListPlacesInputSchema.safeParse({ bbox: BELGRADE, page: 2, pageSize: 100 }).success,
    ).toBe(true);
    for (const paging of [
      { page: 0 },
      { page: 1.5 },
      { page: 1, pageSize: 0 },
      { page: 1, pageSize: 101 },
      { page: 1, pageSize: 2.5 },
    ]) {
      expect(ListPlacesInputSchema.safeParse({ bbox: BELGRADE, ...paging }).success).toBe(false);
    }
  });

  it('PlaceDetailsInput requires a positive whole Place ID (AC-18)', () => {
    expect(PlaceDetailsInputSchema.safeParse({ placeId: 62587 }).success).toBe(true);
    for (const placeId of [0, -1, 1.5, Number.NaN]) {
      expect(PlaceDetailsInputSchema.safeParse({ placeId }).success).toBe(false);
    }
  });

  it('ClientConfig rejects a missing or empty API key (AC-31)', () => {
    expect(ClientConfigSchema.safeParse({ apiKey: 'k' }).success).toBe(true);
    expect(ClientConfigSchema.safeParse({ apiKey: '' }).success).toBe(false);
    expect(ClientConfigSchema.safeParse({}).success).toBe(false);
    expect(ClientConfigSchema.safeParse({ apiKey: 'k', language: 'eng' }).success).toBe(false);
  });

  it('Comment has no Commenter IP field at any depth (AC-11, AC-45)', () => {
    expect(CommentSchema.safeParse(COMMENT).success).toBe(true);
    expect(CommentSchema.safeParse({ ...COMMENT, user_ip: 1 }).success).toBe(false);
    expect(CommentSchema.safeParse({ ...COMMENT, userIp: 1 }).success).toBe(false);
    const nested = {
      ...COMMENT,
      replies: [{ ...COMMENT, replies: [{ ...COMMENT, user_ip: -5 }] }],
    };
    expect(CommentSchema.safeParse(nested).success).toBe(false);
  });

  it('Comment and PlaceDetails reject empty or undefined placeholders for optional items (AC-13)', () => {
    expect(CommentSchema.safeParse({ ...COMMENT, moderatorName: null }).success).toBe(false);
    expect(CommentSchema.safeParse({ ...COMMENT, authorPhotoUrl: '' }).success).toBe(false);
    expect(PlaceDetailsSchema.safeParse(DETAILS).success).toBe(true);
    expect(PlaceDetailsSchema.safeParse({ ...DETAILS, wikipediaUrl: '' }).success).toBe(false);
    expect(PlaceDetailsSchema.safeParse({ ...DETAILS, wikipediaUrl: undefined }).success).toBe(
      false,
    );
    expect(PlaceDetailsSchema.safeParse({ ...DETAILS, parentPlaceId: 0 }).success).toBe(false);
    expect(
      PlaceDetailsSchema.safeParse({ ...DETAILS, location: { ...DETAILS.location, street: '' } })
        .success,
    ).toBe(false);
  });

  it('PlaceDetails rejects unlisted items such as urlhtml (AC-16)', () => {
    expect(PlaceDetailsSchema.safeParse({ ...DETAILS, urlhtml: '<a></a>' }).success).toBe(false);
  });

  it('Place Summary link must point at its own Wikimapia page', () => {
    expect(isWikimapiaPlaceUrl('http://wikimapia.org/1381893/University-Park', 1381893)).toBe(true);
    expect(isWikimapiaPlaceUrl('https://wikimapia.org/1381893/ru/University-Park', 1381893)).toBe(
      true,
    );
    expect(isWikimapiaPlaceUrl('http://wikimapia.org/13818930/x', 1381893)).toBe(false);
    expect(isWikimapiaPlaceUrl('http://example.org/1381893/x', 1381893)).toBe(false);
    const summary = {
      placeId: 62587,
      name: 'Square of the Republic',
      url: 'http://wikimapia.org/1381893/University-Park',
      location: DETAILS.location,
      outline: [],
    };
    expect(PlaceSummarySchema.safeParse(summary).success).toBe(false);
  });

  it('parseRateLimitMessage recognises the documented body and other messages (rule 5)', () => {
    expect(
      parseRateLimitMessage(
        'You have reached the limit for this action. You need to wait for 7 seconds.',
      ),
    ).toStrictEqual({ isRateLimit: true, waitSeconds: 7 });
    expect(
      parseRateLimitMessage(
        'You have reached the limit for this action. You need to wait for 0 seconds.',
      ),
    ).toStrictEqual({ isRateLimit: true, waitSeconds: 0 });
    expect(
      parseRateLimitMessage(
        'You have reached the limit for this action. You need to wait for a few seconds.',
      ),
    ).toStrictEqual({ isRateLimit: true });
    expect(parseRateLimitMessage('You need to wait for 7.5 seconds.')).toStrictEqual({
      isRateLimit: true,
    });
    expect(parseRateLimitMessage('Invalid API key.')).toStrictEqual({ isRateLimit: false });
  });

  it('findCommenterIpPaths finds IP keys at any depth', () => {
    expect(findCommenterIpPaths({ comments: [{ replies: [{ user_ip: 1 }] }] })).toStrictEqual([
      '$.comments[0].replies[0].user_ip',
    ]);
    expect(findCommenterIpPaths({ a: [{ userIp: 1 }] })).toStrictEqual(['$.a[0].userIp']);
    expect(findCommenterIpPaths(DETAILS)).toStrictEqual([]);
  });

  it('a failure result carries no partial data (AC-35, AC-46)', () => {
    const failure = {
      kind: 'unexpected_response',
      message: 'bad',
      issues: [{ path: ['title'], message: 'missing' }],
    };
    expect(ClientFailureSchema.safeParse(failure).success).toBe(true);
    expect(ListPlacesResultSchema.safeParse({ ok: false, failure }).success).toBe(true);
    expect(
      ListPlacesResultSchema.safeParse({
        ok: false,
        failure,
        value: { page: 1, pageSize: 1, totalFound: 0, places: [] },
      }).success,
    ).toBe(false);
    expect(
      ClientFailureSchema.safeParse({ kind: 'unexpected_response', message: 'bad', issues: [] })
        .success,
    ).toBe(false);
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
    expect(parseRateLimitMessage(body.debug.message)).toStrictEqual({
      isRateLimit: true,
      waitSeconds: 7,
    });
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

  it('does not replace the flat 62587 fixture used by AC-9 and AC-10', () => {
    const flat = rawDetails('getbyid-62587.json');
    expect(flat.comments.map((c) => [c.name, c.replies.length])).toStrictEqual([
      ['Mateja', 0],
      ['Serbia', 0],
    ]);
  });

  it('is marked in the README as reconstructed', () => {
    expect(reconstructedSection()).toContain('getbyid-62587-nested-replies.json');
  });
});
