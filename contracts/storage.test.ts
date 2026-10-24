/**
 * AL5 CONTRACT TESTS: Place Store (behaviour, black box, against the Test Database).
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261021-storage-al6.md (revision 2; one describe per AC)
 * Enforces: .agrules section 2 (inputs re-checked with Zod, invalid input is a handled error),
 *           section 3 (extensions and tables created only by Schema Setup), section 4 (no
 *           Commenter IPs, Wikimapia attribution kept, recorded fixtures, no live network,
 *           no secrets in failures, strict types).
 *
 * Subjects under test: the real `createPlaceStore` from `src/db/place-store.ts` (ENTRY_POINT)
 * and `createSchemaSetup` from `src/db/schema-setup.ts` (SCHEMA_SETUP_ENTRY_POINT), connected
 * to the Test Database named by `TEST_DATABASE_URL`. Neither is doubled. Inputs are the real
 * Wikimapia Client's reading of the recorded fixtures (see ./storage.support.ts) or small
 * synthetic values. Until AL2 exists this file fails to import: that is the expected red state.
 *
 * Schema-only and validator checks live in ./storage.schema.test.ts and pass before AL2.
 */
import { createPlaceStore } from '../src/db/place-store';
import { createSchemaSetup } from '../src/db/schema-setup';
import { EMBEDDING_COLUMN, EMBEDDING_TABLE } from './embeddings.schema';
import {
  DATABASE_URL_ENV,
  EmptyResultSchema,
  PlaceTagLinksResultSchema,
  REQUIRED_EXTENSIONS,
  ReadPlaceResultSchema,
  ReadShapesResultSchema,
  STORE_TABLES,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  StoreStructureResultSchema,
  StoredCommentKeysResultSchema,
  TEST_DATABASE_NAME_SUFFIX,
  TagCatalogueResultSchema,
  WGS84_SRID,
  buildWikimapiaLink,
  type CreatePlaceStoreFn,
  type CreateSchemaSetupFn,
  type DetailedPlace,
  type PlaceShapes,
  type PlaceStore,
  type ReadPlaceValue,
  type SaveOutcomeKind,
  type SaveReport,
  type SchemaSetup,
  type StoreFailure,
  type StoreStructure,
  type StoredPlace,
  type SummaryOnlyPlace,
} from './storage.schema';
import {
  EVEN_LATER_FETCHED_AT,
  FETCHED_AT,
  LATER_FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
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
} from './storage.support';
import {
  findCommenterIpPaths,
  type Comment,
  type ListingPage,
  type PlaceDetails,
  type PlaceSummary,
  type Point,
} from './wikimapia-client.schema';
import { SYNTHETIC_IPS } from './wikimapia-client.support';

// Compile-time check: the entry points have the contract's signatures.
const createStore: CreatePlaceStoreFn = createPlaceStore;
const createSetup: CreateSchemaSetupFn = createSchemaSetup;

// ---------------------------------------------------------------------------
// Lifecycle: one Test Database, Schema Setup applied, emptied before every test (AC-61)
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let store: PlaceStore;
/** Every attempted `fetch` (Wikimapia, OpenAI, anything): must stay empty (AC-62). */
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in storage contract tests'));
  });
  testUrl = requireTestDatabaseUrl();
  setup = createSetup({ connectionString: testUrl });
  okSteps(await setup.apply());
  store = createStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  const emptied = EmptyResultSchema.parse(await setup.emptyStore());
  expect(emptied.ok).toBe(true);
});

