/**
 * Crawl Progress (AL4 hydration 1.4.5, 1.4.6 "PassState query" and step, 1.4.8 finish, 1.4.11,
 * 1.5, 2.2 .. 2.4).
 *
 * Reads: the Crawl Progress view of one Region and the current Listing Pass of a Region. The
 * view is returned ungated: the public Crawl Store gates it with the contract schema.
 *
 * Write steps of a Run (start, Last Activity renewal, listing step, finish): each opens its own
 * short READ COMMITTED transaction and sends every write through one Writer built with the given
 * hook. Lock order: Region advisory lock, then `crawl_runs` rows (start); `crawl_runs` row, then
 * place advisory locks (listing step). Steps throw on any error and never catch.
 *
 * Every value is a binding, every SQL text is a constant, and every row is parsed with its row
 * schema.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  COORDINATE_TOLERANCE,
  RunCountsSchema,
  type CrawlProgressView,
  type FinishedPage,
  type ListingPass,
  type RunCounts,
  type RunRecord,
} from '../../contracts/hydration.schema';
import type { StoreFailure, WriteHook } from '../../contracts/storage.schema';
import { CRAWL_REGION_LOCK_CLASS, CRAWL_TABLES } from './crawl-tables';
import { dedupeListing } from './plan';
import {
  FinishedPageRowSchema,
  IdRowSchema,
  LiveRunRowSchema,
  PassRowSchema,
  PassTileRowSchema,
  RunRowSchema,
} from './rows';
import { writeListingPage } from './save-listing';
import type {
  BeginRunInput,
  BeginRunValue,
  CurrentPass,
  FinishInput,
  FinishedPageRow,
  ListingStepInput,
  ListingStepValue,
  PassRow,
  PassState,
  RenewInput,
  RunRow,
} from './types';
import { validateListingInput } from './validate';
import { createWriter } from './writer';

const PASS_COLUMNS = [
  'region_name',
  'pass_number',
  'bbox_west',
  'bbox_south',
  'bbox_east',
  'bbox_north',
  'tile_width',
  'tile_height',
  'tile_count',
] as const;

const PAGE_COLUMNS = [
  'pass_number',
  'tile_number',
  'page_no',
  'run_id',
  'place_count',
  'is_short',
  'reported_total',
] as const;

const RUNS_OF_REGION_SQL =
  'select run_id, region_name, status,' +
  ' to_char(started_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as started_at_text,' +
  ' to_char(ended_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as ended_at_text,' +
  ' to_char(last_activity at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as last_activity_text,' +
  ' counts' +
  ' from crawl_runs where region_name = ? order by run_id';

const PASS_TILES_SQL =
  'select tile_number, max(page_no) as last_page, bool_or(is_short) as finished' +
  ' from crawl_finished_pages where region_name = ? and pass_number = ?' +
  ' group by tile_number order by tile_number';

const RunResultSchema = z.object({ rows: z.array(RunRowSchema) });
const PassTileResultSchema = z.object({ rows: z.array(PassTileRowSchema) });

function toFinishedPage(row: FinishedPageRow): FinishedPage {
  return {
    tileNumber: row.tile_number,
    page: row.page_no,
    runId: row.run_id,
    placeCount: row.place_count,
    short: row.is_short,
    ...(row.reported_total === null ? {} : { totalFound: row.reported_total }),
  };
}

function toListingPass(row: PassRow, pages: readonly FinishedPageRow[]): ListingPass {
  const own = pages.filter((p) => p.pass_number === row.pass_number);
  const finishedTiles = own
    .filter((p) => p.is_short)
    .map((p) => p.tile_number)
    .sort((a, b) => a - b);
  return {
    passNumber: row.pass_number,
    regionName: row.region_name,
    bbox: { west: row.bbox_west, south: row.bbox_south, east: row.bbox_east, north: row.bbox_north },
    tileSize: { width: row.tile_width, height: row.tile_height },
    tileCount: row.tile_count,
    complete: finishedTiles.length === row.tile_count,
    finishedTiles,
    finishedPages: own.map(toFinishedPage),
  };
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    regionName: row.region_name,
    status: row.status,
    startedAt: row.started_at_text,
    ...(row.ended_at_text === null ? {} : { endedAt: row.ended_at_text }),
    lastActivity: row.last_activity_text,
    counts: row.counts,
  };
}

/** Crawl Progress of one Region: passes and Run Records oldest first (AL4 1.4.11). */
export async function readProgressView(
  trx: Knex.Transaction,
  regionName: string,
): Promise<CrawlProgressView> {
  const passRows: unknown = await trx(CRAWL_TABLES.passes)
    .select(PASS_COLUMNS)
    .where('region_name', regionName)
    .orderBy('pass_number');
  const passes = z.array(PassRowSchema).parse(passRows);

  const pageRows: unknown = await trx(CRAWL_TABLES.finishedPages)
    .select(PAGE_COLUMNS)
    .where('region_name', regionName)
    .orderBy([
      { column: 'pass_number' },
      { column: 'tile_number' },
      { column: 'page_no' },
    ]);
  const pages = z.array(FinishedPageRowSchema).parse(pageRows);

  const runResult: unknown = await trx.raw(RUNS_OF_REGION_SQL, [regionName]);
  const runs = RunResultSchema.parse(runResult).rows;

  return {
    regionName,
    passes: passes.map((row) => toListingPass(row, pages)),
    runs: runs.map(toRunRecord),
  };
}

