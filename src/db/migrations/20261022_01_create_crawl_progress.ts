/**
 * Step 5 (AL4 hydration 2.1 .. 2.5): Crawl Progress and Run Records, i.e. `crawl_runs`,
 * `crawl_passes` and `crawl_finished_pages`. Every constraint and index carries an explicit
 * name; `knex.raw` is used only for constant DDL text (partial unique indexes).
 */
import type { Knex } from 'knex';
import { CRAWL_TABLES } from '../crawl-tables';

const REGION_NAME_RULE = `region_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`;
const MOMENT = { useTz: true, precision: 0 } as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(CRAWL_TABLES.runs, (table) => {
    table.bigIncrements('run_id', { primaryKey: false });
    table.text('region_name').notNullable();
    table.text('status').notNullable();
    table.timestamp('started_at', MOMENT).notNullable();
    table.timestamp('ended_at', MOMENT).nullable();
    table.timestamp('last_activity', MOMENT).notNullable();
    table.jsonb('counts').notNullable();

    table.primary(['run_id'], { constraintName: 'crawl_runs_pkey' });
    table.check(REGION_NAME_RULE, {}, 'crawl_runs_region_name_valid');
    table.check(
      `status IN ('in_progress', 'completed', 'budget_reached', 'rate_limited', 'interrupted', 'failed', 'abandoned')`,
      {},
      'crawl_runs_status_valid',
    );
    table.check(
      `(status IN ('in_progress', 'abandoned')) = (ended_at IS NULL)`,
      {},
      'crawl_runs_ended_at_iff_ended',
    );
    table.check(
      'ended_at IS NULL OR ended_at >= started_at',
      {},
      'crawl_runs_ended_at_not_before_start',
    );
    table.check('last_activity >= started_at', {}, 'crawl_runs_last_activity_not_before_start');
    table.index(['region_name', 'run_id'], 'crawl_runs_region_name_run_id_idx', 'btree');
  });
  await knex.raw(
    `CREATE UNIQUE INDEX crawl_runs_one_live_per_region ON crawl_runs (region_name) WHERE status = 'in_progress'`,
  );

  await knex.schema.createTable(CRAWL_TABLES.passes, (table) => {
    table.text('region_name').notNullable();
    table.integer('pass_number').notNullable();
    table.double('bbox_west').notNullable();
    table.double('bbox_south').notNullable();
    table.double('bbox_east').notNullable();
    table.double('bbox_north').notNullable();
    table.double('tile_width').notNullable();
    table.double('tile_height').notNullable();
    table.integer('tile_count').notNullable();
    table.bigInteger('started_by_run_id').notNullable();
    table.timestamp('started_at', MOMENT).notNullable();

    table.primary(['region_name', 'pass_number'], { constraintName: 'crawl_passes_pkey' });
    table
      .foreign('started_by_run_id', 'crawl_passes_started_by_run_id_fkey')
      .references('run_id')
      .inTable(CRAWL_TABLES.runs)
      .onDelete('RESTRICT');
    table.check(REGION_NAME_RULE, {}, 'crawl_passes_region_name_valid');
    table.check('pass_number >= 1', {}, 'crawl_passes_pass_number_positive');
    table.check(
      'bbox_west < bbox_east AND bbox_south < bbox_north',
      {},
      'crawl_passes_bbox_ordered',
    );
    table.check('tile_width > 0', {}, 'crawl_passes_tile_width_positive');
    table.check('tile_height > 0', {}, 'crawl_passes_tile_height_positive');
    table.check('tile_count >= 1', {}, 'crawl_passes_tile_count_positive');
  });

  await knex.schema.createTable(CRAWL_TABLES.finishedPages, (table) => {
    table.text('region_name').notNullable();
    table.integer('pass_number').notNullable();
    table.integer('tile_number').notNullable();
    table.integer('page_no').notNullable();
    table.bigInteger('run_id').notNullable();
    table.integer('place_count').notNullable();
    table.boolean('is_short').notNullable();
    table.bigInteger('reported_total').nullable();
    table.timestamp('finished_at', MOMENT).notNullable();

    table.primary(['region_name', 'pass_number', 'tile_number', 'page_no'], {
      constraintName: 'crawl_finished_pages_pkey',
    });
    table
      .foreign(['region_name', 'pass_number'], 'crawl_finished_pages_pass_fkey')
      .references(['region_name', 'pass_number'])
      .inTable(CRAWL_TABLES.passes)
      .onDelete('CASCADE');
    table
      .foreign('run_id', 'crawl_finished_pages_run_id_fkey')
      .references('run_id')
      .inTable(CRAWL_TABLES.runs)
      .onDelete('RESTRICT');
    table.check(REGION_NAME_RULE, {}, 'crawl_finished_pages_region_name_valid');
    table.check('tile_number >= 1', {}, 'crawl_finished_pages_tile_number_positive');
    table.check('page_no >= 1', {}, 'crawl_finished_pages_page_no_positive');
    table.check('place_count >= 0', {}, 'crawl_finished_pages_place_count_not_negative');
    table.check(
      'reported_total IS NULL OR reported_total >= 0',
      {},
      'crawl_finished_pages_reported_total_not_negative',
    );
  });
  await knex.raw(
    `CREATE UNIQUE INDEX crawl_finished_pages_one_short_per_tile ON crawl_finished_pages (region_name, pass_number, tile_number) WHERE is_short`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(CRAWL_TABLES.finishedPages);
  await knex.schema.dropTable(CRAWL_TABLES.passes);
  await knex.schema.dropTable(CRAWL_TABLES.runs);
}