afterAll(async () => {
  await store.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers (every result is parsed with its contract schema before use)
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  return result.value;
}

function failureOf<T>(result: Result<T>): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

function invalidData<T>(result: Result<T>) {
  const failure = failureOf(result);
  if (failure.kind !== 'invalid_data')
    throw new Error(`expected invalid_data, got ${failure.kind}`);
  return failure;
}

function okSteps(result: unknown): string[] {
  return okValue(SchemaStepsResultSchema.parse(result)).steps;
}

async function inspect(): Promise<StoreStructure> {
  return okValue(StoreStructureResultSchema.parse(await setup.inspect()));
}

function samePath(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function hasIssueAt(
  failure: { issues: { path: (string | number)[] }[] },
  path: (string | number)[],
) {
  return failure.issues.some((issue) => samePath(issue.path, path));
}

async function trySaveListing(page: unknown) {
  return SaveResultSchema.parse(await store.saveListingPage(page as ListingPage));
}

async function saveListing(page: ListingPage): Promise<SaveReport> {
  return okValue(await trySaveListing(page));
}

async function trySaveDetailsRequest(request: unknown) {
  return SaveResultSchema.parse(
    await store.savePlaceDetails(request as Parameters<PlaceStore['savePlaceDetails']>[0]),
  );
}

// fetchedAt is passed exactly as given (no default), so `undefined` really is a missing moment.
async function trySaveDetails(details: unknown, fetchedAt: unknown) {
  return trySaveDetailsRequest({ details, fetchedAt });
}

async function saveDetails(
  details: PlaceDetails,
  fetchedAt: string = FETCHED_AT,
): Promise<SaveReport> {
  return okValue(await trySaveDetails(details, fetchedAt));
}

function outcomes(report: SaveReport): Record<number, SaveOutcomeKind> {
  return Object.fromEntries(report.places.map((p) => [p.placeId, p.outcome]));
}

function onlyOutcome(report: SaveReport, placeId: number): SaveOutcomeKind {
  expect(report.places).toHaveLength(1);
  const entry = at(report.places, 0);
  expect(entry.placeId).toBe(placeId);
  return entry.outcome;
}

async function readValue(placeId: number): Promise<ReadPlaceValue> {
  return okValue(ReadPlaceResultSchema.parse(await store.readPlace({ placeId })));
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

async function readSummaryOnly(placeId: number): Promise<SummaryOnlyPlace> {
  const place = await read(placeId);
  if (place.status !== 'summary_only')
    throw new Error(`place ${String(placeId)} is ${place.status}`);
  return place;
}

async function shapes(placeId: number): Promise<PlaceShapes> {
  const value = okValue(ReadShapesResultSchema.parse(await store.readPlaceShapes({ placeId })));
  if (!value.found) throw new Error(`place ${String(placeId)} has no stored shapes`);
  return value.shapes;
}

async function tagCatalogue() {
  return okValue(TagCatalogueResultSchema.parse(await store.listTags()));
}

async function tagLinks(tagId: number) {
  return okValue(PlaceTagLinksResultSchema.parse(await store.listPlaceTagLinks({ tagId })));
}

async function commentKeys(placeId: number) {
  return okValue(StoredCommentKeysResultSchema.parse(await store.listStoredComments({ placeId })));
}

async function counts() {
  return okValue(StoreCountsResultSchema.parse(await store.countStored()));
}

/** Everything observable about the given Places and the whole store (for "nothing changed"). */
async function snapshot(placeIds: readonly number[]) {
  const places = [];
  for (const id of placeIds) {
    const value = await readValue(id);
    places.push({
      value,
      comments: await commentKeys(id),
      shapes: okValue(ReadShapesResultSchema.parse(await store.readPlaceShapes({ placeId: id }))),
    });
  }
  const catalogue = await tagCatalogue();
  const links = [];
  for (const tag of catalogue) links.push(await tagLinks(tag.id));
  return { places, catalogue, links, counts: await counts() };
}

const BELGRADE_IDS = [1381893, 62587, 164369] as const;
const EMPTY_COUNTS = { places: 0, comments: 0, tags: 0, placeTagLinks: 0 };

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

// ===========================================================================
// 3.1 Databases and Schema Setup (US-7)
// ===========================================================================

describe('AC-1 Two databases', () => {
  it('the separate Test Database (*_test) has map-shape support and Vector Support available', async () => {
    const name = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    expect(name.endsWith(TEST_DATABASE_NAME_SUFFIX)).toBe(true);
    const structure = await inspect();
    for (const extension of REQUIRED_EXTENSIONS) {
      expect(structure.availableExtensions).toContain(extension);
    }
  });
});

describe('AC-2 Setup from nothing', () => {
  afterEach(async () => {
    okSteps(await setup.apply());
  });

  it('after undoing everything, Schema Setup creates all storage with Presence Marks and enables extensions', async () => {
    okSteps(await setup.undoAll());
    const applied = okSteps(await setup.apply());
    expect(applied.length).toBeGreaterThan(0);

    const structure = await inspect();
    expect(structure.pendingSteps).toStrictEqual([]);
    expect(structure.appliedSteps).toStrictEqual(applied);
    const tables = structure.tables.map((t) => t.name);
    for (const table of Object.values(STORE_TABLES)) expect(tables).toContain(table);
    for (const extension of REQUIRED_EXTENSIONS) {
      expect(structure.enabledExtensions).toContain(extension);
    }

    await saveDetails(await clientDetails('getbyid-62587.json'));
    const place = await readDetailed(62587);
    expect(presenceMarks(place)).toStrictEqual([
      'tag 44926: present',
      'tag 46360: present',
      'comment 1: present',
      'comment 2: present',
    ]);
    expect(await counts()).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
  });
});

describe('AC-3 Setup repeated', () => {
  it('applies no step a second time and changes no stored data', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const before = await snapshot([62587]);
    const stepsBefore = (await inspect()).appliedSteps;

    expect(okSteps(await setup.apply())).toStrictEqual([]);

    expect((await inspect()).appliedSteps).toStrictEqual(stepsBefore);
    expect(await snapshot([62587])).toStrictEqual(before);
  });
});

describe('AC-4 Setup undone', () => {
  afterEach(async () => {
    okSteps(await setup.apply());
  });

  it('undoing every step removes the storage, and re-applying succeeds', async () => {
    const applied = (await inspect()).appliedSteps;
    const undone = okSteps(await setup.undoAll());
    expect([...undone].sort()).toStrictEqual([...applied].sort());

    const after = await inspect();
    expect(after.appliedSteps).toStrictEqual([]);
    const tables = after.tables.map((t) => t.name);
    for (const table of Object.values(STORE_TABLES)) expect(tables).not.toContain(table);
    // The step that enabled Vector Support is undone too (it is enabled by Schema Setup, not by hand).
    expect(after.enabledExtensions).not.toContain('vector');

    expect(okSteps(await setup.apply())).toStrictEqual(applied);
    const reapplied = await inspect();
    for (const table of Object.values(STORE_TABLES)) {
      expect(reapplied.tables.map((t) => t.name)).toContain(table);
    }
  });
});

// Narrowed by feature `hydration` (AL6 20261022-hydration-al6.md AC-55, R2, gap G3, approved by
// the stakeholder): Crawl Progress storage is now allowed. Replaced by feature `embeddings` (AL6
// 20261023-embeddings-al6.md AC-57, R1, approved by the stakeholder): "the only place for vectors
// is the Embedding Record of a Place, 1024 numbers each". The 1024 dimensions are read through the
// Embedding Store and checked in ./embeddings.test.ts (AC-53, AC-57), so this file keeps importing
// only the Place Store and Schema Setup.
describe('AC-5 Vectors only in the Embedding Record of a Place', () => {
  it('the only vector column is the Embedding column; no other embedding or vector storage; Vector Support is enabled', async () => {
    const structure = await inspect();
    expect(structure.enabledExtensions).toContain('vector');
    const vectorColumns = structure.tables.flatMap((table) =>
      table.columns.filter((c) => c.udtName === 'vector').map((c) => `${table.name}.${c.name}`),
    );
    expect(vectorColumns).toStrictEqual([`${EMBEDDING_TABLE}.${EMBEDDING_COLUMN}`]);
    for (const table of structure.tables) {
      if (table.name === EMBEDDING_TABLE) continue;
      expect(table.name).not.toMatch(/embedding|vector/i);
      for (const column of table.columns) {
        expect(column.name).not.toMatch(/embedding|vector/i);
      }
    }
  });
});

describe('AC-6 No place for Commenter IPs', () => {
  it('the comments storage has an author column and nothing that could hold an IP', async () => {
    const comments = (await inspect()).tables.find((t) => t.name === STORE_TABLES.comments);
    expect(comments).toBeDefined();
    const columns = comments?.columns ?? [];
    expect(columns.some((c) => /author/i.test(c.name))).toBe(true);
    for (const column of columns) {
      expect(column.name).not.toMatch(/(^|_)ip($|_)|ip_?addr|user_?ip|commenter_?ip|userip/i);
      expect(['inet', 'cidr']).not.toContain(column.udtName);
    }
  });
});

// ===========================================================================
// 3.2 Saving a Listing Page (US-1, US-3, US-5, US-6)
// ===========================================================================

describe('AC-7 Happy path, new Places', () => {
  it('stores the three Belgrade places as Summary-Only and reports each Created', async () => {
    const report = await saveListing(await clientListing('box-belgrade-page1.json'));
    expect(outcomes(report)).toStrictEqual({
      1381893: 'created',
      62587: 'created',
      164369: 'created',
    });
    for (const id of BELGRADE_IDS) expect((await read(id)).status).toBe('summary_only');
    expect(await counts()).toStrictEqual({ places: 3, comments: 0, tags: 0, placeTagLinks: 0 });
  });
});

describe('AC-8 Summary content kept', () => {
  it('reads University Park back with name, link, location, outline and no details', async () => {
    await saveListing(await clientListing('box-belgrade-page1.json'));
    const place = await readSummaryOnly(1381893);
    expect(place).toStrictEqual({
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
    });
  });
});

describe('AC-9 Listing Save is idempotent', () => {
  it('a second identical save changes nothing and reports all Unchanged', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveListing(page);
    const before = await snapshot(BELGRADE_IDS);
    const report = await saveListing(page);
    expect(outcomes(report)).toStrictEqual({
      1381893: 'unchanged',
      62587: 'unchanged',
      164369: 'unchanged',
    });
    expect(await snapshot(BELGRADE_IDS)).toStrictEqual(before);
  });
});

describe('AC-10 Listing Save updates a Summary-Only Place', () => {
  it('takes a new name, link, location and outline and reports Updated', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveListing(page);
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
    const report = await saveListing(listingOf(changed));
    expect(outcomes(report)).toStrictEqual({ 1381893: 'updated' });
    const place = await readSummaryOnly(1381893);
    expect(place.name).toBe(changed.name);
    expect(place.wikimapiaUrl).toBe(changed.url);
    expect(place.location).toStrictEqual(changed.location);
    expect(place.outline).toStrictEqual(changed.outline);
  });

  it('a change of the outline alone is an update', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveListing(page);
    const summary = summaryOf(page, 1381893);
    const report = await saveListing(
      listingOf({ ...summary, outline: summary.outline.slice(0, 3) }),
    );
    expect(outcomes(report)).toStrictEqual({ 1381893: 'updated' });
    expect((await read(1381893)).outline).toStrictEqual(summary.outline.slice(0, 3));
  });
});

