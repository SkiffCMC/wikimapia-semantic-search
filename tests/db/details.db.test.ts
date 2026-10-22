/**
 * AL2 unit tests: `src/db/save-details.ts` (with `src/db/read.ts`) against the Test Database
 * (AL4 1.3 `save-details.ts` block, 1.4.6 Details Save, 1.4.7 Writer and fault hook, 1.4.9 Map
 * shapes, 1.5 Transaction boundaries, 2.2 .. 2.4). AL3 routing 20261021-storage-07-details, 2.1.
 *
 * Module-level stand-in for contract ACs AC-11, AC-16 .. AC-37, AC-40 .. AC-49 (details parts),
 * AC-52, AC-56, AC-59, AC-63 .. AC-72 until `contracts/storage.test.ts` can load (U8).
 *
 * Runs on a `createDb(requireTestDatabaseUrl(), POOL_MAX_STORE)` handle. Issues no SQL itself:
 * data goes in through `saveDetails` (and `saveListing` where a listing is part of the scenario)
 * and comes out through the `read.ts` functions. Every input is the parsed
 * `SavePlaceDetailsInputSchema` value U8 will pass, every report is parsed with
 * `SaveReportSchema` and every read with its contract schema.
 */
import { z } from 'zod';
import type { Knex } from 'knex';
import { saveDetails } from '../../src/db/save-details';
import { saveListing } from '../../src/db/save-listing';
import {
  countAll,
  listCommentKeys,
  listLinksOfTag,
  listTagCatalogue,
  loadDetailsState,
  readPlaceValue,
  readShapesValue,
} from '../../src/db/read';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_STORE, createDb, destroyQuietly } from '../../src/db/connection';
import {
  EmptyResultSchema,
  PlaceTagLinkSchema,
  ReadPlaceValueSchema,
  ReadShapesValueSchema,
  SaveListingPageInputSchema,
  SavePlaceDetailsInputSchema,
  SaveReportSchema,
  SchemaStepsResultSchema,
  StoreCountsSchema,
  StoredCommentKeySchema,
  TagCatalogueSchema,
  WGS84_SRID,
  buildWikimapiaLink,
} from '../../contracts/storage.schema';
import type {
  DetailedPlace,
  PlaceShapes,
  ReadPlaceValue,
  ReadShapesValue,
  SaveReport,
  SchemaSetup,
  StoreCounts,
  StoredPlace,
  WriteHook,
} from '../../contracts/storage.schema';
import {
  EVEN_LATER_FETCHED_AT,
  FETCHED_AT,
  LATER_FETCHED_AT,
  asPlaceDetails,
  at,
  clientDetails,
  clientListing,
  flattenComments,
  levelOrder,
  listingOf,
  longMixedDescription,
  nestedDetails,
  nestedParts,
  omitKeys,
  presenceMarks,
  rehome,
  requireTestDatabaseUrl,
  storedNum,
  summaryOf,
  tagsWithoutPresence,
} from '../../contracts/storage.support';
import type {
  Comment,
  ListingPage,
  PlaceDetails,
  PlaceSummary,
  Point,
} from '../../contracts/wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Lifecycle: Test Database migrated once, emptied before every test
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
let db: Knex;

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: url });
  const applied = SchemaStepsResultSchema.parse(await setup.apply());
  expect(applied.ok).toBe(true);
  db = createDb(url, POOL_MAX_STORE);
});

beforeEach(async () => {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
});

afterAll(async () => {
  await destroyQuietly(db);
  await setup.close();
});

// ---------------------------------------------------------------------------
// Helpers (every result parsed with its contract schema)
// ---------------------------------------------------------------------------

const SQUARE = 'getbyid-62587.json';
const PARK = 'getbyid-1381893.json';
const EIFFEL = 'getbyid-55.json';

/** The parsed Details Save input, exactly as U8 will pass it. */
function detailsInput(details: PlaceDetails, fetchedAt: string) {
  return SavePlaceDetailsInputSchema.parse({ details, fetchedAt });
}

async function save(
  details: PlaceDetails,
  fetchedAt: string = FETCHED_AT,
  onWrite?: WriteHook,
): Promise<SaveReport> {
  return SaveReportSchema.parse(await saveDetails(db, detailsInput(details, fetchedAt), onWrite));
}

async function saveSummaries(page: ListingPage): Promise<SaveReport> {
  return SaveReportSchema.parse(
    await saveListing(db, SaveListingPageInputSchema.parse(page), undefined),
  );
}

async function readValue(placeId: number): Promise<ReadPlaceValue> {
  return ReadPlaceValueSchema.parse(await readPlaceValue(db, placeId));
}

async function read(placeId: number): Promise<StoredPlace> {
  const value = await readValue(placeId);
  if (!value.found) throw new Error(`place ${String(placeId)} is not stored`);
  return value.place;
}

async function readDetailed(placeId: number): Promise<DetailedPlace> {
  const place = await read(placeId);
  if (place.status !== 'detailed') throw new Error(`place ${String(placeId)} is ${place.status}`);
  return place;
}

async function shapesValue(placeId: number): Promise<ReadShapesValue> {
  return ReadShapesValueSchema.parse(await readShapesValue(db, placeId));
}

async function shapes(placeId: number): Promise<PlaceShapes> {
  const value = await shapesValue(placeId);
  if (!value.found) throw new Error(`place ${String(placeId)} has no stored shapes`);
  return value.shapes;
}

async function tagCatalogue() {
  return TagCatalogueSchema.parse(await listTagCatalogue(db));
}

async function tagLinks(tagId: number) {
  return z.array(PlaceTagLinkSchema).parse(await listLinksOfTag(db, tagId));
}

async function commentKeys(placeId: number) {
  return z.array(StoredCommentKeySchema).parse(await listCommentKeys(db, placeId));
}

async function counts(): Promise<StoreCounts> {
  return StoreCountsSchema.parse(await countAll(db));
}

