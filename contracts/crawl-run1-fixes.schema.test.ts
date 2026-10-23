/**
 * AL5 CONTRACT TESTS: Crawl Run 1 fixes (schemas, pure validators and fixtures).
 *
 * Layer:    AL5 (Contracts). These tests do not import the implementation and pass before AL2.
 * Derives:  docs/al6-requirements/20261022-crawl-run1-fixes-al6.md (AC-43, AC-44 fixtures; the
 *           boundary rules behind AC-3 .. AC-5, AC-8 .. AC-13, AC-15 .. AC-19, AC-21, AC-24,
 *           AC-29 .. AC-40; rules 1, 3, 6 .. 9)
 * Enforces: .agrules section 2 (strict Zod boundaries), section 4 (recorded fixtures trimmed,
 *           credited, without API key or Commenter IPs; reconstructed fixtures marked).
 */
import {
  CRAWL_ITEM_FAILURES_COLUMNS,
  CRAWL_ITEM_FAILURES_TABLE,
  ENTRY_POINT,
  ExplicitRetriesValueSchema,
  ExplicitRetrySchema,
  FailureRecordSchema,
  FailureRecordsInputSchema,
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
  CrawlRequestSchema,
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
  ClientFailureSchema,
  KEY_QUOTA_CODE,
  PlaceDetailsSchema,
  RawDebugResponseSchema,
  RawPlaceDetailsSchema,
  classifyDebugResponse,
  findCommenterIpPaths,
  parseRateLimitMessage,
} from './wikimapia-client.schema';
import {
  KEY_QUOTA_BODY,
  at,
  fixtureText,
  rawDetails,
  type FixtureName,
} from './wikimapia-client.support';

const NO_TAGS_FIXTURES: readonly FixtureName[] = [
  'getbyid-1391132-no-tags.json',
  'getbyid-8918979-no-tags.json',
];

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
  it.each(NO_TAGS_FIXTURES)('%s keeps the missing Tags item missing', (name) => {
    const json: unknown = JSON.parse(fixtureText(name));
    expect(json).not.toHaveProperty('tags');
    expect(fixtureText(name)).not.toMatch(/"tags"\s*:/);
    expect(RawPlaceDetailsSchema.safeParse(json).success).toBe(true);
  });

  it('1391132 keeps its empty Wikipedia text and the AL6 evidence values', () => {
    const raw = rawDetails('getbyid-1391132-no-tags.json');
    expect(raw.wikipedia).toBe('');
    expect(raw.id).toBe(1391132);
    expect(raw.title).toBe("Kolarac - Peoples' University and Concert Hall");
    expect([raw.is_building, raw.is_region, raw.is_deleted]).toStrictEqual([true, false, false]);
    expect(raw.parent_id).toBe('0');
    expect(raw.polygon).toHaveLength(16);
    expect([raw.location.lon, raw.location.lat]).toStrictEqual([20.456339, 44.8191407]);
    expect(raw.location.street).toBe('Studentski Trg');
    expect(raw.comments).toStrictEqual([]);
  });

  it('8918979 has no Wikipedia item at all and the AL6 evidence values', () => {
    const json: unknown = JSON.parse(fixtureText('getbyid-8918979-no-tags.json'));
    expect(json).not.toHaveProperty('wikipedia');
    const raw = rawDetails('getbyid-8918979-no-tags.json');
    expect(raw.title).toBe('Zoran Đinđić');
    expect(raw.description).toBe('Monument in Belgrade.');
    expect([raw.is_building, raw.is_region, raw.is_deleted]).toStrictEqual([false, false, false]);
    expect(raw.parent_id).toBe('0');
    expect(raw.polygon).toHaveLength(4);
    expect([raw.location.lon, raw.location.lat]).toStrictEqual([20.4612287, 44.8164264]);
    expect(raw.location.street).toBe('Trg Republike');
    expect(raw.comments).toStrictEqual([]);
  });

  it.each([...NO_TAGS_FIXTURES, 'debug-key-quota.json' as const])(
    '%s contains no API Key, request address or Commenter IP',
    (name) => {
      const text = fixtureText(name);
      expect(findCommenterIpPaths(JSON.parse(text))).toStrictEqual([]);
      expect(text).not.toMatch(/user_?ip/i);
      expect(text).not.toMatch(/[?&]key=/);
      expect(text).not.toMatch(/api\.wikimapia\.org/);
    },
  );

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
    const text = fixtureText('debug-key-quota.json');
    expect(JSON.stringify(JSON.parse(text))).toBe(KEY_QUOTA_BODY);
    expect(KEY_QUOTA_BODY).toBe('{"debug":{"code":1004,"message":"Key limit has been reached"}}');
    const debug = debugOf(text);
    expect(debug.code).toBe(KEY_QUOTA_CODE);
    expect(debug.message).toBe('Key limit has been reached');
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
// Client schemas (AC-1 .. AC-5, AC-8 .. AC-13; Client AC-35 as amended)
// ===========================================================================

