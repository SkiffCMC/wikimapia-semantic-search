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
  validatePlaceSearchQuery,
  validatePlacesDueInput,
  validateSaveEmbeddingRecordsInput,
} from '../../src/db/validate';
import type { StoreFailure } from '../../contracts/storage.schema';
import { FETCHED_AT } from '../../contracts/storage.support';
import { RUN_START, SMALL_BBOX } from '../../contracts/hydration.support';
import { EMBEDDING_MODEL, documentFingerprint } from '../../contracts/embeddings.schema';
import { fakeEmbedding } from '../../contracts/embeddings.support';
import { MAX_RADIUS_METRES, MAX_RESULT_LIMIT } from '../../contracts/hybrid-search.schema';
import {
  AREA_B,
  POINT_S,
  fakeVector,
  queryEmbeddingQ,
} from '../../contracts/hybrid-search.support';

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

describe('validatePlaceSearchQuery (AL4 hybrid-search 1.4.8)', () => {
  const base = { queryEmbedding: queryEmbeddingQ(), mode: 'exact', limit: MAX_RESULT_LIMIT };
  const radius = { radius: { centre: POINT_S, radiusMetres: MAX_RADIUS_METRES } };
  const area = { area: AREA_B };
  const tags = { tagTitles: ['museum', 'hotel'] };
  const shapes: [string, object][] = [
    ['no filter', {}],
    ['radius', radius],
    ['area', area],
    ['tags', tags],
    ['radius plus tags', { ...radius, ...tags }],
    ['area plus tags', { ...area, ...tags }],
    ['300 tag titles', { tagTitles: Array.from({ length: 300 }, (_, i) => `tag ${String(i)}`) }],
  ];

  it.each(
    (['exact', 'approximate'] as const).flatMap((mode) =>
      shapes.map(([name, extra]): [string, string, object] => [mode, name, extra]),
    ),
  )('%s, %s: a parsed copy', (mode, _, extra) => {
    const query = { ...base, mode, ...extra };
    const result = validatePlaceSearchQuery(query);
    expect(result).toStrictEqual({ ok: true, value: query });
    expect(result.ok && result.value).not.toBe(query);
  });

  const notFinite = queryEmbeddingQ();
  notFinite[7] = Number.POSITIVE_INFINITY;
  const nan = queryEmbeddingQ();
  nan[7] = Number.NaN;

  it.each<[string, object]>([
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: MAX_RESULT_LIMIT + 1 }],
    ['limit 2.5', { limit: 2.5 }],
    ['radius 0', { radius: { centre: POINT_S, radiusMetres: 0 } }],
    ['negative radius', { radius: { centre: POINT_S, radiusMetres: -5 } }],
    ['radius 50,001', { radius: { centre: POINT_S, radiusMetres: MAX_RADIUS_METRES + 1 } }],
    ['bad LatLon', { radius: { centre: { lat: 91, lon: 20.457 }, radiusMetres: 500 } }],
    ['bad AreaFilter', { area: { ...AREA_B, south: AREA_B.north, north: AREA_B.south } }],
    ['radius and area together', { ...radius, ...area }],
    ['empty tagTitles', { tagTitles: [] }],
    ['an empty tag title', { tagTitles: ['museum', ''] }],
    ['a 1023-number vector', { queryEmbedding: fakeVector(1023) }],
    ['a 1025-number vector', { queryEmbedding: fakeVector(1025) }],
    ['an infinite number', { queryEmbedding: notFinite }],
    ['a NaN', { queryEmbedding: nan }],
    ['an unknown mode', { mode: 'fast' }],
  ])('%s is invalid_data', (_, extra) => {
    const result = validatePlaceSearchQuery({ ...base, ...extra });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe('invalid_data');
  });
});
