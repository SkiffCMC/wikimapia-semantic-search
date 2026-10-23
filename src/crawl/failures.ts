/**
 * Concluding an Item Failure (AL4 crawl-run1-fixes 1.1 row `failures.ts`, 1.4.4; U6): keeps the
 * Failure Record first, then tallies and prints the Item Failure, and reports a Place the store
 * found Parked after this record. Parking is never decided here: the store's `parked` flag is the
 * only source. Only the repository's own (sanitized) failure message is passed on. No SQL.
 */
import { PARKING_THRESHOLD } from '../../contracts/crawl-run1-fixes.schema';
import {
  ITEM_FAILURE_LABELS,
  toMoment,
  type FailedItem,
  type ItemFailureKind,
} from '../../contracts/hydration.schema';
import type { RunContext } from './types';

export function takenOverMessage(regionName: string): string {
  return `This Run for region "${regionName}" was taken over by a newer Run.`;
}

/** `true`: the Item Failure is recorded and tallied; `false`: the Run stopped (Failed). */
export async function concludeItemFailure(
  ctx: RunContext,
  item: FailedItem,
  failureKind: ItemFailureKind,
  message: string,
): Promise<boolean> {
  const failedAt = toMoment(ctx.clock.now());
  const r = await ctx.repo.recordItemFailure({
    runId: ctx.runId,
    item,
    failureKind,
    message,
    failedAt,
  });
  if (!r.ok) {
    ctx.gateway.stop('failed', r.failure.message);
    return false;
  }
  if (r.value.kind === 'taken_over') {
    ctx.gateway.stop('failed', takenOverMessage(ctx.run.regionName));
    return false;
  }

  ctx.tally.itemFailure(item, failureKind, message);
  ctx.progress(`Item failure: ${message}`);
  const parked = r.value.parked;
  if (parked !== undefined) {
    ctx.tally.placeParked();
    ctx.progress(
      `Place ${String(parked.placeId)}: parked after ${String(PARKING_THRESHOLD)} failures (${ITEM_FAILURE_LABELS[parked.failureKind]})`,
    );
  }
  return true;
}
