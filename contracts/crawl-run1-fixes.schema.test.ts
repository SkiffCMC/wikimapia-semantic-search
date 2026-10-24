/**
 * AL5 CONTRACT TESTS: Crawl Run 1 fixes (schemas, pure validators and fixtures).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261022-crawl-run1-fixes-al6.md (AC-43, AC-44 fixtures; the
 *           boundary rules behind AC-8 .. AC-13, AC-15 .. AC-19, AC-24, AC-26, AC-29 .. AC-40;
 *           rules 3, 6 .. 9)
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (recorded fixtures trimmed,
 *           credited, without API key or Commenter IPs; reconstructed fixtures marked).
 *
 * Plain Zod rules (types, required items, strict objects, enums) are not re-checked here. The
 * Tags rules of AC-3 .. AC-5 are asserted through the real Client in ./crawl-run1-fixes.test.ts.
 */
import {
  CRAWL_ITEM_FAILURES_COLUMNS,
  CRAWL_ITEM_FAILURES_TABLE,
  ENTRY_POINT,
  ExplicitRetriesValueSchema,
  FailureRecordsValueSchema,
  PARKING_COUNTED_KINDS,
  PARKING_THRESHOLD,
  countResetOf,
  countedFailures,
  isParkedPlace,
  parkingKindOf,
  type FailureRecord,
} from './crawl-run1-fixes.schema';
import {
  CLEAN_STOP_OUTCOMES,
  CRAWL_COMMAND_OPTIONS,
  ITEM_FAILURE_LABELS,
  ItemFailureKindSchema,
  OUTCOME_LABELS,
  RunCountsSchema,
  RunOutcomeSchema,
  RunRecordStatusSchema,
  RunReportSchema,
  SUMMARY_LABELS,
  ZERO_RUN_COUNTS,
  exitCodeFor,
  type ItemFailureKind,
} from './hydration.schema';
import {
  RawDebugResponseSchema,
  classifyDebugResponse,
  findCommenterIpPaths,
} from './wikimapia-client.schema';
import { KEY_QUOTA_BODY, fixtureText, type FixtureName } from './wikimapia-client.support';

function readmeSection(heading: string): string {
  const readme = fixtureText('README.md');
  const start = readme.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  return readme.slice(start);
}

function debugOf(text: string) {
  return RawDebugResponseSchema.parse(JSON.parse(text)).debug;
}

function record(
  placeId: number,
  failureKind: ItemFailureKind,
  failedAt: string,
  runId = 1,
): FailureRecord {
  return {
    runId,
    item: { kind: 'place_details', placeId },
    failureKind,
    message: `place ${String(placeId)}: ${failureKind}`,
    failedAt,
  };
}

const H = (hour: number) => `2026-10-22T${String(hour).padStart(2, '0')}:00:00Z`;

// ===========================================================================
// Fixtures (AC-43, AC-44)
// ===========================================================================

describe('AC-43 New Recorded fixtures', () => {
  it.each([
    ['getbyid-1391132-no-tags.json', true],
    ['getbyid-8918979-no-tags.json', false],
  ] as const)(
    '%s keeps the Tags item missing and the Wikipedia item as recorded (empty text: %s)',
    (name, hasEmptyWikipedia) => {
      const json: unknown = JSON.parse(fixtureText(name));
      expect(json).not.toHaveProperty('tags');
      if (hasEmptyWikipedia) expect(json).toHaveProperty('wikipedia', '');
      else expect(json).not.toHaveProperty('wikipedia');
    },
  );

  it.each<FixtureName>([
    'getbyid-1391132-no-tags.json',
    'getbyid-8918979-no-tags.json',
    'debug-key-quota.json',
  ])('%s contains no API Key, request address or Commenter IP', (name) => {
    const text = fixtureText(name);
    expect(findCommenterIpPaths(JSON.parse(text))).toStrictEqual([]);
    expect(text).not.toMatch(/user_?ip/i);
    expect(text).not.toMatch(/[?&]key=/);
    expect(text).not.toMatch(/api\.wikimapia\.org/);
  });

  it('the README lists both as Run 1 recordings with their source and trimming, under the CC BY-NC-SA 3.0 credit', () => {
    const readme = fixtureText('README.md');
    expect(readme).toContain('CC BY-NC-SA 3.0');
    const section = readmeSection('Run 1 of `belgrade-small` (2026-10-22)');
    const recordedPart = section.slice(0, section.indexOf('## Reconstructed fixtures'));
    for (const [file, source] of [
      ['getbyid-1391132-no-tags.json', 'getbyid-belgrade-1391132-no-tags.json'],
      ['getbyid-8918979-no-tags.json', 'getbyid-belgrade-8918979-no-tags.json'],
    ] as const) {
      expect(recordedPart).toContain(file);
      expect(recordedPart).toContain(source);
    }
  });

  it('the README lists the in-memory Tags variants of AC-3, AC-4, AC-5 and AC-7', () => {
    const variants = readmeSection('### Reconstructed variants derived in memory');
    for (const entry of [
      'Tags missing (from 1381893)',
      'Tags as an empty list',
      'Tags as null',
      'Tags of the wrong kind',
      'Title removed (no tags)',
    ]) {
      expect(variants).toContain(entry);
    }
  });
});