describe('AC-11 Details take precedence over a listing (D1)', () => {
  async function differentListing(): Promise<PlaceSummary> {
    const page = await clientListing('box-belgrade-page1.json');
    return {
      ...summaryOf(page, 62587),
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

  it('only the Wikimapia Link is taken from the summary; the link change reports Updated', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const before = await readDetailed(62587);
    const shapesBefore = await shapes(62587);
    const summary = await differentListing();

    const report = await saveListing(listingOf(summary));
    expect(outcomes(report)).toStrictEqual({ 62587: 'updated' });
    const after = await readDetailed(62587);
    expect(after).toStrictEqual({
      ...before,
      wikimapiaUrl: 'http://wikimapia.org/62587/Square-of-the-Republic',
    });
    expect(await shapes(62587)).toStrictEqual(shapesBefore);
  });

  it('differences in name, location or outline alone report Unchanged', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const summary = await differentListing();
    await saveListing(listingOf(summary));
    const before = await snapshot([62587]);

    const report = await saveListing(listingOf({ ...summary, name: 'Trg Republike' }));
    expect(outcomes(report)).toStrictEqual({ 62587: 'unchanged' });
    expect(await snapshot([62587])).toStrictEqual(before);
  });
});

describe('AC-12 Empty Listing Page', () => {
  it('changes nothing, reports no Places and no failure', async () => {
    await saveListing(await clientListing('box-belgrade-page1.json'));
    const before = await snapshot(BELGRADE_IDS);
    const report = await saveListing(await clientListing('box-belgrade-empty-page.json'));
    expect(report.places).toStrictEqual([]);
    expect(await snapshot(BELGRADE_IDS)).toStrictEqual(before);
  });
});

describe('AC-13 Same Place twice in one page', () => {
  it('stores the Place once with its last occurrence and reports it once', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    const first = summaryOf(page, 1381893);
    const last: PlaceSummary = { ...first, name: 'Studentski park' };
    const report = await saveListing(listingOf(first, summaryOf(page, 62587), last));
    expect(report.places.filter((p) => p.placeId === 1381893)).toStrictEqual([
      { placeId: 1381893, outcome: 'created' },
    ]);
    expect((await read(1381893)).name).toBe('Studentski park');
    expect((await counts()).places).toBe(2);
  });
});

describe('AC-14 Listing Page totals not stored', () => {
  it('no stored column holds the page number, page size or Total Found', async () => {
    await saveListing(await clientListing('box-belgrade-page1.json'));
    for (const table of (await inspect()).tables) {
      for (const column of table.columns) {
        expect(column.name).not.toMatch(
          /^(page|page_?size|page_?number|count|found|total_?found|total)$/i,
        );
      }
    }
  });
});

describe('AC-15 Listing Save is all or nothing', () => {
  it.each([
    ['a non-positive Place ID', 1, { placeId: 0 }, 'placeId'],
    ['a link to another Place', 2, { url: 'http://wikimapia.org/55/Eiffel-Tower' }, 'url'],
  ] as const)(
    'a summary with %s: Invalid Data naming it, no Place saved or changed',
    async (_name, index, change, item) => {
      const page = await clientListing('box-belgrade-page1.json');
      await saveListing(listingOf(summaryOf(page, 62587)));
      const before = await snapshot(BELGRADE_IDS);
      const bad = {
        ...page,
        places: page.places.map((p, i) => (i === index ? { ...p, ...change } : p)),
      };
      const failure = invalidData(await trySaveListing(bad));
      expect(hasIssueAt(failure, ['places', index, item])).toBe(true);
      expect(await snapshot(BELGRADE_IDS)).toStrictEqual(before);
    },
  );

  it('a failure part way through a Listing Save leaves no Place saved (fault injected after each write)', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    let injected = 0;
    for (let failAt = 1; failAt <= 100; failAt += 1) {
      const faulty = createStore({
        connectionString: testUrl,
        onWrite: (n) => {
          if (n === failAt) throw new Error('simulated outage');
        },
      });
      const result = SaveResultSchema.parse(await faulty.saveListingPage(page));
      await faulty.close();
      if (result.ok) break;
      expect(result.failure.kind).toBe('store_unavailable');
      expect(await counts()).toStrictEqual(EMPTY_COUNTS);
      injected += 1;
    }
    expect(injected).toBeGreaterThanOrEqual(1);
    expect((await counts()).places).toBe(3);
  });
});

describe('AC-63 Listing Link replaces a Built Link (D1, D6)', () => {
  it('a Listing Save sets the Listing Link, changes nothing else and reports Updated', async () => {
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    const before = await readDetailed(1381893);
    expect(before.wikimapiaUrl).toBe('http://wikimapia.org/1381893');

    const page = await clientListing('box-belgrade-page1.json');
    const report = await saveListing(listingOf(summaryOf(page, 1381893)));
    expect(outcomes(report)).toStrictEqual({ 1381893: 'updated' });
    expect(await readDetailed(1381893)).toStrictEqual({
      ...before,
      wikimapiaUrl: 'http://wikimapia.org/1381893/University-Park',
    });
  });
});

// ===========================================================================
// 3.3 Saving Place Details (US-2, US-3, US-5, US-6, US-9)
// ===========================================================================

describe('AC-16 Happy path, new Place with Comments', () => {
  it('stores Square of the Republic as a Detailed Place and reports Created', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const report = await saveDetails(d, FETCHED_AT);
    expect(onlyOutcome(report, 62587)).toBe('created');

    const place = await readDetailed(62587);
    expect(place.name).toBe('Square of the Republic');
    expect(place.wikimapiaUrl).toBe('http://wikimapia.org/62587');
    expect(place.description).toBe(d.description);
    expect(place.description).toContain('Трг Републике');
    expect(place.description).toContain('Đinđić');
    expect(place.description).toContain('\n');
    expect(place.tags).toStrictEqual([
      { id: 44926, title: 'historic town square', presence: 'present' },
      { id: 46360, title: 'town square', presence: 'present' },
    ]);
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place.isBuilding).toBe(false);
    expect(place.isRegion).toBe(false);
    expect(place.isDeleted).toBe(false);
    expect(place.wikipediaUrl).toBe('http://en.wikipedia.org/wiki/Republic_Square_(Belgrade)');
    expect(place.outline).toStrictEqual(d.outline);
    expect(place.location).toStrictEqual({
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
    expect(place.detailsFetchedAt).toBe('2026-10-21T10:00:00Z');
    expect(levelOrder(place.comments)).toStrictEqual([
      [1, 'present'],
      [2, 'present'],
    ]);
  });
});

describe('AC-17 Comments kept in full', () => {
  it('keeps every field of both comments, without replies, marked Present', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    const place = await readDetailed(62587);
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
});

describe('AC-18 Round trip', () => {
  // One input per equivalence class (62587 is covered field by field by AC-16 and AC-17).
  const cases: [string, () => Promise<PlaceDetails>][] = [
    [
      'University Park (1381893, absent optional items)',
      () => clientDetails('getbyid-1381893.json'),
    ],
    ['Eiffel Tower (55, street, house number, moderator)', () => clientDetails('getbyid-55.json')],
    ['synthetic nesting (AC-34, replies)', () => nestedDetails()],
  ];

  it.each(cases)(
    '%s reads back identical, all Present, Built Link, fetch moment kept',
    async (_name, load) => {
      const d = await load();
      await saveDetails(d, LATER_FETCHED_AT);
      const place = await readDetailed(d.placeId);
      expect(asPlaceDetails(place)).toStrictEqual(d);
      expect(presenceMarks(place).filter((mark) => !mark.endsWith(': present'))).toStrictEqual([]);
      expect(place.wikimapiaUrl).toBe(buildWikimapiaLink(d.placeId));
      expect(place.detailsFetchedAt).toBe(LATER_FETCHED_AT);
    },
  );
});

describe('AC-19 Place without Comments', () => {
  it('reads University Park back with its tag and an empty list of comments', async () => {
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    const place = await readDetailed(1381893);
    expect(place.name).toBe('University Park');
    expect(place.description).toBe('Belgrade,Serbia.');
    expect(place.tags).toStrictEqual([{ id: 194, title: 'park', presence: 'present' }]);
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place.location).not.toHaveProperty('street');
    expect(place.location).not.toHaveProperty('houseNumber');
    expect(place.comments).toStrictEqual([]);
  });
});

