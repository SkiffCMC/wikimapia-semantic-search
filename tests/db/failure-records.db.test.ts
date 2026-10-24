/**
 * AL2 unit tests: `src/db/failure-records.ts` behind the repository's `recordItemFailure`. The
 * contract tests cover the round trip, isolation, append-only history, the write-hook failure and
 * the Explicit Retry read; this pins down what they never reach: the tie order of the reads, the
 * `taken_over` branch and validation before any database access. Synthetic data on the Test
 * Database; no Place is seeded, so no record is ever Parked.
 */
import { openCrawlRepository } from '../../src/db/crawl-repository';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { POOL_MAX_SETUP, createDb, destroyQuietly } from '../../src/db/connection';
import { selectFailureRecords } from '../../src/db/failure-records';
import type { CrawlRepository } from '../../src/db/types';
import type { WriteHook } from '../../contracts/storage.schema';
import { ZERO_RUN_COUNTS, toMoment, type Moment } from '../../contracts/hydration.schema';
import type { FailureRecord } from '../../contracts/crawl-run1-fixes.schema';
import { RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import { UNREACHABLE_DATABASE_URL, requireTestDatabaseUrl } from '../../contracts/storage.support';

const url = requireTestDatabaseUrl();
const setup = createSchemaSetup({ connectionString: url });
const db = createDb(url, POOL_MAX_SETUP);
const repositories: CrawlRepository[] = [];

const T = (seconds: number): Moment => toMoment(new Date(Date.parse(RUN_START) + seconds * 1000));

beforeAll(async () => {
  expect((await setup.apply()).ok).toBe(true);
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
});

afterAll(async () => {
  await Promise.all(repositories.map((repo) => repo.close()));
  await Promise.all([destroyQuietly(db), setup.close()]);
});

function openRepo(onWrite?: WriteHook, connectionString = url): CrawlRepository {
  const repo = openCrawlRepository({ connectionString, ...(onWrite ? { onWrite } : {}) });
  repositories.push(repo);
  return repo;
}

async function startRun(repo: CrawlRepository, startedAt = RUN_START): Promise<number> {
  const result = await repo.beginRun({
    regionName: 'test-one',
    bbox: SMALL_BBOX,
    tileSize: { width: 0.005, height: 0.005 },
    tileCount: 1,
    relist: false,
    startedAt,
    abandonBefore: toMoment(new Date(Date.parse(startedAt) - 3600 * 1000)),
    counts: ZERO_RUN_COUNTS,
    retryParked: false,
  });
  if (!result.ok || result.value.kind !== 'started') throw new Error('expected a started Run');
  return result.value.runId;
}

function placeRecord(runId: number, failedAt: Moment, message: string): FailureRecord {
  const item = { kind: 'place_details', placeId: 900 } as const;
  return { runId, item, failureKind: 'wikimapia_error', message, failedAt };
}

it('reads records oldest first, ties in insertion order, by Place and by Run', async () => {
  const repo = openRepo();
  const runId = await startRun(repo);
  const late = placeRecord(runId, T(30), 'late');
  const first = placeRecord(runId, T(10), 'first');
  const listing: FailureRecord = {
    runId,
    item: { kind: 'listing_page', tileNumber: 1, page: 2 },
    failureKind: 'connection',
    message: 'listing',
    failedAt: T(10),
  };
  const second = placeRecord(runId, T(10), 'second');
  for (const record of [late, first, listing, second]) {
    expect(await repo.recordItemFailure(record)).toStrictEqual({
      ok: true,
      value: { kind: 'recorded' },
    });
  }
  expect(await selectFailureRecords(db, { placeId: 900 })).toStrictEqual([first, second, late]);
  expect(await selectFailureRecords(db, { runId })).toStrictEqual([first, listing, second, late]);
});

it('a record for a Run abandoned by a later start is taken_over and writes nothing', async () => {
  const abandoned = await startRun(openRepo());
  await startRun(openRepo(), T(3601));
  const writes: number[] = [];
  const repo = openRepo((n) => {
    writes.push(n);
  });
  expect(await repo.recordItemFailure(placeRecord(abandoned, T(3700), 'late'))).toStrictEqual({
    ok: true,
    value: { kind: 'taken_over' },
  });
  expect(writes).toStrictEqual([]);
  expect(await selectFailureRecords(db, { runId: abandoned })).toStrictEqual([]);
});

it('a record with an unknown key is invalid_data before any database access', async () => {
  const repo = openRepo(undefined, UNREACHABLE_DATABASE_URL);
  const record = { ...placeRecord(1, T(10), 'synthetic'), extra: 'synthetic-extra' };
  const result = await repo.recordItemFailure(record);
  const issue = { path: [], message: 'Unrecognized key: "extra"' };
  expect(result).toStrictEqual({
    ok: false,
    failure: {
      kind: 'invalid_data',
      message: `Invalid data: (whole input): ${issue.message}`,
      issues: [issue],
    },
  });
});