describe('AC-44 Key Quota fixture', () => {
  it('has exactly the body quoted in CLAUDE.md and the AL7', () => {
    const body = '{"debug":{"code":1004,"message":"Key limit has been reached"}}';
    expect(JSON.stringify(JSON.parse(fixtureText('debug-key-quota.json')))).toBe(body);
    expect(KEY_QUOTA_BODY).toBe(body);
  });

  it('is marked in the README as reconstructed from documentation, with its in-memory variants', () => {
    const reconstructed = readmeSection('## Reconstructed fixtures');
    expect(reconstructed).toContain('debug-key-quota.json');
    const row = reconstructed.slice(reconstructed.indexOf('`debug-key-quota.json`'));
    expect(row.slice(0, row.indexOf('\n'))).toMatch(/Documentation only/);
    const variants = readmeSection('### Reconstructed variants derived in memory');
    for (const entry of [
      'Key Quota message changed',
      'Key Quota code changed',
      'Key Quota code removed',
    ]) {
      expect(variants).toContain(entry);
    }
  });
});

// ===========================================================================
// Client: Key Quota recognition (AC-8 .. AC-13; Client AC-32 and rule 5 as amended)
// ===========================================================================

const RATE_LIMIT_WORDING =
  'You have reached the limit for this action. You need to wait for 7 seconds.';
const KEY_LIMIT = 'Key limit has been reached';

describe('Client: Key Quota recognition (AC-8 .. AC-13, rule 3, Q8)', () => {
  it.each([
    [
      'the Key Quota fixture',
      debugOf(KEY_QUOTA_BODY),
      { kind: 'key_quota', code: 1004, message: KEY_LIMIT },
    ],
    [
      'code 1004 with an empty message (AC-12)',
      { code: 1004, message: '' },
      { kind: 'key_quota', code: 1004, message: '' },
    ],
    [
      'code 1004 with the rate-limit wording (AC-12)',
      { code: 1004, message: RATE_LIMIT_WORDING },
      { kind: 'key_quota', code: 1004, message: RATE_LIMIT_WORDING },
    ],
    [
      'code 1004 sent as text',
      { code: '1004', message: 'x' },
      { kind: 'key_quota', code: 1004, message: 'x' },
    ],
    [
      'debug-error.json (AC-13)',
      debugOf(fixtureText('debug-error.json')),
      { kind: 'wikimapia_error', message: 'Invalid API key.' },
    ],
    [
      'the Key Quota message with code 1003 (AC-13)',
      { code: 1003, message: KEY_LIMIT },
      { kind: 'wikimapia_error', message: KEY_LIMIT },
    ],
    [
      'the Key Quota message without a code (AC-13, Q8)',
      { message: KEY_LIMIT },
      { kind: 'wikimapia_error', message: KEY_LIMIT },
    ],
    [
      'debug-rate-limit.json, no code (unchanged)',
      debugOf(fixtureText('debug-rate-limit.json')),
      { kind: 'rate_limit', waitSeconds: 7 },
    ],
    [
      'a rate-limit wording without seconds (unchanged)',
      { message: 'You need to wait for a few seconds.' },
      { kind: 'rate_limit' },
    ],
  ])('%s', (_, debug, expected) => {
    expect(classifyDebugResponse(debug)).toStrictEqual(expected);
  });
});

// ===========================================================================
// Crawl schemas (AC-15 .. AC-19, AC-39, AC-40; Hydration AC-45, AC-50, AC-53, AC-59 amended)
// ===========================================================================

describe('Run Outcome Quota Exhausted (AC-15 .. AC-19, AC-24, Q4, Q7)', () => {
  it('is a Run Outcome and Run Record status, a Clean Stop labelled "Quota Exhausted" with exit status success, and not an Item Failure kind', () => {
    expect(RunOutcomeSchema.options).toContain('quota_exhausted');
    expect(RunRecordStatusSchema.options).toContain('quota_exhausted');
    expect(CLEAN_STOP_OUTCOMES).toContain('quota_exhausted');
    expect(OUTCOME_LABELS.quota_exhausted).toBe('Quota Exhausted');
    expect(exitCodeFor('quota_exhausted')).toBe(0);
    expect(ItemFailureKindSchema.options).not.toContain('key_quota_exhausted');
    expect(Object.keys(ITEM_FAILURE_LABELS)).not.toContain('key_quota_exhausted');
  });
});