describe('AC-20 Details complete a Summary-Only Place', () => {
  it('becomes Detailed, reports Updated, takes details values and keeps the Listing Link', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    const summary = summaryOf(page, 1381893);
    await saveListing(listingOf({ ...summary, name: 'Univerzitetski park' }));
    const d = await clientDetails('getbyid-1381893.json');

    expect(onlyOutcome(await saveDetails(d), 1381893)).toBe('updated');
    const place = await readDetailed(1381893);
    expect(place.name).toBe(d.title);
    expect(place.location).toStrictEqual(d.location);
    expect(place.outline).toStrictEqual(d.outline);
    expect(place.wikimapiaUrl).toBe('http://wikimapia.org/1381893/University-Park');
  });
});

describe('AC-21 Details Save is idempotent', () => {
  it.each([
    ['flat comments', () => clientDetails('getbyid-62587.json')],
    ['nested replies', () => nestedDetails()],
  ])(
    'the same details (%s) with the same fetch moment change nothing and report Unchanged',
    async (_name, load) => {
      const d = await load();
      await saveDetails(d, FETCHED_AT);
      const before = await snapshot([62587]);
      expect(onlyOutcome(await saveDetails(d, FETCHED_AT), 62587)).toBe('unchanged');
      expect(await snapshot([62587])).toStrictEqual(before);
    },
  );
});

describe('AC-22 Re-fetched, nothing changed (D3)', () => {
  it('only Details Fetched At moves forward; the save reports Unchanged', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d, FETCHED_AT);
    const before = await readDetailed(62587);
    const keysBefore = await commentKeys(62587);

    expect(onlyOutcome(await saveDetails(d, LATER_FETCHED_AT), 62587)).toBe('unchanged');
    expect(await readDetailed(62587)).toStrictEqual({
      ...before,
      detailsFetchedAt: LATER_FETCHED_AT,
    });
    expect(await commentKeys(62587)).toStrictEqual(keysBefore);
  });
});

describe('AC-23 Details changed on Wikimapia', () => {
  it('reads back the new values and reports Updated', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
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
    expect(onlyOutcome(await saveDetails(d2, LATER_FETCHED_AT), 62587)).toBe('updated');
    expect(asPlaceDetails(await readDetailed(62587))).toStrictEqual(d2);
  });

  it.each([
    ['deleted mark', (d: PlaceDetails): PlaceDetails => ({ ...d, isDeleted: true })],
    [
      'address item',
      (d: PlaceDetails): PlaceDetails => ({ ...d, location: { ...d.location, city: 'Beograd' } }),
    ],
  ])('a change of the %s alone reports Updated', async (_name, change) => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    expect(onlyOutcome(await saveDetails(change(d)), 62587)).toBe('updated');
  });
});

describe('AC-24 Optional items removed on Wikimapia', () => {
  it('Wikipedia link, Parent Place ID and street read back as absent', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const withItems: PlaceDetails = {
      ...d,
      parentPlaceId: 999,
      location: { ...d.location, street: 'Trg Republike' },
    };
    await saveDetails(withItems);
    const withoutItems = omitKeys(withItems, 'parentPlaceId', 'wikipediaUrl');
    const location = omitKeys(withItems.location, 'street');
    await saveDetails({ ...withoutItems, location });

    const place = await readDetailed(62587);
    expect(place).not.toHaveProperty('wikipediaUrl');
    expect(place).not.toHaveProperty('parentPlaceId');
    expect(place.location).not.toHaveProperty('street');
  });
});

describe('AC-25 Comment changed', () => {
  it('comment 1 takes the new values, comment 2 is unchanged, both Present, Updated', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    const before = await readDetailed(62587);
    const c1 = at(d.comments, 0);
    const changed: Comment = {
      ...c1,
      message: 'Still waiting.',
      goodVotes: 6,
      badVotes: 16,
      isDeleted: true,
      isBlocked: true,
    };
    const report = await saveDetails({ ...d, comments: [changed, at(d.comments, 1)] });

    expect(onlyOutcome(report, 62587)).toBe('updated');
    const place = await readDetailed(62587);
    expect(storedNum(place.comments, 1)).toStrictEqual({ ...changed, presence: 'present' });
    expect(storedNum(place.comments, 2)).toStrictEqual(storedNum(before.comments, 2));
  });
});

describe('AC-26 Comment added', () => {
  it('reads back all 3 comments in the order given, all Present, Updated', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    const { paul } = await nestedParts();
    const third = rehome(paul, 62587, 3);
    const report = await saveDetails({ ...d, comments: [...d.comments, third] });

    expect(onlyOutcome(report, 62587)).toBe('updated');
    expect(levelOrder((await readDetailed(62587)).comments)).toStrictEqual([
      [1, 'present'],
      [2, 'present'],
      [3, 'present'],
    ]);
  });
});

describe('AC-27 Comments and Tags no longer on Wikimapia are kept as Gone (D2)', () => {
  it('keeps comment 1 and tag 44926 marked Gone with their last values; Updated', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    const before = await readDetailed(62587);
    const report = await saveDetails(
      { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] },
      LATER_FETCHED_AT,
    );

    expect(onlyOutcome(report, 62587)).toBe('updated');
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
  });
});

describe('AC-64 Gone items are idempotent', () => {
  it.each([
    ['the same fetch moment', LATER_FETCHED_AT],
    ['a later fetch moment', EVEN_LATER_FETCHED_AT],
  ])(
    're-saving the reduced details with %s keeps them Gone and reports Unchanged',
    async (_name, moment) => {
      const d = await clientDetails('getbyid-62587.json');
      await saveDetails(d);
      const reduced = { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] };
      await saveDetails(reduced, LATER_FETCHED_AT);
      const before = await readDetailed(62587);
      const keysBefore = await commentKeys(62587);

      expect(onlyOutcome(await saveDetails(reduced, moment), 62587)).toBe('unchanged');
      expect(await readDetailed(62587)).toStrictEqual({ ...before, detailsFetchedAt: moment });
      expect(await commentKeys(62587)).toStrictEqual(keysBefore);
      expect(await counts()).toStrictEqual({ places: 1, comments: 2, tags: 2, placeTagLinks: 2 });
    },
  );
});

describe('AC-65 Gone items come back', () => {
  it('comment 1 and tag 44926 become Present with the new values and position; stored once; Updated', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    await saveDetails(
      { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] },
      LATER_FETCHED_AT,
    );
    const back: Comment = {
      ...at(d.comments, 0),
      message: 'Everybody is waiting for someone here',
      goodVotes: 9,
    };
    const report = await saveDetails(
      { ...d, comments: [at(d.comments, 1), back], tags: [at(d.tags, 1), at(d.tags, 0)] },
      EVEN_LATER_FETCHED_AT,
    );

    expect(onlyOutcome(report, 62587)).toBe('updated');
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
  });
});

describe('AC-66 Gone Reply', () => {
  it('"Paul" stays a Reply of "Serbia", marked Gone with all its values', async () => {
    const d = await nestedDetails();
    await saveDetails(d);
    const { mateja, serbia, paul } = await nestedParts();
    await saveDetails(
      { ...d, comments: [{ ...mateja, replies: [{ ...serbia, replies: [] }] }] },
      LATER_FETCHED_AT,
    );

    const place = await readDetailed(62587);
    expect(levelOrder(place.comments)).toStrictEqual([[1, 'present']]);
    const serbiaStored = storedNum(storedNum(place.comments, 1).replies, 2);
    expect(serbiaStored.presence).toBe('present');
    expect(serbiaStored.replies).toStrictEqual([{ ...paul, presence: 'gone', replies: [] }]);
  });
});

