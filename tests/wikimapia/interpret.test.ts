/**
 * AL2 unit tests: `src/wikimapia/interpret.ts` (AL4 1.3 `interpret.ts` block, 1.4.4 Answer
 * interpretation, 1.4.5 expected raw paths, 1.4.9 IP-safety bullet; U2).
 *
 * Pure and synchronous: each test hands a body string to an interpreter and inspects the
 * returned `Interpretation`. No transport, no clock, no network, no real keys. Bodies are the
 * recorded fixtures (through the contract support helpers) and mutated copies of them.
 */
import { z } from 'zod';
import {
  interpretAnswer,
  interpretBoxAnswer,
  interpretPlaceDetailsAnswer,
  type Interpretation,
} from '../../src/wikimapia/interpret.js';
import {
  normalizeListingPage,
  normalizePlaceDetails,
  type Normalized,
} from '../../src/wikimapia/normalize.js';
import {
  FailureIssueSchema,
  ListingPageSchema,
  PlaceDetailsSchema,
  type FailureIssue,
} from '../../contracts/wikimapia-client.schema.js';
import {
  SYNTHETIC_IPS,
  TEST_API_KEY,
  addCommenterIps,
  at,
  fixtureText,
  rateLimitAnswer,
  rawBox,
  rawDetails,
  type FixtureName,
} from '../../contracts/wikimapia-client.support.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Interpreter = (body: string) => Interpretation<unknown>;

const BOTH: readonly [string, Interpreter][] = [
  ['interpretBoxAnswer', interpretBoxAnswer],
  ['interpretPlaceDetailsAnswer', interpretPlaceDetailsAnswer],
];

const NOT_JSON = {
  kind: 'unexpected',
  issues: [{ path: [], message: 'Wikimapia answer is not valid JSON' }],
} as const;

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

function dataValue<T>(result: Interpretation<T>): T {
  if (result.kind !== 'data') throw new Error(`expected data, got ${JSON.stringify(result)}`);
  expect(keys(result)).toStrictEqual(['kind', 'value']);
  return result.value;
}

/**
 * Asserts an `unexpected` result with only `kind` and `issues` (no partial value), between 1
 * and 20 issues, each a valid contract `FailureIssue`. Returns the issues.
 */
function unexpectedIssues<T>(result: Interpretation<T>): FailureIssue[] {
  expect(result.kind).toBe('unexpected');
  expect(keys(result)).toStrictEqual(['issues', 'kind']);
  if (result.kind !== 'unexpected') throw new Error('expected an unexpected interpretation');
  expect(result.issues.length).toBeGreaterThanOrEqual(1);
  expect(result.issues.length).toBeLessThanOrEqual(20);
  for (const issue of result.issues) {
    expect(FailureIssueSchema.safeParse(issue).success).toBe(true);
  }
  return result.issues;
}

function hasIssueAt(issues: readonly FailureIssue[], path: readonly (string | number)[]): boolean {
  return issues.some(
    (issue) =>
      issue.path.length === path.length && issue.path.every((element, i) => element === path[i]),
  );
}

function expectNoIps(result: unknown, extra: readonly number[] = []): void {
  const json = JSON.stringify(result);
  for (const ip of [...SYNTHETIC_IPS, ...extra]) expect(json).not.toContain(String(ip));
}

function nested() {
  return rawDetails('getbyid-62587-nested-replies.json');
}

const BOX_FIXTURES: readonly FixtureName[] = [
  'box-belgrade-page1.json',
  'box-belgrade-empty-page.json',
];

const DETAILS_FIXTURES: readonly FixtureName[] = [
  'getbyid-62587.json',
  'getbyid-1381893.json',
  'getbyid-55.json',
  'getbyid-62587-nested-replies.json',
];

// ---------------------------------------------------------------------------
// 1. Data
// ---------------------------------------------------------------------------

