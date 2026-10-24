/**
 * AL2 unit tests: the Embedding Store `createEmbeddingStore` (`src/db/embedding-store.ts`, with
 * `src/db/embedding-read.ts`, `src/db/embedding-save.ts`, `src/db/vector.ts`) against the Test
 * Database.
 *
 * Design refs: AL4 embeddings 1.4.8 (Embedding Store), 1.5 (Transaction boundaries), 2.1
 * (`place_embeddings`); U2 "Unit tests must cover". AL3 routing 20261023-embeddings-02-store,
 * section 2.1 D. Stand-in for contract R2, AC-39, AC-53 (one per Place, dimensions), AC-54,
 * AC-56, AC-57 (dimension side) and AC-58 (counts) until `contracts/embeddings.test.ts` can load
 * (U7).
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Places are
 * seeded only through `createPlaceStore` with the recorded fixtures and `syntheticDetails`;
 * Embedding Records only through the store under test. Vectors come only from `fakeEmbedding` /
 * `fakeVector` (no vector literal in this file, contract AC-59). Every result is parsed with its
 * contract schema before any assertion. Failures are checked by `kind`, issue `path` and the
 * absence of secrets, never by driver message text. Every store and setup is closed.
 */
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import {
  EMBEDDING_COLUMN,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TABLE,
  EmbeddingCandidatesResultSchema,
  EmbeddingStorageInfoResultSchema,
  EmbeddingStoreCountsResultSchema,
  ReadEmbeddingRecordResultSchema,
  SIMILARITY_INDEX,
  SaveEmbeddingRecordsResultSchema,
  documentFingerprint,
  type CreateEmbeddingStoreFn,
  type EmbeddingCandidatesInput,
  type EmbeddingCandidatesValue,
  type EmbeddingRecord,
  type EmbeddingStore,
  type EmbeddingStoreCounts,
  type EmbeddingStoreOptions,
  type SaveEmbeddingRecordsInput,
} from '../../contracts/embeddings.schema';
import {
  fakeEmbedding,
  fakeVector,
  placeKSaves,
  PLACE_K_ID,
  syntheticDetails,
  syntheticName,
} from '../../contracts/embeddings.support';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  type DetailedPlace,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
  type WriteHook,
} from '../../contracts/storage.schema';
import {
  EVEN_LATER_FETCHED_AT,
  FETCHED_AT,
  LATER_FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  at,
  clientDetails,
  clientListing,
  nestedDetails,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import type { PlaceDetails } from '../../contracts/wikimapia-client.schema';

// Compile-time check: the entry point has the contract's signature.
const create: CreateEmbeddingStoreFn = createEmbeddingStore;

const SQUARE_ID = 62587;
const PARK_ID = 1381893;
const SUMMARY_ONLY_ID = 164369;
const UNKNOWN_ID = 777_777;
const SYNTHETIC_ID = 300;
const HNSW_INDEX = 'place_embeddings_embedding_hnsw_idx';
const EMBEDDINGS_STEP = '20261023_01_create_place_embeddings';
const UNREACHABLE_TIMEOUT_MS = 60_000;
const FAKE_HOOK_SECRET = 'pa-synthetic-hook-secret-0000';

// ---------------------------------------------------------------------------
// Lifecycle: Test Database migrated once, emptied before every test
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;
const extraStores: EmbeddingStore[] = [];

beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect(SchemaStepsResultSchema.parse(await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
  embeddings = create({ connectionString: testUrl });
});

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterEach(async () => {
  for (const store of extraStores.splice(0)) await store.close();
});

afterAll(async () => {
  try {
    expect(SchemaStepsResultSchema.parse(await setup.apply()).ok).toBe(true);
  } finally {
    await embeddings.close();
    await places.close();
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

function failureOf<T>(result: Result<T>): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

/** An extra Embedding Store, closed in `afterEach`. */
function extraStore(options: EmbeddingStoreOptions): EmbeddingStore {
  const store = create(options);
  extraStores.push(store);
  return store;
}

async function saveDetails(details: PlaceDetails, fetchedAt: string = FETCHED_AT): Promise<void> {
  okValue(SaveResultSchema.parse(await places.savePlaceDetails({ details, fetchedAt })));
}

async function saveRecordedListing(): Promise<void> {
  okValue(
    SaveResultSchema.parse(await places.saveListingPage(await clientListing('box-belgrade-page1.json'))),
  );
}

async function seedSynthetic(...ids: number[]): Promise<void> {
  for (const id of ids) await saveDetails(await syntheticDetails(id));
}

/** Synthetic Detailed Places `first` .. `first + count - 1` from one template (fast seeding). */
async function seedManySynthetic(first: number, count: number): Promise<number[]> {
  const template = await syntheticDetails(first);
  const ids: number[] = [];
  for (let id = first; id < first + count; id += 1) {
    await saveDetails({
      ...template,
      placeId: id,
      title: syntheticName(id),
      description: `Synthetic description ${String(id)}.`,
    });
    ids.push(id);
  }
  return ids;
}

async function readDetailed(placeId: number): Promise<DetailedPlace> {
  const value = okValue(ReadPlaceResultSchema.parse(await places.readPlace({ placeId })));
  if (!value.found || value.place.status !== 'detailed') {
    throw new Error(`place ${String(placeId)} is not a stored Detailed Place`);
  }
  return value.place;
}

function record(placeId: number, change: Partial<Omit<EmbeddingRecord, 'placeId'>> = {}): EmbeddingRecord {
  const seed = `place ${String(placeId)}`;
  return {
    placeId,
    embedding: fakeEmbedding(seed),
    model: EMBEDDING_MODEL,
    documentFingerprint: documentFingerprint(seed),
    embeddedAt: FETCHED_AT,
    ...change,
  };
}

async function save(
  store: EmbeddingStore,
  records: EmbeddingRecord[],
): Promise<Result<{ saved: number }>> {
  return SaveEmbeddingRecordsResultSchema.parse(await store.saveEmbeddingRecords({ records }));
}

/** Passes an input the contract types refuse, as a caller with untrusted data might (AC-39). */
async function saveUnchecked(input: unknown): Promise<Result<{ saved: number }>> {
  return SaveEmbeddingRecordsResultSchema.parse(
    await embeddings.saveEmbeddingRecords(input as SaveEmbeddingRecordsInput),
  );
}

/** Keeps an Embedding Record through the store under test (an older model, a past moment). */
async function keepRecord(
  placeId: number,
  change: Partial<Omit<EmbeddingRecord, 'placeId'>> = {},
): Promise<EmbeddingRecord> {
  const kept = record(placeId, {
    embedding: fakeEmbedding(`old ${String(placeId)}`),
    model: 'voyage-3.5',
    embeddedAt: '2026-10-01T00:00:00Z',
    ...change,
  });
  expect(okValue(await save(embeddings, [kept]))).toStrictEqual({ saved: 1 });
  return kept;
}

async function recordOf(placeId: number): Promise<EmbeddingRecord | undefined> {
  const value = okValue(
    ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId })),
  );
  return value.found ? value.record : undefined;
}

async function candidates(
  input: EmbeddingCandidatesInput,
  store: EmbeddingStore = embeddings,
): Promise<EmbeddingCandidatesValue> {
  return okValue(EmbeddingCandidatesResultSchema.parse(await store.listEmbeddingCandidates(input)));
}

async function embedCounts(store: EmbeddingStore = embeddings): Promise<EmbeddingStoreCounts> {
  return okValue(EmbeddingStoreCountsResultSchema.parse(await store.countEmbeddingStore()));
}

/** Fails unless `text` holds no password, connection string or driver detail of the URLs used. */
function expectNoSecrets(text: string): void {
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(UNREACHABLE_DATABASE_URL);
  expect(text).not.toContain(testUrl);
  const testPassword = decodeURIComponent(new URL(testUrl).password);
  if (testPassword.length >= 6) expect(text).not.toContain(testPassword);
}

function samePath(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function expectInvalidAt(failure: StoreFailure, path: (string | number)[]): void {
  expect(failure.kind).toBe('invalid_data');
  if (failure.kind !== 'invalid_data') return;
  const paths = failure.issues.map((i) => i.path);
  expect(
    paths.some((p) => samePath(p, path)),
    `no issue at ${JSON.stringify(path)}; got ${JSON.stringify(paths)}`,
  ).toBe(true);
}

function startsWith(path: readonly (string | number)[], prefix: readonly (string | number)[]): boolean {
  return prefix.every((item, i) => path[i] === item);
}

/** The R2 data set: recorded listing, details 1381893, synthetic 300, details 62587. */
async function seedR2(): Promise<void> {
  await saveRecordedListing();
  await saveDetails(await clientDetails('getbyid-1381893.json'));
  await seedSynthetic(SYNTHETIC_ID);
  await saveDetails(await clientDetails('getbyid-62587.json'));
}

// ---------------------------------------------------------------------------
// 1. R2 data set
// ---------------------------------------------------------------------------

describe('listEmbeddingCandidates on the R2 data set', () => {
  it('lists [300, 62587, 1381893], each place exactly as readPlace reads it back', async () => {
    await seedR2();
    const kept = await keepRecord(SQUARE_ID);

    const all = await candidates({ limit: 1000 });
    expect(all.places.map((c) => c.place.placeId)).toStrictEqual([SYNTHETIC_ID, SQUARE_ID, PARK_ID]);
    for (const candidate of all.places) {
      expect(candidate.place).toStrictEqual(await readDetailed(candidate.place.placeId));
    }

    expect(at(all.places, 1).embeddingRecord).toStrictEqual(kept);
    expect(Object.hasOwn(at(all.places, 0), 'embeddingRecord')).toBe(false);
    expect(Object.hasOwn(at(all.places, 2), 'embeddingRecord')).toBe(false);
  });

  it('pages with afterPlaceId: { afterPlaceId: 300, limit: 1 } gives [62587]', async () => {
    await seedR2();
    await keepRecord(SQUARE_ID);
    const page = await candidates({ afterPlaceId: SYNTHETIC_ID, limit: 1 });
    expect(page.places.map((c) => c.place.placeId)).toStrictEqual([SQUARE_ID]);
    const rest = await candidates({ afterPlaceId: SQUARE_ID, limit: 1000 });
    expect(rest.places.map((c) => c.place.placeId)).toStrictEqual([PARK_ID]);
    const none = await candidates({ afterPlaceId: PARK_ID, limit: 1000 });
    expect(none.places).toStrictEqual([]);
  });

  it('limit cuts the list in ascending Place ID order', async () => {
    await seedR2();
    const two = await candidates({ limit: 2 });
    expect(two.places.map((c) => c.place.placeId)).toStrictEqual([SYNTHETIC_ID, SQUARE_ID]);
  });

  it('the Summary-Only listing Place is never listed', async () => {
    await seedR2();
    const ids = (await candidates({ limit: 1000 })).places.map((c) => c.place.placeId);
    expect(ids).not.toContain(SUMMARY_ONLY_ID);
    const after = await candidates({ afterPlaceId: SQUARE_ID, limit: 1000 });
    expect(after.places.map((c) => c.place.placeId)).not.toContain(SUMMARY_ONLY_ID);
  });

  it('an empty store lists no Places', async () => {
    expect(await candidates({ limit: 1000 })).toStrictEqual({ places: [] });
  });

  it('a store with only Summary-Only Places lists none', async () => {
    await saveRecordedListing();
    expect(await candidates({ limit: 1000 })).toStrictEqual({ places: [] });
  });
});

// ---------------------------------------------------------------------------
// 2. Read-back equality with Gone Tags, nested Replies and a Gone Comment
// ---------------------------------------------------------------------------

describe('listEmbeddingCandidates read-back equality', () => {
  it('a Place with Gone Tags, Replies and a Gone Comment reads back identically to readPlace', async () => {
    const [first, second] = await placeKSaves();
    await saveDetails(first, FETCHED_AT);
    await saveDetails(second, LATER_FETCHED_AT);

    const place = await readDetailed(PLACE_K_ID);
    expect(place.tags.some((t) => t.presence === 'gone')).toBe(true);
    expect(place.comments.some((c) => c.presence === 'gone')).toBe(true);
    expect(place.comments.some((c) => c.replies.length > 0)).toBe(true);

    const listed = await candidates({ limit: 1000 });
    expect(listed.places).toHaveLength(1);
    expect(at(listed.places, 0).place).toStrictEqual(place);
  });

  it('deeply nested Replies (62587, three levels) read back identically to readPlace', async () => {
    await saveDetails(await nestedDetails());
    await seedSynthetic(SYNTHETIC_ID);
    const listed = await candidates({ limit: 1000 });
    expect(listed.places.map((c) => c.place.placeId)).toStrictEqual([SYNTHETIC_ID, SQUARE_ID]);
    for (const candidate of listed.places) {
      expect(candidate.place).toStrictEqual(await readDetailed(candidate.place.placeId));
    }
  });

  it('Tags and Comments of several Places are kept apart', async () => {
    const [first, second] = await placeKSaves();
    await saveDetails(first, FETCHED_AT);
    await saveDetails(second, LATER_FETCHED_AT);
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    await seedSynthetic(SYNTHETIC_ID, 301);
    const listed = await candidates({ limit: 1000 });
    expect(listed.places.map((c) => c.place.placeId)).toStrictEqual([
      SYNTHETIC_ID,
      301,
      PLACE_K_ID,
      SQUARE_ID,
      PARK_ID,
    ]);
    for (const candidate of listed.places) {
      expect(candidate.place).toStrictEqual(await readDetailed(candidate.place.placeId));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid reads never reach the database
// ---------------------------------------------------------------------------

const INVALID_READS: [string, EmbeddingCandidatesInput, string][] = [
  ['limit 0', { limit: 0 }, 'limit'],
  ['limit 1001', { limit: 1001 }, 'limit'],
  ['afterPlaceId -1', { afterPlaceId: -1, limit: 1 }, 'afterPlaceId'],
];

describe('listEmbeddingCandidates invalid input', () => {
  it.each(INVALID_READS)('%s is invalid_data', async (_label, input, field) => {
    const failure = failureOf(
      EmbeddingCandidatesResultSchema.parse(await embeddings.listEmbeddingCandidates(input)),
    );
    expectInvalidAt(failure, [field]);
  });

  it.each(INVALID_READS)(
    '%s is invalid_data also on an unreachable store (no database access)',
    async (_label, input, field) => {
      const unreachable = extraStore({ connectionString: UNREACHABLE_DATABASE_URL });
      const failure = failureOf(
        EmbeddingCandidatesResultSchema.parse(await unreachable.listEmbeddingCandidates(input)),
      );
      expectInvalidAt(failure, [field]);
    },
  );

  it('an invalid save is invalid_data on an unreachable store (no database access)', async () => {
    const unreachable = extraStore({ connectionString: UNREACHABLE_DATABASE_URL });
    const failure = failureOf(
      SaveEmbeddingRecordsResultSchema.parse(await unreachable.saveEmbeddingRecords({ records: [] })),
    );
    expect(failure.kind).toBe('invalid_data');
  });

  it('readEmbeddingRecord of placeId 0 is invalid_data on an unreachable store', async () => {
    const unreachable = extraStore({ connectionString: UNREACHABLE_DATABASE_URL });
    const failure = failureOf(
      ReadEmbeddingRecordResultSchema.parse(await unreachable.readEmbeddingRecord({ placeId: 0 })),
    );
    expectInvalidAt(failure, ['placeId']);
  });
});

// ---------------------------------------------------------------------------
// 4. Unreachable and not-configured stores
// ---------------------------------------------------------------------------

/** Calls every data method of `store` with a valid input; every result parsed with its schema. */
async function everyMethod(store: EmbeddingStore): Promise<[string, StoreFailure][]> {
  return [
    [
      'listEmbeddingCandidates',
      failureOf(EmbeddingCandidatesResultSchema.parse(await store.listEmbeddingCandidates({ limit: 10 }))),
    ],
    ['saveEmbeddingRecords', failureOf(await save(store, [record(SQUARE_ID)]))],
    [
      'readEmbeddingRecord',
      failureOf(ReadEmbeddingRecordResultSchema.parse(await store.readEmbeddingRecord({ placeId: 1 }))),
    ],
    [
      'countEmbeddingStore',
      failureOf(EmbeddingStoreCountsResultSchema.parse(await store.countEmbeddingStore())),
    ],
    [
      'inspectEmbeddingStorage',
      failureOf(EmbeddingStorageInfoResultSchema.parse(await store.inspectEmbeddingStorage())),
    ],
  ];
}

describe('unreachable store', () => {
  it(
    'every method resolves store_unavailable without secrets, and close() resolves twice',
    async () => {
      const store = create({ connectionString: UNREACHABLE_DATABASE_URL });
      try {
        for (const [, failure] of await everyMethod(store)) {
          expect(failure.kind).toBe('store_unavailable');
          expectNoSecrets(JSON.stringify(failure));
        }
      } finally {
        await expect(store.close()).resolves.toBeUndefined();
        await expect(store.close()).resolves.toBeUndefined();
      }
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

describe('not-configured store', () => {
  it('createEmbeddingStore with an empty connection string does not throw', () => {
    expect(() => create({ connectionString: '' })).not.toThrow();
  });

  it('every method resolves store_unavailable "not configured", and close() resolves twice', async () => {
    const store = create({ connectionString: '' });
    try {
      for (const [, failure] of await everyMethod(store)) {
        expect(failure.kind).toBe('store_unavailable');
        expect(failure.message).toMatch(/not configured/);
      }
    } finally {
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Replace: one record per Place, the last save wins
// ---------------------------------------------------------------------------

describe('saveEmbeddingRecords replaces the earlier record', () => {
  it('keeps one row with the values of the second record; embeddedAt round-trips', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const firstRecord = record(SQUARE_ID, {
      embedding: fakeEmbedding('first'),
      model: 'voyage-3.5',
      documentFingerprint: documentFingerprint('first'),
      embeddedAt: '2026-10-01T00:00:00Z',
    });
    const secondRecord = record(SQUARE_ID, {
      embedding: fakeEmbedding('second'),
      model: EMBEDDING_MODEL,
      documentFingerprint: documentFingerprint('second'),
      embeddedAt: '2026-10-23T09:15:42Z',
    });
    expect(okValue(await save(embeddings, [firstRecord]))).toStrictEqual({ saved: 1 });
    expect(await recordOf(SQUARE_ID)).toStrictEqual(firstRecord);
    expect(okValue(await save(embeddings, [secondRecord]))).toStrictEqual({ saved: 1 });

    expect((await embedCounts()).embeddingRecords).toBe(1);
    const value = okValue(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId: SQUARE_ID })),
    );
    expect(value).toStrictEqual({ found: true, record: secondRecord });
    if (value.found) expect(value.record.embeddedAt).toBe('2026-10-23T09:15:42Z');
  });

  it('saving the same record again keeps one row, unchanged', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const kept = await keepRecord(SQUARE_ID);
    expect(okValue(await save(embeddings, [kept]))).toStrictEqual({ saved: 1 });
    expect(await recordOf(SQUARE_ID)).toStrictEqual(kept);
    expect((await embedCounts()).embeddingRecords).toBe(1);
  });

  it('a Batch of several records keeps each, and saved counts them', async () => {
    await seedSynthetic(301, 302, 303);
    const batch = [record(303), record(301), record(302)];
    expect(okValue(await save(embeddings, batch))).toStrictEqual({ saved: 3 });
    for (const r of batch) expect(await recordOf(r.placeId)).toStrictEqual(r);
  });
});

// ---------------------------------------------------------------------------
// 6. AC-39: wrong Embeddings are refused, nothing of the Batch is kept
// ---------------------------------------------------------------------------

describe('saveEmbeddingRecords refuses wrong records (AC-39)', () => {
  async function withEarlierRecord(): Promise<EmbeddingRecord> {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    return keepRecord(SQUARE_ID);
  }

  const bad: [string, (r: EmbeddingRecord) => unknown][] = [
    ['1023 numbers', (r) => ({ ...r, embedding: fakeVector(1023) })],
    ['1025 numbers', (r) => ({ ...r, embedding: fakeVector(1025) })],
    ['1536 numbers', (r) => ({ ...r, embedding: fakeVector(1536) })],
    ['a NaN value', (r) => ({ ...r, embedding: [...fakeVector(1023), Number.NaN] })],
    [
      'an infinite value',
      (r) => ({ ...r, embedding: [...fakeVector(1023), Number.NEGATIVE_INFINITY] }),
    ],
    ['an empty Embedding Model', (r) => ({ ...r, model: '' })],
    ['no Document Fingerprint', (r) => ({ ...r, documentFingerprint: undefined })],
    ['an empty Document Fingerprint', (r) => ({ ...r, documentFingerprint: '' })],
  ];

  it.each(bad)('%s: invalid_data, the earlier record unchanged', async (_label, change) => {
    const earlier = await withEarlierRecord();
    const attempt = change({ ...earlier, model: EMBEDDING_MODEL, embedding: fakeEmbedding('new') });
    const failure = failureOf(await saveUnchecked({ records: [attempt] }));
    expect(failure.kind).toBe('invalid_data');
    if (failure.kind === 'invalid_data') {
      expect(failure.issues.some((i) => startsWith(i.path, ['records', 0]))).toBe(true);
    }
    expect(await recordOf(SQUARE_ID)).toStrictEqual(earlier);
    expect((await embedCounts()).embeddingRecords).toBe(1);
  });

  it('one wrong record among good ones keeps nothing of the Batch', async () => {
    const earlier = await withEarlierRecord();
    await seedSynthetic(301);
    const good = record(301);
    const wrong = { ...earlier, model: EMBEDDING_MODEL, embedding: fakeVector(1023) };
    const failure = failureOf(await saveUnchecked({ records: [good, wrong] }));
    expect(failure.kind).toBe('invalid_data');
    expect(await recordOf(301)).toBeUndefined();
    expect(await recordOf(SQUARE_ID)).toStrictEqual(earlier);
  });

  it('a duplicated Place ID in a Batch is invalid_data and keeps nothing', async () => {
    await seedSynthetic(301);
    const failure = failureOf(
      await save(embeddings, [record(301), record(301, { model: 'voyage-3.5' })]),
    );
    expect(failure.kind).toBe('invalid_data');
    expect(await recordOf(301)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Not a Detailed Place
// ---------------------------------------------------------------------------

describe('saveEmbeddingRecords for a Place that is not a stored Detailed Place', () => {
  it.each([
    ['the Summary-Only listing Place', SUMMARY_ONLY_ID],
    ['an unknown Place ID', UNKNOWN_ID],
  ])('%s at index 1 of 2: invalid_data at records[1].placeId, nothing kept', async (_label, badId) => {
    await saveRecordedListing();
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const failure = failureOf(await save(embeddings, [record(SQUARE_ID), record(badId)]));
    expectInvalidAt(failure, ['records', 1, 'placeId']);
    expect(await recordOf(SQUARE_ID)).toBeUndefined();
    expect((await embedCounts()).embeddingRecords).toBe(0);
  });

  it.each([
    ['the Summary-Only listing Place', SUMMARY_ONLY_ID],
    ['an unknown Place ID', UNKNOWN_ID],
  ])('%s alone: invalid_data at records[0].placeId', async (_label, badId) => {
    await saveRecordedListing();
    const failure = failureOf(await save(embeddings, [record(badId)]));
    expectInvalidAt(failure, ['records', 0, 'placeId']);
    expect((await embedCounts()).embeddingRecords).toBe(0);
  });

  it('the failure does not echo the record values', async () => {
    const failure = failureOf(await save(embeddings, [record(UNKNOWN_ID, { model: 'synthetic-model-name' })]));
    expect(JSON.stringify(failure)).not.toContain('synthetic-model-name');
    expect(JSON.stringify(failure)).not.toContain(documentFingerprint(`place ${String(UNKNOWN_ID)}`));
  });
});

// ---------------------------------------------------------------------------
// 8. Hook failure rolls the Batch back
// ---------------------------------------------------------------------------

describe('saveEmbeddingRecords with a failing write hook', () => {
  it('a hook throwing at write 1 rolls the Batch back: no row, store_unavailable, no hook text', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await seedSynthetic(301);
    const failing = extraStore({
      connectionString: testUrl,
      onWrite: (n) => {
        if (n === 1) throw new Error(`hook outage: Authorization: Bearer ${FAKE_HOOK_SECRET}`);
      },
    });
    const failure = failureOf(await save(failing, [record(SQUARE_ID), record(301)]));
    expect(failure.kind).toBe('store_unavailable');
    const text = JSON.stringify(failure);
    expect(text).not.toContain(FAKE_HOOK_SECRET);
    expect(text).not.toContain('hook outage');
    expect(text).not.toContain('Bearer');
    expectNoSecrets(text);
    expect(await recordOf(SQUARE_ID)).toBeUndefined();
    expect(await recordOf(301)).toBeUndefined();
    expect((await embedCounts()).embeddingRecords).toBe(0);
  });

  it('a rejecting hook at write 1 also leaves the earlier record unchanged', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const earlier = await keepRecord(SQUARE_ID);
    const failing = extraStore({
      connectionString: testUrl,
      onWrite: () => Promise.reject(new Error(`async hook outage ${FAKE_HOOK_SECRET}`)),
    });
    const failure = failureOf(await save(failing, [record(SQUARE_ID)]));
    expect(failure.kind).toBe('store_unavailable');
    expect(JSON.stringify(failure)).not.toContain(FAKE_HOOK_SECRET);
    expect(await recordOf(SQUARE_ID)).toStrictEqual(earlier);
  });

  it('an invalid save never calls the hook', async () => {
    const hook = vi.fn<WriteHook>();
    const store = extraStore({ connectionString: testUrl, onWrite: hook });
    expect(failureOf(await save(store, [record(UNKNOWN_ID)])).kind).toBe('invalid_data');
    expect(failureOf(await save(store, [])).kind).toBe('invalid_data');
    expect(hook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. Chunking: 100 records per statement; store-wide write numbering
// ---------------------------------------------------------------------------

describe('saveEmbeddingRecords chunking', () => {
  it(
    '250 records are written in 3 statements (hook 1, 2, 3); numbering continues across calls',
    async () => {
      const ids = await seedManySynthetic(2001, 250);
      const calls: number[] = [];
      const store = extraStore({
        connectionString: testUrl,
        onWrite: (n) => {
          calls.push(n);
        },
      });
      const batch = ids.map((id) => record(id));
      expect(okValue(await save(store, batch))).toStrictEqual({ saved: 250 });
      expect(calls).toStrictEqual([1, 2, 3]);
      expect((await embedCounts()).embeddingRecords).toBe(250);
      expect(await recordOf(2001)).toStrictEqual(at(batch, 0));
      expect(await recordOf(2250)).toStrictEqual(at(batch, 249));

      const again = record(2001, { model: 'voyage-3.5' });
      expect(okValue(await save(store, [again]))).toStrictEqual({ saved: 1 });
      expect(calls).toStrictEqual([1, 2, 3, 4]);
      expect(await recordOf(2001)).toStrictEqual(again);
    },
    120_000,
  );

  it('100 records are one statement, 101 are two', async () => {
    const ids = await seedManySynthetic(3001, 101);
    const calls: number[] = [];
    const store = extraStore({
      connectionString: testUrl,
      onWrite: (n) => {
        calls.push(n);
      },
    });
    expect(okValue(await save(store, ids.slice(0, 100).map((id) => record(id))))).toStrictEqual({
      saved: 100,
    });
    expect(calls).toStrictEqual([1]);
    expect(okValue(await save(store, ids.map((id) => record(id, { model: 'voyage-3.5' }))))).toStrictEqual({
      saved: 101,
    });
    expect(calls).toStrictEqual([1, 2, 3]);
  }, 60_000);

  it('two stores number their writes independently', async () => {
    await seedSynthetic(301, 302);
    const callsA: number[] = [];
    const callsB: number[] = [];
    const a = extraStore({
      connectionString: testUrl,
      onWrite: (n) => {
        callsA.push(n);
      },
    });
    const b = extraStore({
      connectionString: testUrl,
      onWrite: (n) => {
        callsB.push(n);
      },
    });
    okValue(await save(a, [record(301)]));
    okValue(await save(b, [record(302)]));
    okValue(await save(a, [record(302, { model: 'voyage-3.5' })]));
    expect(callsA).toStrictEqual([1, 2]);
    expect(callsB).toStrictEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// 10. AC-56: Place Store saves never change an Embedding Record
// ---------------------------------------------------------------------------

describe('Embedding Records outlive Listing and Details Saves (AC-56)', () => {
  it('a Listing Save and two Details Saves leave the record of 62587 unchanged', async () => {
    const details = await clientDetails('getbyid-62587.json');
    await saveDetails(details);
    const kept = await keepRecord(SQUARE_ID, { model: EMBEDDING_MODEL });
    await saveRecordedListing();
    await saveDetails(details, LATER_FETCHED_AT);
    await saveDetails({ ...details, description: 'Changed on Wikimapia.' }, EVEN_LATER_FETCHED_AT);
    expect(await recordOf(SQUARE_ID)).toStrictEqual(kept);
    const listed = await candidates({ limit: 1000 });
    const square = listed.places.find((c) => c.place.placeId === SQUARE_ID);
    expect(square?.embeddingRecord).toStrictEqual(kept);
    expect(square?.place.description).toBe('Changed on Wikimapia.');
  });
});

// ---------------------------------------------------------------------------
// 11. readEmbeddingRecord and countEmbeddingStore
// ---------------------------------------------------------------------------

describe('readEmbeddingRecord', () => {
  it('is { found: false, placeId } for a Detailed Place without a record', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    expect(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId: SQUARE_ID })),
    ).toStrictEqual({ ok: true, value: { found: false, placeId: SQUARE_ID } });
  });

  it('is { found: false, placeId } for an unknown Place', async () => {
    expect(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId: UNKNOWN_ID })),
    ).toStrictEqual({ ok: true, value: { found: false, placeId: UNKNOWN_ID } });
  });

  it('is { found: true, record } for a kept record', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const kept = await keepRecord(SQUARE_ID);
    expect(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId: SQUARE_ID })),
    ).toStrictEqual({ ok: true, value: { found: true, record: kept } });
  });

  it('placeId 0 is invalid_data at placeId', async () => {
    const failure = failureOf(
      ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId: 0 })),
    );
    expectInvalidAt(failure, ['placeId']);
  });
});

describe('countEmbeddingStore', () => {
  it('is all zeros on an empty store', async () => {
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 0,
      detailedPlaces: 0,
      embeddingRecords: 0,
    });
  });

  it('counts Summary-Only Places, Detailed Places and Embedding Records exactly', async () => {
    await saveRecordedListing();
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 3,
      detailedPlaces: 0,
      embeddingRecords: 0,
    });
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    await seedSynthetic(SYNTHETIC_ID, 301);
    await keepRecord(SQUARE_ID);
    await keepRecord(301);
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 1,
      detailedPlaces: 4,
      embeddingRecords: 2,
    });
  });

  it('the R2 data set with one record counts { 1, 3, 1 }', async () => {
    await seedR2();
    await keepRecord(SQUARE_ID);
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 1,
      detailedPlaces: 3,
      embeddingRecords: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 12. inspectEmbeddingStorage
// ---------------------------------------------------------------------------

describe('inspectEmbeddingStorage', () => {
  it('reports the table, 1024 dimensions, one record per Place and exactly the HNSW cosine index', async () => {
    const info = okValue(
      EmbeddingStorageInfoResultSchema.parse(await embeddings.inspectEmbeddingStorage()),
    );
    expect(info).toStrictEqual({
      table: EMBEDDING_TABLE,
      column: EMBEDDING_COLUMN,
      dimensions: EMBEDDING_DIMENSIONS,
      onePerPlace: true,
      vectorIndexes: [
        {
          name: HNSW_INDEX,
          method: SIMILARITY_INDEX.method,
          operatorClass: SIMILARITY_INDEX.operatorClass,
          partial: false,
        },
      ],
    });
  });

  describe('after undoing step 7', () => {
    afterEach(async () => {
      expect(SchemaStepsResultSchema.parse(await setup.apply()).ok).toBe(true);
    });

    it('resolves store_unavailable without secrets', async () => {
      const undone = SchemaStepsResultSchema.parse(await setup.undoLast());
      expect(undone).toStrictEqual({ ok: true, value: { steps: [EMBEDDINGS_STEP] } });
      const failure = failureOf(
        EmbeddingStorageInfoResultSchema.parse(await embeddings.inspectEmbeddingStorage()),
      );
      expect(failure.kind).toBe('store_unavailable');
      expectNoSecrets(JSON.stringify(failure));
    });
  });
});

// ---------------------------------------------------------------------------
// 13. Pool closed
// ---------------------------------------------------------------------------

describe('close()', () => {
  it('resolves twice on a connected store; a later call resolves (store_unavailable if it fails)', async () => {
    const store = create({ connectionString: testUrl });
    expect(okValue(EmbeddingStoreCountsResultSchema.parse(await store.countEmbeddingStore()))).toStrictEqual({
      summaryOnlyPlaces: 0,
      detailedPlaces: 0,
      embeddingRecords: 0,
    });
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();

    const result = EmbeddingStoreCountsResultSchema.parse(await store.countEmbeddingStore());
    if (!result.ok) {
      expect(result.failure.kind).toBe('store_unavailable');
      expectNoSecrets(JSON.stringify(result.failure));
    }
    const listed = EmbeddingCandidatesResultSchema.parse(await store.listEmbeddingCandidates({ limit: 1 }));
    if (!listed.ok) expect(listed.failure.kind).toBe('store_unavailable');
  });
});
