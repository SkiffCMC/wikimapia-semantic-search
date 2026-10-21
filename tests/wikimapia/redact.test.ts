/**
 * AL2 unit tests: `src/wikimapia/redact.ts` (AL4 1.3 `redact.ts` block, 1.4.9 Secret
 * redaction, section 3 "Secrets"; U3; AC-32, AC-36).
 *
 * Pure and synchronous: each test hands a text or a failure object to the subject and
 * inspects the result. No transport, no clock, no network. The only keys used are the
 * synthetic `TEST_API_KEY` and made-up keys defined below.
 */
import { redactFailure, redactSecrets } from '../../src/wikimapia/redact';
import {
  ClientFailureSchema,
  type ClientFailure,
} from '../../contracts/wikimapia-client.schema';
import { TEST_API_KEY, at } from '../../contracts/wikimapia-client.support';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const K = TEST_API_KEY;
const ADDRESS_REMOVED = '[request address removed]';
const KEY_REMOVED = '[key removed]';
const KEYED_URL = `https://api.wikimapia.org/?function=place.getbyid&key=${K}&id=62587`;
const KEYED_HTTPS_URL = `https://api.wikimapia.org/?function=box&key=${K}&format=json`;
/** The same keyed URL over plain http: redaction is protocol-agnostic (AL4 1.4.9). */
const KEYED_HTTP_URL = `http://api.wikimapia.org/?function=box&key=${K}&format=json`;

/** The two AC-36 assertions, applied to any value through its JSON form. */
function expectNoSecret(value: unknown, apiKey: string = K): void {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (apiKey !== '') expect(json).not.toContain(apiKey);
  expect(json).not.toMatch(/[?&]key=/);
}

