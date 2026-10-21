/**
 * AL2 unit tests: `src/wikimapia/issues.ts` (AL4 1.3 `issues.ts` block, 1.4.5 Issue mapping).
 *
 * Pure and synchronous. Real Zod issues come from the contract raw schemas applied to mutated
 * copies of the recorded fixtures; symbol / empty-message / cap cases use hand-built issues.
 */
import type { z } from 'zod';
import {
  MAX_REPORTED_ISSUES,
  describeIssues,
  formatIssuePath,
  toFailureIssues,
} from '../../src/wikimapia/issues';
import {
  FailureIssueSchema,
  RawBoxResponseSchema,
  RawPlaceDetailsSchema,
  type FailureIssue,
} from '../../contracts/wikimapia-client.schema';
import {
  SYNTHETIC_IPS,
  addCommenterIps,
  at,
  rawBox,
  rawDetails,
} from '../../contracts/wikimapia-client.support';

type ZodIssue = z.core.$ZodIssue;

/** Zod issues of a raw-schema `safeParse` that is expected to fail. */
function detailsIssues(value: unknown): ZodIssue[] {
  const result = RawPlaceDetailsSchema.safeParse(value);
  if (result.success) throw new Error('expected the raw details schema to fail');
  return result.error.issues;
}

function boxIssues(value: unknown): ZodIssue[] {
  const result = RawBoxResponseSchema.safeParse(value);
  if (result.success) throw new Error('expected the raw box schema to fail');
  return result.error.issues;
}

function paths(issues: readonly FailureIssue[]): string[] {
  return issues.map((issue) => JSON.stringify(issue.path));
}

function expectValidIssues(issues: readonly FailureIssue[]): void {
  expect(issues.length).toBeGreaterThanOrEqual(1);
  for (const issue of issues) {
    expect(FailureIssueSchema.safeParse(issue).success).toBe(true);
    expect(Object.keys(issue).sort()).toStrictEqual(['message', 'path']);
  }
}

function customIssue(path: PropertyKey[], message: string, input?: unknown): ZodIssue {
  const issue: z.core.$ZodIssueCustom =
    input === undefined
      ? { code: 'custom', path, message }
      : { code: 'custom', path, message, input };
  return issue;
}

function nested() {
  return rawDetails('getbyid-62587-nested-replies.json');
}

describe('MAX_REPORTED_ISSUES', () => {
  it('is 20', () => {
    expect(MAX_REPORTED_ISSUES).toBe(20);
  });
});

describe('toFailureIssues with real Zod issues (AL4 1.4.5 expected paths)', () => {
  it('details without a title gives path ["title"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(raw, 'title');
    const issues = toFailureIssues(detailsIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['title']));
  });

  it('second comment without a name gives path ["comments",1,"name"]', () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(at(raw.comments, 1), 'name');
    const issues = toFailureIssues(detailsIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['comments', 1, 'name']));
  });

  it.each([['abc'], [1.5], [-3]])('details id %s gives path ["id"]', (id) => {
    const raw = rawDetails('getbyid-62587.json');
    Object.assign(raw, { id });
    const issues = toFailureIssues(detailsIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['id']));
  });

  it('box place with a non-numeric id gives path ["folder",0,"id"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    at(raw.folder, 0).id = 'abc';
    const issues = toFailureIssues(boxIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['folder', 0, 'id']));
  });

  it('box page without found gives path ["found"]', () => {
    const raw = rawBox('box-belgrade-page1.json');
    Reflect.deleteProperty(raw, 'found');
    const issues = toFailureIssues(boxIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['found']));
  });

  it('reply with a fractional vote count gives path ["comments",0,"replies",0,"good"]', () => {
    const raw = nested();
    at(at(raw.comments, 0).replies, 0).good = 1.5;
    const issues = toFailureIssues(detailsIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['comments', 0, 'replies', 0, 'good']));
  });

  it('reply to a reply without a name gives path ["comments",0,"replies",0,"replies",0,"name"]', () => {
    const raw = nested();
    Reflect.deleteProperty(at(at(at(raw.comments, 0).replies, 0).replies, 0), 'name');
    const issues = toFailureIssues(detailsIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(
      JSON.stringify(['comments', 0, 'replies', 0, 'replies', 0, 'name']),
    );
  });

  it('copies path and message of each Zod issue unchanged (strings and numbers kept)', () => {
    const raw = rawDetails('getbyid-62587.json');
    Reflect.deleteProperty(at(raw.comments, 1), 'name');
    const zodIssues = detailsIssues(raw);
    const issues = toFailureIssues(zodIssues);
    expect(issues).toStrictEqual(
      zodIssues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path,
        message: issue.message === '' ? 'invalid value' : issue.message,
      })),
    );
  });
});

