/**
 * AL5 CONTRACT TESTS: Embeddings, the Embedding Run (behaviour, black box, Test Database).
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261023-embeddings-al6.md (revision 2; one describe per AC,
 *           plus R2 for the Embedding Store read)
 * Enforces: .agrules section 1 (offline, idempotent, resumable batch job), section 2 (1024-dim
 *           `voyage-4` Embeddings only, model name kept, `inputType: "document"`, every service
 *           answer and every result parsed with its Zod schema), section 3 (storage created by
 *           Schema Setup, HNSW cosine index), section 4 (no secrets in output, no Commenter IPs,
 *           recorded fixtures, no live network, Test Database only, strict types).
 *
 * Subjects under test, never doubled: `runEmbedding` (src/embed/run-embedding.ts),
 * `buildPlaceDocument` (src/embed/place-document.ts), `runEmbedCommand` (src/embed/command.ts),
 * `createEmbeddingStore` (src/db/embedding-store.ts), and the finished `createPlaceStore` /
 * `createSchemaSetup` (src/db/) with the Schema Setup step this feature adds. Only the Embedding
 * Service (Simulated Embedding Service) and the clock (Simulated Clock) are test doubles. Until
 * AL2 exists this file fails to import: that is the expected red state.
 *
 * Schema-only and validator checks live in ./embeddings.schema.test.ts and pass before AL2.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createEmbeddingStore } from '../src/db/embedding-store';
import { createPlaceStore } from '../src/db/place-store';
import { createSchemaSetup } from '../src/db/schema-setup';
import { runEmbedCommand } from '../src/embed/command';
import { buildPlaceDocument } from '../src/embed/place-document';
import { runEmbedding } from '../src/embed/run-embedding';
import {
  ANTHROPIC_API_KEY_ENV,
  DEFAULT_EMBEDDING_LIMIT,
  DOCUMENT_INPUT_TYPE,
  EMBEDDED_AT_UDT_NAME,
  EMBEDDING_COLUMN,
  EMBEDDING_COLUMNS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_OUTCOME_LABELS,
  EMBEDDING_RETRY_WAITS_SECONDS,
  EMBEDDING_TABLE,
  EMBED_COMMAND_OPTIONS,
  EMBED_SCRIPT,
  EMBED_SUMMARY_LABELS,
  ENV_EXAMPLE_EXISTING_LINES_SHA256,
  ENV_EXAMPLE_FILE,
  EmbedCommandResultSchema,
  EmbeddingCandidatesResultSchema,
  EmbeddingRunReportSchema,
  EmbeddingServiceRequestSchema,
  EmbeddingStorageInfoResultSchema,
  EmbeddingStoreCountsResultSchema,
  FAILED_PLACE_LABELS,
  ReadEmbeddingRecordResultSchema,
  SIMILARITY_INDEX,
  SaveEmbeddingRecordsResultSchema,
  VOYAGE_API_KEY_ENV,
  VOYAGE_MAX_TEXTS_PER_REQUEST,
  documentFingerprint,
  estimateDocumentTokens,
  findBatchIssues,
  type BuildPlaceDocumentFn,
  type CreateEmbeddingStoreFn,
  type EmbeddingRecord,
  type EmbeddingRunReport,
  type EmbeddingRunRequest,
  type EmbeddingStore,
  type EmbeddingStoreCounts,
  type RunEmbedCommandFn,
  type RunEmbeddingFn,
} from './embeddings.schema';
import {
  EVEN_LATER_FETCHED_AT,
  FETCHED_AT,
  K_COMMENT_1,
  K_COMMENT_4,
  K_DOCUMENT,
  LATER_FETCHED_AT,
  NORMAL,
  PLACE_K_ID,
  SECOND,
  ServiceGate,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  TEST_VOYAGE_API_KEY,
  baseComment,
  byAttempt,
  connectionError,
  detailedPlace,
  fail,
  fakeEmbedding,
  fakeVector,
  holdsPlace,
  normal,
  partsOf,
  placeKSaves,
  rateLimitError,
  raw,
  refusedError,
  storedTags,
  syntheticDetails,
  syntheticName,
  unavailableError,
  type EmbeddingCall,
  type ServiceAnswer,
  type ServiceResponder,
} from './embeddings.support';
import { toMoment } from './hydration.schema';
import {
  EmptyResultSchema,
  ReadPlaceResultSchema,
  STORE_TABLES,
  SaveResultSchema,
  SchemaStepsResultSchema,
  StoreCountsResultSchema,
  StoreStructureResultSchema,
  type CreatePlaceStoreFn,
  type CreateSchemaSetupFn,
  type DetailedPlace,
  type PlaceStore,
  type SchemaSetup,
  type StoreFailure,
  type StoreStructure,
  type WriteHook,
} from './storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  clientDetails,
  clientListing,
  longMixedDescription,
  rehome,
  requireTestDatabaseUrl,
} from './storage.support';
import type { PlaceDetails } from './wikimapia-client.schema';
import { SYNTHETIC_IPS, TEST_API_KEY, at } from './wikimapia-client.support';

// Compile-time check: the entry points have the contract's signatures.
const run: RunEmbeddingFn = runEmbedding;
const build: BuildPlaceDocumentFn = buildPlaceDocument;
const command: RunEmbedCommandFn = runEmbedCommand;
const createEmbeddings: CreateEmbeddingStoreFn = createEmbeddingStore;
const createStore: CreatePlaceStoreFn = createPlaceStore;
const createSetup: CreateSchemaSetupFn = createSchemaSetup;

// ---------------------------------------------------------------------------
// Lifecycle: one Test Database, every Schema Setup step applied, emptied (Places and Embedding
// Records included) before every test (AC-58, AC-61)
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let store: PlaceStore;
let embeddings: EmbeddingStore;
/** Every attempted global `fetch` (Voyage, Anthropic, Wikimapia, anything): must stay empty (AC-60). */
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in embeddings contract tests'));
  });
  testUrl = requireTestDatabaseUrl();
  setup = createSetup({ connectionString: testUrl });
  okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  store = createStore({ connectionString: testUrl });
  embeddings = createEmbeddings({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  await emptyAll();
});

