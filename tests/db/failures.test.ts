/**
 * AL2 unit tests: `src/db/failures.ts` (AL4 1.3 `failures.ts` block, 1.4.3 Failures).
 *
 * Pure and synchronous. Errors are synthetic; the only "secret" is the contract's synthetic
 * `UNREACHABLE_PASSWORD` (AC-57). No database, no network.
 */
import {
  describeStoreIssues,
  invalidData,
  safeErrorCode,
  storeUnavailable,
  unavailableFrom,
} from '../../src/db/failures';
import {
  InvalidDataFailureSchema,
  StoreUnavailableFailureSchema,
  type StoreFailure,
  type StoreIssue,
} from '../../contracts/storage.schema';
import { UNREACHABLE_PASSWORD } from '../../contracts/storage.support';

function issue(n: number): StoreIssue {
  return { path: ['places', n, 'placeId'], message: `issue ${String(n)}` };
}

function withCode(code: unknown, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// 1. invalidData
// ---------------------------------------------------------------------------

describe('invalidData', () => {
  it('gives kind invalid_data and passes InvalidDataFailureSchema', () => {
    const failure = invalidData([issue(0)]);
    expect(failure.kind).toBe('invalid_data');
    expect(InvalidDataFailureSchema.safeParse(failure).success).toBe(true);
    expect(failure).toStrictEqual({
      kind: 'invalid_data',
      message: describeStoreIssues('Invalid data', [issue(0)]),
      issues: [issue(0)],
    });
  });

  it('keeps the first 20 of 25 issues', () => {
    const issues = Array.from({ length: 25 }, (_, i) => issue(i));
    const failure = InvalidDataFailureSchema.parse(invalidData(issues));
    expect(failure.issues).toStrictEqual(issues.slice(0, 20));
  });

  it('an empty list still gives one issue', () => {
    const failure = InvalidDataFailureSchema.parse(invalidData([]));
    expect(failure.issues).toHaveLength(1);
    expect(failure.message.startsWith('Invalid data')).toBe(true);
  });

  it('the message starts with "Invalid data" and names the first issue path', () => {
    const failure = InvalidDataFailureSchema.parse(
      invalidData([{ path: ['details', 'comments', 1, 'author'], message: 'Required' }]),
    );
    expect(failure.message.startsWith('Invalid data')).toBe(true);
    expect(failure.message).toContain('details.comments[1].author');
    expect(failure.message).not.toContain('(+');
  });

  it('a path of [] renders as (whole input)', () => {
    const failure = InvalidDataFailureSchema.parse(invalidData([{ path: [], message: 'bad' }]));
    expect(failure.message).toContain('(whole input)');
    expect(failure.message).not.toContain('(whole answer)');
  });

  it('more than one issue adds " (+N more)"', () => {
    const failure = InvalidDataFailureSchema.parse(invalidData([issue(0), issue(1), issue(2)]));
    expect(failure.message.endsWith(' (+2 more)')).toBe(true);
  });

  it('keeps commentNum and placeId and adds no optional key that was not given', () => {
    const enriched: StoreIssue = {
      path: ['details', 'comments', 0, 'placeId'],
      message: 'foreign comment',
      commentNum: 1,
      placeId: 55,
    };
    const onlyNum: StoreIssue = {
      path: ['details', 'comments', 1, 'num'],
      message: 'duplicate',
      commentNum: 2,
    };
    const plain = issue(3);
    const failure = InvalidDataFailureSchema.parse(invalidData([enriched, onlyNum, plain]));
    expect(failure.issues).toStrictEqual([enriched, onlyNum, plain]);
    const [, second, third] = failure.issues;
    if (second === undefined || third === undefined) throw new Error('issues missing');
    expect(Object.hasOwn(second, 'placeId')).toBe(false);
    expect(Object.hasOwn(third, 'commentNum')).toBe(false);
    expect(Object.hasOwn(third, 'placeId')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. describeStoreIssues
// ---------------------------------------------------------------------------

describe('describeStoreIssues', () => {
  it('one issue with a nested path', () => {
    expect(
      describeStoreIssues('Invalid data', [
        { path: ['details', 'comments', 0, 'replies', 0, 'placeId'], message: 'foreign comment' },
      ]),
    ).toBe('Invalid data: details.comments[0].replies[0].placeId: foreign comment');
  });

  it('several issues name the first and count the rest', () => {
    expect(describeStoreIssues('Invalid data', [issue(1), issue(2), issue(3)])).toBe(
      'Invalid data: places[1].placeId: issue 1 (+2 more)',
    );
  });

  it('an empty path renders as (whole input)', () => {
    expect(describeStoreIssues('Invalid data', [{ path: [], message: 'expected object' }])).toBe(
      'Invalid data: (whole input): expected object',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. storeUnavailable
// ---------------------------------------------------------------------------

describe('storeUnavailable', () => {
  it('gives kind store_unavailable and passes StoreUnavailableFailureSchema', () => {
    const failure = storeUnavailable('Place Store is not configured');
    expect(failure).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store is not configured',
    });
    expect(StoreUnavailableFailureSchema.safeParse(failure).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. safeErrorCode
// ---------------------------------------------------------------------------

describe('safeErrorCode', () => {
  it('returns a Node errno code from error.code', () => {
    expect(safeErrorCode(withCode('ECONNREFUSED'))).toBe('ECONNREFUSED');
  });

  it.each(['3D000', '28P01'])('returns the SQLSTATE %s', (code) => {
    expect(safeErrorCode(withCode(code))).toBe(code);
  });

  it('reads error.cause.code when error.code is absent', () => {
    const error = new Error('outer', { cause: withCode('3D000', 'inner') });
    expect(safeErrorCode(error)).toBe('3D000');
    const errno = new Error('outer', { cause: withCode('ECONNREFUSED', 'inner') });
    expect(safeErrorCode(errno)).toBe('ECONNREFUSED');
  });

  it.each([
    ['a lowercase code', withCode('econnrefused')],
    ['a code with spaces', withCode('E CONN REFUSED')],
    ['a URL as code', withCode(`postgres://wm_contract:${UNREACHABLE_PASSWORD}@127.0.0.1:1/x`)],
    ['a numeric code', withCode(42)],
    ['an object code', withCode({ code: 'ECONNREFUSED' })],
    ['a string value', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an error without a code', new Error('no code here')],
  ])('returns undefined for %s', (_name, value) => {
    expect(safeErrorCode(value)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. unavailableFrom
// ---------------------------------------------------------------------------

describe('unavailableFrom', () => {
  it('uses the fixed template with the safe code', () => {
    const failure = unavailableFrom(withCode('ECONNREFUSED'), 'readPlace');
    expect(failure).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store unavailable: readPlace failed (ECONNREFUSED)',
    });
    expect(StoreUnavailableFailureSchema.safeParse(failure).success).toBe(true);
  });

  it('uses a code found on error.cause', () => {
    const error = new Error('outer', { cause: withCode('28P01', 'inner') });
    expect(unavailableFrom(error, 'apply')).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store unavailable: apply failed (28P01)',
    });
  });

  it('has no parentheses without a usable code', () => {
    const failure = unavailableFrom(withCode('not a code'), 'countStored');
    expect(failure).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store unavailable: countStored failed',
    });
    expect(failure.message).not.toContain('(');
  });

  it('never copies message, detail, where, cause.message, SQL text or bindings', () => {
    const url = `postgres://wm_contract:${UNREACHABLE_PASSWORD}@127.0.0.1:1/wm_unreachable_test`;
    const sql = 'select "place_id" from "places" where "place_id" = $1';
    const binding = 'binding-value-4e1d7b';
    const cause = Object.assign(new Error(`cause: could not connect to ${url}`), {
      detail: `cause detail ${binding}`,
    });
    const error = Object.assign(
      new Error(`${sql} - connect failed for ${url} [${binding}]`, { cause }),
      {
        code: '28P01',
        detail: `Key (place_id)=(${binding}) at ${url}`,
        where: `SQL statement "${sql}"`,
        sql,
        bindings: [binding],
      },
    );
    const failure = unavailableFrom(error, 'saveListingPage');
    expect(failure).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store unavailable: saveListingPage failed (28P01)',
    });
    const text = JSON.stringify(failure);
    expect(text).not.toContain(UNREACHABLE_PASSWORD);
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain(sql);
    expect(text).not.toContain('select');
    expect(text).not.toContain(binding);
  });

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a plain object', { message: 'not an error' }],
    ['an object without prototype', Object.create(null) as unknown],
  ])('never throws for %s and gives the plain template', (_name, value) => {
    let failure: StoreFailure | undefined;
    expect(() => {
      failure = unavailableFrom(value, 'readPlace');
    }).not.toThrow();
    expect(failure).toStrictEqual({
      kind: 'store_unavailable',
      message: 'Place Store unavailable: readPlace failed',
    });
  });
});