/** Everything observable about the given places and the whole store (for "nothing changed"). */
async function snapshot(placeIds: readonly number[]) {
  const places = [];
  for (const id of placeIds) {
    places.push({
      value: await readValue(id),
      comments: await commentKeys(id),
      shapes: await shapesValue(id),
    });
  }
  const catalogue = await tagCatalogue();
  const links = [];
  for (const tag of catalogue) links.push(await tagLinks(tag.id));
  return { places, catalogue, links, counts: await counts() };
}

/** A hook that records every write number it receives. */
function recordingHook(): { hook: WriteHook; calls: number[] } {
  const calls: number[] = [];
  const hook: WriteHook = (n) => {
    calls.push(n);
  };
  return { hook, calls };
}

function ring(outline: readonly Point[]): Point[] {
  return [...outline, at(outline, 0)];
}

function expectSamePoints(actual: readonly Point[], expected: readonly Point[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((p, i) => {
    const e = at(expected, i);
    expect(p.lon).toBeCloseTo(e.lon, 9);
    expect(p.lat).toBeCloseTo(e.lat, 9);
  });
}

/** Present first in `presentOrder`, then Gone in ascending number (AC-52, AC-72). */
function expectPresentThenGone(
  actual: [number, string][],
  presentOrder: number[],
  gone: number[],
): void {
  expect(actual).toStrictEqual([
    ...presentOrder.map((n): [number, string] => [n, 'present']),
    ...[...gone].sort((a, b) => a - b).map((n): [number, string] => [n, 'gone']),
  ]);
}

/** The AC-27 reduction of 62587: only comment 2 and tag 46360 remain. */
function reduced(d: PlaceDetails): PlaceDetails {
  return { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] };
}

async function universityParkWithTownSquareTag(): Promise<PlaceDetails> {
  const d = await clientDetails(PARK);
  return { ...d, tags: [...d.tags, { id: 46360, title: 'town square' }] };
}

// ===========================================================================
// Created and round trip
// ===========================================================================

describe('saveDetails: new place, round trip (AC-16 .. AC-19, AC-31, AC-49)', () => {
  const cases: [string, () => Promise<PlaceDetails>][] = [
    ['Square of the Republic (62587)', () => clientDetails(SQUARE)],
    ['University Park (1381893)', () => clientDetails(PARK)],
    ['Eiffel Tower (55)', () => clientDetails(EIFFEL)],
    ['synthetic nesting (AC-34)', () => nestedDetails()],
  ];

  it.each(cases)(
    '%s reports created and reads back identical, all present, Built Link, fetch moment kept',
    async (_name, load) => {
      const d = await load();
      const report = await save(d, LATER_FETCHED_AT);
      expect(report).toStrictEqual({ places: [{ placeId: d.placeId, outcome: 'created' }] });

      const place = await readDetailed(d.placeId);
      expect(place.status).toBe('detailed');
      expect(asPlaceDetails(place)).toStrictEqual(d);
      expect(presenceMarks(place).filter((mark) => !mark.endsWith(': present'))).toStrictEqual([]);
      expect(place.wikimapiaUrl).toBe(buildWikimapiaLink(d.placeId));
      expect(place.detailsFetchedAt).toBe(LATER_FETCHED_AT);
    },
  );

  it('62587 has the AC-16 tags and the AC-17 comments in full', async () => {
    const d = await clientDetails(SQUARE);
    await save(d, LATER_FETCHED_AT);
    const place = await readDetailed(62587);
    expect(place.name).toBe('Square of the Republic');
    expect(place.wikimapiaUrl).toBe('http://wikimapia.org/62587');
    expect(place.tags).toStrictEqual([
      { id: 44926, title: 'historic town square', presence: 'present' },
      { id: 46360, title: 'town square', presence: 'present' },
    ]);
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place.wikipediaUrl).toBe('http://en.wikipedia.org/wiki/Republic_Square_(Belgrade)');
    expect(place.outline).toHaveLength(19);
    expect(place.comments).toStrictEqual([
      {
        placeId: 62587,
        num: 1,
        langId: at(d.comments, 0).langId,
        author: 'Mateja',
        authorUserId: 0,
        message: 'Everybodey is waiting for someone here',
        goodVotes: 5,
        badVotes: 15,
        isBlocked: false,
        isDeleted: false,
        postedAtEpochSeconds: 1169755601,
        moderatorUserId: 0,
        presence: 'present',
        replies: [],
      },
      expect.objectContaining({
        placeId: 62587,
        num: 2,
        author: 'Serbia',
        authorUserId: 150331,
        authorPhotoUrl: '/p/u/00/00/15/03/31_50.jpg',
        message: 'Najbolji trg na svetu!!',
        goodVotes: 33,
        badVotes: 0,
        postedAtEpochSeconds: 1199388051,
        presence: 'present',
        replies: [],
      }),
    ]);
    expect(at(place.comments, 0)).not.toHaveProperty('authorPhotoUrl');
    expect(at(place.comments, 0)).not.toHaveProperty('moderatorName');
  });

  it('University Park has its one tag, no Wikipedia link, no street and no comments (AC-19)', async () => {
    await save(await clientDetails(PARK));
    const place = await readDetailed(1381893);
    expect(place.description).toBe('Belgrade,Serbia.');
    expect(place.tags).toStrictEqual([{ id: 194, title: 'park', presence: 'present' }]);
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place.location).not.toHaveProperty('street');
    expect(place.location).not.toHaveProperty('houseNumber');
    expect(place.comments).toStrictEqual([]);
  });

  it('calls the hook at least once with consecutive write numbers from 1', async () => {
    const { hook, calls } = recordingHook();
    await save(await clientDetails(SQUARE), FETCHED_AT, hook);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls).toStrictEqual(calls.map((_n, i) => i + 1));
  });
});

// ===========================================================================
// Idempotent and re-fetched
// ===========================================================================