/**
 * The current (newest) Listing Pass of a Region and its PassState (AL4 1.4.6), or `undefined`
 * when the Region has no pass. Takes no row locks.
 */
export async function readCurrentPass(
  trx: Knex.Transaction,
  regionName: string,
): Promise<CurrentPass | undefined> {
  const passRows: unknown = await trx(CRAWL_TABLES.passes)
    .select(PASS_COLUMNS)
    .where('region_name', regionName)
    .orderBy('pass_number', 'desc')
    .limit(1);
  const row = z.array(PassRowSchema).parse(passRows)[0];
  if (row === undefined) return undefined;

  const tileResult: unknown = await trx.raw(PASS_TILES_SQL, [regionName, row.pass_number]);
  const tiles = PassTileResultSchema.parse(tileResult).rows;
  const state: PassState = {
    passNumber: row.pass_number,
    tileCount: row.tile_count,
    finishedTiles: tiles.filter((t) => t.finished).map((t) => t.tile_number),
    lastFinishedPage: tiles.map((t): [number, number] => [t.tile_number, t.last_page]),
  };
  return { row, state };
}

// ---------------------------------------------------------------------------
// Write steps of a Run
// ---------------------------------------------------------------------------

const REGION_LOCK_SQL = 'select pg_advisory_xact_lock(?::int4, hashtext(?))';

const LIVE_RUNS_SQL =
  'select run_id,' +
  ' to_char(last_activity at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as last_activity_text' +
  " from crawl_runs where region_name = ? and status = 'in_progress'" +
  ' order by run_id for update';

const NEXT_RUN_ID_SQL = "select nextval(pg_get_serial_sequence('crawl_runs', 'run_id')) as id";

const JSONB_SQL = '?::jsonb';

const LiveRunResultSchema = z.object({ rows: z.array(LiveRunRowSchema) });
const IdResultSchema = z.object({ rows: z.array(IdRowSchema) });

/** A listing that fails validation; carries the `invalid_data` failure for the repository. */
export class InvalidListingError extends Error {
  readonly failure: StoreFailure;

  constructor(failure: StoreFailure) {
    super('listing page failed validation');
    this.name = 'InvalidListingError';
    this.failure = failure;
  }
}

/** Counts checked with `RunCountsSchema` (throws before any database access), as JSON text. */
function countsText(counts: RunCounts): string {
  return JSON.stringify(RunCountsSchema.parse(counts));
}

function within(a: number, b: number): boolean {
  return Math.abs(a - b) <= COORDINATE_TOLERANCE;
}

function sameDefinition(row: PassRow, input: BeginRunInput): boolean {
  return (
    within(row.bbox_west, input.bbox.west) &&
    within(row.bbox_south, input.bbox.south) &&
    within(row.bbox_east, input.bbox.east) &&
    within(row.bbox_north, input.bbox.north) &&
    within(row.tile_width, input.tileSize.width) &&
    within(row.tile_height, input.tileSize.height) &&
    row.tile_count === input.tileCount
  );
}

function isComplete(current: CurrentPass): boolean {
  return current.state.finishedTiles.length === current.row.tile_count;
}

/** Locks the Run row while it is in progress; `false` when it is not (taken over or unknown). */
async function lockLiveRun(trx: Knex.Transaction, runId: number): Promise<boolean> {
  const rows: unknown = await trx(CRAWL_TABLES.runs)
    .select({ id: 'run_id' })
    .where({ run_id: runId, status: 'in_progress' })
    .forUpdate();
  return z.array(IdRowSchema).parse(rows).length > 0;
}

