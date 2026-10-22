/**
 * AL2 unit tests: `src/db/place-store.ts` (AL4 1.2 Call flow, 1.3 `place-store.ts` block,
 * 1.4.1 Factories, 1.4.3 Failures, 1.5 Transaction boundaries, U8).
 *
 * No database: only a not-configured store (empty connection string) and a store pointed at
 * the contract's unreachable address (nothing listens there, so every DB call fails fast with
 * ECONNREFUSED). Inputs are the Client's reading of the recorded fixtures. Every result is
 * parsed with its contract `*ResultSchema` before any assertion, and every call is checked to
 * resolve (never reject) first.
 *
 * End-to-end behaviour (saves, read-back, `onWrite` faults, the wrong-database case) is covered
 * by `contracts/storage.test.ts` and the U6/U7 DB tests and is not repeated here.
 */
import { READ_TRANSACTION_CONFIG, createPlaceStore } from '../../src/db/place-store';
import {
  PlaceTagLinksResultSchema,
  ReadPlaceResultSchema,
  ReadShapesResultSchema,
  SaveResultSchema,
  StoreCountsResultSchema,
  StoredCommentKeysResultSchema,
  TagCatalogueResultSchema,
  type CreatePlaceStoreFn,
  type PlaceStore,
  type PlaceStoreOptions,
  type StoreFailure,
} from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  at,
  clientDetails,
  clientListing,
} from '../../contracts/storage.support';

// Compile-time check: the entry point has the contract's signature.
const create: CreatePlaceStoreFn = createPlaceStore;

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const UNAVAILABLE_PREFIX = 'Place Store unavailable: ';
const UNREACHABLE_TIMEOUT_MS = 60_000;

type Parsed = { ok: true; value: unknown } | { ok: false; failure: StoreFailure };
type Path = (string | number)[];
type DataMethod = Exclude<keyof PlaceStore, 'close'>;

const ALL_METHODS: readonly (keyof PlaceStore)[] = [
  'saveListingPage',
  'savePlaceDetails',
  'readPlace',
  'listTags',
  'listPlaceTagLinks',
  'listStoredComments',
  'readPlaceShapes',
  'countStored',
  'close',
];

/** Fails the test explicitly if the call rejects; otherwise yields its resolved value. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await expect(promise).resolves.toBeDefined();
  return promise;
}

function failureOf(result: Parsed): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

function samePath(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}

// ---------------------------------------------------------------------------
// Calls with valid input, one per data method
// ---------------------------------------------------------------------------

interface ValidCall {
  method: DataMethod;
  run: (store: PlaceStore) => Promise<Parsed>;
}

const VALID_CALLS: readonly ValidCall[] = [
  {
    method: 'saveListingPage',
    run: async (store) => {
      const page = await clientListing('box-belgrade-page1.json');
      return SaveResultSchema.parse(await settle(store.saveListingPage(page)));
    },
  },
  {
    method: 'savePlaceDetails',
    run: async (store) => {
      const details = await clientDetails('getbyid-62587.json');
      return SaveResultSchema.parse(
        await settle(store.savePlaceDetails({ details, fetchedAt: FETCHED_AT })),
      );
    },
  },
  {
    method: 'readPlace',
    run: async (store) =>
      ReadPlaceResultSchema.parse(await settle(store.readPlace({ placeId: 62587 }))),
  },
  {
    method: 'listTags',
    run: async (store) => TagCatalogueResultSchema.parse(await settle(store.listTags())),
  },
  {
    method: 'listPlaceTagLinks',
    run: async (store) =>
      PlaceTagLinksResultSchema.parse(await settle(store.listPlaceTagLinks({ tagId: 194 }))),
  },
  {
    method: 'listStoredComments',
    run: async (store) =>
      StoredCommentKeysResultSchema.parse(
        await settle(store.listStoredComments({ placeId: 62587 })),
      ),
  },
  {
    method: 'readPlaceShapes',
    run: async (store) =>
      ReadShapesResultSchema.parse(await settle(store.readPlaceShapes({ placeId: 62587 }))),
  },
  {
    method: 'countStored',
    run: async (store) => StoreCountsResultSchema.parse(await settle(store.countStored())),
  },
];

// ---------------------------------------------------------------------------
// Calls with invalid input (AC-51, AC-53, AC-55): invalid_data before any DB access
// ---------------------------------------------------------------------------

interface InvalidCall {
  label: string;
  run: (store: PlaceStore) => Promise<Parsed>;
  /** Expected issue path; `undefined` when only the kind is pinned (no input object at all). */
  path: Path | undefined;
}