describe('saveDetails: idempotent (AC-21, AC-31)', () => {
  const cases: [string, () => Promise<PlaceDetails>][] = [
    ['62587', () => clientDetails(SQUARE)],
    ['nested replies', () => nestedDetails()],
  ];

  it.each(cases)(
    '%s: the same input with the same moment reports unchanged, changes nothing and makes no write',
    async (_name, load) => {
      const d = await load();
      await save(d, FETCHED_AT);
      const before = await snapshot([d.placeId]);
      const { hook, calls } = recordingHook();
      const report = await save(d, FETCHED_AT, hook);
      expect(report).toStrictEqual({ places: [{ placeId: d.placeId, outcome: 'unchanged' }] });
      expect(calls).toStrictEqual([]);
      expect(await snapshot([d.placeId])).toStrictEqual(before);
    },
  );

  it('a details-only place keeps its Built Link on re-save and reports unchanged (AC-31)', async () => {
    const d = await clientDetails(PARK);
    await save(d);
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe('http://wikimapia.org/1381893');
    expect(await save(d)).toStrictEqual({
      places: [{ placeId: 1381893, outcome: 'unchanged' }],
    });
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe('http://wikimapia.org/1381893');
  });
});

describe('saveDetails: re-fetched, nothing changed (AC-22, D3)', () => {
  it('reports unchanged, writes once and moves only detailsFetchedAt', async () => {
    const d = await clientDetails(SQUARE);
    await save(d, FETCHED_AT);
    const before = await readDetailed(62587);
    const keysBefore = await commentKeys(62587);
    const { hook, calls } = recordingHook();

    const report = await save(d, LATER_FETCHED_AT, hook);
    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'unchanged' }] });
    expect(calls).toStrictEqual([1]);
    expect(await readDetailed(62587)).toStrictEqual({
      ...before,
      detailsFetchedAt: LATER_FETCHED_AT,
    });
    expect(await commentKeys(62587)).toStrictEqual(keysBefore);
  });
});

// ===========================================================================
// Summary-only completed, details changed
// ===========================================================================

describe('saveDetails: details complete a summary-only place (AC-20, D1, D6)', () => {
  it('becomes detailed, reports updated, takes details values and keeps the Listing Link', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveSummaries(listingOf({ ...summaryOf(page, 1381893), name: 'Univerzitetski park' }));
    const d = await clientDetails(PARK);

    expect(await save(d)).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });
    const place = await readDetailed(1381893);
    expect(place.name).toBe(d.title);
    expect(place.location).toStrictEqual(d.location);
    expect(place.outline).toStrictEqual(d.outline);
    expect(place.wikimapiaUrl).toBe('http://wikimapia.org/1381893/University-Park');
    expect(place.detailsFetchedAt).toBe(FETCHED_AT);
  });
});

describe('saveDetails: details changed (AC-23, AC-24)', () => {
  it('reads back the AC-23 values and reports updated', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const d2: PlaceDetails = {
      ...d,
      title: 'Republic Square',
      description: `${d.description}\nRenovated in 2019.`,
      isBuilding: true,
      isRegion: true,
      isDeleted: true,
      wikipediaUrl: 'http://sr.wikipedia.org/wiki/Trg_Republike',
      outline: d.outline.slice(0, 5),
      location: { ...d.location, lon: 20.4604, street: 'Trg Republike' },
    };
    expect(await save(d2, LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 62587, outcome: 'updated' }],
    });
    expect(asPlaceDetails(await readDetailed(62587))).toStrictEqual(d2);
  });

  it.each([
    ['description', (d: PlaceDetails): PlaceDetails => ({ ...d, description: 'x' })],
    ['title', (d: PlaceDetails): PlaceDetails => ({ ...d, title: 'x' })],
    ['deleted mark', (d: PlaceDetails): PlaceDetails => ({ ...d, isDeleted: true })],
    [
      'address item',
      (d: PlaceDetails): PlaceDetails => ({ ...d, location: { ...d.location, city: 'Beograd' } }),
    ],
  ])('a change of the %s alone reports updated and reads back', async (_name, change) => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const changed = change(d);
    expect(await save(changed)).toStrictEqual({
      places: [{ placeId: 62587, outcome: 'updated' }],
    });
    expect(asPlaceDetails(await readDetailed(62587))).toStrictEqual(changed);
  });

  it('removed Wikipedia link, Parent Place ID and street read back as absent keys', async () => {
    const d = await clientDetails(SQUARE);
    const withItems: PlaceDetails = {
      ...d,
      parentPlaceId: 999,
      location: { ...d.location, street: 'Trg Republike' },
    };
    await save(withItems);
    const withoutItems = omitKeys(withItems, 'parentPlaceId', 'wikipediaUrl');
    const location = omitKeys(withItems.location, 'street');
    expect(await save({ ...withoutItems, location }, LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 62587, outcome: 'updated' }],
    });

    const place = await readDetailed(62587);
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place.location).not.toHaveProperty('street');
  });
});

// ===========================================================================
// Comments changed, added, gone, back
// ===========================================================================

describe('saveDetails: comment changed and added (AC-25, AC-26)', () => {
  it('comment 1 takes the new values, comment 2 is unchanged, both present; updated', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const before = await readDetailed(62587);
    const changed: Comment = {
      ...at(d.comments, 0),
      message: 'Still waiting.',
      goodVotes: 6,
      badVotes: 16,
      isDeleted: true,
      isBlocked: true,
    };
    const report = await save({ ...d, comments: [changed, at(d.comments, 1)] });

    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
    const place = await readDetailed(62587);
    expect(storedNum(place.comments, 1)).toStrictEqual({ ...changed, presence: 'present' });
    expect(storedNum(place.comments, 2)).toStrictEqual(storedNum(before.comments, 2));
  });

  it('a third comment reads back after the other two, all present; updated', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const { paul } = await nestedParts();
    const report = await save({ ...d, comments: [...d.comments, rehome(paul, 62587, 3)] });

    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
    expect(levelOrder((await readDetailed(62587)).comments)).toStrictEqual([
      [1, 'present'],
      [2, 'present'],
      [3, 'present'],
    ]);
    expect(await counts()).toStrictEqual({ places: 1, comments: 3, tags: 2, placeTagLinks: 2 });
  });
});

