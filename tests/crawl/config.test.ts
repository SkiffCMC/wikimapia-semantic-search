/**
 * AL2 unit tests: `src/crawl/config.ts` (AL4 1.3 `config.ts` signatures, 1.4.1 Resolving the Run;
 * AL6 AC-1, AC-5, AC-6, AC-60, AC-67; crawl-run1-fixes AL4 1.2 step 1 `retryParked`, 1.4.11 usage).
 *
 * Pure and synchronous: no database, no network, no clock. Configurations come from the contract
 * (`DEFAULT_CRAWL_CONFIGURATION`) and the support file (`testConfiguration`, Region T). API keys
 * are obviously fake strings.
 */
import { isMissingApiKey, knownRegionNames, resolveRun, usageMessage } from '../../src/crawl/config';
import { planTiles } from '../../src/crawl/tile-plan';
import {
  BELGRADE_SMALL_REGION,
  CRAWL_COMMAND_OPTIONS,
  DEFAULT_CRAWL_CONFIGURATION,
  type CrawlConfiguration,
  type CrawlRequest,
} from '../../contracts/hydration.schema';
import { REGION_T1, testConfiguration } from '../../contracts/hydration.support';

type Resolution = ReturnType<typeof resolveRun>;
type Resolved = Extract<Resolution, { ok: true }>['run'];
type Unresolved = Extract<Resolution, { ok: false }>;

const PREFIX = 'Invalid crawl configuration:';

function resolved(resolution: Resolution): Resolved {
  if (!resolution.ok) throw new Error(`expected a resolved Run, got: ${resolution.message}`);
  return resolution.run;
}

function unresolved(resolution: Resolution): Unresolved {
  if (resolution.ok) throw new Error('expected resolveRun to fail');
  return resolution;
}

