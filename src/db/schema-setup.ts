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
import { currentDatabaseName, readStructure } from './inspect';
import { MIGRATIONS, MIGRATION_TABLE, migrationSource } from './migrations';

const NOT_CONFIGURED_MESSAGE =
  'Place Store is not configured: connection string is missing or unusable';
const NOT_A_TEST_DATABASE_MESSAGE =
  'Refusing to empty a database whose name does not end in "_test"';

/** `migrate.latest` / `migrate.rollback` resolve `[batchNo, log]`. */
const MigrateResultSchema = z.tuple([z.unknown(), z.array(z.string())]);

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
      await db.raw('TRUNCATE TABLE place_tags, comments, tags, places');
      return { ok: true, value: {} };
    } catch (error) {
      return { ok: false, failure: unavailableFrom(error, 'empty store') };
    }
  }

  return {
    apply,
    undoAll,
    inspect,
    emptyStore,
    close: () => destroyQuietly(db),
  };
}

export const createSchemaSetup: CreateSchemaSetupFn = (options) => {
  const db = openDb(options);
  return db === undefined ? notConfiguredSetup() : configuredSetup(db);
};