describe('AC-67 Gone Comment with Replies', () => {
  it('"Paul" top-level Present; "Mateja" Gone with Reply "Serbia" Gone and no replies; Updated', async () => {
    const d = await nestedDetails();
    await saveDetails(d);
    const { mateja, serbia, paul } = await nestedParts();
    const report = await saveDetails({ ...d, comments: [paul] }, LATER_FETCHED_AT);

    expect(onlyOutcome(report, 62587)).toBe('updated');
    const place = await readDetailed(62587);
    expect(place.comments).toStrictEqual([
      { ...paul, presence: 'present', replies: [] },
      { ...mateja, presence: 'gone', replies: [{ ...serbia, presence: 'gone', replies: [] }] },
    ]);
  });
});

describe('AC-68 All Comments gone', () => {
  it('keeps both comments as Gone and reports no failure', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    await saveDetails({ ...d, comments: [] }, LATER_FETCHED_AT);
    expect(levelOrder((await readDetailed(62587)).comments)).toStrictEqual([
      [1, 'gone'],
      [2, 'gone'],
    ]);
  });
});

describe('AC-28 Deleted Place kept', () => {
  it('stores the Place and reads the deleted mark back', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails({ ...d, isDeleted: true });
    expect((await readDetailed(1381893)).isDeleted).toBe(true);
  });
});

describe('AC-29 Deleted or blocked Comment kept', () => {
  it('keeps a deleted and blocked comment and a deleted reply, Present, with their replies', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    const d = await nestedDetails();
    const marked: PlaceDetails = {
      ...d,
      comments: [
        {
          ...mateja,
          isDeleted: true,
          isBlocked: true,
          replies: [{ ...serbia, isDeleted: true, replies: [{ ...paul, isBlocked: true }] }],
        },
      ],
    };
    await saveDetails(marked);
    const place = await readDetailed(62587);
    const top = storedNum(place.comments, 1);
    expect([top.isDeleted, top.isBlocked, top.presence]).toStrictEqual([true, true, 'present']);
    const reply = storedNum(top.replies, 2);
    expect([reply.isDeleted, reply.presence]).toStrictEqual([true, 'present']);
    expect(storedNum(reply.replies, 5).isBlocked).toBe(true);
  });
});

describe('AC-30 Parent Place not stored', () => {
  it('keeps Parent Place ID 999 and does not create Place 999', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails({ ...d, parentPlaceId: 999 });
    expect((await readDetailed(1381893)).parentPlaceId).toBe(999);
    expect(await readValue(999)).toStrictEqual({ found: false, placeId: 999 });
  });
});

describe('AC-31 Details-only Place gets a Built Link (D6)', () => {
  it('reads back http://wikimapia.org/1381893; a re-save keeps it and reports Unchanged', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails(d);
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe('http://wikimapia.org/1381893');
    expect(onlyOutcome(await saveDetails(d), 1381893)).toBe('unchanged');
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe('http://wikimapia.org/1381893');
  });

  it('a Details Save never replaces a Listing Link', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveListing(listingOf(summaryOf(page, 1381893)));
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails(d);
    await saveDetails({ ...d, description: 'changed' }, LATER_FETCHED_AT);
    expect((await readDetailed(1381893)).wikimapiaUrl).toBe(
      'http://wikimapia.org/1381893/University-Park',
    );
  });
});

describe('AC-32 Long and non-Latin text', () => {
  it('keeps a 7,000+ character description and a CRLF-terminated message character for character', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const description = longMixedDescription(d.description);
    expect(description.length).toBeGreaterThanOrEqual(7000);
    const message = 'Lep pogled na &quot;Konja&quot; — Ђинђић\r\n';
    await saveDetails({ ...d, description, comments: [{ ...at(d.comments, 0), message }] });

    const place = await readDetailed(62587);
    expect(place.description).toBe(description);
    expect(storedNum(place.comments, 1).message).toBe(message);
  });
});

describe('AC-33 Empty description', () => {
  it('reads back as empty text without failure', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails({ ...d, description: '' });
    expect((await readDetailed(1381893)).description).toBe('');
  });
});

// ===========================================================================
// 3.4 Comment Replies (US-2, US-4, US-6)
// ===========================================================================

describe('AC-34 Replies stored and rebuilt', () => {
  it('rebuilds Mateja > Serbia > Paul with all fields, all Present', async () => {
    const { mateja, serbia, paul } = await nestedParts();
    await saveDetails(await nestedDetails());
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
});

describe('AC-35 Each Reply is a Comment of the Place', () => {
  it('stores 3 comments keyed by (62587, num) with their Parent Comments', async () => {
    await saveDetails(await nestedDetails());
    expect(await commentKeys(62587)).toStrictEqual([
      { placeId: 62587, num: 1, presence: 'present' },
      { placeId: 62587, num: 2, parentNum: 1, presence: 'present' },
      { placeId: 62587, num: 5, parentNum: 2, presence: 'present' },
    ]);
    expect((await counts()).comments).toBe(3);
  });
});

describe('AC-36 Order of Replies', () => {
  it('keeps several replies in the order given (Serbia, Ramona, then Paul)', async () => {
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const d = await nestedDetails();
    await saveDetails({ ...d, comments: [{ ...mateja, replies: [serbia, ramona, paul] }] });
    const place = await readDetailed(62587);
    expect(levelOrder(storedNum(place.comments, 1).replies)).toStrictEqual([
      [2, 'present'],
      [7, 'present'],
      [5, 'present'],
    ]);
  });
});

describe('AC-37 Reply moved', () => {
  it('"Paul" becomes top-level, "Serbia" has no replies, all Present, Updated', async () => {
    const d = await nestedDetails();
    await saveDetails(d);
    const { mateja, serbia, paul } = await nestedParts();
    const moved = { ...d, comments: [{ ...mateja, replies: [serbia] }, paul] };
    expect(onlyOutcome(await saveDetails(moved, LATER_FETCHED_AT), 62587)).toBe('updated');

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
  });
});

const DEPTH_2 = ['details', 'comments', 0, 'replies', 0, 'replies', 0] as const;

describe('AC-38 Comment from another Place rejected (D5)', () => {
  it.each([
    [
      'the nested-replies fixture ("Paul" with Place ID 55 at depth 2)',
      () => clientDetails('getbyid-62587-nested-replies.json'),
      [...DEPTH_2, 'placeId'],
      5,
    ],
    [
      'a top-level comment with Place ID 55',
      async (): Promise<PlaceDetails> => {
        const d = await clientDetails('getbyid-62587.json');
        return { ...d, comments: [{ ...at(d.comments, 0), placeId: 55 }, at(d.comments, 1)] };
      },
      ['details', 'comments', 0, 'placeId'],
      1,
    ],
  ])(
    '%s is Invalid Data naming its number and Place ID; nothing saved',
    async (_name, load, path, commentNum) => {
      const failure = invalidData(await trySaveDetails(await load(), FETCHED_AT));
      const issue = failure.issues.find((i) => samePath(i.path, path));
      expect(issue).toMatchObject({ commentNum, placeId: 55 });
      expect(await counts()).toStrictEqual(EMPTY_COUNTS);
    },
  );
});

describe('AC-39 Duplicate comment number', () => {
  it.each([
    [
      'two top-level comments with number 2',
      async (): Promise<PlaceDetails> => {
        const d = await clientDetails('getbyid-62587.json');
        return { ...d, comments: [{ ...at(d.comments, 0), num: 2 }, at(d.comments, 1)] };
      },
      ['details', 'comments', 1, 'num'],
      2,
    ],
    [
      "a reply reusing its ancestor's number at depth 2",
      async (): Promise<PlaceDetails> => {
        const { mateja, serbia, paul } = await nestedParts();
        const d = await nestedDetails();
        return {
          ...d,
          comments: [{ ...mateja, replies: [{ ...serbia, replies: [{ ...paul, num: 1 }] }] }],
        };
      },
      [...DEPTH_2, 'num'],
      1,
    ],
  ])('%s: Invalid Data naming the number, nothing saved', async (_name, load, path, commentNum) => {
    const failure = invalidData(await trySaveDetails(await load(), FETCHED_AT));
    const issue = failure.issues.find((i) => samePath(i.path, path));
    expect(issue).toMatchObject({ commentNum });
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });
});

// ===========================================================================
// 3.5 Tags and categories (US-2, US-5)
// ===========================================================================

async function universityParkWithTownSquareTag(): Promise<PlaceDetails> {
  const d = await clientDetails('getbyid-1381893.json');
  return { ...d, tags: [...d.tags, { id: 46360, title: 'town square' }] };
}

describe('AC-40 Shared Tag Catalogue', () => {
  it('Tag 46360 is in the catalogue once and both Places are linked to it', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await universityParkWithTownSquareTag());
    expect(await tagCatalogue()).toStrictEqual([
      { id: 194, title: 'park' },
      { id: 44926, title: 'historic town square' },
      { id: 46360, title: 'town square' },
    ]);
    expect((await tagLinks(46360)).map((l) => l.placeId)).toStrictEqual([62587, 1381893]);
  });
});

