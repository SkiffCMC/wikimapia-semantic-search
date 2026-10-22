/**
 * AL2 unit tests: the Crawl Progress Schema Setup step (`src/db/crawl-tables.ts`,
 * `src/db/migrations/20261022_01_create_crawl_progress.ts`) and the crawl part of
 * `SchemaSetup.emptyStore()`.
 *
 * Design refs: AL4 hydration 1.1 (`crawl-tables.ts`), 1.4.12, 2.1 .. 2.5.
 * AL3 routing 20261022-hydration-01-schema, section 2.1 B.
 *
 * Runs against the Test Database (`requireTestDatabaseUrl()`), never `DATABASE_URL`. Rows are
 * seeded with the Knex query builder through the test's own `testDb()` handle (no SQL strings);
 * every value is synthetic. Constraint failures are identified by their PostgreSQL error code
 * (23514 check, 23505 unique, 23503 foreign key). Every `SchemaSetup` and `Knex` handle is
 * closed in `afterEach`/`afterAll`; `afterAll` re-applies all steps and empties the store.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { CRAWL_REGION_LOCK_CLASS, CRAWL_TABLES } from '../../src/db/crawl-tables';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import {
  EmptyResultSchema,
  SchemaStepsResultSchema,
  StoreStructureResultSchema,
  type CreateSchemaSetupFn,
  type SchemaSetup,
  type StoreStructure,
} from '../../contracts/storage.schema';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const createSetup: CreateSchemaSetupFn = createSchemaSetup;

// ---------------------------------------------------------------------------
// Expected structure (AL4 2.2 .. 2.4), columns in table order: [name, udtName]
// ---------------------------------------------------------------------------

const RUNS_COLUMNS: readonly (readonly [string, string])[] = [
  ['run_id', 'int8'],
  ['region_name', 'text'],
  ['status', 'text'],
  ['started_at', 'timestamptz'],
  ['ended_at', 'timestamptz'],
  ['last_activity', 'timestamptz'],
  ['counts', 'jsonb'],
];

const PASSES_COLUMNS: readonly (readonly [string, string])[] = [
  ['region_name', 'text'],
  ['pass_number', 'int4'],
  ['bbox_west', 'float8'],
  ['bbox_south', 'float8'],
  ['bbox_east', 'float8'],
  ['bbox_north', 'float8'],
  ['tile_width', 'float8'],
  ['tile_height', 'float8'],
  ['tile_count', 'int4'],
  ['started_by_run_id', 'int8'],
  ['started_at', 'timestamptz'],
];

const FINISHED_PAGES_COLUMNS: readonly (readonly [string, string])[] = [
  ['region_name', 'text'],
  ['pass_number', 'int4'],
  ['tile_number', 'int4'],
  ['page_no', 'int4'],
  ['run_id', 'int8'],
  ['place_count', 'int4'],
  ['is_short', 'bool'],
  ['reported_total', 'int8'],
  ['finished_at', 'timestamptz'],
];

const EXPECTED_COLUMNS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['crawl_runs', RUNS_COLUMNS],
  ['crawl_passes', PASSES_COLUMNS],
  ['crawl_finished_pages', FINISHED_PAGES_COLUMNS],
];

/** Column-name rules of AL4 2.1 (storage AC-5, AC-6, AC-14; hydration AC-58). */
const FORBIDDEN_COLUMN_NAMES: readonly RegExp[] = [
  /embedding|vector/i,
  /user_?ip|commenter_?ip/i,
  /^(page|page_?size|page_?number|count|found|total_?found|total)$/i,
  /description|message|comment|title|author|user_?ip|outline|polygon/i,
];

const FORBIDDEN_UDT_NAMES: readonly string[] = ['geometry', 'geography', 'inet', 'cidr', 'vector'];

// PostgreSQL SQLSTATE codes.
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

// Synthetic values.
const REGION_A = 'test-region-a';
const REGION_B = 'test-region-b';
const T_START = '2026-10-22T08:00:00Z';
const T_LATER = '2026-10-22T09:00:00Z';
const T_EARLIER = '2026-10-22T07:00:00Z';
const SYNTHETIC_COUNTS = JSON.stringify({ requests: 0 });

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
  setup = createSetup({ connectionString: requireTestDatabaseUrl() });
  okSteps(await setup.apply());
});

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore())).toStrictEqual({ ok: true, value: {} });
});

afterEach(async () => {
  for (const db of knexes.splice(0)) await destroyQuietly(db);
});