describe('resolveRun: success', () => {
  it('resolves belgrade-small with the default configuration', () => {
    const run = resolved(resolveRun({ regionName: 'belgrade-small' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(run.regionName).toBe('belgrade-small');
    expect(run.region).toStrictEqual(BELGRADE_SMALL_REGION);
    expect(run.plan).toStrictEqual(planTiles(BELGRADE_SMALL_REGION));
    expect(run.configuration).toStrictEqual(DEFAULT_CRAWL_CONFIGURATION);
  });

  it('dryRun and relist are false when absent', () => {
    const run = resolved(resolveRun({ regionName: 'belgrade-small' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(run.dryRun).toBe(false);
    expect(run.relist).toBe(false);
  });

  it('dryRun and relist are true when given', () => {
    const run = resolved(
      resolveRun(
        { regionName: 'belgrade-small', dryRun: true, relist: true },
        DEFAULT_CRAWL_CONFIGURATION,
      ),
    );
    expect(run.dryRun).toBe(true);
    expect(run.relist).toBe(true);
  });

  it('dryRun and relist given as false stay false', () => {
    const run = resolved(
      resolveRun(
        { regionName: 'belgrade-small', dryRun: false, relist: false },
        DEFAULT_CRAWL_CONFIGURATION,
      ),
    );
    expect(run.dryRun).toBe(false);
    expect(run.relist).toBe(false);
  });

  it('retryParked is false when absent', () => {
    const run = resolved(resolveRun({ regionName: 'belgrade-small' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(run.retryParked).toBe(false);
  });

  it('retryParked is true when given', () => {
    const run = resolved(
      resolveRun({ regionName: 'belgrade-small', retryParked: true }, DEFAULT_CRAWL_CONFIGURATION),
    );
    expect(run.retryParked).toBe(true);
  });

  it('retryParked given as false stays false', () => {
    const run = resolved(
      resolveRun({ regionName: 'belgrade-small', retryParked: false }, DEFAULT_CRAWL_CONFIGURATION),
    );
    expect(run.retryParked).toBe(false);
  });

  it('retryParked combines with dryRun, relist and requestBudget', () => {
    const run = resolved(
      resolveRun(
        {
          regionName: REGION_T1.name,
          retryParked: true,
          dryRun: true,
          relist: true,
          requestBudget: 10,
        },
        testConfiguration(),
      ),
    );
    expect(run.retryParked).toBe(true);
    expect(run.dryRun).toBe(true);
    expect(run.relist).toBe(true);
    expect(run.configuration.requestBudget).toBe(10);
    expect(run.plan).toStrictEqual(planTiles(REGION_T1));
  });

  it('retryParked does not change the resolved configuration or plan', () => {
    const plain = resolved(resolveRun({ regionName: REGION_T1.name }, testConfiguration()));
    const retrying = resolved(
      resolveRun({ regionName: REGION_T1.name, retryParked: true }, testConfiguration()),
    );
    expect(retrying.configuration).toStrictEqual(plain.configuration);
    expect(retrying.plan).toStrictEqual(plain.plan);
    expect(retrying.dryRun).toBe(false);
    expect(retrying.relist).toBe(false);
  });

  it('trims the asked Region Name', () => {
    const run = resolved(resolveRun({ regionName: '  belgrade-small ' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(run.regionName).toBe('belgrade-small');
    expect(run.region.name).toBe('belgrade-small');
  });

  it('resolves a Region of a test configuration with its own plan', () => {
    const run = resolved(resolveRun({ regionName: REGION_T1.name }, testConfiguration()));
    expect(run.region).toStrictEqual(REGION_T1);
    expect(run.plan).toStrictEqual(planTiles(REGION_T1));
  });
});

describe('resolveRun: overrides', () => {
  it('request overrides replace the configuration values in run.configuration', () => {
    const run = resolved(
      resolveRun(
        {
          regionName: REGION_T1.name,
          requestBudget: 20,
          minRequestIntervalSeconds: 1.5,
          refreshAgeDays: 0,
        },
        testConfiguration(),
      ),
    );
    expect(run.configuration.requestBudget).toBe(20);
    expect(run.configuration.minRequestIntervalSeconds).toBe(1.5);
    expect(run.configuration.refreshAgeDays).toBe(0);
    expect(run.configuration.listingPageSize).toBe(100);
    expect(run.configuration.regions).toStrictEqual(testConfiguration().regions);
  });

  it('a request budget of 0 is a valid override', () => {
    const run = resolved(resolveRun({ regionName: REGION_T1.name, requestBudget: 0 }, testConfiguration()));
    expect(run.configuration.requestBudget).toBe(0);
  });

  it('absent overrides keep the configuration values', () => {
    const configuration = testConfiguration({
      requestBudget: 42,
      minRequestIntervalSeconds: 3,
      refreshAgeDays: 7,
    });
    const run = resolved(resolveRun({ regionName: REGION_T1.name }, configuration));
    expect(run.configuration).toStrictEqual(configuration);
  });

  it('only the given override changes', () => {
    const run = resolved(resolveRun({ regionName: REGION_T1.name, refreshAgeDays: 2 }, testConfiguration()));
    expect(run.configuration).toStrictEqual(testConfiguration({ refreshAgeDays: 2 }));
  });

  it('does not mutate the input configuration or request', () => {
    const configuration = testConfiguration();
    const configurationBefore = structuredClone(configuration);
    const request: CrawlRequest = {
      regionName: ` ${REGION_T1.name} `,
      requestBudget: 1,
      minRequestIntervalSeconds: 0,
      refreshAgeDays: 1,
    };
    const requestBefore = structuredClone(request);
    resolved(resolveRun(request, configuration));
    expect(configuration).toStrictEqual(configurationBefore);
    expect(request).toStrictEqual(requestBefore);
  });
});

describe('resolveRun: invalid configuration names the setting (AC-6)', () => {
  const cases: {
    setting: string;
    regionLevel: boolean;
    configuration?: CrawlConfiguration;
    request?: Partial<CrawlRequest>;
  }[] = [
    {
      setting: 'bbox',
      regionLevel: true,
      configuration: testConfiguration({
        regions: [
          { ...REGION_T1, bbox: { west: 20.462, south: 44.814, east: 20.452, north: 44.82 } },
        ],
      }),
    },
    {
      setting: 'tileSize',
      regionLevel: true,
      configuration: testConfiguration({
        regions: [{ ...REGION_T1, tileSize: { width: 0, height: 0.005 } }],
      }),
    },
    { setting: 'listingPageSize', regionLevel: false, configuration: testConfiguration({ listingPageSize: 0 }) },
    { setting: 'listingPageSize', regionLevel: false, configuration: testConfiguration({ listingPageSize: 101 }) },
    { setting: 'refreshAgeDays', regionLevel: false, configuration: testConfiguration({ refreshAgeDays: -1 }) },
    {
      setting: 'minRequestIntervalSeconds',
      regionLevel: false,
      configuration: testConfiguration({ minRequestIntervalSeconds: Number.NaN }),
    },
    { setting: 'requestBudget', regionLevel: false, configuration: testConfiguration({ requestBudget: -3 }) },
    { setting: 'requestBudget', regionLevel: false, request: { requestBudget: Number.NaN } },
    { setting: 'refreshAgeDays', regionLevel: false, request: { refreshAgeDays: -0.5 } },
  ];

  for (const [i, c] of cases.entries()) {
    it(`case ${String(i + 1)}: an invalid ${c.setting} fails with a message naming it`, () => {
      const result = unresolved(
        resolveRun(
          { regionName: REGION_T1.name, ...c.request },
          c.configuration ?? testConfiguration(),
        ),
      );
      expect(result.message.startsWith(PREFIX)).toBe(true);
      expect(result.message).toContain(c.setting);
      const settingPart = `${PREFIX} setting "${c.setting}"`;
      if (c.regionLevel) {
        expect(result.message).toContain(`of region "${REGION_T1.name}"`);
        expect(result.message.startsWith(`${settingPart} of region "${REGION_T1.name}": `)).toBe(true);
      } else {
        expect(result.message).not.toContain('of region');
        expect(result.message.startsWith(`${settingPart}: `)).toBe(true);
      }
    });
  }

  it('the reversed bbox message is exactly the AL4 form with the contract issue message', () => {
    const result = unresolved(
      resolveRun(
        { regionName: REGION_T1.name },
        testConfiguration({
          regions: [
            { ...REGION_T1, bbox: { west: 20.462, south: 44.814, east: 20.452, north: 44.82 } },
          ],
        }),
      ),
    );
    expect(result.message).toBe(
      `${PREFIX} setting "bbox" of region "test-one": west must be less than east`,
    );
  });

  it('an invalid configuration fails even for a Dry Run', () => {
    const result = unresolved(
      resolveRun({ regionName: REGION_T1.name, dryRun: true }, testConfiguration({ requestBudget: -3 })),
    );
    expect(result.message.startsWith(`${PREFIX} setting "requestBudget"`)).toBe(true);
  });

  it('validation comes before the Region: an unknown Region still gets the configuration message', () => {
    const result = unresolved(
      resolveRun({ regionName: 'atlantis' }, testConfiguration({ listingPageSize: 0 })),
    );
    expect(result.message.startsWith(`${PREFIX} setting "listingPageSize"`)).toBe(true);
  });

  it('validation comes before the Region: an absent Region still gets the configuration message', () => {
    const result = unresolved(resolveRun({}, testConfiguration({ refreshAgeDays: -1 })));
    expect(result.message.startsWith(`${PREFIX} setting "refreshAgeDays"`)).toBe(true);
  });
});

describe('resolveRun: configuration issue without a setting key', () => {
  it('duplicate Region Names fail with the path-based message and do not throw', () => {
    const configuration = testConfiguration({ regions: [REGION_T1, REGION_T1] });
    let resolution: Resolution | undefined;
    expect(() => {
      resolution = resolveRun({ regionName: REGION_T1.name }, configuration);
    }).not.toThrow();
    if (resolution === undefined) throw new Error('resolveRun returned nothing');
    const result = unresolved(resolution);
    expect(result.message.startsWith(PREFIX)).toBe(true);
    expect(result.message).toBe(`${PREFIX} regions: Region Names must be unique`);
  });
});

describe('resolveRun: messages never carry input values', () => {
  it('a requestBudget of -3 is named, but -3 does not appear', () => {
    const result = unresolved(
      resolveRun({ regionName: REGION_T1.name }, testConfiguration({ requestBudget: -3 })),
    );
    expect(result.message).toContain('requestBudget');
    expect(result.message).not.toContain('-3');
  });

  it('a refreshAgeDays override of -0.5 is named, but -0.5 does not appear', () => {
    const result = unresolved(
      resolveRun({ regionName: REGION_T1.name, refreshAgeDays: -0.5 }, testConfiguration()),
    );
    expect(result.message).toContain('refreshAgeDays');
    expect(result.message).not.toContain('-0.5');
  });
});

describe('resolveRun: unknown Region (AC-5, AC-1)', () => {
  it('fails naming the asked Region and exactly the known Region Names', () => {
    const result = unresolved(resolveRun({ regionName: 'atlantis' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(result.regionName).toBe('atlantis');
    expect(result.message).toContain('atlantis');
    const names = result.message.match(/\bbelgrade(?:-[a-z0-9-]+)?\b/g) ?? [];
    expect([...new Set(names)].sort()).toStrictEqual(['belgrade', 'belgrade-small']);
  });

  it('the message has the AL4 form', () => {
    const result = unresolved(resolveRun({ regionName: 'atlantis' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(result.message).toBe('Unknown region "atlantis". Known regions: belgrade, belgrade-small.');
  });

  it('the asked name is trimmed before lookup and in the result', () => {
    const result = unresolved(resolveRun({ regionName: '  nowhere ' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(result.regionName).toBe('nowhere');
    expect(result.message).toContain('"nowhere"');
  });

  it('lookup is by exact name (no case folding)', () => {
    const result = unresolved(resolveRun({ regionName: 'Belgrade' }, DEFAULT_CRAWL_CONFIGURATION));
    expect(result.regionName).toBe('Belgrade');
  });
});

describe('resolveRun: missing Region (AC-60)', () => {
  const blanks: [string, CrawlRequest][] = [
    ['absent', {}],
    ['empty', { regionName: '' }],
    ['blank', { regionName: '   ' }],
  ];

  for (const [label, request] of blanks) {
    it(`${label} regionName fails with the usage message and no regionName`, () => {
      const result = unresolved(resolveRun(request, DEFAULT_CRAWL_CONFIGURATION));
      expect(result).not.toHaveProperty('regionName');
      expect(result.message).toBe(usageMessage(['belgrade', 'belgrade-small']));
      expect(result.message).toContain(CRAWL_COMMAND_OPTIONS.region);
      expect(result.message).toContain('belgrade');
      expect(result.message).toContain('belgrade-small');
    });
  }
});

describe('usageMessage', () => {
  it('has the AL4 form with the region option and the given names', () => {
    expect(usageMessage(['a', 'b-c'])).toBe(
      `No region given. Usage: pnpm crawl ${CRAWL_COMMAND_OPTIONS.region} <name> [--dry-run] [--relist] [${CRAWL_COMMAND_OPTIONS.retryParked}] [--budget <n>] [--min-interval <seconds>] [--refresh-age <days>]. Known regions: a, b-c.`,
    );
  });
});

describe('knownRegionNames', () => {
  it('lists the default Region Names in configuration order', () => {
    expect(knownRegionNames(DEFAULT_CRAWL_CONFIGURATION)).toStrictEqual(['belgrade', 'belgrade-small']);
  });

  it('lists the test Region Names in configuration order', () => {
    expect(knownRegionNames(testConfiguration())).toStrictEqual([
      'test-one',
      'test-two',
      'test-four',
      'test-far',
    ]);
  });
});

describe('isMissingApiKey', () => {
  it.each([[undefined], [''], ['   '], [' \t ']])('is true for %j', (key) => {
    expect(isMissingApiKey(key)).toBe(true);
  });

  it.each([['fake-key'], [' fake ']])('is false for %j', (key) => {
    expect(isMissingApiKey(key)).toBe(false);
  });
});
