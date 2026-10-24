/**
 * AL2 unit tests: `src/wikimapia/interpret.ts`. Only the arms the AL5 contract tests do not
 * reach: the Key Quota answer (crawl-run1-fixes AL4 1.4.2) and a body that passes the raw schema
 * but fails a normaliser check. Data, rate-limit, error and not-JSON bodies are contract-tested.
 */
import { interpretBoxAnswer, interpretPlaceDetailsAnswer } from '../../src/wikimapia/interpret';
import { fixtureText, keyQuotaVariant, rawBox } from '../../contracts/wikimapia-client.support';

it.each([
  ['interpretBoxAnswer', interpretBoxAnswer],
  ['interpretPlaceDetailsAnswer', interpretPlaceDetailsAnswer],
])(
  '%s: a Key Quota answer gives key_quota with the message, even with the rate-limit wording',
  (_, interpret) => {
    expect(interpret(fixtureText('debug-key-quota.json'))).toStrictEqual({
      kind: 'key_quota',
      message: 'Key limit has been reached',
    });
    const wording = 'You need to wait for 7 seconds.';
    expect(interpret(keyQuotaVariant({ message: wording }).body)).toStrictEqual({
      kind: 'key_quota',
      message: wording,
    });
  },
);

it('a body the normaliser rejects gives unexpected with the normaliser issues', () => {
  const raw = rawBox('box-belgrade-page1.json');
  raw.count = 0;
  expect(interpretBoxAnswer(JSON.stringify(raw))).toStrictEqual({
    kind: 'unexpected',
    issues: [{ path: ['count'], message: 'count must be between 1 and 100' }],
  });
});
