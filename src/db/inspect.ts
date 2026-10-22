/**
 * Catalogue queries for `SchemaSetup.inspect()` and the current database name (AL4 1.4.10).
 * Every query is parameterized; every result is parsed with a row schema from `rows.ts` and
 * the assembled value is gated with the contract's `StoreStructureSchema` (a failed gate
 * throws; the caller maps it to `store_unavailable`).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { StoreStructureSchema } from '../../contracts/storage.schema';
import type { ColumnInfo, StoreStructure } from '../../contracts/storage.schema';
import { MIGRATION_TABLE } from './migrations';
import { ColumnRowSchema, NameRowSchema } from './rows';

const MIGRATION_LOCK_TABLE = `${MIGRATION_TABLE}_lock`;

const NameRowsSchema = z.object({ rows: z.array(NameRowSchema) });
const ColumnRowsSchema = z.object({ rows: z.array(ColumnRowSchema) });

async function selectNames(db: Knex, sql: string, bindings: readonly string[]): Promise<string[]> {
  const result: unknown = await db.raw(sql, [...bindings]);
  return NameRowsSchema.parse(result).rows.map((row) => row.name);
}

export async function currentDatabaseName(db: Knex): Promise<string> {
  const [name] = await selectNames(db, 'select current_database() as name', []);
  if (name === undefined) throw new Error('current_database() returned no row');
  return name;
}

async function readAppliedSteps(db: Knex): Promise<string[]> {
  const exists = await selectNames(
    db,
    `select table_name::text as name
       from information_schema.tables
      where table_schema = current_schema() and table_name = ?`,
    [MIGRATION_TABLE],
  );
  if (exists.length === 0) return [];
  const result: unknown = await db.select('name').from(MIGRATION_TABLE).orderBy('id');
  return z.array(NameRowSchema).parse(result).map((row) => row.name);
}

async function readTables(db: Knex): Promise<StoreStructure['tables']> {
  const names = await selectNames(
    db,
    `select table_name::text as name
       from information_schema.tables
      where table_schema = current_schema()
        and table_type = ?
        and table_name not in (?, ?)
      order by table_name collate "C"`,
    ['BASE TABLE', MIGRATION_TABLE, MIGRATION_LOCK_TABLE],
  );
  const result: unknown = await db.raw(
    `select table_name::text as table_name, column_name::text as column_name,
            data_type::text as data_type, udt_name::text as udt_name
       from information_schema.columns
      where table_schema = current_schema()
      order by table_name, ordinal_position`,
  );
  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const row of ColumnRowsSchema.parse(result).rows) {
    const column: ColumnInfo = {
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
    };
    const list = columnsByTable.get(row.table_name);
    if (list === undefined) columnsByTable.set(row.table_name, [column]);
    else list.push(column);
  }
  return names.map((name) => ({ name, columns: columnsByTable.get(name) ?? [] }));
}

export async function readStructure(db: Knex, allSteps: readonly string[]): Promise<StoreStructure> {
  const appliedSteps = await readAppliedSteps(db);
  const applied = new Set(appliedSteps);
  const pendingSteps = allSteps.filter((step) => !applied.has(step));
  const enabledExtensions = await selectNames(
    db,
    'select extname::text as name from pg_extension order by extname',
    [],
  );
  const availableExtensions = await selectNames(
    db,
    'select name::text as name from pg_available_extensions order by name',
    [],
  );
  const tables = await readTables(db);
  return StoreStructureSchema.parse({
    appliedSteps,
    pendingSteps,
    enabledExtensions,
    availableExtensions,
    tables,
  });
}