afterAll(async () => {
  await embeddings.close();
  await store.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers (every result is parsed with its contract schema before use)
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

function failureOf<T>(result: Result<T>): StoreFailure {
  if (result.ok) throw new Error('expected a Store Failure, got success');
  return result.failure;
}

async function emptyAll(): Promise<void> {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
}

async function inspect(): Promise<StoreStructure> {
  return okValue(StoreStructureResultSchema.parse(await setup.inspect()));
}

async function storeCounts() {
  return okValue(StoreCountsResultSchema.parse(await store.countStored()));
}

async function embedCounts(): Promise<EmbeddingStoreCounts> {
  return okValue(EmbeddingStoreCountsResultSchema.parse(await embeddings.countEmbeddingStore()));
}

async function saveDetails(details: PlaceDetails, fetchedAt: string = FETCHED_AT): Promise<void> {
  okValue(SaveResultSchema.parse(await store.savePlaceDetails({ details, fetchedAt })));
}

async function saveRecordedListing(): Promise<void> {
  okValue(
    SaveResultSchema.parse(
      await store.saveListingPage(await clientListing('box-belgrade-page1.json')),
    ),
  );
}

async function seedSynthetic(...ids: number[]): Promise<void> {
  for (const id of ids) await saveDetails(await syntheticDetails(id));
}

/** Synthetic Places `first` .. `first + count - 1` from one template (fast seeding, AC-27). */
async function seedManySynthetic(first: number, count: number): Promise<void> {
  const template = await syntheticDetails(first);
  for (let id = first; id < first + count; id += 1) {
    await saveDetails({
      ...template,
      placeId: id,
      title: syntheticName(id),
      description: `Synthetic description ${String(id)}.`,
    });
  }
}

async function seedK(): Promise<void> {
  const [first, second] = await placeKSaves();
  await saveDetails(first, FETCHED_AT);
  await saveDetails(second, LATER_FETCHED_AT);
}

async function readDetailed(placeId: number): Promise<DetailedPlace> {
  const value = okValue(ReadPlaceResultSchema.parse(await store.readPlace({ placeId })));
  if (!value.found || value.place.status !== 'detailed') {
    throw new Error(`place ${String(placeId)} is not a stored Detailed Place`);
  }
  return value.place;
}

async function documentOf(placeId: number): Promise<string> {
  return build(await readDetailed(placeId));
}

async function recordOf(placeId: number): Promise<EmbeddingRecord | undefined> {
  const value = okValue(
    ReadEmbeddingRecordResultSchema.parse(await embeddings.readEmbeddingRecord({ placeId })),
  );
  return value.found ? value.record : undefined;
}

async function requireRecord(placeId: number): Promise<EmbeddingRecord> {
  const record = await recordOf(placeId);
  if (record === undefined) throw new Error(`place ${String(placeId)} has no Embedding Record`);
  return record;
}

/** Keeps an Embedding Record directly through the Embedding Store (test setup, AC-23, AC-45). */
async function keepRecord(
  placeId: number,
  change: Partial<Omit<EmbeddingRecord, 'placeId'>> = {},
): Promise<EmbeddingRecord> {
  const document = await documentOf(placeId);
  const record: EmbeddingRecord = {
    placeId,
    embedding: fakeEmbedding(`old ${document}`),
    model: 'voyage-3.5',
    documentFingerprint: documentFingerprint(document),
    embeddedAt: '2026-10-01T00:00:00Z',
    ...change,
  };
  okValue(
    SaveEmbeddingRecordsResultSchema.parse(
      await embeddings.saveEmbeddingRecords({ records: [record] }),
    ),
  );
  return record;
}

/** Expects the complete Embedding Record this Run would make for `placeId` (AC-18, AC-45). */
async function expectFreshRecord(placeId: number, embeddedAt?: string): Promise<EmbeddingRecord> {
  const document = await documentOf(placeId);
  const record = await requireRecord(placeId);
  expect(record.model).toBe(EMBEDDING_MODEL);
  expect(record.documentFingerprint).toBe(documentFingerprint(document));
  expect(record.embedding).toStrictEqual(fakeEmbedding(document));
  if (embeddedAt !== undefined) expect(record.embeddedAt).toBe(embeddedAt);
  return record;
}

interface EmbedSetup {
  request?: EmbeddingRunRequest;
  responder?: ServiceResponder;
  tokensPerRequest?: number;
  clock?: SimulatedEmbeddingClock;
  /** `null` = no key at all. */
  apiKey?: string | null;
  signal?: AbortSignal;
  onWrite?: WriteHook;
  batchTokenLimit?: number;
  connectionString?: string;
}

function startEmbed(s: EmbedSetup = {}) {
  const clock = s.clock ?? new SimulatedEmbeddingClock();
  const service = new SimulatedEmbeddingService(clock, s.responder, s.tokensPerRequest);
  const progressLines: string[] = [];
  const promise = run(s.request ?? {}, {
    connectionString: s.connectionString ?? testUrl,
    embeddingService: service,
    clock,
    onProgress: (line) => {
      progressLines.push(line);
    },
    ...(s.apiKey === null ? {} : { apiKey: s.apiKey ?? TEST_VOYAGE_API_KEY }),
    ...(s.signal === undefined ? {} : { signal: s.signal }),
    ...(s.onWrite === undefined ? {} : { onWrite: s.onWrite }),
    ...(s.batchTokenLimit === undefined ? {} : { batchTokenLimit: s.batchTokenLimit }),
  });
  return { promise, service, clock, progressLines };
}

async function embed(s: EmbedSetup = {}) {
  const started = startEmbed(s);
  const report: EmbeddingRunReport = EmbeddingRunReportSchema.parse(await started.promise);
  for (const call of started.service.calls) EmbeddingServiceRequestSchema.parse(call.request);
  return { ...started, report };
}

/** A Batch Token Limit that fits exactly `n` Place Documents of the size of `document`. */
function limitFor(document: string, n: number): number {
  return estimateDocumentTokens(document) * n;
}

async function runCommand(
  argv: readonly string[],
  extra: {
    env?: Partial<Record<typeof VOYAGE_API_KEY_ENV | 'DATABASE_URL', string>>;
    responder?: ServiceResponder;
    signal?: AbortSignal;
  } = {},
) {
  const clock = new SimulatedEmbeddingClock();
  const service = new SimulatedEmbeddingService(clock, extra.responder);
  const output: string[] = [];
  const result = EmbedCommandResultSchema.parse(
    await command(argv, {
      env: extra.env ?? { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, DATABASE_URL: testUrl },
      write: (line) => {
        output.push(line);
      },
      embeddingService: service,
      clock,
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    }),
  );
  return { result, output, service };
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  const password = decodeURIComponent(new URL(testUrl).password);
  if (password !== '') expect(text).not.toContain(password);
  expect(text).not.toMatch(/user_?ip/i);
  for (const ip of SYNTHETIC_IPS) expect(text).not.toContain(String(ip));
}

function everyOutput(report: EmbeddingRunReport, lines: readonly string[]): string {
  return [JSON.stringify(report), report.summaryText, ...lines].join('\n');
}

// ===========================================================================
// 3.1 The Place Document (US-2)
// ===========================================================================

describe('AC-1 Layout, full example', () => {
  it('the Place Document of Synthetic Place K read back from the Place Store is exactly the stated text', async () => {
    await seedK();
    expect(await documentOf(PLACE_K_ID)).toBe(K_DOCUMENT);
  });
});

describe('AC-2 Order of Parts', () => {
  it('Name, Tags, Address, Description, then one Comment Part per included Comment, with their labels', () => {
    const place = detailedPlace({
      name: 'Name',
      tags: storedTags(['b-tag', 'present'], ['a-tag', 'present']),
      address: {
        street: 'Street',
        houseNumber: '7',
        city: 'City',
        place: 'Place',
        state: 'State',
        country: 'Country',
      },
      description: 'Text.',
      comments: [
        { num: 1, message: 'First' },
        { num: 2, message: 'Second' },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual([
      'Name',
      'Tags: b-tag, a-tag',
      'Address: Street, 7, City, Place, State, Country',
      'Description: Text.',
      'Comment: First',
      'Comment: Second',
    ]);
  });
});

describe('AC-3 Empty Parts left out', () => {
  it('a Place with nothing but a name gives exactly its name', () => {
    expect(build(detailedPlace({ name: 'Lonely Name' }))).toBe('Lonely Name');
  });

  it('a Place with only Gone Tags and Gone Comments also gives exactly its name', () => {
    const place = detailedPlace({
      name: 'Lonely Name',
      tags: storedTags(['old', 'gone']),
      comments: [{ num: 1, message: 'gone text', presence: 'gone' }],
    });
    expect(build(place)).toBe('Lonely Name');
  });
});

describe('AC-4 Place without Tags', () => {
  it('Place 8918979 saved from the no-tags fixture: name line, no Tags Part, its Description Part, no Comment', async () => {
    await saveDetails(await clientDetails('getbyid-8918979-no-tags.json'));
    const parts = partsOf(await documentOf(8918979));
    expect(at(parts, 0)).toBe('Zoran Đinđić');
    expect(parts.some((p) => p.startsWith('Tags:'))).toBe(false);
    expect(parts).toContain('Description: Monument in Belgrade.');
    expect(parts.some((p) => p.startsWith('Comment:'))).toBe(false);
  });
});

describe('AC-5 Repeated address values once', () => {
  it('city and place both "Belgrade": once, at the position of the first', () => {
    const place = detailedPlace({
      address: { street: 'Knez Mihailova', city: 'Belgrade', place: 'Belgrade', country: 'Serbia' },
    });
    expect(partsOf(build(place))).toContain('Address: Knez Mihailova, Belgrade, Serbia');
  });

  it('values are compared exactly: "Belgrade" and "belgrade" are both kept', () => {
    const place = detailedPlace({ address: { city: 'Belgrade', place: 'belgrade' } });
    expect(partsOf(build(place))).toContain('Address: Belgrade, belgrade');
  });
});

describe('AC-6 Bare Web Addresses removed', () => {
  const cases: [string, string | undefined][] = [
    ['See http://example.org/a for more.', 'Description: See for more.'],
    ['Visit www.Example.org today', 'Description: Visit today'],
    ['HTTPS://example.org/x', undefined],
    ['Info: https://a.rs/b?c=1, http://d.rs', 'Description: Info:'],
    ['Birds go awww. at dusk', 'Description: Birds go awww. at dusk'],
  ];
  it.each(cases)('description %j', (description, expected) => {
    const parts = partsOf(build(detailedPlace({ name: 'N', description })));
    const part = parts.find((p) => p.startsWith('Description:'));
    expect(part).toBe(expected);
  });
});

describe('AC-7 Description that is only a web address', () => {
  it.each(['http://example.org', '\n www.example.org \r\n'])(
    'description %j gives no Description Part',
    (description) => {
      expect(build(detailedPlace({ name: 'N', description }))).toBe('N');
    },
  );
});

describe('AC-8 Spacing tidied', () => {
  it('line breaks, CR LF, tabs and runs of spaces become one space in every Part, trimmed', () => {
    const place = detailedPlace({
      name: '  Kalemegdan \n Park ',
      tags: storedTags([' old\tfort ', 'present'], ['   ', 'present']),
      address: { street: ' Bulevar \r\n vojvode ', city: '\tBelgrade ' },
      description: '\r\nLine one.\r\nLine\ttwo.   End.  ',
      comments: [
        { num: 1, message: ' a \n\n b ' },
        { num: 2, message: ' \r\n\t ' },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual([
      'Kalemegdan Park',
      'Tags: old fort',
      'Address: Bulevar vojvode, Belgrade',
      'Description: Line one. Line two. End.',
      'Comment: a b',
    ]);
  });
});

describe('AC-9 Text otherwise kept as stored', () => {
  it('HTML entities, Cyrillic and Latin diacritics are kept exactly', () => {
    const description = 'He said &quot;Трг Републике&quot; &amp; Đinđić, Kolarčeva.';
    const parts = partsOf(build(detailedPlace({ name: 'N', description })));
    expect(parts).toContain(`Description: ${description}`);
  });
});

describe('AC-10 Long description kept whole', () => {
  it('a description of 7,000+ characters is kept whole (only spacing tidied)', async () => {
    const description = longMixedDescription('Kalemegdan.');
    expect(description.length).toBeGreaterThanOrEqual(7000);
    await saveDetails(await syntheticDetails(320, { description }));
    const part = partsOf(await documentOf(320)).find((p) => p.startsWith('Description: '));
    expect(part).toBe(`Description: ${description.replace(/\s+/gu, ' ').trim()}`);
  });
});

describe('AC-11 Which Comments are included', () => {
  it('Synthetic Place K: Present, not deleted or blocked Comments and Replies only', async () => {
    await seedK();
    const comments = partsOf(await documentOf(PLACE_K_ID)).filter((p) => p.startsWith('Comment:'));
    expect(comments).toStrictEqual(['Comment: Great sunsets', 'Comment: Agreed!']);
  });

  it('blocked Comments are left out; a Present Reply of a deleted or Gone Comment is still included', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        {
          num: 1,
          message: 'deleted parent',
          isDeleted: true,
          replies: [{ num: 2, message: 'reply of deleted' }],
        },
        { num: 3, message: 'blocked', isBlocked: true },
        {
          num: 4,
          message: 'gone parent',
          presence: 'gone',
          replies: [{ num: 5, message: 'reply of gone' }],
        },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual([
      'N',
      'Comment: reply of deleted',
      'Comment: reply of gone',
    ]);
  });
});

describe('AC-12 Comment order', () => {
  it('A, A1, A1x, A2, B: each Comment followed by its Replies at every depth', async () => {
    const comment = await baseComment();
    const c = (num: number, message: string, replies: PlaceDetails['comments'] = []) => ({
      ...rehome(comment, 322, num, replies),
      message,
    });
    const details = await syntheticDetails(322);
    await saveDetails({
      ...details,
      comments: [c(1, 'A', [c(2, 'A1', [c(3, 'A1x')]), c(4, 'A2')]), c(5, 'B')],
    });
    const comments = partsOf(await documentOf(322)).filter((p) => p.startsWith('Comment:'));
    expect(comments).toStrictEqual([
      'Comment: A',
      'Comment: A1',
      'Comment: A1x',
      'Comment: A2',
      'Comment: B',
    ]);
  });
});

describe('AC-13 Gone Tags left out', () => {
  it('Synthetic Place K: "garden" (Gone) is not in the Tags Part', async () => {
    await seedK();
    const parts = partsOf(await documentOf(PLACE_K_ID));
    expect(parts).toContain('Tags: park, fortress');
    expect(parts.join('\n')).not.toContain('garden');
  });
});

describe('AC-14 Bare Web Addresses only removed from descriptions', () => {
  it('a Comment message keeps its web address', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [{ num: 1, message: 'great photos at http://example.org' }],
    });
    expect(partsOf(build(place))).toContain('Comment: great photos at http://example.org');
  });
});

describe('AC-15 Deleted Places are embedded', () => {
  it('a Detailed Place marked deleted is sent and gets an Embedding Record like any other', async () => {
    await saveDetails(await syntheticDetails(310, { isDeleted: true }));
    const { report, service } = await embed();
    expect(report.outcome).toBe('completed');
    expect(service.texts).toStrictEqual([await documentOf(310)]);
    await expectFreshRecord(310);
  });
});

describe('AC-16 Same Place, same text', () => {
  it('the Place Document and its Document Fingerprint are identical each time', async () => {
    await seedK();
    const first = await documentOf(PLACE_K_ID);
    const second = await documentOf(PLACE_K_ID);
    expect(second).toBe(first);
    expect(documentFingerprint(second)).toBe(documentFingerprint(first));
  });
});

// ===========================================================================
// 3.2 Choosing what to embed (US-1, US-3, US-4)
// ===========================================================================

describe('AC-17 Summary-Only Places skipped', () => {
  it('only Summary-Only Places: no request, no record, Completed, 3 skipped, 0 embedded', async () => {
    await saveRecordedListing();
    const { report, service } = await embed();
    expect(service.calls).toHaveLength(0);
    expect((await embedCounts()).embeddingRecords).toBe(0);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.summaryOnlySkipped).toBe(3);
    expect(report.summary.counts.placesEmbedded).toBe(0);
  });
});

describe('AC-18 First Run embeds every Detailed Place', () => {
  it('one request with voyage-4, "document" and the documents of 62587 then 1381893; records kept', async () => {
    await saveRecordedListing();
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    const { report, service } = await embed({
      responder: () => ({ delayMs: 5 * SECOND, then: NORMAL }),
    });
    expect(report.outcome).toBe('completed');
    expect(service.calls).toHaveLength(1);
    const call = at(service.calls, 0);
    expect(call.request.model).toBe(EMBEDDING_MODEL);
    expect(call.request.inputType).toBe(DOCUMENT_INPUT_TYPE);
    expect(call.request.outputDimension).toBe(EMBEDDING_DIMENSIONS);
    expect(call.request.input).toStrictEqual([await documentOf(62587), await documentOf(1381893)]);
    const answeredAt = toMoment(new Date(call.answeredAtMs ?? 0));
    await expectFreshRecord(1381893, answeredAt);
    await expectFreshRecord(62587, answeredAt);
    expect(await recordOf(164369)).toBeUndefined();
  });
});

describe('AC-19 Unchanged Places skipped', () => {
  it('a second Run with no change sends nothing and keeps both records exactly', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    expect((await embed()).report.outcome).toBe('completed');
    const before = [await requireRecord(62587), await requireRecord(1381893)];

    const second = await embed({ clock: new SimulatedEmbeddingClock('2026-10-23T09:00:00Z') });
    expect(second.service.calls).toHaveLength(0);
    expect([await requireRecord(62587), await requireRecord(1381893)]).toStrictEqual(before);
    expect(second.report.outcome).toBe('completed');
    expect(second.report.summary.counts.placesEmbedded).toBe(0);
    expect(second.report.summary.counts.unchangedSkipped).toBe(2);
  });
});

describe('AC-20 Re-fetched details with no change in text', () => {
  it('a later Details Fetched At alone does not make Place 62587 due', async () => {
    const details = await clientDetails('getbyid-62587.json');
    await saveDetails(details);
    await embed();
    await saveDetails(details, LATER_FETCHED_AT);
    const { service, report } = await embed();
    expect(service.calls).toHaveLength(0);
    expect(report.summary.counts.unchangedSkipped).toBe(1);
  });
});

describe('AC-21 Changes outside the Place Document do not count', () => {
  it('Synthetic Place K re-saved with only left-out changes is an Unchanged Place', async () => {
    await seedK();
    await embed();
    const [, second] = await placeKSaves({
      description: 'Old fortress park.\nSee https://example.com/other-page for more.',
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Kalemegdan',
      comments: [
        { ...K_COMMENT_1, goodVotes: 42 },
        { ...K_COMMENT_4, message: 'Other spam' },
      ],
    });
    const lon = 20.45;
    const lat = 44.823;
    await saveDetails(
      {
        ...second,
        outline: [
          { lon: 20.449, lat: 44.822 },
          { lon: 20.451, lat: 44.822 },
          { lon: 20.451, lat: 44.824 },
        ],
        location: {
          ...second.location,
          lon,
          lat,
          north: 44.824,
          south: 44.822,
          east: 20.451,
          west: 20.449,
        },
      },
      EVEN_LATER_FETCHED_AT,
    );
    const { service, report } = await embed();
    expect(service.calls).toHaveLength(0);
    expect(report.summary.counts.unchangedSkipped).toBe(1);
    expect(await documentOf(PLACE_K_ID)).toBe(K_DOCUMENT);
  });
});

describe('AC-22 Changed text is embedded again', () => {
  const changes: [string, (d: PlaceDetails) => Promise<PlaceDetails> | PlaceDetails][] = [
    [
      'a new Present Comment',
      async (d) => ({
        ...d,
        comments: [
          ...d.comments,
          { ...rehome(await baseComment(), 62587, 99), message: 'A new comment.' },
        ],
      }),
    ],
    ['a changed description', (d) => ({ ...d, description: `${d.description} Changed.` })],
    ['a Tag that became Gone', (d) => ({ ...d, tags: d.tags.slice(1) })],
  ];

  it.each(changes)('%s: sent again, the one record replaced', async (_, change) => {
    const details = await clientDetails('getbyid-62587.json');
    await saveDetails(details);
    await embed();
    const old = await requireRecord(62587);
    await saveDetails(await change(details), LATER_FETCHED_AT);
    const second = await embed({ clock: new SimulatedEmbeddingClock('2026-10-23T09:00:00Z') });
    expect(second.service.texts).toStrictEqual([await documentOf(62587)]);
    const fresh = await expectFreshRecord(62587);
    expect(fresh.documentFingerprint).not.toBe(old.documentFingerprint);
    expect(fresh.embedding).not.toStrictEqual(old.embedding);
    expect(Date.parse(fresh.embeddedAt)).toBeGreaterThan(Date.parse(old.embeddedAt));
    expect((await embedCounts()).embeddingRecords).toBe(1);
  });
});

describe('AC-23 Other Embedding Model is embedded again', () => {
  it('a record of another model with a matching fingerprint is replaced by a voyage-4 one', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await keepRecord(62587, { model: 'voyage-3.5' });
    const { service } = await embed();
    expect(service.texts).toStrictEqual([await documentOf(62587)]);
    await expectFreshRecord(62587);
  });
});

describe('AC-24 Empty Document not sent', () => {
  it('a Place whose every text is empty after tidying is not sent and counted as an Empty Document', async () => {
    const comment = await baseComment();
    const details = await syntheticDetails(330, {
      title: ' \n\t ',
      description: ' \r\n ',
      tags: [{ id: 99002, title: '   ' }],
      address: {},
    });
    await saveDetails({ ...details, comments: [{ ...rehome(comment, 330, 1), message: '\n \n' }] });
    expect(await documentOf(330)).toBe('');
    const { service, report } = await embed();
    expect(service.calls).toHaveLength(0);
    expect(await recordOf(330)).toBeUndefined();
    expect(report.summary.counts.emptyDocumentsSkipped).toBe(1);
    expect(report.outcome).toBe('completed');
  });
});

describe('AC-25 Embedding Order', () => {
  it('Places 1381893, 300 and 62587 are sent in the order 300, 62587, 1381893', async () => {
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    await seedSynthetic(300);
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const { service } = await embed();
    expect(service.texts).toStrictEqual([
      await documentOf(300),
      await documentOf(62587),
      await documentOf(1381893),
    ]);
  });
});

describe('AC-26 Embedding kept with the right Place', () => {
  const E = [fakeVector(1024, 'E1'), fakeVector(1024, 'E2'), fakeVector(1024, 'E3')];

  const answerOf = (data: { embedding: number[] | undefined; index?: number }[]) => ({
    data: data.map((item) => ({ object: 'embedding', ...item })),
    model: EMBEDDING_MODEL,
    usage: { totalTokens: 30 },
  });

  it.each([
    ['without indexes the position decides', answerOf(E.map((embedding) => ({ embedding })))],
    [
      'with indexes the index decides, not the position in the answer',
      answerOf([
        { embedding: E[2], index: 2 },
        { embedding: E[0], index: 0 },
        { embedding: E[1], index: 1 },
      ]),
    ],
  ])('%s: 300 E1, 62587 E2, 1381893 E3', async (_, answer) => {
    await seedSynthetic(300);
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    await embed({ responder: () => raw(answer) });
    expect((await requireRecord(300)).embedding).toStrictEqual(E[0]);
    expect((await requireRecord(62587)).embedding).toStrictEqual(E[1]);
    expect((await requireRecord(1381893)).embedding).toStrictEqual(E[2]);
  });
});

// ===========================================================================
// 3.3 Batches and the Embedding Limit (US-5)
// ===========================================================================

describe('AC-27 At most 1,000 per Batch', () => {
  it('2,500 due Places with limit 3,000: requests of 1,000, 1,000 and 500 in Embedding Order', async () => {
    await seedManySynthetic(10_001, 2500);
    const { report, service } = await embed({ request: { embeddingLimit: 3000 } });
    expect(report.outcome).toBe('completed');
    expect(service.calls.map((c) => c.request.input.length)).toStrictEqual([1000, 1000, 500]);
    const expectedNames = Array.from({ length: 2500 }, (_, i) => syntheticName(10_001 + i));
    expect(service.texts.map((t) => t.split('\n')[0])).toStrictEqual(expectedNames);
    expect((await embedCounts()).embeddingRecords).toBe(2500);
    expect(report.summary.counts.placesEmbedded).toBe(2500);
  }, 600_000);
});

describe('AC-28 Batch Token Limit kept', () => {
  it('5 documents over a small limit are split, each within limits, each sent once, in order', async () => {
    await seedSynthetic(301, 302, 303, 304, 305);
    const documents = [];
    for (const id of [301, 302, 303, 304, 305]) documents.push(await documentOf(id));
    const tokenLimit = limitFor(at(documents, 0), 2);
    const { report, service } = await embed({ batchTokenLimit: tokenLimit });
    expect(report.outcome).toBe('completed');
    expect(service.calls.length).toBeGreaterThan(1);
    expect(findBatchIssues(service.inputs, documents, tokenLimit)).toStrictEqual([]);
    expect(service.inputs.every((b) => b.length <= VOYAGE_MAX_TEXTS_PER_REQUEST)).toBe(true);
  });
});

describe('AC-29 Embedding Limit reached', () => {
  it('5 due, limit 3: the first 3 sent, Limit Reached, 3 embedded, 2 still due; the next Run sends 2', async () => {
    await seedSynthetic(301, 302, 303, 304, 305);
    const first = await embed({ request: { embeddingLimit: 3 } });
    expect(first.service.texts.map((t) => t.split('\n')[0])).toStrictEqual(
      [301, 302, 303].map(syntheticName),
    );
    expect(first.report.outcome).toBe('limit_reached');
    expect(first.report.summary.counts.placesEmbedded).toBe(3);
    expect(first.report.summary.counts.placesStillDue).toBe(2);
    for (const id of [301, 302, 303]) await expectFreshRecord(id);
    expect(await recordOf(304)).toBeUndefined();

    const second = await embed({ request: { embeddingLimit: 3 } });
    expect(second.service.texts.map((t) => t.split('\n')[0])).toStrictEqual(
      [304, 305].map(syntheticName),
    );
    expect(second.report.outcome).toBe('completed');
  });

  it('without an override the Embedding Limit is 1,000', async () => {
    await seedManySynthetic(20_001, DEFAULT_EMBEDDING_LIMIT + 1);
    const { report, service } = await embed();
    expect(service.texts).toHaveLength(DEFAULT_EMBEDDING_LIMIT);
    expect(report.outcome).toBe('limit_reached');
    expect(report.summary.counts.placesStillDue).toBe(1);
  }, 600_000);
});

describe('AC-30 Skipped Places do not use up the limit', () => {
  it('4 Unchanged and 2 due with limit 2: both due Places sent, Completed', async () => {
    await seedSynthetic(301, 302, 303, 304);
    await embed();
    await seedSynthetic(305, 306);
    const { report, service } = await embed({ request: { embeddingLimit: 2 } });
    expect(service.texts.map((t) => t.split('\n')[0])).toStrictEqual([305, 306].map(syntheticName));
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.unchangedSkipped).toBe(4);
  });
});