const BAD_PLACE_IDS: readonly number[] = [0, -3, 1.5, Number.NaN];

const INVALID_CALLS: readonly InvalidCall[] = [
  ...BAD_PLACE_IDS.flatMap((placeId): InvalidCall[] => [
    {
      label: `readPlace({ placeId: ${String(placeId)} })`,
      run: async (store) => ReadPlaceResultSchema.parse(await settle(store.readPlace({ placeId }))),
      path: ['placeId'],
    },
    {
      label: `listStoredComments({ placeId: ${String(placeId)} })`,
      run: async (store) =>
        StoredCommentKeysResultSchema.parse(await settle(store.listStoredComments({ placeId }))),
      path: ['placeId'],
    },
    {
      label: `readPlaceShapes({ placeId: ${String(placeId)} })`,
      run: async (store) =>
        ReadShapesResultSchema.parse(await settle(store.readPlaceShapes({ placeId }))),
      path: ['placeId'],
    },
  ]),
  {
    label: 'listPlaceTagLinks({ tagId: -1 })',
    run: async (store) =>
      PlaceTagLinksResultSchema.parse(await settle(store.listPlaceTagLinks({ tagId: -1 }))),
    path: ['tagId'],
  },
  {
    label: 'saveListingPage(undefined)',
    run: async (store) =>
      SaveResultSchema.parse(await settle(store.saveListingPage(undefined as never))),
    path: undefined,
  },
  {
    label: 'savePlaceDetails(undefined)',
    run: async (store) =>
      SaveResultSchema.parse(await settle(store.savePlaceDetails(undefined as never))),
    path: undefined,
  },
  {
    label: "savePlaceDetails with fetchedAt 'yesterday'",
    run: async (store) => {
      const details = await clientDetails('getbyid-62587.json');
      return SaveResultSchema.parse(
        await settle(store.savePlaceDetails({ details, fetchedAt: 'yesterday' })),
      );
    },
    path: ['fetchedAt'],
  },
  {
    label: 'saveListingPage with lon 200 on the first place',
    run: async (store) => {
      const page = await clientListing('box-belgrade-page1.json');
      const first = at(page.places, 0);
      const bad = {
        ...page,
        places: [{ ...first, location: { ...first.location, lon: 200 } }, ...page.places.slice(1)],
      };
      return SaveResultSchema.parse(await settle(store.saveListingPage(bad)));
    },
    path: ['places', 0, 'location', 'lon'],
  },
];

// ---------------------------------------------------------------------------
// 1. Factory never throws (AL4 1.4.1, AC-57)
// ---------------------------------------------------------------------------

