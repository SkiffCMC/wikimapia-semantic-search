/**
 * AL2 unit tests: `src/db/save-listing.ts` and `src/db/read.ts` against the Test Database
 * (AL4 1.3 `read.ts` and `save-listing.ts` blocks, 1.4.5 Listing Save, 1.4.7 Writer and fault
 * hook, 1.4.8 Read-back, 1.4.9 Map shapes, 1.5 Transaction boundaries). AL3 routing
 * 20261021-storage-06-listing, 2.1 B.
 *
 * Module-level stand-in for contract ACs AC-7 .. AC-15, AC-44, AC-45, AC-48, AC-49, AC-50 and
 * AC-70 (listing parts) until `contracts/storage.test.ts` can load (U8).
 *
 * Runs on a `createDb(requireTestDatabaseUrl(), POOL_MAX_STORE)` handle. Issues no SQL itself:
 * data goes in through `saveListing` and comes out through the `read.ts` functions. Every read
 * result is parsed with its contract schema and every report with `SaveReportSchema`.
 */
import { z } from 'zod';
import type { Knex } from 'knex';
import { saveListing } from '../../src/db/save-listing';
import {
  countAll,
  listCommentKeys,
  listLinksOfTag,
  listTagCatalogue,
  loadDetailsState,
  loadListingState,
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
  SaveReportSchema,
  SchemaStepsResultSchema,
  StoreCountsSchema,
  StoredCommentKeySchema,
  TagCatalogueSchema,
  WGS84_SRID,
} from '../../contracts/storage.schema';
import type {
  PlaceShapes,
  ReadPlaceValue,
  SaveReport,
  SchemaSetup,
  StoreCounts,
  StoredPlace,
  SummaryOnlyPlace,
  WriteHook,
} from '../../contracts/storage.schema';
import {
  at,
  clientDetails,
  clientListing,
  listingOf,
  requireTestDatabaseUrl,
  summaryOf,
} from '../../contracts/storage.support';
import type { ListingPage, PlaceSummary, Point } from '../../contracts/wikimapia-client.schema';

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

const BELGRADE_IDS = [1381893, 62587, 164369] as const;
const EMPTY_COUNTS: StoreCounts = { places: 0, comments: 0, tags: 0, placeTagLinks: 0 };
const UNKNOWN_ID = 424242;

async function save(page: ListingPage, onWrite?: WriteHook): Promise<SaveReport> {
  return SaveReportSchema.parse(await saveListing(db, page, onWrite));
}

async function readValue(placeId: number): Promise<ReadPlaceValue> {
  return ReadPlaceValueSchema.parse(await readPlaceValue(db, placeId));
}

async function read(placeId: number): Promise<StoredPlace> {
  const value = await readValue(placeId);
  if (!value.found) throw new Error(`place ${String(placeId)} is not stored`);
  return value.place;
}

async function readSummaryOnly(placeId: number): Promise<SummaryOnlyPlace> {
  const place = await read(placeId);
  if (place.status !== 'summary_only')
    throw new Error(`place ${String(placeId)} is ${place.status}`);
  return place;
}

async function shapesValue(placeId: number) {
  return ReadShapesValueSchema.parse(await readShapesValue(db, placeId));
}

async function shapes(placeId: number): Promise<PlaceShapes> {
  const value = await shapesValue(placeId);
  if (!value.found) throw new Error(`place ${String(placeId)} has no stored shapes`);
  return value.shapes;
}

async function counts(): Promise<StoreCounts> {
  return StoreCountsSchema.parse(await countAll(db));
}

async function commentKeys(placeId: number) {
  return z.array(StoredCommentKeySchema).parse(await listCommentKeys(db, placeId));
}

