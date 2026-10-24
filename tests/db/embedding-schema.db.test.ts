/**
 * AL2 unit tests: Schema Setup step 7 (`src/db/migrations/20261023_01_create_place_embeddings.ts`,
 * registered in `src/db/migrations/index.ts`) and `emptyStore()` removing Embedding Records
 * (`src/db/schema-setup.ts`).
 *
 * Design refs: AL4 embeddings 2.1 (`place_embeddings`), 2.2 (Migration, step 7), 1.4.9 (Schema
 * Setup change), 1.5 (rows "Schema step 7", "`emptyStore`"); U1 "Unit tests must cover". AL3
 * routing 20261023-embeddings-01-schema, section 2.1 C. Stand-in for contract ACs AC-53, AC-54,
 * AC-55, AC-57 (structure side) and AC-58 (emptying side) until `contracts/embeddings.test.ts`
 * can load (U7).
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Data is
 * seeded through the models and the Knex query builder on the test's own `testDb()` handle; the
 * `embedding` value is always bound as `?::vector` (a binding, never interpolated). Vectors are
 * generated in code (`fakeEmbedding`, `fakeVector`); no vector literal appears in this file.
 * Every `Knex` handle is closed in `afterEach`, `afterEach` re-applies every step after an undo,
 * and `afterAll` re-applies all steps so later files start from a fully migrated database.
 */
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { CommentModel, PlaceModel, PlaceTagModel, TagModel } from '../../src/db/models';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import {
  EmptyResultSchema,
  STORE_TABLES,
  SchemaStepsResultSchema,
  StoreStructureResultSchema,
  type SchemaSetup,
  type StoreStructure,
} from '../../contracts/storage.schema';
import {
  EMBEDDED_AT_UDT_NAME,
  EMBEDDING_COLUMN,
  EMBEDDING_COLUMNS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TABLE,
  SIMILARITY_INDEX,
} from '../../contracts/embeddings.schema';
import { fakeEmbedding, fakeVector } from '../../contracts/embeddings.support';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const STEP_NAMES = [
  '20261021_01_enable_extensions',
  '20261021_02_create_places',
  '20261021_03_create_tags',
  '20261021_04_create_comments',
  '20261022_01_create_crawl_progress',
  '20261022_02_create_item_failures',
  '20261023_01_create_place_embeddings',
] as const;

const EMBEDDINGS_STEP = '20261023_01_create_place_embeddings';
const HNSW_INDEX = 'place_embeddings_embedding_hnsw_idx';

/** Expected columns of `place_embeddings`, in table order (AL4 2.1): [name, udtName]. */
const PLACE_EMBEDDINGS_COLUMNS: readonly (readonly [string, string])[] = [
  ['place_id', 'int8'],
  ['embedding', 'vector'],
  ['embedding_model', 'text'],
  ['document_fingerprint', 'text'],
  ['embedded_at', 'timestamptz'],
];

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

const STORED_PLACE_ID = 900;
const OTHER_PLACE_ID = 901;
const MISSING_PLACE_ID = 999_999;
const EMBEDDED_AT = '2026-10-23T08:00:00Z';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
const knexes: Knex[] = [];

function testDb(): Knex {
  const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
  knexes.push(db);
  return db;
}

beforeAll(async () => {
  setup = createSchemaSetup({ connectionString: requireTestDatabaseUrl() });
  okSteps(await setup.apply());
});

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterEach(async () => {
  for (const db of knexes.splice(0)) await destroyQuietly(db);
  okSteps(await setup.apply());
});

