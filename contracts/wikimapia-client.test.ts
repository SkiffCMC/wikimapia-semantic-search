/**
 * AL5 CONTRACT TESTS: Wikimapia API client (behaviour, black box).
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261020-wikimapia-client-al6.md (one describe per AC)
 * Enforces: .agrules section 2 (responses parsed with Zod, invalid input is a handled error),
 *           section 4 (No Commenter IPs at any depth, recorded fixtures, no live network,
 *           API key never exposed, strict types).
 *
 * Subject under test: the real `createWikimapiaClient` from `src/wikimapia/client.ts`
 * (ENTRY_POINT in ./wikimapia-client.schema.ts). Only the injected transport (Simulated
 * Wikimapia) and clock (Simulated Clock) are test doubles. Until AL2 exists this file fails
 * to import: that is the expected red state.
 *
 * Fixture-only and schema-only checks (AC-39, AC-40, AC-41, AC-50) live in
 * ./wikimapia-client.schema.test.ts and pass before AL2.
 */
import { createWikimapiaClient } from '../src/wikimapia/client.js';
import {
  ListPlacesResultSchema,
  PlaceDetailsResultSchema,
  findCommenterIpPaths,
  type ClientFailure,
  type CreateWikimapiaClientFn,
  type ListPlacesResult,
  type ListingPage,
  type PlaceDetails,
  type PlaceDetailsResult,
  type WikimapiaClientOptions,
} from './wikimapia-client.schema.js';
import {
  SYNTHETIC_IPS,
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  addCommenterIps,
  answer,
  at,
  fixtureAnswer,
  fixtureText,
  rateLimitAnswer,
  rawBox,
  rawDetails,
  settle,
  type SimulatedAnswer,
} from './wikimapia-client.support.js';

// Compile-time check: the entry point has the contract's signature.
const create: CreateWikimapiaClientFn = createWikimapiaClient;

type ExtraOptions = Omit<WikimapiaClientOptions, 'apiKey' | 'transport' | 'clock'>;

function setup(
  answers: readonly SimulatedAnswer[],
  options: ExtraOptions & { repeatLast?: boolean } = {},
) {
  const { repeatLast, ...clientOptions } = options;
  const wikimapia = new SimulatedWikimapia(answers, repeatLast === undefined ? {} : { repeatLast });
  const clock = new SimulatedClock();
  const client = create({
    apiKey: TEST_API_KEY,
    transport: wikimapia.transport,
    clock,
    ...clientOptions,
  });
  return { wikimapia, clock, client };
}

/** Central Belgrade, the bbox of the recorded `box` page. */
const BELGRADE = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 } as const;

function okListing(result: ListPlacesResult): ListingPage {
  const parsed = ListPlacesResultSchema.parse(result);
  if (!parsed.ok) throw new Error(`expected a Listing Page, got ${JSON.stringify(parsed.failure)}`);
  return parsed.value;
}

function okDetails(result: PlaceDetailsResult): PlaceDetails {
  const parsed = PlaceDetailsResultSchema.parse(result);
  if (!parsed.ok) throw new Error(`expected Place Details, got ${JSON.stringify(parsed.failure)}`);
  return parsed.value;
}

/** Asserts a strict failure result (no partial data) of the given kind and returns it. */
function failure<K extends ClientFailure['kind']>(
  result: ListPlacesResult | PlaceDetailsResult,
  kind: K,
): Extract<ClientFailure, { kind: K }> {
  const parsed = PlaceDetailsResultSchema.or(ListPlacesResultSchema).parse(result);
  expect(parsed.ok).toBe(false);
  expect(result).not.toHaveProperty('value');
  if (parsed.ok) throw new Error('expected a failure');
  expect(parsed.failure.kind).toBe(kind);
  return parsed.failure as Extract<ClientFailure, { kind: K }>;
}

function hasIssueAt(f: { issues: { path: (string | number)[] }[] }, path: (string | number)[]) {
  return f.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(path));
}

function nestedFixture() {
  return rawDetails('getbyid-62587-nested-replies.json');
}

// ===========================================================================
// 3.1 Listing places in a Bounding Box
// ===========================================================================

describe('AC-1 Happy path, Listing Page', () => {
  it('returns page number, reported page size, Total Found 290 and the summaries in order', async () => {
    const { client } = setup([fixtureAnswer('box-belgrade-page1.json')]);
    const page = okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(10);
    expect(page.totalFound).toBe(290);
    const recordedIds = rawBox('box-belgrade-page1.json').folder.map((p) => Number(p.id));
    expect(page.places.map((p) => p.placeId)).toStrictEqual(recordedIds);
  });
});

