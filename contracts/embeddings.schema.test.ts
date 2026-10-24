/**
 * AL5 CONTRACT TESTS: Embeddings (schemas, pure validators, the Simulated Embedding Service and
 * fixtures).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261023-embeddings-al6.md (the boundary rules behind AC-16,
 *           AC-26 .. AC-28, AC-36 .. AC-39, AC-41, AC-46, AC-47, AC-50, AC-53, AC-59, AC-60,
 *           AC-62; rules 3, 7 .. 10; assumption 9 with the Voyage limits)
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
  EMBEDDING_TABLE,
  ENTRY_POINT,
  EMBEDDING_STORE_ENTRY_POINT,
  EMBED_COMMAND_ENTRY_POINT,
  EmbeddingCandidatesInputSchema,
  EmbeddingRecordSchema,
  EmbeddingRunCountsSchema,
  EmbeddingRunReportSchema,
  EmbeddingSchema,
  EmbeddingServiceRequestSchema,
  EmbeddingSettingsSchema,
  EMBEDDING_OUTCOME_LABELS,
  EMBED_SUMMARY_LABELS,
  FAILED_PLACE_LABELS,
  PLACE_DOCUMENT_ENTRY_POINT,
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
  unavailableError,
} from './embeddings.support';
import { STORE_TABLES } from './storage.schema';
import { FIXTURE_NAMES, TEST_API_KEY } from './wikimapia-client.support';

const FINGERPRINT_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
// Entry points and fixed names
// ---------------------------------------------------------------------------

describe('Entry points and storage names', () => {
  it('names the modules AL2 must provide', () => {
    expect(ENTRY_POINT).toStrictEqual({
      module: 'src/embed/run-embedding.ts',
      export: 'runEmbedding',
    });
    expect(PLACE_DOCUMENT_ENTRY_POINT.module).toBe('src/embed/place-document.ts');
    expect(EMBED_COMMAND_ENTRY_POINT.module).toBe('src/embed/command.ts');
    expect(EMBEDDING_STORE_ENTRY_POINT.module).toBe('src/db/embedding-store.ts');
  });

  it('the Embedding storage is its own table, not one of the Place Store tables (AC-56)', () => {
    expect(Object.values(STORE_TABLES)).not.toContain(EMBEDDING_TABLE);
  });
});

// ---------------------------------------------------------------------------
// Voyage limits and the one model (assumption 9, rule 7, .agrules section 2)
// ---------------------------------------------------------------------------

describe('Voyage facts and defaults (assumption 9, Q1, D10)', () => {
  it('voyage-4, 1024 dimensions, "document" for stored text, "query" for search', () => {
    expect(EMBEDDING_MODEL).toBe('voyage-4');
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(DOCUMENT_INPUT_TYPE).toBe('document');
    expect(QUERY_INPUT_TYPE).toBe('query');
  });

  it('at most 1,000 texts and 320,000 tokens per request; the default Batch Token Limit is that', () => {
    expect(VOYAGE_MAX_TEXTS_PER_REQUEST).toBe(1000);
    expect(VOYAGE_MAX_TOKENS_PER_REQUEST).toBe(320_000);
    expect(DEFAULT_BATCH_TOKEN_LIMIT).toBeLessThanOrEqual(VOYAGE_MAX_TOKENS_PER_REQUEST);
  });

  it('the default Embedding Limit is 1,000; retries wait 30 then 60 seconds', () => {
    expect(DEFAULT_EMBEDDING_LIMIT).toBe(1000);
    expect([...EMBEDDING_RETRY_WAITS_SECONDS]).toStrictEqual([30, 60]);
  });

  it('a full Batch of typical Place Documents (about 100 characters) stays far below the token limit', () => {
    const typical = 'x'.repeat(100);
    expect(estimateDocumentTokens(typical) * VOYAGE_MAX_TEXTS_PER_REQUEST).toBeLessThan(
      VOYAGE_MAX_TOKENS_PER_REQUEST,
    );
  });
});

describe('Embedding gate (rule 7, AC-38, AC-39)', () => {
  it('accepts exactly 1024 finite numbers', () => {
    expect(isValidEmbedding(fakeEmbedding('a'))).toBe(true);
    expect(EmbeddingSchema.safeParse(fakeVector(1024)).success).toBe(true);
  });

  it.each([0, 256, 1023, 1025, 1536, 2048])('rejects a vector of %i numbers', (length) => {
    expect(isValidEmbedding(fakeVector(length))).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null])(
    'rejects a value %s among the numbers',
    (value) => {
      expect(isValidEmbedding([...fakeVector(1023), value])).toBe(false);
    },
  );
});

describe('Document Fingerprint (AC-16, rule 5)', () => {
  it('is the lower-case hex SHA-256 of the text', () => {
    expect(documentFingerprint('')).toBe(FINGERPRINT_OF_EMPTY);
    expect(documentFingerprint(K_DOCUMENT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same text, same fingerprint; any change, a different one', () => {
    expect(documentFingerprint(K_DOCUMENT)).toBe(documentFingerprint(K_DOCUMENT.slice()));
    expect(documentFingerprint(K_DOCUMENT)).not.toBe(documentFingerprint(`${K_DOCUMENT} `));
    expect(documentFingerprint('Đinđić')).not.toBe(documentFingerprint('Dindic'));
  });
});

describe('Embedding Record (AC-39, AC-45)', () => {
  it('a complete record parses', () => {
    expect(EmbeddingRecordSchema.safeParse(record()).success).toBe(true);
    expect(EmbeddingRecordSchema.safeParse(record({ model: 'voyage-3.5' })).success).toBe(true);
  });

  it.each([
    ['1023 numbers', { embedding: fakeVector(1023) }],
    ['1025 numbers', { embedding: fakeVector(1025) }],
    ['empty model', { model: '' }],
    ['empty fingerprint', { documentFingerprint: '' }],
    ['upper-case fingerprint', { documentFingerprint: FINGERPRINT_OF_EMPTY.toUpperCase() }],
    ['fractional moment', { embeddedAt: '2026-10-23T09:00:00.500Z' }],
  ])('rejects %s', (_, change) => {
    expect(EmbeddingRecordSchema.safeParse({ ...record(), ...change }).success).toBe(false);
  });

  it('rejects a record without a fingerprint or with an unknown key', () => {
    const withoutFingerprint: Partial<EmbeddingRecord> = record();
    delete withoutFingerprint.documentFingerprint;
    expect(EmbeddingRecordSchema.safeParse(withoutFingerprint).success).toBe(false);
    expect(EmbeddingRecordSchema.safeParse({ ...record(), vector: [] }).success).toBe(false);
  });

  it('a Batch save holds 1 .. 1,000 records, each Place once', () => {
    expect(SaveEmbeddingRecordsInputSchema.safeParse({ records: [] }).success).toBe(false);
    expect(
      SaveEmbeddingRecordsInputSchema.safeParse({ records: [record(), record()] }).success,
    ).toBe(false);
    expect(
      SaveEmbeddingRecordsInputSchema.safeParse({ records: [record(), record({ placeId: 55 })] })
        .success,
    ).toBe(true);
  });

  it('a candidates read asks for 1 .. 1,000 Places after a Place ID', () => {
    expect(EmbeddingCandidatesInputSchema.safeParse({ limit: 1000 }).success).toBe(true);
    expect(EmbeddingCandidatesInputSchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(EmbeddingCandidatesInputSchema.safeParse({ limit: 1, afterPlaceId: 0 }).success).toBe(
      false,
    );
  });
});

describe('Embedding Due (glossary, AC-19 .. AC-24)', () => {
  it('no record: due; matching fingerprint and voyage-4: not due', () => {
    expect(isEmbeddingDue(K_DOCUMENT, undefined)).toBe(true);
    expect(
      isEmbeddingDue(K_DOCUMENT, {
        model: EMBEDDING_MODEL,
        documentFingerprint: documentFingerprint(K_DOCUMENT),
      }),
    ).toBe(false);
  });

  it('a different fingerprint or another model: due; an Empty Document: never due', () => {
    expect(
      isEmbeddingDue(K_DOCUMENT, {
        model: EMBEDDING_MODEL,
        documentFingerprint: FINGERPRINT_OF_EMPTY,
      }),
    ).toBe(true);
    expect(
      isEmbeddingDue(K_DOCUMENT, {
        model: 'voyage-3.5',
        documentFingerprint: documentFingerprint(K_DOCUMENT),
      }),
    ).toBe(true);
    expect(isEmbeddingDue('', undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Place Document rules (rule 3, AC-6 .. AC-8)
// ---------------------------------------------------------------------------

describe('Place Document cleaning rules (AC-6 .. AC-9)', () => {
  const strip = (text: string) => tidySpacing(text.replace(BARE_WEB_ADDRESS, ''));

  it.each([
    ['See http://example.org/a for more.', 'See for more.'],
    ['Visit www.Example.org today', 'Visit today'],
    ['HTTPS://example.org/x', ''],
    ['Info: https://a.rs/b?c=1, http://d.rs', 'Info:'],
    ['Birds go awww. at dusk', 'Birds go awww. at dusk'],
    [
      'Old fortress park.\nSee http://example.org/kalemegdan for more.',
      'Old fortress park. See for more.',
    ],
    ['&quot;Трг&quot; &amp; Đinđić', '&quot;Трг&quot; &amp; Đinđić'],
  ])('%j -> %j', (text, expected) => {
    expect(strip(text)).toBe(expected);
  });

  it('spacing runs (CR LF, tabs, spaces) become one space, trimmed', () => {
    expect(tidySpacing('\r\n a\t\tb  \n c \r\n')).toBe('a b c');
    expect(tidySpacing(' \n\t ')).toBe('');
  });

  it('Synthetic Place K document has no line break before the first or after the last Part', () => {
    expect(K_DOCUMENT.split('\n')).toHaveLength(6);
    expect(K_DOCUMENT.startsWith('Kalemegdan Park\n')).toBe(true);
    expect(K_DOCUMENT.endsWith('Comment: Agreed!')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batches (AC-27, AC-28) and the size estimate (assumption 9)
// ---------------------------------------------------------------------------

describe('Size estimate (assumption 9)', () => {
  it('UTF-8 bytes plus the per-text margin', () => {
    expect(estimateDocumentTokens('')).toBe(DOCUMENT_TOKEN_MARGIN);
    expect(estimateDocumentTokens('abc')).toBe(3 + DOCUMENT_TOKEN_MARGIN);
    expect(estimateDocumentTokens('Трг')).toBe(6 + DOCUMENT_TOKEN_MARGIN);
  });
});

describe('Batch split validator (AC-27, AC-28)', () => {
  const docs = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
  const limit = estimateDocumentTokens('dddd') + estimateDocumentTokens('eeeee');

  it('accepts a split in order within the limit', () => {
    expect(findBatchIssues([['a', 'bb'], ['ccc'], ['dddd', 'eeeee']], docs, limit)).toStrictEqual(
      [],
    );
  });

  it('a single document over the limit may form its own Batch', () => {
    expect(findBatchIssues([['x'.repeat(500)]], ['x'.repeat(500)], 10)).toStrictEqual([]);
  });

  it.each([
    ['a document missing', [['a', 'bb'], ['ccc'], ['dddd']]],
    [
      'a document twice',
      [
        ['a', 'bb'],
        ['bb', 'ccc'],
        ['dddd', 'eeeee'],
      ],
    ],
    ['order changed', [['bb', 'a'], ['ccc'], ['dddd', 'eeeee']]],
    ['an empty Batch', [['a', 'bb', 'ccc'], [], ['dddd', 'eeeee']]],
    ['over the token limit', [['a', 'bb', 'ccc', 'dddd', 'eeeee']]],
  ])('rejects %s', (_, batches) => {
    expect(findBatchIssues(batches, docs, limit).length).toBeGreaterThan(0);
  });

  it('rejects a Batch of 1,001 documents', () => {
    const many = Array.from({ length: 1001 }, (_, i) => String(i));
    expect(findBatchIssues([many], many, Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The Embedding Service seam (AC-18, AC-26, AC-34 .. AC-38)
// ---------------------------------------------------------------------------

describe('Embedding Request shape (AC-18, .agrules section 2)', () => {
  const ok = { input: ['a'], model: 'voyage-4', inputType: 'document', outputDimension: 1024 };

  it('accepts voyage-4, "document", 1024, 1 .. 1,000 texts, truncation left out or true', () => {
    expect(EmbeddingServiceRequestSchema.safeParse(ok).success).toBe(true);
    expect(EmbeddingServiceRequestSchema.safeParse({ ...ok, truncation: true }).success).toBe(true);
    expect(
      EmbeddingServiceRequestSchema.safeParse({
        ...ok,
        input: Array.from({ length: 1000 }, () => 'a'),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['another model', { model: 'voyage-3.5' }],
    ['Document Kind "query"', { inputType: 'query' }],
    ['another dimension', { outputDimension: 1536 }],
    ['no text', { input: [] }],
    ['an empty text', { input: [''] }],
    ['1,001 texts', { input: Array.from({ length: 1001 }, () => 'a') }],
    ['truncation false', { truncation: false }],
    ['an unknown key', { encodingFormat: 'base64' }],
  ])('rejects %s', (_, change) => {
    expect(EmbeddingServiceRequestSchema.safeParse({ ...ok, ...change }).success).toBe(false);
  });
});

describe('Embedding answer validator (AC-26, AC-38)', () => {
  const texts = ['a', 'b', 'c'];

  it('a normal answer with or without indexes is usable', () => {
    expect(findEmbeddingAnswerIssues(normalAnswer(texts, 30), 3)).toStrictEqual([]);
    expect(findEmbeddingAnswerIssues(normalAnswer(texts, 30, false), 3)).toStrictEqual([]);
  });

  it('indexes in any order are usable when they are exactly 0 .. n-1', () => {
    const answer = normalAnswer(texts, 30);
    answer.data.reverse();
    expect(findEmbeddingAnswerIssues(answer, 3)).toStrictEqual([]);
  });

  it.each([
    ['2 Embeddings for 3 texts', normalAnswer(['a', 'b'], 20)],
    ['4 Embeddings for 3 texts', normalAnswer(['a', 'b', 'c', 'd'], 40)],
    [
      'an Embedding of 1023 numbers',
      {
        ...normalAnswer(texts, 30),
        data: texts.map((_, index) => ({ embedding: fakeVector(1023), index })),
      },
    ],
    [
      'an Embedding of 1025 numbers',
      {
        ...normalAnswer(texts, 30),
        data: texts.map((_, index) => ({ embedding: fakeVector(1025), index })),
      },
    ],
    [
      'a NaN value',
      {
        ...normalAnswer(texts, 30),
        data: texts.map((_, index) => ({ embedding: [...fakeVector(1023), Number.NaN], index })),
      },
    ],
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
    ['no usage', { data: normalAnswer(texts, 30).data }],
    ['text', '<html>Bad gateway</html>'],
    ['null', null],
    ['an empty object', {}],
  ])('rejects %s', (_, answer) => {
    expect(findEmbeddingAnswerIssues(answer, 3).length).toBeGreaterThan(0);
  });
});

describe('Embedding Service error classification (AC-34 .. AC-37)', () => {
  it.each([
    ['no answer (no status)', connectionError(), 'connection'],
    ['503 unavailable', unavailableError(), 'connection'],
    ['500', { statusCode: 500 }, 'connection'],
    ['408 timeout', { statusCode: 408 }, 'connection'],
    ['429 rate limit', rateLimitError(), 'rate_limit'],
    ['401 refused', refusedError(), 'refused'],
    ['403 forbidden', { statusCode: 403 }, 'refused'],
    ['400 bad request', { statusCode: 400 }, 'refused'],
    ['a thrown string', 'boom', 'connection'],
    ['a non-numeric status', { statusCode: '429' }, 'connection'],
  ] as const)('%s -> %s', (_, error, kind) => {
    expect(classifyEmbeddingServiceError(error)).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// Settings, counts, report, exit status (AC-41, AC-46, AC-47, AC-50)
// ---------------------------------------------------------------------------

describe('Settings (AC-41)', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'Embedding Limit %s is invalid',
    (embeddingLimit) => {
      expect(
        EmbeddingSettingsSchema.safeParse({ embeddingLimit, batchTokenLimit: 1000 }).success,
      ).toBe(false);
    },
  );

  it('whole numbers of at least 1 are valid', () => {
    expect(
      EmbeddingSettingsSchema.safeParse({ embeddingLimit: 1, batchTokenLimit: 1 }).success,
    ).toBe(true);
  });
});

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

  it('the AC-47 numbers are consistent', () => {
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

  it('labels cover every number and every Failed Place kind', () => {
    for (const key of Object.keys(ZERO_EMBEDDING_COUNTS)) {
      if (key === 'failedPlacesByKind') continue;
      expect(Object.keys(EMBED_SUMMARY_LABELS)).toContain(key);
    }
    expect(Object.keys(FAILED_PLACE_LABELS).sort()).toStrictEqual(
      Object.keys(ZERO_EMBEDDING_COUNTS.failedPlacesByKind).sort(),
    );
    expect(Object.keys(EMBEDDING_OUTCOME_LABELS)).toHaveLength(5);
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

  it('a Failed Run must say why', () => {
    const base = {
      outcome: 'failed',
      summary,
      summaryText: 'Run outcome: Failed',
      failedPlaces: [],
    };
    expect(EmbeddingRunReportSchema.safeParse(base).success).toBe(false);
    expect(
      EmbeddingRunReportSchema.safeParse({ ...base, message: 'VOYAGE_API_KEY is missing' }).success,
    ).toBe(true);
  });

  it('one report per Failed Place', () => {
    const base = {
      outcome: 'completed',
      summary: { ...summary, outcome: 'completed' },
      summaryText: 'Run outcome: Completed',
      failedPlaces: [{ placeId: 1, failureKind: 'connection', message: 'place 1: no answer' }],
    };
    expect(EmbeddingRunReportSchema.safeParse(base).success).toBe(false);
  });
});

describe('Exit status (AC-50)', () => {
  it('success for Completed, Limit Reached, Rate Limited; failure for Failed, Interrupted', () => {
    expect(embedExitCodeFor('completed')).toBe(0);
    expect(embedExitCodeFor('limit_reached')).toBe(0);
    expect(embedExitCodeFor('rate_limited')).toBe(0);
    expect(embedExitCodeFor('failed')).toBe(1);
    expect(embedExitCodeFor('interrupted')).toBe(1);
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
