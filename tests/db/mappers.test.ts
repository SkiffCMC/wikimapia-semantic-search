/**
 * AL2 unit tests: `src/db/mappers.ts` (AL4 1.3 `mappers.ts` block, 1.4.6 `flattenComments`,
 * 1.4.8 Read-back, 2.2 .. 2.5; AC-8, AC-16 .. AC-19, AC-34 .. AC-36, AC-49, AC-52, AC-59,
 * AC-66, AC-67, AC-71, AC-72 on the mapping side).
 *
 * Pure. Inputs are the Client's reading of the recorded fixtures (`contracts/storage.support`)
 * or small synthetic values. Synthetic DB rows are plain objects passed through the row schemas
 * of `src/db/rows`, so every row used here is a valid row. No database, no network.
 */
import {
  buildStoredComments,
  commentColumns,
  decodeOutline,
  detailsColumns,
  encodeOutline,
  flattenComments,
  orderStoredTags,
  summaryColumns,
  toDetailedPlace,
  toSummaryOnlyPlace,
} from '../../src/db/mappers';
import { CommentRowSchema, PlaceRowSchema, TagLinkRowSchema } from '../../src/db/rows';
import type { CommentRow, PlaceRow, TagLinkRow } from '../../src/db/types';
import {
  DetailedPlaceSchema,
  StoredCommentSchema,
  StoredTagSchema,
  SummaryOnlyPlaceSchema,
  buildWikimapiaLink,
} from '../../contracts/storage.schema';
import type { StoredComment } from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  asPlaceDetails,
  clientDetails,
  clientListing,
  flattenComments as flattenStored,
  levelOrder,
  nestedDetails,
  nestedParts,
  omitKeys,
  rehome,
  storedNum,
  summaryOf,
} from '../../contracts/storage.support';
import type { Comment, PlaceDetails, Point } from '../../contracts/wikimapia-client.schema';

type Presence = 'present' | 'gone';

const PLACE = 62587;

const CLOSED_OUTLINE: Point[] = [
  { lon: 20.456688, lat: 44.8198 },
  { lon: 20.457444, lat: 44.820321 },
  { lon: 20.459064, lat: 44.819145 },
  { lon: 20.456688, lat: 44.8198 },
];

/** A valid `comments` row for a Comment (AL4 2.4 columns), built by hand. */
function commentRow(
  c: Comment,
  parentNum: number | null,
  presence: Presence,
  position: number | null,
): CommentRow {
  return CommentRowSchema.parse({
    place_id: c.placeId,
    num: c.num,
    parent_num: parentNum,
    lang_id: c.langId,
    author: c.author,
    author_user_id: c.authorUserId,
    author_photo_url: c.authorPhotoUrl ?? null,
    message: c.message,
    good_votes: c.goodVotes,
    bad_votes: c.badVotes,
    is_blocked: c.isBlocked,
    is_deleted: c.isDeleted,
    posted_at_epoch_seconds: c.postedAtEpochSeconds,
    moderator_user_id: c.moderatorUserId,
    moderator_name: c.moderatorName ?? null,
    presence,
    position,
  });
}

/** The expected stored node for a Comment. */
function stored(c: Comment, presence: Presence, replies: StoredComment[] = []): StoredComment {
  return { ...c, presence, replies };
}

function tagRow(
  tagId: number,
  title: string,
  presence: Presence,
  position: number | null,
): TagLinkRow {
  return TagLinkRowSchema.parse({ place_id: PLACE, tag_id: tagId, presence, position, title });
}

/** A detailed `places` row as the read query returns it, built from a Client reading. */
function detailedRow(d: PlaceDetails, fetchedAtText: string | null = FETCHED_AT): PlaceRow {
  return PlaceRowSchema.parse({
    place_id: d.placeId,
    wikimapia_url: buildWikimapiaLink(d.placeId),
    ...detailsColumns(d, FETCHED_AT),
    details_fetched_at_text: fetchedAtText,
  });
}

function linkRows(d: PlaceDetails): TagLinkRow[] {
  return d.tags.map((t, i) =>
    TagLinkRowSchema.parse({
      place_id: d.placeId,
      tag_id: t.id,
      presence: 'present',
      position: i,
      title: t.title,
    }),
  );
}

