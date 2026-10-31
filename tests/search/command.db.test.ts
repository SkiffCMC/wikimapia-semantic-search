/**
 * AL2 unit tests: the Search Command `runSearchCommand` (`src/search/command.ts`; AL4
 * hybrid-search 1.4.7, U5) against the Test Database. The real `searchPlaces` runs underneath;
 * the only test double is the contract's Simulated Query Embedding Service. No module mocks, no
 * network (`fetch` is stubbed to record and reject), settings only through `io.env`.
 */
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { runSearchCommand } from '../../src/search/command';
import { outcomeLines } from '../../src/search/output';
import type { EmbeddingStore } from '../../contracts/embeddings.schema';
import {
  DATABASE_URL_ENV,
  MODE_LINES,
  SEARCH_COMMAND_OPTIONS,
  SEARCH_FAILURE_LABELS,
  SEARCH_USAGE_PREFIX,
  SearchCommandResultSchema,
  VOYAGE_API_KEY_ENV,
  effectiveMode,
  isSearchUsageLine,
  type RunSearchCommandFn,
  type SearchFailureKind,
} from '../../contracts/hybrid-search.schema';
import {
  SimulatedQueryEmbeddingService,
  TEST_VOYAGE_API_KEY,
  rateLimitError,
  refusedError,
  seedSearchSet,
  type QueryServiceAnswer,
} from '../../contracts/hybrid-search.support';
import type { PlaceStore, SchemaSetup } from '../../contracts/storage.schema';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_PASSWORD,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';

// Compile-time check: the entry point has the contract's signature.
const command: RunSearchCommandFn = runSearchCommand;

type CommandEnv = Partial<Record<typeof VOYAGE_API_KEY_ENV | typeof DATABASE_URL_ENV, string>>;

const { near, radius, tag, approximate } = SEARCH_COMMAND_OPTIONS;
const AC41_ARGV = ['museum', near, '44.817,20.457', radius, '500'];
const STUBBED_PROCESS_KEY = 'pa-stubbed-process-env-key-synthetic';

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
let embeddings: EmbeddingStore;
const fetchCalls: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('network is disabled in search command tests'));
  });
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect((await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
  embeddings = createEmbeddingStore({ connectionString: testUrl });
});

beforeEach(async () => {
  expect((await setup.emptyStore()).ok).toBe(true);
  await seedSearchSet(places, embeddings);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await embeddings.close();
    await places.close();
    await setup.close();
    vi.unstubAllGlobals();
  }
});

