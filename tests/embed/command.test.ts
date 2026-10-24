/**
 * AL2 unit tests: `src/embed/command.ts` (`parseEmbedArgs`, `runEmbedCommand`), the paths that
 * need no database (AL4 embeddings 1.4.10 Embed Command and script, 1.3 `ParsedEmbedArgs`,
 * `usageMessage`, `failedReport`; U7; AL6 AC-40, AC-41, AC-49 .. AC-51). AL3 routing
 * 20261023-embeddings-07-command, section 2.1, groups 1 .. 3.
 *
 * `parseEmbedArgs` is pure. Every `runEmbedCommand` call goes through `runCommand`, which always
 * injects a `SimulatedEmbeddingService` and a `SimulatedEmbeddingClock`: the real Voyage adapter
 * is never built. The env holds only the synthetic key and, where a database URL is given, the
 * unreachable one, so no database is ever reached here. Global `fetch` is a rejecting spy. Every
 * result is parsed with `EmbedCommandResultSchema`. Runs that need stored Places live in
 * `./command.db.test.ts`.
 */
import { parseEmbedArgs, runEmbedCommand } from '../../src/embed/command';
import { usageMessage } from '../../src/embed/settings';
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
  EmbeddingRunOutcome,
  RunEmbedCommandFn,
} from '../../contracts/embeddings.schema';
import {
  RUN_START,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  TEST_VOYAGE_API_KEY,
} from '../../contracts/embeddings.support';
import type { ServiceResponder } from '../../contracts/embeddings.support';
import { toMoment } from '../../contracts/hydration.schema';
import { UNREACHABLE_DATABASE_URL, UNREACHABLE_PASSWORD } from '../../contracts/storage.support';

// Compile-time check: the entry point has the contract's signature.
const typedCommand: RunEmbedCommandFn = runEmbedCommand;

const INTERNAL_ERROR_MESSAGE = 'Embedding run failed: internal error';
const LIMIT = EMBED_COMMAND_OPTIONS.limit;

