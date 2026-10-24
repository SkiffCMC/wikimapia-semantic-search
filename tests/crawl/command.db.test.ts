/**
 * AL2 unit test: `src/crawl/command.ts` with the Test Database (crawl-run1-fixes AL4 1.4.10). The
 * contract tests cover the command's Runs; this pins down the extra parked line of a
 * `--retry-parked` Dry Run, between the plan lines and the summary lines. No network.
 */
import { runCrawlCommand } from '../../src/crawl/command';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { SimulatedCrawlClock } from '../../contracts/hydration.support';
import type { SchemaSetup } from '../../contracts/storage.schema';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

let setup: SchemaSetup;

beforeAll(async () => {
  setup = createSchemaSetup({ connectionString: requireTestDatabaseUrl() });
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
}, 60_000);

afterAll(async () => {
  await setup.close();
});

describe('runCrawlCommand', () => {
  it('a --retry-parked Dry Run writes the plan, the parked line, then the summary', async () => {
    const output: string[] = [];
    const { exitCode, report } = await runCrawlCommand(
      ['--region', 'belgrade-small', '--dry-run', '--retry-parked'],
      {
        env: { DATABASE_URL: requireTestDatabaseUrl() },
        write: (line) => {
          output.push(line);
        },
        clock: new SimulatedCrawlClock(),
      },
    );
    expect(exitCode).toBe(0);
    expect(report.parkedPlacesInRegion).toBe(0);
    expect(output.slice(0, 6)).toStrictEqual([
      'Region belgrade-small: 4 tiles',
      'Tile 1: west 20.452, south 44.814, east 20.457, north 44.819',
      'Tile 2: west 20.457, south 44.814, east 20.462, north 44.819',
      'Tile 3: west 20.452, south 44.819, east 20.457, north 44.82',
      'Tile 4: west 20.457, south 44.819, east 20.462, north 44.82',
      'Parked places that --retry-parked would release: 0',
    ]);
    expect(output.slice(6)).toStrictEqual(report.summaryText.split('\n'));
  });
});