describe('Client wire schema: Tags (AC-3, AC-4, AC-5, rule 1)', () => {
  it('a missing, null or empty Tags item is accepted on the wire', () => {
    const base = rawDetails('getbyid-8918979-no-tags.json');
    for (const variant of [base, { ...base, tags: [] }, { ...base, tags: null }]) {
      expect(RawPlaceDetailsSchema.safeParse(variant).success).toBe(true);
    }
  });

  it.each([
    ['text', 'no tags'],
    ['a number', 5],
    ['a Tag without a title', [{ id: 1 }]],
    ['a Tag with a non-whole id', [{ id: 1.5, title: 'x' }]],
    ['a Tag with a text id', [{ id: 'abc', title: 'x' }]],
  ])('Tags as %s is rejected, naming `tags`', (_, tags) => {
    const result = RawPlaceDetailsSchema.safeParse({
      ...rawDetails('getbyid-8918979-no-tags.json'),
      tags,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === 'tags')).toBe(true);
  });

  it('only Tags became optional: a missing title is still rejected (AC-5)', () => {
    const raw = rawDetails('getbyid-1391132-no-tags.json');
    Reflect.deleteProperty(raw, 'title');
    const result = RawPlaceDetailsSchema.safeParse(raw);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toStrictEqual([['title']]);
  });

  it('the output Place Details still require a list of Tags (empty when Wikimapia sent none)', () => {
    const shape = PlaceDetailsSchema.shape.tags;
    expect(shape.safeParse([]).success).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(false);
    expect(shape.safeParse(null).success).toBe(false);
  });
});

