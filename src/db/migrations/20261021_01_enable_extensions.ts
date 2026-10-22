/**
 * Step 1 (AL4 2.6): enables `postgis` and `vector` (`.agrules` section 3: extensions are
 * created by migration). The undo drops them without `CASCADE`, so it fails loudly if
 * anything unexpected still depends on them.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS postgis');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP EXTENSION IF EXISTS vector');
  await knex.raw('DROP EXTENSION IF EXISTS postgis');
}
