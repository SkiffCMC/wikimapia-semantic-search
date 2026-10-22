/**
 * Step 3 (AL4 2.3, 2.6): the Tag Catalogue `tags` and the Place-Tag Links `place_tags`.
 */
import type { Knex } from 'knex';
import { STORE_TABLES } from '../../../contracts/storage.schema';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(STORE_TABLES.tags, (table) => {
    table.bigInteger('tag_id').notNullable().primary({ constraintName: 'tags_pkey' });
    table.text('title').notNullable();

    table.check('tag_id >= 0', {}, 'tags_tag_id_not_negative');
  });

  await knex.schema.createTable(STORE_TABLES.placeTags, (table) => {
    table.bigInteger('place_id').notNullable();
    table.bigInteger('tag_id').notNullable();
    table.text('presence').notNullable();
    table.integer('position').nullable();

    table.primary(['place_id', 'tag_id'], { constraintName: 'place_tags_pkey' });
    table
      .foreign('place_id', 'place_tags_place_id_fkey')
      .references('place_id')
      .inTable(STORE_TABLES.places)
      .onDelete('CASCADE');
    table
      .foreign('tag_id', 'place_tags_tag_id_fkey')
      .references('tag_id')
      .inTable(STORE_TABLES.tags)
      .onDelete('RESTRICT');
    table.check(`presence IN ('present', 'gone')`, {}, 'place_tags_presence_valid');
    table.check(
      `(presence = 'present') = (position IS NOT NULL)`,
      {},
      'place_tags_position_iff_present',
    );
    table.check('position >= 0', {}, 'place_tags_position_not_negative');
    table.index(['tag_id', 'place_id'], 'place_tags_tag_id_place_id_idx', 'btree');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(STORE_TABLES.placeTags);
  await knex.schema.dropTable(STORE_TABLES.tags);
}