describe('Client: Key Quota recognition (AC-8 .. AC-13, rule 3, Q8)', () => {
  it('the Key Quota fixture is a Key Quota Response', () => {
    expect(classifyDebugResponse(debugOf(KEY_QUOTA_BODY))).toStrictEqual({
      kind: 'key_quota',
      code: 1004,
      message: 'Key limit has been reached',
    });
  });

  it.each([
    ['an empty message', ''],
    [
      'the rate-limit wording',
      'You have reached the limit for this action. You need to wait for 7 seconds.',
    ],
  ])('code 1004 wins over %s (AC-12)', (_, message) => {
    expect(classifyDebugResponse({ code: 1004, message })).toStrictEqual({
      kind: 'key_quota',
      code: 1004,
      message,
    });
  });

  it('code 1004 sent as text is still code 1004', () => {
    expect(classifyDebugResponse({ code: '1004', message: 'x' }).kind).toBe('key_quota');
  });

  it('without code 1004 the message decides, as before (AC-13)', () => {
    expect(classifyDebugResponse(debugOf(fixtureText('debug-error.json')))).toStrictEqual({
      kind: 'wikimapia_error',
      message: 'Invalid API key.',
    });
    expect(
      classifyDebugResponse({ code: 1003, message: 'Key limit has been reached' }),
    ).toStrictEqual({ kind: 'wikimapia_error', message: 'Key limit has been reached' });
    expect(classifyDebugResponse({ message: 'Key limit has been reached' })).toStrictEqual({
      kind: 'wikimapia_error',
      message: 'Key limit has been reached',
    });
    expect(classifyDebugResponse(debugOf(fixtureText('debug-rate-limit.json')))).toStrictEqual({
      kind: 'rate_limit',
      waitSeconds: 7,
    });
    expect(classifyDebugResponse({ message: 'You need to wait for a few seconds.' })).toStrictEqual(
      { kind: 'rate_limit' },
    );
  });

  it('parseRateLimitMessage is unchanged: it sees only the message', () => {
    expect(parseRateLimitMessage('Key limit has been reached')).toStrictEqual({
      isRateLimit: false,
    });
  });

  it('Key Quota Exhausted is a Client Failure kind carrying the message and code 1004', () => {
    const failure = {
      kind: 'key_quota_exhausted',
      message: 'Wikimapia key quota exhausted: Key limit has been reached',
      wikimapiaMessage: 'Key limit has been reached',
      code: 1004,
    };
    expect(ClientFailureSchema.safeParse(failure).success).toBe(true);
    expect(ClientFailureSchema.safeParse({ ...failure, wikimapiaMessage: '' }).success).toBe(true);
    expect(ClientFailureSchema.safeParse({ ...failure, code: 1003 }).success).toBe(false);
    expect(ClientFailureSchema.safeParse({ ...failure, attempts: 1 }).success).toBe(false);
    const withoutCode: Record<string, unknown> = { ...failure };
    Reflect.deleteProperty(withoutCode, 'code');
    expect(ClientFailureSchema.safeParse(withoutCode).success).toBe(false);
  });
});

// ===========================================================================
// Crawl schemas (AC-15 .. AC-19, AC-39, AC-40; Hydration AC-45, AC-50, AC-53, AC-59 amended)
// ===========================================================================

describe('Run Outcome Quota Exhausted (AC-15 .. AC-19, Q7)', () => {
  it('is a Run Outcome and a Run Record status, a Clean Stop, labelled "Quota Exhausted", exit status success', () => {
    expect(RunOutcomeSchema.options).toContain('quota_exhausted');
    expect(RunRecordStatusSchema.options).toContain('quota_exhausted');
    expect(CLEAN_STOP_OUTCOMES).toContain('quota_exhausted');
    expect(OUTCOME_LABELS.quota_exhausted).toBe('Quota Exhausted');
    expect(exitCodeFor('quota_exhausted')).toBe(0);
  });

  it('is not an Item Failure kind (AC-24, Q4)', () => {
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
    expect(RunCountsSchema.safeParse(ZERO_RUN_COUNTS).success).toBe(true);
    for (const key of ['placesParkedThisRun', 'placesParked', 'placesReleased'] as const) {
      const without: Record<string, unknown> = { ...ZERO_RUN_COUNTS };
      Reflect.deleteProperty(without, key);
      expect(RunCountsSchema.safeParse(without).success).toBe(false);
    }
    expect(
      RunCountsSchema.safeParse({ ...ZERO_RUN_COUNTS, placesParkedThisRun: 1, placesParked: 1 })
        .success,
    ).toBe(true);
    expect(
      RunCountsSchema.safeParse({ ...ZERO_RUN_COUNTS, placesParkedThisRun: 2, placesParked: 1 })
        .success,
    ).toBe(false);
  });

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
  it('is a Run request flag and a command option without a value', () => {
    expect(
      CrawlRequestSchema.safeParse({ regionName: 'test-one', retryParked: true }).success,
    ).toBe(true);
    expect(CRAWL_COMMAND_OPTIONS.retryParked).toBe('--retry-parked');
    expect(
      CrawlRequestSchema.safeParse({ regionName: 'test-one', retryParked: true, placeId: 900 })
        .success,
    ).toBe(false);
  });

  it('the parked count of a Dry Run is reported for a Dry Run only', () => {
    const summary = {
      regionName: 'belgrade-small',
      outcome: 'planned' as const,
      startedAt: '2026-10-22T09:00:00Z',
      endedAt: '2026-10-22T09:00:00Z',
      counts: ZERO_RUN_COUNTS,
    };
    const plan = {
      regionName: 'belgrade-small',
      bbox: { west: 20.452, south: 44.814, east: 20.462, north: 44.82 },
      tileSize: { width: 0.02, height: 0.02 },
      columns: 1,
      rows: 1,
      tiles: [{ tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.462, north: 44.82 } }],
    };
    const planned = {
      outcome: 'planned' as const,
      summary,
      summaryText: 'Run outcome: Planned',
      plan,
      itemFailures: [],
      parkedPlacesInRegion: 1,
    };
    expect(RunReportSchema.safeParse(planned).success).toBe(true);
    const noPlan: Record<string, unknown> = { ...planned };
    Reflect.deleteProperty(noPlan, 'plan');
    expect(
      RunReportSchema.safeParse({
        ...noPlan,
        outcome: 'completed',
        summary: { ...summary, outcome: 'completed' },
      }).success,
    ).toBe(false);
  });
});

