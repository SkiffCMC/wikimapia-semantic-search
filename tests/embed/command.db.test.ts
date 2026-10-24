/**
 * AL2 unit tests: the Embed Command, `runEmbedCommand` (`src/embed/command.ts`), against the Test
 * Database (AL4 embeddings 1.4.10, U7; AL6 AC-49 .. AC-51). AL3 routing
 * 20261023-embeddings-07-command, section 2.1, cases 1 .. 6.
 *
 * Real Place Store, Embedding Store and Schema Setup; the Embedding Service and the clock are the
 * contract's Simulated ones. Every `runEmbedCommand` call goes through `runCommand`, which always
 * injects `embeddingService` and `clock`: the real Voyage adapter is never built. Global `fetch`
 * is a rejecting spy. Synthetic key `TEST_VOYAGE_API_KEY` only. Test Database only
 * (`requireTestDatabaseUrl()`). No vector literal.
 */
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { runEmbedCommand } from '../../src/embed/command';
import {
  DATABASE_URL_ENV,
  EMBEDDING_OUTCOME_LABELS,
  EMBED_COMMAND_OPTIONS,
  EMBED_SUMMARY_LABELS,
  EmbedCommandResultSchema,
  VOYAGE_API_KEY_ENV,
  embedExitCodeFor,
} from '../../contracts/embeddings.schema';
import type {
  EmbedCommandIO,
  EmbedCommandResult,
  RunEmbedCommandFn,
} from '../../contracts/embeddings.schema';
import {
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  TEST_VOYAGE_API_KEY,
  fail,
  rateLimitError,
  refusedError,
  syntheticDetails,
  syntheticName,
} from '../../contracts/embeddings.support';
import type { ServiceResponder } from '../../contracts/embeddings.support';
import {
  EmptyResultSchema,
  SaveResultSchema,
  SchemaStepsResultSchema,
  buildWikimapiaLink,
} from '../../contracts/storage.schema';
import type { PlaceStore, SchemaSetup, StoreFailure } from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  UNREACHABLE_PASSWORD,
  listingOf,
  requireTestDatabaseUrl,
} from '../../contracts/storage.support';
import type { PlaceDetails, PlaceSummary } from '../../contracts/wikimapia-client.schema';

// Compile-time check: the entry point has the contract's signature.
const typedCommand: RunEmbedCommandFn = runEmbedCommand;

const LIMIT = EMBED_COMMAND_OPTIONS.limit;

// ---------------------------------------------------------------------------
// Lifecycle: Test Database migrated once, emptied before every test
// ---------------------------------------------------------------------------

let testUrl = '';
let setup: SchemaSetup;
let places: PlaceStore;
const fetchSpy = vi.fn((input: unknown) =>
  Promise.reject(new Error(`network is disabled in embed command tests: ${String(input)}`)),
);

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect(SchemaStepsResultSchema.parse(await setup.apply()).ok).toBe(true);
  places = createPlaceStore({ connectionString: testUrl });
}, 60_000);

beforeEach(async () => {
  expect(EmptyResultSchema.parse(await setup.emptyStore()).ok).toBe(true);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
});

afterAll(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  await places.close();
  await setup.close();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Seeding (every result is parsed with its contract schema before use)
// ---------------------------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  }
  return result.value;
}

async function saveDetails(details: PlaceDetails): Promise<void> {
  okValue(
    SaveResultSchema.parse(await places.savePlaceDetails({ details, fetchedAt: FETCHED_AT })),
  );
}

async function seedSynthetic(...ids: number[]): Promise<void> {
  for (const id of ids) await saveDetails(await syntheticDetails(id));
}

/** A synthetic Place Summary (Listing Save only: the Place stays Summary-Only). */
function syntheticSummary(placeId: number): PlaceSummary {
  const lon = 20.457;
  const lat = 44.817;
  return {
    placeId,
    name: syntheticName(placeId),
    url: buildWikimapiaLink(placeId),
    location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
    outline: [],
  };
}

