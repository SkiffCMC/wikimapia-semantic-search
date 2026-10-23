/**
 * Step 6 (AL4 crawl-run1-fixes 2.1 .. 2.4): widens the `crawl_runs` status check by
 * `quota_exhausted` and adds the Failure Records (`crawl_item_failures`), the Explicit Retries
 * (`crawl_explicit_retries`) and the per-Place Count Resets (`crawl_place_releases`). Every
 * constraint and index carries an explicit name; `knex.raw` is used only for constant DDL text.
 * The status and failure-kind lists are frozen literals (equal to `RunRecordStatusSchema` and
 * `ItemFailureKindSchema` at the time of writing), never built from the live contract enums.
 */
import type { Knex } from 'knex';
import { CRAWL_TABLES, ITEM_FAILURE_PAGE_COLUMN } from '../crawl-tables';

const REGION_NAME_RULE = `region_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`;
const MOMENT = { useTz: true, precision: 0 } as const;

const WIDEN_RUN_STATUS = `ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_status_valid, ADD CONSTRAINT crawl_runs_status_valid CHECK (status IN ('in_progress', 'completed', 'budget_reached', 'rate_limited', 'quota_exhausted', 'interrupted', 'failed', 'abandoned'))`;
const NARROW_RUN_STATUS = `ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_status_valid, ADD CONSTRAINT crawl_runs_status_valid CHECK (status IN ('in_progress', 'completed', 'budget_reached', 'rate_limited', 'interrupted', 'failed', 'abandoned')) NOT VALID`;
const FAILURE_KIND_RULE = `failure_kind IN ('connection', 'wikimapia_error', 'unexpected_response', 'invalid_request', 'invalid_data')`;
const ONE_ITEM_RULE = `(place_id IS NOT NULL AND tile_number IS NULL AND page_no IS NULL) OR (place_id IS NULL AND tile_number IS NOT NULL AND page_no IS NOT NULL)`;
const FAILURES_PLACE_INDEX = `CREATE INDEX crawl_item_failures_place_idx ON crawl_item_failures (place_id, failed_at) WHERE place_id IS NOT NULL`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(WIDEN_RUN_STATUS);

  await knex.schema.createTable(CRAWL_TABLES.itemFailures, (table) => {
    table.bigIncrements('failure_id', { primaryKey: false });
    table.bigInteger('run_id').notNullable();
    table.bigInteger('place_id').nullable();
    table.integer('tile_number').nullable();
    table.integer(ITEM_FAILURE_PAGE_COLUMN).nullable();
    table.text('failure_kind').notNullable();
    table.text('message').notNullable();
    table.timestamp('failed_at', MOMENT).notNullable();

    table.primary(['failure_id'], { constraintName: 'crawl_item_failures_pkey' });
    table
      .foreign('run_id', 'crawl_item_failures_run_id_fkey')
      .references('run_id')
      .inTable(CRAWL_TABLES.runs)
      .onDelete('RESTRICT');
    table.check('place_id IS NULL OR place_id >= 1', {}, 'crawl_item_failures_place_id_positive');
    table.check(
      'tile_number IS NULL OR tile_number >= 1',
      {},
      'crawl_item_failures_tile_number_positive',
    );
    table.check('page_no IS NULL OR page_no >= 1', {}, 'crawl_item_failures_page_no_positive');
    table.check(FAILURE_KIND_RULE, {}, 'crawl_item_failures_failure_kind_valid');
    table.check(`message <> ''`, {}, 'crawl_item_failures_message_not_empty');
    table.check(ONE_ITEM_RULE, {}, 'crawl_item_failures_one_item');
    table.index(['run_id', 'failed_at'], 'crawl_item_failures_run_idx', 'btree');
  });
  await knex.raw(FAILURES_PLACE_INDEX);

  await knex.schema.createTable(CRAWL_TABLES.explicitRetries, (table) => {
    table.bigInteger('run_id').notNullable();
    table.text('region_name').notNullable();
    table.timestamp('retried_at', MOMENT).notNullable();
    table.integer('places_released').notNullable();

    table.primary(['run_id'], { constraintName: 'crawl_explicit_retries_pkey' });
    table
      .foreign('run_id', 'crawl_explicit_retries_run_id_fkey')
      .references('run_id')
      .inTable(CRAWL_TABLES.runs)
      .onDelete('RESTRICT');
    table.check(REGION_NAME_RULE, {}, 'crawl_explicit_retries_region_name_valid');
    table.check(
      'places_released >= 0',
      {},
      'crawl_explicit_retries_places_released_not_negative',
    );
    table.index(['region_name', 'retried_at'], 'crawl_explicit_retries_region_idx', 'btree');
  });

  await knex.schema.createTable(CRAWL_TABLES.placeReleases, (table) => {
    table.bigInteger('run_id').notNullable();
    table.bigInteger('place_id').notNullable();
    table.timestamp('released_at', MOMENT).notNullable();

    table.primary(['place_id', 'run_id'], { constraintName: 'crawl_place_releases_pkey' });
    table
      .foreign('run_id', 'crawl_place_releases_run_id_fkey')
      .references('run_id')
      .inTable(CRAWL_TABLES.explicitRetries)
      .onDelete('CASCADE');
    table.check('place_id >= 1', {}, 'crawl_place_releases_place_id_positive');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(CRAWL_TABLES.placeReleases);
  await knex.schema.dropTable(CRAWL_TABLES.explicitRetries);
  await knex.schema.dropTable(CRAWL_TABLES.itemFailures);
  await knex.raw(NARROW_RUN_STATUS);
}
