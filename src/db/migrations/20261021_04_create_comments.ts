/**
 * Step 4 (AL4 2.4, 2.6): `comments`, keyed by `(place_id, num)`, with the deferrable
 * self-reference for replies. There is no column for a Commenter IP in any form (AC-6).
 */
import type { Knex } from 'knex';
import { STORE_TABLES } from '../../../contracts/storage.schema';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(STORE_TABLES.comments, (table) => {
    table.bigInteger('place_id').notNullable();
    table.bigInteger('num').notNullable();
    table.bigInteger('parent_num').nullable();
    table.bigInteger('lang_id').notNullable();
    table.text('author').notNullable();
    table.bigInteger('author_user_id').notNullable();
    table.text('author_photo_url').nullable();
    table.text('message').notNullable();
    table.bigInteger('good_votes').notNullable();
    table.bigInteger('bad_votes').notNullable();
    table.boolean('is_blocked').notNullable();
    table.boolean('is_deleted').notNullable();
    table.bigInteger('posted_at_epoch_seconds').notNullable();
    table.bigInteger('moderator_user_id').notNullable();
    table.text('moderator_name').nullable();
    table.text('presence').notNullable();
    table.integer('position').nullable();

    table.primary(['place_id', 'num'], { constraintName: 'comments_pkey' });
    table.check('num >= 0', {}, 'comments_num_not_negative');
    table.check('parent_num <> num', {}, 'comments_parent_num_not_self');
    table.check(`author_photo_url <> ''`, {}, 'comments_author_photo_url_not_empty');
    table.check(`moderator_name <> ''`, {}, 'comments_moderator_name_not_empty');
    table.check(`presence IN ('present', 'gone')`, {}, 'comments_presence_valid');
    table.check(
      `(presence = 'present') = (position IS NOT NULL)`,
      {},
      'comments_position_iff_present',
    );
    table.check('position >= 0', {}, 'comments_position_not_negative');
    table
      .foreign('place_id', 'comments_place_id_fkey')
      .references('place_id')
      .inTable(STORE_TABLES.places)
      .onDelete('CASCADE');
    table
      .foreign(['place_id', 'parent_num'], 'comments_parent_fkey')
      .references(['place_id', 'num'])
      .inTable(STORE_TABLES.comments)
      .deferrable('deferred');
    table.index(['place_id', 'parent_num'], 'comments_place_id_parent_num_idx', 'btree');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(STORE_TABLES.comments);
}