describe('AC-31 Limit exactly matches', () => {
  it('3 due with limit 3: all sent, Completed, not Limit Reached', async () => {
    await seedSynthetic(301, 302, 303);
    const { report, service } = await embed({ request: { embeddingLimit: 3 } });
    expect(service.texts).toHaveLength(3);
    expect(report.outcome).toBe('completed');
  });
});

describe('AC-32 Failed Places count towards the limit', () => {
  it('limit 3 and a first Batch of 3 that fails: nothing more is sent, Limit Reached', async () => {
    await seedSynthetic(301, 302, 303, 304, 305);
    const { report, service } = await embed({
      request: { embeddingLimit: 3 },
      responder: () => raw({ data: [], usage: { totalTokens: 0 } }),
    });
    expect(service.calls).toHaveLength(1);
    expect(at(service.calls, 0).request.input).toHaveLength(3);
    expect(report.summary.counts.failedPlaces).toBe(3);
    expect(report.outcome).toBe('limit_reached');
  });
});

describe('AC-33 Kept before the next request', () => {
  it('when the second request is sent, every record of the first Batch is already kept', async () => {
    await seedSynthetic(301, 302, 303);
    const seenAtSecond: (EmbeddingRecord | undefined)[] = [];
    const tokenLimit = limitFor(await documentOf(301), 1);
    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) =>
        call.index === 1
          ? {
              effect: async () => {
                seenAtSecond.push(await recordOf(301));
              },
              then: NORMAL,
            }
          : NORMAL,
    });
    expect(service.calls).toHaveLength(3);
    expect(report.outcome).toBe('completed');
    expect(seenAtSecond).toHaveLength(1);
    const kept = at(seenAtSecond, 0);
    expect(kept?.documentFingerprint).toBe(documentFingerprint(await documentOf(301)));
  });
});

