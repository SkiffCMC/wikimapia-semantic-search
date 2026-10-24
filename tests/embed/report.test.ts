/**
 * AL2 unit tests: the `buildReport` gate (`src/embed/report.ts`, AL4 embeddings 1.4.7). The Run
 * never builds a report the gate refuses, so the contract tests do not reach this branch.
 */
import { buildReport, failedReport } from '../../src/embed/report';
import type { ReportInput } from '../../src/embed/types';
import { ZERO_EMBEDDING_COUNTS } from '../../contracts/embeddings.schema';

const STARTED_AT = '2026-10-23T09:00:00Z';
const ENDED_AT = '2026-10-23T09:05:30Z';
const FAILED_PLACE = { placeId: 1, failureKind: 'connection', message: 'Place 1: lost' } as const;

it.each<[string, Pick<ReportInput, 'outcome' | 'failedPlaces'>]>([
  ['failed without a message', { outcome: 'failed', failedPlaces: [] }],
  ['more Failed Places than counted', { outcome: 'completed', failedPlaces: [FAILED_PLACE] }],
])('%s gives the report-check failedReport', (_label, input) => {
  const report = buildReport({
    ...input,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    counts: ZERO_EMBEDDING_COUNTS,
  });
  expect(report).toStrictEqual(
    failedReport('Embedding run failed: internal error (report check)', STARTED_AT, ENDED_AT),
  );
});
