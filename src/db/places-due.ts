/**
 * Places Due for Details (AL4 hydration 1.4.7, R1, AC-30 .. AC-34): the Places of a bbox
 * (Centre Point inside, edges included) that are Summary-Only or whose Details Fetched At is
 * strictly earlier than `dueBefore`, in Details Order, and their count. One parameterized
 * statement each; the SQL text is built from constant fragments only. Callers validate the
 * input; the order comes from SQL.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import type { DuePlace, PlacesDueInput } from '../../contracts/hydration.schema';
import { CountRowSchema, DuePlaceRowSchema } from './rows';
import type { DuePlaceRow, DueQuery } from './types';

const DuePlaceResultSchema = z.object({ rows: z.array(DuePlaceRowSchema) });
const CountResultSchema = z.object({ rows: z.array(CountRowSchema) });

/** Shared filter: GIST envelope prefilter, exact inclusive bbox, cutoff (exclusive). */
const DUE_FILTER_SQL =
  ' from places' +
  ' where centre_point && ST_MakeEnvelope(?, ?, ?, ?, 4326)' +
  ' and location_lon between ? and ? and location_lat between ? and ?' +
  ' and (details_fetched_at is null or details_fetched_at < ?::timestamptz)';

const SELECT_DUE_SQL =
  'select place_id,' +
  ' to_char(details_fetched_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as details_fetched_at_text' +
  DUE_FILTER_SQL +
  ' order by (details_fetched_at is not null), details_fetched_at, place_id';

const LIMIT_SQL = ' limit ?';

const COUNT_DUE_SQL = 'select count(*) as count' + DUE_FILTER_SQL;

function filterBindings(input: PlacesDueInput): (string | number)[] {
  const { west, south, east, north } = input.bbox;
  return [west, south, east, north, west, east, south, north, input.dueBefore];
}

function toDuePlace(row: DuePlaceRow): DuePlace {
  return {
    placeId: row.place_id,
    ...(row.details_fetched_at_text === null ? {} : { detailsFetchedAt: row.details_fetched_at_text }),
  };
}

export async function selectPlacesDue(
  db: Knex | Knex.Transaction,
  query: DueQuery,
): Promise<DuePlace[]> {
  const bindings = filterBindings(query);
  const sql = query.limit === undefined ? SELECT_DUE_SQL : SELECT_DUE_SQL + LIMIT_SQL;
  if (query.limit !== undefined) bindings.push(query.limit);
  const result: unknown = await db.raw(sql, bindings);
  return DuePlaceResultSchema.parse(result).rows.map(toDuePlace);
}

export async function countPlacesDue(
  db: Knex | Knex.Transaction,
  input: PlacesDueInput,
): Promise<number> {
  const result: unknown = await db.raw(COUNT_DUE_SQL, filterBindings(input));
  const row = CountResultSchema.parse(result).rows[0];
  if (row === undefined) throw new Error('count of places due returned no row');
  return row.count;
}