// ===========================================================================
// 3.4 Failures and stops (US-4, US-5)
// ===========================================================================

/** Start-time gaps in seconds between consecutive calls holding the given Place. */
function gapsFor(calls: readonly EmbeddingCall[], name: string): number[] {
  const starts = calls.filter((c) => holdsPlace(c, name)).map((c) => c.startedAtMs);
  return starts.slice(1).map((s, i) => (s - (starts[i] ?? s)) / SECOND);
}

describe('AC-34 Connection Failure retried', () => {
  it.each([
    ['no answer', connectionError()],
    ['temporarily unavailable (503)', unavailableError()],
  ])(
    '%s, then normal: waits 30 s, sends the same Batch again, keeps it, 2 requests',
    async (_, error) => {
      await seedSynthetic(301, 302);
      const { report, service } = await embed({ responder: byAttempt(fail(error), NORMAL) });
      expect(service.calls).toHaveLength(2);
      expect(at(service.calls, 1).request.input).toStrictEqual(at(service.calls, 0).request.input);
      expect(gapsFor(service.calls, syntheticName(301))).toStrictEqual([
        EMBEDDING_RETRY_WAITS_SECONDS[0],
      ]);
      await expectFreshRecord(301);
      await expectFreshRecord(302);
      expect(report.summary.counts.embeddingRequests).toBe(2);
      expect(report.summary.counts.batchesSent).toBe(1);
      expect(report.outcome).toBe('completed');
    },
  );
});

