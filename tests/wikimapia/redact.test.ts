/**
 * AL2 unit tests: `src/wikimapia/redact.ts` (AL4 1.4.9). One table over `redactSecrets`: the
 * address rule arms and the key-handling edge cases the AL5 contract tests never produce (keys
 * with RegExp metacharacters, an empty key). `redactFailure` per kind is covered by the contracts.
 */
import { redactSecrets } from '../../src/wikimapia/redact';
import { TEST_API_KEY as K } from '../../contracts/wikimapia-client.support';

const ADDRESS = '[request address removed]';
const KEY = '[key removed]';
const META = "a.b*c+(d)?[e]$&$'|\\";

it.each([
  [
    'a URL with key=',
    `at http://api.wikimapia.org/?function=box&key=${K}&id=1 now`,
    K,
    `at ${ADDRESS} now`,
  ],
  [
    'a URL carrying the key without key=',
    `see https://example.org/${K}/x now`,
    K,
    `see ${ADDRESS} now`,
  ],
  [
    'an unkeyed URL',
    'see https://wikimapia.org/62587/ru/x?page=2',
    K,
    'see https://wikimapia.org/62587/ru/x?page=2',
  ],
  [
    'an unkeyed URL, empty key',
    'see https://wikimapia.org/62587/',
    '',
    'see https://wikimapia.org/62587/',
  ],
  [
    'a KEY= fragment outside a URL',
    `request function=box&KEY=${K}&id=1`,
    K,
    `request function=box${KEY}&id=1`,
  ],
  ['repeated bare keys', `${K} and ${K}${K}.`, K, `${KEY} and ${KEY}${KEY}.`],
  ['a key of RegExp metacharacters', `x ${META} y; aXbbbc`, META, `x ${KEY} y; aXbbbc`],
  ['an empty key: no markers inserted', 'Invalid API key.', '', 'Invalid API key.'],
])('%s', (_, text, apiKey, expected) => {
  expect(redactSecrets(text, apiKey)).toBe(expected);
});
