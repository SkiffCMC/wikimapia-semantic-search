/**
 * AL2 unit tests: the Embedding Store `createEmbeddingStore` (`src/db/embedding-store.ts`,
 * `src/db/embedding-read.ts`) against the Test Database. Only what the contract tests do not
 * reach: the not-configured store, the storage inspection without step 7, and the candidates
 * read of nested Replies with author photos. AL4 embeddings 1.4.8, 1.5.
 */
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { EMBEDDING_MODEL, documentFingerprint } from '../../contracts/embeddings.schema';
import type { EmbeddingStore } from '../../contracts/embeddings.schema';
import { fakeEmbedding, syntheticDetails } from '../../contracts/embeddings.support';
import type { PlaceStore, SchemaSetup } from '../../contracts/storage.schema';
import { FETCHED_AT, nestedDetails, requireTestDatabaseUrl } from '../../contracts/storage.support';

const NOT_CONFIGURED = {
  kind: 'store_unavailable',
  message: 'Embedding Store is not configured: connection string is missing or unusable',
};

let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: url });
  expect((await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: url });
  embeddings = createEmbeddingStore({ connectionString: url });
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await embeddings.close();
    await places.close();
    await setup.close();
  }
});

it('lists nested Replies with author photos exactly as readPlace reads them back', async () => {
  for (const details of [await nestedDetails(), await syntheticDetails(300)]) {
    expect((await places.savePlaceDetails({ details, fetchedAt: FETCHED_AT })).ok).toBe(true);
  }
  const listed = await embeddings.listEmbeddingCandidates({ limit: 10 });
  if (!listed.ok) throw new Error(listed.failure.message);
  expect(listed.value.places.map((c) => c.place.placeId)).toStrictEqual([300, 62587]);
  for (const { place } of listed.value.places) {
    const read = await places.readPlace({ placeId: place.placeId });
    expect(read).toStrictEqual({ ok: true, value: { found: true, place } });
  }
});

it('a not-configured store fails every valid call without the database and closes twice', async () => {
  const store = createEmbeddingStore({ connectionString: '' });
  const record = {
    placeId: 1,
    embedding: fakeEmbedding('x'),
    model: EMBEDDING_MODEL,
    documentFingerprint: documentFingerprint('x'),
    embeddedAt: FETCHED_AT,
  };
  const results = [
    await store.listEmbeddingCandidates({ limit: 10 }),
    await store.saveEmbeddingRecords({ records: [record] }),
    await store.readEmbeddingRecord({ placeId: 1 }),
    await store.countEmbeddingStore(),
    await store.inspectEmbeddingStorage(),
  ];
  for (const result of results)
    expect(result).toStrictEqual({ ok: false, failure: NOT_CONFIGURED });
  await expect(store.close()).resolves.toBeUndefined();
  await expect(store.close()).resolves.toBeUndefined();
});

it('inspectEmbeddingStorage without step 7 is store_unavailable', async () => {
  expect((await setup.undoLast()).ok).toBe(true);
  try {
    expect(await embeddings.inspectEmbeddingStorage()).toStrictEqual({
      ok: false,
      failure: {
        kind: 'store_unavailable',
        message: 'Place Store unavailable: embedding storage inspection failed',
      },
    });
  } finally {
    expect((await setup.apply()).ok).toBe(true);
  }
});