describe('AC-41 Places of a Tag', () => {
  it('exactly the two Places are linked to 46360, Present; 62587 also to 44926', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await universityParkWithTownSquareTag());
    expect(await tagLinks(46360)).toStrictEqual([
      { placeId: 62587, tagId: 46360, presence: 'present' },
      { placeId: 1381893, tagId: 46360, presence: 'present' },
    ]);
    expect(await tagLinks(44926)).toStrictEqual([
      { placeId: 62587, tagId: 44926, presence: 'present' },
    ]);
  });
});

describe('AC-42 Tag title changed on Wikimapia', () => {
  it('the new title shows for every Place linked to the Tag, Present or Gone', async () => {
    const park = await clientDetails('getbyid-1381893.json');
    const square = await clientDetails('getbyid-62587.json');
    await saveDetails(park);
    await saveDetails({ ...square, tags: [...square.tags, { id: 194, title: 'park' }] });
    await saveDetails(square, LATER_FETCHED_AT); // 62587's link to 194 is now Gone
    await saveDetails({ ...park, tags: [{ id: 194, title: 'city park' }] }, LATER_FETCHED_AT);

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
});

describe('AC-43 Same Tag twice in one Place', () => {
  it('links the Tag once, without failure', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails({
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
  });
});

describe('AC-69 Gone link to a shared Tag', () => {
  it("62587's link to 46360 is Gone, the other stays Present, the Tag stays once", async () => {
    const square = await clientDetails('getbyid-62587.json');
    await saveDetails(square);
    await saveDetails(await universityParkWithTownSquareTag());
    await saveDetails({ ...square, tags: [at(square.tags, 0)] }, LATER_FETCHED_AT);

    expect(await tagLinks(46360)).toStrictEqual([
      { placeId: 62587, tagId: 46360, presence: 'gone' },
      { placeId: 1381893, tagId: 46360, presence: 'present' },
    ]);
    expect((await tagCatalogue()).filter((t) => t.id === 46360)).toHaveLength(1);
  });
});

// ===========================================================================
// 3.6 Map shapes (US-5)
// ===========================================================================

describe('AC-44 Outline kept as a closed shape', () => {
  it('stores a WGS 84 polygon visiting the 19 points in order and back to the first', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    const stored = await shapes(62587);
    expect(stored.outlineShape?.type).toBe('Polygon');
    expect(stored.outlineShape?.srid).toBe(WGS84_SRID);
    expectSamePoints(stored.outlineShape?.ring ?? [], ring(d.outline));
    expect((await read(62587)).outline).toStrictEqual(d.outline);
  });
});

describe('AC-45 Centre Point kept', () => {
  it('is a WGS 84 point at the Location centre, for summary-only and detailed places', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    await saveListing(listingOf(summaryOf(page, 1381893)));
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    for (const [placeId, location] of [
      [1381893, summaryOf(page, 1381893).location],
      [62587, d.location],
    ] as const) {
      const centre = (await shapes(placeId)).centrePoint;
      expect(centre.type).toBe('Point');
      expect(centre.srid).toBe(WGS84_SRID);
      expect(centre.point.lon).toBeCloseTo(location.lon, 9);
      expect(centre.point.lat).toBeCloseTo(location.lat, 9);
    }
  });
});

const CLOSED_OUTLINE: Point[] = [
  { lon: 20.4566, lat: 44.8198 },
  { lon: 20.4575, lat: 44.8204 },
  { lon: 20.4591, lat: 44.8191 },
  { lon: 20.4566, lat: 44.8198 },
];

describe('AC-46 Outline already closed', () => {
  it('reads back exactly as given and the shape adds no second repeat', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails({ ...d, outline: CLOSED_OUTLINE });
    expect((await read(1381893)).outline).toStrictEqual(CLOSED_OUTLINE);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], CLOSED_OUTLINE);
  });
});

describe('AC-47 Unusual but drawable Outline', () => {
  it('a self-crossing (bow-tie) outline is saved and read back as given', async () => {
    const bowTie: Point[] = [
      { lon: 20.456, lat: 44.818 },
      { lon: 20.459, lat: 44.821 },
      { lon: 20.459, lat: 44.818 },
      { lon: 20.456, lat: 44.821 },
    ];
    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails({ ...d, outline: bowTie });
    expect((await read(1381893)).outline).toStrictEqual(bowTie);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(bowTie));
  });
});

describe('AC-48 Outline too small for a shape (D4)', () => {
  // Boundary (2 points) through one save path, empty edge through the other; AC-70 covers the rest.
  it.each([
    [
      'Place Details',
      '2 points',
      [
        { lon: 20.4566, lat: 44.8198 },
        { lon: 20.4575, lat: 44.8204 },
      ],
    ],
    ['Place Summary', 'no points', []],
  ] as [string, string, Point[]][])(
    '%s with %s: saved with Centre Point, no Outline Shape, outline as given',
    async (kind, _n, outline) => {
      let centreLon: number;
      if (kind === 'Place Details') {
        const d = await clientDetails('getbyid-1381893.json');
        await saveDetails({ ...d, outline });
        centreLon = d.location.lon;
      } else {
        const summary = summaryOf(await clientListing('box-belgrade-page1.json'), 1381893);
        await saveListing(listingOf({ ...summary, outline }));
        centreLon = summary.location.lon;
      }
      expect((await read(1381893)).outline).toStrictEqual(outline);
      const stored = await shapes(1381893);
      expect(stored).not.toHaveProperty('outlineShape');
      expect(stored.centrePoint.point.lon).toBeCloseTo(centreLon, 9);
    },
  );
});

describe('AC-70 Outline grows or shrinks', () => {
  it('a shape is dropped when the outline shrinks below 3 points, and added when it grows', async () => {
    const page = await clientListing('box-belgrade-page1.json');
    const summary = summaryOf(page, 1381893);
    await saveListing(listingOf(summary));
    expect((await shapes(1381893)).outlineShape).toBeDefined();

    await saveListing(listingOf({ ...summary, outline: summary.outline.slice(0, 2) }));
    expect(await shapes(1381893)).not.toHaveProperty('outlineShape');

    const d = await clientDetails('getbyid-1381893.json');
    await saveDetails(d);
    expectSamePoints((await shapes(1381893)).outlineShape?.ring ?? [], ring(d.outline));

    await saveDetails({ ...d, outline: [] }, LATER_FETCHED_AT);
    expect(await shapes(1381893)).not.toHaveProperty('outlineShape');
  });
});