/** A valid synthetic key and a database URL where nothing listens. */
const UNREACHABLE_ENV: EmbedCommandIO['env'] = {
  [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY,
  [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL,
};

// ---------------------------------------------------------------------------
// Lifecycle: no network
// ---------------------------------------------------------------------------

const fetchSpy = vi.fn((input: unknown) =>
  Promise.reject(new Error(`network is disabled in embed command tests: ${String(input)}`)),
);

/** Every outcome the command reached in this file (group 3 (g)). */
const reachedOutcomes = new Set<EmbeddingRunOutcome>();

beforeAll(() => {
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
});

afterAll(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CommandExtra {
  env?: EmbedCommandIO['env'];
  responder?: ServiceResponder;
  signal?: AbortSignal;
  clock?: SimulatedEmbeddingClock;
  write?: (line: string) => void;
}

interface CommandRun {
  result: EmbedCommandResult;
  output: string[];
  service: SimulatedEmbeddingService;
  clock: SimulatedEmbeddingClock;
}

/**
 * Runs the command with a Simulated Embedding Service and Simulated Clock (always injected).
 * Checks the invariants every result keeps: the contract schema, `embedExitCodeFor` agreement
 * and single-line writes.
 */
async function runCommand(argv: readonly string[], extra: CommandExtra = {}): Promise<CommandRun> {
  const clock = extra.clock ?? new SimulatedEmbeddingClock();
  const service = new SimulatedEmbeddingService(clock, extra.responder);
  const output: string[] = [];
  const io: EmbedCommandIO = {
    env: extra.env ?? UNREACHABLE_ENV,
    write:
      extra.write ??
      ((line: string) => {
        output.push(line);
      }),
    embeddingService: service,
    clock,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  };
  const result = EmbedCommandResultSchema.parse(await runEmbedCommand(argv, io));
  expect(result.exitCode).toBe(embedExitCodeFor(result.report.outcome));
  for (const line of output) expect(line).not.toContain('\n');
  reachedOutcomes.add(result.report.outcome);
  return { result, output, service, clock };
}

function summaryLines(result: EmbedCommandResult): string[] {
  return result.report.summaryText.split('\n');
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(TEST_VOYAGE_API_KEY);
  expect(text).not.toMatch(/Bearer\s/);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(UNREACHABLE_PASSWORD);
}

function everyOutput(run: CommandRun): string {
  return [JSON.stringify(run.result), ...run.output].join('\n');
}

function parsedRequest(argv: readonly string[]) {
  const parsed = parseEmbedArgs(Object.freeze([...argv]));
  if (!parsed.ok) throw new Error(`expected a request, got the problem: ${parsed.problem}`);
  return parsed.request;
}

function parsedProblem(argv: readonly string[]): string {
  const parsed = parseEmbedArgs(Object.freeze([...argv]));
  if (parsed.ok) throw new Error(`expected a problem, got ${JSON.stringify(parsed.request)}`);
  return parsed.problem;
}

/** Group 2: every argv that is a parse problem, with its exact problem text. */
const PROBLEMS: readonly (readonly [readonly string[], string])[] = [
  [[LIMIT, '2', LIMIT, '3'], `option ${LIMIT} given twice`],
  [[LIMIT], `missing value for ${LIMIT}`],
  [['--dry-run'], 'unknown option "--dry-run"'],
  [['--region'], 'unknown option "--region"'],
  [['extra'], 'unknown option "extra"'],
];

// ---------------------------------------------------------------------------
// 1. parseEmbedArgs: parsing
// ---------------------------------------------------------------------------

describe('entry point', () => {
  it('src/embed/command exports runEmbedCommand as a RunEmbedCommandFn', () => {
    expect(typedCommand).toBe(runEmbedCommand);
    expect(typeof parseEmbedArgs).toBe('function');
  });
});

describe('parseEmbedArgs: parsing (1)', () => {
  it('[] gives an empty request without the embeddingLimit key', () => {
    const parsed = parseEmbedArgs([]);
    expect(parsed).toStrictEqual({ ok: true, request: {} });
    if (!parsed.ok) throw new Error('expected a request');
    expect('embeddingLimit' in parsed.request).toBe(false);
  });

  it('--limit 2 gives exactly { embeddingLimit: 2 }', () => {
    expect(parseEmbedArgs(Object.freeze([LIMIT, '2']))).toStrictEqual({
      ok: true,
      request: { embeddingLimit: 2 },
    });
  });

  it('the option name is EMBED_COMMAND_OPTIONS.limit, i.e. --limit', () => {
    expect(LIMIT).toBe('--limit');
    expect(parsedRequest(['--limit', '7'])).toStrictEqual({ embeddingLimit: 7 });
  });

  it('drops one leading --', () => {
    expect(parseEmbedArgs(['--', LIMIT, '2'])).toStrictEqual({
      ok: true,
      request: { embeddingLimit: 2 },
    });
    expect(parseEmbedArgs(['--'])).toStrictEqual({ ok: true, request: {} });
  });

  it('a -- in any other position is an unknown option', () => {
    expect(parsedProblem([LIMIT, '2', '--'])).toBe('unknown option "--"');
    expect(parsedProblem(['--', '--'])).toBe('unknown option "--"');
    expect(parsedProblem(['--', LIMIT, '2', '--'])).toBe('unknown option "--"');
  });

  it('--limit -3 reads -3 as the value', () => {
    expect(parsedRequest([LIMIT, '-3'])).toStrictEqual({ embeddingLimit: -3 });
  });

  it("--limit 2.5 gives 2.5 and --limit 0 gives 0 (validation is the Run's job)", () => {
    expect(parsedRequest([LIMIT, '2.5'])).toStrictEqual({ embeddingLimit: 2.5 });
    expect(parsedRequest([LIMIT, '0'])).toStrictEqual({ embeddingLimit: 0 });
  });

  it('--limit --limit takes the second --limit as the value, which is NaN', () => {
    const request = parsedRequest([LIMIT, LIMIT]);
    expect(Object.keys(request)).toStrictEqual(['embeddingLimit']);
    expect(Number.isNaN(request.embeddingLimit)).toBe(true);
  });

  it.each(['abc', '', '1e3', '0x10', '+2', ' 2'])('--limit %j gives NaN', (value) => {
    const request = parsedRequest([LIMIT, value]);
    expect(Object.keys(request)).toStrictEqual(['embeddingLimit']);
    expect(request.embeddingLimit).toBeTypeOf('number');
    expect(Number.isNaN(request.embeddingLimit)).toBe(true);
  });

  it('does not change the given argv', () => {
    const argv = ['--', LIMIT, '2'];
    const copy = [...argv];
    parseEmbedArgs(argv);
    expect(argv).toStrictEqual(copy);

    const problemArgv = ['--dry-run', LIMIT];
    const problemCopy = [...problemArgv];
    parseEmbedArgs(problemArgv);
    expect(problemArgv).toStrictEqual(problemCopy);
  });
});

// ---------------------------------------------------------------------------
// 2. parseEmbedArgs: problems
// ---------------------------------------------------------------------------

describe('parseEmbedArgs: problems (2)', () => {
  it.each(PROBLEMS)('%j gives exactly the problem %j and no request', (argv, problem) => {
    const parsed = parseEmbedArgs(Object.freeze([...argv]));
    expect(parsed).toStrictEqual({ ok: false, problem });
    expect('request' in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. runEmbedCommand without a database
// ---------------------------------------------------------------------------

describe('runEmbedCommand: parse problems (3a)', () => {
  it.each(PROBLEMS)(
    '%j: Failed, exit 1, "<problem>. <usage>", nothing sent, message then summary lines',
    async (argv, problem) => {
      const run = await runCommand(argv);
      const { result, output, service } = run;
      expect(result.report.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.report.message).toBe(`${problem}. ${usageMessage()}`);
      expect(result.report.message).toContain(LIMIT);
      expect(service.calls).toHaveLength(0);
      expect(output).toStrictEqual([result.report.message, ...summaryLines(result)]);
      expect(output).toContain(
        `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS.failed}`,
      );
      expect(result.report.summary.startedAt).toBe(RUN_START);
      expect(result.report.summary.endedAt).toBe(RUN_START);
    },
  );

  it('the usage message is "Usage: pnpm embed [--limit <n>]"', () => {
    expect(usageMessage()).toBe(`Usage: pnpm embed [${LIMIT} <n>]`);
  });

  it('uses the injected clock for both moments of the failed report', async () => {
    const clock = new SimulatedEmbeddingClock('2026-11-01T10:20:30.700Z');
    const { result } = await runCommand(['--dry-run'], { clock });
    const moment = toMoment(new Date('2026-11-01T10:20:30.700Z'));
    expect(moment).toBe('2026-11-01T10:20:30Z');
    expect(result.report.summary.startedAt).toBe(moment);
    expect(result.report.summary.endedAt).toBe(moment);
  });

  it('a parse problem fails even with an empty env (nothing else is checked first)', async () => {
    const { result, service } = await runCommand(['extra'], { env: {} });
    expect(result.report.outcome).toBe('failed');
    expect(result.report.message).toBe(`unknown option "extra". ${usageMessage()}`);
    expect(service.calls).toHaveLength(0);
  });
});

describe('runEmbedCommand: invalid --limit values (3b)', () => {
  it.each(['abc', '0', '-3', '2.5'])(
    '--limit %s: Failed, exit 1, message names embeddingLimit, nothing sent',
    async (value) => {
      const { result, output, service } = await runCommand([LIMIT, value]);
      expect(result.report.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.report.message).toContain('embeddingLimit');
      expect(service.calls).toHaveLength(0);
      expect(output).toStrictEqual([result.report.message, ...summaryLines(result)]);
    },
  );

  it('the setting is checked before the key: --limit abc with no key still names embeddingLimit', async () => {
    const { result, service } = await runCommand([LIMIT, 'abc'], {
      env: { [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL },
    });
    expect(result.report.outcome).toBe('failed');
    expect(result.report.message).toContain('embeddingLimit');
    expect(service.calls).toHaveLength(0);
  });
});

describe('runEmbedCommand: missing Voyage key (3c)', () => {
  it.each([
    ['absent', { [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL }],
    ['blank', { [VOYAGE_API_KEY_ENV]: '   ', [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL }],
  ] as const)(
    'key %s: Failed, exit 1, the message names the key variable, nothing sent',
    async (_, env) => {
      const { result, output, service } = await runCommand([], { env });
      expect(result.report.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.report.message).toContain(VOYAGE_API_KEY_ENV);
      expect(service.calls).toHaveLength(0);
      expect(output).toStrictEqual([result.report.message, ...summaryLines(result)]);
    },
  );
});

describe('runEmbedCommand: no database URL (3d)', () => {
  it('a valid key and no database URL: Failed, exit 1, nothing sent, no secrets anywhere', async () => {
    const run = await runCommand([], { env: { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY } });
    expect(run.result.report.outcome).toBe('failed');
    expect(run.result.exitCode).toBe(1);
    expect(run.service.calls).toHaveLength(0);
    const lines = summaryLines(run.result);
    expect(run.output.slice(run.output.length - lines.length)).toStrictEqual(lines);
    expectNoSecrets(everyOutput(run));
  });

  it('the parse-problem and missing-key outputs carry no secrets either', async () => {
    for (const run of [
      await runCommand(['--dry-run']),
      await runCommand([LIMIT, 'abc']),
      await runCommand([], { env: { [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL } }),
    ]) {
      expectNoSecrets(everyOutput(run));
    }
  });
});

describe('runEmbedCommand: already interrupted (3e)', () => {
  it('an aborted signal: Interrupted, exit 1, nothing sent, the summary is written', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, output, service } = await runCommand([], { signal: controller.signal });
    expect(result.report.outcome).toBe('interrupted');
    expect(result.exitCode).toBe(1);
    expect(service.calls).toHaveLength(0);
    const lines = summaryLines(result);
    expect(output.slice(output.length - lines.length)).toStrictEqual(lines);
    expect(output).toContain(
      `${EMBED_SUMMARY_LABELS.outcome}: ${EMBEDDING_OUTCOME_LABELS.interrupted}`,
    );
  });
});

describe('runEmbedCommand: never rejects (3f)', () => {
  it('a write that throws on its first call resolves Failed, exit 1, without the error text', async () => {
    const thrownText = `stdout is closed ${TEST_VOYAGE_API_KEY}`;
    const write = vi.fn((): void => {
      if (write.mock.calls.length === 1) throw new Error(thrownText);
    });
    const { result } = await runCommand(['--dry-run'], { write });
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(result.report.message).not.toContain('stdout is closed');
    expect(JSON.stringify(result)).not.toContain('stdout is closed');
    expect(JSON.stringify(result)).not.toContain(TEST_VOYAGE_API_KEY);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a write that always throws, on a Run failure path, also resolves Failed, exit 1', async () => {
    const write = vi.fn((): void => {
      throw new Error('stdout is closed');
    });
    const { result, service } = await runCommand([], {
      env: { [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL },
      write,
    });
    expect(result.report.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.report.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('stdout is closed');
    expect(service.calls).toHaveLength(0);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('runEmbedCommand: embedExitCodeFor agreement (3g)', () => {
  it('every outcome reached in this file maps through embedExitCodeFor', async () => {
    const controller = new AbortController();
    controller.abort();
    const runs = [
      await runCommand(['--nope']),
      await runCommand([LIMIT, '0']),
      await runCommand([], { env: { [DATABASE_URL_ENV]: UNREACHABLE_DATABASE_URL } }),
      await runCommand([], { signal: controller.signal }),
    ];
    expect(runs.map((r) => r.result.report.outcome)).toStrictEqual([
      'failed',
      'failed',
      'failed',
      'interrupted',
    ]);
    for (const { result } of runs) {
      expect(result.exitCode).toBe(embedExitCodeFor(result.report.outcome));
    }
    expect([...reachedOutcomes].sort()).toStrictEqual(['failed', 'interrupted']);
    for (const outcome of reachedOutcomes) expect(embedExitCodeFor(outcome)).toBe(1);
  });
});
