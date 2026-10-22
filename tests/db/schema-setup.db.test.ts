/**
 * AL2 unit tests: Schema Setup (`src/db/schema-setup.ts`), the migration steps
 * (`src/db/migrations/`) and the Objection models (`src/db/models.ts`).
 *
 * Design refs: AL4 1.3 (`schema-setup.ts`, `inspect.ts`), 1.4.1 Factories, 1.4.10 Schema Setup,
 * 2.1 .. 2.4 (tables), 2.6 Migrations. AL3 routing 20261021-storage-03-schema, section 2.1.
 * Extended by feature `hydration` (AL4 hydration 1.4.12, 2.5; AL3 routing
 * 20261022-hydration-01-schema, section 2.1 A): the 5th step, `undoLast`, and `emptyStore`
 * clearing Crawl Progress.
 * Stand-in for contract ACs AC-1 .. AC-6, AC-14 (structure), AC-57 (Schema Setup part) and AC-61
 * until `contracts/storage.test.ts` can load (U8).
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`, AC-60) and the contract's
 * unreachable URL. It never connects to `DATABASE_URL` and never writes SQL itself: data goes
 * through the model classes, bound per query (`XModel.query(db)`). Every `SchemaSetup` and
 * every `Knex` created here is closed in `afterEach`/`afterAll`. `afterAll` re-applies all steps
 * so that later test files start from a fully migrated database.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createSchemaSetup, isTestDatabaseName } from '../../src/db/schema-setup';
import { MIGRATIONS } from '../../src/db/migrations';
import { CRAWL_TABLES } from '../../src/db/crawl-tables';
import { CommentModel, PlaceModel, PlaceTagModel, TagModel } from '../../src/db/models';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import {
  EmptyResultSchema,
  REQUIRED_EXTENSIONS,
  STORE_TABLES,
  SchemaStepsResultSchema,
  StoreStructureResultSchema,
  type CreateSchemaSetupFn,
  type SchemaSetup,
  type StoreFailure,
  type StoreStructure,
} from '../../contracts/storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';

// Compile-time check: the entry point has the contract's signature.
const createSetup: CreateSchemaSetupFn = createSchemaSetup;

const STEP_NAMES = [
  '20261021_01_enable_extensions',
  '20261021_02_create_places',
  '20261021_03_create_tags',
  '20261021_04_create_comments',
  '20261022_01_create_crawl_progress',
] as const;

const CRAWL_STEP = '20261022_01_create_crawl_progress';
const STORAGE_STEPS: readonly string[] = STEP_NAMES.slice(0, 4);

// ---------------------------------------------------------------------------
// Expected structure (AL4 2.2 .. 2.4), columns in table order: [name, udtName]
// ---------------------------------------------------------------------------

const PLACES_COLUMNS: readonly (readonly [string, string])[] = [
  ['place_id', 'int8'],
  ['name', 'text'],
  ['wikimapia_url', 'text'],
  ['location_lon', 'float8'],
  ['location_lat', 'float8'],
  ['bound_north', 'float8'],
  ['bound_south', 'float8'],
  ['bound_east', 'float8'],
  ['bound_west', 'float8'],
  ['outline', 'jsonb'],
  ['centre_point', 'geometry'],
  ['outline_shape', 'geometry'],
  ['description', 'text'],
  ['is_building', 'bool'],
  ['is_region', 'bool'],
  ['is_deleted', 'bool'],
  ['parent_place_id', 'int8'],
  ['wikipedia_url', 'text'],
  ['address_street', 'text'],
  ['address_house_number', 'text'],
  ['address_city', 'text'],
  ['address_place', 'text'],
  ['address_state', 'text'],
  ['address_country', 'text'],
  ['details_fetched_at', 'timestamptz'],
];

const TAGS_COLUMNS: readonly (readonly [string, string])[] = [
  ['tag_id', 'int8'],
  ['title', 'text'],
];

const PLACE_TAGS_COLUMNS: readonly (readonly [string, string])[] = [
  ['place_id', 'int8'],
  ['tag_id', 'int8'],
  ['presence', 'text'],
  ['position', 'int4'],
];

const COMMENTS_COLUMNS: readonly (readonly [string, string])[] = [
  ['place_id', 'int8'],
  ['num', 'int8'],
  ['parent_num', 'int8'],
  ['lang_id', 'int8'],
  ['author', 'text'],
  ['author_user_id', 'int8'],
  ['author_photo_url', 'text'],
  ['message', 'text'],
  ['good_votes', 'int8'],
  ['bad_votes', 'int8'],
  ['is_blocked', 'bool'],
  ['is_deleted', 'bool'],
  ['posted_at_epoch_seconds', 'int8'],
  ['moderator_user_id', 'int8'],
  ['moderator_name', 'text'],
  ['presence', 'text'],
  ['position', 'int4'],
];

const EXPECTED_COLUMNS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [STORE_TABLES.places, PLACES_COLUMNS],
  [STORE_TABLES.tags, TAGS_COLUMNS],
  [STORE_TABLES.placeTags, PLACE_TAGS_COLUMNS],
  [STORE_TABLES.comments, COMMENTS_COLUMNS],
];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let setup: SchemaSetup;
const extraSetups: SchemaSetup[] = [];
const knexes: Knex[] = [];

function trackSetup(s: SchemaSetup): SchemaSetup {
  extraSetups.push(s);
  return s;
}

function testDb(): Knex {
  const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
  knexes.push(db);
  return db;
}

beforeAll(async () => {
  setup = createSetup({ connectionString: requireTestDatabaseUrl() });
  okSteps(await setup.apply());
});

afterEach(async () => {
  for (const s of extraSetups.splice(0)) await s.close();
  for (const db of knexes.splice(0)) await destroyQuietly(db);
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

async function inspectOk(s: SchemaSetup = setup): Promise<StoreStructure> {
  const parsed = StoreStructureResultSchema.parse(await s.inspect());
  if (!parsed.ok) throw new Error(`expected a structure, got ${JSON.stringify(parsed.failure)}`);
  return parsed.value;
}

function failureOf(result: { ok: true } | { ok: false; failure: StoreFailure }): StoreFailure {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result.failure;
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

/** Number of rows in a table, read through the query builder (no SQL strings). */
async function rowCount(db: Knex, table: string): Promise<number> {
  const result: unknown = await db(table).count({ n: '*' });
  const first = CountRowsSchema.parse(result)[0];
  if (first === undefined) throw new Error(`count on ${table} returned no row`);
  return first.n;
}

