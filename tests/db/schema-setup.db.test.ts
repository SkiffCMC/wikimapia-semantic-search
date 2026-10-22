/**
 * AL2 unit tests: Schema Setup (`src/db/schema-setup.ts`), the migration steps
 * (`src/db/migrations/`) and the Objection models (`src/db/models.ts`).
 *
 * Design refs: AL4 1.3 (`schema-setup.ts`, `inspect.ts`), 1.4.1 Factories, 1.4.10 Schema Setup,
 * 2.1 .. 2.4 (tables), 2.6 Migrations. AL3 routing 20261021-storage-03-schema, section 2.1.
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
import { createSchemaSetup, isTestDatabaseName } from '../../src/db/schema-setup';
import { MIGRATIONS } from '../../src/db/migrations';
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
] as const;

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

/** All four Schema Setup methods that return a result, each parsed with its contract schema. */
async function allFailures(s: SchemaSetup): Promise<StoreFailure[]> {
  return [
    failureOf(SchemaStepsResultSchema.parse(await s.apply())),
    failureOf(SchemaStepsResultSchema.parse(await s.undoAll())),
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
  it('lists exactly the four steps, in order', () => {
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

  it('after undoAll, apply returns the four steps in order and inspect shows them applied', async () => {
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

  it('undoAll returns the four steps, newest first', async () => {
    const undone = okSteps(await setup.undoAll());
    expect([...undone].sort()).toStrictEqual([...STEP_NAMES].sort());
    expect(undone).toStrictEqual([...STEP_NAMES].reverse());
  }, 60_000);

  it('after undoAll nothing is applied, all four are pending, tables and extensions are gone', async () => {
    okSteps(await setup.undoAll());

    const after = await inspectOk();
    expect(after.appliedSteps).toStrictEqual([]);
    expect(after.pendingSteps).toStrictEqual([...STEP_NAMES]);
    const tables = tableNames(after);
    for (const table of Object.values(STORE_TABLES)) expect(tables).not.toContain(table);
    expect(after.enabledExtensions).not.toContain('vector');
    expect(after.enabledExtensions).not.toContain('postgis');
  }, 60_000);

  it('a second undoAll undoes nothing', async () => {
    okSteps(await setup.undoAll());
    expect(okSteps(await setup.undoAll())).toStrictEqual([]);
  }, 60_000);

  it('re-applying after undoAll returns the same four steps', async () => {
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
// ---------------------------------------------------------------------------

describe('Forbidden columns (AC-5, AC-6, AC-14)', () => {
  it('AC-5: no vector or embedding column, no crawl-progress table; vector is enabled', async () => {
    const structure = await inspectOk();
    expect(structure.enabledExtensions).toContain('vector');
    for (const table of structure.tables) {
      expect(table.name).not.toMatch(/crawl|progress|visit|checkpoint|cursor|queue|job|embedding/i);
      for (const column of table.columns) {
        expect(column.udtName).not.toBe('vector');
        expect(column.name).not.toMatch(/embedding|vector/i);
        expect(column.name).not.toMatch(/visited|crawled|progress|cursor/i);
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
