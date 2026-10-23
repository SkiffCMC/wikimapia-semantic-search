/**
 * Details Phase (AL4 1.1 row `details-phase.ts`, 1.3 `runDetailsPhase`, 1.4.7; U6): fetches Place
 * Details for the Places Due for Details of the Region, in Details Order, limited to what the
 * remaining Request Budget can reach (+1 so an exhausted budget is still detected). Details
 * Fetched At is the receive moment. The store leaves Parked Places out of the due list; the
 * Parked count at the start is reported (crawl-run1-fixes 1.2). Item Failures are concluded
 * through `concludeItemFailure` (1.4.4). No SQL; only store failures' and the Client's own
 * messages are passed on.
 */
import { toMoment } from '../../contracts/hydration.schema';
import { concludeItemFailure } from './failures';
import { requestWithBackoff } from './requests';
import type { DetailsPhaseResult, RunContext } from './types';

const NOTHING_LOADED: DetailsPhaseResult = { dueLoaded: 0, parkedAtStart: 0 };

export async function runDetailsPhase(ctx: RunContext): Promise<DetailsPhaseResult> {
  const { gateway, client, repo, tally, run } = ctx;
  const limit = Math.max(1, run.configuration.requestBudget - gateway.requestsSent + 1);
  const listed = await repo.listPlacesDue({
    bbox: run.region.bbox,
    dueBefore: ctx.dueBefore,
    limit,
  });
  if (!listed.ok) {
    gateway.stop('failed', listed.failure.message);
    return NOTHING_LOADED;
  }
  const due = listed.value;
  const parked = await repo.listParkedPlaces({ bbox: run.region.bbox });
  if (!parked.ok) {
    gateway.stop('failed', parked.failure.message);
    return NOTHING_LOADED;
  }
  const parkedAtStart = parked.value.length;
  ctx.parkedAtDetailsStart = parkedAtStart;

  for (const place of due) {
    if (gateway.stopped !== undefined) break;
    const placeId = place.placeId;
    const r = await requestWithBackoff(gateway, 'details', ctx.signal, () =>
      client.getPlaceDetails({ placeId }),
    );
    if (r.kind === 'stopped') break;
    if (r.kind === 'item_failure') {
      const message = `Place ${String(placeId)}: ${r.message}`;
      const item = { kind: 'place_details', placeId } as const;
      if (await concludeItemFailure(ctx, item, r.failureKind, message)) continue;
      break;
    }

    const fetchedAt = toMoment(ctx.clock.now());
    const s = await repo.saveDetails({ details: r.value, fetchedAt });
    if (!s.ok) {
      if (s.failure.kind === 'invalid_data') {
        const message = `Place ${String(placeId)}: the Place Store rejected the details: ${s.failure.message}`;
        const item = { kind: 'place_details', placeId } as const;
        if (await concludeItemFailure(ctx, item, 'invalid_data', message)) continue;
        break;
      }
      gateway.stop('failed', s.failure.message);
      break;
    }
    const outcome = s.value.places[0]?.outcome ?? 'unchanged';
    tally.detailsSaved(outcome === 'created' || outcome === 'updated');
    ctx.progress(`Place ${String(placeId)}: details saved (${outcome})`);
  }

  return { dueLoaded: due.length, parkedAtStart };
}