describe('saveDetails: gone comments and tags (AC-27, AC-68, AC-71, D2)', () => {
  it('keeps comment 1 and tag 44926 marked gone with their last values; updated', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const before = await readDetailed(62587);
    const report = await save(reduced(d), LATER_FETCHED_AT);

    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
    const place = await readDetailed(62587);
    expect(place.tags).toStrictEqual([
      { id: 46360, title: 'town square', presence: 'present' },
      { id: 44926, title: 'historic town square', presence: 'gone' },
    ]);
    expect(levelOrder(place.comments)).toStrictEqual([
      [2, 'present'],
      [1, 'gone'],
    ]);
    expect(storedNum(place.comments, 1)).toStrictEqual({
      ...storedNum(before.comments, 1),
      presence: 'gone',
    });
    expect(await tagCatalogue()).toContainEqual({ id: 44926, title: 'historic town square' });
    expect(await counts()).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
  });

  it('a single read returns present and gone comments and tags, each marked (AC-71)', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    await save(reduced(d), LATER_FETCHED_AT);
    const marks = presenceMarks(await read(62587));
    expect([...marks].sort()).toStrictEqual(
      ['comment 1: gone', 'comment 2: present', 'tag 44926: gone', 'tag 46360: present'].sort(),
    );
  });

  it('removing all comments keeps both as gone (AC-68)', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    expect(await save({ ...d, comments: [] }, LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 62587, outcome: 'updated' }],
    });
    expect(levelOrder((await readDetailed(62587)).comments)).toStrictEqual([
      [1, 'gone'],
      [2, 'gone'],
    ]);
    expect((await counts()).comments).toBe(2);
  });
});

describe('saveDetails: gone items are idempotent (AC-64)', () => {
  const moments: [string, string, number[]][] = [
    ['the same fetch moment', LATER_FETCHED_AT, []],
    ['a later fetch moment', EVEN_LATER_FETCHED_AT, [1]],
  ];

  it.each(moments)(
    're-saving the reduction with %s reports unchanged and changes only detailsFetchedAt',
    async (_name, moment, expectedCalls) => {
      const d = await clientDetails(SQUARE);
      await save(d);
      await save(reduced(d), LATER_FETCHED_AT);
      const before = await readDetailed(62587);
      const keysBefore = await commentKeys(62587);
      const { hook, calls } = recordingHook();

      const report = await save(reduced(d), moment, hook);
      expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'unchanged' }] });
      expect(calls).toStrictEqual(expectedCalls);
      expect(await readDetailed(62587)).toStrictEqual({ ...before, detailsFetchedAt: moment });
      expect(await commentKeys(62587)).toStrictEqual(keysBefore);
      expect(await counts()).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
    },
  );
});

describe('saveDetails: gone items come back (AC-65)', () => {
  it('comment 1 and tag 44926 become present with new values and position, stored once; updated', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    await save(reduced(d), LATER_FETCHED_AT);
    const back: Comment = {
      ...at(d.comments, 0),
      message: 'Everybody is waiting for someone here',
      goodVotes: 9,
    };
    const report = await save(
      { ...d, comments: [at(d.comments, 1), back], tags: [at(d.tags, 1), at(d.tags, 0)] },
      EVEN_LATER_FETCHED_AT,
    );

    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
    const place = await readDetailed(62587);
    expect(levelOrder(place.comments)).toStrictEqual([
      [2, 'present'],
      [1, 'present'],
    ]);
    expect(storedNum(place.comments, 1)).toStrictEqual({ ...back, presence: 'present' });
    expect(place.tags.map((t) => [t.id, t.presence])).toStrictEqual([
      [46360, 'present'],
      [44926, 'present'],
    ]);
    expect((await commentKeys(62587)).filter((k) => k.num === 1)).toHaveLength(1);
    expect(await counts()).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
  });
});

// ===========================================================================
// Replies
// ===========================================================================

describe('saveDetails: replies (AC-34 .. AC-37)', () => {
  it('rebuilds Mateja > Serbia > Paul with all fields, all present (AC-34)', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    await save(await nestedDetails());
    const place = await readDetailed(62587);
    expect(place.comments).toStrictEqual([
      {
        ...mateja,
        presence: 'present',
        replies: [
          {
            ...serbia,
            presence: 'present',
            replies: [{ ...paul, presence: 'present', replies: [] }],
          },
        ],
      },
    ]);
  });

  it('stores 3 comments keyed by (62587, num) with their parent numbers (AC-35)', async () => {
    await save(await nestedDetails());
    expect(await commentKeys(62587)).toStrictEqual([
      { placeId: 62587, num: 1, presence: 'present' },
      { placeId: 62587, num: 2, parentNum: 1, presence: 'present' },
      { placeId: 62587, num: 5, parentNum: 2, presence: 'present' },
    ]);
    expect((await counts()).comments).toBe(3);
  });

  it('keeps several replies in the order given: Serbia, Ramona, then Paul (AC-36)', async () => {
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const d = await nestedDetails();
    await save({ ...d, comments: [{ ...mateja, replies: [serbia, ramona, paul] }] });
    const place = await readDetailed(62587);
    expect(levelOrder(storedNum(place.comments, 1).replies)).toStrictEqual([
      [2, 'present'],
      [7, 'present'],
      [5, 'present'],
    ]);
  });

  it('Paul moved to the top level has no parentNum, Serbia has no replies; updated (AC-37)', async () => {
    const d = await nestedDetails();
    await save(d);
    const { mateja, serbia, paul } = await nestedParts();
    const moved: PlaceDetails = { ...d, comments: [{ ...mateja, replies: [serbia] }, paul] };
    expect(await save(moved, LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 62587, outcome: 'updated' }],
    });

    const place = await readDetailed(62587);
    expect(levelOrder(place.comments)).toStrictEqual([
      [1, 'present'],
      [5, 'present'],
    ]);
    expect(storedNum(storedNum(place.comments, 1).replies, 2).replies).toStrictEqual([]);
    expect((await commentKeys(62587)).find((k) => k.num === 5)).toStrictEqual({
      placeId: 62587,
      num: 5,
      presence: 'present',
    });
    expect(asPlaceDetails(place)).toStrictEqual(moved);
  });
});

