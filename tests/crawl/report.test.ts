/**
 * AL2 unit tests: `src/crawl/report.ts` (AL4 1.3 `Tally` and `report.ts` signatures, 1.4.8 Run end,
 * Run Summary, report; AL6 AC-10, AC-16, AC-50, AC-51, AC-54).
 *
 * Pure and synchronous: no database, no network, no clock. Moments are fixed `MomentSchema` text;
 * counts are synthetic (the AC-51 scenario numbers). Labels are read from the contract constants.
 */
import {
  buildReport,
  createTally,
  failedReport,
  formatPlanLines,
  formatSummaryText,
  oneLine,
  plannedReport,
} from '../../src/crawl/report';
import { planTiles } from '../../src/crawl/tile-plan';
import {
  BELGRADE_SMALL_REGION,
  ITEM_FAILURE_LABELS,
  ItemFailureKindSchema,
  OUTCOME_LABELS,
  RunCountsSchema,
  RunOutcomeSchema,
  RunReportSchema,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
  type ItemFailureReport,
  type RunCounts,
  type RunSummary,
} from '../../contracts/hydration.schema';
import { RUN_START } from '../../contracts/hydration.support';

const RUN_END = '2026-10-22T09:05:00Z';
const LINE_PATTERN = /^[A-Z][^:{}[\]"]*: \S.*$/;
const ZERO_GATEWAY = { listingRequests: 0, detailsRequests: 0, rateLimitWaits: 0, rateLimitWaitMs: 0 };
const ZERO_EXTRA = { tilesUnfinished: 0, placesStillDue: 0, placesParked: 0, placesReleased: 0 };

/** AC-51: the exact numbers of the AL6 scenario. */
const AC51_COUNTS: RunCounts = {
  wikimapiaRequests: 5,
  listingRequests: 1,
  detailsRequests: 4,
  rateLimitWaits: 1,
  rateLimitWaitSeconds: 7,
  listingPagesSaved: 1,
  tilesFinished: 1,
  tilesUnfinished: 0,
  placesListed: 3,
  placesNewlyStored: 3,
  detailsSaved: 2,
  detailsChanged: 2,
  placesStillDue: 1,
  itemFailures: 1,
  itemFailuresByKind: { ...ZERO_RUN_COUNTS.itemFailuresByKind, wikimapia_error: 1 },
  placesParkedThisRun: 0,
  placesParked: 0,
  placesReleased: 0,
};

const AC51_FAILURE: ItemFailureReport = {
  item: { kind: 'place_details', placeId: 62587 },
  failureKind: 'wikimapia_error',
  message: 'Place 62587: Wikimapia error',
};

/** A tally driven to exactly the AC-51 counts. */
function ac51Tally(): ReturnType<typeof createTally> {
  const tally = createTally();
  tally.pageSaved([101, 102, 103], 3, true);
  tally.detailsSaved(true);
  tally.detailsSaved(true);
  tally.itemFailure(AC51_FAILURE.item, AC51_FAILURE.failureKind, AC51_FAILURE.message);
  return tally;
}

function ac51Snapshot(tally: ReturnType<typeof createTally>): RunCounts {
  return tally.snapshot(
    { listingRequests: 1, detailsRequests: 4, rateLimitWaits: 1, rateLimitWaitMs: 7000 },
    { tilesUnfinished: 0, placesStillDue: 1, placesParked: 0, placesReleased: 0 },
  );
}

function ac51Summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    regionName: 'test-one',
    outcome: 'completed',
    startedAt: RUN_START,
    endedAt: RUN_END,
    counts: AC51_COUNTS,
    ...overrides,
  };
}