async function seedSummaryOnly(...ids: number[]): Promise<void> {
  okValue(
    SaveResultSchema.parse(await places.saveListingPage(listingOf(...ids.map(syntheticSummary)))),
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CommandExtra {
  env?: EmbedCommandIO['env'];
  responder?: ServiceResponder;
}

interface CommandRun {
  result: EmbedCommandResult;
  output: string[];
  service: SimulatedEmbeddingService;
}

/** Runs the command over the Test Database with a Simulated Embedding Service and Clock. */
async function runCommand(argv: readonly string[], extra: CommandExtra = {}): Promise<CommandRun> {
  const clock = new SimulatedEmbeddingClock();
  const service = new SimulatedEmbeddingService(clock, extra.responder);
  const output: string[] = [];
  const io: EmbedCommandIO = {
    env: extra.env ?? { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY, [DATABASE_URL_ENV]: testUrl },
    write: (line: string) => {
      output.push(line);
    },
    embeddingService: service,
    clock,
  };
  const result = EmbedCommandResultSchema.parse(await runEmbedCommand(argv, io));
  expect(result.exitCode).toBe(embedExitCodeFor(result.report.outcome));
  for (const line of output) expect(line).not.toContain('\n');
  return { result, output, service };
}

function summaryLines(result: EmbedCommandResult): string[] {
  return result.report.summaryText.split('\n');
}

function outcomeLine(result: EmbedCommandResult): string {
  return `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS[result.report.outcome]}`;
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
  const password = decodeURIComponent(new URL(testUrl).password);
  if (password !== '') expect(text).not.toContain(password);
}

/**
 * Splits the written lines into progress lines, the failure message (when the report has one)
 * and the summary lines, checking that they come in exactly that order.
 */
function splitOutput(run: CommandRun): { progress: string[]; summary: string[] } {
  const lines = summaryLines(run.result);
  const message = run.result.report.message;
  const tailLength = lines.length + (message === undefined ? 0 : 1);
  expect(run.output.length).toBeGreaterThanOrEqual(tailLength);
  const tail = run.output.slice(run.output.length - tailLength);
  expect(tail).toStrictEqual(message === undefined ? lines : [message, ...lines]);
  const progress = run.output.slice(0, run.output.length - tailLength);
  for (const line of progress) {
    expect(lines).not.toContain(line);
    if (message !== undefined) expect(line).not.toBe(message);
  }
  return { progress, summary: run.output.slice(run.output.length - lines.length) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEmbedCommand with the Test Database', () => {
  it('0. the entry point has the RunEmbedCommandFn signature', () => {
    expect(typedCommand).toBe(runEmbedCommand);
  });

  it('1. no options (AC-49): 2 Detailed and 1 Summary-Only Place give Completed, exit 0, 2 texts sent', async () => {
    await seedSynthetic(301, 302);
    await seedSummaryOnly(401);
    const run = await runCommand([]);
    expect(run.result.report.outcome).toBe('completed');
    expect(run.result.exitCode).toBe(0);
    expect(run.service.texts).toHaveLength(2);
    expect(run.result.report.summary.counts.summaryOnlySkipped).toBe(1);
    expect(run.result.report.summary.counts.placesEmbedded).toBe(2);
    expect(run.output).toContain(outcomeLine(run.result));
    expect(run.output).toContain(
      `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS.completed}`,
    );
  });

  it('2. --limit 2 with 3 due: Limit Reached, exit 0, exactly 2 texts sent', async () => {
    await seedSynthetic(301, 302, 303);
    const run = await runCommand([LIMIT, '2']);
    expect(run.result.report.outcome).toBe('limit_reached');
    expect(run.result.exitCode).toBe(0);
    expect(run.service.texts).toHaveLength(2);
    expect(run.output).toContain(outcomeLine(run.result));
  });

  it('2b. a leading -- is dropped: -- --limit 2 behaves like --limit 2', async () => {
    await seedSynthetic(301, 302, 303);
    const run = await runCommand(['--', LIMIT, '2']);
    expect(run.result.report.outcome).toBe('limit_reached');
    expect(run.result.exitCode).toBe(0);
    expect(run.service.texts).toHaveLength(2);
  });

  it('3. Rate Limited: every request answered with the rate limit gives Rate Limited, exit 0', async () => {
    await seedSynthetic(301);
    const run = await runCommand([], { responder: () => fail(rateLimitError()) });
    expect(run.result.report.outcome).toBe('rate_limited');
    expect(run.result.exitCode).toBe(0);
    expect(run.service.calls.length).toBeGreaterThan(0);
    expect(run.output).toContain(
      `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS.rate_limited}`,
    );
  });

  it('4. Refused: Failed, exit 1, and no key, Bearer, password or postgres:// in any output', async () => {
    await seedSynthetic(301);
    const run = await runCommand([], { responder: () => fail(refusedError()) });
    expect(run.result.report.outcome).toBe('failed');
    expect(run.result.exitCode).toBe(1);
    expect(run.service.calls.length).toBeGreaterThan(0);
    expectNoSecrets([JSON.stringify(run.result), ...run.output].join('\n'));
    for (const line of run.output) expectNoSecrets(line);
  });

  describe('5. output order', () => {
    it('Completed: progress lines first, then every summary line in order, each its own write', async () => {
      await seedSynthetic(301, 302);
      const run = await runCommand([]);
      expect(run.result.report.message).toBeUndefined();
      const { progress, summary } = splitOutput(run);
      expect(progress.length).toBeGreaterThan(0);
      expect(summary).toStrictEqual(summaryLines(run.result));
    });

    it('Refused: progress lines, then the failure message, then every summary line', async () => {
      await seedSynthetic(301);
      const run = await runCommand([], { responder: () => fail(refusedError()) });
      expect(run.result.report.message).toBeDefined();
      const { progress, summary } = splitOutput(run);
      expect(progress.length).toBeGreaterThan(0);
      expect(summary).toStrictEqual(summaryLines(run.result));
    });

    it('Rate Limited: progress lines, then the message if any, then every summary line', async () => {
      await seedSynthetic(301);
      const run = await runCommand([], { responder: () => fail(rateLimitError()) });
      const { progress } = splitOutput(run);
      expect(progress.length).toBeGreaterThan(0);
    });

    it('Limit Reached: progress lines, then every summary line', async () => {
      await seedSynthetic(301, 302, 303);
      const run = await runCommand([LIMIT, '1']);
      expect(run.result.report.outcome).toBe('limit_reached');
      const { progress } = splitOutput(run);
      expect(progress.length).toBeGreaterThan(0);
    });
  });

  it('6. no Place Document text of a seeded Place appears in any written line', async () => {
    await seedSynthetic(301, 302, 303);
    const runs = [await runCommand([])];
    // 301 .. 303 are now kept; one more due Place gives the refused Run something to send.
    await seedSynthetic(304);
    runs.push(await runCommand([], { responder: () => fail(refusedError()) }));

    const documents = runs.flatMap((r) => r.service.texts);
    expect(documents.length).toBeGreaterThanOrEqual(4);
    const parts = new Set(documents.flatMap((document) => document.split('\n')));
    for (const id of [301, 302, 303, 304]) {
      expect(parts).toContain(syntheticName(id));
    }
    for (const run of runs) {
      for (const line of run.output) {
        for (const document of documents) expect(line).not.toContain(document);
        for (const part of parts) expect(line).not.toContain(part);
      }
      const reportText = JSON.stringify(run.result.report);
      for (const part of parts) expect(reportText).not.toContain(part);
    }
  });
});