describe('saveDetails: gone replies and ordering (AC-66, AC-67, AC-52, AC-59)', () => {
  it('Paul gone stays a reply of Serbia with all its values (AC-66)', async () => {
    const d = await nestedDetails();
    await save(d);
    const { mateja, serbia, paul } = await nestedParts();
    expect(
      await save(
        { ...d, comments: [{ ...mateja, replies: [{ ...serbia, replies: [] }] }] },
        LATER_FETCHED_AT,
      ),
    ).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });

    const place = await readDetailed(62587);
    expect(levelOrder(place.comments)).toStrictEqual([[1, 'present']]);
    const serbiaStored = storedNum(storedNum(place.comments, 1).replies, 2);
    expect(serbiaStored.presence).toBe('present');
    expect(serbiaStored.replies).toStrictEqual([{ ...paul, presence: 'gone', replies: [] }]);
    expect((await commentKeys(62587)).find((k) => k.num === 5)).toStrictEqual({
      placeId: 62587,
      num: 5,
      parentNum: 2,
      presence: 'gone',
    });
  });

  it('only Paul remains: Paul top-level present, Mateja gone holding Serbia gone (AC-67)', async () => {
    const d = await nestedDetails();
    await save(d);
    const { mateja, serbia, paul } = await nestedParts();
    const report = await save({ ...d, comments: [paul] }, LATER_FETCHED_AT);

    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
    const place = await readDetailed(62587);
    expect(place.comments).toStrictEqual([
      { ...paul, presence: 'present', replies: [] },
      { ...mateja, presence: 'gone', replies: [{ ...serbia, presence: 'gone', replies: [] }] },
    ]);
    expect(await commentKeys(62587)).toStrictEqual([
      { placeId: 62587, num: 1, presence: 'gone' },
      { placeId: 62587, num: 2, parentNum: 1, presence: 'gone' },
      { placeId: 62587, num: 5, presence: 'present' },
    ]);
  });

  it('present in the latest order first, then gone ascending by number, at every level (AC-52)', async () => {
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const square = await clientDetails(SQUARE);
    const c = (num: number, replies: Comment[] = []): Comment =>
      rehome(mateja, 62587, num, replies);
    await save({
      ...square,
      comments: [c(4), { ...serbia, replies: [paul, ramona] }, c(1), c(3), c(9)],
    });
    await save(
      { ...square, comments: [c(3), { ...serbia, replies: [ramona] }] },
      LATER_FETCHED_AT,
    );

    const place = await readDetailed(62587);
    expectPresentThenGone(levelOrder(place.comments), [3, 2], [1, 4, 9]);
    expectPresentThenGone(levelOrder(storedNum(place.comments, 2).replies), [7], [5]);
  });

  it('every comment, present or gone, keeps its author (AC-59)', async () => {
    const { paul } = await nestedParts();
    const d = await nestedDetails();
    await save(d);
    await save({ ...d, comments: [paul] }, LATER_FETCHED_AT);
    const comments = flattenComments((await readDetailed(62587)).comments);
    expect(comments.map((c) => [c.author, c.presence])).toStrictEqual([
      ['Paul', 'present'],
      ['Mateja', 'gone'],
      ['Serbia', 'gone'],
    ]);
  });
});

// ===========================================================================
// Tags
// ===========================================================================

describe('saveDetails: tags (AC-40 .. AC-43, AC-69, AC-72)', () => {
  it('the shared catalogue lists each tag once and both places link to 46360 (AC-40, AC-41)', async () => {
    await save(await clientDetails(SQUARE));
    await save(await universityParkWithTownSquareTag());
    expect(await tagCatalogue()).toStrictEqual([
      { id: 194, title: 'park' },
      { id: 44926, title: 'historic town square' },
      { id: 46360, title: 'town square' },
    ]);
    expect(await tagLinks(46360)).toStrictEqual([
      { placeId: 62587, tagId: 46360, presence: 'present' },
      { placeId: 1381893, tagId: 46360, presence: 'present' },
    ]);
    expect(await tagLinks(44926)).toStrictEqual([
      { placeId: 62587, tagId: 44926, presence: 'present' },
    ]);
    expect(await tagLinks(194)).toStrictEqual([
      { placeId: 1381893, tagId: 194, presence: 'present' },
    ]);
  });

  it('a changed title shows for present and gone links (AC-42)', async () => {
    const park = await clientDetails(PARK);
    const square = await clientDetails(SQUARE);
    await save(park);
    await save({ ...square, tags: [...square.tags, { id: 194, title: 'park' }] });
    await save(square, LATER_FETCHED_AT); // 62587's link to 194 is now gone
    expect(
      await save({ ...park, tags: [{ id: 194, title: 'city park' }] }, LATER_FETCHED_AT),
    ).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });

    expect((await readDetailed(1381893)).tags).toStrictEqual([
      { id: 194, title: 'city park', presence: 'present' },
    ]);
    expect((await readDetailed(62587)).tags).toContainEqual({
      id: 194,
      title: 'city park',
      presence: 'gone',
    });
    expect((await tagCatalogue()).filter((t) => t.id === 194)).toStrictEqual([
      { id: 194, title: 'city park' },
    ]);
  });

  it('a duplicate tag id gives one link (AC-43)', async () => {
    const d = await clientDetails(PARK);
    await save({
      ...d,
      tags: [
        { id: 194, title: 'park' },
        { id: 194, title: 'park' },
      ],
    });
    expect(tagsWithoutPresence((await readDetailed(1381893)).tags)).toStrictEqual([
      { id: 194, title: 'park' },
    ]);
    expect(await tagLinks(194)).toHaveLength(1);
    expect(await counts()).toStrictEqual({ places: 1, comments: 0, tags: 1, placeTagLinks: 1 });
  });

  it("a gone link to a shared tag leaves the other place's link present (AC-69)", async () => {
    const square = await clientDetails(SQUARE);
    await save(square);
    await save(await universityParkWithTownSquareTag());
    await save({ ...square, tags: [at(square.tags, 0)] }, LATER_FETCHED_AT);

    expect(await tagLinks(46360)).toStrictEqual([
      { placeId: 62587, tagId: 46360, presence: 'gone' },
      { placeId: 1381893, tagId: 46360, presence: 'present' },
    ]);
    expect((await tagCatalogue()).filter((t) => t.id === 46360)).toHaveLength(1);
  });

  it('present tags in the latest order first, then gone ascending by id (AC-72)', async () => {
    const d = await clientDetails(SQUARE);
    const t = (id: number, title: string) => ({ id, title });
    await save({
      ...d,
      tags: [
        t(300, 'fountain'),
        t(46360, 'town square'),
        t(44926, 'historic town square'),
        t(194, 'park'),
      ],
    });
    await save({ ...d, tags: [t(194, 'park'), t(300, 'fountain')] }, LATER_FETCHED_AT);
    expectPresentThenGone(
      (await readDetailed(62587)).tags.map((tag): [number, string] => [tag.id, tag.presence]),
      [194, 300],
      [44926, 46360],
    );
  });
});