/** Everything observable about the given places through `read.ts` (for "nothing changed"). */
async function snapshot(placeIds: readonly number[]) {
  const places = [];
  for (const id of placeIds) {
    places.push({
      value: await readValue(id),
      shapes: await shapesValue(id),
      comments: await commentKeys(id),
    });
  }
  return {
    places,
    catalogue: TagCatalogueSchema.parse(await listTagCatalogue(db)),
    counts: await counts(),
  };
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

function failingAt(failAt: number): WriteHook {
  return (n) => {
    if (n === failAt) throw new Error('simulated outage');
  };
}

const throwingHook: WriteHook = () => {
  throw new Error('no write expected');
};

async function belgradePage(): Promise<ListingPage> {
  return clientListing('box-belgrade-page1.json');
}

// ===========================================================================
// Listing Save
// ===========================================================================

describe('saveListing: new places (AC-7)', () => {
  it('reports the three Belgrade places created, in page order, and stores them summary-only', async () => {
    const page = await belgradePage();
    const report = await save(page);
    expect(report).toStrictEqual({
      places: page.places.map((p) => ({ placeId: p.placeId, outcome: 'created' })),
    });
    expect(report.places.map((p) => p.placeId)).toStrictEqual([...BELGRADE_IDS]);
    expect(await counts()).toStrictEqual({ places: 3, comments: 0, tags: 0, placeTagLinks: 0 });
    for (const id of BELGRADE_IDS) expect((await read(id)).status).toBe('summary_only');
  });
});

describe('readPlaceValue: summary content (AC-8, AC-14, AC-49)', () => {
  it('reads University Park back exactly as the AC-8 summary-only place', async () => {
    await save(await belgradePage());
    expect(await readValue(1381893)).toStrictEqual({
      found: true,
      place: {
        status: 'summary_only',
        placeId: 1381893,
        name: 'University Park',
        wikimapiaUrl: 'http://wikimapia.org/1381893/University-Park',
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
        tags: [],
        comments: [],
      },
    });
  });

  it('carries no details fetch moment and no page data', async () => {
    await save(await belgradePage());
    for (const id of [1381893, 164369]) {
      const place = await read(id);
      expect(place).not.toHaveProperty('detailsFetchedAt');
      expect(place).not.toHaveProperty('page');
      expect(place).not.toHaveProperty('pageSize');
      expect(place).not.toHaveProperty('totalFound');
    }
  });
});

describe('saveListing: idempotent (AC-9)', () => {
  it('a second identical save reports all unchanged, changes nothing and makes no write', async () => {
    const page = await belgradePage();
    await save(page);
    const before = await snapshot(BELGRADE_IDS);
    const hook = vi.fn<WriteHook>();
    const report = await save(page, hook);
    expect(report).toStrictEqual({
      places: BELGRADE_IDS.map((placeId) => ({ placeId, outcome: 'unchanged' })),
    });
    expect(hook).not.toHaveBeenCalled();
    expect(await snapshot(BELGRADE_IDS)).toStrictEqual(before);
  });
});

describe('saveListing: update of a summary-only place (AC-10)', () => {
  it('takes a new name, link, location and outline and reports updated', async () => {
    const page = await belgradePage();
    await save(page);
    const changed: PlaceSummary = {
      ...summaryOf(page, 1381893),
      name: 'University Park (Studentski park)',
      url: 'http://wikimapia.org/1381893/Studentski-park',
      location: {
        lon: 20.4579,
        lat: 44.8196,
        north: 44.8204,
        south: 44.8187,
        east: 20.4591,
        west: 20.4566,
      },
      outline: [
        { lon: 20.4566, lat: 44.8198 },
        { lon: 20.4575, lat: 44.8204 },
        { lon: 20.4591, lat: 44.8191 },
      ],
    };
    const report = await save(listingOf(changed));
    expect(report).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });
    const place = await readSummaryOnly(1381893);
    expect(place.name).toBe(changed.name);
    expect(place.wikimapiaUrl).toBe(changed.url);
    expect(place.location).toStrictEqual(changed.location);
    expect(place.outline).toStrictEqual(changed.outline);
    const stored = await shapes(1381893);
    expect(stored.centrePoint.point.lon).toBeCloseTo(changed.location.lon, 9);
    expect(stored.centrePoint.point.lat).toBeCloseTo(changed.location.lat, 9);
    expectSamePoints(stored.outlineShape?.ring ?? [], ring(changed.outline));
  });

  it('a change of the outline alone is an update', async () => {
    const page = await belgradePage();
    await save(page);
    const summary = summaryOf(page, 1381893);
    const report = await save(listingOf({ ...summary, outline: summary.outline.slice(0, 3) }));
    expect(report).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });
    expect((await read(1381893)).outline).toStrictEqual(summary.outline.slice(0, 3));
  });
});

describe('saveListing: same place twice in one page (AC-13)', () => {
  it('reports the place once at its first position and stores its last occurrence', async () => {
    const page = await belgradePage();
    const first = summaryOf(page, 1381893);
    const last: PlaceSummary = { ...first, name: 'Studentski park' };
    const report = await save(listingOf(first, summaryOf(page, 62587), last));
    expect(report).toStrictEqual({
      places: [
        { placeId: 1381893, outcome: 'created' },
        { placeId: 62587, outcome: 'created' },
      ],
    });
    expect((await read(1381893)).name).toBe('Studentski park');
    expect((await counts()).places).toBe(2);
  });
});

