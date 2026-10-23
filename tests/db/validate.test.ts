/**
 * AL2 unit tests: `src/db/validate.ts` (AL4 1.3 `validate.ts` block, 1.4.4 Input validation).
 *
 * Pure. Inputs are the Client's reading of the recorded fixtures (contracts/storage.support.ts)
 * or small synthetic mutations of it. Every invalid case must give `ok: false`, a failure that
 * passes `InvalidDataFailureSchema`, and an issue whose path equals the expected one exactly
 * (AC-15, AC-38, AC-39, AC-51, AC-53 .. AC-55).
 * Extended by feature `hydration` (AL3 routing 20261022-hydration-03-store-read, 2.1 C):
 * `validatePlacesDueInput` and `validateCrawlProgressInput` (section 8).
 * Extended by feature `crawl-run1-fixes` (AL4 crawl-run1-fixes 1.3, 1.4.8; AL3 routing
 * 20261022-crawl-run1-fixes-03-failure-records, 2.1 D): `validateFailureRecord`,
 * `validateFailureRecordsInput` and `validateExplicitRetriesInput` (section 9).
 */
import {
  validateCrawlProgressInput,
  validateDetailsInput,
  validateExplicitRetriesInput,
  validateFailureRecord,
  validateFailureRecordsInput,
  validateListingInput,
  validatePlaceRef,
  validatePlacesDueInput,
  validateTagRef,
} from '../../src/db/validate';
import {
  InvalidDataFailureSchema,
  SaveListingPageInputSchema,
  SavePlaceDetailsInputSchema,
  type StoreFailure,
  type StoreIssue,
} from '../../contracts/storage.schema';
import {
  findCommenterIpPaths,
  type ListingPage,
  type PlaceDetails,
} from '../../contracts/wikimapia-client.schema';
import {
  FETCHED_AT,
  at,
  clientDetails,
  clientListing,
  nestedDetails,
  nestedParts,
  omitKeys,
  type NestedParts,
} from '../../contracts/storage.support';
import { SYNTHETIC_IPS } from '../../contracts/wikimapia-client.support';
import { RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import {
  ExplicitRetriesInputSchema,
  FailureRecordSchema,
  FailureRecordsInputSchema,
  type FailureRecord,
} from '../../contracts/crawl-run1-fixes.schema';

type AnyResult = { ok: true; value: unknown } | { ok: false; failure: StoreFailure };
type Path = (string | number)[];

/** The failure of a result that must be `invalid_data` (also checks the contract schema). */
function invalidOf(result: AnyResult) {
  if (result.ok) throw new Error('expected invalid_data, got ok');
  expect(InvalidDataFailureSchema.safeParse(result.failure).success).toBe(true);
  return InvalidDataFailureSchema.parse(result.failure);
}

function samePath(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** The issue at exactly `path`; fails the test when there is none. */
function issueAt(failure: { issues: StoreIssue[] }, path: Path): StoreIssue {
  const issue = failure.issues.find((i) => samePath(i.path, path));
  if (issue === undefined) {
    throw new Error(
      `no issue at ${JSON.stringify(path)}; got ${JSON.stringify(failure.issues.map((i) => i.path))}`,
    );
  }
  expect(issue.path).toStrictEqual(path);
  return issue;
}

function expectNoRuleKeys(issue: StoreIssue): void {
  expect(Object.hasOwn(issue, 'commentNum')).toBe(false);
  expect(Object.hasOwn(issue, 'placeId')).toBe(false);
}

let page: ListingPage;
let square: PlaceDetails;
let nested: PlaceDetails;
let parts: NestedParts;

beforeAll(async () => {
  page = await clientListing('box-belgrade-page1.json');
  square = await clientDetails('getbyid-62587.json');
  nested = await nestedDetails();
  parts = await nestedParts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. validateListingInput (AC-15, AC-53)
// ---------------------------------------------------------------------------

describe('validateListingInput', () => {
  it('a second summary with Place ID 0 names places[1].placeId', () => {
    const bad = {
      ...page,
      places: [at(page.places, 0), { ...at(page.places, 1), placeId: 0 }, at(page.places, 2)],
    };
    issueAt(invalidOf(validateListingInput(bad)), ['places', 1, 'placeId']);
  });

  it('a third summary linking to another place names places[2].url', () => {
    const bad = {
      ...page,
      places: [
        at(page.places, 0),
        at(page.places, 1),
        { ...at(page.places, 2), url: 'http://wikimapia.org/55/Eiffel-Tower' },
      ],
    };
    issueAt(invalidOf(validateListingInput(bad)), ['places', 2, 'url']);
  });

  it('longitude 200 names places[0].location.lon', () => {
    const first = at(page.places, 0);
    const bad = {
      ...page,
      places: [{ ...first, location: { ...first.location, lon: 200 } }, ...page.places.slice(1)],
    };
    issueAt(invalidOf(validateListingInput(bad)), ['places', 0, 'location', 'lon']);
  });

  it('undefined input is invalid_data at the whole input (path [])', () => {
    let result: AnyResult | undefined;
    expect(() => {
      result = validateListingInput(undefined);
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    issueAt(invalidOf(result), []);
  });

  it('the unmodified Belgrade page is ok and equals the parsed input', () => {
    const result = validateListingInput(page);
    expect(result).toStrictEqual({ ok: true, value: SaveListingPageInputSchema.parse(page) });
  });
});

// ---------------------------------------------------------------------------
// 2. validateDetailsInput: shape errors (AC-53)
// ---------------------------------------------------------------------------

describe('validateDetailsInput shape errors', () => {
  it('details without a title name details.title', () => {
    const input = { details: omitKeys(square, 'title'), fetchedAt: FETCHED_AT };
    const issue = issueAt(invalidOf(validateDetailsInput(input)), ['details', 'title']);
    expectNoRuleKeys(issue);
  });

  it('a second comment without its author names details.comments[1].author', () => {
    const noAuthor = omitKeys(at(square.comments, 1), 'author');
    const input = {
      details: { ...square, comments: [at(square.comments, 0), noAuthor] },
      fetchedAt: FETCHED_AT,
    };
    const issue = issueAt(invalidOf(validateDetailsInput(input)), [
      'details',
      'comments',
      1,
      'author',
    ]);
    expectNoRuleKeys(issue);
  });

  it('goodVotes 1.5 on Paul in the nested shape names its position inside Replies', () => {
    const { mateja, serbia, paul } = parts;
    const details = {
      ...nested,
      comments: [{ ...mateja, replies: [{ ...serbia, replies: [{ ...paul, goodVotes: 1.5 }] }] }],
    };
    const issue = issueAt(invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT })), [
      'details',
      'comments',
      0,
      'replies',
      0,
      'replies',
      0,
      'goodVotes',
    ]);
    expectNoRuleKeys(issue);
  });

  it('the valid 62587 details with FETCHED_AT are ok and the value equals the parsed input', () => {
    const input = { details: square, fetchedAt: FETCHED_AT };
    const result = validateDetailsInput(input);
    expect(result).toStrictEqual({ ok: true, value: SavePlaceDetailsInputSchema.parse(input) });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).not.toBe(input);
  });

  it('the valid nested (AC-34) details are ok', () => {
    expect(validateDetailsInput({ details: nested, fetchedAt: FETCHED_AT }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. validateDetailsInput: Details Fetched At (AC-55)
// ---------------------------------------------------------------------------

describe('validateDetailsInput fetchedAt', () => {
  it('a missing fetchedAt key names fetchedAt', () => {
    const issue = issueAt(invalidOf(validateDetailsInput({ details: square })), ['fetchedAt']);
    expectNoRuleKeys(issue);
  });

  it.each([
    ['undefined', undefined],
    ['not a moment', 'yesterday'],
    ['impossible date', '2026-13-01T00:00:00Z'],
    ['not UTC', '2026-10-21T12:00:00+02:00'],
    ['a number', 1761040800],
  ])('%s names fetchedAt', (_name, fetchedAt) => {
    const issue = issueAt(invalidOf(validateDetailsInput({ details: square, fetchedAt })), [
      'fetchedAt',
    ]);
    expectNoRuleKeys(issue);
  });
});

// ---------------------------------------------------------------------------
// 4. Comment-rule enrichment (AC-38, AC-39)
// ---------------------------------------------------------------------------

describe('validateDetailsInput comment-rule enrichment', () => {
  it('nested-replies fixture: Paul (place 55) carries commentNum 5 and placeId 55', async () => {
    const details = await clientDetails('getbyid-62587-nested-replies.json');
    const failure = invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT }));
    const path: Path = ['details', 'comments', 0, 'replies', 0, 'replies', 0, 'placeId'];
    const issue = issueAt(failure, path);
    expect(issue).toStrictEqual({
      path,
      message: expect.any(String) as unknown,
      commentNum: 5,
      placeId: 55,
    });
  });

  it('a top-level comment of another place carries commentNum 1 and placeId 55', () => {
    const foreign = { ...at(square.comments, 0), placeId: 55 };
    const details = { ...square, comments: [foreign, at(square.comments, 1)] };
    const failure = invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT }));
    const issue = issueAt(failure, ['details', 'comments', 0, 'placeId']);
    expect(issue.commentNum).toBe(1);
    expect(issue.placeId).toBe(55);
    expect(failure.issues.some((i) => i.commentNum === 1 && i.placeId === 55)).toBe(true);
  });

  it('a duplicate top-level number 2 gives an issue with commentNum 2 and no placeId key', () => {
    const dup = { ...at(square.comments, 0), num: 2 };
    const details = { ...square, comments: [dup, at(square.comments, 1)] };
    const failure = invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT }));
    expect(failure.issues.some((i) => i.commentNum === 2)).toBe(true);
    const issue = issueAt(failure, ['details', 'comments', 1, 'num']);
    expect(issue.commentNum).toBe(2);
    expect(Object.hasOwn(issue, 'placeId')).toBe(false);
  });

  it('Paul renumbered to 1 at depth 2 gives commentNum 1 at its num and no placeId key', () => {
    const { mateja, serbia, paul } = parts;
    const details = {
      ...nested,
      comments: [{ ...mateja, replies: [{ ...serbia, replies: [{ ...paul, num: 1 }] }] }],
    };
    const failure = invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT }));
    const issue = issueAt(failure, ['details', 'comments', 0, 'replies', 0, 'replies', 0, 'num']);
    expect(issue.commentNum).toBe(1);
    expect(Object.hasOwn(issue, 'placeId')).toBe(false);
  });

  it('issues that do not come from a comment rule have only path and message', () => {
    const input = {
      details: omitKeys(square, 'title', 'description'),
      fetchedAt: 'yesterday',
    };
    const failure = invalidOf(validateDetailsInput(input));
    expect(failure.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of failure.issues) {
      expect(Object.keys(issue).sort()).toStrictEqual(['message', 'path']);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Robustness (AC-53): never throws, issues never empty and capped at 20
// ---------------------------------------------------------------------------

describe('validateDetailsInput robustness', () => {
  const malformed: [string, () => unknown][] = [
    ['undefined', () => undefined],
    ['null', () => null],
    ['details is a string', () => ({ details: 'x' })],
    ['comments is a string', () => ({ details: { comments: 'x' } })],
    [
      'replies is not an array',
      () => ({
        details: { ...square, comments: [{ ...at(square.comments, 0), replies: 'x' }] },
        fetchedAt: FETCHED_AT,
      }),
    ],
  ];

  it.each(malformed)('%s: invalid_data, never throws, issues non-empty', (_name, build) => {
    const input = build();
    let result: AnyResult | undefined;
    expect(() => {
      result = validateDetailsInput(input);
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    const failure = invalidOf(result);
    expect(failure.issues.length).toBeGreaterThanOrEqual(1);
    expect(failure.issues.length).toBeLessThanOrEqual(20);
  });

  it('25 broken comments give at most 20 issues', () => {
    const base = at(square.comments, 0);
    const comments = Array.from({ length: 25 }, (_, i) =>
      omitKeys({ ...base, num: 100 + i }, 'author'),
    );
    const failure = invalidOf(
      validateDetailsInput({ details: { ...square, comments }, fetchedAt: FETCHED_AT }),
    );
    expect(failure.issues).toHaveLength(20);
  });

  it('a throwing safeParse becomes the fixed fallback issue at the whole input', () => {
    vi.spyOn(SavePlaceDetailsInputSchema, 'safeParse').mockImplementation(() => {
      throw new Error('refinement blew up');
    });
    let result: AnyResult | undefined;
    expect(() => {
      result = validateDetailsInput({ details: square, fetchedAt: FETCHED_AT });
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    const failure = invalidOf(result);
    expect(failure.issues).toStrictEqual([
      { path: [], message: 'input does not have the shape of a Details Save' },
    ]);
    expect(JSON.stringify(failure)).not.toContain('refinement blew up');
  });
});

// ---------------------------------------------------------------------------
// 6. No Commenter IP (AC-54)
// ---------------------------------------------------------------------------

describe('validateDetailsInput refuses Commenter IPs without echoing them', () => {
  it.each(['user_ip', 'userIp', 'commenterIp'])(
    'a reply to a reply carrying `%s` is invalid_data and the value is not echoed',
    (key) => {
      const { mateja, serbia, paul } = parts;
      const ip = SYNTHETIC_IPS[1];
      const details = {
        ...nested,
        comments: [{ ...mateja, replies: [{ ...serbia, replies: [{ ...paul, [key]: ip }] }] }],
      };
      expect(findCommenterIpPaths(details)).toHaveLength(1);
      const failure = invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT }));
      const text = JSON.stringify(failure);
      expect(text).not.toContain(String(ip));
      expect(text).not.toContain(String(Math.abs(ip)));
    },
  );

  it('a top-level comment with user_ip is invalid_data and the value is not echoed', () => {
    const ip = SYNTHETIC_IPS[0];
    const details = { ...square, comments: [{ ...at(square.comments, 0), user_ip: ip }] };
    const failure = invalidOf(validateDetailsInput({ details, fetchedAt: FETCHED_AT }));
    const text = JSON.stringify(failure);
    expect(text).not.toContain(String(ip));
    expect(text).not.toContain(String(Math.abs(ip)));
  });
});

// ---------------------------------------------------------------------------
// 7. validatePlaceRef / validateTagRef (AC-51)
// ---------------------------------------------------------------------------

describe('validatePlaceRef', () => {
  it.each([0, -3, 1.5, Number.NaN])('placeId %s names placeId', (placeId) => {
    const issue = issueAt(invalidOf(validatePlaceRef({ placeId })), ['placeId']);
    expectNoRuleKeys(issue);
  });

  it('placeId 62587 is ok', () => {
    expect(validatePlaceRef({ placeId: 62587 })).toStrictEqual({
      ok: true,
      value: { placeId: 62587 },
    });
  });

  it('undefined input is invalid_data and does not throw', () => {
    let result: AnyResult | undefined;
    expect(() => {
      result = validatePlaceRef(undefined);
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    invalidOf(result);
  });
});

describe('validateTagRef', () => {
  it('tagId -1 names tagId', () => {
    issueAt(invalidOf(validateTagRef({ tagId: -1 })), ['tagId']);
  });

  it('tagId 0 is ok', () => {
    expect(validateTagRef({ tagId: 0 })).toStrictEqual({ ok: true, value: { tagId: 0 } });
  });
});

// ---------------------------------------------------------------------------
// 8. validatePlacesDueInput / validateCrawlProgressInput (feature `hydration`; AL4 hydration
//    1.3, 1.4.11; AL3 routing 20261022-hydration-03-store-read, section 2.1 C)
// ---------------------------------------------------------------------------

describe('validatePlacesDueInput', () => {
  it('a valid input is ok with a value equal to the input', () => {
    const input = { bbox: { ...SMALL_BBOX }, dueBefore: RUN_START };
    expect(validatePlacesDueInput(input)).toStrictEqual({
      ok: true,
      value: { bbox: SMALL_BBOX, dueBefore: RUN_START },
    });
  });

  it('the value is a fresh object: mutating it leaves the input unchanged', () => {
    const input = { bbox: { ...SMALL_BBOX }, dueBefore: RUN_START };
    const result = validatePlacesDueInput(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).not.toBe(input);
    result.value.dueBefore = '2000-01-01T00:00:00Z';
    result.value.bbox.west = 0;
    expect(input).toStrictEqual({ bbox: SMALL_BBOX, dueBefore: RUN_START });
  });

  it("dueBefore 'yesterday' names dueBefore and does not echo the value", () => {
    const failure = invalidOf(validatePlacesDueInput({ bbox: SMALL_BBOX, dueBefore: 'yesterday' }));
    issueAt(failure, ['dueBefore']);
    expect(failure.message).not.toContain('yesterday');
    expect(JSON.stringify(failure)).not.toContain('yesterday');
  });

  it('dueBefore with milliseconds names dueBefore', () => {
    const failure = invalidOf(
      validatePlacesDueInput({ bbox: SMALL_BBOX, dueBefore: '2026-10-22T09:00:00.000Z' }),
    );
    issueAt(failure, ['dueBefore']);
  });

  it('a reversed bbox is reported at a path under bbox', () => {
    const reversed = { ...SMALL_BBOX, west: SMALL_BBOX.east, east: SMALL_BBOX.west };
    const failure = invalidOf(validatePlacesDueInput({ bbox: reversed, dueBefore: RUN_START }));
    const underBbox = failure.issues.filter((i) => i.path[0] === 'bbox' && i.path.length >= 2);
    expect(underBbox.length).toBeGreaterThanOrEqual(1);
  });

  it('a missing bbox names bbox', () => {
    issueAt(invalidOf(validatePlacesDueInput({ dueBefore: RUN_START })), ['bbox']);
  });

  it('a missing dueBefore names dueBefore', () => {
    issueAt(invalidOf(validatePlacesDueInput({ bbox: SMALL_BBOX })), ['dueBefore']);
  });

  it('an extra key is invalid_data', () => {
    invalidOf(validatePlacesDueInput({ bbox: SMALL_BBOX, dueBefore: RUN_START, limit: 3 }));
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', [SMALL_BBOX, RUN_START]],
  ])('%s is invalid_data and does not throw', (_label, input) => {
    let result: AnyResult | undefined;
    expect(() => {
      result = validatePlacesDueInput(input);
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    invalidOf(result);
  });
});

describe('validateCrawlProgressInput', () => {
  it("{ regionName: 'test-one' } is ok", () => {
    expect(validateCrawlProgressInput({ regionName: 'test-one' })).toStrictEqual({
      ok: true,
      value: { regionName: 'test-one' },
    });
  });

  it('the value is a fresh object', () => {
    const input = { regionName: 'test-one' };
    const result = validateCrawlProgressInput(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).not.toBe(input);
  });

  it.each(['Belgrade', '', '-a', 'a--b', 'a b', 'a-'])(
    'regionName %j names regionName',
    (regionName) => {
      issueAt(invalidOf(validateCrawlProgressInput({ regionName })), ['regionName']);
    },
  );

  it('a number names regionName', () => {
    issueAt(invalidOf(validateCrawlProgressInput({ regionName: 7 })), ['regionName']);
  });

  it('a missing key names regionName', () => {
    issueAt(invalidOf(validateCrawlProgressInput({})), ['regionName']);
  });

  it('an extra key is invalid_data', () => {
    invalidOf(validateCrawlProgressInput({ regionName: 'test-one', extra: true }));
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'test-one'],
  ])('%s is invalid_data and does not throw', (_label, input) => {
    let result: AnyResult | undefined;
    expect(() => {
      result = validateCrawlProgressInput(input);
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    invalidOf(result);
  });
});

describe('crawl input validators robustness', () => {
  function throwingGetter(key: string, rest: Record<string, string>): object {
    const input = { ...rest };
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        throw new Error('getter blew up');
      },
    });
    return input;
  }

  function hostileProxy(): object {
    return new Proxy(
      {},
      {
        get() {
          throw new Error('proxy blew up');
        },
        has() {
          throw new Error('proxy blew up');
        },
        ownKeys() {
          throw new Error('proxy blew up');
        },
        getOwnPropertyDescriptor() {
          throw new Error('proxy blew up');
        },
        getPrototypeOf() {
          throw new Error('proxy blew up');
        },
      },
    );
  }

  const cases: [string, (input: unknown) => AnyResult, () => unknown][] = [
    [
      'validatePlacesDueInput, throwing bbox getter',
      validatePlacesDueInput,
      () => throwingGetter('bbox', { dueBefore: RUN_START }),
    ],
    [
      'validatePlacesDueInput, throwing dueBefore getter',
      validatePlacesDueInput,
      () => throwingGetter('dueBefore', {}),
    ],
    ['validatePlacesDueInput, hostile Proxy', validatePlacesDueInput, hostileProxy],
    [
      'validateCrawlProgressInput, throwing regionName getter',
      validateCrawlProgressInput,
      () => throwingGetter('regionName', {}),
    ],
    ['validateCrawlProgressInput, hostile Proxy', validateCrawlProgressInput, hostileProxy],
  ];

  it.each(cases)('%s: invalid_data, never throws, no error text', (_label, validate, build) => {
    const input = build();
    let result: AnyResult | undefined;
    expect(() => {
      result = validate(input);
    }).not.toThrow();
    if (result === undefined) throw new Error('no result');
    const failure = invalidOf(result);
    expect(failure.issues.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(failure)).not.toContain('blew up');
  });
});

// ---------------------------------------------------------------------------
// 9. validateFailureRecord / validateFailureRecordsInput / validateExplicitRetriesInput
//    (feature `crawl-run1-fixes`; AL4 crawl-run1-fixes 1.3, 1.4.8; AL3 routing
//    20261022-crawl-run1-fixes-03-failure-records, section 2.1 D)
// ---------------------------------------------------------------------------

const VALID_PLACE_RECORD: FailureRecord = {
  runId: 7,
  item: { kind: 'place_details', placeId: 900 },
  failureKind: 'wikimapia_error',
  message: 'Place 900: Wikimapia error: synthetic failure',
  failedAt: '2026-10-22T10:00:00Z',
};

const VALID_LISTING_RECORD: FailureRecord = {
  runId: 7,
  item: { kind: 'listing_page', tileNumber: 3, page: 2 },
  failureKind: 'connection',
  message: 'Tile 3 page 2: connection failure: synthetic',
  failedAt: '2026-10-22T10:00:05Z',
};

/** Distinct values that must never appear in a failure. */
const SECRET_EXTRA = 'synthetic-extra-value';
const SUB_SECOND = '2026-10-22T10:00:00.500Z';

const NOT_OBJECTS: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'synthetic-string-input'],
  ['an array', [VALID_PLACE_RECORD]],
  ['a number', 42],
];

function expectNoThrow(validate: (input: unknown) => AnyResult, input: unknown): AnyResult {
  let result: AnyResult | undefined;
  expect(() => {
    result = validate(input);
  }).not.toThrow();
  if (result === undefined) throw new Error('no result');
  return result;
}

describe('validateFailureRecord', () => {
  it.each([
    ['a Place record', VALID_PLACE_RECORD],
    ['a listing record', VALID_LISTING_RECORD],
  ])('%s is ok with a value equal to the parsed input', (_label, input) => {
    expect(validateFailureRecord(input)).toStrictEqual({
      ok: true,
      value: FailureRecordSchema.parse(input),
    });
  });

  it('the value is a fresh object', () => {
    const input = { ...VALID_PLACE_RECORD, item: { ...VALID_PLACE_RECORD.item } };
    const result = validateFailureRecord(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).not.toBe(input);
    expect(result.value).toStrictEqual(VALID_PLACE_RECORD);
  });

  const invalid: [string, unknown, Path][] = [
    ['an empty message', { ...VALID_PLACE_RECORD, message: '' }, ['message']],
    ['a sub-second failedAt', { ...VALID_PLACE_RECORD, failedAt: SUB_SECOND }, ['failedAt']],
    ['failedAt not a moment', { ...VALID_PLACE_RECORD, failedAt: 'yesterday' }, ['failedAt']],
    [
      'failureKind key_quota_exhausted',
      { ...VALID_PLACE_RECORD, failureKind: 'key_quota_exhausted' },
      ['failureKind'],
    ],
    ['an extra key', { ...VALID_PLACE_RECORD, extra: SECRET_EXTRA }, []],
    [
      'an item with both shapes\u2019 keys',
      { ...VALID_PLACE_RECORD, item: { kind: 'place_details', placeId: 900, tileNumber: 1, page: 1 } },
      ['item'],
    ],
    [
      'placeId 0',
      { ...VALID_PLACE_RECORD, item: { kind: 'place_details', placeId: 0 } },
      ['item', 'placeId'],
    ],
    ['runId 0', { ...VALID_PLACE_RECORD, runId: 0 }, ['runId']],
    ['a missing message', omitKeys(VALID_PLACE_RECORD, 'message'), ['message']],
  ];

  it.each(invalid)('%s is invalid_data with the issue path', (_label, input, path) => {
    const failure = invalidOf(expectNoThrow(validateFailureRecord, input));
    issueAt(failure, path);
  });

  it('the failures never contain the input values', () => {
    for (const [, input] of invalid) {
      const text = JSON.stringify(invalidOf(expectNoThrow(validateFailureRecord, input)));
      expect(text).not.toContain(SECRET_EXTRA);
      expect(text).not.toContain('10:00:00.500');
      expect(text).not.toContain('synthetic failure');
      expect(text).not.toContain('key_quota_exhausted');
    }
  });

  it.each(NOT_OBJECTS)('%s is invalid_data and does not throw', (_label, input) => {
    const failure = invalidOf(expectNoThrow(validateFailureRecord, input));
    expect(failure.issues.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(failure)).not.toContain('synthetic-string-input');
  });
});

describe('validateFailureRecordsInput', () => {
  it.each([
    ['by Place', { placeId: 900 }],
    ['by Run', { runId: 7 }],
  ])('%s is ok with a value equal to the parsed input', (_label, input) => {
    expect(validateFailureRecordsInput(input)).toStrictEqual({
      ok: true,
      value: FailureRecordsInputSchema.parse(input),
    });
  });

  it('the value is a fresh object', () => {
    const input = { placeId: 900 };
    const result = validateFailureRecordsInput(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).not.toBe(input);
  });

  it.each([
    ['placeId 0', { placeId: 0 }, ['placeId']],
    ['placeId 1.5', { placeId: 1.5 }, ['placeId']],
    ['runId -1', { runId: -1 }, ['runId']],
  ] as const)('%s is invalid_data with the issue path', (_label, input, path) => {
    issueAt(invalidOf(expectNoThrow(validateFailureRecordsInput, input)), [...path]);
  });

  it.each([
    ['{}', {}],
    ['both placeId and runId', { placeId: 1, runId: 1 }],
    ['an extra key', { placeId: 1, extra: SECRET_EXTRA }],
    ['placeId as text', { placeId: '900' }],
  ])('%s is invalid_data', (_label, input) => {
    const failure = invalidOf(expectNoThrow(validateFailureRecordsInput, input));
    expect(failure.issues.length).toBeGreaterThanOrEqual(1);
  });

  it('the failures never contain the input values', () => {
    for (const input of [{ placeId: 1.5 }, { placeId: 1, extra: SECRET_EXTRA }]) {
      const text = JSON.stringify(invalidOf(expectNoThrow(validateFailureRecordsInput, input)));
      expect(text).not.toContain('1.5');
      expect(text).not.toContain(SECRET_EXTRA);
    }
  });

  it.each(NOT_OBJECTS)('%s is invalid_data and does not throw', (_label, input) => {
    invalidOf(expectNoThrow(validateFailureRecordsInput, input));
  });
});

describe('validateExplicitRetriesInput', () => {
  it("{ regionName: 'test-one' } is ok with a value equal to the parsed input", () => {
    const input = { regionName: 'test-one' };
    expect(validateExplicitRetriesInput(input)).toStrictEqual({
      ok: true,
      value: ExplicitRetriesInputSchema.parse(input),
    });
  });

  it('the value is a fresh object', () => {
    const input = { regionName: 'test-one' };
    const result = validateExplicitRetriesInput(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).not.toBe(input);
  });

  it.each([
    ['uppercase', { regionName: 'Test-One' }],
    ['empty', { regionName: '' }],
    ['missing', {}],
    ['a number', { regionName: 7 }],
  ])('regionName %s names regionName', (_label, input) => {
    issueAt(invalidOf(expectNoThrow(validateExplicitRetriesInput, input)), ['regionName']);
  });

  it('an extra key is invalid_data and does not echo its value', () => {
    const failure = invalidOf(
      expectNoThrow(validateExplicitRetriesInput, { regionName: 'test-one', extra: SECRET_EXTRA }),
    );
    expect(JSON.stringify(failure)).not.toContain(SECRET_EXTRA);
  });

  it('an uppercase Region Name is not echoed', () => {
    const failure = invalidOf(expectNoThrow(validateExplicitRetriesInput, { regionName: 'Test-One' }));
    expect(JSON.stringify(failure)).not.toContain('Test-One');
  });

  it.each(NOT_OBJECTS)('%s is invalid_data and does not throw', (_label, input) => {
    invalidOf(expectNoThrow(validateExplicitRetriesInput, input));
  });
});