// ===========================================================================
// Map shapes
// ===========================================================================

const CLOSED_OUTLINE: Point[] = [
  { lon: 20.4566, lat: 44.8198 },
  { lon: 20.4575, lat: 44.8204 },
  { lon: 20.4591, lat: 44.8191 },
  { lon: 20.4566, lat: 44.8198 },
];

describe('saveDetails: map shapes (AC-44 .. AC-48, AC-70)', () => {
  it('62587 gets a WGS 84 polygon of its 19 points closed, and a centre point (AC-44, AC-45)', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const value = await shapesValue(62587);
    if (!value.found) throw new Error('shapes of 62587 not found');
    expect(value.shapes.placeId).toBe(62587);
    const centre = value.shapes.centrePoint;
    expect(centre.type).toBe('Point');
    expect(centre.srid).toBe(WGS84_SRID);
    expect(centre.point.lon).toBeCloseTo(d.location.lon, 9);
    expect(centre.point.lat).toBeCloseTo(d.location.lat, 9);
    const outline = value.shapes.outlineShape;
    expect(outline?.type).toBe('Polygon');
    expect(outline?.srid).toBe(WGS84_SRID);
    expectSamePoints(outline?.ring ?? [], ring(d.outline));
    expect(outline?.ring).toHaveLength(20);
  });

  it('an already closed outline reads back as given and its shape adds no extra point (AC-46)', async () => {
    const d = await clientDetails(PARK);
    await save({ ...d, outline: CLOSED_OUTLINE });
    expect((await read(1381893)).outline).toStrictEqual(CLOSED_OUTLINE);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], CLOSED_OUTLINE);
  });

  it('a self-crossing (bow-tie) outline is stored as given (AC-47)', async () => {
    const bowTie: Point[] = [
      { lon: 20.456, lat: 44.818 },
      { lon: 20.459, lat: 44.821 },
      { lon: 20.459, lat: 44.818 },
      { lon: 20.456, lat: 44.821 },
    ];
    const d = await clientDetails(PARK);
    await save({ ...d, outline: bowTie });
    expect((await read(1381893)).outline).toStrictEqual(bowTie);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(bowTie));
  });

  const small: [string, Point[]][] = [
    [
      '2 points',
      [
        { lon: 20.4566, lat: 44.8198 },
        { lon: 20.4575, lat: 44.8204 },
      ],
    ],
    ['1 point', [{ lon: 20.4566, lat: 44.8198 }]],
    ['no points', []],
  ];

  it.each(small)(
    'details with %s: saved with a centre point and no outline shape (AC-48, D4)',
    async (_n, outline) => {
      const d = await clientDetails(PARK);
      expect(await save({ ...d, outline })).toStrictEqual({
        places: [{ placeId: 1381893, outcome: 'created' }],
      });
      expect((await read(1381893)).outline).toStrictEqual(outline);
      const stored = await shapes(1381893);
      expect(stored).not.toHaveProperty('outlineShape');
      expect(stored.centrePoint.srid).toBe(WGS84_SRID);
      expect(stored.centrePoint.point.lon).toBeCloseTo(d.location.lon, 9);
      expect(stored.centrePoint.point.lat).toBeCloseTo(d.location.lat, 9);
    },
  );

  it('shrinking the outline to [] drops the shape and growing it restores it (AC-70)', async () => {
    const d = await clientDetails(PARK);
    await save(d);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(d.outline));

    expect(await save({ ...d, outline: [] }, LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 1381893, outcome: 'updated' }],
    });
    const shrunk = await shapes(1381893);
    expect(shrunk).not.toHaveProperty('outlineShape');
    expect(shrunk.centrePoint.point.lon).toBeCloseTo(d.location.lon, 9);

    expect(await save(d, EVEN_LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 1381893, outcome: 'updated' }],
    });
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(d.outline));
  });

  it('after a summary-only shrink, details with a full outline add the shape again (AC-70)', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    const summary = summaryOf(page, 1381893);
    await saveSummaries(listingOf({ ...summary, outline: summary.outline.slice(0, 2) }));
    expect(await shapes(1381893)).not.toHaveProperty('outlineShape');

    const d = await clientDetails(PARK);
    await save(d);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(d.outline));
  });

  it('a save that only moves the fetch moment leaves the shapes unchanged', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const before = await shapesValue(62587);
    await save(d, LATER_FETCHED_AT);
    expect(await shapesValue(62587)).toStrictEqual(before);
  });
});

// ===========================================================================
// Unusual values
// ===========================================================================