/** Run start (AL4 1.4.5): one live Run per Region, abandonment, the Run Record and the pass. */
export async function beginRunStep(
  db: Knex,
  input: BeginRunInput,
  onWrite: WriteHook | undefined,
): Promise<BeginRunValue> {
  const counts = countsText(input.counts);
  return db.transaction(async (trx): Promise<BeginRunValue> => {
    await trx.raw(REGION_LOCK_SQL, [CRAWL_REGION_LOCK_CLASS, input.regionName]);

    const liveResult: unknown = await trx.raw(LIVE_RUNS_SQL, [input.regionName]);
    const live = LiveRunResultSchema.parse(liveResult).rows;
    const abandonBeforeMs = Date.parse(input.abandonBefore);
    const alive = live.find((row) => Date.parse(row.last_activity_text) >= abandonBeforeMs);
    if (alive !== undefined) {
      return { kind: 'run_in_progress', runId: alive.run_id, lastActivity: alive.last_activity_text };
    }

    const current = await readCurrentPass(trx, input.regionName);
    if (
      !input.relist &&
      current !== undefined &&
      !isComplete(current) &&
      !sameDefinition(current.row, input)
    ) {
      return { kind: 'region_changed', passNumber: current.row.pass_number };
    }

    const writer = createWriter(onWrite);
    for (const row of live) {
      await writer.run(
        trx(CRAWL_TABLES.runs).where('run_id', row.run_id).update({ status: 'abandoned' }),
      );
    }

    const idResult: unknown = await trx.raw(NEXT_RUN_ID_SQL);
    const idRow = IdResultSchema.parse(idResult).rows[0];
    if (idRow === undefined) throw new Error('nextval returned no row');
    const runId = idRow.id;

    await writer.run(
      trx(CRAWL_TABLES.runs).insert({
        run_id: runId,
        region_name: input.regionName,
        status: 'in_progress',
        started_at: input.startedAt,
        last_activity: input.startedAt,
        counts: trx.raw(JSONB_SQL, [counts]),
      }),
    );

    const abandonedRunIds = live.map((row) => row.run_id);
    if (input.relist || current === undefined) {
      const passNumber = (current?.row.pass_number ?? 0) + 1;
      await writer.run(
        trx(CRAWL_TABLES.passes).insert({
          region_name: input.regionName,
          pass_number: passNumber,
          bbox_west: input.bbox.west,
          bbox_south: input.bbox.south,
          bbox_east: input.bbox.east,
          bbox_north: input.bbox.north,
          tile_width: input.tileSize.width,
          tile_height: input.tileSize.height,
          tile_count: input.tileCount,
          started_by_run_id: runId,
          started_at: input.startedAt,
        }),
      );
      const pass: PassState = {
        passNumber,
        tileCount: input.tileCount,
        finishedTiles: [],
        lastFinishedPage: [],
      };
      return { kind: 'started', runId, pass, abandonedRunIds };
    }
    return {
      kind: 'started',
      runId,
      ...(isComplete(current) ? {} : { pass: current.state }),
      abandonedRunIds,
    };
  });
}

/** Last Activity renewal (AL4 1.5): one update of `last_activity` and `counts` while live. */
export async function renewActivityStep(
  db: Knex,
  input: RenewInput,
  onWrite: WriteHook | undefined,
): Promise<{ alive: boolean }> {
  const counts = countsText(input.counts);
  return db.transaction(async (trx) => {
    if (!(await lockLiveRun(trx, input.runId))) return { alive: false };
    const writer = createWriter(onWrite);
    await writer.run(
      trx(CRAWL_TABLES.runs)
        .where('run_id', input.runId)
        .update({ last_activity: input.at, counts: trx.raw(JSONB_SQL, [counts]) }),
    );
    return { alive: true };
  });
}

/**
 * Listing step (AL4 1.4.6): the page's Listing Save and its Finished Page in one transaction.
 * An invalid listing throws `InvalidListingError` before any database access.
 */
export async function listingPageStep(
  db: Knex,
  input: ListingStepInput,
  onWrite: WriteHook | undefined,
): Promise<ListingStepValue> {
  const validated = validateListingInput(input.listing);
  if (!validated.ok) throw new InvalidListingError(validated.failure);
  const v = validated.value;
  return db.transaction(async (trx): Promise<ListingStepValue> => {
    if (!(await lockLiveRun(trx, input.runId))) return { kind: 'taken_over' };
    const writer = createWriter(onWrite);
    const places = dedupeListing(v.places);
    const report =
      places.length === 0 ? { places: [] } : await writeListingPage(trx, places, writer);
    await writer.run(
      trx(CRAWL_TABLES.finishedPages).insert({
        region_name: input.regionName,
        pass_number: input.passNumber,
        tile_number: input.tileNumber,
        page_no: input.page,
        run_id: input.runId,
        place_count: v.places.length,
        is_short: input.short,
        reported_total: v.totalFound,
        finished_at: input.finishedAt,
      }),
    );
    return { kind: 'saved', report };
  });
}

/** Run finish (AL4 1.4.8): status, `ended_at`, `last_activity = ended_at` and counts while live. */
export async function finishRunStep(
  db: Knex,
  input: FinishInput,
  onWrite: WriteHook | undefined,
): Promise<{ updated: boolean }> {
  const counts = countsText(input.counts);
  return db.transaction(async (trx) => {
    if (!(await lockLiveRun(trx, input.runId))) return { updated: false };
    const writer = createWriter(onWrite);
    await writer.run(
      trx(CRAWL_TABLES.runs)
        .where('run_id', input.runId)
        .update({
          status: input.status,
          ended_at: input.endedAt,
          last_activity: input.endedAt,
          counts: trx.raw(JSONB_SQL, [counts]),
        }),
    );
    return { updated: true };
  });
}
