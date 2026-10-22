/**
 * AL5 CONTRACT TESTS: Place Store (schemas, validators and test inputs).
 *
 * Layer:    AL5 (Contracts). These tests do not import the Place Store and pass before AL2.
 * Derives:  docs/al6-requirements/20261021-storage-al6.md (boundary invariants behind AC-8,
 *           AC-15, AC-38, AC-39, AC-44, AC-46, AC-48, AC-49, AC-54, AC-55, AC-59; the facts of
 *           section 0 about the fixtures; AC-34 synthetic nesting; AC-62)
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (no Commenter IPs, Wikimapia
 *           link kept, recorded fixtures only).
 */
import {
  DetailedPlaceSchema,
  DetailsFetchedAtSchema,
  ENTRY_POINT,
  PlaceShapesSchema,
  SCHEMA_SETUP_ENTRY_POINT,
  SaveReportSchema,
  SavePlaceDetailsInputSchema,
  StoreFailureSchema,
  StoredCommentSchema,
  SummaryOnlyPlaceSchema,
  buildWikimapiaLink,
  findCommentRuleIssues,
  outlineShapeRing,
  type DetailedPlace,
  type StoredComment,
} from './storage.schema';
import {
  FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  asPlaceDetails,
  at,
  clientDetails,
  clientListing,
  nestedDetails,
  nestedParts,
  omitKeys,
} from './storage.support';
import {
  findCommenterIpPaths,
  isWikimapiaPlaceUrl,
  type Comment,
  type Point,
} from './wikimapia-client.schema';
import { SYNTHETIC_IPS } from './wikimapia-client.support';

function stored(comment: Comment, presence: 'present' | 'gone' = 'present'): StoredComment {
  return { ...comment, presence, replies: comment.replies.map((r) => stored(r, presence)) };
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
    comments: comments.map((c) => stored(c)),
    detailsFetchedAt: FETCHED_AT,
  };
}