// ===========================================================================
// 3.7 Reading a Place back (US-4, US-9)
// ===========================================================================

describe('AC-49 Read back form', () => {
  // The strict read-back schema (parsed by readDetailed) enforces the Client shapes plus a
  // Presence Mark on every Tag, Comment and Reply; AC-8 covers the Summary-Only form.
  it('a Detailed Place reads back in the strict contract shape with name, link and fetch moment', async () => {
    await saveDetails(await nestedDetails());
    const place = await readDetailed(62587);
    expect(place.name).toBe('Square of the Republic');
    expect(place.wikimapiaUrl).toBe(buildWikimapiaLink(62587));
    expect(place.detailsFetchedAt).toBe(FETCHED_AT);
  });
});

describe('AC-71 Read back returns Present and Gone together (D2)', () => {
  it('a single read returns Present and Gone comments and tags, each marked', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    await saveDetails(
      { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] },
      LATER_FETCHED_AT,
    );
    const marks = presenceMarks(await read(62587));
    expect([...marks].sort()).toStrictEqual(
      ['comment 1: gone', 'comment 2: present', 'tag 44926: gone', 'tag 46360: present'].sort(),
    );
  });
});

describe('AC-50 Place Not Found', () => {
  it('answers Place Not Found for 424242, not a failure', async () => {
    expect(await readValue(424242)).toStrictEqual({ found: false, placeId: 424242 });
  });
});

describe('AC-51 Invalid Place ID on read', () => {
  it.each([0, -3, 1.5])('placeId %s is Invalid Data naming placeId', async (placeId) => {
    const failure = invalidData(ReadPlaceResultSchema.parse(await store.readPlace({ placeId })));
    expect(hasIssueAt(failure, ['placeId'])).toBe(true);
  });

  it('does not consult the stored data (an unreachable store still answers Invalid Data)', async () => {
    const unreachable = createStore({ connectionString: UNREACHABLE_DATABASE_URL });
    try {
      const failure = invalidData(
        ReadPlaceResultSchema.parse(await unreachable.readPlace({ placeId: 0 })),
      );
      expect(hasIssueAt(failure, ['placeId'])).toBe(true);
    } finally {
      await unreachable.close();
    }
  });
});

describe('AC-52 Order of Comments', () => {
  it('Present in the latest order first, then Gone ascending by number, at every level', async () => {
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const square = await clientDetails('getbyid-62587.json');
    const c = (num: number, replies: Comment[] = []): Comment =>
      rehome(mateja, 62587, num, replies);
    // Top level 1..4 and 9; Serbia (2) holds replies 5 and 7.
    await saveDetails({
      ...square,
      comments: [c(4), { ...serbia, replies: [paul, ramona] }, c(1), c(3), c(9)],
    });
    // Latest details: 3 then 2 at top level; 2 keeps only reply 7.
    await saveDetails(
      { ...square, comments: [c(3), { ...serbia, replies: [ramona] }] },
      LATER_FETCHED_AT,
    );

    const place = await readDetailed(62587);
    expectPresentThenGone(levelOrder(place.comments), [3, 2], [1, 4, 9]);
    expectPresentThenGone(levelOrder(storedNum(place.comments, 2).replies), [7], [5]);
  });
});

describe('AC-72 Order of Tags', () => {
  it('Present in the latest order first, then Gone ascending by id', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const t = (id: number, title: string) => ({ id, title });
    await saveDetails({
      ...d,
      tags: [
        t(300, 'fountain'),
        t(46360, 'town square'),
        t(44926, 'historic town square'),
        t(194, 'park'),
      ],
    });
    await saveDetails({ ...d, tags: [t(194, 'park'), t(300, 'fountain')] }, LATER_FETCHED_AT);
    expectPresentThenGone(
      (await readDetailed(62587)).tags.map((tag): [number, string] => [tag.id, tag.presence]),
      [194, 300],
      [44926, 46360],
    );
  });
});

// ===========================================================================
// 3.8 Failures, atomicity and privacy (US-6, US-8)
// ===========================================================================

describe('AC-53 Wrong shape rejected', () => {
  it.each([
    [
      'Place Details without a title',
      async () =>
        trySaveDetails(omitKeys(await clientDetails('getbyid-62587.json'), 'title'), FETCHED_AT),
      ['details', 'title'],
    ],
    [
      'a reply to a reply with a fractional vote count',
      async () => {
        const { mateja, serbia, paul } = await nestedParts();
        const reply = { ...serbia, replies: [{ ...paul, goodVotes: 1.5 }] };
        const d = { ...(await nestedDetails()), comments: [{ ...mateja, replies: [reply] }] };
        return trySaveDetails(d, FETCHED_AT);
      },
      [...DEPTH_2, 'goodVotes'],
    ],
    [
      'a summary with longitude 200',
      async () => {
        const page = await clientListing('box-belgrade-page1.json');
        const first = at(page.places, 0);
        const moved = { ...first, location: { ...first.location, lon: 200 } };
        return trySaveListing({ ...page, places: [moved, ...page.places.slice(1)] });
      },
      ['places', 0, 'location', 'lon'],
    ],
  ])(
    '%s: Invalid Data naming the item and its position, nothing saved',
    async (_name, attempt, path) => {
      expect(hasIssueAt(invalidData(await attempt()), path)).toBe(true);
      expect(await counts()).toStrictEqual(EMPTY_COUNTS);
    },
  );

  it('a call without any input object is Invalid Data, not a rejection', async () => {
    invalidData(await trySaveListing(undefined));
    invalidData(SaveResultSchema.parse(await store.savePlaceDetails(undefined as never)));
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });
});

describe('AC-54 Commenter IP refused', () => {
  it.each([
    [
      '`user_ip` on a top-level comment',
      async (): Promise<unknown> => {
        const d = await clientDetails('getbyid-62587.json');
        return { ...d, comments: [{ ...at(d.comments, 0), user_ip: SYNTHETIC_IPS[0] }] };
      },
      SYNTHETIC_IPS[0],
    ],
    [
      'another spelling (`commenterIp`) on a reply to a reply',
      async (): Promise<unknown> => {
        const { mateja, serbia, paul } = await nestedParts();
        const reply = { ...serbia, replies: [{ ...paul, commenterIp: SYNTHETIC_IPS[1] }] };
        return { ...(await nestedDetails()), comments: [{ ...mateja, replies: [reply] }] };
      },
      SYNTHETIC_IPS[1],
    ],
  ])('%s is Invalid Data; nothing saved; the value is not echoed', async (_name, load, ip) => {
    const withIp = await load();
    expect(findCommenterIpPaths(withIp)).toHaveLength(1);
    const text = JSON.stringify(invalidData(await trySaveDetails(withIp, FETCHED_AT)));
    expect(text).not.toContain(String(ip));
    expect(text).not.toContain(String(Math.abs(ip)));
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });

  it('nothing read back ever carries a Commenter IP', async () => {
    await saveDetails(await nestedDetails());
    expect(findCommenterIpPaths(await store.readPlace({ placeId: 62587 }))).toStrictEqual([]);
  });
});