// ===========================================================================
// Failure Records and Explicit Retries (AC-21 .. AC-27, AC-37, AC-41)
// ===========================================================================

describe('Failure Record (AC-21, AC-24, AC-27)', () => {
  it('holds the Run, the item (Place, or Tile and page), kind, message and moment', () => {
    expect(FailureRecordSchema.safeParse(record(900, 'wikimapia_error', H(9))).success).toBe(true);
    expect(
      FailureRecordSchema.safeParse({
        runId: 3,
        item: { kind: 'listing_page', tileNumber: 1, page: 1 },
        failureKind: 'connection',
        message: 'tile 1 page 1: connection failure',
        failedAt: '2026-10-22T09:01:30Z',
      }).success,
    ).toBe(true);
  });

  it('rejects kinds that are not Item Failures, extra items and moments finer than a second', () => {
    for (const failureKind of [
      'key_quota_exhausted',
      'rate_limit_exhausted',
      'configuration',
      'store_unavailable',
    ]) {
      expect(
        FailureRecordSchema.safeParse({ ...record(900, 'wikimapia_error', H(9)), failureKind })
          .success,
      ).toBe(false);
    }
    for (const extra of [{ user_ip: 1111111111 }, { description: 'text' }, { regionName: 'x' }]) {
      expect(
        FailureRecordSchema.safeParse({ ...record(900, 'wikimapia_error', H(9)), ...extra })
          .success,
      ).toBe(false);
    }
    expect(
      FailureRecordSchema.safeParse(record(900, 'wikimapia_error', '2026-10-22T09:00:00.500Z'))
        .success,
    ).toBe(false);
    expect(
      FailureRecordSchema.safeParse({ ...record(900, 'invalid_data', H(9)), message: '' }).success,
    ).toBe(false);
  });

  it('is read by Place or by Run, oldest first (AC-26)', () => {
    expect(FailureRecordsInputSchema.safeParse({ placeId: 900 }).success).toBe(true);
    expect(FailureRecordsInputSchema.safeParse({ runId: 2 }).success).toBe(true);
    expect(FailureRecordsInputSchema.safeParse({ placeId: 0 }).success).toBe(false);
    expect(FailureRecordsInputSchema.safeParse({}).success).toBe(false);
    const oldestFirst = [
      record(900, 'wikimapia_error', H(9)),
      record(900, 'wikimapia_error', H(10)),
    ];
    expect(FailureRecordsValueSchema.safeParse({ records: oldestFirst }).success).toBe(true);
    expect(
      FailureRecordsValueSchema.safeParse({ records: [...oldestFirst].reverse() }).success,
    ).toBe(false);
  });

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
});

