/**
 * AL2 unit tests: `src/embed/report.ts` (AL4 embeddings 1.4.7, U4; AC-46, AC-47, AC-48 counting
 * side, AC-50). AL3 routing 20261023-embeddings-04-run-core, section 2.1.
 *
 * Pure: no database, no network, no clock, no fixture files. Moments are fixed synthetic dates.
 */
import { buildReport, createTally, failedReport, formatSummaryText } from '../../src/embed/report';
import type { DueItem, Tally } from '../../src/embed/types';
import {
  EMBEDDING_MODEL,
  EMBEDDING_OUTCOME_LABELS,
  EMBED_SUMMARY_LABELS,
  EmbeddingRunCountsSchema,
  EmbeddingRunOutcomeSchema,
  EmbeddingRunReportSchema,
  FAILED_PLACE_LABELS,
  FailedPlaceReportSchema,
  ZERO_EMBEDDING_COUNTS,
  documentFingerprint,
  embedExitCodeFor,
} from '../../contracts/embeddings.schema';
import type {
  EmbeddingRunCounts,
  EmbeddingRunOutcome,
  EmbeddingRunSummary,
  FailedPlaceReport,
} from '../../contracts/embeddings.schema';
import { toMoment } from '../../contracts/hydration.schema';

const STARTED_AT = toMoment(new Date('2026-10-23T09:00:00Z'));
const ENDED_AT = toMoment(new Date('2026-10-23T09:05:30Z'));
const REPORT_CHECK_MESSAGE = 'Embedding run failed: internal error (report check)';
const INVALID_REASON = 'the answer holds 0 embeddings for 1 texts';

function item(placeId: number): DueItem {
  const document = `Name: place ${String(placeId)}`;
  return { placeId, document, fingerprint: documentFingerprint(document) };
}

function considerMany(tally: Tally, kind: 'unchanged' | 'empty' | 'due', count: number): void {
  for (let i = 0; i < count; i += 1) tally.considered(kind);
}

/** The AC-47 scenario replayed on a fresh tally. */
function ac47Tally(): Tally {
  const tally = createTally();
  tally.summaryOnlySkipped = 1;
  considerMany(tally, 'due', 3);
  considerMany(tally, 'unchanged', 1);
  tally.batch();
  tally.request();
  tally.embedded(2, 40);
  tally.batch();
  tally.request();
  tally.failed([item(1381893)], 'invalid_answer', INVALID_REASON);
  return tally;
}

const AC47_COUNTS: EmbeddingRunCounts = {
  detailedPlacesConsidered: 4,
  placesEmbedded: 2,
  unchangedSkipped: 1,
  summaryOnlySkipped: 1,
  emptyDocumentsSkipped: 0,
  failedPlaces: 1,
  failedPlacesByKind: { connection: 0, invalid_answer: 1, invalid_data: 0 },
  placesStillDue: 1,
  batchesSent: 2,
  embeddingRequests: 2,
  tokensUsed: 40,
};

/** Self-consistent counts with a distinct number in every field. */
const DISTINCT_COUNTS: EmbeddingRunCounts = {
  detailedPlacesConsidered: 40,
  placesEmbedded: 10,
  unchangedSkipped: 11,
  summaryOnlySkipped: 13,
  emptyDocumentsSkipped: 12,
  failedPlaces: 6,
  failedPlacesByKind: { connection: 1, invalid_answer: 2, invalid_data: 3 },
  placesStillDue: 7,
  batchesSent: 8,
  embeddingRequests: 9,
  tokensUsed: 12345,
};

function summaryWith(
  outcome: EmbeddingRunOutcome,
  counts: EmbeddingRunCounts,
): EmbeddingRunSummary {
  return {
    outcome,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    embeddingModel: EMBEDDING_MODEL,
    counts,
  };
}

function failureReports(count: number): FailedPlaceReport[] {
  return Array.from({ length: count }, (_, i) => ({
    placeId: 500 + i,
    failureKind: 'connection',
    message: `Place ${String(500 + i)}: connection failure after 3 tries`,
  }));
}

describe('createTally: a fresh tally', () => {
  it('has zero counts, no failures and nothing held back', () => {
    const tally = createTally();
    expect(tally.snapshot()).toStrictEqual(ZERO_EMBEDDING_COUNTS);
    expect(tally.failures).toStrictEqual([]);
    expect(tally.limitHeld).toBe(0);
    expect(tally.summaryOnlySkipped).toBe(0);
  });

  it('every createTally has its own state', () => {
    const a = createTally();
    a.considered('due');
    a.failed([item(7)], 'connection', 'connection failure after 3 tries');
    const b = createTally();
    expect(b.snapshot()).toStrictEqual(ZERO_EMBEDDING_COUNTS);
    expect(b.failures).toStrictEqual([]);
  });
});

