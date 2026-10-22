/**
 * Listing Phase (AL4 1.1 row `listing-phase.ts`, 1.3 `runListingPhase`, 1.4.6; U6): walks the
 * unfinished Tiles of the current Listing Pass in Tile Number order, one `box` page at a time
 * until a Short Page, and records every page through the atomic listing step (Listing Save +
 * Finished Page). No SQL; only store failures' and the Client's own messages are passed on.
 */
import { toMoment } from '../../contracts/hydration.schema';
import { requestWithBackoff } from './requests';
import type { PassCursor, RunContext } from './types';

export function takenOverMessage(regionName: string): string {
  return `This Run for region "${regionName}" was taken over by a newer Run.`;
}

export async function runListingPhase(ctx: RunContext, pass: PassCursor): Promise<void> {
  const { gateway, client, repo, tally, run } = ctx;
  const pageSize = run.configuration.listingPageSize;

  for (const tile of run.plan.tiles) {
    const n = tile.tileNumber;
    if (pass.finishedTiles.has(n)) continue;
    let page = (pass.lastFinishedPage.get(n) ?? 0) + 1;

    for (;;) {
      if (gateway.stopped !== undefined) return;
      const requestedPage = page;
      const r = await requestWithBackoff(gateway, 'listing', ctx.signal, () =>
        client.listPlaces({ bbox: tile.bbox, page: requestedPage, pageSize }),
      );
      if (r.kind === 'stopped') return;
      if (r.kind === 'item_failure') {
        const message = `Tile ${String(n)} page ${String(page)}: ${r.message}`;
        tally.itemFailure({ kind: 'listing_page', tileNumber: n, page }, r.failureKind, message);
        ctx.progress(`Item failure: ${message}`);
        break;
      }

      const listing = r.value;
      const short = listing.places.length < pageSize;
      const s = await repo.recordListingPage({
        runId: ctx.runId,
        regionName: run.regionName,
        passNumber: pass.passNumber,
        tileNumber: n,
        page,
        listing,
        short,
        finishedAt: toMoment(ctx.clock.now()),
      });
      if (!s.ok) {
        if (s.failure.kind === 'invalid_data') {
          const message = `Tile ${String(n)} page ${String(page)}: the Place Store rejected the page: ${s.failure.message}`;
          tally.itemFailure({ kind: 'listing_page', tileNumber: n, page }, 'invalid_data', message);
          ctx.progress(`Item failure: ${message}`);
          break;
        }
        gateway.stop('failed', s.failure.message);
        return;
      }
      if (s.value.kind === 'taken_over') {
        gateway.stop('failed', takenOverMessage(run.regionName));
        return;
      }

      const report = s.value.report;
      const created = report.places.filter((p) => p.outcome === 'created').length;
      tally.pageSaved(
        listing.places.map((p) => p.placeId),
        created,
        short,
      );
      pass.lastFinishedPage.set(n, page);
      ctx.progress(
        `Tile ${String(n)} page ${String(page)}: ${String(listing.places.length)} places saved${short ? ', tile finished' : ''}`,
      );
      if (short) {
        pass.finishedTiles.add(n);
        break;
      }
      page += 1;
    }
  }
}
