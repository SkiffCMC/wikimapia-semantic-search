/**
 * AL2 unit tests: the Crawl Repository (`src/db/crawl-repository.ts`, `crawl-progress.ts`; AL4
 * hydration 1.4.5 .. 1.4.9, 1.5) against the Test Database. The contract tests drive it through
 * `runCrawl`; here only the branches a Run never takes: an invalid listing, steps of a Run that
 * is not live, a deduplicated page, a due list without a limit and invalid details input.
 */
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import type { CrawlRepository, ListingStepInput } from '../../src/db/types';
import { ZERO_RUN_COUNTS } from '../../contracts/hydration.schema';
import { RUN_START, SMALL_BBOX, at } from '../../contracts/hydration.support';
import type { ListingPage } from '../../contracts/wikimapia-client.schema';
import {
  clientDetails,
  clientListing,
  listingOf,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';

const url = requireTestDatabaseUrl();
const setup = createSchemaSetup({ connectionString: url });
const placeStore = createPlaceStore({ connectionString: url });
let repo: CrawlRepository;

beforeAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
  repo = openCrawlRepository({ connectionString: url });
});

afterAll(async () => {
  await Promise.all([repo.close(), placeStore.close(), setup.close()]);
});

/** Empties the store and starts Run 1 of `test-one` with pass 1. */
async function startRun(): Promise<number> {
  expect((await setup.emptyStore()).ok).toBe(true);
  const begun = await repo.beginRun({
    regionName: 'test-one',
    bbox: SMALL_BBOX,
    tileSize: { width: 0.005, height: 0.005 },
    tileCount: 1,
    relist: false,
    startedAt: RUN_START,
    abandonBefore: '2026-10-22T08:00:00Z',
    counts: ZERO_RUN_COUNTS,
    retryParked: false,
  });
  if (!begun.ok || begun.value.kind !== 'started') throw new Error('expected a started Run');
  return begun.value.runId;
}

function pageInput(runId: number, listing: ListingPage): ListingStepInput {
  return {
    runId,
    regionName: 'test-one',
    passNumber: 1,
    tileNumber: 1,
    page: 1,
    listing,
    short: true,
    finishedAt: '2026-10-22T09:00:10Z',
  };
}

describe('recordListingPage', () => {
  it.each([
    [
      'an invalid listing is invalid_data',
      0,
      { pageSize: 0 },
      { ok: false, failure: { kind: 'invalid_data' } },
    ],
    ['an unknown Run is taken_over', 1000, {}, { ok: true, value: { kind: 'taken_over' } }],
  ])('%s and writes nothing', async (_case, runOffset, spoil, expected) => {
    const runId = await startRun();
    const listing = await clientListing('box-belgrade-page1.json');
    const placeId = at(listing.places, 0).placeId;
    expect(
      await repo.recordListingPage(pageInput(runId + runOffset, { ...listing, ...spoil })),
    ).toMatchObject(expected);
    expect(await placeStore.readPlace({ placeId })).toStrictEqual({
      ok: true,
      value: { found: false, placeId },
    });
  });

  it('stores a page with a repeated Place ID once; listPlacesDue without a limit lists it', async () => {
    const runId = await startRun();
    const first = at((await clientListing('box-belgrade-page1.json')).places, 0);
    const saved = await repo.recordListingPage(
      pageInput(runId, listingOf(first, { ...first, name: 'Renamed' })),
    );
    expect(saved).toMatchObject({ ok: true, value: { kind: 'saved' } });
    expect(
      await repo.listPlacesDue({ bbox: SMALL_BBOX, dueBefore: '2026-10-22T09:01:00Z' }),
    ).toStrictEqual({ ok: true, value: [{ placeId: first.placeId }] });
  });
});

describe('a Run that is not live', () => {
  it('renewActivity of an unknown Run answers alive: false', async () => {
    const runId = await startRun();
    expect(
      await repo.renewActivity({ runId: runId + 1000, at: RUN_START, counts: ZERO_RUN_COUNTS }),
    ).toStrictEqual({ ok: true, value: { alive: false } });
  });
});

describe('saveDetails', () => {
  it('details with an invalid fetchedAt are invalid_data', async () => {
    const details = await clientDetails('getbyid-62587.json');
    expect(await repo.saveDetails({ details, fetchedAt: 'yesterday' })).toMatchObject({
      ok: false,
      failure: { kind: 'invalid_data' },
    });
  });
});
