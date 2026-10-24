/**
 * AL2 unit tests: `src/db/validate.ts` (AL4 1.4.4 Input validation). Only what the storage
 * contract tests (`contracts/storage.test.ts`) do not reach: the validators added by later
 * features (hydration, crawl-run1-fixes, embeddings), the never-throw fallback, and the
 * Failure Records union narrowing. Schema rules themselves are pinned by the schema tests.
 */
import {
  validateCrawlProgressInput,
  validateDetailsInput,
  validateEmbeddingCandidatesInput,
  validateExplicitRetriesInput,
  validateFailureRecord,
  validateFailureRecordsInput,
  validatePlacesDueInput,
  validateSaveEmbeddingRecordsInput,
} from '../../src/db/validate';
import type { StoreFailure } from '../../contracts/storage.schema';
import { FETCHED_AT } from '../../contracts/storage.support';
import { RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import { EMBEDDING_MODEL, documentFingerprint } from '../../contracts/embeddings.schema';
import { fakeEmbedding } from '../../contracts/embeddings.support';

type AnyResult = { ok: true; value: unknown } | { ok: false; failure: StoreFailure };
type Validator = (input: unknown) => AnyResult;

function issuePaths(result: AnyResult): unknown[] {
  if (result.ok) throw new Error('expected invalid_data');
  expect(result.failure.kind).toBe('invalid_data');
  return result.failure.kind === 'invalid_data' ? result.failure.issues.map((i) => i.path) : [];
}

const record = {
  placeId: 62587,
  embedding: fakeEmbedding('a'),
  model: EMBEDDING_MODEL,
  documentFingerprint: documentFingerprint('a'),
  embeddedAt: FETCHED_AT,
};
const failureRecord = {
  runId: 7,
  item: { kind: 'place_details', placeId: 900 },
  failureKind: 'wikimapia_error',
  message: 'Place 900: synthetic failure',
  failedAt: '2026-10-22T10:00:00Z',
};

it.each<[string, Validator, object, object, (string | number)[]]>([
  [
    'placesDue',
    validatePlacesDueInput,
    { bbox: SMALL_BBOX, dueBefore: RUN_START },
    { bbox: SMALL_BBOX },
    ['dueBefore'],
  ],
  [
    'crawlProgress',
    validateCrawlProgressInput,
    { regionName: 'test-one' },
    { regionName: 'A b' },
    ['regionName'],
  ],
  [
    'failureRecord',
    validateFailureRecord,
    failureRecord,
    { ...failureRecord, runId: 0 },
    ['runId'],
  ],
  ['explicitRetries', validateExplicitRetriesInput, { regionName: 'test-one' }, {}, ['regionName']],
  [
    'embeddingCandidates',
    validateEmbeddingCandidatesInput,
    { afterPlaceId: 1, limit: 5 },
    { limit: 0 },
    ['limit'],
  ],
  [
    'saveEmbeddingRecords',
    validateSaveEmbeddingRecordsInput,
    { records: [record] },
    { records: [record, { ...record, placeId: 0 }] },
    ['records', 1, 'placeId'],
  ],
])(
  '%s: a parsed copy on success, the issue path on failure',
  (_, validate, valid, invalid, path) => {
    const result = validate(valid);
    expect(result).toStrictEqual({ ok: true, value: valid });
    expect(result.ok && result.value).not.toBe(valid);
    expect(issuePaths(validate(invalid))).toContainEqual(path);
  },
);

const hostile = new Proxy(
  {},
  {
    get: () => {
      throw new Error('proxy blew up');
    },
    ownKeys: () => {
      throw new Error('proxy blew up');
    },
  },
);

it.each<[Validator, string]>([
  [validateDetailsInput, 'input does not have the shape of a Details Save'],
  [validateCrawlProgressInput, 'input does not have the shape of a Crawl Progress query'],
])('a throwing input becomes the fixed whole-input issue (%#)', (validate, message) => {
  expect(validate(hostile)).toStrictEqual({
    ok: false,
    failure: {
      kind: 'invalid_data',
      message: `Invalid data: (whole input): ${message}`,
      issues: [{ path: [], message }],
    },
  });
});

describe('validateFailureRecordsInput: reports the shape the input names', () => {
  it.each<[string, unknown, unknown[]]>([
    ['only placeId', { placeId: 0 }, [['placeId']]],
    ['only runId', { runId: -1 }, [['runId']]],
    ['no shape key', {}, [[]]],
    ['both shape keys', { placeId: 1, runId: 1 }, [[]]],
    ['not an object', 'x', [[]]],
  ])('%s', (_, input, paths) => {
    expect(issuePaths(validateFailureRecordsInput(input))).toStrictEqual(paths);
  });

  it('a valid by-Run query is ok', () => {
    expect(validateFailureRecordsInput({ runId: 7 })).toStrictEqual({
      ok: true,
      value: { runId: 7 },
    });
  });
});
