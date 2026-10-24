/**
 * Schema Setup (public entry point; AL4 1.4.1, 1.4.10): applies, undoes and inspects the
 * versioned steps and empties the Test Database. The factory never throws and no method
 * ever rejects: every failure resolves `store_unavailable` without secrets (AC-57).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { StoreConfigSchema, TEST_DATABASE_NAME_SUFFIX } from '../../contracts/storage.schema';
import type {
  CreateSchemaSetupFn,
  EmptyResult,
  SchemaSetup,
  SchemaSetupOptions,
  SchemaStepsResult,
  StoreStructureResult,
} from '../../contracts/storage.schema';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from './connection';
import { storeUnavailable, unavailableFrom } from './failures';
import { CRAWL_TABLES } from './crawl-tables';
import { currentDatabaseName, readAppliedSteps, readStructure } from './inspect';
import { MIGRATIONS, MIGRATION_TABLE, migrationSource } from './migrations';

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const NOT_A_TEST_DATABASE_MESSAGE =
  'Refusing to empty a database whose name does not end in "_test"';

/** `migrate.latest` / `migrate.rollback` / `migrate.down` resolve `[batchNo, log]`. */
const MigrateResultSchema = z.tuple([z.unknown(), z.array(z.string())]);

/** Result of the `to_regclass` existence probe. */
const TableExistsResultSchema = z.object({
  rows: z.tuple([z.object({ present: z.boolean() })]),
});

const EMBEDDINGS_TABLE = 'place_embeddings';
const TRUNCATE_STORE_TABLES = 'TRUNCATE TABLE place_tags, comments, tags, places';
const TRUNCATE_STORE_AND_EMBEDDING_TABLES =
  'TRUNCATE TABLE place_embeddings, place_tags, comments, tags, places';
const TRUNCATE_CRAWL_TABLES =
  'TRUNCATE TABLE crawl_finished_pages, crawl_passes, crawl_runs RESTART IDENTITY';
const TRUNCATE_ALL_CRAWL_TABLES =
  'TRUNCATE TABLE crawl_place_releases, crawl_explicit_retries, crawl_item_failures, crawl_finished_pages, crawl_passes, crawl_runs RESTART IDENTITY';
const TABLE_EXISTS = 'select to_regclass(?) is not null as present';

const MIGRATION_CONFIG: Knex.MigratorConfig = {
  migrationSource,
  tableName: MIGRATION_TABLE,
};

const STEP_NAMES: readonly string[] = MIGRATIONS.map((migration) => migration.name);

export function isTestDatabaseName(name: string): boolean {
  return name.endsWith(TEST_DATABASE_NAME_SUFFIX);
}

function openDb(options: SchemaSetupOptions): Knex | undefined {
  try {
    const parsed = StoreConfigSchema.safeParse({ connectionString: options.connectionString });
    if (!parsed.success) return undefined;
    return createDb(parsed.data.connectionString, POOL_MAX_SETUP);
  } catch {
    return undefined;
  }
}

function notConfiguredSetup(): SchemaSetup {
  const failure = () => ({ ok: false as const, failure: storeUnavailable(NOT_CONFIGURED_MESSAGE) });
  return {
    apply: () => Promise.resolve(failure()),
    undoAll: () => Promise.resolve(failure()),
    undoLast: () => Promise.resolve(failure()),
    inspect: () => Promise.resolve(failure()),
    emptyStore: () => Promise.resolve(failure()),
    close: () => Promise.resolve(),
  };
}

function configuredSetup(db: Knex): SchemaSetup {
  async function apply(): Promise<SchemaStepsResult> {
    try {
      const result: unknown = await db.migrate.latest(MIGRATION_CONFIG);
      const [, steps] = MigrateResultSchema.parse(result);
      return { ok: true, value: { steps } };
    } catch (error) {
      return { ok: false, failure: unavailableFrom(error, 'schema setup apply') };
    }
  }

  async function undoAll(): Promise<SchemaStepsResult> {
    try {
      const result: unknown = await db.migrate.rollback(MIGRATION_CONFIG, true);
      const [, steps] = MigrateResultSchema.parse(result);
      return { ok: true, value: { steps } };
    } catch (error) {
      return { ok: false, failure: unavailableFrom(error, 'schema setup undo') };
    }
  }

  async function undoLast(): Promise<SchemaStepsResult> {
    try {
      const applied = await readAppliedSteps(db);
      if (applied.length === 0) return { ok: true, value: { steps: [] } };
      const result: unknown = await db.migrate.down(MIGRATION_CONFIG);
      const [, steps] = MigrateResultSchema.parse(result);
      return { ok: true, value: { steps } };
    } catch (error) {
      return { ok: false, failure: unavailableFrom(error, 'schema setup undo last') };
    }
  }

  async function inspect(): Promise<StoreStructureResult> {
    try {
      return { ok: true, value: await readStructure(db, STEP_NAMES) };
    } catch (error) {
      return { ok: false, failure: unavailableFrom(error, 'schema setup inspect') };
    }
  }

  async function emptyStore(): Promise<EmptyResult> {
    try {
      const name = await currentDatabaseName(db);
      if (!isTestDatabaseName(name)) {
        return { ok: false, failure: storeUnavailable(NOT_A_TEST_DATABASE_MESSAGE) };
      }
      await db.transaction(async (trx) => {
        const embeddings: unknown = await trx.raw(TABLE_EXISTS, [EMBEDDINGS_TABLE]);
        const [{ present: embeddingsPresent }] = TableExistsResultSchema.parse(embeddings).rows;
        await trx.raw(
          embeddingsPresent ? TRUNCATE_STORE_AND_EMBEDDING_TABLES : TRUNCATE_STORE_TABLES,
        );
        const result: unknown = await trx.raw(TABLE_EXISTS, [CRAWL_TABLES.runs]);
        const [{ present }] = TableExistsResultSchema.parse(result).rows;
        if (!present) return;
        const failures: unknown = await trx.raw(TABLE_EXISTS, [CRAWL_TABLES.itemFailures]);
        const [{ present: failuresPresent }] = TableExistsResultSchema.parse(failures).rows;
        await trx.raw(failuresPresent ? TRUNCATE_ALL_CRAWL_TABLES : TRUNCATE_CRAWL_TABLES);
      });
      return { ok: true, value: {} };
    } catch (error) {
      return { ok: false, failure: unavailableFrom(error, 'empty store') };
    }
  }

  return {
    apply,
    undoAll,
    undoLast,
    inspect,
    emptyStore,
    close: () => destroyQuietly(db),
  };
}

export const createSchemaSetup: CreateSchemaSetupFn = (options) => {
  const db = openDb(options);
  return db === undefined ? notConfiguredSetup() : configuredSetup(db);
};
