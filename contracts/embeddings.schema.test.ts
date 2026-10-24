/**
 * AL5 CONTRACT TESTS: Embeddings (custom invariants, pure validators, the Simulated Embedding
 * Service and fixtures).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261023-embeddings-al6.md (the custom rules behind AC-16,
 *           AC-19 .. AC-28, AC-34 .. AC-39, AC-46, AC-47, AC-50, AC-59, AC-60, AC-62; rules 3,
 *           7 .. 10; assumption 9 with the Voyage limits). Plain Zod rules (types, ranges, enums,
 *           strict objects, the settings and read-input bounds) are exercised through the Run and
 *           the Embedding Store in ./embeddings.test.ts, not re-checked here.
 * Enforces: .agrules section 2 (exactly 1024-dim `voyage-4` Embeddings, model name kept,
 *           `inputType: "document"` for stored text, validated service answers), section 4
 *           (fixtures unchanged, synthetic keys only, deterministic fake vectors).
 */
import { readdirSync } from 'node:fs';
import {
  BARE_WEB_ADDRESS,
  DEFAULT_BATCH_TOKEN_LIMIT,
  DEFAULT_EMBEDDING_LIMIT,
  DOCUMENT_INPUT_TYPE,
  DOCUMENT_TOKEN_MARGIN,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_RETRY_WAITS_SECONDS,
  EmbeddingRecordSchema,
  EmbeddingRunCountsSchema,
  EmbeddingRunReportSchema,
  EmbeddingServiceRequestSchema,
  QUERY_INPUT_TYPE,
  SaveEmbeddingRecordsInputSchema,
  VOYAGE_MAX_TEXTS_PER_REQUEST,
  VOYAGE_MAX_TOKENS_PER_REQUEST,
  ZERO_EMBEDDING_COUNTS,
  classifyEmbeddingServiceError,
  documentFingerprint,
  embedExitCodeFor,
  estimateDocumentTokens,
  findBatchIssues,
  findEmbeddingAnswerIssues,
  isEmbeddingDue,
  isValidEmbedding,
  tidySpacing,
  type EmbeddingRecord,
  type EmbeddingRunCounts,
} from './embeddings.schema';
import {
  K_DOCUMENT,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  TEST_VOYAGE_API_KEY,
  byAttempt,
  connectionError,
  fail,
  fakeEmbedding,
  fakeVector,
  normalAnswer,
  rateLimitError,
  refusedError,
} from './embeddings.support';
import { FIXTURE_NAMES, TEST_API_KEY } from './wikimapia-client.support';

const FINGERPRINT_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const K_FINGERPRINT = documentFingerprint(K_DOCUMENT);

function record(change: Partial<EmbeddingRecord> = {}): EmbeddingRecord {
  return {
    placeId: 62587,
    embedding: fakeEmbedding('x'),
    model: EMBEDDING_MODEL,
    documentFingerprint: documentFingerprint('x'),
    embeddedAt: '2026-10-23T09:00:00Z',
    ...change,
  };
}

function counts(change: Partial<EmbeddingRunCounts>): EmbeddingRunCounts {
  return { ...ZERO_EMBEDDING_COUNTS, ...change };
}

// ---------------------------------------------------------------------------
// Voyage limits and the one model (assumption 9, rule 7, Q1, D10, .agrules section 2)
// ---------------------------------------------------------------------------

describe('Voyage facts and defaults (assumption 9, Q1, D10)', () => {
  it.each([
    ['Embedding Model', EMBEDDING_MODEL, 'voyage-4'],
    ['Embedding dimensions', EMBEDDING_DIMENSIONS, 1024],
    ['Document Kind of stored text', DOCUMENT_INPUT_TYPE, 'document'],
    ['Document Kind of search queries', QUERY_INPUT_TYPE, 'query'],
    ['texts per request', VOYAGE_MAX_TEXTS_PER_REQUEST, 1000],
    ['tokens per request', VOYAGE_MAX_TOKENS_PER_REQUEST, 320_000],
    ['default Batch Token Limit', DEFAULT_BATCH_TOKEN_LIMIT, 320_000],
    ['default Embedding Limit', DEFAULT_EMBEDDING_LIMIT, 1000],
    ['retry waits in seconds', [...EMBEDDING_RETRY_WAITS_SECONDS], [30, 60]],
  ] as const)('%s', (_, actual, expected) => {
    expect(actual).toStrictEqual(expected);
  });
});