async function run(argv: readonly string[], extra: { env?: CommandEnv; answer?: QueryServiceAnswer } = {}) {
  const service = new SimulatedQueryEmbeddingService(extra.answer);
  const output: string[] = [];
  const result = SearchCommandResultSchema.parse(
    await command(argv, {
      env: extra.env ?? { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, [DATABASE_URL_ENV]: testUrl },
      write: (line) => {
        output.push(line);
      },
      embeddingService: service,
    }),
  );
  return { result, output, service };
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toContain(STUBBED_PROCESS_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  expect(text).not.toContain('postgres://');
  const password = decodeURIComponent(new URL(testUrl).password);
  if (password !== '') expect(text).not.toContain(password);
}

describe('AC-41 / AC-71 requests', () => {
  it('the AC-41 argv: the request, one embedding of the Query Text, the ranked Places', async () => {
    const { result, output, service } = await run(AC41_ARGV);
    expect(result.request).toStrictEqual({
      queryText: 'museum',
      centre: { lat: 44.817, lon: 20.457 },
      radiusMetres: 500,
    });
    expect(service.calls).toHaveLength(1);
    expect(service.texts).toStrictEqual(['museum']);
    expect(result.outcome?.ok && result.outcome.results.map((r) => r.placeId)).toStrictEqual([
      102, 101, 108, 109, 104,
    ]);
    expect(output[0]).toBe(MODE_LINES.exact);
  });

  it.each([[[approximate]], [[approximate, approximate]]])('%j: Approximate mode', async (flags) => {
    const { result, output } = await run([...AC41_ARGV, ...flags]);
    expect(result.request?.mode).toBe('approximate');
    expect(output[0]).toBe(MODE_LINES.approximate);
  });
});

describe('output layout and exit code 0', () => {
  it.each([
    ['a list', ['museum'], 0],
    ['an empty list', ['museum', tag, 'volcano'], 0],
    ['a failure', ['museum', near, '44.817,20.457', radius, '0'], 1],
  ])('%s: the output is outcomeLines of the outcome', async (_, argv, exitCode) => {
    const { result, output } = await run(argv);
    if (result.request === undefined || result.outcome === undefined) {
      throw new Error('the command made no search');
    }
    expect(output).toStrictEqual(outcomeLines(effectiveMode(result.request), result.outcome));
    expect(result.exitCode).toBe(exitCode);
  });
});

describe('exit code 1', () => {
  // `env` is a factory because the Test Database URL is known only after `beforeAll`.
  it.each<[SearchFailureKind, string[], { env?: (url: string) => CommandEnv; answer?: QueryServiceAnswer }, string?]>([
    ['invalid_request', ['museum', near, '44.817,20.457', radius, '0'], {}, radius],
    ['missing_key', ['museum'], { env: (url) => ({ [DATABASE_URL_ENV]: url }) }, VOYAGE_API_KEY_ENV],
    ['query_embedding_failed', ['museum'], { answer: { error: rateLimitError() } }],
    [
      'store_unavailable',
      ['museum'],
      { env: () => ({ [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL }) },
    ],
  ])('%s', async (kind, argv, { env, answer }, named) => {
    const { result, output } = await run(argv, {
      ...(env === undefined ? {} : { env: env(testUrl) }),
      ...(answer === undefined ? {} : { answer }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.outcome?.ok === false && result.outcome.failure.kind).toBe(kind);
    const text = output.join('\n');
    expect(text).toContain(SEARCH_FAILURE_LABELS[kind]);
    if (named !== undefined) expect(text).toContain(named);
  }, 60_000);

  it('a usage error: problem line, usage line, no request, no outcome, no service call', async () => {
    const { result, output, service } = await run(['museum', '--fast']);
    expect(result.exitCode).toBe(1);
    expect(result).not.toHaveProperty('outcome');
    expect(result).not.toHaveProperty('request');
    expect(output).toHaveLength(2);
    expect(output[0]?.startsWith('Search failed: ')).toBe(true);
    expect(output[1]?.startsWith(SEARCH_USAGE_PREFIX)).toBe(true);
    expect(isSearchUsageLine(output[1] ?? '')).toBe(true);
    expect(service.calls).toHaveLength(0);
  });
});

describe('AC-45 settings only from io.env', () => {
  it('no VOYAGE_API_KEY in io.env: missing_key, even with one in process.env', async () => {
    vi.stubEnv(VOYAGE_API_KEY_ENV, STUBBED_PROCESS_KEY);
    const { result, output, service } = await run(['museum'], { env: { [DATABASE_URL_ENV]: testUrl } });
    expect(result.outcome?.ok === false && result.outcome.failure.kind).toBe('missing_key');
    expect(output.join('\n')).toContain(VOYAGE_API_KEY_ENV);
    expect(service.calls).toHaveLength(0);
    expectNoSecrets(output.join('\n'));
  });

  it('no DATABASE_URL in io.env: store_unavailable, even with one in process.env', async () => {
    vi.stubEnv(DATABASE_URL_ENV, testUrl);
    const { result, output } = await run(['museum'], { env: { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY } });
    expect(result.outcome?.ok === false && result.outcome.failure.kind).toBe('store_unavailable');
    expectNoSecrets(output.join('\n'));
  });

  it('refused key and unreachable database: no secrets in the output', async () => {
    const refused = await run(['museum'], { answer: { error: refusedError() } });
    const unreachable = await run(['museum'], {
      env: { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL },
    });
    expect([refused.result.exitCode, unreachable.result.exitCode]).toStrictEqual([1, 1]);
    expectNoSecrets([...refused.output, ...unreachable.output].join('\n'));
  }, 60_000);
});

describe('never rejects', () => {
  it.each([
    ['every write throws', ['museum'], () => true],
    ['every write throws on a usage error', ['museum', '--fast'], () => true],
    ['only the first write throws', ['museum'], (n: number) => n === 1],
  ])('%s: resolves { exitCode: 1 }', async (_, argv, throwsOn) => {
    let writes = 0;
    const result = await command(argv, {
      env: { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, [DATABASE_URL_ENV]: testUrl },
      write: () => {
        writes += 1;
        if (throwsOn(writes)) throw new Error(`stdout is closed ${TEST_VOYAGE_API_KEY}`);
      },
      embeddingService: new SimulatedQueryEmbeddingService(),
    });
    expect(SearchCommandResultSchema.parse(result)).toStrictEqual({ exitCode: 1 });
  });
});

it('no test reached the network', () => {
  expect(fetchCalls).toStrictEqual([]);
});
