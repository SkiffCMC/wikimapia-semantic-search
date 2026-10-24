/**
 * AL2 unit tests: the Embed Command (`src/embed/command.ts`, AL4 embeddings 1.4.10). Only what
 * the contract tests do not reach: the leading `--`, repeated or valueless `--limit`, a missing
 * database URL and a throwing `write`. A Simulated service and clock are always injected; no
 * database, no network.
 */
import { parseEmbedArgs, runEmbedCommand } from '../../src/embed/command';
import { failedReport } from '../../src/embed/report';
import { VOYAGE_API_KEY_ENV } from '../../contracts/embeddings.schema';
import type { EmbedCommandIO } from '../../contracts/embeddings.schema';
import {
  RUN_START,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  TEST_VOYAGE_API_KEY,
} from '../../contracts/embeddings.support';

const KEY_ONLY_ENV = { [VOYAGE_API_KEY_ENV]: TEST_VOYAGE_API_KEY };

function io(
  write: (line: string) => void,
): EmbedCommandIO & { service: SimulatedEmbeddingService } {
  const clock = new SimulatedEmbeddingClock();
  const service = new SimulatedEmbeddingService(clock);
  return { env: KEY_ONLY_ENV, write, embeddingService: service, clock, service };
}

it.each([
  [['--', '--limit', '2'], { ok: true, request: { embeddingLimit: 2 } }],
  [['--limit', '2', '--limit', '3'], { ok: false, problem: 'option --limit given twice' }],
  [['--limit'], { ok: false, problem: 'missing value for --limit' }],
])('parseEmbedArgs(%j)', (argv, parsed) => {
  expect(parseEmbedArgs(argv)).toStrictEqual(parsed);
});

it('without a database URL the run fails before sending anything', async () => {
  const lines: string[] = [];
  const command = io((line) => lines.push(line));
  const result = await runEmbedCommand([], command);
  expect(result.exitCode).toBe(1);
  expect(result.report.outcome).toBe('failed');
  expect(result.report.message).toMatch(/not configured/);
  expect(command.service.calls).toHaveLength(0);
  expect(lines[0]).toBe(result.report.message);
});

it.each([
  ['a parse problem', ['--dry-run']],
  ['a run', []],
])('a throwing write on %s resolves the internal-error report', async (_label, argv) => {
  const command = io(() => {
    throw new Error(`stdout is closed ${TEST_VOYAGE_API_KEY}`);
  });
  expect(await runEmbedCommand(argv, command)).toStrictEqual({
    exitCode: 1,
    report: failedReport('Embedding run failed: internal error', RUN_START, RUN_START),
  });
});