describe('AC-47 counts are exact', () => {
  it('the replayed scenario gives exactly the contract counts', () => {
    const counts = ac47Tally().snapshot();
    expect(counts).toStrictEqual(AC47_COUNTS);
    expect(EmbeddingRunCountsSchema.safeParse(counts).success).toBe(true);
  });

  it('the Failed Place is reported with its id, kind and `Place <id>: <reason>`', () => {
    const failures = ac47Tally().failures;
    expect(failures).toStrictEqual([
      {
        placeId: 1381893,
        failureKind: 'invalid_answer',
        message: `Place 1381893: ${INVALID_REASON}`,
      },
    ]);
    for (const f of failures) expect(FailedPlaceReportSchema.safeParse(f).success).toBe(true);
  });
});

describe('derived counts', () => {
  it('placesStillDue covers Places never sent: 5 due, 3 embedded -> 2 still due', () => {
    const tally = createTally();
    considerMany(tally, 'due', 5);
    tally.batch();
    tally.request();
    tally.embedded(3, 30);
    const counts = tally.snapshot();
    expect(counts.detailedPlacesConsidered).toBe(5);
    expect(counts.placesEmbedded).toBe(3);
    expect(counts.placesStillDue).toBe(2);
    expect(counts.failedPlaces).toBe(0);
    expect(EmbeddingRunCountsSchema.safeParse(counts).success).toBe(true);
  });

  it('failedPlaces is the sum of every kind; Failed Places stay due; order is kept', () => {
    const tally = createTally();
    considerMany(tally, 'due', 6);
    tally.batch();
    tally.request();
    tally.request();
    tally.request();
    tally.failed([item(30), item(10)], 'connection', 'connection failure after 3 tries');
    tally.batch();
    tally.request();
    tally.failed([item(40)], 'invalid_answer', INVALID_REASON);
    tally.batch();
    tally.request();
    tally.failed([item(20), item(50), item(60)], 'invalid_data', 'the Place Store rejected it');
    const counts = tally.snapshot();
    expect(counts.failedPlacesByKind).toStrictEqual({
      connection: 2,
      invalid_answer: 1,
      invalid_data: 3,
    });
    expect(counts.failedPlaces).toBe(6);
    expect(counts.placesStillDue).toBe(6);
    expect(EmbeddingRunCountsSchema.safeParse(counts).success).toBe(true);
    expect(tally.failures.map((f) => f.placeId)).toStrictEqual([30, 10, 40, 20, 50, 60]);
    expect(tally.failures.map((f) => f.failureKind)).toStrictEqual([
      'connection',
      'connection',
      'invalid_answer',
      'invalid_data',
      'invalid_data',
      'invalid_data',
    ]);
    expect(tally.failures.map((f) => f.message)).toStrictEqual([
      'Place 30: connection failure after 3 tries',
      'Place 10: connection failure after 3 tries',
      `Place 40: ${INVALID_REASON}`,
      'Place 20: the Place Store rejected it',
      'Place 50: the Place Store rejected it',
      'Place 60: the Place Store rejected it',
    ]);
  });

  it('empty considerations count in emptyDocumentsSkipped and are not still due', () => {
    const tally = createTally();
    considerMany(tally, 'empty', 2);
    considerMany(tally, 'unchanged', 3);
    considerMany(tally, 'due', 1);
    const counts = tally.snapshot();
    expect(counts.emptyDocumentsSkipped).toBe(2);
    expect(counts.unchangedSkipped).toBe(3);
    expect(counts.detailedPlacesConsidered).toBe(6);
    expect(counts.placesStillDue).toBe(1);
    expect(EmbeddingRunCountsSchema.safeParse(counts).success).toBe(true);
  });

  it('a retried Batch (1 batch, 3 requests) passes the counts schema', () => {
    const tally = createTally();
    considerMany(tally, 'due', 2);
    tally.batch();
    tally.request();
    tally.request();
    tally.request();
    tally.embedded(2, 17);
    const counts = tally.snapshot();
    expect(counts.batchesSent).toBe(1);
    expect(counts.embeddingRequests).toBe(3);
    expect(counts.tokensUsed).toBe(17);
    expect(EmbeddingRunCountsSchema.safeParse(counts).success).toBe(true);
  });

  it('tokens add up over kept answers', () => {
    const tally = createTally();
    considerMany(tally, 'due', 2);
    tally.batch();
    tally.request();
    tally.embedded(1, 120);
    tally.batch();
    tally.request();
    tally.embedded(1, 75);
    expect(tally.snapshot().tokensUsed).toBe(195);
  });

  it('limitHeld is a plain counter and does not change the snapshot', () => {
    const tally = createTally();
    considerMany(tally, 'due', 3);
    const before = tally.snapshot();
    tally.limitHeld += 2;
    expect(tally.limitHeld).toBe(2);
    expect(tally.snapshot()).toStrictEqual(before);
  });

  it('summaryOnlySkipped is shown in the snapshot only', () => {
    const tally = createTally();
    tally.summaryOnlySkipped = 9;
    const counts = tally.snapshot();
    expect(counts.summaryOnlySkipped).toBe(9);
    expect(counts.detailedPlacesConsidered).toBe(0);
    expect(counts.placesStillDue).toBe(0);
  });
});

