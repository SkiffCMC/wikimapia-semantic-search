/**
 * AL2 unit tests: `src/wikimapia/normalize.ts` (AL4 1.3 `normalize.ts` block, 1.4.6
 * Normalisation, section 2 Data Model Design).
 *
 * Pure and synchronous. Inputs are the recorded / reconstructed fixtures loaded through the
 * contract support helpers (already validated by the raw schemas) and mutated copies of them.
 */
import {
  normalizeComment,
  normalizeListingPage,
  normalizePlaceDetails,
} from '../../src/wikimapia/normalize';
import type { Normalized } from '../../src/wikimapia/types';
import {
  CommentSchema,
  FailureIssueSchema,
  ListingPageSchema,
  PlaceDetailsSchema,
  findCommenterIpPaths,
  type Comment,
  type FailureIssue,
  type RawComment,
} from '../../contracts/wikimapia-client.schema';
import {
  SYNTHETIC_IPS,
  addCommenterIps,
  at,
  rawBox,
  rawDetails,
  type FixtureName,
} from '../../contracts/wikimapia-client.support';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okValue<T>(result: Normalized<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  expect(Object.keys(result).sort()).toStrictEqual(['ok', 'value']);
  return result.value;
}

/** Asserts a failure with no partial value and returns its issues. */
function failIssues<T>(result: Normalized<T>): FailureIssue[] {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('value');
  expect(Object.keys(result).sort()).toStrictEqual(['issues', 'ok']);
  if (result.ok) throw new Error('expected a failure');
  for (const issue of result.issues) {
    expect(FailureIssueSchema.safeParse(issue).success).toBe(true);
  }
  return result.issues;
}

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

const BOUNDS_KEYS = ['east', 'lat', 'lon', 'north', 'south', 'west'];
const POINT_KEYS = ['lat', 'lon'];
const LISTING_KEYS = ['page', 'pageSize', 'places', 'totalFound'];
const SUMMARY_KEYS = ['location', 'name', 'outline', 'placeId', 'url'];
const DETAILS_REQUIRED_KEYS = [
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
];
const COMMENT_REQUIRED_KEYS = [
  'author',
  'authorUserId',
  'badVotes',
  'goodVotes',
  'isBlocked',
  'isDeleted',
  'langId',
  'message',
  'moderatorUserId',
  'num',
  'placeId',
  'postedAtEpochSeconds',
  'replies',
];
const TAG_KEYS = ['id', 'title'];

/** A digit string above Number.MAX_SAFE_INTEGER (passes the raw digit regexes). */
const UNSAFE_DIGITS = '9007199254740993';
const UNSAFE_MESSAGE = 'id is not a safe whole number';

function nested() {
  return rawDetails('getbyid-62587-nested-replies.json');
}

/** A chain of `levels` comments, each the only reply of the previous one (copies of "Serbia"). */
function commentChain(levels: number): RawComment {
  const template = at(rawDetails('getbyid-62587.json').comments, 1);
  let chain: RawComment = { ...template, replies: [] };
  for (let depth = 1; depth < levels; depth += 1) chain = { ...template, replies: [chain] };
  return chain;
}

function depthOf(comment: Comment): number {
  let level = comment;
  let depth = 1;
  while (level.replies.length > 0) {
    level = at(level.replies, 0);
    depth += 1;
  }
  return depth;
}

const PARK_SUMMARY = {
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
};