/** The lines of AL4 1.4.8 for a summary, built from the contract labels in the stated order. */
function expectedLines(summary: RunSummary): string[] {
  const c = summary.counts;
  const lines: string[] = [];
  if (summary.regionName !== undefined) lines.push(`${SUMMARY_LABELS.regionName}: ${summary.regionName}`);
  lines.push(
    `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS[summary.outcome]}`,
    `${SUMMARY_LABELS.startedAt}: ${summary.startedAt}`,
    `${SUMMARY_LABELS.endedAt}: ${summary.endedAt}`,
    `${SUMMARY_LABELS.wikimapiaRequests}: ${String(c.wikimapiaRequests)}`,
    `${SUMMARY_LABELS.listingRequests}: ${String(c.listingRequests)}`,
    `${SUMMARY_LABELS.detailsRequests}: ${String(c.detailsRequests)}`,
    `${SUMMARY_LABELS.rateLimitWaits}: ${String(c.rateLimitWaits)}`,
    `${SUMMARY_LABELS.rateLimitWaitSeconds}: ${String(c.rateLimitWaitSeconds)}`,
    `${SUMMARY_LABELS.listingPagesSaved}: ${String(c.listingPagesSaved)}`,
    `${SUMMARY_LABELS.tilesFinished}: ${String(c.tilesFinished)}`,
    `${SUMMARY_LABELS.tilesUnfinished}: ${String(c.tilesUnfinished)}`,
    `${SUMMARY_LABELS.placesListed}: ${String(c.placesListed)}`,
    `${SUMMARY_LABELS.placesNewlyStored}: ${String(c.placesNewlyStored)}`,
    `${SUMMARY_LABELS.detailsSaved}: ${String(c.detailsSaved)}`,
    `${SUMMARY_LABELS.detailsChanged}: ${String(c.detailsChanged)}`,
    `${SUMMARY_LABELS.placesStillDue}: ${String(c.placesStillDue)}`,
    `${SUMMARY_LABELS.itemFailures}: ${String(c.itemFailures)}`,
  );
  for (const kind of ItemFailureKindSchema.options) {
    lines.push(
      `${SUMMARY_LABELS.itemFailures} (${ITEM_FAILURE_LABELS[kind]}): ${String(c.itemFailuresByKind[kind])}`,
    );
  }
  lines.push(
    `${SUMMARY_LABELS.placesParkedThisRun}: ${String(c.placesParkedThisRun)}`,
    `${SUMMARY_LABELS.placesParked}: ${String(c.placesParked)}`,
    `${SUMMARY_LABELS.placesReleased}: ${String(c.placesReleased)}`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

describe('createTally: from scratch', () => {
  it('a snapshot with zero gateway counts and zero extras equals ZERO_RUN_COUNTS', () => {
    const counts = createTally().snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('starts with no failures', () => {
    expect(createTally().failures).toStrictEqual([]);
  });

  it('a snapshot is a fresh object: mutating it leaves ZERO_RUN_COUNTS and later snapshots unchanged', () => {
    const before = structuredClone(ZERO_RUN_COUNTS);
    const tally = createTally();
    const first = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    first.itemFailuresByKind.connection = 9;
    first.listingPagesSaved = 9;
    expect(ZERO_RUN_COUNTS).toStrictEqual(before);
    expect(tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA)).toStrictEqual(ZERO_RUN_COUNTS);
  });
});

describe('createTally: counting', () => {
  it('pageSaved adds a listing page, created Places, and a Tile only when finished', () => {
    const tally = createTally();
    tally.pageSaved([1, 2], 2, false);
    let counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.listingPagesSaved).toBe(1);
    expect(counts.tilesFinished).toBe(0);
    expect(counts.placesNewlyStored).toBe(2);
    expect(counts.placesListed).toBe(2);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();

    tally.pageSaved([3], 1, true);
    counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.listingPagesSaved).toBe(2);
    expect(counts.tilesFinished).toBe(1);
    expect(counts.placesNewlyStored).toBe(3);
    expect(counts.placesListed).toBe(3);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('counts distinct Place IDs: the same id on two pages counts once (AC-16)', () => {
    const tally = createTally();
    tally.pageSaved([10, 11], 2, false);
    tally.pageSaved([11, 12], 1, true);
    const counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.placesListed).toBe(3);
    expect(counts.placesNewlyStored).toBe(3);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('counts distinct Place IDs: the same id twice on one page counts once', () => {
    const tally = createTally();
    tally.pageSaved([7, 7, 8], 2, true);
    const counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.placesListed).toBe(2);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('an empty page still counts as a saved listing page', () => {
    const tally = createTally();
    tally.pageSaved([], 0, true);
    const counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.listingPagesSaved).toBe(1);
    expect(counts.tilesFinished).toBe(1);
    expect(counts.placesListed).toBe(0);
  });

  it('detailsSaved(true) counts saved and changed; detailsSaved(false) only saved', () => {
    const tally = createTally();
    tally.detailsSaved(true);
    tally.detailsSaved(false);
    tally.detailsSaved(false);
    const counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.detailsSaved).toBe(3);
    expect(counts.detailsChanged).toBe(1);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('itemFailure appends reports in order and counts them per kind', () => {
    const tally = createTally();
    const first: ItemFailureReport = {
      item: { kind: 'listing_page', tileNumber: 2, page: 3 },
      failureKind: 'connection',
      message: 'Tile 2 page 3: connection failure',
    };
    const second: ItemFailureReport = {
      item: { kind: 'place_details', placeId: 5 },
      failureKind: 'invalid_data',
      message: 'Place 5: invalid data',
    };
    const third: ItemFailureReport = {
      item: { kind: 'place_details', placeId: 6 },
      failureKind: 'invalid_data',
      message: 'Place 6: invalid data',
    };
    for (const f of [first, second, third]) tally.itemFailure(f.item, f.failureKind, f.message);
    expect(tally.failures).toStrictEqual([first, second, third]);
    const counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.itemFailures).toBe(3);
    expect(counts.itemFailuresByKind).toStrictEqual({
      ...ZERO_RUN_COUNTS.itemFailuresByKind,
      connection: 1,
      invalid_data: 2,
    });
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });
});

describe('createTally: snapshot maps gateway counts and extras', () => {
  it('sums requests, converts wait ms to seconds and copies the extras', () => {
    const counts = createTally().snapshot(
      { listingRequests: 3, detailsRequests: 5, rateLimitWaits: 2, rateLimitWaitMs: 1500 },
      { tilesUnfinished: 4, placesStillDue: 6, placesParked: 0, placesReleased: 0 },
    );
    expect(counts.listingRequests).toBe(3);
    expect(counts.detailsRequests).toBe(5);
    expect(counts.wikimapiaRequests).toBe(8);
    expect(counts.rateLimitWaits).toBe(2);
    expect(counts.rateLimitWaitSeconds).toBe(1.5);
    expect(counts.tilesUnfinished).toBe(4);
    expect(counts.placesStillDue).toBe(6);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });
});

describe('createTally: the AC-51 numbers', () => {
  it('gives exactly the AC-51 counts', () => {
    const tally = ac51Tally();
    const counts = ac51Snapshot(tally);
    expect(counts).toStrictEqual(AC51_COUNTS);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
    expect(tally.failures).toStrictEqual([AC51_FAILURE]);
  });
});

// ---------------------------------------------------------------------------
// formatSummaryText
// ---------------------------------------------------------------------------

describe('formatSummaryText (AC-54)', () => {
  it('gives exactly the lines of AL4 1.4.8 in order, joined by \\n, no trailing empty line', () => {
    const summary = ac51Summary();
    const text = formatSummaryText(summary);
    expect(text).toBe(expectedLines(summary).join('\n'));
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')).toHaveLength(4 + 14 + 5 + 3);
  });

  it('starts with Region, outcome label, Started at and Ended at', () => {
    const lines = formatSummaryText(ac51Summary()).split('\n');
    expect(lines.slice(0, 4)).toStrictEqual([
      `${SUMMARY_LABELS.regionName}: test-one`,
      `${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.completed}`,
      `${SUMMARY_LABELS.startedAt}: ${RUN_START}`,
      `${SUMMARY_LABELS.endedAt}: ${RUN_END}`,
    ]);
  });

  it('every line matches the AC-54 pattern', () => {
    for (const line of formatSummaryText(ac51Summary()).split('\n')) {
      expect(line).toMatch(LINE_PATTERN);
    }
  });

  it('omits the Region line when regionName is absent', () => {
    const summary: RunSummary = {
      outcome: 'failed',
      startedAt: RUN_START,
      endedAt: RUN_START,
      counts: ZERO_RUN_COUNTS,
    };
    const text = formatSummaryText(summary);
    expect(text).toBe(expectedLines(summary).join('\n'));
    expect(text).not.toContain(`${SUMMARY_LABELS.regionName}:`);
    expect(text.split('\n')[0]).toBe(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.failed}`);
  });

  it('prints a non-integer rateLimitWaitSeconds with String()', () => {
    const summary = ac51Summary({ counts: { ...AC51_COUNTS, rateLimitWaitSeconds: 1.5 } });
    const lines = formatSummaryText(summary).split('\n');
    expect(lines).toContain(`${SUMMARY_LABELS.rateLimitWaitSeconds}: ${String(1.5)}`);
  });

  it('uses the outcome label for every outcome', () => {
    for (const outcome of ['budget_reached', 'rate_limited', 'interrupted', 'planned'] as const) {
      const text = formatSummaryText(ac51Summary({ outcome }));
      expect(text.split('\n')).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS[outcome]}`);
    }
  });
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  it('completed with a runId and the AC-51 tally passes RunReportSchema', () => {
    const tally = ac51Tally();
    const counts = ac51Snapshot(tally);
    const report = buildReport({
      outcome: 'completed',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts,
      failures: tally.failures,
      runId: 7,
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('completed');
    expect(report.runId).toBe(7);
    expect(report.summary).toStrictEqual({
      regionName: 'test-one',
      outcome: 'completed',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: AC51_COUNTS,
    });
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
    expect(report.itemFailures).toStrictEqual([AC51_FAILURE]);
    expect(report).not.toHaveProperty('plan');
    expect(report).not.toHaveProperty('message');
  });

  it('failed with a message passes RunReportSchema and keeps the message', () => {
    const report = buildReport({
      outcome: 'failed',
      message: 'Place Store unavailable',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: ZERO_RUN_COUNTS,
      failures: [],
      runId: 3,
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('failed');
    expect(report.message).toBe('Place Store unavailable');
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
    expect(report.itemFailures).toStrictEqual([]);
    expect(report).not.toHaveProperty('plan');
  });

  it('budget_reached with a message passes RunReportSchema', () => {
    const report = buildReport({
      outcome: 'budget_reached',
      message: 'Request Budget reached',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: { ...ZERO_RUN_COUNTS, wikimapiaRequests: 2, listingRequests: 2 },
      failures: [],
      runId: 4,
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('budget_reached');
    expect(report.summary.outcome).toBe('budget_reached');
    expect(report.message).toBe('Request Budget reached');
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
    expect(report).not.toHaveProperty('plan');
  });

  it('planned with a plan passes RunReportSchema and carries the plan', () => {
    const plan = planTiles(BELGRADE_SMALL_REGION);
    const report = buildReport({
      outcome: 'planned',
      regionName: plan.regionName,
      startedAt: RUN_START,
      endedAt: RUN_START,
      counts: ZERO_RUN_COUNTS,
      failures: [],
      plan,
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.plan).toStrictEqual(plan);
  });

  it('optional keys are absent, not undefined, when not given', () => {
    const report = buildReport({
      outcome: 'completed',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: ZERO_RUN_COUNTS,
      failures: [],
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(Object.keys(report)).not.toContain('message');
    expect(Object.keys(report)).not.toContain('runId');
    expect(Object.keys(report)).not.toContain('plan');
    expect(Object.keys(report.summary)).not.toContain('regionName');
    expect(report.summaryText).not.toContain(`${SUMMARY_LABELS.regionName}:`);
  });

  it('a report that fails the gate becomes the internal-error failed report (failed without a message)', () => {
    const report = buildReport({
      outcome: 'failed',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: AC51_COUNTS,
      failures: [AC51_FAILURE],
      runId: 9,
    });
    expect(report).toStrictEqual(
      failedReport('Crawl failed: internal error (report check)', 'test-one', RUN_END),
    );
    expect(() => RunReportSchema.parse(report)).not.toThrow();
  });

  it('a report that fails the gate becomes the internal-error failed report (failures do not match counts)', () => {
    const report = buildReport({
      outcome: 'completed',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: AC51_COUNTS,
      failures: [],
      runId: 9,
    });
    expect(report.outcome).toBe('failed');
    expect(report.message).toBe('Crawl failed: internal error (report check)');
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(report.summary.startedAt).toBe(RUN_END);
    expect(report.summary.endedAt).toBe(RUN_END);
    expect(report).not.toHaveProperty('runId');
    expect(() => RunReportSchema.parse(report)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// failedReport, plannedReport, formatPlanLines
// ---------------------------------------------------------------------------

describe('failedReport', () => {
  it('has zero counts, no runId, equal moments and passes RunReportSchema', () => {
    const report = failedReport('some reason', 'atlantis', RUN_START);
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('failed');
    expect(report.summary.outcome).toBe('failed');
    expect(report.message).toBe('some reason');
    expect(report.summary.regionName).toBe('atlantis');
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(report.summary.startedAt).toBe(RUN_START);
    expect(report.summary.endedAt).toBe(RUN_START);
    expect(report.itemFailures).toStrictEqual([]);
    expect(report).not.toHaveProperty('runId');
    expect(report).not.toHaveProperty('plan');
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
  });

  it('without a Region has no regionName key and no Region line', () => {
    const report = failedReport('some reason', undefined, RUN_START);
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(Object.keys(report.summary)).not.toContain('regionName');
    expect(report.summaryText).not.toContain(`${SUMMARY_LABELS.regionName}:`);
  });

  it('never puts the message inside summaryText', () => {
    const report = failedReport('a very particular reason', 'atlantis', RUN_START);
    expect(report.summaryText).not.toContain('a very particular reason');
  });

  it('its counts are a fresh object (mutating them leaves ZERO_RUN_COUNTS unchanged)', () => {
    const before = structuredClone(ZERO_RUN_COUNTS);
    const report = failedReport('some reason', 'atlantis', RUN_START);
    report.summary.counts.itemFailuresByKind.connection = 5;
    report.summary.counts.detailsSaved = 5;
    expect(ZERO_RUN_COUNTS).toStrictEqual(before);
  });
});

describe('plannedReport (AC-10)', () => {
  it('is planned, zero counts, carries the plan, no runId, passes RunReportSchema', () => {
    const plan = planTiles(BELGRADE_SMALL_REGION);
    const report = plannedReport(plan, RUN_START);
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('planned');
    expect(report.summary.outcome).toBe('planned');
    expect(report.summary.regionName).toBe('belgrade-small');
    expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
    expect(report.summary.startedAt).toBe(RUN_START);
    expect(report.summary.endedAt).toBe(RUN_START);
    expect(report.plan).toStrictEqual(plan);
    expect(report.itemFailures).toStrictEqual([]);
    expect(report).not.toHaveProperty('runId');
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
  });
});

// ---------------------------------------------------------------------------
// crawl-run1-fixes U5 (AL4 1.4.10; AC-18, AC-39, AC-40): parking counts, the
// `Wikimapia message:` line, `parkedPlacesInRegion`
// ---------------------------------------------------------------------------

const KEY_QUOTA_TEXT = 'Key limit has been reached';
const KEY_QUOTA_STOP_MESSAGE = `Wikimapia key quota exhausted (code 1004): ${KEY_QUOTA_TEXT}`;
const WIKIMAPIA_LINE_PREFIX = `${SUMMARY_LABELS.wikimapiaMessage}:`;

/** AC-51 counts with distinct parking numbers, so each line shows its own count. */
const PARKING_COUNTS: RunCounts = {
  ...AC51_COUNTS,
  placesParkedThisRun: 1,
  placesParked: 2,
  placesReleased: 3,
};

function parkingLines(c: RunCounts): string[] {
  return [
    `${SUMMARY_LABELS.placesParkedThisRun}: ${String(c.placesParkedThisRun)}`,
    `${SUMMARY_LABELS.placesParked}: ${String(c.placesParked)}`,
    `${SUMMARY_LABELS.placesReleased}: ${String(c.placesReleased)}`,
  ];
}

function quotaSummary(counts: RunCounts = PARKING_COUNTS): RunSummary {
  return ac51Summary({ outcome: 'quota_exhausted', counts });
}

function hasWikimapiaLine(text: string): boolean {
  return text.split('\n').some((line) => line.startsWith(WIKIMAPIA_LINE_PREFIX));
}

describe('createTally: parking counts', () => {
  it('a fresh tally has parkedThisRun 0 and snapshots 0 for the three counts', () => {
    const tally = createTally();
    expect(tally.parkedThisRun).toBe(0);
    const counts = tally.snapshot(ZERO_GATEWAY, ZERO_EXTRA);
    expect(counts.placesParkedThisRun).toBe(0);
    expect(counts.placesParked).toBe(0);
    expect(counts.placesReleased).toBe(0);
  });

  it('each placeParked() adds 1 to parkedThisRun', () => {
    const tally = createTally();
    tally.placeParked();
    expect(tally.parkedThisRun).toBe(1);
    tally.placeParked();
    tally.placeParked();
    expect(tally.parkedThisRun).toBe(3);
  });

  it('snapshot writes placesParkedThisRun = parkedThisRun and copies placesParked and placesReleased', () => {
    const tally = createTally();
    tally.placeParked();
    tally.placeParked();
    const counts = tally.snapshot(ZERO_GATEWAY, {
      tilesUnfinished: 0,
      placesStillDue: 0,
      placesParked: 5,
      placesReleased: 4,
    });
    expect(counts.placesParkedThisRun).toBe(2);
    expect(counts.placesParked).toBe(5);
    expect(counts.placesReleased).toBe(4);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('placesParkedThisRun === placesParked passes RunCountsSchema', () => {
    const tally = createTally();
    tally.placeParked();
    tally.placeParked();
    const counts = tally.snapshot(ZERO_GATEWAY, {
      tilesUnfinished: 0,
      placesStillDue: 0,
      placesParked: 2,
      placesReleased: 0,
    });
    expect(counts.placesParkedThisRun).toBe(2);
    expect(counts.placesParked).toBe(2);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('placesParked larger than placesParkedThisRun passes RunCountsSchema', () => {
    const tally = createTally();
    tally.placeParked();
    const counts = tally.snapshot(ZERO_GATEWAY, {
      tilesUnfinished: 0,
      placesStillDue: 3,
      placesParked: 7,
      placesReleased: 1,
    });
    expect(counts.placesParkedThisRun).toBe(1);
    expect(counts.placesParked).toBe(7);
    expect(counts.placesReleased).toBe(1);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });

  it('the AC-51 tally with parking extras keeps every other count', () => {
    const tally = ac51Tally();
    tally.placeParked();
    const counts = tally.snapshot(
      { listingRequests: 1, detailsRequests: 4, rateLimitWaits: 1, rateLimitWaitMs: 7000 },
      { tilesUnfinished: 0, placesStillDue: 1, placesParked: 2, placesReleased: 3 },
    );
    expect(counts).toStrictEqual(PARKING_COUNTS);
    expect(() => RunCountsSchema.parse(counts)).not.toThrow();
  });
});

describe('oneLine', () => {
  it('turns every whitespace run (spaces, tabs, \\n, \\r\\n) into one space and trims', () => {
    expect(oneLine('a  b')).toBe('a b');
    expect(oneLine('a\tb')).toBe('a b');
    expect(oneLine('a\nb')).toBe('a b');
    expect(oneLine('a\r\nb')).toBe('a b');
    expect(oneLine('  Key limit\n\t has   been\r\n reached \t')).toBe('Key limit has been reached');
  });

  it('keeps a single-line text unchanged', () => {
    expect(oneLine('Key limit has been reached')).toBe('Key limit has been reached');
    expect(oneLine('Key [key removed] is not valid')).toBe('Key [key removed] is not valid');
  });

  it("gives '' for '' and whitespace-only text", () => {
    expect(oneLine('')).toBe('');
    expect(oneLine('   ')).toBe('');
    expect(oneLine(' \t\n\r\n ')).toBe('');
  });
});

describe('formatSummaryText: parking lines and the Wikimapia message line', () => {
  it('shows the three parking lines after the per-kind lines, in SUMMARY_LABELS order', () => {
    const summary = ac51Summary({ counts: PARKING_COUNTS });
    const lines = formatSummaryText(summary).split('\n');
    expect(lines.slice(-3)).toStrictEqual(parkingLines(PARKING_COUNTS));
    const lastKind = ItemFailureKindSchema.options[ItemFailureKindSchema.options.length - 1];
    if (lastKind === undefined) throw new Error('no Item Failure kinds');
    expect(lines.at(-4)).toBe(
      `${SUMMARY_LABELS.itemFailures} (${ITEM_FAILURE_LABELS[lastKind]}): ${String(PARKING_COUNTS.itemFailuresByKind[lastKind])}`,
    );
    expect(lines.join('\n')).toBe(expectedLines(summary).join('\n'));
  });

  it('no outcome other than quota_exhausted shows a Wikimapia message line, even with notes', () => {
    const others = RunOutcomeSchema.options.filter((o) => o !== 'quota_exhausted');
    expect(others.length).toBeGreaterThan(0);
    for (const outcome of others) {
      const summary = ac51Summary({ outcome, counts: PARKING_COUNTS });
      const text = formatSummaryText(summary, { wikimapiaMessage: KEY_QUOTA_TEXT });
      expect(hasWikimapiaLine(text)).toBe(false);
      expect(text).not.toContain(KEY_QUOTA_TEXT);
      expect(text).toBe(expectedLines(summary).join('\n'));
    }
  });

  it('quota_exhausted without notes, or with notes lacking wikimapiaMessage, shows no such line', () => {
    const summary = quotaSummary();
    for (const text of [formatSummaryText(summary), formatSummaryText(summary, {})]) {
      expect(hasWikimapiaLine(text)).toBe(false);
      expect(text).toBe(expectedLines(summary).join('\n'));
    }
  });

  it('quota_exhausted with the message: the last four lines are the parking lines and the Wikimapia line', () => {
    const summary = quotaSummary();
    const text = formatSummaryText(summary, { wikimapiaMessage: KEY_QUOTA_TEXT });
    const lines = text.split('\n');
    expect(lines.slice(-4)).toStrictEqual([
      ...parkingLines(PARKING_COUNTS),
      `${SUMMARY_LABELS.wikimapiaMessage}: ${KEY_QUOTA_TEXT}`,
    ]);
    expect(lines.at(-1)).toBe('Wikimapia message: Key limit has been reached');
    expect(text).toBe(
      [...expectedLines(summary), `${SUMMARY_LABELS.wikimapiaMessage}: ${KEY_QUOTA_TEXT}`].join('\n'),
    );
    expect(lines).toContain(`${SUMMARY_LABELS.outcome}: ${OUTCOME_LABELS.quota_exhausted}`);
    expect(text.endsWith('\n')).toBe(false);
    for (const line of lines) expect(line).toMatch(LINE_PATTERN);
  });

  for (const blank of ['', '   ', ' \t\n\r\n ']) {
    it(`a blank Wikimapia message (${JSON.stringify(blank)}) shows (empty)`, () => {
      const text = formatSummaryText(quotaSummary(), { wikimapiaMessage: blank });
      const lines = text.split('\n');
      expect(lines.at(-1)).toBe(`${SUMMARY_LABELS.wikimapiaMessage}: (empty)`);
      expect(lines.filter((l) => l.startsWith(WIKIMAPIA_LINE_PREFIX))).toHaveLength(1);
      for (const line of lines) expect(line).toMatch(LINE_PATTERN);
    });
  }

  it('a multi-line Wikimapia message gives one line', () => {
    const summary = quotaSummary();
    const text = formatSummaryText(summary, {
      wikimapiaMessage: '  Key limit\n\thas been\r\nreached  ',
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(expectedLines(summary).length + 1);
    expect(lines.at(-1)).toBe(`${SUMMARY_LABELS.wikimapiaMessage}: ${KEY_QUOTA_TEXT}`);
    for (const line of lines) expect(line).toMatch(LINE_PATTERN);
  });
});

describe('buildReport: quota_exhausted and the Wikimapia message', () => {
  function quotaReport(wikimapiaMessage: string | undefined): ReturnType<typeof buildReport> {
    const tally = ac51Tally();
    return buildReport({
      outcome: 'quota_exhausted',
      message: KEY_QUOTA_STOP_MESSAGE,
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: ac51Snapshot(tally),
      failures: tally.failures,
      runId: 11,
      ...(wikimapiaMessage === undefined ? {} : { wikimapiaMessage }),
    });
  }

  it('passes RunReportSchema, keeps the message and shows the Wikimapia line', () => {
    const report = quotaReport(KEY_QUOTA_TEXT);
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('quota_exhausted');
    expect(report.summary.outcome).toBe('quota_exhausted');
    expect(report.message).toBe(KEY_QUOTA_STOP_MESSAGE);
    expect(report.runId).toBe(11);
    expect(report.summaryText).toBe(
      formatSummaryText(report.summary, { wikimapiaMessage: KEY_QUOTA_TEXT }),
    );
    expect(report.summaryText.split('\n')).toContain(
      `${SUMMARY_LABELS.wikimapiaMessage}: ${KEY_QUOTA_TEXT}`,
    );
    for (const line of report.summaryText.split('\n')) expect(line).toMatch(LINE_PATTERN);
  });

  it('never adds a wikimapiaMessage key to the report object', () => {
    const report = quotaReport(KEY_QUOTA_TEXT);
    expect(Object.keys(report)).not.toContain('wikimapiaMessage');
    expect(Object.keys(report.summary)).not.toContain('wikimapiaMessage');
  });

  it('a blank Wikimapia message gives (empty) and still passes RunReportSchema', () => {
    const report = quotaReport('');
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('quota_exhausted');
    expect(report.summaryText.split('\n').at(-1)).toBe(
      `${SUMMARY_LABELS.wikimapiaMessage}: (empty)`,
    );
  });

  it('quota_exhausted without a wikimapiaMessage: no Wikimapia line', () => {
    const report = quotaReport(undefined);
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('quota_exhausted');
    expect(hasWikimapiaLine(report.summaryText)).toBe(false);
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
  });

  it('another outcome given a wikimapiaMessage: no Wikimapia line', () => {
    const report = buildReport({
      outcome: 'budget_reached',
      message: 'Request Budget reached',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: ZERO_RUN_COUNTS,
      failures: [],
      runId: 4,
      wikimapiaMessage: KEY_QUOTA_TEXT,
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('budget_reached');
    expect(hasWikimapiaLine(report.summaryText)).toBe(false);
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
    expect(Object.keys(report)).not.toContain('wikimapiaMessage');
  });
});

describe('plannedReport and buildReport: parkedPlacesInRegion (AC-40)', () => {
  for (const n of [4, 0]) {
    it(`plannedReport(plan, at, ${String(n)}) has parkedPlacesInRegion ${String(n)} and zero counts`, () => {
      const plan = planTiles(BELGRADE_SMALL_REGION);
      const report = plannedReport(plan, RUN_START, n);
      expect(() => RunReportSchema.parse(report)).not.toThrow();
      expect(report.outcome).toBe('planned');
      expect(report.plan).toStrictEqual(plan);
      expect(Object.keys(report)).toContain('parkedPlacesInRegion');
      expect(report.parkedPlacesInRegion).toBe(n);
      expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
      expect(report.summaryText).toBe(formatSummaryText(report.summary));
    });
  }

  it('plannedReport(plan, at) has no parkedPlacesInRegion key', () => {
    const report = plannedReport(planTiles(BELGRADE_SMALL_REGION), RUN_START);
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(Object.keys(report)).not.toContain('parkedPlacesInRegion');
  });

  it('buildReport planned with parkedPlacesInRegion passes RunReportSchema', () => {
    const plan = planTiles(BELGRADE_SMALL_REGION);
    const report = buildReport({
      outcome: 'planned',
      regionName: plan.regionName,
      startedAt: RUN_START,
      endedAt: RUN_START,
      counts: ZERO_RUN_COUNTS,
      failures: [],
      plan,
      parkedPlacesInRegion: 2,
    });
    expect(() => RunReportSchema.parse(report)).not.toThrow();
    expect(report.outcome).toBe('planned');
    expect(report.parkedPlacesInRegion).toBe(2);
  });

  it('buildReport without parkedPlacesInRegion has no such key', () => {
    const report = buildReport({
      outcome: 'completed',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: ZERO_RUN_COUNTS,
      failures: [],
    });
    expect(Object.keys(report)).not.toContain('parkedPlacesInRegion');
  });

  it('parkedPlacesInRegion with a non-Planned outcome fails the gate: the internal-error failed report', () => {
    const report = buildReport({
      outcome: 'completed',
      regionName: 'test-one',
      startedAt: RUN_START,
      endedAt: RUN_END,
      counts: ZERO_RUN_COUNTS,
      failures: [],
      runId: 5,
      parkedPlacesInRegion: 2,
    });
    expect(report).toStrictEqual(
      failedReport('Crawl failed: internal error (report check)', 'test-one', RUN_END),
    );
    expect(Object.keys(report)).not.toContain('parkedPlacesInRegion');
    expect(() => RunReportSchema.parse(report)).not.toThrow();
  });
});

describe('failedReport and plannedReport show 0 on each parking line (AC-39)', () => {
  const zeroLines = [
    `${SUMMARY_LABELS.placesParkedThisRun}: 0`,
    `${SUMMARY_LABELS.placesParked}: 0`,
    `${SUMMARY_LABELS.placesReleased}: 0`,
  ];

  it('failedReport', () => {
    const report = failedReport('some reason', 'atlantis', RUN_START);
    const lines = report.summaryText.split('\n');
    expect(lines.slice(-3)).toStrictEqual(zeroLines);
    expect(hasWikimapiaLine(report.summaryText)).toBe(false);
    for (const line of lines) expect(line).toMatch(LINE_PATTERN);
  });

  it('plannedReport, with and without parkedPlacesInRegion', () => {
    const plan = planTiles(BELGRADE_SMALL_REGION);
    for (const report of [plannedReport(plan, RUN_START), plannedReport(plan, RUN_START, 3)]) {
      const lines = report.summaryText.split('\n');
      expect(lines.slice(-3)).toStrictEqual(zeroLines);
      expect(report.summary.counts).toStrictEqual(ZERO_RUN_COUNTS);
      for (const line of lines) expect(line).toMatch(LINE_PATTERN);
    }
  });
});

describe('formatPlanLines', () => {
  it('gives one line per Tile of belgrade-small', () => {
    const lines = formatPlanLines(planTiles(BELGRADE_SMALL_REGION));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('Tile 1: west 20.452, south 44.814, east 20.457, north 44.819');
    expect(lines[3]).toBe('Tile 4: west 20.457, south 44.819, east 20.462, north 44.82');
  });
});