function presentCommentRows(d: PlaceDetails): CommentRow[] {
  return flattenComments(d.comments).map((flat) =>
    CommentRowSchema.parse(commentColumns(d.placeId, flat)),
  );
}

/** Deterministic shuffle so that row order never matches the expected order. */
function scrambled<T>(items: readonly T[]): T[] {
  const odd = items.filter((_x, i) => i % 2 === 1);
  const even = items.filter((_x, i) => i % 2 === 0);
  return [...odd.reverse(), ...even];
}

const DETAILS_KEYS = [
  'address_city',
  'address_country',
  'address_house_number',
  'address_place',
  'address_state',
  'address_street',
  'bound_east',
  'bound_north',
  'bound_south',
  'bound_west',
  'description',
  'details_fetched_at',
  'is_building',
  'is_deleted',
  'is_region',
  'location_lat',
  'location_lon',
  'name',
  'outline',
  'parent_place_id',
  'wikipedia_url',
];

const ADDRESS_KEYS = ['street', 'houseNumber', 'city', 'place', 'state', 'country'] as const;

function withEveryOptional(d: PlaceDetails): PlaceDetails {
  return {
    ...d,
    parentPlaceId: 1381893,
    wikipediaUrl: 'https://en.wikipedia.org/wiki/Republic_Square_(Belgrade)',
    location: {
      ...d.location,
      street: 'Trg Republike',
      houseNumber: '1a',
      city: 'Belgrade',
      place: 'Stari Grad',
      state: 'Central Serbia',
      country: 'Serbia',
    },
  };
}

function withoutAnyOptional(d: PlaceDetails): PlaceDetails {
  return {
    ...omitKeys(d, 'parentPlaceId', 'wikipediaUrl'),
    location: omitKeys(d.location, ...ADDRESS_KEYS),
  };
}

// ---------------------------------------------------------------------------
// 1. Outline encoding
// ---------------------------------------------------------------------------