describe('Embedding gate (rule 7, AC-38, AC-39)', () => {
  it('accepts exactly 1024 finite numbers', () => {
    expect(isValidEmbedding(fakeEmbedding('a'))).toBe(true);
  });

  it.each([
    ['0 numbers', fakeVector(0)],
    ['1023 numbers', fakeVector(1023)],
    ['1025 numbers', fakeVector(1025)],
    ['1536 numbers', fakeVector(1536)],
    ['a NaN value', [...fakeVector(1023), Number.NaN]],
    ['an infinite value', [...fakeVector(1023), Number.POSITIVE_INFINITY]],
  ])('rejects %s', (_, vector) => {
    expect(isValidEmbedding(vector)).toBe(false);
  });
});

describe('Document Fingerprint (AC-16, rule 5)', () => {
  it('is the lower-case hex SHA-256 of the text, the same for the same text', () => {
    expect(documentFingerprint('')).toBe(FINGERPRINT_OF_EMPTY);
    expect(documentFingerprint(K_DOCUMENT.slice())).toBe(K_FINGERPRINT);
  });

  it.each([
    ['a trailing space', `${K_DOCUMENT} `, K_DOCUMENT],
    ['diacritics', 'Đinđić', 'Dindic'],
  ])('any change gives a different one: %s', (_, a, b) => {
    expect(documentFingerprint(a)).not.toBe(documentFingerprint(b));
  });
});

describe('Embedding Record (AC-23, AC-39, AC-45)', () => {
  it('a complete record parses, also of another model (AC-23)', () => {
    expect(EmbeddingRecordSchema.safeParse(record()).success).toBe(true);
    expect(EmbeddingRecordSchema.safeParse(record({ model: 'voyage-3.5' })).success).toBe(true);
  });

  it.each([
    ['1023 numbers', { embedding: fakeVector(1023) }],
    ['an empty model name', { model: '' }],
    ['an upper-case fingerprint', { documentFingerprint: FINGERPRINT_OF_EMPTY.toUpperCase() }],
  ])('rejects %s', (_, change) => {
    expect(EmbeddingRecordSchema.safeParse({ ...record(), ...change }).success).toBe(false);
  });

  it('a Batch save holds each Place once', () => {
    const save = (records: EmbeddingRecord[]) =>
      SaveEmbeddingRecordsInputSchema.safeParse({ records }).success;
    expect(save([record(), record({ placeId: 55 })])).toBe(true);
    expect(save([record(), record()])).toBe(false);
  });
});

describe('Embedding Due (glossary, AC-19 .. AC-24)', () => {
  it.each([
    ['no record', K_DOCUMENT, undefined, true],
    [
      'matching fingerprint and voyage-4',
      K_DOCUMENT,
      { model: EMBEDDING_MODEL, documentFingerprint: K_FINGERPRINT },
      false,
    ],
    [
      'a different fingerprint',
      K_DOCUMENT,
      { model: EMBEDDING_MODEL, documentFingerprint: FINGERPRINT_OF_EMPTY },
      true,
    ],
    [
      'another model',
      K_DOCUMENT,
      { model: 'voyage-3.5', documentFingerprint: K_FINGERPRINT },
      true,
    ],
    ['an Empty Document', '', undefined, false],
  ] as const)('%s -> due %s', (_, document, existing, due) => {
    expect(isEmbeddingDue(document, existing)).toBe(due);
  });
});