describe('Explicit Retry record (AC-37)', () => {
  it('keeps the Run, Region, moment and number released, oldest first', () => {
    const retry = { runId: 7, regionName: 'test-one', retriedAt: H(15), placesReleased: 2 };
    expect(ExplicitRetrySchema.safeParse(retry).success).toBe(true);
    expect(ExplicitRetrySchema.safeParse({ ...retry, placeId: 900 }).success).toBe(false);
    expect(
      ExplicitRetriesValueSchema.safeParse({
        retries: [{ ...retry, retriedAt: H(16) }, retry],
      }).success,
    ).toBe(false);
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

  it('AC-29: the third Wikimapia Error parks the Place', () => {
    const two = [record(900, 'wikimapia_error', H(9)), record(900, 'wikimapia_error', H(10))];
    expect(isParkedPlace(two, 900)).toBe(false);
    const three = [...two, record(900, 'wikimapia_error', H(11))];
    expect(parkingKindOf(three, 900)).toBe('wikimapia_error');
    expect(isParkedPlace(three, 901)).toBe(false);
  });

  it('AC-30: records of every Run count', () => {
    const records = [1, 2, 3].map((runId) =>
      record(900, 'unexpected_response', H(8 + runId), runId),
    );
    expect(isParkedPlace(records, 900)).toBe(true);
  });

  it('AC-31: same kind only, not necessarily consecutive', () => {
    const alternating = [
      record(900, 'wikimapia_error', H(9)),
      record(900, 'unexpected_response', H(10)),
      record(900, 'wikimapia_error', H(11)),
      record(900, 'unexpected_response', H(12)),
    ];
    expect(isParkedPlace(alternating, 900)).toBe(false);
    expect(parkingKindOf([...alternating, record(900, 'wikimapia_error', H(13))], 900)).toBe(
      'wikimapia_error',
    );
    expect(parkingKindOf([...alternating, record(900, 'unexpected_response', H(13))], 900)).toBe(
      'unexpected_response',
    );
  });

  it('AC-32: Connection Failures never park; Invalid Data does', () => {
    const connection = [9, 10, 11, 12].map((h) => record(900, 'connection', H(h)));
    expect(isParkedPlace(connection, 900)).toBe(false);
    expect(countedFailures(connection, 900)).toStrictEqual([]);
    const invalid = [9, 10, 11].map((h) => record(900, 'invalid_data', H(h)));
    expect(isParkedPlace(invalid, 900)).toBe(true);
  });

  it('AC-33, AC-38: a Details Save or an Explicit Retry resets the count', () => {
    const records = [
      record(900, 'wikimapia_error', H(9)),
      record(900, 'wikimapia_error', H(10)),
      record(900, 'wikimapia_error', H(12)),
    ];
    const afterSave = countResetOf({ lastDetailsSaveAt: H(11) });
    expect(afterSave).toBe(H(11));
    expect(countedFailures(records, 900, afterSave)).toHaveLength(1);
    expect(isParkedPlace(records, 900, afterSave)).toBe(false);
    expect(countResetOf({ lastDetailsSaveAt: H(11), lastExplicitRetryAt: H(13) })).toBe(H(13));
    expect(countResetOf({})).toBeUndefined();
  });

  it('AC-38: a failure in the same second as the Explicit Retry counts', () => {
    const records = [
      record(900, 'wikimapia_error', H(15)),
      record(900, 'wikimapia_error', H(16)),
      record(900, 'wikimapia_error', H(17)),
    ];
    expect(isParkedPlace(records, 900, H(15))).toBe(true);
    expect(isParkedPlace(records, 900, '2026-10-22T15:00:01Z')).toBe(false);
  });

  it('AC-34: Listing Page records never park anything', () => {
    const listing: FailureRecord[] = [9, 10, 11].map((h) => ({
      runId: h,
      item: { kind: 'listing_page', tileNumber: 1, page: 1 },
      failureKind: 'wikimapia_error',
      message: 'tile 1 page 1: Wikimapia error',
      failedAt: H(h),
    }));
    expect(isParkedPlace(listing, 1)).toBe(false);
    expect(countedFailures(listing, 1)).toStrictEqual([]);
    expect(at(listing, 0).item.kind).toBe('listing_page');
  });
});