afterAll(async () => {
  try {
    okSteps(await setup.apply());
  } finally {
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers (results are parsed with their contract schema before any assertion)
// ---------------------------------------------------------------------------

function okSteps(result: unknown): string[] {
  const parsed = SchemaStepsResultSchema.parse(result);
  if (!parsed.ok) throw new Error(`expected steps, got ${JSON.stringify(parsed.failure)}`);
  return parsed.value.steps;
}

async function inspectOk(): Promise<StoreStructure> {
  const parsed = StoreStructureResultSchema.parse(await setup.inspect());
  if (!parsed.ok) throw new Error(`expected a structure, got ${JSON.stringify(parsed.failure)}`);
  return parsed.value;
}

function tableNames(structure: StoreStructure): string[] {
  return structure.tables.map((t) => t.name);
}

function columnsOf(structure: StoreStructure, table: string): StoreStructure['tables'][number]['columns'] {
  const found = structure.tables.find((t) => t.name === table);
  if (found === undefined) throw new Error(`table ${table} is missing`);
  return found.columns;
}

const CountRowsSchema = z.array(z.object({ n: z.coerce.number().int() }));

/** Number of rows in a table, read through the query builder. */
async function rowCount(db: Knex, table: string): Promise<number> {
  const result: unknown = await db(table).count({ n: '*' });
  const first = CountRowsSchema.parse(result)[0];
  if (first === undefined) throw new Error(`count on ${table} returned no row`);
  return first.n;
}

/** Every column of the rows of `table` matching `where`, read through the query builder. */
async function readRows(db: Knex, table: string, where: Readonly<Record<string, number>>): Promise<unknown[]> {
  const rows: unknown[] = await db(table).where(where).select('*');
  return rows;
}

/** The pgvector text form `[v1,...,vN]` of a generated vector (never a pasted literal). */
function vectorText(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/** A 64-character lower-case hex Document Fingerprint derived from `seed`. */
function fingerprint(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

interface EmbeddingSeed {
  place_id: number;
  embedding: readonly number[];
  embedding_model: string;
  document_fingerprint: string;
  embedded_at: string;
}

function validEmbedding(placeId: number = STORED_PLACE_ID): EmbeddingSeed {
  return {
    place_id: placeId,
    embedding: fakeEmbedding(`synthetic place ${String(placeId)}`),
    embedding_model: EMBEDDING_MODEL,
    document_fingerprint: fingerprint(`synthetic document ${String(placeId)}`),
    embedded_at: EMBEDDED_AT,
  };
}

/** Inserts one Embedding Record; `embedding` is bound as `?::vector`. */
async function insertEmbedding(db: Knex, row: EmbeddingSeed): Promise<void> {
  await db(EMBEDDING_TABLE).insert({
    place_id: row.place_id,
    embedding: db.raw('?::vector', [vectorText(row.embedding)]),
    embedding_model: row.embedding_model,
    document_fingerprint: row.document_fingerprint,
    embedded_at: row.embedded_at,
  });
}

/** One synthetic Place, through the model. */
async function seedPlace(db: Knex, placeId: number): Promise<void> {
  await PlaceModel.query(db).insert({
    place_id: placeId,
    name: `Synthetic place ${String(placeId)}`,
    wikimapia_url: `http://wikimapia.org/${String(placeId)}/Synthetic-place-${String(placeId)}`,
    location_lon: 20.457,
    location_lat: 44.817,
    bound_north: 44.817,
    bound_south: 44.817,
    bound_east: 20.457,
    bound_west: 20.457,
    outline: [],
    centre_point: 'SRID=4326;POINT(20.457 44.817)',
    outline_shape: null,
  });
}

/** A Place with one Tag, one Place-Tag Link and one Comment, through the models. */
async function seedStoreRows(db: Knex): Promise<void> {
  await seedPlace(db, STORED_PLACE_ID);
  await TagModel.query(db).insert({ tag_id: 194, title: 'synthetic tag' });
  await PlaceTagModel.query(db).insert({
    place_id: STORED_PLACE_ID,
    tag_id: 194,
    presence: 'present',
    position: 0,
  });
  await CommentModel.query(db).insert({
    place_id: STORED_PLACE_ID,
    num: 1,
    parent_num: null,
    lang_id: 1,
    author: 'synthetic author',
    author_user_id: 1,
    author_photo_url: null,
    message: 'synthetic comment',
    good_votes: 0,
    bad_votes: 0,
    is_blocked: false,
    is_deleted: false,
    posted_at_epoch_seconds: 1_700_000_000,
    moderator_user_id: 0,
    moderator_name: null,
    presence: 'present',
    position: 0,
  });
}

const RunIdRowsSchema = z.array(z.object({ run_id: z.number().int().positive() }));

/** One synthetic crawl Run Record, through the query builder; returns its run id. */
async function seedRun(db: Knex): Promise<number> {
  const result: unknown = await db(CRAWL_TABLES.runs)
    .insert({
      region_name: 'test-region-a',
      status: 'in_progress',
      started_at: '2026-10-23T08:00:00Z',
      ended_at: null,
      last_activity: '2026-10-23T08:00:00Z',
      counts: JSON.stringify({ requests: 0 }),
    })
    .returning('run_id');
  const run = RunIdRowsSchema.parse(result)[0];
  if (run === undefined) throw new Error('insert into crawl_runs returned no row');
  return run.run_id;
}

interface StoredSnapshot {
  place: unknown[];
  tag: unknown[];
  placeTag: unknown[];
  comment: unknown[];
  run: unknown[];
}

async function snapshot(db: Knex, runId: number): Promise<StoredSnapshot> {
  return {
    place: await readRows(db, STORE_TABLES.places, { place_id: STORED_PLACE_ID }),
    tag: await readRows(db, STORE_TABLES.tags, { tag_id: 194 }),
    placeTag: await readRows(db, STORE_TABLES.placeTags, { place_id: STORED_PLACE_ID }),
    comment: await readRows(db, STORE_TABLES.comments, { place_id: STORED_PLACE_ID }),
    run: await readRows(db, CRAWL_TABLES.runs, { run_id: runId }),
  };
}

const ALL_CRAWL_TABLES: readonly string[] = Object.values(CRAWL_TABLES);

// ---------------------------------------------------------------------------
// 1. Setup from nothing (AL4 2.2; AC-53)
// ---------------------------------------------------------------------------

describe('Step 7 from nothing (AL4 2.2)', () => {
  it('apply after undoAll returns the seven steps in order, the embedding step last', async () => {
    okSteps(await setup.undoAll());
    expect(okSteps(await setup.apply())).toStrictEqual([...STEP_NAMES]);

    const structure = await inspectOk();
    expect(structure.appliedSteps).toStrictEqual([...STEP_NAMES]);
    expect(structure.appliedSteps.at(-1)).toBe(EMBEDDINGS_STEP);
    expect(structure.pendingSteps).toStrictEqual([]);
    expect(tableNames(structure)).toContain(EMBEDDING_TABLE);
  }, 60_000);

  it('undoAll undoes step 7 first (and step 1 still drops the vector extension)', async () => {
    const undone = okSteps(await setup.undoAll());
    expect(undone).toStrictEqual([...STEP_NAMES].reverse());
    const after = await inspectOk();
    expect(tableNames(after)).not.toContain(EMBEDDING_TABLE);
    expect(after.enabledExtensions).not.toContain('vector');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Undo of step 7 (AL4 2.2; AC-55)
// ---------------------------------------------------------------------------

describe('undoLast of step 7 (AC-55)', () => {
  it('undoes exactly the embedding step, removes every vector column and leaves every other table and row unchanged', async () => {
    const db = testDb();
    await seedStoreRows(db);
    const runId = await seedRun(db);
    await insertEmbedding(db, validEmbedding());
    const before = await snapshot(db, runId);
    expect(before.place).toHaveLength(1);
    expect(before.tag).toHaveLength(1);
    expect(before.placeTag).toHaveLength(1);
    expect(before.comment).toHaveLength(1);
    expect(before.run).toHaveLength(1);
    const tablesBefore = tableNames(await inspectOk());
    expect(tablesBefore).toContain(EMBEDDING_TABLE);

    expect(okSteps(await setup.undoLast())).toStrictEqual([EMBEDDINGS_STEP]);

    const after = await inspectOk();
    const names = tableNames(after);
    expect(names).not.toContain(EMBEDDING_TABLE);
    expect(after.tables.flatMap((t) => t.columns).some((c) => c.udtName === 'vector')).toBe(false);
    expect([...names].sort()).toStrictEqual(tablesBefore.filter((n) => n !== EMBEDDING_TABLE).sort());
    for (const table of Object.values(STORE_TABLES)) expect(names).toContain(table);
    for (const table of ALL_CRAWL_TABLES) expect(names).toContain(table);
    expect(after.appliedSteps).toStrictEqual(STEP_NAMES.slice(0, 6));
    expect(after.pendingSteps).toStrictEqual([EMBEDDINGS_STEP]);
    expect(after.enabledExtensions).toContain('vector');
    expect(await snapshot(db, runId)).toStrictEqual(before);

    expect(okSteps(await setup.apply())).toStrictEqual([EMBEDDINGS_STEP]);
    const reapplied = await inspectOk();
    expect(reapplied.pendingSteps).toStrictEqual([]);
    expect(tableNames(reapplied)).toContain(EMBEDDING_TABLE);
    expect(await snapshot(db, runId)).toStrictEqual(before);
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Structure (AL4 2.1; AC-53, AC-57)
// ---------------------------------------------------------------------------

describe('place_embeddings structure (AL4 2.1)', () => {
  it('has exactly the designed columns, in order', async () => {
    const columns = columnsOf(await inspectOk(), EMBEDDING_TABLE);
    expect(columns.map((c) => [c.name, c.udtName])).toStrictEqual(
      PLACE_EMBEDDINGS_COLUMNS.map(([n, u]) => [n, u]),
    );
    expect(columns.map((c) => c.name)).toStrictEqual([...EMBEDDING_COLUMNS]);
  });

  it('embedding is a vector column and embedded_at has the contract udt', async () => {
    const columns = columnsOf(await inspectOk(), EMBEDDING_TABLE);
    expect(columns.find((c) => c.name === EMBEDDING_COLUMN)?.udtName).toBe('vector');
    expect(columns.find((c) => c.name === 'embedded_at')?.udtName).toBe(EMBEDDED_AT_UDT_NAME);
  });

  it('the only vector column of the store is place_embeddings.embedding', async () => {
    const structure = await inspectOk();
    const vectorColumns = structure.tables.flatMap((t) =>
      t.columns.filter((c) => c.udtName === 'vector').map((c) => `${t.name}.${c.name}`),
    );
    expect(vectorColumns).toStrictEqual([`${EMBEDDING_TABLE}.${EMBEDDING_COLUMN}`]);
  });

  it('has no column that could hold Wikimapia text or a Commenter IP', async () => {
    for (const column of columnsOf(await inspectOk(), EMBEDDING_TABLE)) {
      expect(column.name).not.toMatch(/description|message|title|user_?ip|commenter_?ip/i);
      expect(['inet', 'cidr']).not.toContain(column.udtName);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Accepted row (AL4 2.1)
// ---------------------------------------------------------------------------

describe('place_embeddings accepts a valid Embedding Record (AL4 2.1)', () => {
  it('accepts a 1024-value vector, a non-empty model and a lower-case 64-hex fingerprint for a stored Place', async () => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    const row = validEmbedding();
    expect(row.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(row.document_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    await expect(insertEmbedding(db, row)).resolves.toBeUndefined();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);
  });

  it('accepts a model name other than voyage-4 (any non-empty name)', async () => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    await expect(
      insertEmbedding(db, { ...validEmbedding(), embedding_model: 'older-model' }),
    ).resolves.toBeUndefined();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Rejected rows (AL4 2.1): each with a valid control row accepted
// ---------------------------------------------------------------------------

describe('place_embeddings rejects invalid Embedding Records (AL4 2.1)', () => {
  it('rejects a vector of 1023 values; a 1024-value control row is accepted', async () => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    await expect(
      insertEmbedding(db, { ...validEmbedding(), embedding: fakeVector(EMBEDDING_DIMENSIONS - 1) }),
    ).rejects.toThrow();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(0);

    await expect(insertEmbedding(db, validEmbedding())).resolves.toBeUndefined();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);
  });

  it('rejects a Place ID that is not in places (FK); a control row for a stored Place is accepted', async () => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    await expect(insertEmbedding(db, validEmbedding(MISSING_PLACE_ID))).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(0);

    await expect(insertEmbedding(db, validEmbedding(STORED_PLACE_ID))).resolves.toBeUndefined();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);
  });

  it.each([
    ['an empty embedding_model', { embedding_model: '' }],
    ['an upper-case fingerprint', { document_fingerprint: fingerprint('synthetic document 900').toUpperCase() }],
    ['a 63-character fingerprint', { document_fingerprint: fingerprint('synthetic document 900').slice(0, 63) }],
  ] as const)('rejects %s (CHECK); a valid control row is accepted', async (_label, change) => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    await expect(insertEmbedding(db, { ...validEmbedding(), ...change })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(0);

    await expect(insertEmbedding(db, validEmbedding())).resolves.toBeUndefined();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);
  });

  it('rejects a second row for the same Place (PK); a row for another stored Place is accepted', async () => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    await seedPlace(db, OTHER_PLACE_ID);
    await expect(insertEmbedding(db, validEmbedding(STORED_PLACE_ID))).resolves.toBeUndefined();

    await expect(
      insertEmbedding(db, {
        ...validEmbedding(STORED_PLACE_ID),
        embedding: fakeEmbedding('a different document'),
        document_fingerprint: fingerprint('a different document'),
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);

    await expect(insertEmbedding(db, validEmbedding(OTHER_PLACE_ID))).resolves.toBeUndefined();
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. FK cascade (AL4 2.1 `ON DELETE CASCADE`)
// ---------------------------------------------------------------------------

describe('place_embeddings follows its Place (AL4 2.1 ON DELETE CASCADE)', () => {
  it('deleting the stored Place removes its Embedding Record and leaves other Places\' records', async () => {
    const db = testDb();
    await seedPlace(db, STORED_PLACE_ID);
    await seedPlace(db, OTHER_PLACE_ID);
    await insertEmbedding(db, validEmbedding(STORED_PLACE_ID));
    await insertEmbedding(db, validEmbedding(OTHER_PLACE_ID));
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(2);

    await db(STORE_TABLES.places).where({ place_id: STORED_PLACE_ID }).del();

    expect(await readRows(db, EMBEDDING_TABLE, { place_id: STORED_PLACE_ID })).toStrictEqual([]);
    expect(await readRows(db, EMBEDDING_TABLE, { place_id: OTHER_PLACE_ID })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. emptyStore (AL4 1.4.9; AC-58)
// ---------------------------------------------------------------------------

describe('emptyStore with Embedding Records (AL4 1.4.9, AC-58)', () => {
  it('removes the Embedding Record together with the Place and empties every store and crawl table', async () => {
    const db = testDb();
    await seedStoreRows(db);
    await seedRun(db);
    await insertEmbedding(db, validEmbedding());
    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(1);
    expect(await rowCount(db, STORE_TABLES.places)).toBe(1);

    expect(EmptyResultSchema.parse(await setup.emptyStore())).toStrictEqual({ ok: true, value: {} });

    expect(await rowCount(db, EMBEDDING_TABLE)).toBe(0);
    for (const table of Object.values(STORE_TABLES)) expect(await rowCount(db, table)).toBe(0);
    for (const table of ALL_CRAWL_TABLES) expect(await rowCount(db, table)).toBe(0);
    const structure = await inspectOk();
    expect(structure.pendingSteps).toStrictEqual([]);
    expect(tableNames(structure)).toContain(EMBEDDING_TABLE);
  });

  it('after undoLast of step 7 still resolves ok and clears the store tables', async () => {
    const db = testDb();
    await seedStoreRows(db);
    expect(okSteps(await setup.undoLast())).toStrictEqual([EMBEDDINGS_STEP]);
    expect(tableNames(await inspectOk())).not.toContain(EMBEDDING_TABLE);

    expect(EmptyResultSchema.parse(await setup.emptyStore())).toStrictEqual({ ok: true, value: {} });

    for (const table of Object.values(STORE_TABLES)) expect(await rowCount(db, table)).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 8. Similarity index (AL4 2.1, 2.2; AC-54)
// ---------------------------------------------------------------------------

const IndexRowsSchema = z.array(z.object({ indexname: z.string(), indexdef: z.string() }));

describe('Similarity index (AC-54)', () => {
  it('place_embeddings_embedding_hnsw_idx uses hnsw with vector_cosine_ops and is not partial', async () => {
    const db = testDb();
    const result: unknown = await db('pg_indexes')
      .where('tablename', EMBEDDING_TABLE)
      .select('indexname', 'indexdef');
    const indexes = IndexRowsSchema.parse(result);
    const hnsw = indexes.find((i) => i.indexname === HNSW_INDEX);
    expect(hnsw).toBeDefined();
    const definition = hnsw?.indexdef ?? '';
    expect(definition).toMatch(new RegExp(`USING ${SIMILARITY_INDEX.method}\\b`, 'i'));
    expect(definition).toContain(SIMILARITY_INDEX.operatorClass);
    expect(definition).toContain(`(${EMBEDDING_COLUMN} ${SIMILARITY_INDEX.operatorClass})`);
    expect(definition).not.toMatch(/\bWHERE\b/i);
  });
});