const MATEJA: Comment = {
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

const SERBIA: Comment = {
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
};

const PAUL: Comment = {
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
};

// ---------------------------------------------------------------------------
// 2.1 Listing page
// ---------------------------------------------------------------------------

describe('normalizeListingPage (AL4 2.1)', () => {
  it('reports page, reported pageSize 10, totalFound 290 and summaries in fixture order (AC-1)', () => {
    const raw = rawBox('box-belgrade-page1.json');
    const page = okValue(normalizeListingPage(raw));
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(10);
    expect(page.totalFound).toBe(290);
    expect(page.places.map((p) => p.placeId)).toStrictEqual(raw.folder.map((p) => Number(p.id)));
    expect(page.places.map((p) => p.name)).toStrictEqual(raw.folder.map((p) => p.name));
    expect(keys(page)).toStrictEqual(LISTING_KEYS);
  });

  it('reports University Park exactly as in AC-2', () => {
    const page = okValue(normalizeListingPage(rawBox('box-belgrade-page1.json')));
    const park = page.places.find((p) => p.placeId === 1381893);
    expect(park).toStrictEqual(PARK_SUMMARY);
  });

  it('keeps every url unchanged and maps every polygon point x/y to lon/lat in order', () => {
    const raw = rawBox('box-belgrade-page1.json');
    const page = okValue(normalizeListingPage(raw));
    page.places.forEach((place, i) => {
      const source = at(raw.folder, i);
      expect(place.url).toBe(source.url);
      expect(place.outline).toStrictEqual(source.polygon.map((p) => ({ lon: p.x, lat: p.y })));
    });
  });

  it('accepts numeric page/count/found and numeric ids as well as digit strings', () => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.page = '2';
    raw.count = '10';
    raw.found = 290;
    at(raw.folder, 0).id = 1381893;
    const page = okValue(normalizeListingPage(raw));
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(10);
    expect(page.totalFound).toBe(290);
    expect(at(page.places, 0).placeId).toBe(1381893);
  });

  it('gives an empty places list and no failure for the empty page (AC-6)', () => {
    const page = okValue(normalizeListingPage(rawBox('box-belgrade-empty-page.json')));
    expect(page).toStrictEqual({ page: 30, pageSize: 10, totalFound: 290, places: [] });
  });
});

// ---------------------------------------------------------------------------
// 2.2 Place details
// ---------------------------------------------------------------------------