describe('AC-35 Connection Failure persists', () => {
  it('Batch 1 tried 3 times (30 s, 60 s), its Places fail; Batch 2 kept; Completed; next Run retries them', async () => {
    await seedSynthetic(301, 302);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const failing = syntheticName(301);
    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => (holdsPlace(call, failing) ? fail(connectionError()) : NORMAL),
    });
    expect(service.calls.filter((c) => holdsPlace(c, failing))).toHaveLength(3);
    expect(gapsFor(service.calls, failing)).toStrictEqual([...EMBEDDING_RETRY_WAITS_SECONDS]);
    expect(await recordOf(301)).toBeUndefined();
    await expectFreshRecord(302);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts.failedPlaces).toBe(1);
    expect(report.summary.counts.failedPlacesByKind.connection).toBe(1);
    expect(report.failedPlaces.map((f) => [f.placeId, f.failureKind])).toStrictEqual([
      [301, 'connection'],
    ]);

    const next = await embed({ batchTokenLimit: tokenLimit });
    expect(next.service.texts).toStrictEqual([await documentOf(301)]);
    await expectFreshRecord(301);
  });

  it('a Failed Place keeps its earlier record unchanged', async () => {
    await seedSynthetic(301);
    const old = await keepRecord(301, { model: 'voyage-3.5' });
    await embed({ responder: () => fail(connectionError()) });
    expect(await recordOf(301)).toStrictEqual(old);
  });
});

describe('AC-36 Service Rate Limit', () => {
  it('retried after 30 and 60 s; when it persists the Run stops Rate Limited, earlier Batches kept', async () => {
    await seedSynthetic(301, 302, 303);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const limited = syntheticName(302);
    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => (holdsPlace(call, limited) ? fail(rateLimitError()) : NORMAL),
    });
    expect(service.calls.filter((c) => holdsPlace(c, limited))).toHaveLength(3);
    expect(gapsFor(service.calls, limited)).toStrictEqual([...EMBEDDING_RETRY_WAITS_SECONDS]);
    expect(service.calls.some((c) => holdsPlace(c, syntheticName(303)))).toBe(false);
    expect(report.outcome).toBe('rate_limited');
    expect(report.summary.counts.failedPlaces).toBe(0);
    expect(report.summary.counts.placesStillDue).toBe(2);
    await expectFreshRecord(301);
    expect(await recordOf(302)).toBeUndefined();

    const next = await embed({ batchTokenLimit: tokenLimit });
    expect(at(next.service.inputs, 0)).toStrictEqual([await documentOf(302)]);
  });

  it('a Rate Limit followed by success is retried after 30 s and kept', async () => {
    await seedSynthetic(301);
    const { report, service } = await embed({
      responder: byAttempt(fail(rateLimitError()), NORMAL),
    });
    expect(service.calls).toHaveLength(2);
    expect(gapsFor(service.calls, syntheticName(301))).toStrictEqual([
      EMBEDDING_RETRY_WAITS_SECONDS[0],
    ]);
    expect(report.outcome).toBe('completed');
    await expectFreshRecord(301);
  });
});

describe('AC-37 Service Refused', () => {
  it('no retry, no further request, earlier Batches kept, Failed saying the service refused; no key shown', async () => {
    await seedSynthetic(301, 302, 303);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const refused = syntheticName(302);
    const { report, service, progressLines } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => (holdsPlace(call, refused) ? fail(refusedError()) : NORMAL),
    });
    expect(service.calls.filter((c) => holdsPlace(c, refused))).toHaveLength(1);
    expect(service.calls).toHaveLength(2);
    expect(report.outcome).toBe('failed');
    expect(report.message).toMatch(/Embedding Service refused/i);
    await expectFreshRecord(301);
    expect(await recordOf(302)).toBeUndefined();
    expectNoSecrets(everyOutput(report, progressLines));
  });
});

describe('AC-38 Invalid Embedding Answer', () => {
  const three = (embedding: unknown[]) => ({
    data: [0, 1, 2].map((index) => ({ object: 'embedding', embedding, index })),
    model: EMBEDDING_MODEL,
    usage: { totalTokens: 30 },
  });
  const twoOnly = {
    data: [0, 1].map((index) => ({ object: 'embedding', embedding: fakeVector(1024), index })),
    model: EMBEDDING_MODEL,
    usage: { totalTokens: 20 },
  };
  const cases: [string, unknown][] = [
    ['2 Embeddings for 3 documents', twoOnly],
    ['an Embedding of 1023 numbers', three(fakeVector(1023))],
    ['an Embedding of 1025 numbers', three(fakeVector(1025))],
    ['a NaN value', three([...fakeVector(1023), Number.NaN])],
    ['an answer that cannot be read', '<html>Bad gateway</html>'],
  ];

  it.each(cases)(
    '%s: nothing kept, 3 Failed Places, no retry, the next Batch goes on',
    async (_, bad) => {
      await seedSynthetic(301, 302, 303, 304);
      const tokenLimit = limitFor(await documentOf(301), 3);
      const first = syntheticName(301);
      const { report, service } = await embed({
        batchTokenLimit: tokenLimit,
        responder: (call) => (holdsPlace(call, first) ? raw(bad) : NORMAL),
      });
      expect(service.calls.filter((c) => holdsPlace(c, first))).toHaveLength(1);
      expect(at(service.calls, 0).request.input).toHaveLength(3);
      for (const id of [301, 302, 303]) expect(await recordOf(id)).toBeUndefined();
      await expectFreshRecord(304);
      expect(report.summary.counts.failedPlaces).toBe(3);
      expect(report.summary.counts.failedPlacesByKind.invalid_answer).toBe(3);
      expect(report.summary.counts.tokensUsed).toBe(10);
      expect(report.outcome).toBe('completed');
    },
  );
});

describe('AC-39 Place Store refuses wrong Embeddings', () => {
  async function withEarlierRecord(): Promise<EmbeddingRecord> {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    return keepRecord(62587);
  }

  const bad: [string, (r: EmbeddingRecord) => unknown][] = [
    ['1023 numbers', (r) => ({ ...r, embedding: fakeVector(1023) })],
    ['1025 numbers', (r) => ({ ...r, embedding: fakeVector(1025) })],
    ['a NaN value', (r) => ({ ...r, embedding: [...fakeVector(1023), Number.NaN] })],
    ['an empty Embedding Model', (r) => ({ ...r, model: '' })],
    ['no Document Fingerprint', (r) => ({ ...r, documentFingerprint: undefined })],
  ];

  it.each(bad)(
    '%s: Invalid Data, nothing kept, the earlier record unchanged',
    async (_, change) => {
      const earlier = await withEarlierRecord();
      const attempt = change({
        ...earlier,
        model: EMBEDDING_MODEL,
        embedding: fakeEmbedding('new'),
      });
      const result = SaveEmbeddingRecordsResultSchema.parse(
        await embeddings.saveEmbeddingRecords({ records: [attempt] } as never),
      );
      expect(failureOf(result).kind).toBe('invalid_data');
      expect(await recordOf(62587)).toStrictEqual(earlier);
    },
  );

  it('one wrong record in a Batch: nothing of the Batch is kept', async () => {
    const earlier = await withEarlierRecord();
    await seedSynthetic(301);
    const good: EmbeddingRecord = { ...earlier, placeId: 301, model: EMBEDDING_MODEL };
    const wrong = { ...earlier, embedding: fakeVector(1023) };
    const result = SaveEmbeddingRecordsResultSchema.parse(
      await embeddings.saveEmbeddingRecords({ records: [good, wrong] }),
    );
    expect(failureOf(result).kind).toBe('invalid_data');
    expect(await recordOf(301)).toBeUndefined();
    expect(await recordOf(62587)).toStrictEqual(earlier);
  });

  it('a record for a Summary-Only or unknown Place is Invalid Data', async () => {
    await saveRecordedListing();
    const record = (placeId: number): EmbeddingRecord => ({
      placeId,
      embedding: fakeEmbedding('x'),
      model: EMBEDDING_MODEL,
      documentFingerprint: documentFingerprint('x'),
      embeddedAt: FETCHED_AT,
    });
    for (const placeId of [164369, 777_777]) {
      const result = SaveEmbeddingRecordsResultSchema.parse(
        await embeddings.saveEmbeddingRecords({ records: [record(placeId)] }),
      );
      expect(failureOf(result).kind).toBe('invalid_data');
    }
    expect((await embedCounts()).embeddingRecords).toBe(0);
  });
});