afterAll(async () => {
  try {
    okSteps(await setup.apply());
    EmptyResultSchema.parse(await setup.emptyStore());
  } finally {
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
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

function columnsOf(structure: StoreStructure, table: string): StoreStructure['tables'][number]['columns'] {
  const found = structure.tables.find((t) => t.name === table);
  if (found === undefined) throw new Error(`table ${table} is missing`);
  return found.columns;
}

const RunIdRowsSchema = z.array(z.object({ run_id: z.number().int().positive() }));
const CountRowsSchema = z.array(z.object({ n: z.coerce.number().int() }));

interface RunRow {
  run_id?: number;
  region_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_activity: string;
  counts: string;
}

interface PassRow {
  region_name: string;
  pass_number: number;
  bbox_west: number;
  bbox_south: number;
  bbox_east: number;
  bbox_north: number;
  tile_width: number;
  tile_height: number;
  tile_count: number;
  started_by_run_id: number;
  started_at: string;
}

interface FinishedPageRow {
  region_name: string;
  pass_number: number;
  tile_number: number;
  page_no: number;
  run_id: number;
  place_count: number;
  is_short: boolean;
  reported_total: number | null;
  finished_at: string;
}

function liveRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    region_name: REGION_A,
    status: 'in_progress',
    started_at: T_START,
    ended_at: null,
    last_activity: T_START,
    counts: SYNTHETIC_COUNTS,
    ...overrides,
  };
}

function endedRun(overrides: Partial<RunRow> = {}): RunRow {
  return liveRun({ status: 'completed', ended_at: T_LATER, last_activity: T_LATER, ...overrides });
}

async function insertRun(db: Knex, row: RunRow): Promise<number> {
  const result: unknown = await db(CRAWL_TABLES.runs).insert(row).returning('run_id');
  const first = RunIdRowsSchema.parse(result)[0];
  if (first === undefined) throw new Error('insert into crawl_runs returned no row');
  return first.run_id;
}

function pass(runId: number, overrides: Partial<PassRow> = {}): PassRow {
  return {
    region_name: REGION_A,
    pass_number: 1,
    bbox_west: 20.4,
    bbox_south: 44.8,
    bbox_east: 20.5,
    bbox_north: 44.9,
    tile_width: 0.05,
    tile_height: 0.05,
    tile_count: 4,
    started_by_run_id: runId,
    started_at: T_START,
    ...overrides,
  };
}

async function insertPass(db: Knex, row: PassRow): Promise<void> {
  await db(CRAWL_TABLES.passes).insert(row);
}

function page(runId: number, overrides: Partial<FinishedPageRow> = {}): FinishedPageRow {
  return {
    region_name: REGION_A,
    pass_number: 1,
    tile_number: 1,
    page_no: 1,
    run_id: runId,
    place_count: 3,
    is_short: false,
    reported_total: null,
    finished_at: T_LATER,
    ...overrides,
  };
}

async function insertPage(db: Knex, row: FinishedPageRow): Promise<void> {
  await db(CRAWL_TABLES.finishedPages).insert(row);
}

async function rowCount(db: Knex, table: string): Promise<number> {
  const result: unknown = await db(table).count({ n: '*' });
  const first = CountRowsSchema.parse(result)[0];
  if (first === undefined) throw new Error(`count on ${table} returned no row`);
  return first.n;
}

/** A Run and its first pass, so pages can reference both. */
async function seedRunAndPass(db: Knex): Promise<number> {
  const runId = await insertRun(db, liveRun());
  await insertPass(db, pass(runId));
  return runId;
}

// ---------------------------------------------------------------------------
// 1. Constants (AL4 1.1)
// ---------------------------------------------------------------------------

describe('crawl-tables constants', () => {
  it('CRAWL_TABLES names the three Crawl Progress tables', () => {
    expect(CRAWL_TABLES).toStrictEqual({
      runs: 'crawl_runs',
      passes: 'crawl_passes',
      finishedPages: 'crawl_finished_pages',
    });
  });

  it('CRAWL_REGION_LOCK_CLASS is 20261022 (fits int4)', () => {
    expect(CRAWL_REGION_LOCK_CLASS).toBe(20261022);
    expect(Number.isSafeInteger(CRAWL_REGION_LOCK_CLASS)).toBe(true);
    expect(CRAWL_REGION_LOCK_CLASS).toBeLessThanOrEqual(2_147_483_647);
  });
});

// ---------------------------------------------------------------------------
// 2. Exact structure (AL4 2.2 .. 2.4)
// ---------------------------------------------------------------------------

describe('Crawl Progress structure', () => {
  it('the step is applied and the three tables exist', async () => {
    const structure = await inspectOk();
    expect(structure.appliedSteps).toContain('20261022_01_create_crawl_progress');
    expect(structure.pendingSteps).toStrictEqual([]);
    const names = structure.tables.map((t) => t.name);
    for (const table of Object.values(CRAWL_TABLES)) expect(names).toContain(table);
  });

  it.each(EXPECTED_COLUMNS)('table %s has exactly the designed columns, in order', async (table, expected) => {
    const columns = columnsOf(await inspectOk(), table);
    expect(columns.map((c) => [c.name, c.udtName])).toStrictEqual(expected.map(([n, u]) => [n, u]));
  });
});

// ---------------------------------------------------------------------------
// 3. Column rules (AL4 2.1; storage AC-5, AC-6, AC-14; hydration AC-58)
// ---------------------------------------------------------------------------

describe('Crawl Progress column rules (AC-58)', () => {
  it('no crawl column name matches a forbidden pattern and no crawl column has a forbidden type', async () => {
    const structure = await inspectOk();
    let checked = 0;
    for (const table of Object.values(CRAWL_TABLES)) {
      const columns = columnsOf(structure, table);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        for (const pattern of FORBIDDEN_COLUMN_NAMES) expect(column.name).not.toMatch(pattern);
        expect(FORBIDDEN_UDT_NAMES).not.toContain(column.udtName);
        checked += 1;
      }
    }
    expect(checked).toBe(RUNS_COLUMNS.length + PASSES_COLUMNS.length + FINISHED_PAGES_COLUMNS.length);
  });

  it('no crawl table name matches embedding or vector', () => {
    for (const table of Object.values(CRAWL_TABLES)) expect(table).not.toMatch(/embedding|vector/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Constraints of crawl_runs (AL4 2.2)
// ---------------------------------------------------------------------------

describe('crawl_runs constraints', () => {
  it('accepts a valid in_progress Run and a valid completed Run', async () => {
    const db = testDb();
    const live = await insertRun(db, liveRun());
    const done = await insertRun(db, endedRun({ region_name: REGION_B }));
    expect(live).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(live);
    expect(await rowCount(db, CRAWL_TABLES.runs)).toBe(2);
  });

  it('accepts an abandoned Run without ended_at', async () => {
    const db = testDb();
    await insertRun(db, liveRun({ status: 'abandoned' }));
    expect(await rowCount(db, CRAWL_TABLES.runs)).toBe(1);
  });

  it.each(['completed', 'budget_reached', 'rate_limited', 'interrupted', 'failed'])(
    'accepts the ended status %s with an ended_at',
    async (status) => {
      const db = testDb();
      await insertRun(db, endedRun({ status }));
      expect(await rowCount(db, CRAWL_TABLES.runs)).toBe(1);
    },
  );

  it('rejects an unknown status (running)', async () => {
    const db = testDb();
    await expect(insertRun(db, liveRun({ status: 'running' }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('rejects in_progress with a non-null ended_at', async () => {
    const db = testDb();
    await expect(insertRun(db, liveRun({ ended_at: T_LATER }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('rejects abandoned with a non-null ended_at', async () => {
    const db = testDb();
    await expect(
      insertRun(db, liveRun({ status: 'abandoned', ended_at: T_LATER })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects completed with a null ended_at', async () => {
    const db = testDb();
    await expect(insertRun(db, endedRun({ ended_at: null }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('rejects ended_at before started_at', async () => {
    const db = testDb();
    await expect(
      insertRun(db, endedRun({ ended_at: T_EARLIER, last_activity: T_START })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects last_activity before started_at', async () => {
    const db = testDb();
    await expect(insertRun(db, liveRun({ last_activity: T_EARLIER }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it.each(['Belgrade', 'belgrade small', '-belgrade', 'belgrade-', 'belgrade--small', ''])(
    'rejects the Region Name %j',
    async (regionName) => {
      const db = testDb();
      await expect(insertRun(db, liveRun({ region_name: regionName }))).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
    },
  );

  it('rejects a second in_progress Run for the same Region (crawl_runs_one_live_per_region)', async () => {
    const db = testDb();
    await insertRun(db, liveRun());
    await expect(insertRun(db, liveRun())).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'crawl_runs_one_live_per_region',
    });
    expect(await rowCount(db, CRAWL_TABLES.runs)).toBe(1);
  });

  it('accepts a second in_progress Run for another Region', async () => {
    const db = testDb();
    await insertRun(db, liveRun());
    await insertRun(db, liveRun({ region_name: REGION_B }));
    expect(await rowCount(db, CRAWL_TABLES.runs)).toBe(2);
  });

  it('accepts a second completed Run (and a live one) for the same Region', async () => {
    const db = testDb();
    await insertRun(db, endedRun());
    await insertRun(db, endedRun());
    await insertRun(db, liveRun());
    expect(await rowCount(db, CRAWL_TABLES.runs)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Constraints of crawl_passes (AL4 2.3)
// ---------------------------------------------------------------------------

describe('crawl_passes constraints', () => {
  it('accepts a valid pass', async () => {
    const db = testDb();
    await seedRunAndPass(db);
    expect(await rowCount(db, CRAWL_TABLES.passes)).toBe(1);
  });

  it.each([
    ['bbox_west = bbox_east', { bbox_west: 20.5, bbox_east: 20.5 }],
    ['bbox_west > bbox_east', { bbox_west: 20.6, bbox_east: 20.5 }],
    ['bbox_south >= bbox_north', { bbox_south: 44.9, bbox_north: 44.9 }],
    ['tile_width = 0', { tile_width: 0 }],
    ['tile_height = 0', { tile_height: 0 }],
    ['tile_count = 0', { tile_count: 0 }],
    ['pass_number = 0', { pass_number: 0 }],
    ['Region Name with upper case', { region_name: 'Belgrade' }],
  ] as const)('rejects a pass with %s', async (_label, overrides) => {
    const db = testDb();
    const runId = await insertRun(db, liveRun());
    await expect(insertPass(db, pass(runId, overrides))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('rejects a pass started by an unknown Run', async () => {
    const db = testDb();
    const runId = await insertRun(db, liveRun());
    await expect(insertPass(db, pass(runId + 1000))).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
  });

  it('rejects a second pass with the same (region_name, pass_number)', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await expect(insertPass(db, pass(runId))).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await insertPass(db, pass(runId, { pass_number: 2 }));
    expect(await rowCount(db, CRAWL_TABLES.passes)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Constraints of crawl_finished_pages (AL4 2.4)
// ---------------------------------------------------------------------------

describe('crawl_finished_pages constraints', () => {
  it('accepts a valid page with and without reported_total', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await insertPage(db, page(runId));
    await insertPage(db, page(runId, { page_no: 2, reported_total: 290 }));
    expect(await rowCount(db, CRAWL_TABLES.finishedPages)).toBe(2);
  });

  it('rejects page_no = 0', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await expect(insertPage(db, page(runId, { page_no: 0 }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it.each([
    ['tile_number = 0', { tile_number: 0 }],
    ['place_count < 0', { place_count: -1 }],
    ['reported_total < 0', { reported_total: -1 }],
  ] as const)('rejects a page with %s', async (_label, overrides) => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await expect(insertPage(db, page(runId, overrides))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('rejects a page of an unknown (region_name, pass_number)', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await expect(insertPage(db, page(runId, { pass_number: 2 }))).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
    await expect(insertPage(db, page(runId, { region_name: REGION_B }))).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
  });

  it('rejects a page finished by an unknown Run', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await expect(insertPage(db, page(runId + 1000))).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
  });

  it('rejects the same page of a tile twice (primary key)', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await insertPage(db, page(runId));
    await expect(insertPage(db, page(runId))).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('rejects a second Short Page for the same tile of a pass; non-short pages are not limited', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await insertPage(db, page(runId, { page_no: 1 }));
    await insertPage(db, page(runId, { page_no: 2 }));
    await insertPage(db, page(runId, { page_no: 3, is_short: true }));
    await expect(
      insertPage(db, page(runId, { page_no: 4, is_short: true })),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    // A Short Page of another tile of the same pass is accepted.
    await insertPage(db, page(runId, { tile_number: 2, page_no: 1, is_short: true }));
    expect(await rowCount(db, CRAWL_TABLES.finishedPages)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 7. emptyStore clears Crawl Progress and restarts the run id (AL4 1.4.12)
// ---------------------------------------------------------------------------

describe('emptyStore and Crawl Progress', () => {
  it('clears every crawl table', async () => {
    const db = testDb();
    const runId = await seedRunAndPass(db);
    await insertPage(db, page(runId));

    expect(EmptyResultSchema.parse(await setup.emptyStore())).toStrictEqual({ ok: true, value: {} });

    for (const table of Object.values(CRAWL_TABLES)) expect(await rowCount(db, table)).toBe(0);
  });

  it('restarts the run id: the first Run after emptyStore gets run_id 1', async () => {
    const db = testDb();
    await insertRun(db, endedRun());
    const second = await insertRun(db, endedRun());
    expect(second).toBeGreaterThan(1);

    expect(EmptyResultSchema.parse(await setup.emptyStore())).toStrictEqual({ ok: true, value: {} });

    expect(await insertRun(db, liveRun())).toBe(1);
  });
});