describe('AC-2 Place Summary content', () => {
  it('reports University Park with whole-number id, link, location and outline', async () => {
    const { client } = setup([fixtureAnswer('box-belgrade-page1.json')]);
    const page = okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    const park = page.places.find((p) => p.placeId === 1381893);
    expect(park).toStrictEqual({
      placeId: 1381893,
      name: 'University Park',
      url: 'http://wikimapia.org/1381893/University-Park',
      location: {
        lon: 20.457876,
        lat: 44.819524,
        north: 44.820321,
        south: 44.818727,
        east: 20.459064,
        west: 20.456688,
      },
      outline: [
        { lon: 20.456688, lat: 44.8198 },
        { lon: 20.457444, lat: 44.820321 },
        { lon: 20.459064, lat: 44.819145 },
        { lon: 20.458394, lat: 44.818727 },
      ],
    });
  });

  it('keeps the Wikimapia page link of every summary (licensing, rule 8)', async () => {
    const { client } = setup([fixtureAnswer('box-belgrade-page1.json')]);
    const page = okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    for (const place of page.places) {
      expect(place.url).toMatch(new RegExp(`^http://wikimapia\\.org/${String(place.placeId)}/`));
    }
  });
});

describe('AC-3 What is asked of Wikimapia, listing', () => {
  it('sends exactly one `box` request with format, key, bbox (W,S,E,N), page and count', async () => {
    const { client, wikimapia } = setup([fixtureAnswer('box-belgrade-page1.json')]);
    await client.listPlaces({ bbox: BELGRADE, page: 3, pageSize: 25 });
    expect(wikimapia.requests).toHaveLength(1);
    const url = new URL(at(wikimapia.requests, 0).url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('api.wikimapia.org');
    const params = url.searchParams;
    expect(params.get('function')).toBe('box');
    expect(params.get('format')).toBe('json');
    expect(params.get('key')).toBe(TEST_API_KEY);
    expect(params.get('bbox')?.split(',').map(Number)).toStrictEqual([
      20.452, 44.814, 20.462, 44.82,
    ]);
    expect(params.get('page')).toBe('3');
    expect(params.get('count')).toBe('25');
  });
});

describe('AC-4 Default page size', () => {
  it('asks for 100 places per page when no page size is stated', async () => {
    const { client, wikimapia } = setup([fixtureAnswer('box-belgrade-page1.json')]);
    await client.listPlaces({ bbox: BELGRADE, page: 1 });
    expect(wikimapia.params(0).get('count')).toBe('100');
  });
});

describe('AC-5 Language, optional', () => {
  it('asks for the stated language on every request', async () => {
    const { client, wikimapia } = setup(
      [fixtureAnswer('box-belgrade-page1.json'), fixtureAnswer('getbyid-62587.json')],
      { language: 'en' },
    );
    okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(wikimapia.params(0).get('language')).toBe('en');
    expect(wikimapia.params(1).get('language')).toBe('en');
  });

  it('asks for no particular language when none is stated', async () => {
    const { client, wikimapia } = setup([
      fixtureAnswer('box-belgrade-page1.json'),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(wikimapia.params(0).has('language')).toBe(false);
    expect(wikimapia.params(1).has('language')).toBe(false);
  });
});

describe('AC-6 Empty page', () => {
  it('returns no summaries with the Total Found, and no failure', async () => {
    const { client } = setup([fixtureAnswer('box-belgrade-empty-page.json')]);
    const page = okListing(await client.listPlaces({ bbox: BELGRADE, page: 30, pageSize: 10 }));
    expect(page.places).toStrictEqual([]);
    expect(page.totalFound).toBe(290);
    expect(page.page).toBe(30);
  });
});

describe('AC-7 Invalid Bounding Box', () => {
  const cases = [
    ['west equals east', { ...BELGRADE, east: BELGRADE.west }],
    ['west greater than east', { ...BELGRADE, west: 20.5, east: 20.4 }],
    ['south equals north', { ...BELGRADE, north: BELGRADE.south }],
    ['south greater than north', { ...BELGRADE, south: 45, north: 44 }],
    ['longitude above 180', { ...BELGRADE, east: 180.5 }],
    ['longitude below -180', { ...BELGRADE, west: -181 }],
    ['latitude above 90', { ...BELGRADE, north: 90.5 }],
    ['latitude below -90', { ...BELGRADE, south: -91 }],
    ['not a number', { ...BELGRADE, west: Number.NaN }],
  ] as const;

  it.each(cases)(
    '%s: reports Invalid Request naming the bbox and sends nothing',
    async (_, bbox) => {
      const { client, wikimapia } = setup([fixtureAnswer('box-belgrade-page1.json')]);
      const f = failure(await client.listPlaces({ bbox, page: 1 }), 'invalid_request');
      expect(f.issues.some((issue) => issue.path[0] === 'bbox')).toBe(true);
      expect(wikimapia.requests).toHaveLength(0);
    },
  );
});

describe('AC-8 Invalid paging', () => {
  const cases = [
    ['page 0', { page: 0 }, 'page'],
    ['page -1', { page: -1 }, 'page'],
    ['page 1.5', { page: 1.5 }, 'page'],
    ['page size 0', { page: 1, pageSize: 0 }, 'pageSize'],
    ['page size 101', { page: 1, pageSize: 101 }, 'pageSize'],
    ['page size 2.5', { page: 1, pageSize: 2.5 }, 'pageSize'],
  ] as const;

  it.each(cases)('%s: reports Invalid Request and sends nothing', async (_, paging, field) => {
    const { client, wikimapia } = setup([fixtureAnswer('box-belgrade-page1.json')]);
    const f = failure(await client.listPlaces({ bbox: BELGRADE, ...paging }), 'invalid_request');
    expect(f.issues.some((issue) => issue.path[0] === field)).toBe(true);
    expect(wikimapia.requests).toHaveLength(0);
  });
});

// ===========================================================================
// 3.2 Fetching Place Details
// ===========================================================================

describe('AC-9 Happy path, place with comments', () => {
  it('returns the details of Square of the Republic (62587)', async () => {
    const { client } = setup([fixtureAnswer('getbyid-62587.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(place.placeId).toBe(62587);
    expect(place.title).toBe('Square of the Republic');
    expect(place.description).toBe(rawDetails('getbyid-62587.json').description);
    expect(place.tags).toStrictEqual([
      { id: 44926, title: 'historic town square' },
      { id: 46360, title: 'town square' },
    ]);
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place.isBuilding).toBe(false);
    expect(place.isRegion).toBe(false);
    expect(place.isDeleted).toBe(false);
    expect(place.wikipediaUrl).toBe('http://en.wikipedia.org/wiki/Republic_Square_(Belgrade)');
    expect(place.outline).toHaveLength(19);
    expect(at(place.outline, 0)).toStrictEqual({ lon: 20.4605903, lat: 44.8155814 });
    expect(place.location).toStrictEqual({
      lon: 20.4603516,
      lat: 44.8161006,
      north: 44.8167366,
      south: 44.8154647,
      east: 20.4612394,
      west: 20.4594638,
      city: 'Belgrade',
      place: 'Belgrade',
      state: 'Central Serbia',
      country: 'Serbia and Montenegro',
    });
    expect(place.comments).toHaveLength(2);
  });
});

describe('AC-10 Comment content', () => {
  it('reports both comments in order with every kept field normalised', async () => {
    const { client } = setup([fixtureAnswer('getbyid-62587.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(at(place.comments, 0)).toStrictEqual({
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
    });
    expect(at(place.comments, 1)).toStrictEqual({
      placeId: 62587,
      num: 2,
      langId: 0,
      author: 'Serbia',
      authorUserId: 150331,
      authorPhotoUrl: '/p/u/00/00/15/03/31_50.jpg',
      message: 'Najbolji trg na svetu!!',
      goodVotes: 33,
      badVotes: 0,
      isBlocked: false,
      isDeleted: false,
      postedAtEpochSeconds: 1199388051,
      moderatorUserId: 0,
      replies: [],
    });
  });
});

describe('AC-11 No Commenter IPs', () => {
  it('drops positive and negative Commenter IPs and keeps the Comment Author', async () => {
    const withIps = addCommenterIps(rawDetails('getbyid-62587.json'));
    const sentIps = withIps.comments.map((c) => c.user_ip);
    expect(sentIps.some((ip) => ip !== undefined && ip < 0)).toBe(true);
    const { client } = setup([answer(withIps)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(findCommenterIpPaths(place)).toStrictEqual([]);
    const json = JSON.stringify(place);
    for (const ip of sentIps) expect(json).not.toContain(String(ip));
    expect(place.comments.map((c) => c.author)).toStrictEqual(['Mateja', 'Serbia']);
  });
});

describe('AC-12 Place without comments', () => {
  it('returns University Park with an empty list of comments', async () => {
    const { client } = setup([fixtureAnswer('getbyid-1381893.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place.title).toBe('University Park');
    expect(place.description).toBe('Belgrade,Serbia.');
    expect(place.tags).toStrictEqual([{ id: 194, title: 'park' }]);
    expect(place.comments).toStrictEqual([]);
  });
});

describe('AC-13 Optional details missing', () => {
  it('reports Wikipedia link, street and house number as absent', async () => {
    const { client } = setup([fixtureAnswer('getbyid-1381893.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place.location).not.toHaveProperty('street');
    expect(place.location).not.toHaveProperty('houseNumber');
  });

  it('treats empty text from Wikimapia as absent, not as an empty value', async () => {
    const raw = rawDetails('getbyid-1381893.json');
    raw.wikipedia = '';
    raw.location.street = '';
    raw.location.housenumber = '';
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place.location).not.toHaveProperty('street');
    expect(place.location).not.toHaveProperty('houseNumber');
  });
});

describe('AC-14 Optional details present', () => {
  it('returns the Eiffel Tower as a building with street and house number', async () => {
    const { client } = setup([fixtureAnswer('getbyid-55.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 55 }));
    expect(place.title).toBe('Eiffel Tower');
    expect(place.isBuilding).toBe(true);
    expect(place.location.street).toBe('Champ de Mars');
    expect(place.location.houseNumber).toBe('5');
  });
});

describe('AC-15 Parent place', () => {
  it('reports no Parent Place ID for parent id "0"', async () => {
    const { client } = setup([fixtureAnswer('getbyid-1381893.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place).not.toHaveProperty('parentPlaceId');
  });

  it('reports any other parent id as a whole number (reconstructed: parent_id "7291521")', async () => {
    const raw = rawDetails('getbyid-1381893.json');
    raw.parent_id = '7291521';
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place.parentPlaceId).toBe(7291521);
  });
});

describe('AC-16 Extra items ignored', () => {
  it('does not report urlhtml, gadm, zoom, x/y, pl or other unlisted items', async () => {
    const { client } = setup([fixtureAnswer('getbyid-62587.json')]);
    const result = await client.getPlaceDetails({ placeId: 62587 });
    const place = okDetails(result);
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.value).sort()).toStrictEqual(
      [
        'comments',
        'description',
        'isBuilding',
        'isDeleted',
        'isRegion',
        'location',
        'outline',
        'placeId',
        'tags',
        'title',
        'wikipediaUrl',
      ].sort(),
    );
    const json = JSON.stringify(place);
    for (const extra of [
      'urlhtml',
      'gadm',
      'zoom',
      'country_adm_id',
      'street_id',
      'cityguideDomain',
      'object_type',
      'language_iso',
    ]) {
      expect(json).not.toContain(extra);
    }
  });
});

describe('AC-17 What is asked of Wikimapia, details', () => {
  it('sends exactly one `place.getbyid` request with format, key, id and data blocks', async () => {
    const { client, wikimapia } = setup([fixtureAnswer('getbyid-62587.json')]);
    await client.getPlaceDetails({ placeId: 62587 });
    expect(wikimapia.requests).toHaveLength(1);
    const url = new URL(at(wikimapia.requests, 0).url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('api.wikimapia.org');
    const params = url.searchParams;
    expect(params.get('function')).toBe('place.getbyid');
    expect(params.get('format')).toBe('json');
    expect(params.get('key')).toBe(TEST_API_KEY);
    expect(params.get('id')).toBe('62587');
    expect(params.get('data_blocks')?.split(',').sort()).toStrictEqual([
      'comments',
      'geometry',
      'location',
      'main',
    ]);
  });
});

describe('API key travels encrypted (HTTPS, contract change 2026-10-21)', () => {
  function expectHttpsWikimapia(requests: readonly { url: string }[]) {
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('api.wikimapia.org');
    }
  }

  it('every Listing Page request, including retries, goes to https://api.wikimapia.org', async () => {
    const { client, wikimapia } = setup([
      rateLimitAnswer(7),
      fixtureAnswer('box-belgrade-page1.json'),
    ]);
    okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    expect(wikimapia.requests).toHaveLength(2);
    expectHttpsWikimapia(wikimapia.requests);
  });

  it('every Place Details request, including retries, goes to https://api.wikimapia.org', async () => {
    const { client, wikimapia } = setup([rateLimitAnswer(7), fixtureAnswer('getbyid-62587.json')]);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(wikimapia.requests).toHaveLength(2);
    expectHttpsWikimapia(wikimapia.requests);
  });
});

describe('AC-18 Invalid Place ID', () => {
  it.each([0, -5, 1.5, Number.NaN])(
    '%s: reports Invalid Request and sends nothing',
    async (placeId) => {
      const { client, wikimapia } = setup([fixtureAnswer('getbyid-62587.json')]);
      const f = failure(await client.getPlaceDetails({ placeId }), 'invalid_request');
      expect(f.issues.some((issue) => issue.path[0] === 'placeId')).toBe(true);
      expect(wikimapia.requests).toHaveLength(0);
    },
  );
});

describe('AC-19 Deleted place', () => {
  it('returns the details with the deleted mark set (reconstructed: is_deleted true)', async () => {
    const raw = rawDetails('getbyid-1381893.json');
    raw.is_deleted = true;
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place.isDeleted).toBe(true);
    expect(place.title).toBe('University Park');
  });
});

describe('AC-20 Deleted or blocked comment', () => {
  it('returns deleted and blocked comments with their marks set', async () => {
    const raw = rawDetails('getbyid-62587.json');
    at(raw.comments, 0).is_deleted = true;
    at(raw.comments, 1).block = true;
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(at(place.comments, 0)).toMatchObject({
      author: 'Mateja',
      isDeleted: true,
      isBlocked: false,
    });
    expect(at(place.comments, 1)).toMatchObject({
      author: 'Serbia',
      isDeleted: false,
      isBlocked: true,
    });
  });

  it('returns deleted and blocked replies with their marks set', async () => {
    const raw = nestedFixture();
    const serbia = at(at(raw.comments, 0).replies, 0);
    serbia.is_deleted = true;
    at(serbia.replies, 0).block = true;
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    const reply = at(at(place.comments, 0).replies, 0);
    expect(reply).toMatchObject({ author: 'Serbia', isDeleted: true, isBlocked: false });
    expect(at(reply.replies, 0)).toMatchObject({
      author: 'Paul',
      isDeleted: false,
      isBlocked: true,
    });
  });
});

// ===========================================================================
// 3.3 Comment Replies
// ===========================================================================

describe('AC-21 Empty replies', () => {
  it('reports comments whose replies are empty with an empty list of Replies', async () => {
    const { client } = setup([fixtureAnswer('getbyid-62587.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    for (const comment of place.comments) expect(comment.replies).toStrictEqual([]);
  });
});

describe('AC-42 One level of Replies', () => {
  it('reports "Serbia" as the single, fully normalised Reply of "Mateja"', async () => {
    const { client } = setup([fixtureAnswer('getbyid-62587-nested-replies.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(place.comments).toHaveLength(1);
    const mateja = at(place.comments, 0);
    expect(mateja.author).toBe('Mateja');
    expect(mateja.message).toBe('Everybodey is waiting for someone here');
    expect(mateja.replies).toHaveLength(1);
    const serbia = at(mateja.replies, 0);
    expect(serbia).toStrictEqual({
      placeId: 62587,
      num: 2,
      langId: 0,
      author: 'Serbia',
      authorUserId: 150331,
      authorPhotoUrl: '/p/u/00/00/15/03/31_50.jpg',
      message: 'Najbolji trg na svetu!!',
      goodVotes: 33,
      badVotes: 0,
      isBlocked: false,
      isDeleted: false,
      postedAtEpochSeconds: 1199388051,
      moderatorUserId: 0,
      replies: [at(serbia.replies, 0)],
    });
  });
});

describe('AC-43 Replies at any depth', () => {
  it('reports the recorded place-55 comment as a Reply of "Serbia", unchanged, with no replies', async () => {
    const { client } = setup([fixtureAnswer('getbyid-62587-nested-replies.json')]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    const serbia = at(at(place.comments, 0).replies, 0);
    expect(serbia.replies).toHaveLength(1);
    expect(at(serbia.replies, 0)).toStrictEqual({
      placeId: 55,
      num: 5,
      langId: 0,
      author: 'Paul',
      authorUserId: 0,
      message:
        "It's a big fancy tower that was built in the late 1880s to commemorate the centenary of the French Revolution.\r\n",
      goodVotes: 0,
      badVotes: 2,
      isBlocked: false,
      isDeleted: false,
      postedAtEpochSeconds: 1168829553,
      moderatorUserId: 1680617,
      moderatorName: 'Extram',
      replies: [],
    });
  });

  it('has no fixed depth limit (reconstructed: 12 levels of nesting)', async () => {
    const raw = rawDetails('getbyid-62587.json');
    const template = at(raw.comments, 1);
    let chain = { ...template, replies: [] as typeof template.replies };
    for (let depth = 0; depth < 11; depth += 1) chain = { ...template, replies: [chain] };
    raw.comments = [chain];
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    let level = at(place.comments, 0);
    let depth = 1;
    while (level.replies.length > 0) {
      level = at(level.replies, 0);
      depth += 1;
    }
    expect(depth).toBe(12);
    expect(level.author).toBe('Serbia');
  });
});

describe('AC-44 Order of Replies', () => {
  it('keeps several Replies in the order Wikimapia sent them (reconstructed: Ramona after Serbia)', async () => {
    const raw = nestedFixture();
    const ramona = at(rawDetails('getbyid-55.json').comments, 0);
    expect(ramona.name).toBe('Ramona');
    at(raw.comments, 0).replies.push(ramona);
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(at(place.comments, 0).replies.map((r) => r.author)).toStrictEqual(['Serbia', 'Ramona']);
  });
});

describe('AC-45 No Commenter IPs at any depth', () => {
  it('drops Commenter IPs on the comment, the reply and the reply to the reply', async () => {
    const withIps = addCommenterIps(nestedFixture());
    const { client } = setup([answer(withIps)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(findCommenterIpPaths(place)).toStrictEqual([]);
    const json = JSON.stringify(place);
    for (const ip of SYNTHETIC_IPS.slice(0, 3)) expect(json).not.toContain(String(ip));
    const mateja = at(place.comments, 0);
    const serbia = at(mateja.replies, 0);
    const paul = at(serbia.replies, 0);
    expect([mateja.author, serbia.author, paul.author]).toStrictEqual(['Mateja', 'Serbia', 'Paul']);
  });
});

describe('AC-46 Wrong shape inside a Reply', () => {
  it('reports Unexpected Response when a reply to a reply lacks its author', async () => {
    const raw = nestedFixture();
    Reflect.deleteProperty(at(at(at(raw.comments, 0).replies, 0).replies, 0), 'name');
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    expect(hasIssueAt(f, ['comments', 0, 'replies', 0, 'replies', 0, 'name'])).toBe(true);
  });

  it('reports Unexpected Response when a reply has a vote count that is not a whole number', async () => {
    const raw = nestedFixture();
    at(at(raw.comments, 0).replies, 0).good = 1.5;
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    expect(hasIssueAt(f, ['comments', 0, 'replies', 0, 'good'])).toBe(true);
  });
});

describe('AC-47 Deleted or blocked parent with Replies', () => {
  it('keeps the full Replies of a deleted and blocked comment', async () => {
    const raw = nestedFixture();
    at(raw.comments, 0).is_deleted = true;
    at(raw.comments, 0).block = true;
    const { client } = setup([answer(raw)]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    const mateja = at(place.comments, 0);
    expect(mateja).toMatchObject({ isDeleted: true, isBlocked: true });
    expect(mateja.replies.map((r) => r.author)).toStrictEqual(['Serbia']);
    expect(at(mateja.replies, 0).replies.map((r) => r.author)).toStrictEqual(['Paul']);
  });
});

// ===========================================================================
// 3.4 Rate limiting
// ===========================================================================

describe('AC-22 Recognise and wait', () => {
  it('waits exactly 7 s on the clock, resends the identical request and returns the normal result', async () => {
    const plain = setup([fixtureAnswer('getbyid-62587.json')]);
    const expected = okDetails(await plain.client.getPlaceDetails({ placeId: 62587 }));

    const { client, wikimapia, clock } = setup([
      rateLimitAnswer(7),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
    expect(at(wikimapia.requests, 1).url).toBe(at(wikimapia.requests, 0).url);
    expect(place).toStrictEqual(expected);
  });
});

describe('AC-23 Applies to both functions', () => {
  it('waits and retries for a Listing Page request', async () => {
    const { client, wikimapia, clock } = setup([
      rateLimitAnswer(7),
      fixtureAnswer('box-belgrade-page1.json'),
    ]);
    const page = okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    expect(page.totalFound).toBe(290);
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
    expect(at(wikimapia.requests, 1).url).toBe(at(wikimapia.requests, 0).url);
  });

  it('waits and retries for a Place Details request', async () => {
    const { client, wikimapia, clock } = setup([
      rateLimitAnswer(7),
      fixtureAnswer('getbyid-1381893.json'),
    ]);
    const place = okDetails(await client.getPlaceDetails({ placeId: 1381893 }));
    expect(place.title).toBe('University Park');
    expect(clock.sleeps).toStrictEqual([7000]);
    expect(wikimapia.requests).toHaveLength(2);
  });
});

describe('AC-24 Not mistaken for data', () => {
  it('is never reported as Unexpected Response, even when retries are used up', async () => {
    const listing = setup([rateLimitAnswer(4)], { retryLimit: 0 });
    const f1 = failure(
      await listing.client.listPlaces({ bbox: BELGRADE, page: 1 }),
      'rate_limit_exhausted',
    );
    expect(f1.kind).not.toBe('unexpected_response');

    const details = setup([rateLimitAnswer(4)], { retryLimit: 0 });
    failure(await details.client.getPlaceDetails({ placeId: 62587 }), 'rate_limit_exhausted');
    expect(details.wikimapia.requests).toHaveLength(1);
    expect(details.clock.sleeps).toStrictEqual([]);
  });
});

describe('AC-25 Several limits in a row', () => {
  it('waits 3 s, retries, waits 5 s, retries and succeeds: 8 s, 3 requests', async () => {
    const { client, wikimapia, clock } = setup([
      rateLimitAnswer(3),
      rateLimitAnswer(5),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(clock.sleeps).toStrictEqual([3000, 5000]);
    expect(clock.totalMilliseconds).toBe(8000);
    expect(wikimapia.requests).toHaveLength(3);
  });
});

describe('AC-26 Retry Limit reached', () => {
  it('default limit: 6 requests, 5 waits, then Rate Limit Exhausted with attempts and last wait', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer(3)], { repeatLast: true });
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(6);
    expect(clock.sleeps).toStrictEqual([3000, 3000, 3000, 3000, 3000]);
    expect(f.attempts).toBe(6);
    expect(f.lastWaitSeconds).toBe(3);
  });

  it('configured limit R = 1: 2 requests, 1 wait, no wait after the last', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer(2), rateLimitAnswer(9)], {
      retryLimit: 1,
    });
    const f = failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.sleeps).toStrictEqual([2000]);
    expect(f.attempts).toBe(2);
    expect(f.lastWaitSeconds).toBe(9);
  });
});

describe('AC-27 Unreadable Wait Time', () => {
  it('waits the default Fallback Wait Time of 60 s and retries', async () => {
    const { client, wikimapia, clock } = setup([
      rateLimitAnswer('a few'),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(clock.sleeps).toStrictEqual([60000]);
    expect(wikimapia.requests).toHaveLength(2);
  });

  it('counts towards the Retry Limit', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer('a few')], {
      repeatLast: true,
      retryLimit: 1,
    });
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.sleeps).toStrictEqual([60000]);
    expect(f.lastWaitSeconds).toBe(60);
  });
});

describe('AC-28 Wait Time of zero', () => {
  it('retries without waiting', async () => {
    const { client, wikimapia, clock } = setup([
      rateLimitAnswer(0),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.totalMilliseconds).toBe(0);
  });

  it('counts towards the Retry Limit', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer(0)], {
      repeatLast: true,
      retryLimit: 2,
    });
    const f = failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(3);
    expect(clock.totalMilliseconds).toBe(0);
    expect(f.attempts).toBe(3);
  });
});

describe('AC-29 No waiting without a limit', () => {
  it('sends one request and never waits for either function', async () => {
    const { client, wikimapia, clock } = setup([
      fixtureAnswer('box-belgrade-page1.json'),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    expect(wikimapia.requests).toHaveLength(1);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(wikimapia.requests).toHaveLength(2);
    expect(clock.sleeps).toStrictEqual([]);
  });
});

describe('AC-30 No early retry', () => {
  it('sends nothing for the request until the wait has elapsed on the given clock', async () => {
    const log: string[] = [];
    const wikimapia = new SimulatedWikimapia(
      [rateLimitAnswer(7), fixtureAnswer('getbyid-62587.json')],
      { log },
    );
    const clock = new SimulatedClock({ manual: true, log });
    const client = create({ apiKey: TEST_API_KEY, transport: wikimapia.transport, clock });

    const pending = client.getPlaceDetails({ placeId: 62587 });
    await settle();
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.pendingWaits).toBe(1);
    await settle(20);
    expect(wikimapia.requests).toHaveLength(1);

    clock.elapseAll();
    okDetails(await pending);
    expect(wikimapia.requests).toHaveLength(2);
    expect(log).toStrictEqual(['request', 'sleep:7000', 'request']);
  });
});

describe('AC-48 No cap on a stated Wait Time', () => {
  it('waits the full 86400 s on the clock and retries without failing', async () => {
    const { client, wikimapia, clock } = setup([
      rateLimitAnswer(86400),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(clock.sleeps).toStrictEqual([86_400_000]);
    expect(wikimapia.requests).toHaveLength(2);
  });
});

describe('AC-49 Configured limits honoured', () => {
  it('Retry Limit 2 and Fallback 10 s: 3 requests, two 10 s waits, Rate Limit Exhausted', async () => {
    const { client, wikimapia, clock } = setup([rateLimitAnswer('several')], {
      repeatLast: true,
      retryLimit: 2,
      fallbackWaitSeconds: 10,
    });
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'rate_limit_exhausted');
    expect(wikimapia.requests).toHaveLength(3);
    expect(clock.sleeps).toStrictEqual([10000, 10000]);
    expect(f.attempts).toBe(3);
    expect(f.lastWaitSeconds).toBe(10);
  });
});

// ===========================================================================
// 3.5 Failures
// ===========================================================================

describe('AC-31 Missing API Key', () => {
  const variants: [string, Partial<WikimapiaClientOptions>][] = [
    ['empty', { apiKey: '' }],
    ['missing', {}],
  ];

  it.each(variants)(
    '%s key: creation does not throw, every call is a Configuration Failure',
    async (_, keyPart) => {
      const wikimapia = new SimulatedWikimapia([fixtureAnswer('getbyid-62587.json')], {
        repeatLast: true,
      });
      const clock = new SimulatedClock();
      const options = {
        transport: wikimapia.transport,
        clock,
        ...keyPart,
      } as WikimapiaClientOptions;
      const client = create(options);
      failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'configuration');
      failure(await client.getPlaceDetails({ placeId: 62587 }), 'configuration');
      expect(wikimapia.requests).toHaveLength(0);
    },
  );
});

describe('AC-32 Other Wikimapia messages', () => {
  it('reports a Wikimapia Error with the message text and does not retry (details)', async () => {
    const { client, wikimapia, clock } = setup([fixtureAnswer('debug-error.json')], {
      repeatLast: true,
    });
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'wikimapia_error');
    expect(f.wikimapiaMessage).toBe('Invalid API key.');
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('reports a Wikimapia Error and does not retry (listing)', async () => {
    const { client, wikimapia } = setup([fixtureAnswer('debug-error.json')], { repeatLast: true });
    failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'wikimapia_error');
    expect(wikimapia.requests).toHaveLength(1);
  });
});

describe('AC-33 Cannot reach Wikimapia', () => {
  it('reports a Connection Failure when Wikimapia cannot be reached, without retrying', async () => {
    const { client, wikimapia, clock } = setup([{ unreachable: true }], { repeatLast: true });
    failure(await client.getPlaceDetails({ placeId: 62587 }), 'connection');
    expect(wikimapia.requests).toHaveLength(1);
    expect(clock.sleeps).toStrictEqual([]);
  });

  it.each([404, 500, 503])(
    'reports a Connection Failure for status %i, without retrying',
    async (status) => {
      const { client, wikimapia } = setup([answer(fixtureText('getbyid-62587.json'), status)], {
        repeatLast: true,
      });
      const f = failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'connection');
      expect(f.status).toBe(status);
      expect(wikimapia.requests).toHaveLength(1);
    },
  );
});

describe('AC-34 Unreadable answer', () => {
  it.each([
    ['HTML page', '<html><body>Service temporarily unavailable</body></html>'],
    ['empty body', ''],
    ['truncated JSON', fixtureText('getbyid-62587.json').slice(0, 200)],
  ])('%s: reports an Unexpected Response', async (_, body) => {
    const { client } = setup([answer(body)]);
    failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
  });
});

describe('AC-35 Wrong shape', () => {
  it('details without a title: names `title`', async () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(raw, 'title');
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    expect(hasIssueAt(f, ['title'])).toBe(true);
  });

  it('comment without an author: names `comments[1].name`', async () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(at(raw.comments, 1), 'name');
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    expect(hasIssueAt(f, ['comments', 1, 'name'])).toBe(true);
  });

  it.each([['abc'], [1.5], [-3]])('place id %s: names `id`', async (id) => {
    const raw = rawDetails('getbyid-62587.json');
    Object.assign(raw, { id });
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    expect(hasIssueAt(f, ['id'])).toBe(true);
  });

  it('box place with a non-numeric id: names `folder[0].id`', async () => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 0).id = 'abc';
    const { client } = setup([answer(raw)]);
    const f = failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'unexpected_response');
    expect(hasIssueAt(f, ['folder', 0, 'id'])).toBe(true);
  });

  it('box page without Total Found: names `found`', async () => {
    const raw = rawBox('box-belgrade-page1.json');
    Reflect.deleteProperty(raw, 'found');
    const { client } = setup([answer(raw)]);
    const f = failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'unexpected_response');
    expect(hasIssueAt(f, ['found'])).toBe(true);
  });

  it('an empty JSON list (as `place.getbyarea` returns) is an Unexpected Response', async () => {
    const { client } = setup([answer('[]')]);
    failure(await client.listPlaces({ bbox: BELGRADE, page: 1 }), 'unexpected_response');
  });
});

describe('AC-36 API Key never exposed', () => {
  const WIKIMAPIA_URL_WITH_KEY = `https://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=62587`;

  async function allFailures(): Promise<ClientFailure[]> {
    const outcomes: (ListPlacesResult | PlaceDetailsResult)[] = [];
    const unconfigured = create({
      apiKey: '',
      transport: new SimulatedWikimapia([]).transport,
      clock: new SimulatedClock(),
    });
    outcomes.push(await unconfigured.getPlaceDetails({ placeId: 62587 }));
    outcomes.push(await setup([]).client.getPlaceDetails({ placeId: 0 }));
    outcomes.push(
      await setup([rateLimitAnswer(1)], { repeatLast: true }).client.getPlaceDetails({
        placeId: 62587,
      }),
    );
    outcomes.push(
      await setup([
        answer({ debug: { message: `Key ${TEST_API_KEY} is not valid` } }),
      ]).client.getPlaceDetails({
        placeId: 62587,
      }),
    );
    outcomes.push(
      await setup([{ unreachable: true }]).client.listPlaces({ bbox: BELGRADE, page: 1 }),
    );
    outcomes.push(await setup([answer('', 502)]).client.listPlaces({ bbox: BELGRADE, page: 1 }));
    outcomes.push(
      await setup([
        answer(`<html>Bad request: ${WIKIMAPIA_URL_WITH_KEY}</html>`),
      ]).client.getPlaceDetails({
        placeId: 62587,
      }),
    );
    return outcomes.map((outcome) => {
      if (outcome.ok) throw new Error('expected a failure');
      return outcome.failure;
    });
  }

  it('no failure of any kind contains the key or a request address with it', async () => {
    const failures = await allFailures();
    expect(new Set(failures.map((f) => f.kind))).toStrictEqual(
      new Set([
        'configuration',
        'invalid_request',
        'rate_limit_exhausted',
        'wikimapia_error',
        'connection',
        'unexpected_response',
      ]),
    );
    for (const f of failures) {
      const json = JSON.stringify(f);
      expect(json).not.toContain(TEST_API_KEY);
      expect(json).not.toMatch(/[?&]key=/);
    }
  });
});

describe('AC-37 No Commenter IPs in failures', () => {
  it('an Unexpected Response for a wrong reply carries no IP from any level', async () => {
    const raw = addCommenterIps(nestedFixture());
    Reflect.deleteProperty(at(at(at(raw.comments, 0).replies, 0).replies, 0), 'name');
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    const json = JSON.stringify(f);
    for (const ip of SYNTHETIC_IPS) expect(json).not.toContain(String(ip));
  });

  it('an Unexpected Response for a wrongly typed Commenter IP does not echo the IP', async () => {
    const raw = addCommenterIps(rawDetails('getbyid-62587.json'));
    Object.assign(at(raw.comments, 0), { user_ip: '1555555555', good: 'many' });
    const { client } = setup([answer(raw)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'unexpected_response');
    const json = JSON.stringify(f);
    for (const ip of [...SYNTHETIC_IPS, 1555555555]) expect(json).not.toContain(String(ip));
  });

  it('a Wikimapia Error for an answer that also carried comments carries no IP', async () => {
    const withIps = addCommenterIps(nestedFixture());
    const body = { debug: { message: 'Invalid API key.' }, comments: withIps.comments };
    const { client } = setup([answer(body)]);
    const f = failure(await client.getPlaceDetails({ placeId: 62587 }), 'wikimapia_error');
    const json = JSON.stringify(f);
    for (const ip of SYNTHETIC_IPS) expect(json).not.toContain(String(ip));
  });
});

// ===========================================================================
// 3.6 Offline verification
// ===========================================================================

describe('AC-38 No network in tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with an injected transport and clock, the client never uses the real network', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('real network is disabled in contract tests'));
    const { client } = setup([
      rateLimitAnswer(30),
      fixtureAnswer('box-belgrade-page1.json'),
      fixtureAnswer('getbyid-62587.json'),
    ]);
    okListing(await client.listPlaces({ bbox: BELGRADE, page: 1 }));
    okDetails(await client.getPlaceDetails({ placeId: 62587 }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
