/**
 * Step 2 (AL4 2.2, 2.6): the `places` table with its checks and indexes. Geometry columns use
 * WGS 84 (SRID 4326). Raw DDL fragments are constant text only, never runtime values.
 */
import type { Knex } from 'knex';
import { STORE_TABLES } from '../../../contracts/storage.schema';

const ADDRESS_COLUMNS = [
  'address_street',
  'address_house_number',
  'address_city',
  'address_place',
  'address_state',
  'address_country',
] as const;

/** Summary-only: every details column is null. */
const SUMMARY_ONLY = [
  'details_fetched_at IS NULL',
  'description IS NULL',
  'is_building IS NULL',
  'is_region IS NULL',
  'is_deleted IS NULL',
  'parent_place_id IS NULL',
  'wikipedia_url IS NULL',
  ...ADDRESS_COLUMNS.map((column) => `${column} IS NULL`),
].join(' AND ');

/** Detailed: the always-present details columns are set. */
const DETAILED = [
  'details_fetched_at IS NOT NULL',
  'description IS NOT NULL',
  'is_building IS NOT NULL',
  'is_region IS NOT NULL',
  'is_deleted IS NOT NULL',
].join(' AND ');

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(STORE_TABLES.places, (table) => {
    table.bigInteger('place_id').notNullable().primary({ constraintName: 'places_pkey' });
    table.text('name').notNullable();
    table.text('wikimapia_url').notNullable();
    table.double('location_lon').notNullable();
    table.double('location_lat').notNullable();
    table.double('bound_north').notNullable();
    table.double('bound_south').notNullable();
    table.double('bound_east').notNullable();
    table.double('bound_west').notNullable();
    table.jsonb('outline').notNullable();
    table.specificType('centre_point', 'geometry(Point, 4326)').notNullable();
    table.specificType('outline_shape', 'geometry(Polygon, 4326)').nullable();
    table.text('description').nullable();
    table.boolean('is_building').nullable();
    table.boolean('is_region').nullable();
    table.boolean('is_deleted').nullable();
    table.bigInteger('parent_place_id').nullable();
    table.text('wikipedia_url').nullable();
    for (const column of ADDRESS_COLUMNS) table.text(column).nullable();
    table.timestamp('details_fetched_at', { useTz: true, precision: 0 }).nullable();

    table.check('place_id > 0', {}, 'places_place_id_positive');
    table.check(`wikipedia_url <> ''`, {}, 'places_wikipedia_url_not_empty');
    for (const column of ADDRESS_COLUMNS) {
      table.check(`${column} <> ''`, {}, `places_${column}_not_empty`);
    }
    table.check(`(${SUMMARY_ONLY}) OR (${DETAILED})`, {}, 'places_details_consistent');

    table.index(['centre_point'], 'places_centre_point_gist', 'gist');
    table.index(['outline_shape'], 'places_outline_shape_gist', 'gist');
    table.index(['details_fetched_at'], 'places_details_fetched_at_idx', 'btree');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(STORE_TABLES.places);
}