describe('AC-40 Missing key', () => {
  it.each([
    ['not set', null],
    ['blank', '   '],
  ] as const)(
    'VOYAGE_API_KEY %s: Failed naming it, no request, nothing changed',
    async (_, apiKey) => {
      await seedSynthetic(301);
      const { report, service } = await embed({ apiKey });
      expect(report.outcome).toBe('failed');
      expect(report.message).toContain(VOYAGE_API_KEY_ENV);
      expect(service.calls).toHaveLength(0);
      expect((await embedCounts()).embeddingRecords).toBe(0);
    },
  );

  it('through the command: an env without VOYAGE_API_KEY fails the same way', async () => {
    await seedSynthetic(301);
    const { result, service } = await runCommand([], { env: { DATABASE_URL: testUrl } });
    expect(result.report.outcome).toBe('failed');
    expect(result.report.message).toContain(VOYAGE_API_KEY_ENV);
    expect(service.calls).toHaveLength(0);
  });
});

describe('AC-41 Invalid setting', () => {
  it.each([0, 1.5, Number.NaN])(
    'Embedding Limit %s: Failed naming the setting, no request, nothing changed',
    async (embeddingLimit) => {
      await seedSynthetic(301);
      const { report, service } = await embed({ request: { embeddingLimit } });
      expect(report.outcome).toBe('failed');
      expect(report.message).toContain('embeddingLimit');
      expect(service.calls).toHaveLength(0);
      expect((await embedCounts()).embeddingRecords).toBe(0);
    },
  );

  it('an invalid Batch Token Limit fails naming batchTokenLimit', async () => {
    await seedSynthetic(301);
    const { report, service } = await embed({ batchTokenLimit: 0 });
    expect(report.outcome).toBe('failed');
    expect(report.message).toContain('batchTokenLimit');
    expect(service.calls).toHaveLength(0);
  });

  it.each([['abc'], ['0'], ['2.5']])(
    'command `--limit %s` fails naming the setting',
    async (value) => {
      await seedSynthetic(301);
      const { result, service } = await runCommand([EMBED_COMMAND_OPTIONS.limit, value]);
      expect(result.report.outcome).toBe('failed');
      expect(result.report.message).toMatch(/--limit|embeddingLimit/);
      expect(service.calls).toHaveLength(0);
    },
  );
});

describe('AC-42 Place Store unavailable', () => {
  it('unreachable from the start: Failed, no request, summary shown without secrets', async () => {
    const { report, service, progressLines } = await embed({
      connectionString: UNREACHABLE_DATABASE_URL,
    });
    expect(report.outcome).toBe('failed');
    expect(service.calls).toHaveLength(0);
    expect(report.summaryText).toContain(
      `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS.failed}`,
    );
    expectNoSecrets(everyOutput(report, progressLines));
    expect(everyOutput(report, progressLines)).not.toContain(UNREACHABLE_DATABASE_URL);
  }, 60_000);

  it('unavailable while keeping Batch 2: no further request, Batch 1 kept, Batch 2 not, Failed', async () => {
    await seedSynthetic(301, 302, 303);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const seen: { service?: SimulatedEmbeddingService } = {};
    const started = startEmbed({
      batchTokenLimit: tokenLimit,
      onWrite: () => {
        if ((seen.service?.calls.length ?? 0) >= 2) throw new Error('the Place Store went away');
      },
    });
    seen.service = started.service;
    const report = EmbeddingRunReportSchema.parse(await started.promise);
    expect(report.outcome).toBe('failed');
    expect(started.service.calls).toHaveLength(2);
    await expectFreshRecord(301);
    expect(await recordOf(302)).toBeUndefined();
    expect(await recordOf(303)).toBeUndefined();
    expectNoSecrets(everyOutput(report, started.progressLines));
  });
});

describe('AC-43 Interrupt', () => {
  it('interrupted during Batch 2: no new request, Batch 2 kept whole or not at all, Interrupted; next Run continues', async () => {
    await seedSynthetic(301, 302, 303);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const controller = new AbortController();
    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      signal: controller.signal,
      responder: (call) =>
        call.index === 1
          ? {
              effect: () => {
                controller.abort();
              },
              then: NORMAL,
            }
          : NORMAL,
    });
    expect(service.calls).toHaveLength(2);
    expect(report.outcome).toBe('interrupted');
    expect(report.summaryText.length).toBeGreaterThan(0);
    await expectFreshRecord(301);
    const second = await recordOf(302);
    if (second !== undefined) await expectFreshRecord(302);
    expect(await recordOf(303)).toBeUndefined();

    const next = await embed({ batchTokenLimit: tokenLimit });
    const expected = second === undefined ? [302, 303] : [303];
    expect(next.service.texts.map((t) => t.split('\n')[0])).toStrictEqual(
      expected.map(syntheticName),
    );
    expect(next.report.outcome).toBe('completed');
  });

  it('already interrupted at the start: nothing is sent', async () => {
    await seedSynthetic(301);
    const controller = new AbortController();
    controller.abort();
    const { report, service } = await embed({ signal: controller.signal });
    expect(service.calls).toHaveLength(0);
    expect(report.outcome).toBe('interrupted');
    expect(await recordOf(301)).toBeUndefined();
  });
});

describe('AC-44 Crash keeps finished Batches', () => {
  it('a Run stuck on Batch 2: a new Run skips Batch 1 and sends Batch 2 and the rest', async () => {
    await seedSynthetic(301, 302, 303);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const gate = new ServiceGate();
    const controller = new AbortController();
    const stuck = startEmbed({
      batchTokenLimit: tokenLimit,
      signal: controller.signal,
      responder: (call) => (call.index === 1 ? { gate } : NORMAL),
    });
    await gate.reached;
    await expectFreshRecord(301);

    const fresh = await embed({
      batchTokenLimit: tokenLimit,
      clock: new SimulatedEmbeddingClock('2026-10-22T10:00:00Z'),
    });
    expect(fresh.service.texts.map((t) => t.split('\n')[0])).toStrictEqual(
      [302, 303].map(syntheticName),
    );
    expect(fresh.report.summary.counts.unchangedSkipped).toBe(1);

    controller.abort();
    gate.open(raw('the process was killed'));
    EmbeddingRunReportSchema.parse(await stuck.promise);
  });
});

describe('AC-45 All or nothing per Place', () => {
  it.each([1, 2, 3])(
    'a store failure at write %i leaves every Place with its old record or a complete new one',
    async (failAt) => {
      await seedSynthetic(301, 302, 303);
      const old = new Map<number, EmbeddingRecord>();
      for (const id of [301, 302, 303]) old.set(id, await keepRecord(id, { model: 'voyage-3.5' }));
      let writes = 0;
      const { report } = await embed({
        onWrite: () => {
          writes += 1;
          if (writes === failAt) throw new Error('the Place Store went away');
        },
      });
      expect(['completed', 'failed']).toContain(report.outcome);
      for (const id of [301, 302, 303]) {
        const record = await requireRecord(id);
        if (record.model === EMBEDDING_MODEL) {
          await expectFreshRecord(id);
        } else {
          expect(record).toStrictEqual(old.get(id));
        }
      }
    },
  );
});

// ===========================================================================
// 3.5 Run Summary and command line (US-6, US-1)
// ===========================================================================

function summaryLines(report: EmbeddingRunReport): string[] {
  return report.summaryText.split(/\r?\n/);
}

function expectSummaryText(report: EmbeddingRunReport): void {
  const lines = summaryLines(report);
  const s = report.summary;
  const c = s.counts;
  expect(lines).toContain(
    `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS[s.outcome]}`,
  );
  expect(lines).toContain(`${EMBED_SUMMARY_LABELS.startedAt}: ${s.startedAt}`);
  expect(lines).toContain(`${EMBED_SUMMARY_LABELS.endedAt}: ${s.endedAt}`);
  expect(lines).toContain(`${EMBED_SUMMARY_LABELS.embeddingModel}: ${EMBEDDING_MODEL}`);
  const numeric = [
    'detailedPlacesConsidered',
    'placesEmbedded',
    'unchangedSkipped',
    'summaryOnlySkipped',
    'emptyDocumentsSkipped',
    'failedPlaces',
    'placesStillDue',
    'batchesSent',
    'embeddingRequests',
    'tokensUsed',
  ] as const;
  for (const key of numeric)
    expect(lines).toContain(`${EMBED_SUMMARY_LABELS[key]}: ${String(c[key])}`);
  for (const [kind, label] of Object.entries(FAILED_PLACE_LABELS)) {
    const n = c.failedPlacesByKind[kind as keyof typeof c.failedPlacesByKind];
    expect(lines).toContain(`${EMBED_SUMMARY_LABELS.failedPlaces} (${label}): ${String(n)}`);
  }
}