const RunIdRowsSchema = z.array(z.object({ run_id: z.number().int().positive() }));

/** One synthetic row in each Crawl Progress table (AL4 hydration 2.2 .. 2.4). */
async function seedCrawlRows(db: Knex): Promise<void> {
  const result: unknown = await db(CRAWL_TABLES.runs)
    .insert({
      region_name: 'test-region-a',
      status: 'in_progress',
      started_at: '2026-10-22T08:00:00Z',
      ended_at: null,
      last_activity: '2026-10-22T08:00:00Z',
      counts: JSON.stringify({ requests: 0 }),
    })
    .returning('run_id');
  const run = RunIdRowsSchema.parse(result)[0];
  if (run === undefined) throw new Error('insert into crawl_runs returned no row');
  await db(CRAWL_TABLES.passes).insert({
    region_name: 'test-region-a',
    pass_number: 1,
    bbox_west: 20.4,
    bbox_south: 44.8,
    bbox_east: 20.5,
    bbox_north: 44.9,
    tile_width: 0.05,
    tile_height: 0.05,
    tile_count: 4,
    started_by_run_id: run.run_id,
    started_at: '2026-10-22T08:00:00Z',
  });
  await db(CRAWL_TABLES.finishedPages).insert({
    region_name: 'test-region-a',
    pass_number: 1,
    tile_number: 1,
    page_no: 1,
    run_id: run.run_id,
    place_count: 3,
    is_short: true,
    reported_total: 3,
    finished_at: '2026-10-22T08:01:00Z',
  });
}

/** All five Schema Setup methods that return a result, each parsed with its contract schema. */
async function allFailures(s: SchemaSetup): Promise<StoreFailure[]> {
  return [
    failureOf(SchemaStepsResultSchema.parse(await s.apply())),
    failureOf(SchemaStepsResultSchema.parse(await s.undoAll())),
    failureOf(SchemaStepsResultSchema.parse(await s.undoLast())),
    failureOf(StoreStructureResultSchema.parse(await s.inspect())),
    failureOf(EmptyResultSchema.parse(await s.emptyStore())),
  ];
}