describe('normalizePlaceDetails (AL4 2.2)', () => {
  it('returns the details of Square of the Republic (AC-9)', () => {
    const raw = rawDetails('getbyid-62587.json');
    const place = okValue(normalizePlaceDetails(raw));
    expect(place.placeId).toBe(62587);
    expect(place.title).toBe('Square of the Republic');
    expect(place.description).toBe(raw.description);
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
    expect(place.outline).toStrictEqual(raw.polygon.map((p) => ({ lon: p.x, lat: p.y })));
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

  it('returns University Park with empty comments (AC-12)', () => {
    const place = okValue(normalizePlaceDetails(rawDetails('getbyid-1381893.json')));
    expect(place.placeId).toBe(1381893);
    expect(place.title).toBe('University Park');
    expect(place.description).toBe('Belgrade,Serbia.');
    expect(place.tags).toStrictEqual([{ id: 194, title: 'park' }]);
    expect(place.comments).toStrictEqual([]);
  });

  it('accepts a digit-string details id', () => {
    const raw = rawDetails('getbyid-1381893.json');
    raw.id = '1381893';
    expect(okValue(normalizePlaceDetails(raw)).placeId).toBe(1381893);
  });

  describe('optional values are absent keys (AC-13)', () => {
    it('wikipedia missing (1381893 as recorded) gives no wikipediaUrl, street or houseNumber key', () => {
      const place = okValue(normalizePlaceDetails(rawDetails('getbyid-1381893.json')));
      expect(place).not.toHaveProperty('wikipediaUrl');
      expect(place.location).not.toHaveProperty('street');
      expect(place.location).not.toHaveProperty('houseNumber');
      expect(keys(place)).toStrictEqual(DETAILS_REQUIRED_KEYS);
    });

    it.each([['null'], ['empty'], ['missing']] as const)(
      'wikipedia %s gives no wikipediaUrl key',
      (variant) => {
        const raw = rawDetails('getbyid-55.json');
        if (variant === 'null') raw.wikipedia = null;
        if (variant === 'empty') raw.wikipedia = '';
        if (variant === 'missing') Reflect.deleteProperty(raw, 'wikipedia');
        const place = okValue(normalizePlaceDetails(raw));
        expect(place).not.toHaveProperty('wikipediaUrl');
        expect(Object.keys(place)).not.toContain('wikipediaUrl');
      },
    );

    const locationFields = [
      ['street', 'street'],
      ['housenumber', 'houseNumber'],
      ['city', 'city'],
      ['place', 'place'],
      ['state', 'state'],
      ['country', 'country'],
    ] as const;
    const variants = ['null', 'empty', 'missing'] as const;
    const cases = locationFields.flatMap(([rawKey, outKey]) =>
      variants.map((variant) => [rawKey, outKey, variant] as const),
    );

    it.each(cases)('location.%s %s -> %s gives no output key', (rawKey, outKey, variant) => {
      const raw = rawDetails('getbyid-55.json');
      if (variant === 'missing') Reflect.deleteProperty(raw.location, rawKey);
      else raw.location[rawKey] = variant === 'null' ? null : '';
      const place = okValue(normalizePlaceDetails(raw));
      expect(place.location).not.toHaveProperty(outKey);
      expect(Object.keys(place.location)).not.toContain(outKey);
    });
  });

  describe('optional values present (AC-14)', () => {
    it('returns the Eiffel Tower as a building with every location detail', () => {
      const place = okValue(normalizePlaceDetails(rawDetails('getbyid-55.json')));
      expect(place.title).toBe('Eiffel Tower');
      expect(place.isBuilding).toBe(true);
      expect(place.wikipediaUrl).toBe('http://en.wikipedia.org/wiki/Eiffel_Tower');
      expect(place.location).toStrictEqual({
        lon: 2.2945074,
        lat: 48.8582537,
        north: 48.8590372,
        south: 48.8574703,
        east: 2.2957088,
        west: 2.2933061,
        street: 'Champ de Mars',
        houseNumber: '5',
        city: 'Paris',
        place: 'Vanves',
        state: 'Ile-de-France',
        country: 'France',
      });
    });

    it('keeps present text unchanged (not trimmed)', () => {
      const raw = rawDetails('getbyid-55.json');
      raw.wikipedia = '  http://en.wikipedia.org/wiki/Eiffel_Tower ';
      raw.location.street = ' Champ de Mars  ';
      raw.location.housenumber = '5 ';
      raw.location.city = ' Paris';
      const place = okValue(normalizePlaceDetails(raw));
      expect(place.wikipediaUrl).toBe('  http://en.wikipedia.org/wiki/Eiffel_Tower ');
      expect(place.location.street).toBe(' Champ de Mars  ');
      expect(place.location.houseNumber).toBe('5 ');
      expect(place.location.city).toBe(' Paris');
    });
  });

  describe('parent place (AC-15)', () => {
    it('parent_id "0" gives no parentPlaceId key', () => {
      const place = okValue(normalizePlaceDetails(rawDetails('getbyid-1381893.json')));
      expect(place).not.toHaveProperty('parentPlaceId');
    });

    it('parent_id 0 (number) gives no parentPlaceId key', () => {
      const raw = rawDetails('getbyid-1381893.json');
      raw.parent_id = 0;
      expect(okValue(normalizePlaceDetails(raw))).not.toHaveProperty('parentPlaceId');
    });

    it('parent_id "7291521" gives parentPlaceId 7291521', () => {
      const raw = rawDetails('getbyid-1381893.json');
      raw.parent_id = '7291521';
      const place = okValue(normalizePlaceDetails(raw));
      expect(place.parentPlaceId).toBe(7291521);
      expect(keys(place)).toStrictEqual([...DETAILS_REQUIRED_KEYS, 'parentPlaceId'].sort());
    });
  });

  it('keeps is_deleted true (AC-19)', () => {
    const raw = rawDetails('getbyid-1381893.json');
    raw.is_deleted = true;
    const place = okValue(normalizePlaceDetails(raw));
    expect(place.isDeleted).toBe(true);
    expect(place.title).toBe('University Park');
  });
});

// ---------------------------------------------------------------------------
// 2.3 Comments
// ---------------------------------------------------------------------------

describe('comments (AL4 2.3)', () => {
  it('reports both comments of 62587 in order, field by field (AC-10)', () => {
    const place = okValue(normalizePlaceDetails(rawDetails('getbyid-62587.json')));
    expect(place.comments).toStrictEqual([MATEJA, SERBIA]);
  });

  it('normalizeComment maps a single raw comment directly', () => {
    const raw = rawDetails('getbyid-62587.json');
    expect(normalizeComment(at(raw.comments, 0))).toStrictEqual(MATEJA);
    expect(normalizeComment(at(raw.comments, 1))).toStrictEqual(SERBIA);
  });

  it("authorPhotoUrl is absent for user_photo ''", () => {
    const comment = normalizeComment(at(rawDetails('getbyid-62587.json').comments, 0));
    expect(comment).not.toHaveProperty('authorPhotoUrl');
  });

  it.each([
    ['null', null],
    ['empty', ''],
  ] as const)('moderatorName is absent for moder_name %s', (_, value) => {
    const raw = at(rawDetails('getbyid-55.json').comments, 1);
    raw.moder_name = value;
    const comment = normalizeComment(raw);
    expect(comment).not.toHaveProperty('moderatorName');
    expect(keys(comment)).toStrictEqual(COMMENT_REQUIRED_KEYS);
  });

  it('keeps moderatorName and authorPhotoUrl when present', () => {
    const raw = rawDetails('getbyid-55.json');
    const w8r = normalizeComment(at(raw.comments, 2));
    expect(w8r.moderatorName).toBe('RK77');
    expect(w8r.authorPhotoUrl).toBe('/p/u/00/00/58/90/32_50.jpg');
    expect(w8r.moderatorUserId).toBe(36096);
  });

  it('keeps deleted and blocked comments with their marks (AC-20)', () => {
    const raw = rawDetails('getbyid-62587.json');
    at(raw.comments, 0).is_deleted = true;
    at(raw.comments, 1).block = true;
    const place = okValue(normalizePlaceDetails(raw));
    expect(place.comments).toStrictEqual([
      { ...MATEJA, isDeleted: true },
      { ...SERBIA, isBlocked: true },
    ]);
  });

  it('keeps deleted and blocked replies with their marks (AC-20)', () => {
    const raw = nested();
    const serbia = at(at(raw.comments, 0).replies, 0);
    serbia.is_deleted = true;
    at(serbia.replies, 0).block = true;
    const place = okValue(normalizePlaceDetails(raw));
    const reply = at(at(place.comments, 0).replies, 0);
    expect(reply).toMatchObject({ author: 'Serbia', isDeleted: true, isBlocked: false });
    expect(at(reply.replies, 0)).toMatchObject({
      author: 'Paul',
      isDeleted: false,
      isBlocked: true,
    });
  });

  it('empty replies give [] (AC-21)', () => {
    const place = okValue(normalizePlaceDetails(rawDetails('getbyid-62587.json')));
    for (const comment of place.comments) expect(comment.replies).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Replies (nested fixture)
// ---------------------------------------------------------------------------

describe('replies (AC-42 .. AC-44, AC-47)', () => {
  const MATEJA_TREE: Comment = {
    ...MATEJA,
    replies: [{ ...SERBIA, replies: [PAUL] }],
  };

  it('normalises Mateja -> Serbia -> Paul fully through normalizePlaceDetails (AC-42, AC-43)', () => {
    const place = okValue(normalizePlaceDetails(nested()));
    expect(place.comments).toStrictEqual([MATEJA_TREE]);
  });

  it('normalises the same tree through normalizeComment directly', () => {
    expect(normalizeComment(at(nested().comments, 0))).toStrictEqual(MATEJA_TREE);
  });

  it("keeps the reply's own place_id (55) as is", () => {
    const place = okValue(normalizePlaceDetails(nested()));
    const paul = at(at(at(place.comments, 0).replies, 0).replies, 0);
    expect(paul.placeId).toBe(55);
  });

  it('keeps several replies in the order sent (AC-44)', () => {
    const raw = nested();
    const ramona = at(rawDetails('getbyid-55.json').comments, 0);
    at(raw.comments, 0).replies.push(ramona);
    const place = okValue(normalizePlaceDetails(raw));
    expect(at(place.comments, 0).replies.map((r) => r.author)).toStrictEqual(['Serbia', 'Ramona']);
  });

  it('normalises a 12-level chain to 12 levels (no depth limit), directly and via details', () => {
    const chain = commentChain(12);
    const direct = normalizeComment(chain);
    expect(depthOf(direct)).toBe(12);
    expect(CommentSchema.safeParse(direct).success).toBe(true);

    const raw = rawDetails('getbyid-62587.json');
    raw.comments = [commentChain(12)];
    const place = okValue(normalizePlaceDetails(raw));
    const top = at(place.comments, 0);
    expect(depthOf(top)).toBe(12);
    let level = top;
    while (level.replies.length > 0) {
      expect(level.author).toBe('Serbia');
      level = at(level.replies, 0);
    }
    expect(level).toStrictEqual(SERBIA);
  });

  it('keeps the full replies of a deleted and blocked parent (AC-47)', () => {
    const raw = nested();
    at(raw.comments, 0).is_deleted = true;
    at(raw.comments, 0).block = true;
    const place = okValue(normalizePlaceDetails(raw));
    expect(place.comments).toStrictEqual([{ ...MATEJA_TREE, isDeleted: true, isBlocked: true }]);
  });
});

// ---------------------------------------------------------------------------
// Allow-list (AC-16)
// ---------------------------------------------------------------------------

describe('allow-list construction (AC-16)', () => {
  it('drops unlisted keys at every level of a listing page', () => {
    const raw = rawBox('box-belgrade-page1.json');
    Object.assign(raw, { urlhtml: '<a>x</a>', zoom: 3, extra: true });
    const place = at(raw.folder, 0);
    Object.assign(place, { urlhtml: '<a>y</a>', pl: 1113, extra: 'e' });
    Object.assign(place.location, { gadm: [{ id: '1000' }], zoom: 16, extra: 1 });
    Object.assign(at(place.polygon, 0), { extra: 'p', z: 7 });

    const page = okValue(normalizeListingPage(raw));
    expect(keys(page)).toStrictEqual(LISTING_KEYS);
    for (const summary of page.places) {
      expect(keys(summary)).toStrictEqual(SUMMARY_KEYS);
      expect(keys(summary.location)).toStrictEqual(BOUNDS_KEYS);
      for (const point of summary.outline) expect(keys(point)).toStrictEqual(POINT_KEYS);
    }
    expect(at(page.places, 0)).toStrictEqual(PARK_SUMMARY);
  });

  it('drops unlisted keys at every level of place details (top, location, point, tag, comment, reply)', () => {
    const raw = nested();
    // Recorded extras already present: urlhtml, object_type, language_*, x, y, pl, gadm, zoom, ...
    Object.assign(raw, { extraItem: 'top' });
    Object.assign(raw.location, { extraItem: 'loc', street_id: '331907' });
    Object.assign(at(raw.polygon, 0), { extraItem: 'pt' });
    Object.assign(at(raw.tags, 0), { extraItem: 'tag', pl: 1 });
    const mateja = at(raw.comments, 0);
    Object.assign(mateja, { extraItem: 'comment', urlhtml: 'c' });
    const serbia = at(mateja.replies, 0);
    Object.assign(serbia, { extraItem: 'reply', pl: 2 });
    Object.assign(at(serbia.replies, 0), { extraItem: 'reply2', zoom: 9 });

    const place = okValue(normalizePlaceDetails(raw));
    expect(keys(place)).toStrictEqual([...DETAILS_REQUIRED_KEYS, 'wikipediaUrl'].sort());
    expect(keys(place.location)).toStrictEqual(
      [...BOUNDS_KEYS, 'city', 'country', 'place', 'state'].sort(),
    );
    for (const point of place.outline) expect(keys(point)).toStrictEqual(POINT_KEYS);
    for (const tag of place.tags) expect(keys(tag)).toStrictEqual(TAG_KEYS);

    const outMateja = at(place.comments, 0);
    expect(keys(outMateja)).toStrictEqual(COMMENT_REQUIRED_KEYS);
    const outSerbia = at(outMateja.replies, 0);
    expect(keys(outSerbia)).toStrictEqual([...COMMENT_REQUIRED_KEYS, 'authorPhotoUrl'].sort());
    const outPaul = at(outSerbia.replies, 0);
    expect(keys(outPaul)).toStrictEqual([...COMMENT_REQUIRED_KEYS, 'moderatorName'].sort());

    const json = JSON.stringify(place);
    for (const extra of [
      'urlhtml',
      'gadm',
      'zoom',
      'country_adm_id',
      'street_id',
      'city_id',
      'cityguideDomain',
      'object_type',
      'language_iso',
      'extraItem',
      '"pl"',
      '"x"',
      '"y"',
    ]) {
      expect(json).not.toContain(extra);
    }
  });

  it('builds location details with every optional key present for 55 and nothing else', () => {
    const place = okValue(normalizePlaceDetails(rawDetails('getbyid-55.json')));
    expect(keys(place.location)).toStrictEqual(
      [...BOUNDS_KEYS, 'city', 'country', 'houseNumber', 'place', 'state', 'street'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// No Commenter IPs (AC-11, AC-45)
// ---------------------------------------------------------------------------

describe('no Commenter IPs (AC-11, AC-45)', () => {
  it.each([['getbyid-62587.json'], ['getbyid-62587-nested-replies.json']] as const)(
    '%s with synthetic IPs: no IP key or value anywhere, authors kept',
    (name: FixtureName) => {
      const withIps = addCommenterIps(rawDetails(name));
      expect(withIps.comments.some((c) => c.user_ip !== undefined)).toBe(true);
      const place = okValue(normalizePlaceDetails(withIps));
      expect(findCommenterIpPaths(place)).toStrictEqual([]);
      const json = JSON.stringify(place);
      for (const ip of SYNTHETIC_IPS) expect(json).not.toContain(String(ip));
      for (const comment of place.comments) expect(comment.author).not.toBe('');
    },
  );

  it('keeps the authors Mateja, Serbia (62587) after dropping IPs', () => {
    const place = okValue(normalizePlaceDetails(addCommenterIps(rawDetails('getbyid-62587.json'))));
    expect(place.comments.map((c) => c.author)).toStrictEqual(['Mateja', 'Serbia']);
  });

  it('keeps the authors Mateja -> Serbia -> Paul (nested) after dropping IPs', () => {
    const place = okValue(normalizePlaceDetails(addCommenterIps(nested())));
    const mateja = at(place.comments, 0);
    const serbia = at(mateja.replies, 0);
    const paul = at(serbia.replies, 0);
    expect([mateja.author, serbia.author, paul.author]).toStrictEqual(['Mateja', 'Serbia', 'Paul']);
  });

  it('normalizeComment drops user_ip at every depth', () => {
    const withIps = addCommenterIps(nested());
    const comment = normalizeComment(at(withIps.comments, 0));
    expect(findCommenterIpPaths(comment)).toStrictEqual([]);
    const json = JSON.stringify(comment);
    for (const ip of SYNTHETIC_IPS) expect(json).not.toContain(String(ip));
    expect(comment.author).toBe('Mateja');
  });
});

// ---------------------------------------------------------------------------
// Semantic checks (AL4 1.4.6 table)
// ---------------------------------------------------------------------------

describe('semantic checks (AL4 1.4.6)', () => {
  const URL_MESSAGE = 'url is not the Wikimapia page link of this place';

  it.each([
    ['another place', 'http://wikimapia.org/62587/Square-of-the-Republic'],
    ['another host', 'http://example.org/1381893/University-Park'],
    ['a look-alike host', 'http://wikimapia.org.example.com/1381893/University-Park'],
  ])('box place url of %s gives ["folder",0,"url"]', (_, url) => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 0).url = url;
    expect(failIssues(normalizeListingPage(raw))).toStrictEqual([
      { path: ['folder', 0, 'url'], message: URL_MESSAGE },
    ]);
  });

  it('reports the url check with the index of the offending place', () => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 2).url = 'https://example.org/164369/';
    expect(failIssues(normalizeListingPage(raw))).toStrictEqual([
      { path: ['folder', 2, 'url'], message: URL_MESSAGE },
    ]);
  });

  it.each([[0], [101], ['0'], ['101']])('count %s gives ["count"]', (count) => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.count = count;
    expect(failIssues(normalizeListingPage(raw))).toStrictEqual([
      { path: ['count'], message: 'count must be between 1 and 100' },
    ]);
  });

  it.each([[1], [100]])('count %s is accepted', (count) => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.count = count;
    expect(okValue(normalizeListingPage(raw)).pageSize).toBe(count);
  });

  it.each([[0], ['0']])('page %s gives ["page"]', (pageValue) => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.page = pageValue;
    expect(failIssues(normalizeListingPage(raw))).toStrictEqual([
      { path: ['page'], message: 'page must be at least 1' },
    ]);
  });

  it('box place id above Number.MAX_SAFE_INTEGER gives ["folder",0,"id"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 0).id = UNSAFE_DIGITS;
    const issues = failIssues(normalizeListingPage(raw));
    expect(issues).toContainEqual({ path: ['folder', 0, 'id'], message: UNSAFE_MESSAGE });
  });

  it('unsafe found gives ["found"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.found = UNSAFE_DIGITS;
    expect(failIssues(normalizeListingPage(raw))).toStrictEqual([
      { path: ['found'], message: 'found is not a safe whole number' },
    ]);
  });

  it('unsafe details id gives ["id"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    raw.id = UNSAFE_DIGITS;
    expect(failIssues(normalizePlaceDetails(raw))).toStrictEqual([
      { path: ['id'], message: UNSAFE_MESSAGE },
    ]);
  });

  it('unsafe parent_id gives ["parent_id"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    raw.parent_id = UNSAFE_DIGITS;
    expect(failIssues(normalizePlaceDetails(raw))).toStrictEqual([
      { path: ['parent_id'], message: UNSAFE_MESSAGE },
    ]);
  });

  it('reports every failing check of a listing page together, with no partial value', () => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.page = 0;
    raw.count = 101;
    raw.found = UNSAFE_DIGITS;
    at(raw.folder, 1).url = 'http://example.org/62587/';
    const issues = failIssues(normalizeListingPage(raw));
    expect(issues).toHaveLength(4);
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: ['page'], message: 'page must be at least 1' },
        { path: ['count'], message: 'count must be between 1 and 100' },
        { path: ['found'], message: 'found is not a safe whole number' },
        { path: ['folder', 1, 'url'], message: URL_MESSAGE },
      ]),
    );
  });

  it('reports both failing checks of place details together', () => {
    const raw = rawDetails('getbyid-62587.json');
    raw.id = UNSAFE_DIGITS;
    raw.parent_id = UNSAFE_DIGITS;
    const issues = failIssues(normalizePlaceDetails(raw));
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: ['id'], message: UNSAFE_MESSAGE },
        { path: ['parent_id'], message: UNSAFE_MESSAGE },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Output gate: every success value passes the contract output schemas
// ---------------------------------------------------------------------------

describe('output gate: success values pass the contract schemas', () => {
  it.each([['box-belgrade-page1.json'], ['box-belgrade-empty-page.json']] as const)(
    '%s passes ListingPageSchema',
    (name: FixtureName) => {
      const page = okValue(normalizeListingPage(rawBox(name)));
      expect(ListingPageSchema.safeParse(page).success).toBe(true);
    },
  );

  it.each([
    ['getbyid-62587.json'],
    ['getbyid-1381893.json'],
    ['getbyid-55.json'],
    ['getbyid-62587-nested-replies.json'],
  ] as const)('%s passes PlaceDetailsSchema', (name: FixtureName) => {
    const place = okValue(normalizePlaceDetails(rawDetails(name)));
    expect(PlaceDetailsSchema.safeParse(place).success).toBe(true);
  });

  it('the 12-level chain passes PlaceDetailsSchema', () => {
    const raw = rawDetails('getbyid-62587.json');
    raw.comments = [commentChain(12)];
    const place = okValue(normalizePlaceDetails(raw));
    expect(PlaceDetailsSchema.safeParse(place).success).toBe(true);
  });

  it('a details value with parentPlaceId passes PlaceDetailsSchema', () => {
    const raw = rawDetails('getbyid-1381893.json');
    raw.parent_id = '7291521';
    const place = okValue(normalizePlaceDetails(raw));
    expect(PlaceDetailsSchema.safeParse(place).success).toBe(true);
  });
});