describe('Run Summary additions (AC-39)', () => {
  it('the counts carry parked, skipped and released Places, all zero by default', () => {
    expect(ZERO_RUN_COUNTS).toMatchObject({
      placesParkedThisRun: 0,
      placesParked: 0,
      placesReleased: 0,
    });
  });

  it.each([
    [1, 1, true],
    [2, 1, false],
  ])(
    '%i parked this Run with %i Parked at its end: valid %s',
    (placesParkedThisRun, placesParked, valid) => {
      expect(
        RunCountsSchema.safeParse({ ...ZERO_RUN_COUNTS, placesParkedThisRun, placesParked })
          .success,
      ).toBe(valid);
    },
  );

  it('each new item has its own label', () => {
    const labels = [
      SUMMARY_LABELS.placesParkedThisRun,
      SUMMARY_LABELS.placesParked,
      SUMMARY_LABELS.placesReleased,
      SUMMARY_LABELS.wikimapiaMessage,
    ];
    expect(new Set(Object.values(SUMMARY_LABELS)).size).toBe(Object.values(SUMMARY_LABELS).length);
    for (const label of labels) expect(label).toMatch(/^[A-Z][^:{}[\]"]*$/);
  });
});

describe('Explicit Retry option (AC-37, AC-40, Q5)', () => {
  it('is the command option `--retry-parked`', () => {
    expect(CRAWL_COMMAND_OPTIONS.retryParked).toBe('--retry-parked');
  });

  it('the parked count is reported for a Dry Run only', () => {
    const summary = {
      regionName: 'belgrade-small',
      outcome: 'planned' as const,
      startedAt: '2026-10-22T09:00:00Z',
      endedAt: '2026-10-22T09:00:00Z',
      counts: ZERO_RUN_COUNTS,
    };
    const bbox = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 };
    const plan = {
      regionName: 'belgrade-small',
      bbox,
      tileSize: { width: 0.02, height: 0.02 },
      columns: 1,
      rows: 1,
      tiles: [{ tileNumber: 1, bbox }],
    };
    const report = {
      outcome: 'planned' as const,
      summary,
      summaryText: 'Run outcome: Planned',
      itemFailures: [],
      parkedPlacesInRegion: 1,
    };
    expect(RunReportSchema.safeParse({ ...report, plan }).success).toBe(true);
    expect(
      RunReportSchema.safeParse({
        ...report,
        outcome: 'completed',
        summary: { ...summary, outcome: 'completed' },
      }).success,
    ).toBe(false);
  });
});

// ===========================================================================
// Failure Records and Explicit Retries (AC-21, AC-26, AC-37, section 5.3)
// ===========================================================================

describe('Failure Record and Explicit Retry storage (AC-21, AC-26, AC-37)', () => {
  it('the stakeholder-named table and its columns (section 5.3)', () => {
    expect(CRAWL_ITEM_FAILURES_TABLE).toBe('crawl_item_failures');
    expect(CRAWL_ITEM_FAILURES_COLUMNS).toStrictEqual([
      'run_id',
      'place_id',
      'tile_number',
      'page_no',
      'failure_kind',
      'message',
      'failed_at',
    ]);
    expect(ENTRY_POINT).toStrictEqual({
      module: 'src/db/crawl-store.ts',
      export: 'createCrawlStore',
    });
  });

  const failures = [record(900, 'wikimapia_error', H(9)), record(900, 'wikimapia_error', H(10))];
  const retry = { runId: 7, regionName: 'test-one', placesReleased: 2 };
  const retries = [
    { ...retry, retriedAt: H(15) },
    { ...retry, retriedAt: H(16) },
  ];

  it.each([
    ['Failure Records oldest first', true],
    ['Failure Records newest first', false],
  ])('%s: valid %s', (_, oldestFirst) => {
    const records = oldestFirst ? failures : [...failures].reverse();
    expect(FailureRecordsValueSchema.safeParse({ records }).success).toBe(oldestFirst);
  });

  it.each([
    ['Explicit Retries oldest first', true],
    ['Explicit Retries newest first', false],
  ])('%s: valid %s', (_, oldestFirst) => {
    const list = oldestFirst ? retries : [...retries].reverse();
    expect(ExplicitRetriesValueSchema.safeParse({ retries: list }).success).toBe(oldestFirst);
  });
});

// ===========================================================================
// Parking rules (AC-29 .. AC-38, decisions Q1 .. Q3, Q6)
// ===========================================================================

describe('Parking rules (pure)', () => {
  it('threshold 3; Connection Failures do not count (Q3)', () => {
    expect(PARKING_THRESHOLD).toBe(3);
    expect([...PARKING_COUNTED_KINDS].sort()).toStrictEqual(
      ['invalid_data', 'invalid_request', 'unexpected_response', 'wikimapia_error'].sort(),
    );
  });

  const failuresAt = (kind: ItemFailureKind, ...hours: number[]) =>
    hours.map((h) => record(900, kind, H(h)));
  const alternating = [
    record(900, 'wikimapia_error', H(9)),
    record(900, 'unexpected_response', H(10)),
    record(900, 'wikimapia_error', H(11)),
    record(900, 'unexpected_response', H(12)),
  ];
  const listing: FailureRecord[] = [9, 10, 11].map((h) => ({
    runId: h,
    item: { kind: 'listing_page', tileNumber: 1, page: 1 },
    failureKind: 'wikimapia_error',
    message: 'tile 1 page 1: Wikimapia error',
    failedAt: H(h),
  }));

  it.each<[string, FailureRecord[], number, string | undefined, ItemFailureKind | undefined]>([
    [
      'AC-29: two Wikimapia Errors',
      failuresAt('wikimapia_error', 9, 10),
      900,
      undefined,
      undefined,
    ],
    [
      'AC-29: the third Wikimapia Error',
      failuresAt('wikimapia_error', 9, 10, 11),
      900,
      undefined,
      'wikimapia_error',
    ],
    [
      'AC-29: another Place’s failures',
      failuresAt('wikimapia_error', 9, 10, 11),
      901,
      undefined,
      undefined,
    ],
    [
      'AC-30: one failure in each of three Runs',
      [1, 2, 3].map((runId) => record(900, 'unexpected_response', H(8 + runId), runId)),
      900,
      undefined,
      'unexpected_response',
    ],
    ['AC-31: 2 + 2 alternating kinds', alternating, 900, undefined, undefined],
    [
      'AC-31: then a Wikimapia Error',
      [...alternating, record(900, 'wikimapia_error', H(13))],
      900,
      undefined,
      'wikimapia_error',
    ],
    [
      'AC-31: then an Unexpected Response',
      [...alternating, record(900, 'unexpected_response', H(13))],
      900,
      undefined,
      'unexpected_response',
    ],
    [
      'AC-32: four Connection Failures',
      failuresAt('connection', 9, 10, 11, 12),
      900,
      undefined,
      undefined,
    ],
    [
      'AC-32: three Invalid Data',
      failuresAt('invalid_data', 9, 10, 11),
      900,
      undefined,
      'invalid_data',
    ],
    [
      'AC-33: two errors, a Details Save, one error',
      failuresAt('wikimapia_error', 9, 10, 12),
      900,
      H(11),
      undefined,
    ],
    [
      'AC-38: a failure in the same second as the Explicit Retry counts',
      failuresAt('wikimapia_error', 15, 16, 17),
      900,
      H(15),
      'wikimapia_error',
    ],
    [
      'AC-38: a failure before the Count Reset does not',
      failuresAt('wikimapia_error', 15, 16, 17),
      900,
      '2026-10-22T15:00:01Z',
      undefined,
    ],
    ['AC-34: Listing Page records', listing, 1, undefined, undefined],
  ])('%s', (_, records, placeId, countReset, kind) => {
    expect(parkingKindOf(records, placeId, countReset)).toBe(kind);
    expect(isParkedPlace(records, placeId, countReset)).toBe(kind !== undefined);
  });

  it.each<[string, FailureRecord[], number, string | undefined, number]>([
    ['Connection Failures (Q3)', failuresAt('connection', 9, 10, 11, 12), 900, undefined, 0],
    ['Listing Page records (Q6)', listing, 1, undefined, 0],
    [
      'records before the Count Reset (Q2)',
      failuresAt('wikimapia_error', 9, 10, 12),
      900,
      H(11),
      1,
    ],
  ])('countedFailures leaves out %s', (_, records, placeId, countReset, expected) => {
    expect(countedFailures(records, placeId, countReset)).toHaveLength(expected);
  });

  it.each<[string, Parameters<typeof countResetOf>[0], string | undefined]>([
    ['a Details Save only', { lastDetailsSaveAt: H(11) }, H(11)],
    [
      'a Details Save and a later Explicit Retry',
      { lastDetailsSaveAt: H(11), lastExplicitRetryAt: H(13) },
      H(13),
    ],
    ['neither', {}, undefined],
  ])('the Count Reset after %s (AC-33, AC-38)', (_, moments, expected) => {
    expect(countResetOf(moments)).toBe(expected);
  });
});