describe('Schemas and validators (pass before AL2)', () => {
  it('names the entry points under src/db', () => {
    expect(ENTRY_POINT).toStrictEqual({
      module: 'src/db/place-store.ts',
      export: 'createPlaceStore',
    });
    expect(SCHEMA_SETUP_ENTRY_POINT).toStrictEqual({
      module: 'src/db/schema-setup.ts',
      export: 'createSchemaSetup',
    });
  });

  it('builds the D6 link http://wikimapia.org/<id>, which is a valid link of that place', () => {
    expect(buildWikimapiaLink(1381893)).toBe('http://wikimapia.org/1381893');
    expect(isWikimapiaPlaceUrl(buildWikimapiaLink(1381893), 1381893)).toBe(true);
  });

  it('Details Fetched At accepts only a whole-second UTC moment (AC-55)', () => {
    expect(DetailsFetchedAtSchema.safeParse('2026-10-21T10:00:00Z').success).toBe(true);
    for (const bad of [
      undefined,
      '',
      'yesterday',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-10-21T10:00:00.250Z',
      '2026-10-21T12:00:00+02:00',
      1761040800,
    ]) {
      expect(DetailsFetchedAtSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('a Detailed Place mirrors the Client shapes plus Presence Marks (AC-49) and round-trips (AC-18)', async () => {
    const place = DetailedPlaceSchema.parse(await detailedFrom62587());
    expect(asPlaceDetails(place)).toStrictEqual(await clientDetails('getbyid-62587.json'));
  });

  it('a Detailed Place must link to its own place (AC-59)', async () => {
    const place = await detailedFrom62587();
    expect(
      DetailedPlaceSchema.safeParse({ ...place, wikimapiaUrl: 'http://wikimapia.org/55' }).success,
    ).toBe(false);
    const noLink = omitKeys(place, 'wikimapiaUrl');
    expect(DetailedPlaceSchema.safeParse(noLink).success).toBe(false);
  });

  it('a stored comment needs a Presence Mark and an author, at any depth, and refuses Commenter IPs', async () => {
    const { mateja, serbia } = await nestedParts();
    const ok = stored({ ...mateja, replies: [serbia] });
    expect(StoredCommentSchema.safeParse(ok).success).toBe(true);
    const noPresence = omitKeys(at(ok.replies, 0), 'presence');
    expect(StoredCommentSchema.safeParse({ ...ok, replies: [noPresence] }).success).toBe(false);
    const noAuthor = omitKeys(at(ok.replies, 0), 'author');
    expect(StoredCommentSchema.safeParse({ ...ok, replies: [noAuthor] }).success).toBe(false);
    expect(
      StoredCommentSchema.safeParse({ ...ok, replies: [{ ...at(ok.replies, 0), user_ip: 1 }] })
        .success,
    ).toBe(false);
    expect(StoredCommentSchema.safeParse({ ...ok, presence: 'deleted' }).success).toBe(false);
  });

  it('a Summary-Only Place has no details items and no address (AC-8)', async () => {
    const summary = at((await clientListing('box-belgrade-page1.json')).places, 0);
    const place = {
      status: 'summary_only',
      placeId: summary.placeId,
      name: summary.name,
      wikimapiaUrl: summary.url,
      location: summary.location,
      outline: summary.outline,
      tags: [],
      comments: [],
    };
    expect(SummaryOnlyPlaceSchema.safeParse(place).success).toBe(true);
    expect(SummaryOnlyPlaceSchema.safeParse({ ...place, description: 'x' }).success).toBe(false);
    expect(
      SummaryOnlyPlaceSchema.safeParse({ ...place, detailsFetchedAt: FETCHED_AT }).success,
    ).toBe(false);
    expect(
      SummaryOnlyPlaceSchema.safeParse({
        ...place,
        location: { ...place.location, city: 'Belgrade' },
      }).success,
    ).toBe(false);
  });

  it('a save report lists each place once', () => {
    expect(
      SaveReportSchema.safeParse({ places: [{ placeId: 1, outcome: 'created' }] }).success,
    ).toBe(true);
    expect(
      SaveReportSchema.safeParse({
        places: [
          { placeId: 1, outcome: 'created' },
          { placeId: 1, outcome: 'updated' },
        ],
      }).success,
    ).toBe(false);
    expect(
      SaveReportSchema.safeParse({ places: [{ placeId: 1, outcome: 'deleted' }] }).success,
    ).toBe(false);
  });

  it('Store Failures are invalid_data (with issues) or store_unavailable, nothing else', () => {
    expect(
      StoreFailureSchema.safeParse({ kind: 'store_unavailable', message: 'down' }).success,
    ).toBe(true);
    expect(
      StoreFailureSchema.safeParse({
        kind: 'invalid_data',
        message: 'bad',
        issues: [{ path: ['placeId'], message: 'x' }],
      }).success,
    ).toBe(true);
    expect(
      StoreFailureSchema.safeParse({ kind: 'invalid_data', message: 'bad', issues: [] }).success,
    ).toBe(false);
    expect(StoreFailureSchema.safeParse({ kind: 'connection', message: 'x' }).success).toBe(false);
  });

  it('D5: a comment of another place is found at any depth with its number and place (AC-38)', async () => {
    const issues = findCommentRuleIssues(await clientDetails('getbyid-62587-nested-replies.json'));
    expect(issues).toStrictEqual([
      expect.objectContaining({
        path: ['comments', 0, 'replies', 0, 'replies', 0, 'placeId'],
        commentNum: 5,
        placeId: 55,
      }),
    ]);
  });

  it('a duplicated comment number is found at any depth (AC-39)', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const d = await nestedDetails();
    const issues = findCommentRuleIssues({
      ...d,
      comments: [{ ...mateja, replies: [{ ...serbia, replies: [{ ...paul, num: 2 }] }] }],
    });
    expect(issues).toStrictEqual([
      expect.objectContaining({
        path: ['comments', 0, 'replies', 0, 'replies', 0, 'num'],
        commentNum: 2,
      }),
    ]);
    expect(findCommentRuleIssues(d)).toStrictEqual([]);
  });

  it('the Details Save input refuses D5 and duplicate violations, Commenter IPs and a bad moment', async () => {
    const nested = await nestedDetails();
    expect(
      SavePlaceDetailsInputSchema.safeParse({ details: nested, fetchedAt: FETCHED_AT }).success,
    ).toBe(true);
    const foreign = await clientDetails('getbyid-62587-nested-replies.json');
    const r1 = SavePlaceDetailsInputSchema.safeParse({ details: foreign, fetchedAt: FETCHED_AT });
    expect(r1.error?.issues.map((i) => i.path)).toContainEqual([
      'details',
      'comments',
      0,
      'replies',
      0,
      'replies',
      0,
      'placeId',
    ]);
    const square = await clientDetails('getbyid-62587.json');
    const withIp = {
      ...square,
      comments: [{ ...at(square.comments, 0), user_ip: SYNTHETIC_IPS[0] }],
    };
    const r2 = SavePlaceDetailsInputSchema.safeParse({ details: withIp, fetchedAt: FETCHED_AT });
    expect(r2.success).toBe(false);
    expect(JSON.stringify(r2.error?.issues)).not.toContain(String(SYNTHETIC_IPS[0]));
    expect(SavePlaceDetailsInputSchema.safeParse({ details: square }).success).toBe(false);
  });

  it('Outline Shape ring: closed by repeating the first point; already closed kept; too small none (D4)', () => {
    const a: Point = { lon: 1, lat: 1 };
    const b: Point = { lon: 2, lat: 1 };
    const c: Point = { lon: 2, lat: 2 };
    expect(outlineShapeRing([a, b, c])).toStrictEqual([a, b, c, a]);
    expect(outlineShapeRing([a, b, c, a])).toStrictEqual([a, b, c, a]);
    expect(outlineShapeRing([a, b])).toBeUndefined();
    expect(outlineShapeRing([a])).toBeUndefined();
    expect(outlineShapeRing([])).toBeUndefined();
    expect(outlineShapeRing([a, b, a])).toBeUndefined();
  });

  it('stored shapes are WGS 84 and a polygon ring has at least 4 points', () => {
    const centrePoint = { type: 'Point', srid: 4326, point: { lon: 20.46, lat: 44.81 } };
    expect(PlaceShapesSchema.safeParse({ placeId: 1, centrePoint }).success).toBe(true);
    expect(
      PlaceShapesSchema.safeParse({ placeId: 1, centrePoint: { ...centrePoint, srid: 3857 } })
        .success,
    ).toBe(false);
    const tri = [
      { lon: 1, lat: 1 },
      { lon: 2, lat: 1 },
      { lon: 1, lat: 1 },
    ];
    expect(
      PlaceShapesSchema.safeParse({
        placeId: 1,
        centrePoint,
        outlineShape: { type: 'Polygon', srid: 4326, ring: tri },
      }).success,
    ).toBe(false);
  });

  it('the unreachable test connection string is synthetic and points at nothing real', () => {
    const url = new URL(UNREACHABLE_DATABASE_URL);
    expect(url.port).toBe('1');
    expect(url.hostname).toBe('127.0.0.1');
  });
});

describe('Test inputs: the Client reading of the fixtures matches AL6 section 0 (pass before AL2)', () => {
  it('the Belgrade listing holds 1381893, 62587, 164369 with their links', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    expect(page.places.map((p) => p.placeId)).toStrictEqual([1381893, 62587, 164369]);
    expect(at(page.places, 0).url).toBe('http://wikimapia.org/1381893/University-Park');
    expect(at(page.places, 0).outline).toHaveLength(4);
    expect((await clientListing('box-belgrade-empty-page.json')).places).toStrictEqual([]);
  });

  it('Place 62587 reads with the values AC-16 and AC-17 rely on', async () => {
    const d = await clientDetails('getbyid-62587.json');
    expect(d.title).toBe('Square of the Republic');
    expect(d.outline).toHaveLength(19);
    expect(d.location).toStrictEqual({
      lon: 20.4603516,
      lat: 44.8161006,
      north: 44.8167366,
      south: 44.8154647,
      east: 20.4612394,
      west: 20.4594638,
      country: 'Serbia and Montenegro',
      state: 'Central Serbia',
      place: 'Belgrade',
      city: 'Belgrade',
    });
    expect(d.comments.map((c) => [c.num, c.author, c.goodVotes, c.badVotes])).toStrictEqual([
      [1, 'Mateja', 5, 15],
      [2, 'Serbia', 33, 0],
    ]);
  });

  it('the synthetic AC-34 nesting carries Place ID 62587 everywhere and distinct numbers', async () => {
    const d = await nestedDetails();
    expect(findCommentRuleIssues(d)).toStrictEqual([]);
    const top = at(d.comments, 0);
    const reply = at(top.replies, 0);
    expect([top.author, reply.author, at(reply.replies, 0).author]).toStrictEqual([
      'Mateja',
      'Serbia',
      'Paul',
    ]);
    expect([top.num, reply.num, at(reply.replies, 0).num]).toStrictEqual([1, 2, 5]);
  });

  it('no input carries a Commenter IP', async () => {
    for (const details of [
      await clientDetails('getbyid-62587.json'),
      await clientDetails('getbyid-55.json'),
      await clientDetails('getbyid-1381893.json'),
      await nestedDetails(),
    ]) {
      expect(findCommenterIpPaths(details)).toStrictEqual([]);
    }
  });
});
