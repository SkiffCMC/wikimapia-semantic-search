/**
 * AL5 CONTRACT TESTS: Place Store (custom validators and test inputs).
 *
 * Layer:    AL5 (Contracts). These tests do not import the Place Store and pass before AL2.
 * Derives:  docs/al6-requirements/20261021-storage-al6.md (the custom refinements and validators
 *           behind AC-13, AC-38, AC-39, AC-44, AC-46, AC-48, AC-59 and D6; AC-34 synthetic
 *           nesting; AC-62). Plain Zod rules (types, ranges, enums, strict objects, the Details
 *           Fetched At format) are exercised through the Place Store in ./storage.test.ts, not
 *           re-checked here.
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (no Commenter IPs, Wikimapia
 *           link kept, recorded fixtures only).
 */
import {
  DetailedPlaceSchema,
  SaveReportSchema,
  SavePlaceDetailsInputSchema,
  buildWikimapiaLink,
  findCommentRuleIssues,
  outlineShapeRing,
  type DetailedPlace,
  type StoredComment,
} from './storage.schema';
import { FETCHED_AT, at, clientDetails, nestedDetails, nestedParts } from './storage.support';
import {
  findCommenterIpPaths,
  isWikimapiaPlaceUrl,
  type Comment,
  type PlaceDetails,
  type Point,
} from './wikimapia-client.schema';

function stored(comment: Comment): StoredComment {
  return { ...comment, presence: 'present', replies: comment.replies.map(stored) };
}

async function detailedFrom62587(): Promise<DetailedPlace> {
  const d = await clientDetails('getbyid-62587.json');
  const { title, comments, tags, ...rest } = d;
  return {
    ...rest,
    status: 'detailed',
    name: title,
    wikimapiaUrl: buildWikimapiaLink(d.placeId),
    tags: tags.map((t) => ({ ...t, presence: 'present' as const })),
    comments: comments.map(stored),
    detailsFetchedAt: FETCHED_AT,
  };
}

/** AC-39 input: the AC-34 nesting with "Paul" (depth 2) reusing Serbia's number 2. */
async function duplicateAtDepth2(): Promise<PlaceDetails> {
  const { mateja, serbia, paul } = await nestedParts();
  const d = await nestedDetails();
  return {
    ...d,
    comments: [{ ...mateja, replies: [{ ...serbia, replies: [{ ...paul, num: 2 }] }] }],
  };
}

const DEPTH_2 = ['comments', 0, 'replies', 0, 'replies', 0] as const;

describe('Custom refinements and validators (pass before AL2)', () => {
  it('builds the D6 link http://wikimapia.org/<id>, a valid link of that place', () => {
    expect(buildWikimapiaLink(1381893)).toBe('http://wikimapia.org/1381893');
    expect(isWikimapiaPlaceUrl(buildWikimapiaLink(1381893), 1381893)).toBe(true);
  });

  it('a stored place must link to its own place (AC-59)', async () => {
    const place = await detailedFrom62587();
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    const r = DetailedPlaceSchema.safeParse({ ...place, wikimapiaUrl: 'http://wikimapia.org/55' });
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(['wikimapiaUrl']);
  });

  it('a save report lists each place once (AC-13)', () => {
    const once = { places: [{ placeId: 1, outcome: 'created' as const }] };
    expect(SaveReportSchema.safeParse(once).success).toBe(true);
    const twice = { places: [...once.places, { placeId: 1, outcome: 'updated' as const }] };
    expect(SaveReportSchema.safeParse(twice).success).toBe(false);
  });

  it.each([
    ['the valid AC-34 nesting', () => nestedDetails(), []],
    [
      'a comment of Place 55 at depth 2 (D5, AC-38)',
      () => clientDetails('getbyid-62587-nested-replies.json'),
      [{ path: [...DEPTH_2, 'placeId'], commentNum: 5, placeId: 55 }],
    ],
    [
      'a duplicated number at depth 2 (AC-39)',
      duplicateAtDepth2,
      [{ path: [...DEPTH_2, 'num'], commentNum: 2 }],
    ],
  ])('findCommentRuleIssues: %s', async (_name, load, expected) => {
    const issues = findCommentRuleIssues(await load());
    // toMatchObject on arrays: same length, each issue containing the expected fields.
    expect(issues).toMatchObject(expected);
  });

  it('the Details Save input reports comment rule issues under `details`', async () => {
    const nested = await nestedDetails();
    expect(
      SavePlaceDetailsInputSchema.safeParse({ details: nested, fetchedAt: FETCHED_AT }).success,
    ).toBe(true);
    const foreign = await clientDetails('getbyid-62587-nested-replies.json');
    const r = SavePlaceDetailsInputSchema.safeParse({ details: foreign, fetchedAt: FETCHED_AT });
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(['details', ...DEPTH_2, 'placeId']);
  });

  const a: Point = { lon: 1, lat: 1 };
  const b: Point = { lon: 2, lat: 1 };
  const c: Point = { lon: 2, lat: 2 };
  it.each([
    ['an open outline of 3 points is closed (AC-44)', [a, b, c], [a, b, c, a]],
    ['an already closed outline is kept (AC-46)', [a, b, c, a], [a, b, c, a]],
    ['2 points get none (D4, AC-48)', [a, b], undefined],
    ['no points get none (D4, AC-48)', [], undefined],
    ['a closed outline of 3 points (A, B, A) gets none', [a, b, a], undefined],
  ] as [string, Point[], Point[] | undefined][])('outlineShapeRing: %s', (_name, outline, ring) => {
    expect(outlineShapeRing(outline)).toStrictEqual(ring);
  });
});

describe('Test inputs: the Client reading of the fixtures matches AL6 section 0 (pass before AL2)', () => {
  it('the synthetic AC-34 nesting is Mateja #1 > Serbia #2 > Paul #5, all of Place 62587', async () => {
    const top = at((await nestedDetails()).comments, 0);
    const reply = at(top.replies, 0);
    const deepest = at(reply.replies, 0);
    expect([top, reply, deepest].map((x) => [x.author, x.num, x.placeId])).toStrictEqual([
      ['Mateja', 1, 62587],
      ['Serbia', 2, 62587],
      ['Paul', 5, 62587],
    ]);
  });

  it.each([
    ['getbyid-62587.json', () => clientDetails('getbyid-62587.json')],
    ['getbyid-55.json', () => clientDetails('getbyid-55.json')],
    ['getbyid-1381893.json', () => clientDetails('getbyid-1381893.json')],
    ['the synthetic nesting', () => nestedDetails()],
  ])('%s carries no Commenter IP (AC-62)', async (_name, load) => {
    expect(findCommenterIpPaths(await load())).toStrictEqual([]);
  });
});
