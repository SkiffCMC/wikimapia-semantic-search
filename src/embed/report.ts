/**
 * Tally, Run Summary text and report builders (AL4 embeddings 1.4.7; AC-46 .. AC-48, AC-50).
 * Pure: moments come in as arguments. Labels come only from the contract constants; every
 * built report is gated with `EmbeddingRunReportSchema`.
 */
import {
  EMBEDDING_MODEL,
  EMBEDDING_OUTCOME_LABELS,
  EMBED_SUMMARY_LABELS,
  EmbeddingRunReportSchema,
  FAILED_PLACE_LABELS,
  FailedPlaceKindSchema,
  ZERO_EMBEDDING_COUNTS,
} from '../../contracts/embeddings.schema';
import type {
  EmbeddingRunCounts,
  EmbeddingRunReport,
  EmbeddingRunSummary,
  FailedPlaceCounts,
  FailedPlaceReport,
} from '../../contracts/embeddings.schema';
import type { ReportInput, Tally } from './types';

const REPORT_CHECK_MESSAGE = 'Embedding run failed: internal error (report check)';

function zeroCounts(): EmbeddingRunCounts {
  return {
    ...ZERO_EMBEDDING_COUNTS,
    failedPlacesByKind: { ...ZERO_EMBEDDING_COUNTS.failedPlacesByKind },
  };
}

export function createTally(): Tally {
  const failures: FailedPlaceReport[] = [];
  const byKind: FailedPlaceCounts = { ...ZERO_EMBEDDING_COUNTS.failedPlacesByKind };
  let unchanged = 0;
  let empty = 0;
  let due = 0;
  let placesEmbedded = 0;
  let tokensUsed = 0;
  let batchesSent = 0;
  let embeddingRequests = 0;

  const tally: Tally = {
    considered(kind) {
      if (kind === 'unchanged') unchanged += 1;
      else if (kind === 'empty') empty += 1;
      else due += 1;
    },
    embedded(count, tokens) {
      placesEmbedded += count;
      tokensUsed += tokens;
    },
    failed(items, failureKind, reason) {
      for (const item of items) {
        failures.push({
          placeId: item.placeId,
          failureKind,
          message: `Place ${String(item.placeId)}: ${reason}`,
        });
      }
      byKind[failureKind] += items.length;
    },
    request() {
      embeddingRequests += 1;
    },
    batch() {
      batchesSent += 1;
    },
    limitHeld: 0,
    summaryOnlySkipped: 0,
    get failures(): readonly FailedPlaceReport[] {
      return failures.map((f) => ({ ...f }));
    },
    snapshot() {
      const failedPlacesByKind = { ...byKind };
      const failedPlaces = FailedPlaceKindSchema.options.reduce(
        (sum, kind) => sum + failedPlacesByKind[kind],
        0,
      );
      const detailedPlacesConsidered = unchanged + empty + due;
      return {
        detailedPlacesConsidered,
        placesEmbedded,
        unchangedSkipped: unchanged,
        summaryOnlySkipped: tally.summaryOnlySkipped,
        emptyDocumentsSkipped: empty,
        failedPlaces,
        failedPlacesByKind,
        placesStillDue: detailedPlacesConsidered - placesEmbedded - unchanged - empty,
        batchesSent,
        embeddingRequests,
        tokensUsed,
      };
    },
  };
  return tally;
}

export function formatSummaryText(summary: EmbeddingRunSummary): string {
  const L = EMBED_SUMMARY_LABELS;
  const c = summary.counts;
  const lines: string[] = [
    `${L.outcome}: ${EMBEDDING_OUTCOME_LABELS[summary.outcome]}`,
    `${L.startedAt}: ${summary.startedAt}`,
    `${L.endedAt}: ${summary.endedAt}`,
    `${L.embeddingModel}: ${summary.embeddingModel}`,
    `${L.detailedPlacesConsidered}: ${String(c.detailedPlacesConsidered)}`,
    `${L.placesEmbedded}: ${String(c.placesEmbedded)}`,
    `${L.unchangedSkipped}: ${String(c.unchangedSkipped)}`,
    `${L.summaryOnlySkipped}: ${String(c.summaryOnlySkipped)}`,
    `${L.emptyDocumentsSkipped}: ${String(c.emptyDocumentsSkipped)}`,
    `${L.failedPlaces}: ${String(c.failedPlaces)}`,
    ...FailedPlaceKindSchema.options.map(
      (kind) =>
        `${L.failedPlaces} (${FAILED_PLACE_LABELS[kind]}): ${String(c.failedPlacesByKind[kind])}`,
    ),
    `${L.placesStillDue}: ${String(c.placesStillDue)}`,
    `${L.batchesSent}: ${String(c.batchesSent)}`,
    `${L.embeddingRequests}: ${String(c.embeddingRequests)}`,
    `${L.tokensUsed}: ${String(c.tokensUsed)}`,
  ];
  return lines.join('\n');
}

/** Failed report with zero counts and no Failed Places, built directly (never gated). */
export function failedReport(
  message: string,
  startedAt: string,
  endedAt: string,
): EmbeddingRunReport {
  const summary: EmbeddingRunSummary = {
    outcome: 'failed',
    startedAt,
    endedAt,
    embeddingModel: EMBEDDING_MODEL,
    counts: zeroCounts(),
  };
  return {
    outcome: 'failed',
    message,
    summary,
    summaryText: formatSummaryText(summary),
    failedPlaces: [],
  };
}

export function buildReport(input: ReportInput): EmbeddingRunReport {
  const summary: EmbeddingRunSummary = {
    outcome: input.outcome,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    embeddingModel: EMBEDDING_MODEL,
    counts: input.counts,
  };
  const report: EmbeddingRunReport = {
    outcome: input.outcome,
    ...(input.message !== undefined ? { message: input.message } : {}),
    summary,
    summaryText: formatSummaryText(summary),
    failedPlaces: input.failedPlaces.map((f) => ({ ...f })),
  };
  if (!EmbeddingRunReportSchema.safeParse(report).success) {
    return failedReport(REPORT_CHECK_MESSAGE, input.startedAt, input.endedAt);
  }
  return report;
}
