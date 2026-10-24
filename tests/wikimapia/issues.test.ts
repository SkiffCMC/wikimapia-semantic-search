/**
 * AL2 unit tests: `src/wikimapia/issues.ts` (AL4 1.4.5). The mapping edge cases the AL5 contract
 * tests never produce (symbol paths, empty messages, no issues, more than 20 issues) and the
 * message format, using hand-built Zod issues.
 */
import type { z } from 'zod';
import { describeIssues, toFailureIssues } from '../../src/wikimapia/issues';

function issue(path: PropertyKey[], message: string): z.core.$ZodIssue {
  return { code: 'custom', path, message, input: 'value that must not be copied' };
}

describe('toFailureIssues', () => {
  it.each([
    [
      'a described symbol',
      [issue(['a', Symbol('described'), 0], 'bad')],
      [{ path: ['a', 'described', 0], message: 'bad' }],
    ],
    [
      'a symbol without description',
      [issue([Symbol()], 'bad')],
      [{ path: ['symbol'], message: 'bad' }],
    ],
    ['an empty message', [issue(['title'], '')], [{ path: ['title'], message: 'invalid value' }]],
    ['no issues at all', [], [{ path: [], message: 'invalid value' }]],
  ])('%s', (_, input, expected) => {
    expect(toFailureIssues(input)).toStrictEqual(expected);
  });

  it('keeps only the first 20 issues, in order', () => {
    const issues = toFailureIssues(
      Array.from({ length: 25 }, (_, i) => issue([i], `m${String(i)}`)),
    );
    expect(issues).toHaveLength(20);
    expect(issues.at(-1)).toStrictEqual({ path: [19], message: 'm19' });
  });
});

it.each([
  [[], 'P'],
  [[{ path: [], message: 'not JSON' }], 'P: (whole answer): not JSON'],
  [
    [
      { path: ['comments', 0, 'replies', 1, 'name'], message: 'first' },
      { path: ['found'], message: 'second' },
    ],
    'P: comments[0].replies[1].name: first (+1 more)',
  ],
])('describeIssues(%j) formats the first issue and counts the rest', (issues, expected) => {
  expect(describeIssues('P', issues)).toBe(expected);
});
