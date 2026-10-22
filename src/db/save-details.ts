/**
 * Details Save (AL4 1.4.6, 1.5 "Details Save"; AC-16 .. AC-37, AC-40 .. AC-43, AC-64 .. AC-72,
 * D1 .. D6). One READ COMMITTED transaction per place: the place's advisory lock, the stored
 * state, the pure plan, then one statement per planned write through the Writer, in the fixed
 * order place, tags, links, comments. Any DB or hook error propagates (the transaction rolls
 * back); errors are neither caught nor mapped here.
 */
import type { Knex } from 'knex';
import { STORE_TABLES } from '../../contracts/storage.schema';
import type { SavePlaceDetailsInput, SaveReport, WriteHook } from '../../contracts/storage.schema';
import { centrePointSql, outlineShapeSql } from './geometry';
import { commentColumns, commentPatchColumns, detailsColumns } from './mappers';
import { CommentModel, PlaceModel, PlaceTagModel } from './models';
import { planDetailsSave } from './plan';
import { loadDetailsState } from './read';
import { createWriter } from './writer';
import type { PlaceDetailsWrite, Writer } from './types';

/** Runs the one statement of the planned place-row write through the Writer. */
async function runPlaceWrite(
  writer: Writer,
  trx: Knex.Transaction,
  input: SavePlaceDetailsInput,
  write: PlaceDetailsWrite,
): Promise<void> {
  const { details, fetchedAt } = input;
  switch (write.kind) {
    case 'insert':
      await writer.run(
        PlaceModel.query(trx).insert({
          place_id: details.placeId,
          wikimapia_url: write.wikimapiaUrl,
          ...detailsColumns(details, fetchedAt),
          centre_point: centrePointSql(trx, details.location),
          outline_shape: outlineShapeSql(trx, details.outline),
        }),
      );
      return;
    case 'update_details':
      await writer.run(
        PlaceModel.query(trx)
          .findById(details.placeId)
          .patch({
            ...detailsColumns(details, fetchedAt),
            centre_point: centrePointSql(trx, details.location),
            outline_shape: outlineShapeSql(trx, details.outline),
          }),
      );
      return;
    case 'update_fetched_at':
      // Writes only this one column, with the ISO text `fetchedAt`; the Knex builder is unchanged from U7.
      await writer.run(
        trx(STORE_TABLES.places)
          .where('place_id', details.placeId)
          .update({ details_fetched_at: fetchedAt }),
      );
      return;
  }
}

export async function saveDetails(
  db: Knex,
  input: SavePlaceDetailsInput,
  onWrite: WriteHook | undefined,
): Promise<SaveReport> {
  const placeId = input.details.placeId;
  return db.transaction(async (trx) => {
    await trx.raw('select pg_advisory_xact_lock(?::bigint)', [placeId]);
    const state = await loadDetailsState(trx, input.details);
    const plan = planDetailsSave(input, state);
    const writer = createWriter(onWrite);

    // 1. Place row.
    if (plan.place !== undefined) {
      await runPlaceWrite(writer, trx, input, plan.place);
    }

    // 2. Tag catalogue (before any link insert: the FK to tags is not deferrable).
    for (const tag of plan.tagUpserts) {
      await writer.run(
        trx(STORE_TABLES.tags)
          .insert({ tag_id: tag.id, title: tag.title })
          .onConflict('tag_id')
          .merge(['title']),
      );
    }

    // 3. Links: present ones in input order, then gone ones.
    for (const link of plan.linkWrites) {
      if (link.kind === 'insert') {
        await writer.run(
          PlaceTagModel.query(trx).insert({
            place_id: placeId,
            tag_id: link.tagId,
            presence: 'present',
            position: link.position,
          }),
        );
      } else {
        await writer.run(
          PlaceTagModel.query(trx)
            .findById([placeId, link.tagId])
            .patch({ presence: 'present', position: link.position }),
        );
      }
    }
    for (const tagId of plan.goneLinks) {
      await writer.run(
        PlaceTagModel.query(trx)
          .findById([placeId, tagId])
          .patch({ presence: 'gone', position: null }),
      );
    }

    // 4. Comments: present ones in pre-order, then gone ones (values and parent_num kept).
    for (const write of plan.commentWrites) {
      if (write.kind === 'insert') {
        await writer.run(CommentModel.query(trx).insert(commentColumns(placeId, write.flat)));
      } else {
        await writer.run(
          CommentModel.query(trx)
            .findById([placeId, write.flat.comment.num])
            .patch(commentPatchColumns(write.flat)),
        );
      }
    }
    for (const num of plan.goneComments) {
      await writer.run(
        CommentModel.query(trx)
          .findById([placeId, num])
          .patch({ presence: 'gone', position: null }),
      );
    }

    return { places: [{ placeId, outcome: plan.outcome }] };
  });
}