// ---------------------------------------------------------------------------
// 1. isTestDatabaseName (pure; AL4 1.3, 1.4.10)
// ---------------------------------------------------------------------------

describe('isTestDatabaseName', () => {
  it.each(['wikimapia_test', 'x_test'])('is true for %j', (name) => {
    expect(isTestDatabaseName(name)).toBe(true);
  });

  it.each(['wikimapia', 'wikimapia_test_old', 'test', '_Test', ''])('is false for %j', (name) => {
    expect(isTestDatabaseName(name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Step list (AL4 2.6, 1.4.10)
// ---------------------------------------------------------------------------

describe('MIGRATIONS', () => {
  it('lists exactly the five steps, in order', () => {
    expect(MIGRATIONS.map((m) => m.name)).toStrictEqual([...STEP_NAMES]);
  });

  it('every step has an up and a down function', () => {
    for (const step of MIGRATIONS) {
      expect(typeof step.up).toBe('function');
      expect(typeof step.down).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Setup from nothing (AC-2, AC-1)
// ---------------------------------------------------------------------------

describe('Setup from nothing (AC-1, AC-2)', () => {
  afterEach(async () => {
    okSteps(await setup.apply());
  });

  it('after undoAll, apply returns the five steps in order and inspect shows them applied', async () => {
    okSteps(await setup.undoAll());
    expect(okSteps(await setup.apply())).toStrictEqual([...STEP_NAMES]);

    const structure = await inspectOk();
    expect(structure.appliedSteps).toStrictEqual([...STEP_NAMES]);
    expect(structure.pendingSteps).toStrictEqual([]);
    for (const extension of REQUIRED_EXTENSIONS) {
      expect(structure.enabledExtensions).toContain(extension);
      expect(structure.availableExtensions).toContain(extension);
    }
    const tables = tableNames(structure);
    for (const table of Object.values(STORE_TABLES)) expect(tables).toContain(table);
    for (const table of Object.values(CRAWL_TABLES)) expect(tables).toContain(table);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Setup repeated (AC-3)
// ---------------------------------------------------------------------------

describe('Setup repeated (AC-3)', () => {
  it('a second apply applies nothing and leaves the applied steps unchanged', async () => {
    const before = (await inspectOk()).appliedSteps;
    expect(before).toStrictEqual([...STEP_NAMES]);

    expect(okSteps(await setup.apply())).toStrictEqual([]);

    expect((await inspectOk()).appliedSteps).toStrictEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 5. Setup undone (AC-4)
// ---------------------------------------------------------------------------

describe('Setup undone (AC-4)', () => {
  afterEach(async () => {
    okSteps(await setup.apply());
  });

  it('undoAll returns the five steps, newest first', async () => {
    const undone = okSteps(await setup.undoAll());
    expect([...undone].sort()).toStrictEqual([...STEP_NAMES].sort());
    expect(undone).toStrictEqual([...STEP_NAMES].reverse());
  }, 60_000);

  it('after undoAll nothing is applied, all five are pending, tables and extensions are gone', async () => {
    okSteps(await setup.undoAll());

    const after = await inspectOk();
    expect(after.appliedSteps).toStrictEqual([]);
    expect(after.pendingSteps).toStrictEqual([...STEP_NAMES]);
    const tables = tableNames(after);
    for (const table of Object.values(STORE_TABLES)) expect(tables).not.toContain(table);
    for (const table of Object.values(CRAWL_TABLES)) expect(tables).not.toContain(table);
    expect(after.enabledExtensions).not.toContain('vector');
    expect(after.enabledExtensions).not.toContain('postgis');
  }, 60_000);

  it('a second undoAll undoes nothing', async () => {
    okSteps(await setup.undoAll());
    expect(okSteps(await setup.undoAll())).toStrictEqual([]);
  }, 60_000);

  it('re-applying after undoAll returns the same five steps', async () => {
    okSteps(await setup.undoAll());
    expect(okSteps(await setup.apply())).toStrictEqual([...STEP_NAMES]);
    const reapplied = await inspectOk();
    expect(reapplied.pendingSteps).toStrictEqual([]);
    for (const table of Object.values(STORE_TABLES)) {
      expect(tableNames(reapplied)).toContain(table);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. Exact structure (AL4 2.2 .. 2.4, 1.4.10)
// ---------------------------------------------------------------------------

describe('Exact structure', () => {
  it.each(EXPECTED_COLUMNS)('table %s has exactly the designed columns, in order', async (table, expected) => {
    const columns = columnsOf(await inspectOk(), table);
    expect(columns.map((c) => [c.name, c.udtName])).toStrictEqual(expected.map(([n, u]) => [n, u]));
  });

  it('geometry columns of places are USER-DEFINED geometry', async () => {
    const columns = columnsOf(await inspectOk(), STORE_TABLES.places);
    for (const name of ['centre_point', 'outline_shape']) {
      const column = columns.find((c) => c.name === name);
      expect(column).toStrictEqual({ name, dataType: 'USER-DEFINED', udtName: 'geometry' });
    }
  });

  it('tables are ordered by name', async () => {
    const names = tableNames(await inspectOk());
    expect(names).toStrictEqual([...names].sort());
  });

  it('excludes the migration bookkeeping tables', async () => {
    const names = tableNames(await inspectOk());
    expect(names).not.toContain('knex_migrations');
    expect(names).not.toContain('knex_migrations_lock');
  });
});

// ---------------------------------------------------------------------------
// 7. Forbidden columns (AC-5, AC-6, AC-14); regexes copied from contracts/storage.test.ts
//    (AC-5 as narrowed by AL5 for feature `hydration`: crawl tables are allowed)
// ---------------------------------------------------------------------------

describe('Forbidden columns (AC-5, AC-6, AC-14)', () => {
  it('AC-5: no vector or embedding table or column; vector is enabled', async () => {
    const structure = await inspectOk();
    expect(structure.enabledExtensions).toContain('vector');
    for (const table of structure.tables) {
      expect(table.name).not.toMatch(/embedding|vector/i);
      for (const column of table.columns) {
        expect(column.udtName).not.toBe('vector');
        expect(column.name).not.toMatch(/embedding|vector/i);
      }
    }
  });

  it('AC-6: comments has an author column and nothing that could hold an IP', async () => {
    const columns = columnsOf(await inspectOk(), STORE_TABLES.comments);
    expect(columns.some((c) => /author/i.test(c.name))).toBe(true);
    expect(columns.some((c) => c.name.includes('author'))).toBe(true);
    for (const column of columns) {
      expect(column.name).not.toMatch(/(^|_)ip($|_)|ip_?addr|user_?ip|commenter_?ip|userip/i);
      expect(['inet', 'cidr']).not.toContain(column.udtName);
    }
  });

  it('AC-6: no table anywhere has a Commenter IP column or an inet/cidr column', async () => {
    for (const table of (await inspectOk()).tables) {
      for (const column of table.columns) {
        expect(column.name).not.toMatch(/user_?ip|commenter_?ip/i);
        expect(['inet', 'cidr']).not.toContain(column.udtName);
      }
    }
  });

  it('AC-14: no column holds the page number, page size or Total Found', async () => {
    for (const table of (await inspectOk()).tables) {
      for (const column of table.columns) {
        expect(column.name).not.toMatch(
          /^(page|page_?size|page_?number|count|found|total_?found|total)$/i,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Models match the tables (AL4 2.2 .. 2.4 "Objection")
// ---------------------------------------------------------------------------

describe('Models match the tables', () => {
  const MODELS: readonly (readonly [string, { tableName: string; idColumn: string | string[] }, string, string | string[]])[] = [
    ['PlaceModel', PlaceModel, STORE_TABLES.places, 'place_id'],
    ['CommentModel', CommentModel, STORE_TABLES.comments, ['place_id', 'num']],
    ['TagModel', TagModel, STORE_TABLES.tags, 'tag_id'],
    ['PlaceTagModel', PlaceTagModel, STORE_TABLES.placeTags, ['place_id', 'tag_id']],
  ];

  it.each(MODELS)('%s has the designed tableName and idColumn', (_label, model, table, idColumn) => {
    expect(model.tableName).toBe(table);
    expect(model.idColumn).toStrictEqual(idColumn);
  });

  it.each(MODELS)('%s table and id columns exist in the database', async (_label, model) => {
    const structure = await inspectOk();
    const columns = columnsOf(structure, model.tableName).map((c) => c.name);
    const ids = Array.isArray(model.idColumn) ? model.idColumn : [model.idColumn];
    for (const id of ids) expect(columns).toContain(id);
  });

  it('PlaceModel.jsonAttributes is [outline] and outline is jsonb', async () => {
    expect(PlaceModel.jsonAttributes).toStrictEqual(['outline']);
    const outline = columnsOf(await inspectOk(), STORE_TABLES.places).find((c) => c.name === 'outline');
    expect(outline?.udtName).toBe('jsonb');
  });
});

// ---------------------------------------------------------------------------
// 9. emptyStore (AC-61, AL4 1.4.10)
// ---------------------------------------------------------------------------

describe('emptyStore on the migrated Test Database (AC-61)', () => {
  beforeEach(async () => {
    expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
  });

  it('removes stored rows and keeps the structure', async () => {
    const db = testDb();
    await TagModel.query(db).insert({ tag_id: 194, title: 'synthetic tag' });
    expect(await TagModel.query(db).resultSize()).toBe(1);

    const emptied = EmptyResultSchema.parse(await setup.emptyStore());
    expect(emptied).toStrictEqual({ ok: true, value: {} });

    expect(await TagModel.query(db).resultSize()).toBe(0);
    expect((await inspectOk()).pendingSteps).toStrictEqual([]);
  });

  it('clears all seven tables: the four store tables and the three crawl tables', async () => {
    const db = testDb();
    await TagModel.query(db).insert({ tag_id: 194, title: 'synthetic tag' });
    await seedCrawlRows(db);
    for (const table of Object.values(CRAWL_TABLES)) expect(await rowCount(db, table)).toBe(1);

    const emptied = EmptyResultSchema.parse(await setup.emptyStore());
    expect(emptied).toStrictEqual({ ok: true, value: {} });

    const allTables = [...Object.values(STORE_TABLES), ...Object.values(CRAWL_TABLES)];
    expect(allTables).toHaveLength(7);
    for (const table of allTables) expect(await rowCount(db, table)).toBe(0);
    expect((await inspectOk()).pendingSteps).toStrictEqual([]);
  });

  it('the tags CHECK rejects a negative tag id', async () => {
    const db = testDb();
    await expect(
      TagModel.query(db).insert({ tag_id: -1, title: 'negative' }),
    ).rejects.toThrow();
    expect(await TagModel.query(db).resultSize()).toBe(0);
  });
});

describe('emptyStore without the tables (AC-61)', () => {
  afterEach(async () => {
    okSteps(await setup.apply());
  });

  it('resolves store_unavailable after undoAll', async () => {
    okSteps(await setup.undoAll());
    const failure = failureOf(EmptyResultSchema.parse(await setup.emptyStore()));
    expect(failure.kind).toBe('store_unavailable');
  }, 60_000);

  it('after undoLast (crawl tables absent) succeeds and still clears the store tables', async () => {
    const db = testDb();
    await TagModel.query(db).insert({ tag_id: 194, title: 'synthetic tag' });
    expect(okSteps(await setup.undoLast())).toStrictEqual([CRAWL_STEP]);

    expect(EmptyResultSchema.parse(await setup.emptyStore())).toStrictEqual({ ok: true, value: {} });
    expect(await TagModel.query(db).resultSize()).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9b. undoLast (hydration AC-55, AC-56; AL4 hydration 1.4.12, 2.5)
// ---------------------------------------------------------------------------

describe('undoLast', () => {
  afterEach(async () => {
    okSteps(await setup.apply());
    EmptyResultSchema.parse(await setup.emptyStore());
  });

  it('undoes exactly the Crawl Progress step and leaves the store tables and their rows unchanged', async () => {
    expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
    const db = testDb();
    await TagModel.query(db).insert({ tag_id: 194, title: 'synthetic tag' });
    const before = (await TagModel.query(db).orderBy('tag_id')).map((t) => ({
      tag_id: t.tag_id,
      title: t.title,
    }));
    expect(before).toStrictEqual([{ tag_id: 194, title: 'synthetic tag' }]);

    expect(okSteps(await setup.undoLast())).toStrictEqual([CRAWL_STEP]);

    const after = await inspectOk();
    expect(after.appliedSteps).toStrictEqual([...STORAGE_STEPS]);
    expect(after.pendingSteps).toStrictEqual([CRAWL_STEP]);
    const tables = tableNames(after);
    for (const table of Object.values(CRAWL_TABLES)) expect(tables).not.toContain(table);
    for (const table of Object.values(STORE_TABLES)) expect(tables).toContain(table);

    const kept = (await TagModel.query(db).orderBy('tag_id')).map((t) => ({
      tag_id: t.tag_id,
      title: t.title,
    }));
    expect(kept).toStrictEqual(before);
  }, 60_000);

  it('a second undoLast undoes the comments step; apply then re-applies both', async () => {
    expect(okSteps(await setup.undoLast())).toStrictEqual([CRAWL_STEP]);
    expect(okSteps(await setup.undoLast())).toStrictEqual(['20261021_04_create_comments']);

    const after = await inspectOk();
    expect(after.appliedSteps).toStrictEqual(STEP_NAMES.slice(0, 3));
    expect(after.pendingSteps).toStrictEqual(['20261021_04_create_comments', CRAWL_STEP]);
    expect(tableNames(after)).not.toContain(STORE_TABLES.comments);

    expect(okSteps(await setup.apply())).toStrictEqual(['20261021_04_create_comments', CRAWL_STEP]);
    expect((await inspectOk()).pendingSteps).toStrictEqual([]);
  }, 60_000);

  it('with nothing applied (after undoAll) returns no steps', async () => {
    okSteps(await setup.undoAll());
    expect(SchemaStepsResultSchema.parse(await setup.undoLast())).toStrictEqual({
      ok: true,
      value: { steps: [] },
    });
    const after = await inspectOk();
    expect(after.appliedSteps).toStrictEqual([]);
    expect(after.pendingSteps).toStrictEqual([...STEP_NAMES]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 10. Failures (AC-57, AL4 1.4.1)
// ---------------------------------------------------------------------------

describe('Failures (AC-57)', () => {
  it('an empty connection string does not throw, and every method resolves store_unavailable', async () => {
    let broken: SchemaSetup | undefined;
    expect(() => {
      broken = trackSetup(createSetup({ connectionString: '' }));
    }).not.toThrow();
    if (broken === undefined) throw new Error('createSchemaSetup returned nothing');

    for (const failure of await allFailures(broken)) {
      expect(failure.kind).toBe('store_unavailable');
    }
  });

  it('an unreachable server resolves store_unavailable without secrets', async () => {
    const unreachable = trackSetup(createSetup({ connectionString: UNREACHABLE_DATABASE_URL }));
    for (const failure of await allFailures(unreachable)) {
      expect(failure.kind).toBe('store_unavailable');
      const text = JSON.stringify(failure);
      expect(text).not.toContain(UNREACHABLE_PASSWORD);
      expect(text).not.toContain(UNREACHABLE_DATABASE_URL);
      expect(text).not.toContain('postgres://');
    }
  }, 60_000);

  it('a missing database on the real server does not reveal the connection string', async () => {
    const url = new URL(requireTestDatabaseUrl());
    url.pathname = '/wm_missing_database_test';
    const wrongDb = trackSetup(createSetup({ connectionString: url.toString() }));

    const failure = failureOf(StoreStructureResultSchema.parse(await wrongDb.inspect()));
    expect(failure.kind).toBe('store_unavailable');
    const text = JSON.stringify(failure);
    expect(text).not.toContain(url.toString());
    if (url.password !== '') expect(text).not.toContain(decodeURIComponent(url.password));
  }, 60_000);

  it('close() resolves twice, for a broken, an unreachable and a used setup', async () => {
    // Tracked as well, so they are released even if an assertion fails (close is idempotent).
    const broken = trackSetup(createSetup({ connectionString: '' }));
    const unreachable = trackSetup(createSetup({ connectionString: UNREACHABLE_DATABASE_URL }));
    const used = trackSetup(createSetup({ connectionString: requireTestDatabaseUrl() }));
    await inspectOk(used);
    for (const s of [broken, unreachable, used]) {
      await expect(s.close()).resolves.toBeUndefined();
      await expect(s.close()).resolves.toBeUndefined();
    }
  }, 60_000);
});
