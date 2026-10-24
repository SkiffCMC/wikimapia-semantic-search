/**
 * AL2 unit tests: `src/crawl/config.ts` (AL4 1.4.1). The contract tests cover every setting-keyed
 * message; this pins down the path-based message for an issue without a setting key.
 */
import { resolveRun } from '../../src/crawl/config';
import { REGION_T1, testConfiguration } from '../../contracts/hydration.support';

describe('resolveRun', () => {
  it('a configuration issue without a setting key gets the path-based message', () => {
    const configuration = testConfiguration({ regions: [REGION_T1, REGION_T1] });
    expect(resolveRun({ regionName: REGION_T1.name }, configuration)).toStrictEqual({
      ok: false,
      message: 'Invalid crawl configuration: regions: Region Names must be unique',
    });
  });
});