describe('AC-46 Summary contents', () => {
  it('a Completed Run shows every item, one labelled line each', async () => {
    await seedSynthetic(301);
    const { report } = await embed();
    expectSummaryText(report);
  });

  it('a Run that ended Failed after it started also shows every item', async () => {
    await seedSynthetic(301, 302);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const { report } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => (call.index === 1 ? fail(refusedError()) : NORMAL),
    });
    expect(report.outcome).toBe('failed');
    expectSummaryText(report);
  });

  it('the Run Summary is not kept in the database (no new table)', async () => {
    const before = (await inspect()).tables.map((t) => t.name).sort();
    await seedSynthetic(301);
    await embed();
    expect((await inspect()).tables.map((t) => t.name).sort()).toStrictEqual(before);
  });
});

describe('AC-47 Counts are exact', () => {
  it('3 due (Batch 1 ok with 40 tokens, Batch 2 invalid), 1 Unchanged, 1 Summary-Only', async () => {
    await saveRecordedListing();
    await seedSynthetic(300);
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    await seedK();
    await keepRecord(PLACE_K_ID, { model: EMBEDDING_MODEL });
    const d300 = await documentOf(300);
    const d62587 = await documentOf(62587);
    const d1381893 = await documentOf(1381893);
    const tokenLimit = estimateDocumentTokens(d300) + estimateDocumentTokens(d62587);
    expect(estimateDocumentTokens(d62587) + estimateDocumentTokens(d1381893)).toBeGreaterThan(
      tokenLimit,
    );

    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) =>
        call.request.input.includes(d1381893)
          ? raw({ data: [], usage: { totalTokens: 0 } })
          : normal(40),
    });
    expect(service.inputs).toStrictEqual([[d300, d62587], [d1381893]]);
    expect(report.outcome).toBe('completed');
    expect(report.summary.counts).toStrictEqual({
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
    });
    expect(report.failedPlaces.map((f) => [f.placeId, f.failureKind])).toStrictEqual([
      [1381893, 'invalid_answer'],
    ]);
    expectSummaryText(report);
  });
});

describe('AC-48 Tokens from the service', () => {
  it('120 + 75 reported tokens give 195; failed requests add nothing', async () => {
    await seedSynthetic(301, 302, 303);
    const tokenLimit = limitFor(await documentOf(301), 1);
    const answers: ServiceAnswer[] = [
      normal(120),
      fail(connectionError()),
      normal(75),
      raw({ data: [], usage: { totalTokens: 999 } }),
    ];
    const { report, service } = await embed({
      batchTokenLimit: tokenLimit,
      responder: (call) => answers[call.index] ?? NORMAL,
    });
    expect(service.calls).toHaveLength(4);
    expect(report.summary.counts.tokensUsed).toBe(195);
  });
});

describe('AC-49 Command form', () => {
  it('package.json has an `embed` script run through tsx', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    expect(scripts[EMBED_SCRIPT.name]).toMatch(new RegExp(`^${EMBED_SCRIPT.runner}\\s`));
  });

  it('no options: a Run with the default settings over all Detailed Places; the summary is written', async () => {
    await saveRecordedListing();
    await seedSynthetic(301, 302);
    const { result, output, service } = await runCommand([]);
    expect(result.report.outcome).toBe('completed');
    expect(service.texts).toHaveLength(2);
    expect(result.report.summary.counts.summaryOnlySkipped).toBe(3);
    const text = output.join('\n');
    for (const line of summaryLines(result.report)) expect(text).toContain(line);
  });

  it('`--limit 2` sets the Embedding Limit for that Run', async () => {
    await seedSynthetic(301, 302, 303);
    const { result, service } = await runCommand([EMBED_COMMAND_OPTIONS.limit, '2']);
    expect(service.texts).toHaveLength(2);
    expect(result.report.outcome).toBe('limit_reached');
  });

  it.each([['--dry-run'], ['extra']])(
    'unknown option %s: Failed with a usage message, nothing sent',
    async (option) => {
      await seedSynthetic(301);
      const { result, output, service } = await runCommand([option]);
      expect(result.report.outcome).toBe('failed');
      expect([result.report.message ?? '', ...output].join('\n')).toContain(
        EMBED_COMMAND_OPTIONS.limit,
      );
      expect(service.calls).toHaveLength(0);
      expect((await embedCounts()).embeddingRecords).toBe(0);
    },
  );
});

describe('AC-50 Exit status', () => {
  it('success for Completed, Limit Reached and Rate Limited; failure for Failed and Interrupted', async () => {
    await seedSynthetic(301, 302);
    const limited = await runCommand([EMBED_COMMAND_OPTIONS.limit, '1']);
    expect(limited.result.report.outcome).toBe('limit_reached');
    expect(limited.result.exitCode).toBe(0);

    const rateLimited = await runCommand([], { responder: () => fail(rateLimitError()) });
    expect(rateLimited.result.report.outcome).toBe('rate_limited');
    expect(rateLimited.result.exitCode).toBe(0);

    const completed = await runCommand([]);
    expect(completed.result.report.outcome).toBe('completed');
    expect(completed.result.exitCode).toBe(0);

    const failed = await runCommand([], { env: { DATABASE_URL: testUrl } });
    expect(failed.result.report.outcome).toBe('failed');
    expect(failed.result.exitCode).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const interrupted = await runCommand([], { signal: controller.signal });
    expect(interrupted.result.report.outcome).toBe('interrupted');
    expect(interrupted.result.exitCode).toBe(1);
  });
});

describe('AC-51 No secrets in output', () => {
  it('summaries, progress and failure messages never show a key, password or Commenter IP', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await seedSynthetic(301);
    const outputs: string[] = [];
    for (const responder of [
      () => fail(refusedError()),
      () => fail(connectionError()),
      () => fail(rateLimitError()),
    ]) {
      const { report, progressLines } = await embed({ responder });
      outputs.push(everyOutput(report, progressLines));
    }
    const unreachable = await embed({ connectionString: UNREACHABLE_DATABASE_URL });
    outputs.push(everyOutput(unreachable.report, unreachable.progressLines));
    const viaCommand = await runCommand([], { responder: () => fail(refusedError()) });
    outputs.push(JSON.stringify(viaCommand.result), ...viaCommand.output);
    for (const text of outputs) expectNoSecrets(text);
  }, 120_000);

  it('Place Documents sent to the service hold no Commenter IP', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const { service } = await embed();
    expectNoSecrets(service.texts.join('\n'));
  });
});

describe('AC-52 Example settings file', () => {
  it('.env.example has empty VOYAGE_API_KEY and ANTHROPIC_API_KEY, the existing entries unchanged', () => {
    const text = readFileSync(new URL(`../${ENV_EXAMPLE_FILE}`, import.meta.url), 'utf8');
    const entries = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) entries.set(match[1], match[2] ?? '');
    }
    expect(entries.get(VOYAGE_API_KEY_ENV)).toBe('');
    expect(entries.get(ANTHROPIC_API_KEY_ENV)).toBe('');
    for (const [key, hash] of Object.entries(ENV_EXAMPLE_EXISTING_LINES_SHA256)) {
      expect(entries.has(key)).toBe(true);
      expect(documentFingerprint(`${key}=${entries.get(key) ?? ''}`)).toBe(hash);
    }
    expect(text).not.toMatch(/pa-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}/);
  });
});

// ===========================================================================
// 3.6 Schema Setup for Embeddings (US-7)
// ===========================================================================

async function storageInfo() {
  return okValue(
    EmbeddingStorageInfoResultSchema.parse(await embeddings.inspectEmbeddingStorage()),
  );
}

