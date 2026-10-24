/**
 * AL2 unit tests: `src/db/failures.ts` (AL4 1.4.3). Only what the storage contract tests do
 * not reach: the issue cap and empty-list fallback of `invalidData`, and which error codes
 * `unavailableFrom` quotes (own code, cause code, nothing else; AC-57).
 */
import { invalidData, unavailableFrom } from '../../src/db/failures';
import { UNREACHABLE_PASSWORD } from '../../contracts/storage.support';

function withCode(code: unknown, cause?: unknown): Error {
  return Object.assign(new Error(`secret ${UNREACHABLE_PASSWORD}`, { cause }), { code });
}

describe('invalidData', () => {
  it('keeps the first 20 issues and counts the rest', () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({ path: ['places', i], message: 'bad' }));
    const failure = invalidData(issues);
    expect(failure).toStrictEqual({
      kind: 'invalid_data',
      message: 'Invalid data: places[0]: bad (+19 more)',
      issues: issues.slice(0, 20),
    });
  });

  it('an empty list still gives one whole-input issue', () => {
    expect(invalidData([])).toStrictEqual({
      kind: 'invalid_data',
      message: 'Invalid data: (whole input): invalid value',
      issues: [{ path: [], message: 'invalid value' }],
    });
  });
});

it.each<[string, unknown, string]>([
  ['an errno code', withCode('ECONNREFUSED'), ' (ECONNREFUSED)'],
  ['a SQLSTATE code', withCode('28P01'), ' (28P01)'],
  ['a code on the cause', withCode(undefined, withCode('3D000')), ' (3D000)'],
  ['a lower-case code', withCode('econnrefused'), ''],
  ['a URL as code', withCode(`postgres://u:${UNREACHABLE_PASSWORD}@h/x`), ''],
  ['a numeric code', withCode(42), ''],
  ['a cause that is not an object', withCode(undefined, 'ECONNREFUSED'), ''],
  ['a non-object error', 'ECONNREFUSED', ''],
  ['null', null, ''],
])('unavailableFrom quotes only a safe code: %s', (_, error, suffix) => {
  expect(unavailableFrom(error, 'readPlace')).toStrictEqual({
    kind: 'store_unavailable',
    message: `Place Store unavailable: readPlace failed${suffix}`,
  });
});
