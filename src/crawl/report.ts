/**
 * Run tally, Run Summary text and report builders (AL4 1.3 `Tally`, 1.4.8; AC-10, AC-16, AC-50,
 * AC-51, AC-54). Pure: moments come in as arguments. Labels come only from the contract
 * constants; every report is gated with `RunReportSchema`.
 */
import {
  ITEM_FAILURE_LABELS,
  ItemFailureKindSchema,
  OUTCOME_LABELS,
  RunReportSchema,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
  type ItemFailureReport,
  type RunCounts,
  type RunOutcome,
  type RunReport,
  type RunSummary,
  type TilePlan,
} from '../../contracts/hydration.schema';
import type { SummaryNotes, Tally } from './types';

const REPORT_CHECK_MESSAGE = 'Crawl failed: internal error (report check)';

/** Whitespace runs become one space; the result is trimmed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function zeroCounts(): RunCounts {
  return { ...ZERO_RUN_COUNTS, itemFailuresByKind: { ...ZERO_RUN_COUNTS.itemFailuresByKind } };
}

export function createTally(): Tally {
  const placeIds = new Set<number>();
  const failures: ItemFailureReport[] = [];
  let listingPagesSaved = 0;
  let tilesFinished = 0;
  let placesNewlyStored = 0;
  let detailsSaved = 0;
  let detailsChanged = 0;
  let parkedThisRun = 0;

  return {
    pageSaved(ids, createdCount, tileFinished) {
      listingPagesSaved += 1;
      if (tileFinished) tilesFinished += 1;
      placesNewlyStored += createdCount;
      for (const id of ids) placeIds.add(id);
    },
    detailsSaved(changed) {
      detailsSaved += 1;
      if (changed) detailsChanged += 1;
    },
    itemFailure(item, failureKind, message) {
      failures.push({ item, failureKind, message });
    },
    placeParked() {
      parkedThisRun += 1;
    },
    get failures(): readonly ItemFailureReport[] {
      return failures;
    },
    get parkedThisRun(): number {
      return parkedThisRun;
    },
    snapshot(gateway, extra) {
      const counts = zeroCounts();
      counts.listingRequests = gateway.listingRequests;
      counts.detailsRequests = gateway.detailsRequests;
      counts.wikimapiaRequests = gateway.listingRequests + gateway.detailsRequests;
      counts.rateLimitWaits = gateway.rateLimitWaits;
      counts.rateLimitWaitSeconds = gateway.rateLimitWaitMs / 1000;
      counts.listingPagesSaved = listingPagesSaved;
      counts.tilesFinished = tilesFinished;
      counts.tilesUnfinished = extra.tilesUnfinished;
      counts.placesListed = placeIds.size;
      counts.placesNewlyStored = placesNewlyStored;
      counts.detailsSaved = detailsSaved;
      counts.detailsChanged = detailsChanged;
      counts.placesStillDue = extra.placesStillDue;
      counts.itemFailures = failures.length;
      for (const failure of failures) counts.itemFailuresByKind[failure.failureKind] += 1;
      counts.placesParkedThisRun = parkedThisRun;
      counts.placesParked = extra.placesParked;
      counts.placesReleased = extra.placesReleased;
      return counts;
    },
  };
}

export function formatSummaryText(summary: RunSummary, notes?: SummaryNotes): string {
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
  const wikimapiaMessage = notes?.wikimapiaMessage;
  if (summary.outcome === 'quota_exhausted' && wikimapiaMessage !== undefined) {
    const text = oneLine(wikimapiaMessage);
    lines.push(`${SUMMARY_LABELS.wikimapiaMessage}: ${text === '' ? '(empty)' : text}`);
  }
  return lines.join('\n');
}

/** Failed report with zero counts, built directly (never through the gate). */
export function failedReport(message: string, regionName: string | undefined, at: string): RunReport {
  const summary: RunSummary = {
    ...(regionName !== undefined ? { regionName } : {}),
    outcome: 'failed',
    startedAt: at,
    endedAt: at,
    counts: zeroCounts(),
  };
  return {
    outcome: 'failed',
    message,
    summary,
    summaryText: formatSummaryText(summary),
    itemFailures: [],
  };
}

export function buildReport(input: {
  outcome: RunOutcome;
  message?: string;
  regionName?: string;
  startedAt: string;
  endedAt: string;
  counts: RunCounts;
  failures: readonly ItemFailureReport[];
  runId?: number;
  plan?: TilePlan;
  wikimapiaMessage?: string;
  parkedPlacesInRegion?: number;
}): RunReport {
  const summary: RunSummary = {
    ...(input.regionName !== undefined ? { regionName: input.regionName } : {}),
    outcome: input.outcome,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    counts: input.counts,
  };
  const report: RunReport = {
    outcome: input.outcome,
    ...(input.message !== undefined ? { message: input.message } : {}),
    summary,
    summaryText:
      input.outcome === 'quota_exhausted' && input.wikimapiaMessage !== undefined
        ? formatSummaryText(summary, { wikimapiaMessage: input.wikimapiaMessage })
        : formatSummaryText(summary),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    itemFailures: [...input.failures],
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.parkedPlacesInRegion !== undefined
      ? { parkedPlacesInRegion: input.parkedPlacesInRegion }
      : {}),
  };
  if (!RunReportSchema.safeParse(report).success) {
    return failedReport(REPORT_CHECK_MESSAGE, input.regionName, input.endedAt);
  }
  return report;
}

export function plannedReport(
  plan: TilePlan,
  at: string,
  parkedPlacesInRegion?: number,
): RunReport {
  return buildReport({
    ...(parkedPlacesInRegion !== undefined ? { parkedPlacesInRegion } : {}),
    outcome: 'planned',
    regionName: plan.regionName,
    startedAt: at,
    endedAt: at,
    counts: zeroCounts(),
    failures: [],
    plan,
  });
}

export function formatPlanLines(plan: TilePlan): string[] {
  return plan.tiles.map(
    ({ tileNumber, bbox }) =>
      `Tile ${String(tileNumber)}: west ${String(bbox.west)}, south ${String(bbox.south)}, east ${String(bbox.east)}, north ${String(bbox.north)}`,
  );
}