describe('saveListing: empty page (AC-12)', () => {
  it('reports no places and changes nothing', async () => {
    await save(await belgradePage());
    const before = await snapshot(BELGRADE_IDS);
    const report = await save(await clientListing('box-belgrade-empty-page.json'));
    expect(report).toStrictEqual({ places: [] });
    expect(await snapshot(BELGRADE_IDS)).toStrictEqual(before);
  });

  it('never calls the hook', async () => {
    const hook = vi.fn<WriteHook>(throwingHook);
    const report = await save(await clientListing('box-belgrade-empty-page.json'), hook);
    expect(report).toStrictEqual({ places: [] });
    expect(hook).not.toHaveBeenCalled();
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });
});

describe('saveListing: all or nothing (AC-15)', () => {
  it('a hook that throws after any write rolls the whole page back', async () => {
    const page = await belgradePage();
    let injected = 0;
    let succeeded = false;
    for (let failAt = 1; failAt <= 100; failAt += 1) {
      try {
        await saveListing(db, page, failingAt(failAt));
        succeeded = true;
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty('message', 'simulated outage');
      }
      expect(await counts()).toStrictEqual(EMPTY_COUNTS);
      injected += 1;
    }
    expect(succeeded).toBe(true);
    expect(injected).toBeGreaterThanOrEqual(1);
    expect((await counts()).places).toBe(3);
  });

  it('a hook that rejects at write 2 rejects the save and leaves nothing stored', async () => {
    const page = await belgradePage();
    const hook: WriteHook = (n) =>
      n === 2 ? Promise.reject(new Error('simulated async outage')) : Promise.resolve();
    await expect(saveListing(db, page, hook)).rejects.toThrow('simulated async outage');
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });
});

// ===========================================================================
// Map shapes
// ===========================================================================

describe('readShapesValue after a Listing Save (AC-44, AC-45, AC-48, AC-70)', () => {
  it('stores a WGS 84 centre point and the closed outline polygon of University Park', async () => {
    const page = await belgradePage();
    await save(page);
    const summary = summaryOf(page, 1381893);
    const value = await shapesValue(1381893);
    if (!value.found) throw new Error('shapes of 1381893 not found');
    expect(value.shapes.placeId).toBe(1381893);
    const centre = value.shapes.centrePoint;
    expect(centre.type).toBe('Point');
    expect(centre.srid).toBe(WGS84_SRID);
    expect(centre.point.lon).toBeCloseTo(summary.location.lon, 9);
    expect(centre.point.lat).toBeCloseTo(summary.location.lat, 9);
    const outline = value.shapes.outlineShape;
    expect(outline?.type).toBe('Polygon');
    expect(outline?.srid).toBe(WGS84_SRID);
    expectSamePoints(outline?.ring ?? [], ring(summary.outline));
  });

  it('drops the outline shape when the outline shrinks to 2 points, and restores it when it grows back', async () => {
    const page = await belgradePage();
    await save(page);
    const summary = summaryOf(page, 1381893);
    expect((await shapes(1381893)).outlineShape).toBeDefined();

    const shrunk = await save(listingOf({ ...summary, outline: summary.outline.slice(0, 2) }));
    expect(shrunk).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });
    const afterShrink = await shapes(1381893);
    expect(afterShrink).not.toHaveProperty('outlineShape');
    expect(afterShrink.centrePoint.point.lon).toBeCloseTo(summary.location.lon, 9);
    expect((await read(1381893)).outline).toStrictEqual(summary.outline.slice(0, 2));

    const grown = await save(listingOf(summary));
    expect(grown).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'updated' }] });
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(summary.outline));
  });

  const small: [string, Point[]][] = [
    ['1 point', [{ lon: 20.4566, lat: 44.8198 }]],
    ['no points', []],
  ];

  it.each(small)(
    'a summary with %s is saved with a centre point and no outline shape',
    async (_n, outline) => {
      const page = await belgradePage();
      const summary = summaryOf(page, 1381893);
      const report = await save(listingOf({ ...summary, outline }));
      expect(report).toStrictEqual({ places: [{ placeId: 1381893, outcome: 'created' }] });
      expect((await read(1381893)).outline).toStrictEqual(outline);
      const stored = await shapes(1381893);
      expect(stored).not.toHaveProperty('outlineShape');
      expect(stored.centrePoint.type).toBe('Point');
      expect(stored.centrePoint.srid).toBe(WGS84_SRID);
      expect(stored.centrePoint.point.lon).toBeCloseTo(summary.location.lon, 9);
      expect(stored.centrePoint.point.lat).toBeCloseTo(summary.location.lat, 9);
    },
  );
});

// ===========================================================================
// Other reads
// ===========================================================================

describe('reads of a place that is not stored (AC-50)', () => {
  it('readPlaceValue answers not found', async () => {
    expect(await readValue(UNKNOWN_ID)).toStrictEqual({ found: false, placeId: UNKNOWN_ID });
  });

  it('readShapesValue answers not found', async () => {
    expect(await shapesValue(UNKNOWN_ID)).toStrictEqual({ found: false, placeId: UNKNOWN_ID });
  });
});