/** Every string inside a value, in a traversal order that ignores key order. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => strings(item));
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => strings((value as Record<string, unknown>)[key]));
  }
  return [];
}

/** The value with every string replaced by a placeholder: keys, numbers and lengths stay. */
function shape(value: unknown): unknown {
  if (typeof value === 'string') return '<text>';
  if (Array.isArray(value)) return value.map((item: unknown) => shape(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1. Key removal
// ---------------------------------------------------------------------------

describe('redactSecrets removes the key (AL4 1.4.9, AC-36)', () => {
  const INPUTS: readonly [string, string][] = [
    ['debug message with the key', `Key ${K} is not valid`],
    ['HTML body with a keyed URL', `<html>Bad request: ${KEYED_URL}</html>`],
    ['HTML body with a keyed http URL', `<html>Bad request: ${KEYED_HTTP_URL}</html>`],
    ['bare keyed http URL', KEYED_HTTP_URL],
    ['bare keyed https URL', KEYED_HTTPS_URL],
    ['?key= fragment outside a URL', `request ?key=${K}&id=62587 failed`],
    ['&key= fragment outside a URL', `request function=box&key=${K} failed`],
    ['uppercase &KEY= fragment', `request function=box&KEY=${K}&id=1 failed`],
    ['the key repeated several times', `${K} and ${K}, then ${K}${K}.`],
    ['connection error message', `connect ECONNREFUSED while requesting ${KEYED_URL}`],
  ];

  it.each(INPUTS)('%s', (_name, text) => {
    const result = redactSecrets(text, K);
    expectNoSecret(result);
    expect(result).not.toMatch(/[?&]key=/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Replacement markers
// ---------------------------------------------------------------------------

describe('redactSecrets replacement markers (AL4 1.4.9)', () => {
  it('a keyed https URL becomes the address marker and the text around it is kept', () => {
    expect(redactSecrets(`<html>Bad request: ${KEYED_URL}</html>`, K)).toBe(
      `<html>Bad request: ${ADDRESS_REMOVED}</html>`,
    );
  });

  it('a keyed http URL becomes the address marker and the text around it is kept', () => {
    expect(redactSecrets(`<html>Bad request: ${KEYED_HTTP_URL}</html>`, K)).toBe(
      `<html>Bad request: ${ADDRESS_REMOVED}</html>`,
    );
  });

  it('a bare keyed URL becomes the address marker', () => {
    expect(redactSecrets(KEYED_URL, K)).toBe(ADDRESS_REMOVED);
    expect(redactSecrets(KEYED_HTTPS_URL, K)).toBe(ADDRESS_REMOVED);
    expect(redactSecrets(KEYED_HTTP_URL, K)).toBe(ADDRESS_REMOVED);
  });

  it('a URL that carries the key without key= is also removed', () => {
    expect(redactSecrets(`see http://example.org/${K}/x now`, K)).toBe(
      `see ${ADDRESS_REMOVED} now`,
    );
  });

  it('a URL with key= but another key value is removed', () => {
    expect(redactSecrets('at https://api.wikimapia.org/?key=other&id=1 now', K)).toBe(
      `at ${ADDRESS_REMOVED} now`,
    );
  });

  it('a ?key= fragment becomes the key marker', () => {
    expect(redactSecrets(`request ?key=${K}&id=62587 failed`, K)).toBe(
      `request ${KEY_REMOVED}&id=62587 failed`,
    );
  });

  it('a &key= fragment becomes the key marker', () => {
    expect(redactSecrets(`request function=box&key=${K} failed`, K)).toBe(
      `request function=box${KEY_REMOVED} failed`,
    );
  });

  it('an uppercase &KEY= fragment becomes the key marker', () => {
    expect(redactSecrets(`request function=box&KEY=${K}&id=1 failed`, K)).toBe(
      `request function=box${KEY_REMOVED}&id=1 failed`,
    );
  });

  it('a key= fragment with another value is removed too', () => {
    expect(redactSecrets('bad ?key=other-value', K)).toBe(`bad ${KEY_REMOVED}`);
  });

  it('a bare key occurrence becomes the key marker', () => {
    expect(redactSecrets(`Key ${K} is not valid`, K)).toBe(`Key ${KEY_REMOVED} is not valid`);
  });

  it('every repeated occurrence of the key becomes the key marker', () => {
    expect(redactSecrets(`${K} and ${K}, then ${K}${K}.`, K)).toBe(
      `${KEY_REMOVED} and ${KEY_REMOVED}, then ${KEY_REMOVED}${KEY_REMOVED}.`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Unkeyed text unchanged
// ---------------------------------------------------------------------------

describe('redactSecrets leaves unkeyed text unchanged (AL4 1.4.9, AC-32)', () => {
  it.each([
    ['Wikimapia error text', 'Invalid API key.'],
    ['unkeyed http URL', 'see http://example.org/docs?page=2&format=json for details'],
    ['unkeyed https URL', 'https://wikimapia.org/62587/ru/University-Park'],
    ['the empty string', ''],
    [
      'the rate-limit text',
      'You have reached the limit for this action. You need to wait for 7 seconds.',
    ],
    ['a word containing "key" without "="', 'monkey keys keyboard'],
  ])('%s', (_name, text) => {
    expect(redactSecrets(text, K)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 4. RegExp metacharacters
// ---------------------------------------------------------------------------

describe('redactSecrets never compiles the key into a RegExp (AL4 1.4.9)', () => {
  const META_KEY = 'a.b*c+(d)?[e]$^|\\';

  it('removes a key full of RegExp metacharacters wherever it appears', () => {
    const text = `token ${META_KEY} end; again:${META_KEY}`;
    const result = redactSecrets(text, META_KEY);
    expect(result).toBe(`token ${KEY_REMOVED} end; again:${KEY_REMOVED}`);
    expect(result).not.toContain(META_KEY);
  });

  it('removes a URL that carries a metacharacter key', () => {
    const result = redactSecrets(`at http://example.org/x/${META_KEY} now`, META_KEY);
    expect(result).toBe(`at ${ADDRESS_REMOVED} now`);
    expect(result).not.toContain(META_KEY);
  });

  it('does not remove text that matches the key only as a regex', () => {
    expect(redactSecrets('aXbbbc', 'a.b*c')).toBe('aXbbbc');
    expect(redactSecrets('ac', 'a.b*c')).toBe('ac');
    expect(redactSecrets('d', '(d)?')).toBe('d');
  });

  it('a $ sequence in the key does not act as a replacement pattern', () => {
    const key = "$&$'$`$1";
    expect(redactSecrets(`x ${key} y`, key)).toBe(`x ${KEY_REMOVED} y`);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty key
// ---------------------------------------------------------------------------

describe('redactSecrets with an empty key (AL3 2.2 step 3 clarification)', () => {
  it('does not throw and inserts no markers between characters', () => {
    expect(() => redactSecrets('abc', '')).not.toThrow();
    expect(redactSecrets('abc', '')).toBe('abc');
    expect(redactSecrets('Invalid API key.', '')).toBe('Invalid API key.');
    expect(redactSecrets('', '')).toBe('');
  });

  it('still removes ?key= and &key= fragments', () => {
    expect(redactSecrets('x ?key=abc y', '')).toBe(`x ${KEY_REMOVED} y`);
    expect(redactSecrets('x&key=abc y', '')).toBe(`x${KEY_REMOVED} y`);
  });

  it('still removes a URL with key=', () => {
    expect(redactSecrets('at https://api.wikimapia.org/?function=box&key=&format=json', '')).toBe(
      `at ${ADDRESS_REMOVED}`,
    );
  });

  it('leaves an unkeyed URL unchanged', () => {
    const text = 'see http://example.org/docs?page=2 for details';
    expect(redactSecrets(text, '')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 6. redactFailure, all six kinds
// ---------------------------------------------------------------------------

const SECRET_FAILURES: readonly [string, ClientFailure][] = [
  [
    'configuration',
    {
      kind: 'configuration',
      message: `Wikimapia client is not configured: key ${K} at ${KEYED_URL}`,
    },
  ],
  [
    'invalid_request',
    {
      kind: 'invalid_request',
      message: `Invalid request: ${KEYED_URL}`,
      issues: [
        { path: ['bbox', K, 0, KEYED_URL], message: `bad value near ?key=${K}` },
        { path: [], message: `Key ${K} rejected` },
        { path: ['placeId', 3], message: 'expected a positive whole number' },
      ],
    },
  ],
  [
    'rate_limit_exhausted',
    {
      kind: 'rate_limit_exhausted',
      message: `Rate limit exhausted for ${KEYED_URL} (key ${K})`,
      attempts: 6,
      lastWaitSeconds: 7,
    },
  ],
  [
    'wikimapia_error',
    {
      kind: 'wikimapia_error',
      message: `Wikimapia error: Key ${K} is not valid`,
      wikimapiaMessage: `Key ${K} is not valid; see ${KEYED_HTTPS_URL}`,
    },
  ],
  [
    'connection with status',
    { kind: 'connection', message: `HTTP 502 from ${KEYED_URL}`, status: 502 },
  ],
  [
    'connection without status',
    { kind: 'connection', message: `connect ECONNREFUSED while requesting ${KEYED_URL}` },
  ],
  [
    'unexpected_response',
    {
      kind: 'unexpected_response',
      message: `Unexpected response: <html>Bad request: ${KEYED_URL}</html>`,
      issues: [
        { path: [], message: `<html>Bad request: ${KEYED_URL}</html>` },
        { path: ['comments', 0, 'replies', 1, K], message: `&key=${K}` },
      ],
    },
  ],
];

describe('redactFailure removes secrets from every kind (AL4 1.4.9, AC-36)', () => {
  it('the table covers all six failure kinds', () => {
    expect(new Set(SECRET_FAILURES.map(([, f]) => f.kind))).toStrictEqual(
      new Set([
        'configuration',
        'invalid_request',
        'rate_limit_exhausted',
        'wikimapia_error',
        'connection',
        'unexpected_response',
      ]),
    );
    for (const [, f] of SECRET_FAILURES) {
      expect(ClientFailureSchema.safeParse(f).success).toBe(true);
      expect(JSON.stringify(f)).toContain(K);
    }
  });

  it.each(SECRET_FAILURES)('%s: no key and no key= in the result', (_name, input) => {
    expectNoSecret(redactFailure(input, K));
  });

  it.each(SECRET_FAILURES)('%s: the result passes ClientFailureSchema', (_name, input) => {
    expect(ClientFailureSchema.safeParse(redactFailure(input, K)).success).toBe(true);
  });

  it.each(SECRET_FAILURES)(
    '%s: same keys, same kind, same numbers and path positions',
    (_name, input) => {
      const result = redactFailure(input, K);
      expect(result.kind).toBe(input.kind);
      expect(Object.keys(result).sort()).toStrictEqual(Object.keys(input).sort());
      expect(shape(result)).toStrictEqual(shape(input));
    },
  );

  it.each(SECRET_FAILURES)(
    '%s: every text field is the redactSecrets of the original',
    (_name, input) => {
      const result = redactFailure(input, K);
      expect(strings(result)).toStrictEqual(strings(input).map((s) => redactSecrets(s, K)));
    },
  );

  it.each(SECRET_FAILURES)('%s: the input is not mutated', (_name, input) => {
    const before = structuredClone(input);
    const result = redactFailure(input, K);
    expect(input).toStrictEqual(before);
    expect(result).not.toBe(input);
  });

  it('a connection failure without status still has no status key', () => {
    const input: ClientFailure = {
      kind: 'connection',
      message: `connect ECONNREFUSED while requesting ${KEYED_URL}`,
    };
    const result = redactFailure(input, K);
    expect('status' in result).toBe(false);
    expect(Object.keys(result).sort()).toStrictEqual(['kind', 'message']);
    expect(result).toStrictEqual({
      kind: 'connection',
      message: `connect ECONNREFUSED while requesting ${ADDRESS_REMOVED}`,
    });
  });

  it('a connection failure with status keeps the status number', () => {
    const result = redactFailure({ kind: 'connection', message: `HTTP 502 ${K}`, status: 502 }, K);
    expect(result).toStrictEqual({
      kind: 'connection',
      message: `HTTP 502 ${KEY_REMOVED}`,
      status: 502,
    });
  });

  it('rate_limit_exhausted keeps attempts and lastWaitSeconds', () => {
    const result = redactFailure(
      { kind: 'rate_limit_exhausted', message: `limit ${K}`, attempts: 6, lastWaitSeconds: 0.5 },
      K,
    );
    expect(result).toStrictEqual({
      kind: 'rate_limit_exhausted',
      message: `limit ${KEY_REMOVED}`,
      attempts: 6,
      lastWaitSeconds: 0.5,
    });
  });

  it('wikimapia_error: only the key is replaced inside wikimapiaMessage', () => {
    const result = redactFailure(
      {
        kind: 'wikimapia_error',
        message: 'Wikimapia error',
        wikimapiaMessage: `Key ${K} is not valid`,
      },
      K,
    );
    expect(result).toStrictEqual({
      kind: 'wikimapia_error',
      message: 'Wikimapia error',
      wikimapiaMessage: `Key ${KEY_REMOVED} is not valid`,
    });
  });

  it('issues: string path elements and messages are redacted, numbers kept', () => {
    const result = redactFailure(
      {
        kind: 'unexpected_response',
        message: 'Unexpected response',
        issues: [{ path: ['comments', 0, K, KEYED_URL], message: `near ${K}` }],
      },
      K,
    );
    if (result.kind !== 'unexpected_response') throw new Error('kind changed');
    const issue = at(result.issues, 0);
    expect(issue.path).toStrictEqual(['comments', 0, KEY_REMOVED, ADDRESS_REMOVED]);
    expect(issue.message).toBe(`near ${KEY_REMOVED}`);
  });
});

// ---------------------------------------------------------------------------
// 7. Verbatim pass-through
// ---------------------------------------------------------------------------

const CLEAN_FAILURES: readonly [string, ClientFailure][] = [
  [
    'configuration',
    {
      kind: 'configuration',
      message: 'Wikimapia client is not configured: apiKey: API key is required',
    },
  ],
  [
    'invalid_request',
    {
      kind: 'invalid_request',
      message: 'Invalid request: bbox.east: west must be less than east',
      issues: [{ path: ['bbox', 'east'], message: 'west must be less than east' }],
    },
  ],
  [
    'rate_limit_exhausted',
    {
      kind: 'rate_limit_exhausted',
      message: 'Rate limit exhausted',
      attempts: 6,
      lastWaitSeconds: 60,
    },
  ],
  [
    'wikimapia_error',
    {
      kind: 'wikimapia_error',
      message: 'Wikimapia error: Invalid API key.',
      wikimapiaMessage: 'Invalid API key.',
    },
  ],
  [
    'connection with status',
    { kind: 'connection', message: 'Wikimapia answered HTTP 503', status: 503 },
  ],
  ['connection without status', { kind: 'connection', message: 'Wikimapia cannot be reached' }],
  [
    'unexpected_response',
    {
      kind: 'unexpected_response',
      message: 'Unexpected response: comments[0].user_ip: expected number',
      issues: [
        { path: ['comments', 0, 'user_ip'], message: 'expected number' },
        { path: [], message: 'Wikimapia answer is not valid JSON' },
      ],
    },
  ],
];

describe('redactFailure passes clean failures through verbatim (AC-32)', () => {
  it('wikimapia_error with "Invalid API key." comes back deep-equal', () => {
    const input: ClientFailure = {
      kind: 'wikimapia_error',
      message: 'Wikimapia error',
      wikimapiaMessage: 'Invalid API key.',
    };
    expect(redactFailure(input, K)).toStrictEqual(input);
  });

  it.each(CLEAN_FAILURES)('%s without secrets comes back deep-equal', (_name, input) => {
    const before = structuredClone(input);
    expect(redactFailure(input, K)).toStrictEqual(before);
    expect(input).toStrictEqual(before);
  });

  it('an empty wikimapiaMessage stays empty', () => {
    const input: ClientFailure = {
      kind: 'wikimapia_error',
      message: 'Wikimapia error',
      wikimapiaMessage: '',
    };
    const result = redactFailure(input, K);
    expect(result).toStrictEqual(input);
    expect(ClientFailureSchema.safeParse(result).success).toBe(true);
  });
});