describe('data answers (AL4 1.4.4, AC-16)', () => {
  it.each(BOX_FIXTURES)('%s through interpretBoxAnswer gives the U1 listing page', (name) => {
    const value = dataValue(interpretBoxAnswer(fixtureText(name)));
    const expected = normalizeListingPage(rawBox(name));
    if (!expected.ok) throw new Error('U1 normaliser rejected a fixture');
    expect(value).toStrictEqual(expected.value);
    expect(ListingPageSchema.safeParse(value).success).toBe(true);
  });

  it.each(DETAILS_FIXTURES)(
    '%s through interpretPlaceDetailsAnswer gives the U1 place details',
    (name) => {
      const value = dataValue(interpretPlaceDetailsAnswer(fixtureText(name)));
      const expected = normalizePlaceDetails(rawDetails(name));
      if (!expected.ok) throw new Error('U1 normaliser rejected a fixture');
      expect(value).toStrictEqual(expected.value);
      expect(PlaceDetailsSchema.safeParse(value).success).toBe(true);
    },
  );

  it('the empty box page gives data with an empty places list', () => {
    const value = dataValue(interpretBoxAnswer(fixtureText('box-belgrade-empty-page.json')));
    expect(value.places).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Rate limit
// ---------------------------------------------------------------------------

describe('rate-limit answers (AL4 1.4.4, AC-24)', () => {
  it.each(BOTH)('%s: debug-rate-limit.json gives rate_limit with 7 seconds', (_, interpret) => {
    expect(interpret(fixtureText('debug-rate-limit.json'))).toStrictEqual({
      kind: 'rate_limit',
      waitSeconds: 7,
    });
  });

  it.each(BOTH)(
    '%s: an unreadable wait time gives rate_limit with waitSeconds undefined (key present)',
    (_, interpret) => {
      const result = interpret(rateLimitAnswer('a few').body);
      expect(result.kind).toBe('rate_limit');
      expect(keys(result)).toStrictEqual(['kind', 'waitSeconds']);
      if (result.kind !== 'rate_limit') throw new Error('expected rate_limit');
      expect(result.waitSeconds).toBeUndefined();
    },
  );

  it.each(BOTH)('%s: a wait of 0 seconds gives waitSeconds 0', (_, interpret) => {
    expect(interpret(rateLimitAnswer(0).body)).toStrictEqual({
      kind: 'rate_limit',
      waitSeconds: 0,
    });
  });

  it.each(BOTH)('%s: a wait of 86400 seconds is not capped', (_, interpret) => {
    expect(interpret(rateLimitAnswer(86400).body)).toStrictEqual({
      kind: 'rate_limit',
      waitSeconds: 86400,
    });
  });

  it.each(BOTH)('%s: a rate-limit body is never data and never unexpected', (_, interpret) => {
    for (const body of [
      fixtureText('debug-rate-limit.json'),
      rateLimitAnswer('a few').body,
      rateLimitAnswer(3).body,
    ]) {
      const kind = interpret(body).kind;
      expect(kind).not.toBe('data');
      expect(kind).not.toBe('unexpected');
      expect(kind).toBe('rate_limit');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Wikimapia error
// ---------------------------------------------------------------------------

describe('Wikimapia error answers (AL4 1.4.4, AC-32)', () => {
  it.each(BOTH)('%s: debug-error.json gives wikimapia_error verbatim', (_, interpret) => {
    expect(interpret(fixtureText('debug-error.json'))).toStrictEqual({
      kind: 'wikimapia_error',
      message: 'Invalid API key.',
    });
  });

  it.each(BOTH)(
    '%s: a debug message containing the key is returned verbatim (redaction is not U2)',
    (_, interpret) => {
      const message = `Key ${TEST_API_KEY} is not valid`;
      expect(interpret(JSON.stringify({ debug: { message } }))).toStrictEqual({
        kind: 'wikimapia_error',
        message,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Debug envelope wins over data next to it
// ---------------------------------------------------------------------------

describe('debug envelope wins (AL4 1.4.4, AC-37 case 3)', () => {
  it.each(BOTH)(
    '%s: debug plus comments with IPs gives wikimapia_error and no IP',
    (_, interpret) => {
      const withIps = addCommenterIps(nested());
      const body = JSON.stringify({
        debug: { message: 'Invalid API key.' },
        comments: withIps.comments,
      });
      const result = interpret(body);
      expect(result).toStrictEqual({ kind: 'wikimapia_error', message: 'Invalid API key.' });
      expectNoIps(result);
    },
  );

  it('debug next to a complete, valid details object gives wikimapia_error, not data', () => {
    const body = JSON.stringify({
      ...rawDetails('getbyid-62587.json'),
      debug: { message: 'Invalid API key.' },
    });
    expect(interpretPlaceDetailsAnswer(body)).toStrictEqual({
      kind: 'wikimapia_error',
      message: 'Invalid API key.',
    });
  });

  it('debug next to a complete, valid box page gives wikimapia_error, not data', () => {
    const body = JSON.stringify({
      ...rawBox('box-belgrade-page1.json'),
      debug: { message: 'Invalid API key.' },
    });
    expect(interpretBoxAnswer(body)).toStrictEqual({
      kind: 'wikimapia_error',
      message: 'Invalid API key.',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed debug
// ---------------------------------------------------------------------------

describe('malformed debug envelope falls through to the data schema (AL4 1.4.4)', () => {
  it.each(BOTH)('%s: { debug: "x" } gives unexpected', (_, interpret) => {
    unexpectedIssues(interpret(JSON.stringify({ debug: 'x' })));
  });

  it.each(BOTH)('%s: { debug: {} } gives unexpected', (_, interpret) => {
    unexpectedIssues(interpret(JSON.stringify({ debug: {} })));
  });
});

// ---------------------------------------------------------------------------
// 6. Unreadable bodies
// ---------------------------------------------------------------------------

describe('unreadable bodies (AL4 1.4.4, AC-34, AC-36)', () => {
  const KEYED_URL = `http://api.wikimapia.org/?function=place.getbyid&key=${TEST_API_KEY}&id=62587`;
  const TRUNCATED = fixtureText('getbyid-62587.json').slice(0, 200);

  const BODIES: readonly [string, string, readonly string[]][] = [
    [
      'HTML page',
      '<html><body>Service temporarily unavailable</body></html>',
      ['html', 'Service', 'temporarily', 'unavailable', 'body'],
    ],
    ['empty body', '', []],
    ['truncated JSON', TRUNCATED, ['object_type', 'language_iso', 'urlhtml', '62587']],
    [
      'HTML with a keyed URL',
      `<html>Bad request: ${KEYED_URL}</html>`,
      ['html', 'Bad request', 'api.wikimapia.org', 'function=', 'place.getbyid'],
    ],
  ];

  describe.each(BOTH)('%s', (_, interpret) => {
    it.each(BODIES)('%s gives exactly the fixed not-JSON issue', (_label, body) => {
      expect(interpret(body)).toStrictEqual(NOT_JSON);
    });

    it.each(BODIES)(
      '%s: the result carries no body text, key or key=',
      (_label, body, fragments) => {
        const json = JSON.stringify(interpret(body));
        expect(json).not.toContain(TEST_API_KEY);
        expect(json).not.toContain('key=');
        for (const fragment of fragments) expect(json).not.toContain(fragment);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Wrong top-level shape
// ---------------------------------------------------------------------------

describe('wrong top-level shape (AL4 1.4.4, AC-35)', () => {
  describe.each(BOTH)('%s', (_, interpret) => {
    it('[] gives unexpected with an issue at path []', () => {
      expect(hasIssueAt(unexpectedIssues(interpret('[]')), [])).toBe(true);
    });

    it.each([['null'], ['"just text"'], ['42']])('%s gives unexpected', (body) => {
      unexpectedIssues(interpret(body));
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Exact raw paths
// ---------------------------------------------------------------------------

describe('exact raw issue paths (AL4 1.4.5, AC-35, AC-46)', () => {
  it('details without title names ["title"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(raw, 'title');
    const issues = unexpectedIssues(interpretPlaceDetailsAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['title'])).toBe(true);
  });

  it('comments[1] without name names ["comments", 1, "name"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(at(raw.comments, 1), 'name');
    const issues = unexpectedIssues(interpretPlaceDetailsAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['comments', 1, 'name'])).toBe(true);
  });

  it.each([['abc'], [1.5], [-3]])('details id %s names ["id"]', (id) => {
    const raw = rawDetails('getbyid-62587.json');
    Object.assign(raw, { id });
    const issues = unexpectedIssues(interpretPlaceDetailsAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['id'])).toBe(true);
  });

  it('box folder[0].id = "abc" names ["folder", 0, "id"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 0).id = 'abc';
    const issues = unexpectedIssues(interpretBoxAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['folder', 0, 'id'])).toBe(true);
  });

  it('box without found names ["found"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    Reflect.deleteProperty(raw, 'found');
    const issues = unexpectedIssues(interpretBoxAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['found'])).toBe(true);
  });

  it('a reply vote count of 1.5 names ["comments", 0, "replies", 0, "good"]', () => {
    const raw = nested();
    at(at(raw.comments, 0).replies, 0).good = 1.5;
    const issues = unexpectedIssues(interpretPlaceDetailsAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['comments', 0, 'replies', 0, 'good'])).toBe(true);
  });

  it('a reply to a reply without name names the full nested path', () => {
    const raw = nested();
    Reflect.deleteProperty(at(at(at(raw.comments, 0).replies, 0).replies, 0), 'name');
    const issues = unexpectedIssues(interpretPlaceDetailsAnswer(JSON.stringify(raw)));
    expect(hasIssueAt(issues, ['comments', 0, 'replies', 0, 'replies', 0, 'name'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Semantic-check passthrough
// ---------------------------------------------------------------------------

describe('U1 semantic checks pass through as unexpected (AL4 1.4.4, 1.4.6)', () => {
  it('a folder url pointing at another place names ["folder", 0, "url"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 0).url = 'http://wikimapia.org/55/Eiffel-Tower';
    const result = interpretBoxAnswer(JSON.stringify(raw));
    expect(result.kind).not.toBe('data');
    expect(hasIssueAt(unexpectedIssues(result), ['folder', 0, 'url'])).toBe(true);
  });

  it('count 0 names ["count"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    raw.count = 0;
    const result = interpretBoxAnswer(JSON.stringify(raw));
    expect(result.kind).not.toBe('data');
    expect(hasIssueAt(unexpectedIssues(result), ['count'])).toBe(true);
  });

  it('a details id above the safe integer range names ["id"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    Object.assign(raw, { id: '9007199254740993' });
    const result = interpretPlaceDetailsAnswer(JSON.stringify(raw));
    expect(result.kind).not.toBe('data');
    expect(hasIssueAt(unexpectedIssues(result), ['id'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. No IPs in failures
// ---------------------------------------------------------------------------

describe('no Commenter IPs in unexpected results (AL4 1.4.9, AC-37 cases 1 and 2)', () => {
  it('a reply to a reply without name, with IPs at every level, carries no IP', () => {
    const raw = addCommenterIps(nested());
    Reflect.deleteProperty(at(at(at(raw.comments, 0).replies, 0).replies, 0), 'name');
    const result = interpretPlaceDetailsAnswer(JSON.stringify(raw));
    unexpectedIssues(result);
    expectNoIps(result);
  });

  it('a wrongly typed Commenter IP is not echoed', () => {
    const raw = addCommenterIps(rawDetails('getbyid-62587.json'));
    Object.assign(at(raw.comments, 0), { user_ip: '1555555555', good: 'many' });
    const result = interpretPlaceDetailsAnswer(JSON.stringify(raw));
    unexpectedIssues(result);
    expectNoIps(result, [1555555555]);
  });
});

// ---------------------------------------------------------------------------
// 11. Issue shape (cap)
// ---------------------------------------------------------------------------

describe('unexpected issue shape (AL4 1.4.4, 1.4.5)', () => {
  it('many wrong comments still give between 1 and 20 valid issues and no partial value', () => {
    const raw = rawDetails('getbyid-62587.json');
    const template = at(raw.comments, 0);
    const broken = Array.from({ length: 30 }, () => ({ ...template, good: 'many' }));
    Object.assign(raw, { comments: broken });
    const result = interpretPlaceDetailsAnswer(JSON.stringify(raw));
    const issues = unexpectedIssues(result);
    expect(issues).toHaveLength(20);
    expect(result).not.toHaveProperty('value');
  });
});

// ---------------------------------------------------------------------------
// 12. Generic interpretAnswer
// ---------------------------------------------------------------------------

describe('interpretAnswer with a synthetic schema and stub normaliser (AL4 1.3, 1.4.4)', () => {
  const SyntheticSchema = z.looseObject({ n: z.number().int() });
  type Synthetic = z.output<typeof SyntheticSchema>;
  const STUB_ISSUES: FailureIssue[] = [{ path: ['n'], message: 'n is too small' }];

  function okStub() {
    return vi.fn((raw: Synthetic): Normalized<{ doubled: number }> => ({
      ok: true,
      value: { doubled: raw.n * 2 },
    }));
  }

  function failStub() {
    return vi.fn((): Normalized<{ doubled: number }> => ({ ok: false, issues: STUB_ISSUES }));
  }

  it('maps { ok: true, value } to data with that value, passing the parsed raw object', () => {
    const stub = okStub();
    const result = interpretAnswer(JSON.stringify({ n: 21, extra: 'kept' }), SyntheticSchema, stub);
    expect(result).toStrictEqual({ kind: 'data', value: { doubled: 42 } });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]?.[0]).toMatchObject({ n: 21 });
  });

  it('maps { ok: false, issues } to unexpected with exactly those issues', () => {
    const stub = failStub();
    const result = interpretAnswer(JSON.stringify({ n: 1 }), SyntheticSchema, stub);
    expect(result).toStrictEqual({ kind: 'unexpected', issues: STUB_ISSUES });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('does not call the normaliser when the debug envelope decides (rate limit)', () => {
    const stub = okStub();
    const result = interpretAnswer(fixtureText('debug-rate-limit.json'), SyntheticSchema, stub);
    expect(result).toStrictEqual({ kind: 'rate_limit', waitSeconds: 7 });
    expect(stub).not.toHaveBeenCalled();
  });

  it('does not call the normaliser when the debug envelope decides (error), even next to data', () => {
    const stub = okStub();
    const body = JSON.stringify({ n: 3, debug: { message: 'Invalid API key.' } });
    const result = interpretAnswer(body, SyntheticSchema, stub);
    expect(result).toStrictEqual({ kind: 'wikimapia_error', message: 'Invalid API key.' });
    expect(stub).not.toHaveBeenCalled();
  });

  it('does not call the normaliser when the raw schema rejects the body', () => {
    const stub = okStub();
    const result = interpretAnswer(JSON.stringify({ n: 'three' }), SyntheticSchema, stub);
    expect(hasIssueAt(unexpectedIssues(result), ['n'])).toBe(true);
    expect(stub).not.toHaveBeenCalled();
  });

  it('does not call the normaliser when the body is not JSON', () => {
    const stub = okStub();
    expect(interpretAnswer('{"n":', SyntheticSchema, stub)).toStrictEqual(NOT_JSON);
    expect(stub).not.toHaveBeenCalled();
  });
});