describe('formatSummaryText (AC-46)', () => {
  it('gives exactly the 17 lines of AL4 1.4.7 in order', () => {
    const summary = summaryWith('completed', DISTINCT_COUNTS);
    const L = EMBED_SUMMARY_LABELS;
    expect(formatSummaryText(summary).split('\n')).toStrictEqual([
      `${L.outcome}: ${EMBEDDING_OUTCOME_LABELS.completed}`,
      `${L.startedAt}: ${STARTED_AT}`,
      `${L.endedAt}: ${ENDED_AT}`,
      `${L.embeddingModel}: ${EMBEDDING_MODEL}`,
      `${L.detailedPlacesConsidered}: 40`,
      `${L.placesEmbedded}: 10`,
      `${L.unchangedSkipped}: 11`,
      `${L.summaryOnlySkipped}: 13`,
      `${L.emptyDocumentsSkipped}: 12`,
      `${L.failedPlaces}: 6`,
      `${L.failedPlaces} (${FAILED_PLACE_LABELS.connection}): 1`,
      `${L.failedPlaces} (${FAILED_PLACE_LABELS.invalid_answer}): 2`,
      `${L.failedPlaces} (${FAILED_PLACE_LABELS.invalid_data}): 3`,
      `${L.placesStillDue}: 7`,
      `${L.batchesSent}: 8`,
      `${L.embeddingRequests}: 9`,
      `${L.tokensUsed}: 12345`,
    ]);
  });

  it('the literal text of the first and model lines', () => {
    const lines = formatSummaryText(summaryWith('completed', DISTINCT_COUNTS)).split('\n');
    expect(lines[0]).toBe('Run outcome: Completed');
    expect(lines[3]).toBe('Embedding model: voyage-4');
  });

  it('has no leading or trailing newline', () => {
    const text = formatSummaryText(summaryWith('completed', ZERO_EMBEDDING_COUNTS));
    expect(text.startsWith('\n')).toBe(false);
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')).toHaveLength(17);
  });

  it.each(EmbeddingRunOutcomeSchema.options)('outcome %s shows its label', (outcome) => {
    const lines = formatSummaryText(summaryWith(outcome, ZERO_EMBEDDING_COUNTS)).split('\n');
    expect(lines[0]).toBe(`${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS[outcome]}`);
  });
});

describe('buildReport', () => {
  it('completed: passes the report schema with the model, the summary text and no message', () => {
    const counts = ac47Tally().snapshot();
    const failedPlaces = ac47Tally().failures;
    const report = buildReport({
      outcome: 'completed',
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts,
      failedPlaces,
    });
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.outcome).toBe('completed');
    expect(report.summary).toStrictEqual(summaryWith('completed', AC47_COUNTS));
    expect(report.summary.embeddingModel).toBe(EMBEDDING_MODEL);
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
    expect(report.failedPlaces).toStrictEqual([...failedPlaces]);
    expect('message' in report).toBe(false);
  });

  it('limit_reached: passes the report schema', () => {
    const tally = createTally();
    considerMany(tally, 'due', 5);
    tally.batch();
    tally.request();
    tally.embedded(3, 30);
    const report = buildReport({
      outcome: 'limit_reached',
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts: tally.snapshot(),
      failedPlaces: tally.failures,
    });
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.outcome).toBe('limit_reached');
    expect(report.summary.counts.placesStillDue).toBe(2);
    expect('message' in report).toBe(false);
  });

  it('failed with a message: passes the schema; the message is kept and not in summaryText', () => {
    const message = 'The Embedding Service refused the request (HTTP 401).';
    const report = buildReport({
      outcome: 'failed',
      message,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts: ZERO_EMBEDDING_COUNTS,
      failedPlaces: [],
    });
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.outcome).toBe('failed');
    expect(report.message).toBe(message);
    expect(report.summaryText).not.toContain(message);
    expect(report.summaryText.split('\n')[0]).toBe('Run outcome: Failed');
  });

  it('a message on another outcome is kept and not in summaryText', () => {
    const message = 'Operator interrupted the run';
    const report = buildReport({
      outcome: 'interrupted',
      message,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts: ZERO_EMBEDDING_COUNTS,
      failedPlaces: [],
    });
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.message).toBe(message);
    expect(report.summaryText).not.toContain(message);
  });

  it('reports the given Failed Places when they match the counts', () => {
    const failedPlaces = failureReports(1);
    const counts: EmbeddingRunCounts = {
      ...ZERO_EMBEDDING_COUNTS,
      detailedPlacesConsidered: 1,
      failedPlaces: 1,
      failedPlacesByKind: { connection: 1, invalid_answer: 0, invalid_data: 0 },
      placesStillDue: 1,
      batchesSent: 1,
      embeddingRequests: 3,
    };
    const report = buildReport({
      outcome: 'completed',
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts,
      failedPlaces,
    });
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.failedPlaces).toStrictEqual(failedPlaces);
  });
});