describe('toFailureIssues never leaks input values', () => {
  it('a wrongly typed user_ip yields no IP value in message or path, and only path/message keys', () => {
    const raw = addCommenterIps(rawDetails('getbyid-62587.json'));
    Object.assign(at(raw.comments, 0), { user_ip: String(SYNTHETIC_IPS[0]) });
    const issues = toFailureIssues(detailsIssues(raw));
    expectValidIssues(issues);
    expect(paths(issues)).toContain(JSON.stringify(['comments', 0, 'user_ip']));
    const json = JSON.stringify(issues);
    for (const ip of SYNTHETIC_IPS) expect(json).not.toContain(String(ip));
  });

  it('does not copy input, code or any other field of a hand-built issue', () => {
    const secret = String(SYNTHETIC_IPS[2]);
    const issues = toFailureIssues([customIssue(['comments', 0, 'user_ip'], 'bad value', secret)]);
    expect(issues).toStrictEqual([{ path: ['comments', 0, 'user_ip'], message: 'bad value' }]);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});

describe('toFailureIssues path and message mapping', () => {
  it('maps a symbol path element to its description', () => {
    const issues = toFailureIssues([customIssue(['a', Symbol('described'), 0], 'bad')]);
    expect(issues).toStrictEqual([{ path: ['a', 'described', 0], message: 'bad' }]);
    expectValidIssues(issues);
  });

  it("maps a symbol without a description to 'symbol'", () => {
    const issues = toFailureIssues([customIssue([Symbol(), 'b'], 'bad')]);
    expect(issues).toStrictEqual([{ path: ['symbol', 'b'], message: 'bad' }]);
    expectValidIssues(issues);
  });

  it("maps an empty message to 'invalid value'", () => {
    const issues = toFailureIssues([customIssue(['title'], '')]);
    expect(issues).toStrictEqual([{ path: ['title'], message: 'invalid value' }]);
    expectValidIssues(issues);
  });

  it('keeps an empty path as the whole answer', () => {
    expect(toFailureIssues([customIssue([], 'whole')])).toStrictEqual([
      { path: [], message: 'whole' },
    ]);
  });
});

describe('toFailureIssues cap and minimum', () => {
  it('caps more than 20 issues at MAX_REPORTED_ISSUES, in input order', () => {
    const input = Array.from({ length: 25 }, (_, i) => customIssue(['item', i], `m${String(i)}`));
    const issues = toFailureIssues(input);
    expect(issues).toHaveLength(MAX_REPORTED_ISSUES);
    expect(issues).toStrictEqual(
      Array.from({ length: 20 }, (_, i) => ({ path: ['item', i], message: `m${String(i)}` })),
    );
  });

  it('keeps exactly 20 issues unchanged', () => {
    const input = Array.from({ length: 20 }, (_, i) => customIssue([i], 'm'));
    expect(toFailureIssues(input)).toHaveLength(20);
  });

  it("is never empty: no input issues give [{ path: [], message: 'invalid value' }]", () => {
    const issues = toFailureIssues([]);
    expect(issues).toStrictEqual([{ path: [], message: 'invalid value' }]);
    expectValidIssues(issues);
  });
});

describe('formatIssuePath', () => {
  it('formats keys with dots and indexes with brackets', () => {
    expect(formatIssuePath(['comments', 0, 'replies', 0, 'name'])).toBe(
      'comments[0].replies[0].name',
    );
  });

  it("formats the empty path as '(whole answer)'", () => {
    expect(formatIssuePath([])).toBe('(whole answer)');
  });

  it('formats a single key as the key', () => {
    expect(formatIssuePath(['title'])).toBe('title');
  });

  it('formats a box place id path', () => {
    expect(formatIssuePath(['folder', 0, 'id'])).toBe('folder[0].id');
  });
});

describe('describeIssues', () => {
  it("formats a single issue as 'prefix: <path>: <message>' with no count", () => {
    expect(describeIssues('Wrong shape', [{ path: ['title'], message: 'Required' }])).toBe(
      'Wrong shape: title: Required',
    );
  });

  it("appends ' (+N more)' when there are further issues", () => {
    const issues: FailureIssue[] = [
      { path: ['folder', 0, 'id'], message: 'first' },
      { path: ['found'], message: 'second' },
      { path: [], message: 'third' },
    ];
    expect(describeIssues('Wrong shape', issues)).toBe(
      'Wrong shape: folder[0].id: first (+2 more)',
    );
  });

  it('uses the whole-answer marker for an empty path', () => {
    expect(describeIssues('Bad', [{ path: [], message: 'not JSON' }])).toBe(
      'Bad: (whole answer): not JSON',
    );
  });

  it('names a reply to a reply with the formatted nested path', () => {
    const raw = nested();
    Reflect.deleteProperty(at(at(at(raw.comments, 0).replies, 0).replies, 0), 'name');
    const issues = toFailureIssues(detailsIssues(raw));
    const text = describeIssues('Unexpected response', issues);
    expect(text).toContain('comments[0].replies[0].replies[0].name');
    expect(text.startsWith('Unexpected response: ')).toBe(true);
  });
});