describe('encodeOutline / decodeOutline', () => {
  it('encodes [[lon, lat], ...] in order', async () => {
    const d = await clientDetails('getbyid-62587.json');
    expect(encodeOutline(d.outline)).toStrictEqual(d.outline.map((p) => [p.lon, p.lat]));
    expect(encodeOutline(CLOSED_OUTLINE)).toStrictEqual([
      [20.456688, 44.8198],
      [20.457444, 44.820321],
      [20.459064, 44.819145],
      [20.456688, 44.8198],
    ]);
  });

  it('round-trips the 62587 outline, an empty outline and a closed outline (AC-46, AC-48)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    expect(d.outline).toHaveLength(19);
    for (const outline of [d.outline, [], CLOSED_OUTLINE]) {
      expect(decodeOutline(encodeOutline(outline))).toStrictEqual(outline);
    }
    expect(decodeOutline(encodeOutline(CLOSED_OUTLINE))).toHaveLength(4);
  });

  it('returns new arrays', () => {
    const encoded = encodeOutline(CLOSED_OUTLINE);
    expect(encoded).not.toBe(CLOSED_OUTLINE);
    const decoded = decodeOutline(encoded);
    expect(decoded).not.toBe(encoded);
    expect(CLOSED_OUTLINE).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 2. summaryColumns
// ---------------------------------------------------------------------------

describe('summaryColumns (AC-8)', () => {
  it('maps summary 164369 to exactly the nine summary columns', async () => {
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), 164369);
    const columns = summaryColumns(summary);
    expect(Object.keys(columns).sort()).toStrictEqual(
      [
        'name',
        'wikimapia_url',
        'location_lon',
        'location_lat',
        'bound_north',
        'bound_south',
        'bound_east',
        'bound_west',
        'outline',
      ].sort(),
    );
    expect(columns).toStrictEqual({
      name: summary.name,
      wikimapia_url: summary.url,
      location_lon: summary.location.lon,
      location_lat: summary.location.lat,
      bound_north: summary.location.north,
      bound_south: summary.location.south,
      bound_east: summary.location.east,
      bound_west: summary.location.west,
      outline: encodeOutline(summary.outline),
    });
  });

  it('keeps the Listing Link unchanged and has no place_id, geometry or details keys', async () => {
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), 164369);
    const columns = summaryColumns(summary);
    expect(columns.wikimapia_url).toBe(summary.url);
    for (const key of [
      'place_id',
      'centre_point',
      'outline_shape',
      'description',
      'details_fetched_at',
      'is_building',
      'parent_place_id',
      'address_street',
    ]) {
      expect(Object.hasOwn(columns, key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. detailsColumns
// ---------------------------------------------------------------------------

describe('detailsColumns', () => {
  it('maps the 62587 reading one to one, absent items as null', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const columns = detailsColumns(d, FETCHED_AT);
    expect(Object.keys(columns).sort()).toStrictEqual(DETAILS_KEYS);
    expect(columns).toStrictEqual({
      name: d.title,
      description: d.description,
      is_building: d.isBuilding,
      is_region: d.isRegion,
      is_deleted: d.isDeleted,
      parent_place_id: d.parentPlaceId ?? null,
      wikipedia_url: d.wikipediaUrl ?? null,
      location_lon: d.location.lon,
      location_lat: d.location.lat,
      bound_north: d.location.north,
      bound_south: d.location.south,
      bound_east: d.location.east,
      bound_west: d.location.west,
      address_street: d.location.street ?? null,
      address_house_number: d.location.houseNumber ?? null,
      address_city: d.location.city ?? null,
      address_place: d.location.place ?? null,
      address_state: d.location.state ?? null,
      address_country: d.location.country ?? null,
      outline: encodeOutline(d.outline),
      details_fetched_at: FETCHED_AT,
    });
  });

  it('keeps every optional key present with null when the item is absent (AC-24)', async () => {
    const d = withoutAnyOptional(await clientDetails('getbyid-62587.json'));
    const columns = detailsColumns(d, FETCHED_AT);
    expect(Object.keys(columns).sort()).toStrictEqual(DETAILS_KEYS);
    for (const key of [
      'parent_place_id',
      'wikipedia_url',
      'address_street',
      'address_house_number',
      'address_city',
      'address_place',
      'address_state',
      'address_country',
    ] as const) {
      expect(Object.hasOwn(columns, key)).toBe(true);
      expect(columns[key]).toBeNull();
    }
  });

  it('maps every optional item when set; houseNumber goes to address_house_number', async () => {
    const d = withEveryOptional(await clientDetails('getbyid-62587.json'));
    const columns = detailsColumns(d, FETCHED_AT);
    expect(columns.parent_place_id).toBe(1381893);
    expect(columns.wikipedia_url).toBe('https://en.wikipedia.org/wiki/Republic_Square_(Belgrade)');
    expect(columns.address_street).toBe('Trg Republike');
    expect(columns.address_house_number).toBe('1a');
    expect(columns.address_city).toBe('Belgrade');
    expect(columns.address_place).toBe('Stari Grad');
    expect(columns.address_state).toBe('Central Serbia');
    expect(columns.address_country).toBe('Serbia');
  });

  it('has no place_id, wikimapia_url or geometry keys', async () => {
    const columns = detailsColumns(await clientDetails('getbyid-62587.json'), FETCHED_AT);
    for (const key of ['place_id', 'wikimapia_url', 'centre_point', 'outline_shape']) {
      expect(Object.hasOwn(columns, key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. flattenComments (src/db/mappers)
// ---------------------------------------------------------------------------

describe('flattenComments (AC-34, AC-36)', () => {
  it('Mateja > Serbia > Paul gives pre-order with parents null, 1, 2 and positions 0', async () => {
    const d = await nestedDetails();
    const flat = flattenComments(d.comments);
    expect(flat.map((f) => f.comment.num)).toStrictEqual([1, 2, 5]);
    expect(flat.map((f) => f.parentNum)).toStrictEqual([null, 1, 2]);
    expect(flat.map((f) => f.position)).toStrictEqual([0, 0, 0]);
  });

  it('several replies keep the given order with positions 0..n-1 (AC-36)', async () => {
    const { mateja, serbia, ramona, paul } = await nestedParts();
    const flat = flattenComments([{ ...mateja, replies: [serbia, ramona, paul] }]);
    expect(flat.map((f) => f.comment.num)).toStrictEqual([1, 2, 7, 5]);
    expect(flat.map((f) => f.position)).toStrictEqual([0, 0, 1, 2]);
    expect(flat.map((f) => f.parentNum)).toStrictEqual([null, 1, 1, 1]);
  });

  it('top-level siblings get positions 0..n-1 and parent null', async () => {
    const { mateja } = await nestedParts();
    const comments = [4, 2, 9].map((n) => rehome(mateja, PLACE, n));
    const flat = flattenComments(comments);
    expect(flat.map((f) => f.comment.num)).toStrictEqual([4, 2, 9]);
    expect(flat.map((f) => f.position)).toStrictEqual([0, 1, 2]);
    expect(flat.map((f) => f.parentNum)).toStrictEqual([null, null, null]);
  });

  it('an empty list gives []', () => {
    expect(flattenComments([])).toStrictEqual([]);
  });

  it('never mutates its input', async () => {
    const d = await nestedDetails();
    const copy = structuredClone(d.comments);
    flattenComments(d.comments);
    expect(d.comments).toStrictEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// 5. commentColumns
// ---------------------------------------------------------------------------

describe('commentColumns', () => {
  it('gives the AL4 2.4 columns, presence present, parent and position from the flat item', async () => {
    const { serbia } = await nestedParts();
    const columns = commentColumns(PLACE, { comment: serbia, parentNum: 1, position: 3 });
    expect(columns).toStrictEqual({
      place_id: PLACE,
      num: serbia.num,
      parent_num: 1,
      lang_id: serbia.langId,
      author: serbia.author,
      author_user_id: serbia.authorUserId,
      author_photo_url: serbia.authorPhotoUrl ?? null,
      message: serbia.message,
      good_votes: serbia.goodVotes,
      bad_votes: serbia.badVotes,
      is_blocked: serbia.isBlocked,
      is_deleted: serbia.isDeleted,
      posted_at_epoch_seconds: serbia.postedAtEpochSeconds,
      moderator_user_id: serbia.moderatorUserId,
      moderator_name: serbia.moderatorName ?? null,
      presence: 'present',
      position: 3,
    });
    expect(CommentRowSchema.safeParse(columns).success).toBe(true);
  });

  it('a top-level comment gets parent_num null', async () => {
    const { mateja } = await nestedParts();
    expect(
      commentColumns(PLACE, { comment: mateja, parentNum: null, position: 0 }).parent_num,
    ).toBeNull();
  });

  it('absent authorPhotoUrl and moderatorName become null; set ones are kept', async () => {
    const { mateja } = await nestedParts();
    const bare: Comment = { ...omitKeys(mateja, 'authorPhotoUrl', 'moderatorName'), replies: [] };
    const absent = commentColumns(PLACE, { comment: bare, parentNum: null, position: 0 });
    expect(Object.hasOwn(absent, 'author_photo_url')).toBe(true);
    expect(absent.author_photo_url).toBeNull();
    expect(Object.hasOwn(absent, 'moderator_name')).toBe(true);
    expect(absent.moderator_name).toBeNull();

    const full: Comment = {
      ...mateja,
      authorPhotoUrl: 'http://photos.wikimapia.org/p/0/1.jpg',
      moderatorName: 'Moderator',
    };
    const set = commentColumns(PLACE, { comment: full, parentNum: null, position: 0 });
    expect(set.author_photo_url).toBe('http://photos.wikimapia.org/p/0/1.jpg');
    expect(set.moderator_name).toBe('Moderator');
  });

  it('has no replies key and no Commenter IP column (AC-6)', async () => {
    const { mateja, serbia } = await nestedParts();
    const columns = commentColumns(PLACE, {
      comment: { ...mateja, replies: [serbia] },
      parentNum: null,
      position: 0,
    });
    expect(Object.hasOwn(columns, 'replies')).toBe(false);
    for (const key of Object.keys(columns)) expect(key).not.toMatch(/(^|_)ip($|_)/);
  });
});

// ---------------------------------------------------------------------------
// 6. buildStoredComments
// ---------------------------------------------------------------------------

describe('buildStoredComments', () => {
  it('rebuilds the AC-34 tree exactly from the rows of the nested save', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const rows = presentCommentRows(await nestedDetails());
    const tree = buildStoredComments(scrambled(rows));
    expect(tree).toStrictEqual([
      stored(mateja, 'present', [stored(serbia, 'present', [stored(paul, 'present')])]),
    ]);
    for (const node of flattenStored(tree)) {
      expect(StoredCommentSchema.safeParse(node).success).toBe(true);
      expect(typeof node.author).toBe('string');
      expect(Object.hasOwn(node, 'author')).toBe(true);
    }
  });

  it('omits absent authorPhotoUrl and moderatorName as keys, keeps set ones', async () => {
    const { mateja, serbia } = await nestedParts();
    const bare: Comment = { ...omitKeys(mateja, 'authorPhotoUrl', 'moderatorName'), replies: [] };
    const full: Comment = {
      ...serbia,
      authorPhotoUrl: 'http://photos.wikimapia.org/p/0/2.jpg',
      moderatorName: 'Moderator',
    };
    const tree = buildStoredComments([
      commentRow(bare, null, 'present', 0),
      commentRow(full, 1, 'present', 0),
    ]);
    const top = storedNum(tree, 1);
    expect(Object.hasOwn(top, 'authorPhotoUrl')).toBe(false);
    expect(Object.hasOwn(top, 'moderatorName')).toBe(false);
    const reply = storedNum(top.replies, 2);
    expect(reply.authorPhotoUrl).toBe('http://photos.wikimapia.org/p/0/2.jpg');
    expect(reply.moderatorName).toBe('Moderator');
    expect(tree).toStrictEqual([stored(bare, 'present', [stored(full, 'present')])]);
  });

  it('orders present by position then gone by num at every level (AC-52)', async () => {
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const c = (num: number): Comment => rehome(mateja, PLACE, num);
    const rows = [
      commentRow(c(3), null, 'present', 0),
      commentRow(serbia, null, 'present', 1),
      commentRow(c(1), null, 'gone', null),
      commentRow(c(4), null, 'gone', null),
      commentRow(c(9), null, 'gone', null),
      commentRow(ramona, 2, 'present', 0),
      commentRow(paul, 2, 'gone', null),
    ];
    const tree = buildStoredComments(scrambled(rows));
    expect(levelOrder(tree)).toStrictEqual([
      [3, 'present'],
      [2, 'present'],
      [1, 'gone'],
      [4, 'gone'],
      [9, 'gone'],
    ]);
    expect(levelOrder(storedNum(tree, 2).replies)).toStrictEqual([
      [7, 'present'],
      [5, 'gone'],
    ]);
    expect(flattenStored(tree)).toHaveLength(rows.length);
  });

  it('gone siblings are ordered by num, not by row order or stale position', async () => {
    const { mateja } = await nestedParts();
    const c = (num: number): Comment => rehome(mateja, PLACE, num);
    const tree = buildStoredComments([
      commentRow(c(9), null, 'gone', null),
      commentRow(c(6), null, 'present', 1),
      commentRow(c(1), null, 'gone', null),
      commentRow(c(8), null, 'present', 0),
      commentRow(c(4), null, 'gone', null),
    ]);
    expect(levelOrder(tree)).toStrictEqual([
      [8, 'present'],
      [6, 'present'],
      [1, 'gone'],
      [4, 'gone'],
      [9, 'gone'],
    ]);
  });

  it('a gone reply stays under its present parent (AC-66)', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const tree = buildStoredComments([
      commentRow(paul, 2, 'gone', null),
      commentRow(serbia, 1, 'present', 0),
      commentRow(mateja, null, 'present', 0),
    ]);
    expect(tree).toStrictEqual([
      stored(mateja, 'present', [stored(serbia, 'present', [stored(paul, 'gone')])]),
    ]);
  });

  it('a gone parent keeps its gone reply and its place in the gone group (AC-67)', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const tree = buildStoredComments([
      commentRow(serbia, 1, 'gone', null),
      commentRow(mateja, null, 'gone', null),
      commentRow(paul, null, 'present', 0),
    ]);
    expect(tree).toStrictEqual([
      stored(paul, 'present'),
      stored(mateja, 'gone', [stored(serbia, 'gone')]),
    ]);
  });

  it('present and gone replies both stay under a gone parent, gone parent ordered by num', async () => {
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const c = (num: number): Comment => rehome(mateja, PLACE, num);
    const tree = buildStoredComments([
      commentRow(c(9), null, 'gone', null),
      commentRow(paul, 1, 'gone', null),
      commentRow(serbia, 1, 'present', 0),
      commentRow(mateja, null, 'gone', null),
      commentRow(ramona, null, 'present', 0),
    ]);
    expect(levelOrder(tree)).toStrictEqual([
      [7, 'present'],
      [1, 'gone'],
      [9, 'gone'],
    ]);
    expect(levelOrder(storedNum(tree, 1).replies)).toStrictEqual([
      [2, 'present'],
      [5, 'gone'],
    ]);
  });

  it('returns present and gone rows together, each marked (AC-71)', async () => {
    const { mateja, serbia } = await nestedParts();
    const tree = buildStoredComments([
      commentRow(mateja, null, 'gone', null),
      commentRow(serbia, null, 'present', 0),
    ]);
    expect(
      flattenStored(tree)
        .map((n) => `${String(n.num)}: ${n.presence}`)
        .sort(),
    ).toStrictEqual(['1: gone', '2: present']);
  });

  it('every node has its author, present or gone (AC-59)', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const tree = buildStoredComments([
      commentRow(paul, null, 'present', 0),
      commentRow(mateja, null, 'gone', null),
      commentRow(serbia, 1, 'gone', null),
    ]);
    expect(flattenStored(tree).map((n) => [n.author, n.presence])).toStrictEqual([
      [paul.author, 'present'],
      [mateja.author, 'gone'],
      [serbia.author, 'gone'],
    ]);
  });

  it('an empty list gives []', () => {
    expect(buildStoredComments([])).toStrictEqual([]);
  });

  it('defensive rule: a row whose parent has no row is appended at the top level, after the others', async () => {
    const { mateja } = await nestedParts();
    const c = (num: number): Comment => rehome(mateja, PLACE, num);
    const rows = [
      commentRow(c(8), 99, 'gone', null),
      commentRow(c(3), null, 'gone', null),
      commentRow(c(12), 8, 'gone', null),
      commentRow(c(1), null, 'present', 0),
    ];
    const tree = buildStoredComments(rows);
    const top = tree.map((n) => n.num);
    expect(top.slice(0, 2)).toStrictEqual([1, 3]);
    expect(top).toContain(8);
    const all = flattenStored(tree).map((n) => n.num);
    expect([...all].sort((a, b) => a - b)).toStrictEqual([1, 3, 8, 12]);
    expect(all).toHaveLength(rows.length);
  });

  it('defensive rule: a parent cycle terminates and each row appears exactly once', async () => {
    const { mateja } = await nestedParts();
    const c = (num: number): Comment => rehome(mateja, PLACE, num);
    const rows = [
      commentRow(c(10), 11, 'gone', null),
      commentRow(c(11), 10, 'gone', null),
      commentRow(c(1), null, 'present', 0),
    ];
    const tree = buildStoredComments(rows);
    expect(tree[0]?.num).toBe(1);
    const all = flattenStored(tree).map((n) => n.num);
    expect([...all].sort((a, b) => a - b)).toStrictEqual([1, 10, 11]);
    expect(all).toHaveLength(rows.length);
  });

  it('never drops a stored row', async () => {
    const { mateja } = await nestedParts();
    const c = (num: number): Comment => rehome(mateja, PLACE, num);
    const rows = [
      commentRow(c(1), null, 'present', 0),
      commentRow(c(2), 1, 'present', 0),
      commentRow(c(3), 2, 'gone', null),
      commentRow(c(4), 40, 'gone', null),
      commentRow(c(5), 6, 'gone', null),
      commentRow(c(6), 5, 'gone', null),
      commentRow(c(7), null, 'gone', null),
    ];
    expect(flattenStored(buildStoredComments(scrambled(rows)))).toHaveLength(rows.length);
  });

  it('never mutates its input', async () => {
    const rows = presentCommentRows(await nestedDetails());
    const copy = structuredClone(rows);
    buildStoredComments(rows);
    expect(rows).toStrictEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// 7. orderStoredTags
// ---------------------------------------------------------------------------

describe('orderStoredTags (AC-72)', () => {
  const rows = (): TagLinkRow[] => [
    tagRow(46360, 'town square', 'gone', null),
    tagRow(300, 'fountain', 'present', 1),
    tagRow(44926, 'historic town square', 'gone', null),
    tagRow(194, 'park', 'present', 0),
  ];

  it('present by position, then gone by tag id', () => {
    expect(orderStoredTags(rows())).toStrictEqual([
      { id: 194, title: 'park', presence: 'present' },
      { id: 300, title: 'fountain', presence: 'present' },
      { id: 44926, title: 'historic town square', presence: 'gone' },
      { id: 46360, title: 'town square', presence: 'gone' },
    ]);
  });

  it('each element is exactly { id, title, presence } and passes StoredTagSchema', () => {
    for (const tag of orderStoredTags(rows())) {
      expect(Object.keys(tag).sort()).toStrictEqual(['id', 'presence', 'title']);
      expect(StoredTagSchema.safeParse(tag).success).toBe(true);
    }
  });

  it('an empty list gives []', () => {
    expect(orderStoredTags([])).toStrictEqual([]);
  });

  it('does not sort its input in place', () => {
    const input = rows();
    const copy = structuredClone(input);
    orderStoredTags(input);
    expect(input).toStrictEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// 8. toSummaryOnlyPlace
// ---------------------------------------------------------------------------

describe('toSummaryOnlyPlace (AC-8, AC-49)', () => {
  async function summaryRow(): Promise<{ row: PlaceRow; url: string }> {
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), 164369);
    const row = PlaceRowSchema.parse({
      place_id: summary.placeId,
      ...summaryColumns(summary),
      description: null,
      is_building: null,
      is_region: null,
      is_deleted: null,
      parent_place_id: null,
      wikipedia_url: null,
      address_street: null,
      address_house_number: null,
      address_city: null,
      address_place: null,
      address_state: null,
      address_country: null,
      details_fetched_at_text: null,
    });
    return { row, url: summary.url };
  }

  it('builds the summary-only shape from summary 164369 and passes SummaryOnlyPlaceSchema', async () => {
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), 164369);
    const { row } = await summaryRow();
    const place = toSummaryOnlyPlace(row);
    expect(SummaryOnlyPlaceSchema.safeParse(place).success).toBe(true);
    expect(place).toStrictEqual({
      status: 'summary_only',
      placeId: 164369,
      name: summary.name,
      wikimapiaUrl: summary.url,
      location: summary.location,
      outline: summary.outline,
      tags: [],
      comments: [],
    });
  });

  it('outline and location equal the summary; link is the stored one', async () => {
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), 164369);
    const { row, url } = await summaryRow();
    const place = toSummaryOnlyPlace(row);
    expect(place.outline).toStrictEqual(summary.outline);
    expect(place.location).toStrictEqual(summary.location);
    expect(place.wikimapiaUrl).toBe(url);
    expect(place.tags).toStrictEqual([]);
    expect(place.comments).toStrictEqual([]);
    expect(Object.hasOwn(place, 'detailsFetchedAt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. toDetailedPlace
// ---------------------------------------------------------------------------

describe('toDetailedPlace', () => {
  it('62587: passes DetailedPlaceSchema and reads back as the Client value (AC-18)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const place = toDetailedPlace(detailedRow(d), linkRows(d), presentCommentRows(d));
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    expect(asPlaceDetails(place)).toStrictEqual(d);
    expect(place.status).toBe('detailed');
    expect(place.placeId).toBe(PLACE);
    expect(place.wikimapiaUrl).toBe(buildWikimapiaLink(PLACE));
    expect(place.detailsFetchedAt).toBe(FETCHED_AT);
    for (const tag of place.tags) expect(tag.presence).toBe('present');
    for (const c of flattenStored(place.comments)) expect(c.presence).toBe('present');
  });

  it('nested 62587: rebuilds the reply tree and reads back as the Client value (AC-18, AC-34)', async () => {
    const d = await nestedDetails();
    const place = toDetailedPlace(
      detailedRow(d),
      scrambled(linkRows(d)),
      scrambled(presentCommentRows(d)),
    );
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    expect(asPlaceDetails(place)).toStrictEqual(d);
  });

  it('optional keys are absent when their column is null (AC-19, AC-24)', async () => {
    const d = withoutAnyOptional(await clientDetails('getbyid-62587.json'));
    const place = toDetailedPlace(detailedRow(d), linkRows(d), presentCommentRows(d));
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    expect(Object.hasOwn(place, 'parentPlaceId')).toBe(false);
    expect(Object.hasOwn(place, 'wikipediaUrl')).toBe(false);
    for (const key of ADDRESS_KEYS) expect(Object.hasOwn(place.location, key)).toBe(false);
    expect(asPlaceDetails(place)).toStrictEqual(d);
  });

  it('optional keys are present when their column has a value', async () => {
    const d = withEveryOptional(await clientDetails('getbyid-62587.json'));
    const place = toDetailedPlace(detailedRow(d), linkRows(d), presentCommentRows(d));
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    expect(place.parentPlaceId).toBe(1381893);
    expect(place.wikipediaUrl).toBe('https://en.wikipedia.org/wiki/Republic_Square_(Belgrade)');
    expect(place.location).toStrictEqual(d.location);
    expect(place.location.houseNumber).toBe('1a');
    expect(asPlaceDetails(place)).toStrictEqual(d);
  });

  it('a detailed place with no links and no comments gives tags [] and comments [] (AC-19)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const place = toDetailedPlace(detailedRow({ ...d, tags: [], comments: [] }), [], []);
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    expect(place.tags).toStrictEqual([]);
    expect(place.comments).toStrictEqual([]);
  });

  it('orders tags and comments with the read-back rules (AC-71, AC-72)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const { mateja, serbia } = await nestedParts();
    const place = toDetailedPlace(
      detailedRow(d),
      [
        tagRow(46360, 'town square', 'gone', null),
        tagRow(300, 'fountain', 'present', 1),
        tagRow(44926, 'historic town square', 'gone', null),
        tagRow(194, 'park', 'present', 0),
      ],
      [commentRow(mateja, null, 'gone', null), commentRow(serbia, null, 'present', 0)],
    );
    expect(DetailedPlaceSchema.safeParse(place).success).toBe(true);
    expect(place.tags.map((t) => [t.id, t.presence])).toStrictEqual([
      [194, 'present'],
      [300, 'present'],
      [44926, 'gone'],
      [46360, 'gone'],
    ]);
    expect(levelOrder(place.comments)).toStrictEqual([
      [2, 'present'],
      [1, 'gone'],
    ]);
  });

  describe('throws without row values when the row is not a detailed place', () => {
    const cases: [string, (row: PlaceRow) => PlaceRow][] = [
      ['details_fetched_at_text null', (row) => ({ ...row, details_fetched_at_text: null })],
      ['description null', (row) => ({ ...row, description: null })],
      ['is_building null', (row) => ({ ...row, is_building: null })],
      ['is_region null', (row) => ({ ...row, is_region: null })],
      ['is_deleted null', (row) => ({ ...row, is_deleted: null })],
    ];

    it.each(cases)('%s', async (_name, broken) => {
      const d = await clientDetails('getbyid-62587.json');
      const row = broken(detailedRow(d));
      let thrown: unknown;
      try {
        toDetailedPlace(row, linkRows(d), presentCommentRows(d));
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : '';
      for (const value of [
        row.name,
        row.wikimapia_url,
        String(row.place_id),
        FETCHED_AT,
        String(row.location_lon),
        d.description.slice(0, 20),
      ]) {
        expect(message).not.toContain(value);
      }
    });
  });
});