describe('inspection reads on a summary-only store', () => {
  beforeEach(async () => {
    await save(await belgradePage());
  });

  it('listTagCatalogue is empty', async () => {
    expect(TagCatalogueSchema.parse(await listTagCatalogue(db))).toStrictEqual([]);
  });

  it('listLinksOfTag is empty', async () => {
    expect(z.array(PlaceTagLinkSchema).parse(await listLinksOfTag(db, 194))).toStrictEqual([]);
  });

  it('listCommentKeys is empty for a stored and an unknown place', async () => {
    expect(await commentKeys(1381893)).toStrictEqual([]);
    expect(await commentKeys(UNKNOWN_ID)).toStrictEqual([]);
  });

  it('countAll counts the three places and nothing else', async () => {
    expect(await counts()).toStrictEqual({ places: 3, comments: 0, tags: 0, placeTagLinks: 0 });
  });
});

describe('countAll on an empty store', () => {
  it('is all zeros', async () => {
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });
});

// ===========================================================================
// State loaders (used inside the save transactions)
// ===========================================================================

describe('loadListingState', () => {
  it('returns the stored rows of the given ids only', async () => {
    await save(listingOf(summaryOf(await belgradePage(), 62587)));
    const state = await db.transaction((trx) => loadListingState(trx, [62587, UNKNOWN_ID]));
    expect(state.rows).toHaveLength(1);
    const row = at(state.rows, 0);
    expect(row.place_id).toBe(62587);
    expect(row.name).toBe('Square of the Republic');
    expect(row.details_fetched_at_text).toBeNull();
  });

  it('returns no rows for an empty id list', async () => {
    const state = await db.transaction((trx) => loadListingState(trx, []));
    expect(state).toStrictEqual({ rows: [] });
  });
});

describe('loadDetailsState on a summary-only or missing place', () => {
  it('gives the summary-only row, no comments, no links and no stored tag titles', async () => {
    await save(await belgradePage());
    const fetched = await clientDetails('getbyid-1381893.json');
    const details = { ...fetched, tags: [...fetched.tags, { id: 46360, title: 'square' }] };
    expect(details.tags).toHaveLength(2);
    const state = await db.transaction((trx) => loadDetailsState(trx, details));
    expect(state.place?.place_id).toBe(1381893);
    expect(state.place?.details_fetched_at_text).toBeNull();
    expect(state.place?.name).toBe('University Park');
    expect(state.comments).toStrictEqual([]);
    expect(state.links).toStrictEqual([]);
    expect(state.tagTitles).toBeInstanceOf(Map);
    expect(state.tagTitles.size).toBe(0);
  });

  it('gives no place row for a place that is not stored', async () => {
    await save(await belgradePage());
    const fetched = await clientDetails('getbyid-1381893.json');
    const details = { ...fetched, placeId: UNKNOWN_ID };
    const state = await db.transaction((trx) => loadDetailsState(trx, details));
    expect(state.place).toBeUndefined();
    expect(state.comments).toStrictEqual([]);
    expect(state.links).toStrictEqual([]);
    expect(state.tagTitles.size).toBe(0);
  });
});

// ===========================================================================
// Reads inside a read-only snapshot transaction (how U8 calls them)
// ===========================================================================

describe('reads inside a read-only REPEATABLE READ transaction', () => {
  it('readPlaceValue and readShapesValue give the same values as outside a transaction', async () => {
    await save(await belgradePage());
    const outside = { value: await readValue(1381893), shapes: await shapesValue(1381893) };
    const inside = await db.transaction(
      async (trx) => ({
        value: ReadPlaceValueSchema.parse(await readPlaceValue(trx, 1381893)),
        shapes: ReadShapesValueSchema.parse(await readShapesValue(trx, 1381893)),
      }),
      { isolationLevel: 'repeatable read', readOnly: true },
    );
    expect(inside).toStrictEqual(outside);
    expect(inside.value.found).toBe(true);
  });

  it('answers not found inside the transaction too', async () => {
    const inside = await db.transaction(
      async (trx) => ({
        value: ReadPlaceValueSchema.parse(await readPlaceValue(trx, UNKNOWN_ID)),
        shapes: ReadShapesValueSchema.parse(await readShapesValue(trx, UNKNOWN_ID)),
      }),
      { isolationLevel: 'repeatable read', readOnly: true },
    );
    expect(inside).toStrictEqual({
      value: { found: false, placeId: UNKNOWN_ID },
      shapes: { found: false, placeId: UNKNOWN_ID },
    });
  });
});
