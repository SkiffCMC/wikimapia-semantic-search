/**
 * Parking (AL4 crawl-run1-fixes 1.4.5, 1.4.6, 1.5, 2.4): loads the Parking inputs of the Places
 * of a bbox or of one Place, decides the Parked Places with the contract functions only
 * (`countResetOf` + `parkingKindOf`), and writes the releases of an Explicit Retry inside a
 * given transaction.
 *
 * The rule itself never appears here: SQL only loads every Failure Record about a Place in scope
 * together with the Place's Count Reset inputs (its Details Fetched At and its latest release).
 * Every value is a binding, every SQL text is built from constants, and every row is parsed with
 * its row schema. Append-only: nothing here updates or deletes.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  countResetOf,
  parkingKindOf,
  type FailureRecord,
} from '../../contracts/crawl-run1-fixes.schema';
import { CRAWL_TABLES } from './crawl-tables';
import { ParkingRowSchema } from './rows';
import type { ParkedPlace, ParkingRow, ParkingScope, ReleaseInput, Writer } from './types';

const ParkingResultSchema = z.object({ rows: z.array(ParkingRowSchema) });

const SELECT_PARKING_SQL =
  'select f.run_id, f.place_id, f.failure_kind, f.message,' +
  ' to_char(f.failed_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as failed_at_text,' +
  ' to_char(p.details_fetched_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as details_fetched_at_text,' +
  ' to_char(r.released_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as released_at_text' +
  ' from ' +
  CRAWL_TABLES.itemFailures +
  ' f' +
  ' join places p on p.place_id = f.place_id' +
  ' left join lateral (select max(released_at) as released_at from ' +
  CRAWL_TABLES.placeReleases +
  ' where place_id = f.place_id) r on true' +
  ' where f.place_id is not null';

/** The R1 Centre Point filter of `places-due.ts` on `p`: GIST envelope plus inclusive bbox. */
const BBOX_SCOPE_SQL =
  ' and p.centre_point && ST_MakeEnvelope(?, ?, ?, ?, 4326)' +
  ' and p.location_lon between ? and ? and p.location_lat between ? and ?';

const PLACE_SCOPE_SQL = ' and f.place_id = ?';

const ORDER_SQL = ' order by f.place_id, f.failed_at, f.failure_id';

function scopeOf(scope: ParkingScope): { sql: string; bindings: number[] } {
  if ('placeId' in scope) return { sql: PLACE_SCOPE_SQL, bindings: [scope.placeId] };
  const { west, south, east, north } = scope.bbox;
  return { sql: BBOX_SCOPE_SQL, bindings: [west, south, east, north, west, east, south, north] };
}

/** Every Failure Record about a Place in scope with its Count Reset inputs, per Place oldest first. */
export async function selectParkingRows(
  db: Knex | Knex.Transaction,
  scope: ParkingScope,
): Promise<ParkingRow[]> {
  const { sql, bindings } = scopeOf(scope);
  const result: unknown = await db.raw(SELECT_PARKING_SQL + sql + ORDER_SQL, bindings);
  return ParkingResultSchema.parse(result).rows;
}

function toFailureRecord(row: ParkingRow): FailureRecord {
  return {
    runId: row.run_id,
    item: { kind: 'place_details', placeId: row.place_id },
    failureKind: row.failure_kind,
    message: row.message,
    failedAt: row.failed_at_text,
  };
}

/** Pure: the Parked Places among the rows, ascending `placeId`, decided by the contract rule. */
export function parkedPlacesFrom(rows: readonly ParkingRow[]): ParkedPlace[] {
  const byPlace = new Map<number, ParkingRow[]>();
  for (const row of rows) {
    const group = byPlace.get(row.place_id);
    if (group === undefined) byPlace.set(row.place_id, [row]);
    else group.push(row);
  }
  const parked: ParkedPlace[] = [];
  const placeIds = [...byPlace.keys()].sort((a, b) => a - b);
  for (const placeId of placeIds) {
    const group = byPlace.get(placeId) ?? [];
    const first = group[0];
    if (first === undefined) continue;
    const reset = countResetOf({
      ...(first.details_fetched_at_text === null
        ? {}
        : { lastDetailsSaveAt: first.details_fetched_at_text }),
      ...(first.released_at_text === null ? {} : { lastExplicitRetryAt: first.released_at_text }),
    });
    const failureKind = parkingKindOf(group.map(toFailureRecord), placeId, reset);
    if (failureKind !== undefined) parked.push({ placeId, failureKind });
  }
  return parked;
}

/** The Parked Places in scope, ascending `placeId`. */
export async function selectParkedPlaces(
  db: Knex | Knex.Transaction,
  scope: ParkingScope,
): Promise<ParkedPlace[]> {
  return parkedPlacesFrom(await selectParkingRows(db, scope));
}

/**
 * Explicit Retry (AL4 1.4.5): one retry row, then one release row per Parked Place of the bbox
 * (ascending), all through the caller's Writer and transaction. Returns the number released.
 */
export async function releaseParkedPlaces(
  trx: Knex.Transaction,
  writer: Writer,
  input: ReleaseInput,
): Promise<number> {
  const parked = await selectParkedPlaces(trx, { bbox: input.bbox });
  await writer.run(
    trx(CRAWL_TABLES.explicitRetries).insert({
      run_id: input.runId,
      region_name: input.regionName,
      retried_at: input.at,
      places_released: parked.length,
    }),
  );
  if (parked.length > 0) {
    await writer.run(
      trx(CRAWL_TABLES.placeReleases).insert(
        parked.map((place) => ({
          run_id: input.runId,
          place_id: place.placeId,
          released_at: input.at,
        })),
      ),
    );
  }
  return parked.length;
}