// ---------------------------------------------------------------------------
// Place Document rules (rule 3, AC-6 .. AC-9)
// ---------------------------------------------------------------------------

describe('Place Document cleaning rules (AC-6 .. AC-9)', () => {
  const strip = (text: string) => tidySpacing(text.replace(BARE_WEB_ADDRESS, ''));

  it.each([
    ['Visit www.Example.org today', 'Visit today'],
    ['HTTPS://example.org/x', ''],
    ['Info: https://a.rs/b?c=1, http://d.rs', 'Info:'],
    ['Birds go awww. at dusk', 'Birds go awww. at dusk'],
    ['&quot;Трг&quot; &amp; Đinđić', '&quot;Трг&quot; &amp; Đinđić'],
  ])('%j -> %j', (text, expected) => {
    expect(strip(text)).toBe(expected);
  });

  it.each([
    ['\r\n a\t\tb  \n c \r\n', 'a b c'],
    [' \n\t ', ''],
  ])('spacing %j -> %j', (text, expected) => {
    expect(tidySpacing(text)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Batches (AC-27, AC-28) and the size estimate (assumption 9)
// ---------------------------------------------------------------------------

describe('Size estimate (assumption 9)', () => {
  it.each([
    ['', DOCUMENT_TOKEN_MARGIN],
    ['abc', 3 + DOCUMENT_TOKEN_MARGIN],
    ['Трг', 6 + DOCUMENT_TOKEN_MARGIN],
  ])('UTF-8 bytes of %j plus the per-text margin', (text, expected) => {
    expect(estimateDocumentTokens(text)).toBe(expected);
  });
});

describe('Batch split validator (AC-27, AC-28)', () => {
  const docs = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
  const limit = estimateDocumentTokens('dddd') + estimateDocumentTokens('eeeee');
  const long = 'x'.repeat(500);
  const many = Array.from({ length: 1001 }, (_, i) => String(i));

  it.each([
    ['a split in order within the limit', [['a', 'bb'], ['ccc'], ['dddd', 'eeeee']], docs, limit],
    ['a single document over the limit in its own Batch', [[long]], [long], 10],
  ])('accepts %s', (_, batches, documents, tokenLimit) => {
    expect(findBatchIssues(batches, documents, tokenLimit)).toStrictEqual([]);
  });

  it.each([
    ['a document missing', [['a', 'bb'], ['ccc'], ['dddd']], docs, limit],
    [
      'a document twice',
      [
        ['a', 'bb'],
        ['bb', 'ccc'],
        ['dddd', 'eeeee'],
      ],
      docs,
      limit,
    ],
    ['order changed', [['bb', 'a'], ['ccc'], ['dddd', 'eeeee']], docs, limit],
    ['an empty Batch', [['a', 'bb', 'ccc'], [], ['dddd', 'eeeee']], docs, limit],
    ['over the token limit', [docs], docs, limit],
    ['a Batch of 1,001 documents', [many], many, Number.MAX_SAFE_INTEGER],
  ])('rejects %s', (_, batches, documents, tokenLimit) => {
    expect(findBatchIssues(batches, documents, tokenLimit).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The Embedding Service seam (AC-18, AC-26, AC-34 .. AC-38)
// ---------------------------------------------------------------------------

describe('Embedding Request shape (AC-18, .agrules section 2)', () => {
  const ok = { input: ['a'], model: 'voyage-4', inputType: 'document', outputDimension: 1024 };

  it('accepts voyage-4, "document" and 1024 dimensions', () => {
    expect(EmbeddingServiceRequestSchema.safeParse(ok).success).toBe(true);
  });

  it.each([
    ['another model', { model: 'voyage-3.5' }],
    ['Document Kind "query"', { inputType: 'query' }],
    ['another dimension', { outputDimension: 1536 }],
  ])('rejects %s', (_, change) => {
    expect(EmbeddingServiceRequestSchema.safeParse({ ...ok, ...change }).success).toBe(false);
  });
});

describe('Embedding answer validator (AC-26, AC-38)', () => {
  const texts = ['a', 'b', 'c'];
  const reversed = normalAnswer(texts, 30);
  reversed.data.reverse();
  const withEmbeddings = (embedding: number[]) => ({
    ...normalAnswer(texts, 30),
    data: texts.map((_, index) => ({ embedding, index })),
  });

  it.each([
    ['with indexes', normalAnswer(texts, 30)],
    ['without indexes', normalAnswer(texts, 30, false)],
    ['with indexes in any order', reversed],
  ])('a normal answer %s is usable', (_, answer) => {
    expect(findEmbeddingAnswerIssues(answer, 3)).toStrictEqual([]);
  });

  it.each([
    ['2 Embeddings for 3 texts', normalAnswer(['a', 'b'], 20)],
    ['an Embedding of 1023 numbers', withEmbeddings(fakeVector(1023))],
    ['an Embedding of 1025 numbers', withEmbeddings(fakeVector(1025))],
    ['a NaN value', withEmbeddings([...fakeVector(1023), Number.NaN])],
    [
      'duplicate indexes',
      {
        ...normalAnswer(texts, 30),
        data: [0, 0, 1].map((index) => ({ embedding: fakeVector(1024), index })),
      },
    ],
    [
      'only some indexes',
      {
        ...normalAnswer(texts, 30),
        data: [
          { embedding: fakeVector(1024), index: 0 },
          { embedding: fakeVector(1024) },
          { embedding: fakeVector(1024) },
        ],
      },
    ],
    ['another model', { ...normalAnswer(texts, 30), model: 'voyage-3.5' }],
    ['an answer that cannot be read', '<html>Bad gateway</html>'],
  ])('rejects %s', (_, answer) => {
    expect(findEmbeddingAnswerIssues(answer, 3).length).toBeGreaterThan(0);
  });
});

describe('Embedding Service error classification (AC-34 .. AC-37)', () => {
  it.each([
    ['no answer (no status)', connectionError(), 'connection'],
    ['500', { statusCode: 500 }, 'connection'],
    ['408 timeout', { statusCode: 408 }, 'connection'],
    ['429 rate limit', rateLimitError(), 'rate_limit'],
    ['401 refused', refusedError(), 'refused'],
    ['400 bad request', { statusCode: 400 }, 'refused'],
    ['a non-numeric status', { statusCode: '429' }, 'connection'],
  ] as const)('%s -> %s', (_, error, kind) => {
    expect(classifyEmbeddingServiceError(error)).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// Counts, report, exit status (AC-37, AC-40 .. AC-42, AC-46, AC-47, AC-50)
// ---------------------------------------------------------------------------

describe('Run Summary numbers (AC-46, AC-47)', () => {
  const ac47 = counts({
    detailedPlacesConsidered: 4,
    placesEmbedded: 2,
    unchangedSkipped: 1,
    summaryOnlySkipped: 1,
    failedPlaces: 1,
    failedPlacesByKind: { connection: 0, invalid_answer: 1, invalid_data: 0 },
    placesStillDue: 1,
    batchesSent: 2,
    embeddingRequests: 2,
    tokensUsed: 40,
  });

  it('the AC-47 numbers and all-zero counts are consistent', () => {
    expect(EmbeddingRunCountsSchema.safeParse(ac47).success).toBe(true);
    expect(EmbeddingRunCountsSchema.safeParse(ZERO_EMBEDDING_COUNTS).success).toBe(true);
  });

  it.each([
    ['failed total differs from the kinds', { failedPlaces: 2 }],
    ['a considered Place unaccounted for', { detailedPlacesConsidered: 5 }],
    ['more Failed Places than still due', { placesStillDue: 0, detailedPlacesConsidered: 3 }],
    ['more Batches than requests', { batchesSent: 3 }],
    ['more than 3 requests per Batch', { embeddingRequests: 7 }],
  ])('rejects %s', (_, change) => {
    expect(EmbeddingRunCountsSchema.safeParse({ ...ac47, ...change }).success).toBe(false);
  });
});

describe('Run report (AC-37, AC-40 .. AC-42)', () => {
  const summary = {
    outcome: 'failed' as const,
    startedAt: '2026-10-22T09:00:00Z',
    endedAt: '2026-10-22T09:00:00Z',
    embeddingModel: EMBEDDING_MODEL,
    counts: ZERO_EMBEDDING_COUNTS,
  };
  const withoutMessage = {
    outcome: 'failed',
    summary,
    summaryText: 'Run outcome: Failed',
    failedPlaces: [],
  };
  const failed = { ...withoutMessage, message: 'VOYAGE_API_KEY is missing' };

  it('a Failed Run that says why parses', () => {
    expect(EmbeddingRunReportSchema.safeParse(failed).success).toBe(true);
  });

  it.each([
    ['a Failed Run without a message', withoutMessage],
    [
      'a Failed Place report without a counted Failed Place',
      {
        ...failed,
        failedPlaces: [{ placeId: 1, failureKind: 'connection', message: 'place 1: no answer' }],
      },
    ],
  ])('rejects %s', (_, report) => {
    expect(EmbeddingRunReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('Exit status (AC-50)', () => {
  it.each([
    ['completed', 0],
    ['limit_reached', 0],
    ['rate_limited', 0],
    ['failed', 1],
    ['interrupted', 1],
  ] as const)('%s -> %i', (outcome, code) => {
    expect(embedExitCodeFor(outcome)).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// The Simulated Embedding Service (AC-59, AC-60)
// ---------------------------------------------------------------------------

describe('Simulated Embedding Service (glossary, AC-59, AC-60)', () => {
  it('fake Embeddings are deterministic, 1024 numbers, float32-exact, and differ per text', () => {
    const a = fakeEmbedding('Kalemegdan Park');
    expect(a).toStrictEqual(fakeEmbedding('Kalemegdan Park'));
    expect(a).not.toStrictEqual(fakeEmbedding('Square of the Republic'));
    expect(isValidEmbedding(a)).toBe(true);
    expect(a.every((v) => Math.fround(v) === v)).toBe(true);
    expect(a.some((v) => v !== 0)).toBe(true);
  });

  it('answers with the normal answer, records calls and attempts, and fails on request', async () => {
    const clock = new SimulatedEmbeddingClock();
    const service = new SimulatedEmbeddingService(clock, byAttempt(fail(rateLimitError())), 7);
    const request = {
      input: ['a', 'b'],
      model: 'voyage-4' as const,
      inputType: 'document' as const,
      outputDimension: 1024 as const,
    };
    await expect(service.embed(request)).rejects.toMatchObject({ statusCode: 429 });
    await expect(service.embed(request)).rejects.toMatchObject({ statusCode: 429 });
    expect(service.calls.map((c) => c.attempt)).toStrictEqual([1, 2]);

    const normalService = new SimulatedEmbeddingService(clock, undefined, 7);
    const answer = await normalService.embed(request);
    expect(findEmbeddingAnswerIssues(answer, 2)).toStrictEqual([]);
    expect(answer).toMatchObject({ usage: { totalTokens: 7 } });
  });

  it('the synthetic keys are not real-looking secrets of any provider', () => {
    expect(TEST_VOYAGE_API_KEY).toContain('synthetic');
    expect(TEST_API_KEY).toContain('synthetic');
  });
});

describe('AC-62 Fixtures unchanged', () => {
  it('the fixtures folder holds exactly the existing recordings and README; this feature adds none', () => {
    const names = readdirSync(new URL('./fixtures/wikimapia/', import.meta.url)).sort();
    expect(names).toStrictEqual([...FIXTURE_NAMES, 'README.md'].sort());
  });
});