describe('AC-55 Missing Details Fetched At', () => {
  it.each([
    ['missing (key omitted)', {}],
    ['not a moment', { fetchedAt: 'yesterday' }],
    ['not UTC', { fetchedAt: '2026-10-21T12:00:00+02:00' }],
  ])('%s: Invalid Data naming fetchedAt, nothing saved', async (_name, moment) => {
    const details = await clientDetails('getbyid-62587.json');
    const failure = invalidData(await trySaveDetailsRequest({ details, ...moment }));
    expect(hasIssueAt(failure, ['fetchedAt'])).toBe(true);
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
  });
});

describe('AC-56 Details Save is all or nothing', () => {
  it('a failure after any write leaves Place 62587 exactly as D (fault injected after each write)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    const before = await snapshot([62587]);
    const { paul } = await nestedParts();
    const d2: PlaceDetails = {
      ...d,
      description: 'Changed on Wikimapia.',
      tags: [at(d.tags, 1), { id: 300, title: 'fountain' }],
      comments: [{ ...at(d.comments, 1), message: 'changed' }, rehome(paul, 62587, 3)],
    };

    let injected = 0;
    let succeeded = false;
    for (let failAt = 1; failAt <= 200 && !succeeded; failAt += 1) {
      let writes = 0;
      const faulty = createStore({
        connectionString: testUrl,
        onWrite: (n) => {
          writes = n;
          if (n === failAt) return Promise.reject(new Error('simulated outage'));
          return undefined;
        },
      });
      const result = SaveResultSchema.parse(
        await faulty.savePlaceDetails({ details: d2, fetchedAt: LATER_FETCHED_AT }),
      );
      await faulty.close();
      if (result.ok) {
        succeeded = true;
        expect(writes).toBeLessThan(failAt);
      } else {
        expect(result.failure.kind).toBe('store_unavailable');
        expect(await snapshot([62587])).toStrictEqual(before);
        injected += 1;
      }
    }
    expect(injected).toBeGreaterThanOrEqual(1);
    expect(succeeded).toBe(true);
    expect((await readDetailed(62587)).description).toBe('Changed on Wikimapia.');
  }, 120_000);
});

describe('AC-57 Store Unavailable', () => {
  it('every save and read on an unreachable store is Store Unavailable without secrets', async () => {
    const unreachable = createStore({ connectionString: UNREACHABLE_DATABASE_URL });
    const unreachableSetup = createSetup({ connectionString: UNREACHABLE_DATABASE_URL });
    try {
      const results: unknown[] = [
        SaveResultSchema.parse(
          await unreachable.saveListingPage(await clientListing('box-belgrade-page1.json')),
        ),
        SaveResultSchema.parse(
          await unreachable.savePlaceDetails({
            details: await clientDetails('getbyid-62587.json'),
            fetchedAt: FETCHED_AT,
          }),
        ),
        ReadPlaceResultSchema.parse(await unreachable.readPlace({ placeId: 62587 })),
        TagCatalogueResultSchema.parse(await unreachable.listTags()),
        PlaceTagLinksResultSchema.parse(await unreachable.listPlaceTagLinks({ tagId: 194 })),
        StoredCommentKeysResultSchema.parse(
          await unreachable.listStoredComments({ placeId: 62587 }),
        ),
        ReadShapesResultSchema.parse(await unreachable.readPlaceShapes({ placeId: 62587 })),
        StoreCountsResultSchema.parse(await unreachable.countStored()),
        SchemaStepsResultSchema.parse(await unreachableSetup.apply()),
        StoreStructureResultSchema.parse(await unreachableSetup.inspect()),
      ];
      for (const result of results) {
        const failure = failureOf(result as Result<unknown>);
        expect(failure.kind).toBe('store_unavailable');
        const text = JSON.stringify(failure);
        expect(text).not.toContain(UNREACHABLE_PASSWORD);
        expect(text).not.toContain(UNREACHABLE_DATABASE_URL);
        expect(text).not.toContain('postgres://');
      }
    } finally {
      await unreachable.close();
      await unreachableSetup.close();
    }
  }, 60_000);

  it.each([
    ['an empty connection string (never throws)', () => ''],
    [
      'a missing database on the real Test Database server',
      () => {
        const url = new URL(testUrl);
        url.pathname = '/wm_missing_database_test';
        return url.toString();
      },
    ],
  ])(
    '%s: reads resolve Store Unavailable without revealing the connection string',
    async (_name, connectionString) => {
      const url = connectionString();
      const broken = createStore({ connectionString: url });
      try {
        const failure = failureOf(
          ReadPlaceResultSchema.parse(await broken.readPlace({ placeId: 1 })),
        );
        expect(failure.kind).toBe('store_unavailable');
        const text = JSON.stringify(failure);
        if (url !== '') {
          const password = new URL(url).password;
          if (password !== '') expect(text).not.toContain(decodeURIComponent(password));
          expect(text).not.toContain(url);
        }
      } finally {
        await broken.close();
      }
    },
    60_000,
  );
});

describe('AC-58 Failures change nothing', () => {
  it('Invalid Data on a Details Save of a stored Place with Gone items changes no mark or value', async () => {
    const d = await clientDetails('getbyid-62587.json');
    await saveDetails(d);
    await saveDetails(
      { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] },
      LATER_FETCHED_AT,
    );
    await saveListing(
      listingOf(summaryOf(await clientListing('box-belgrade-page1.json'), 1381893)),
    );
    const before = await snapshot([62587, 1381893]);

    invalidData(await trySaveDetails({ ...d, comments: [] }, 'not a moment'));
    invalidData(
      await trySaveDetails({ ...d, comments: [at(d.comments, 0), at(d.comments, 0)] }, FETCHED_AT),
    );
    invalidData(await trySaveListing({ ...listingOf(), places: [{ placeId: 62587 }] }));

    expect(await snapshot([62587, 1381893])).toStrictEqual(before);
  });
});

describe('AC-59 Attribution kept', () => {
  it('every Place carries a Wikimapia Link and every Comment, Present or Gone, its author', async () => {
    const { paul } = await nestedParts();
    const d = await nestedDetails();
    await saveDetails(d);
    await saveDetails({ ...d, comments: [paul] }, LATER_FETCHED_AT);
    await saveListing(await clientListing('box-belgrade-page1.json'));
    for (const id of BELGRADE_IDS) {
      const place = await read(id);
      expect(place.wikimapiaUrl.startsWith(`http://wikimapia.org/${String(id)}`)).toBe(true);
    }
    const comments = flattenComments((await readDetailed(62587)).comments);
    expect(comments.map((c) => [c.author, c.presence])).toStrictEqual([
      ['Paul', 'present'],
      ['Mateja', 'gone'],
      ['Serbia', 'gone'],
    ]);
  });
});

// ===========================================================================
// 3.9 Tests (US-7, .agrules section 4)
// ===========================================================================

describe('AC-60 Test Database only', () => {
  it('the tests are connected to a database named *_test, never to DATABASE_URL', () => {
    expect(() => requireTestDatabaseUrl()).not.toThrow();
    const dev = process.env[DATABASE_URL_ENV];
    if (dev !== undefined && dev !== '') expect(testUrl).not.toBe(dev);
  });
});

describe('AC-61 Known starting state', () => {
  it('every test starts with Schema Setup fully applied and nothing stored; emptying keeps the structure', async () => {
    expect((await inspect()).pendingSteps).toStrictEqual([]);
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
    expect(await tagCatalogue()).toStrictEqual([]);

    await saveDetails(await clientDetails('getbyid-62587.json'));
    expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
    expect(await counts()).toStrictEqual(EMPTY_COUNTS);
    expect((await inspect()).pendingSteps).toStrictEqual([]);
  });
});

describe('AC-62 No external calls, small data', () => {
  it('no test of this file attempted any HTTP call (Wikimapia, OpenAI or other)', () => {
    expect(fetchCalls).toStrictEqual([]);
  });
});
