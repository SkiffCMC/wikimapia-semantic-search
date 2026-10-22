/**
 * Details Phase (AL4 1.1 row `details-phase.ts`, 1.3 `runDetailsPhase`, 1.4.7; U6): fetches Place
 * Details for the Places Due for Details of the Region, in Details Order, limited to what the
 * remaining Request Budget can reach (+1 so an exhausted budget is still detected). Details
 * Fetched At is the receive moment. No SQL; only store failures' and the Client's own messages
 * are passed on.
 */
import { toMoment } from '../../contracts/hydration.schema';
import { requestWithBackoff } from './requests';
import type { RunContext } from './types';

export async function runDetailsPhase(ctx: RunContext): Promise<{ dueLoaded: number }> {
  const { gateway, client, repo, tally, run } = ctx;
  const limit = Math.max(1, run.configuration.requestBudget - gateway.requestsSent + 1);
  const listed = await repo.listPlacesDue({
    bbox: run.region.bbox,
    dueBefore: ctx.dueBefore,
    limit,
  });
  if (!listed.ok) {
    gateway.stop('failed', listed.failure.message);
    return { dueLoaded: 0 };
  }
  const due = listed.value;

  for (const place of due) {
    if (gateway.stopped !== undefined) break;
    const placeId = place.placeId;
    const r = await requestWithBackoff(gateway, 'details', ctx.signal, () =>
      client.getPlaceDetails({ placeId }),
    );
    if (r.kind === 'stopped') break;
    if (r.kind === 'item_failure') {
      const message = `Place ${String(placeId)}: ${r.message}`;
      tally.itemFailure({ kind: 'place_details', placeId }, r.failureKind, message);
      ctx.progress(`Item failure: ${message}`);
      continue;
    }

    const fetchedAt = toMoment(ctx.clock.now());
    const s = await repo.saveDetails({ details: r.value, fetchedAt });
    if (!s.ok) {
      if (s.failure.kind === 'invalid_data') {
        const message = `Place ${String(placeId)}: the Place Store rejected the details: ${s.failure.message}`;
        tally.itemFailure({ kind: 'place_details', placeId }, 'invalid_data', message);
        ctx.progress(`Item failure: ${message}`);
        continue;
      }
      gateway.stop('failed', s.failure.message);
      break;
    }
    const outcome = s.value.places[0]?.outcome ?? 'unchanged';
    tally.detailsSaved(outcome === 'created' || outcome === 'updated');
    ctx.progress(`Place ${String(placeId)}: details saved (${outcome})`);
  }

  return { dueLoaded: due.length };
}