describe('saveDetails: unusual values (AC-28 .. AC-30, AC-32, AC-33)', () => {
  it('a deleted place is stored with its deleted mark (AC-28)', async () => {
    const d = await clientDetails(PARK);
    await save({ ...d, isDeleted: true });
    expect((await readDetailed(1381893)).isDeleted).toBe(true);
  });

  it('a deleted and blocked comment and its deleted reply stay present (AC-29)', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const d = await nestedDetails();
    await save({
      ...d,
      comments: [
        {
          ...mateja,
          isDeleted: true,
          isBlocked: true,
          replies: [{ ...serbia, isDeleted: true, replies: [{ ...paul, isBlocked: true }] }],
        },
      ],
    });
    const place = await readDetailed(62587);
    const top = storedNum(place.comments, 1);
    expect([top.isDeleted, top.isBlocked, top.presence]).toStrictEqual([true, true, 'present']);
    const reply = storedNum(top.replies, 2);
    expect([reply.isDeleted, reply.presence]).toStrictEqual([true, 'present']);
    const deepest = storedNum(reply.replies, 5);
    expect([deepest.isBlocked, deepest.presence]).toStrictEqual([true, 'present']);
  });

  it('keeps parent place 999 without creating place 999 (AC-30)', async () => {
    const d = await clientDetails(PARK);
    await save({ ...d, parentPlaceId: 999 });
    expect((await readDetailed(1381893)).parentPlaceId).toBe(999);
    expect(await readValue(999)).toStrictEqual({ found: false, placeId: 999 });
    expect((await counts()).places).toBe(1);
  });

  it('keeps a 7,000+ character description and a CRLF message character for character (AC-32)', async () => {
    const d = await clientDetails(SQUARE);
    const description = longMixedDescription(d.description);
    expect(description.length).toBeGreaterThanOrEqual(7000);
    const message = 'Lep pogled na &quot;Konja&quot; — Ђинђић\r\n';
    await save({ ...d, description, comments: [{ ...at(d.comments, 0), message }] });

    const place = await readDetailed(62587);
    expect(place.description).toBe(description);
    expect(place.description.length).toBe(description.length);
    expect(storedNum(place.comments, 1).message).toBe(message);
  });

  it('an empty description reads back as empty text (AC-33)', async () => {
    const d = await clientDetails(PARK);
    await save({ ...d, description: '' });
    expect((await readDetailed(1381893)).description).toBe('');
  });
});

// ===========================================================================
// Link precedence
// ===========================================================================

describe('saveDetails and saveListing: link precedence (AC-11, AC-31, AC-63, D1, D6)', () => {
  async function differentListing(url?: string): Promise<PlaceSummary> {
    const page = await clientListing('box-belgrade-page1.json');
    const summary = summaryOf(page, 62587);
    return {
      ...summary,
      url: url ?? summary.url,
      name: 'Republic Square',
      location: {
        lon: 20.46,
        lat: 44.816,
        north: 44.817,
        south: 44.815,
        east: 20.461,
        west: 20.459,
      },
      outline: [
        { lon: 20.459, lat: 44.815 },
        { lon: 20.461, lat: 44.815 },
        { lon: 20.46, lat: 44.817 },
      ],
    };
  }

  it('a Details Save after a Listing Save keeps the Listing Link, also after a change (AC-31)', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveSummaries(listingOf(summaryOf(page, 1381893)));
    const d = await clientDetails(PARK);
    await save(d);
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe(
      'http://wikimapia.org/1381893/University-Park',
    );
    expect(await save({ ...d, description: 'changed' }, LATER_FETCHED_AT)).toStrictEqual({
      places: [{ placeId: 1381893, outcome: 'updated' }],
    });
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe(
      'http://wikimapia.org/1381893/University-Park',
    );
  });

  it('a listing with other name, location and outline but the same Built Link is unchanged (AC-11)', async () => {
    await save(await clientDetails(SQUARE));
    const before = await snapshot([62587]);
    const report = await saveSummaries(listingOf(await differentListing(buildWikimapiaLink(62587))));
    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'unchanged' }] });
    expect(await snapshot([62587])).toStrictEqual(before);
  });

  it('a listing with the Listing Link changes only wikimapiaUrl and leaves the shapes (AC-11)', async () => {
    await save(await clientDetails(SQUARE));
    const before = await readDetailed(62587);
    const shapesBefore = await shapesValue(62587);

    const report = await saveSummaries(listingOf(await differentListing()));
    expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
    expect(await readDetailed(62587)).toStrictEqual({
      ...before,
      wikimapiaUrl: 'http://wikimapia.org/62587/Square-of-the-Republic',
    });
    expect(await shapesValue(62587)).toStrictEqual(shapesBefore);

    const again = await saveSummaries(listingOf({ ...(await differentListing()), name: 'Trg' }));
    expect(again).toStrictEqual({ places: [{ placeId: 62587, outcome: 'unchanged' }] });
  });

  it('the Listing Link replaces a Built Link and nothing else (AC-63)', async () => {
    await save(await clientDetails(PARK));
    const before = await readDetailed(1381893);
    expect(before.wikimapiaUrl).toBe('http://wikimapia.org/1381893');
    const shapesBefore = await shapesValue(1381893);

    const page = await clientListing('box-belgrade-page1.json');
    const report = await saveSummaries(listingOf(summaryOf(page, 1381893)));
    expect(report).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });
    expect(await readDetailed(1381893)).toStrictEqual({
      ...before,
      wikimapiaUrl: 'http://wikimapia.org/1381893/University-Park',
    });
    expect(await shapesValue(1381893)).toStrictEqual(shapesBefore);
  });
});

// ===========================================================================
// All or nothing
// ===========================================================================