describe('AC-53 New step, earlier steps untouched', () => {
  it('the table holds one record per Place with exactly 1024 dimensions; Places start without one', async () => {
    const structure = await inspect();
    expect(structure.pendingSteps).toStrictEqual([]);
    const table = structure.tables.find((t) => t.name === EMBEDDING_TABLE);
    expect(table).toBeDefined();
    const columns = table?.columns ?? [];
    for (const name of EMBEDDING_COLUMNS) expect(columns.map((c) => c.name)).toContain(name);
    expect(columns.find((c) => c.name === EMBEDDING_COLUMN)?.udtName).toBe('vector');
    expect(columns.find((c) => c.name === 'embedded_at')?.udtName).toBe(EMBEDDED_AT_UDT_NAME);
    const info = await storageInfo();
    expect(info.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(info.onePerPlace).toBe(true);

    await saveDetails(await clientDetails('getbyid-62587.json'));
    expect(await recordOf(62587)).toBeUndefined();
    await keepRecord(62587);
    await keepRecord(62587, { model: EMBEDDING_MODEL });
    expect((await embedCounts()).embeddingRecords).toBe(1);
  });

  it('undoing and re-applying this step keeps every Place, Comment, Tag and Place-Tag Link', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await saveRecordedListing();
    const before = { counts: await storeCounts(), place: await readDetailed(62587) };
    const applied = (await inspect()).appliedSteps;
    const undone = okValue(SchemaStepsResultSchema.parse(await setup.undoLast())).steps;
    expect(undone).toStrictEqual([at(applied, applied.length - 1)]);
    expect(okValue(SchemaStepsResultSchema.parse(await setup.apply())).steps).toStrictEqual(undone);
    expect({ counts: await storeCounts(), place: await readDetailed(62587) }).toStrictEqual(before);
    expect((await embedCounts()).embeddingRecords).toBe(0);
  });
});

describe('AC-54 Similarity index', () => {
  it('an HNSW cosine index covers every Embedding', async () => {
    const info = await storageInfo();
    const cosine = info.vectorIndexes.filter(
      (i) =>
        i.method === SIMILARITY_INDEX.method && i.operatorClass === SIMILARITY_INDEX.operatorClass,
    );
    expect(cosine.length).toBeGreaterThanOrEqual(1);
    expect(cosine.some((i) => !i.partial)).toBe(true);
  });
});

describe('AC-55 Step can be undone', () => {
  afterEach(async () => {
    okValue(SchemaStepsResultSchema.parse(await setup.apply()));
  });

  it('undoing it removes the Embedding storage and index only; applying it again succeeds', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    await keepRecord(62587);
    const before = { counts: await storeCounts(), place: await readDetailed(62587) };
    const tablesBefore = (await inspect()).tables.map((t) => t.name);

    okValue(SchemaStepsResultSchema.parse(await setup.undoLast()));
    const after = await inspect();
    const names = after.tables.map((t) => t.name);
    expect(names).not.toContain(EMBEDDING_TABLE);
    expect(after.tables.flatMap((t) => t.columns).some((c) => c.udtName === 'vector')).toBe(false);
    for (const table of Object.values(STORE_TABLES)) expect(names).toContain(table);
    expect([...names].sort()).toStrictEqual(
      tablesBefore.filter((n) => n !== EMBEDDING_TABLE).sort(),
    );
    expect({ counts: await storeCounts(), place: await readDetailed(62587) }).toStrictEqual(before);

    okValue(SchemaStepsResultSchema.parse(await setup.apply()));
    expect((await inspect()).tables.map((t) => t.name)).toContain(EMBEDDING_TABLE);
    const reapplied = await storageInfo();
    expect(reapplied.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(reapplied.vectorIndexes.length).toBeGreaterThan(0);
  });
});

describe('AC-56 Embedding Records outlive Details Saves', () => {
  it('Listing Saves and Details Saves of Place 62587 leave its Embedding Record unchanged', async () => {
    const details = await clientDetails('getbyid-62587.json');
    await saveDetails(details);
    await embed();
    const kept = await requireRecord(62587);
    await saveRecordedListing();
    await saveDetails(details, LATER_FETCHED_AT);
    await saveDetails({ ...details, description: 'Changed on Wikimapia.' }, EVEN_LATER_FETCHED_AT);
    expect(await recordOf(62587)).toStrictEqual(kept);
  });
});

describe('AC-57 Amended storage checks', () => {
  it('the only vector column of the store is the Embedding of a Place, 1024 numbers each', async () => {
    const structure = await inspect();
    const vectorColumns = structure.tables.flatMap((t) =>
      t.columns.filter((c) => c.udtName === 'vector').map((c) => `${t.name}.${c.name}`),
    );
    expect(vectorColumns).toStrictEqual([`${EMBEDDING_TABLE}.${EMBEDDING_COLUMN}`]);
    expect((await storageInfo()).dimensions).toBe(EMBEDDING_DIMENSIONS);
  });
});

describe('AC-58 Test starting state', () => {
  it('every test starts with all steps applied and no Embedding Records', async () => {
    expect((await inspect()).pendingSteps).toStrictEqual([]);
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 0,
      detailedPlaces: 0,
      embeddingRecords: 0,
    });
  });

  it('emptying the Test Database also removes every Embedding Record', async () => {
    await seedSynthetic(301, 302);
    await embed();
    expect((await embedCounts()).embeddingRecords).toBe(2);
    await emptyAll();
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 0,
      detailedPlaces: 0,
      embeddingRecords: 0,
    });
  });
});

// ===========================================================================
// R2 Reading Detailed Places with their Embedding Records (AL6 section 5)
// ===========================================================================

describe('R2 Embedding Store read', () => {
  it('lists Detailed Places only, ascending Place ID, paged, each exactly as readPlace reads it, with its record', async () => {
    await saveRecordedListing();
    await saveDetails(await clientDetails('getbyid-1381893.json'));
    await seedSynthetic(300);
    await saveDetails(await clientDetails('getbyid-62587.json'));
    const record = await keepRecord(62587);

    const all = okValue(
      EmbeddingCandidatesResultSchema.parse(
        await embeddings.listEmbeddingCandidates({ limit: 1000 }),
      ),
    );
    expect(all.places.map((c) => c.place.placeId)).toStrictEqual([300, 62587, 1381893]);
    for (const candidate of all.places) {
      expect(candidate.place).toStrictEqual(await readDetailed(candidate.place.placeId));
    }
    expect(at(all.places, 1).embeddingRecord).toStrictEqual(record);
    expect(at(all.places, 0).embeddingRecord).toBeUndefined();

    const page = okValue(
      EmbeddingCandidatesResultSchema.parse(
        await embeddings.listEmbeddingCandidates({ afterPlaceId: 300, limit: 1 }),
      ),
    );
    expect(page.places.map((c) => c.place.placeId)).toStrictEqual([62587]);
    expect(await embedCounts()).toStrictEqual({
      summaryOnlyPlaces: 1,
      detailedPlaces: 3,
      embeddingRecords: 1,
    });
  });

  it('an invalid read is Invalid Data; an unreachable store is Store Unavailable without secrets', async () => {
    const invalid = EmbeddingCandidatesResultSchema.parse(
      await embeddings.listEmbeddingCandidates({ limit: 1001 }),
    );
    expect(failureOf(invalid).kind).toBe('invalid_data');
    const unreachable = createEmbeddings({ connectionString: UNREACHABLE_DATABASE_URL });
    try {
      const failure = failureOf(
        EmbeddingCandidatesResultSchema.parse(
          await unreachable.listEmbeddingCandidates({ limit: 10 }),
        ),
      );
      expect(failure.kind).toBe('store_unavailable');
      expectNoSecrets(JSON.stringify(failure));
    } finally {
      await unreachable.close();
    }
  }, 60_000);
});

// ===========================================================================
// 3.7 Licensing and tests (US-8, US-9)
// ===========================================================================

function filesUnder(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
    return entry.isDirectory() ? filesUnder(url) : [url];
  });
}

describe('AC-59 No Embeddings in the repository', () => {
  it('contracts/ and tests/ hold no stored Embedding (no list of 1024 numbers) and no bulk files', () => {
    const run1024 = new RegExp(
      `(?:-?\\d+(?:\\.\\d+)?(?:e-?\\d+)?\\s*,\\s*){${String(EMBEDDING_DIMENSIONS - 1)}}-?\\d`,
    );
    for (const root of ['./', '../tests/']) {
      for (const file of filesUnder(new URL(root, import.meta.url))) {
        expect(statSync(file).size).toBeLessThan(512 * 1024);
        expect(run1024.test(readFileSync(file, 'utf8'))).toBe(false);
      }
    }
  });

  it('.gitignore keeps crawl output (data/) and .env out of the repository', () => {
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('data/');
    expect(ignore).toContain('.env');
  });
});

describe('AC-60 No live calls', () => {
  it('no test of this file attempted a global fetch (Voyage, Anthropic, Wikimapia or other)', () => {
    expect(fetchCalls).toStrictEqual([]);
  });
});

describe('AC-61 Test Database only', () => {
  it('the tests use a database named *_test, never DATABASE_URL', () => {
    expect(() => requireTestDatabaseUrl()).not.toThrow();
    const dev = process.env.DATABASE_URL;
    if (dev !== undefined && dev !== '') expect(testUrl).not.toBe(dev);
  });
});

describe('AC-62 Fixtures', () => {
  it('real-looking Places come from the existing trimmed fixtures through the Place Store', async () => {
    await saveDetails(await clientDetails('getbyid-62587.json'));
    expect((await readDetailed(62587)).name).toBe('Square of the Republic');
  });
});
