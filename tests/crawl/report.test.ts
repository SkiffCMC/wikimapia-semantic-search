/**
 * AL2 unit tests: `src/crawl/report.ts` (AL4 1.4.8; crawl-run1-fixes AL4 1.4.8 .. 1.4.11). The
 * contract tests check the Run Summary of every hydration outcome; this covers the report-check
 * gate and the crawl-run1-fixes parts (Parked counts, the Wikimapia message line of a Quota stop,
 * the parked count of a Planned report). Pure: no database, network or clock.
 */
import { buildReport, createTally, failedReport, plannedReport } from '../../src/crawl/report';
import { planTiles } from '../../src/crawl/tile-plan';
import {
  BELGRADE_SMALL_REGION,
  OUTCOME_LABELS,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
} from '../../contracts/hydration.schema';
import { RUN_START } from '../../contracts/hydration.support';

const GATEWAY = { listingRequests: 1, detailsRequests: 0, rateLimitWaits: 0, rateLimitWaitMs: 0 };
const EXTRA = { tilesUnfinished: 4, placesStillDue: 0, placesParked: 5, placesReleased: 1 };

describe('createTally', () => {
  it('counts placeParked() into placesParkedThisRun and copies the other parking counts', () => {
    const tally = createTally();
    tally.placeParked();
    tally.placeParked();
    expect(tally.parkedThisRun).toBe(2);
    expect(tally.snapshot(GATEWAY, EXTRA)).toMatchObject({
      placesParkedThisRun: 2,
      placesParked: 5,
      placesReleased: 1,
    });
  });
});

describe('buildReport', () => {
  it.each([
    ['Key limit\n  has been reached ', 'Key limit has been reached'],
    [' \t', '(empty)'],
  ])('a Quota stop with Wikimapia text %j ends the summary with %j', (text, shown) => {
    const report = buildReport({
      outcome: 'quota_exhausted',
      message: 'Wikimapia key quota reached',
      startedAt: RUN_START,
      endedAt: RUN_START,
      counts: createTally().snapshot(GATEWAY, EXTRA),
      failures: [],
      runId: 3,
      wikimapiaMessage: text,
    });
    expect(report.outcome).toBe('quota_exhausted');
    expect(report).not.toHaveProperty('wikimapiaMessage');
    const lines = report.summaryText.split('\n');
    expect(lines[0]).toBe(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`);
    expect(lines.at(-1)).toBe(`${SUMMARY_LABELS.wikimapiaMessage}: ${shown}`);
  });

  it('a report that fails the report check becomes the internal-error failed report', () => {
    const report = buildReport({
      outcome: 'failed',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: '2026-10-22T09:05:00Z',
      counts: ZERO_RUN_COUNTS,
      failures: [],
    });
    expect(report).toStrictEqual(
      failedReport(
        'Crawl failed: internal error (report check)',
        'test-one',
        '2026-10-22T09:05:00Z',
      ),
    );
  });
});

describe('plannedReport', () => {
  it('carries the parked count of the Region when given', () => {
    const report = plannedReport(planTiles(BELGRADE_SMALL_REGION), RUN_START, 4);
    expect(report.outcome).toBe('planned');
    expect(report.parkedPlacesInRegion).toBe(4);
  });
});