describe('saveDetails: all or nothing (AC-56)', () => {
  async function changedSquare(d: PlaceDetails): Promise<PlaceDetails> {
    const { paul } = await nestedParts();
    return {
      ...d,
      description: 'Changed on Wikimapia.',
      tags: [at(d.tags, 1), { id: 300, title: 'fountain' }],
      comments: [{ ...at(d.comments, 1), message: 'changed' }, rehome(paul, 62587, 3)],
    };
  }

  const failures: [string, (failAt: number, seen: (n: number) => void) => WriteHook][] = [
    [
      'rejects',
      (failAt, seen) => (n) => {
        seen(n);
        return n === failAt ? Promise.reject(new Error('simulated outage')) : Promise.resolve();
      },
    ],
    [
      'throws synchronously',
      (failAt, seen) => (n) => {
        seen(n);
        if (n === failAt) throw new Error('simulated outage');
      },
    ],
  ];

  it.each(failures)(
    'a hook that %s after any write leaves 62587 exactly as before until the save succeeds',
    async (_name, failingHook) => {
      const d = await clientDetails(SQUARE);
      await save(d);
      const before = await snapshot([62587]);
      const d2 = await changedSquare(d);
      const input = detailsInput(d2, LATER_FETCHED_AT);

      let injected = 0;
      let succeeded = false;
      for (let failAt = 1; failAt <= 200 && !succeeded; failAt += 1) {
        let highest = 0;
        const hook = failingHook(failAt, (n) => {
          highest = Math.max(highest, n);
        });
        try {
          const report = SaveReportSchema.parse(await saveDetails(db, input, hook));
          expect(report).toStrictEqual({ places: [{ placeId: 62587, outcome: 'updated' }] });
          succeeded = true;
          expect(highest).toBeLessThan(failAt);
          expect(highest).toBeGreaterThanOrEqual(1);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error).toHaveProperty('message', 'simulated outage');
          expect(highest).toBe(failAt);
          expect(await snapshot([62587])).toStrictEqual(before);
          injected += 1;
        }
      }
      expect(injected).toBeGreaterThanOrEqual(1);
      expect(succeeded).toBe(true);
      const place = await readDetailed(62587);
      expect(place.description).toBe('Changed on Wikimapia.');
      expect(asPlaceDetails(place)).toStrictEqual({
        ...d2,
        comments: [...d2.comments, at(d.comments, 0)],
        tags: [...d2.tags, at(d.tags, 0)],
      });
      expect(presenceMarks(place)).toStrictEqual([
        'tag 46360: present',
        'tag 300: present',
        'tag 44926: gone',
        'comment 2: present',
        'comment 3: present',
        'comment 1: gone',
      ]);
    },
    120_000,
  );
});

// ===========================================================================
// Lock and transaction
// ===========================================================================

describe('saveDetails: concurrent saves of one place serialize (AL4 1.5, AL6 rule 13)', () => {
  it('two concurrent saves both resolve and the place matches exactly one of them', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    const a: PlaceDetails = { ...d, title: 'Variant A', description: 'Description A' };
    const b: PlaceDetails = { ...d, title: 'Variant B', description: 'Description B' };

    const reports = await Promise.all([save(a, LATER_FETCHED_AT), save(b, LATER_FETCHED_AT)]);
    expect(reports).toStrictEqual([
      { places: [{ placeId: 62587, outcome: 'updated' }] },
      { places: [{ placeId: 62587, outcome: 'updated' }] },
    ]);

    const back = asPlaceDetails(await readDetailed(62587));
    expect(['Variant A', 'Variant B']).toContain(back.title);
    expect(back).toStrictEqual(back.title === 'Variant A' ? a : b);
    expect(await counts()).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
  });
});

// ===========================================================================
// loadDetailsState on a detailed place
// ===========================================================================

describe('loadDetailsState on a detailed place with gone items', () => {
  it('returns the place row, every comment row, every link and only stored input tag titles', async () => {
    const d = await clientDetails(SQUARE);
    await save(d);
    await save(reduced(d), LATER_FETCHED_AT);
    const probe: PlaceDetails = {
      ...d,
      tags: [
        { id: 46360, title: 'town square' },
        { id: 46360, title: 'town square' },
        { id: 999999, title: 'not stored' },
      ],
    };

    const state = await db.transaction((trx) => loadDetailsState(trx, probe));

    expect(state.place?.place_id).toBe(62587);
    expect(state.place?.details_fetched_at_text).toBe(LATER_FETCHED_AT);

    const c1 = at(d.comments, 0);
    const c2 = at(d.comments, 1);
    const rows = [...state.comments].sort((x, y) => x.num - y.num);
    expect(rows).toStrictEqual([
      {
        place_id: 62587,
        num: 1,
        parent_num: null,
        lang_id: c1.langId,
        author: c1.author,
        author_user_id: c1.authorUserId,
        author_photo_url: c1.authorPhotoUrl ?? null,
        message: c1.message,
        good_votes: c1.goodVotes,
        bad_votes: c1.badVotes,
        is_blocked: c1.isBlocked,
        is_deleted: c1.isDeleted,
        posted_at_epoch_seconds: c1.postedAtEpochSeconds,
        moderator_user_id: c1.moderatorUserId,
        moderator_name: c1.moderatorName ?? null,
        presence: 'gone',
        position: null,
      },
      {
        place_id: 62587,
        num: 2,
        parent_num: null,
        lang_id: c2.langId,
        author: c2.author,
        author_user_id: c2.authorUserId,
        author_photo_url: c2.authorPhotoUrl ?? null,
        message: c2.message,
        good_votes: c2.goodVotes,
        bad_votes: c2.badVotes,
        is_blocked: c2.isBlocked,
        is_deleted: c2.isDeleted,
        posted_at_epoch_seconds: c2.postedAtEpochSeconds,
        moderator_user_id: c2.moderatorUserId,
        moderator_name: c2.moderatorName ?? null,
        presence: 'present',
        position: 0,
      },
    ]);

    const links = [...state.links].sort((x, y) => x.tag_id - y.tag_id);
    expect(links).toStrictEqual([
      {
        place_id: 62587,
        tag_id: 44926,
        presence: 'gone',
        position: null,
        title: 'historic town square',
      },
      { place_id: 62587, tag_id: 46360, presence: 'present', position: 0, title: 'town square' },
    ]);

    expect(state.tagTitles).toBeInstanceOf(Map);
    expect([...state.tagTitles]).toStrictEqual([[46360, 'town square']]);
  });
});
