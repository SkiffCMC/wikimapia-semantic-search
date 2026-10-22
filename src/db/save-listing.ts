/**
 * Listing Save (AL4 1.4.5, 1.5 "Listing Save"; AC-7 .. AC-15, AC-63, D1, D6). One READ COMMITTED
 * transaction per page: advisory locks for every distinct place id in ascending numeric order,
 * the stored state, the pure plan, then one statement per planned write through the Writer.
 * Any DB or hook error propagates (the transaction rolls back); errors are neither caught nor
 * mapped here.
 */
import type { Knex } from 'knex';
import type { SaveListingPageInput, SaveReport, WriteHook } from '../../contracts/storage.schema';
import { centrePointSql, outlineShapeSql } from './geometry';
import { summaryColumns } from './mappers';
import { PlaceModel } from './models';
import { dedupeListing, planListingSave } from './plan';
import { loadListingState } from './read';
import { createWriter } from './writer';
import type { ListingWrite, Writer } from './types';

/** Runs the one statement of a planned listing write through the Writer. */
async function runListingWrite(
  writer: Writer,
  trx: Knex.Transaction,
  write: ListingWrite,
): Promise<void> {
  switch (write.kind) {
    case 'insert_summary': {
      const s = write.summary;
      await writer.run(
        PlaceModel.query(trx).insert({
          place_id: s.placeId,
          ...summaryColumns(s),
          centre_point: centrePointSql(trx, s.location),
          outline_shape: outlineShapeSql(trx, s.outline),
        }),
      );
      return;
    }
    case 'update_summary': {
      const s = write.summary;
      await writer.run(
        PlaceModel.query(trx)
          .findById(s.placeId)
          .patch({
            ...summaryColumns(s),
            centre_point: centrePointSql(trx, s.location),
            outline_shape: outlineShapeSql(trx, s.outline),
          }),
      );
      return;
    }
    case 'update_link':
      await writer.run(
        PlaceModel.query(trx).findById(write.placeId).patch({ wikimapia_url: write.url }),
      );
      return;
  }
}

export async function saveListing(
  db: Knex,
  page: SaveListingPageInput,
  onWrite: WriteHook | undefined,
): Promise<SaveReport> {
  const places = dedupeListing(page.places);
  if (places.length === 0) return { places: [] };
  return db.transaction(async (trx) => {
    const ids = [...new Set(places.map((p) => p.placeId))].sort((a, b) => a - b);
    for (const id of ids) {
      await trx.raw('select pg_advisory_xact_lock(?::bigint)', [id]);
    }
    const state = await loadListingState(trx, ids);
    const plan = planListingSave(places, state);
    const writer = createWriter(onWrite);
    for (const write of plan.writes) {
      await runListingWrite(writer, trx, write);
    }
    return { places: plan.outcomes };
  });
}