describe('createPlaceStore: factory', () => {
  const optionCases: [string, PlaceStoreOptions][] = [
    ['an empty connection string', { connectionString: '' }],
    ['the unreachable connection string', { connectionString: UNREACHABLE_DATABASE_URL }],
    ['a connection string that is not a URL', { connectionString: 'not a url' }],
    ['an empty connection string plus onWrite', { connectionString: '', onWrite: () => undefined }],
    [
      'the unreachable connection string plus onWrite',
      { connectionString: UNREACHABLE_DATABASE_URL, onWrite: () => undefined },
    ],
  ];

  it.each(optionCases)(
    'does not throw for %s and returns all nine methods',
    async (_name, options) => {
      expect(() => create(options)).not.toThrow();
      const store = create(options);
      try {
        for (const method of ALL_METHODS) {
          expect(typeof store[method], method).toBe('function');
        }
      } finally {
        await expect(store.close()).resolves.toBeUndefined();
      }
    },
  );

  it(
    'an extra onWrite does not make a valid connection string "not configured"',
    async () => {
      const store = create({
        connectionString: UNREACHABLE_DATABASE_URL,
        onWrite: () => undefined,
      });
      try {
        const failure = failureOf(
          ReadPlaceResultSchema.parse(await settle(store.readPlace({ placeId: 1 }))),
        );
        expect(failure.kind).toBe('store_unavailable');
        expect(failure.message).not.toBe(NOT_CONFIGURED_MESSAGE);
        expect(failure.message.startsWith(UNAVAILABLE_PREFIX)).toBe(true);
      } finally {
        await store.close();
      }
    },
    UNREACHABLE_TIMEOUT_MS,
  );

  it('an empty connection string plus onWrite is "not configured"', async () => {
    const store = create({ connectionString: '', onWrite: () => undefined });
    try {
      const result = ReadPlaceResultSchema.parse(await settle(store.readPlace({ placeId: 1 })));
      expect(result).toStrictEqual({
        ok: false,
        failure: { kind: 'store_unavailable', message: NOT_CONFIGURED_MESSAGE },
      });
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Not-configured store: valid input resolves the fixed store_unavailable failure
// ---------------------------------------------------------------------------

describe('not-configured store (connectionString: "")', () => {
  let store: PlaceStore;

  beforeAll(() => {
    store = create({ connectionString: '' });
  });

  afterAll(async () => {
    await store.close();
  });

  it.each(VALID_CALLS)(
    '$method with valid input resolves store_unavailable "not configured"',
    async ({ run }) => {
      const result = await run(store);
      expect(result).toStrictEqual({
        ok: false,
        failure: { kind: 'store_unavailable', message: NOT_CONFIGURED_MESSAGE },
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Validation runs before the DB (AC-51, AC-53, AC-55)
// ---------------------------------------------------------------------------

describe.each([
  ['not-configured', ''],
  ['unreachable', UNREACHABLE_DATABASE_URL],
])('validation before any DB access: %s store', (_kind, connectionString) => {
  let store: PlaceStore;

  beforeAll(() => {
    store = create({ connectionString });
  });

  afterAll(async () => {
    await store.close();
  });

  it.each(INVALID_CALLS)('$label resolves invalid_data', async ({ run, path }) => {
    const failure = failureOf(await run(store));
    expect(failure.kind).toBe('invalid_data');
    if (failure.kind !== 'invalid_data') return;
    expect(failure.issues.length).toBeGreaterThan(0);
    if (path !== undefined) {
      expect(
        failure.issues.some((issue) => samePath(issue.path, path)),
        JSON.stringify(failure.issues.map((issue) => issue.path)),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Unreachable store (AC-57): store_unavailable, no secrets, unavailableFrom template
// ---------------------------------------------------------------------------

describe('unreachable store (UNREACHABLE connection string)', () => {
  let store: PlaceStore;

  beforeAll(() => {
    store = create({ connectionString: UNREACHABLE_DATABASE_URL });
  });

  afterAll(async () => {
    await store.close();
  });

  it.each(VALID_CALLS)(
    '$method with valid input resolves store_unavailable without secrets',
    async ({ run }) => {
      const failure = failureOf(await run(store));
      expect(failure.kind).toBe('store_unavailable');
      expect(failure.message.startsWith(UNAVAILABLE_PREFIX)).toBe(true);
      expect(failure.message).not.toBe(NOT_CONFIGURED_MESSAGE);
      const text = JSON.stringify(failure);
      expect(text).not.toContain(UNREACHABLE_PASSWORD);
      expect(text).not.toContain(UNREACHABLE_DATABASE_URL);
      expect(text).not.toContain('postgres://');
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 6. close(): idempotent, never rejects; later calls still resolve
// ---------------------------------------------------------------------------

describe.each([
  ['not-configured', ''],
  ['unreachable', UNREACHABLE_DATABASE_URL],
])('close() on the %s store', (_kind, connectionString) => {
  it(
    'resolves twice in a row, and a later readPlace resolves (store_unavailable if it fails)',
    async () => {
      const store = create({ connectionString });
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();

      const result = ReadPlaceResultSchema.parse(await settle(store.readPlace({ placeId: 1 })));
      if (!result.ok) {
        expect(result.failure.kind).toBe('store_unavailable');
        const text = JSON.stringify(result.failure);
        expect(text).not.toContain(UNREACHABLE_PASSWORD);
        expect(text).not.toContain('postgres://');
      }
    },
    UNREACHABLE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 7. Read transaction pin (AL4 1.4.8, 1.5)
// ---------------------------------------------------------------------------

describe('READ_TRANSACTION_CONFIG', () => {
  it('is a read-only REPEATABLE READ transaction', () => {
    expect(READ_TRANSACTION_CONFIG).toStrictEqual({
      isolationLevel: 'repeatable read',
      readOnly: true,
    });
  });
});
