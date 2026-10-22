/**
 * Static migration source (AL4 0.1, 1.4.10): the ordered Schema Setup steps as imported
 * modules. No migration directory, no file-system scan, no `knexfile`.
 */
import type { Knex } from 'knex';
import type { NamedMigration } from '../types';
import * as enableExtensions from './20261021_01_enable_extensions';
import * as createPlaces from './20261021_02_create_places';
import * as createTags from './20261021_03_create_tags';
import * as createComments from './20261021_04_create_comments';

export const MIGRATION_TABLE = 'knex_migrations';

export const MIGRATIONS: readonly NamedMigration[] = [
  { name: '20261021_01_enable_extensions', up: enableExtensions.up, down: enableExtensions.down },
  { name: '20261021_02_create_places', up: createPlaces.up, down: createPlaces.down },
  { name: '20261021_03_create_tags', up: createTags.up, down: createTags.down },
  { name: '20261021_04_create_comments', up: createComments.up, down: createComments.down },
];

export const migrationSource: Knex.MigrationSource<NamedMigration> = {
  getMigrations: () => Promise.resolve([...MIGRATIONS]),
  getMigrationName: (migration) => migration.name,
  getMigration: (migration) =>
    Promise.resolve({
      up: (knex: Knex) => migration.up(knex),
      down: (knex: Knex) => migration.down(knex),
    }),
};