describe('buildReport gate', () => {
  function expectReportCheckFailure(
    report: ReturnType<typeof buildReport>,
    startedAt: string,
    endedAt: string,
  ): void {
    expect(report.outcome).toBe('failed');
    expect(report.message).toBe(REPORT_CHECK_MESSAGE);
    expect(report.summary.counts).toStrictEqual(ZERO_EMBEDDING_COUNTS);
    expect(report.failedPlaces).toStrictEqual([]);
    expect(report.summary.startedAt).toBe(startedAt);
    expect(report.summary.endedAt).toBe(endedAt);
  }

  it('failed without a message returns the report-check failedReport', () => {
    const report = buildReport({
      outcome: 'failed',
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts: AC47_COUNTS,
      failedPlaces: failureReports(1),
    });
    expectReportCheckFailure(report, STARTED_AT, ENDED_AT);
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
  });

  it('failedPlaces length not equal to counts.failedPlaces returns the report-check failedReport', () => {
    const report = buildReport({
      outcome: 'completed',
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts: ZERO_EMBEDDING_COUNTS,
      failedPlaces: failureReports(1),
    });
    expectReportCheckFailure(report, STARTED_AT, ENDED_AT);
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
  });

  it('endedAt before startedAt returns the report-check failedReport with the given moments', () => {
    // AL4 1.4.7 passes the given moments on to failedReport. With endedAt before startedAt the
    // result cannot pass EmbeddingRunReportSchema (EmbeddingRunSummarySchema refines the order),
    // so the schema is not asserted here (reported as an AL4 gap).
    const report = buildReport({
      outcome: 'completed',
      startedAt: ENDED_AT,
      endedAt: STARTED_AT,
      counts: ZERO_EMBEDDING_COUNTS,
      failedPlaces: [],
    });
    expectReportCheckFailure(report, ENDED_AT, STARTED_AT);
  });
});

describe('failedReport', () => {
  it('has outcome failed, the message, zero counts, no Failed Places and the moments', () => {
    const report = failedReport('Embedding Service key is missing.', STARTED_AT, ENDED_AT);
    expect(report.outcome).toBe('failed');
    expect(report.message).toBe('Embedding Service key is missing.');
    expect(report.summary.outcome).toBe('failed');
    expect(report.summary.counts).toStrictEqual(ZERO_EMBEDDING_COUNTS);
    expect(report.summary.embeddingModel).toBe(EMBEDDING_MODEL);
    expect(report.failedPlaces).toStrictEqual([]);
    expect(report.summary.startedAt).toBe(STARTED_AT);
    expect(report.summary.endedAt).toBe(ENDED_AT);
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.summaryText).toBe(formatSummaryText(report.summary));
    expect(report.summaryText.split('\n')).toContain('Run outcome: Failed');
    expect(report.summaryText).not.toContain('Embedding Service key is missing.');
  });

  it('one moment for both start and end passes the schema', () => {
    const report = failedReport(
      'Invalid embedding setting "embeddingLimit": x',
      STARTED_AT,
      STARTED_AT,
    );
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.summary.startedAt).toBe(STARTED_AT);
    expect(report.summary.endedAt).toBe(STARTED_AT);
  });
});

describe('AC-50 exit codes of built reports', () => {
  it.each([
    ['completed', 0],
    ['limit_reached', 0],
    ['rate_limited', 0],
    ['failed', 1],
    ['interrupted', 1],
  ] as const)('%s -> %i', (outcome, code) => {
    const report = buildReport({
      outcome,
      ...(outcome === 'failed' ? { message: 'Place Store unavailable' } : {}),
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      counts: ZERO_EMBEDDING_COUNTS,
      failedPlaces: [],
    });
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(true);
    expect(report.outcome).toBe(outcome);
    expect(embedExitCodeFor(report.outcome)).toBe(code);
  });
});
