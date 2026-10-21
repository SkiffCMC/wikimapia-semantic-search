/**
 * Issue mapping (AL4 1.4.5): turns Zod issues into contract `FailureIssue`s and formats
 * issue paths for failure messages. Only `path` and `message` are ever read from an issue;
 * input values are never copied (.agrules section 4, No Commenter IPs).
 */
import type { z } from 'zod';
import type { FailureIssue } from '../../contracts/wikimapia-client.schema.js';

export const MAX_REPORTED_ISSUES = 20;

const FALLBACK_MESSAGE = 'invalid value';

function toPathElement(element: PropertyKey): string | number {
  if (typeof element === 'symbol') return element.description ?? 'symbol';
  return element;
}

export function toFailureIssues(issues: readonly z.core.$ZodIssue[]): FailureIssue[] {
  const mapped = issues.slice(0, MAX_REPORTED_ISSUES).map(
    (issue): FailureIssue => ({
      path: issue.path.map(toPathElement),
      message: issue.message === '' ? FALLBACK_MESSAGE : issue.message,
    }),
  );
  return mapped.length > 0 ? mapped : [{ path: [], message: FALLBACK_MESSAGE }];
}

export function formatIssuePath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '(whole answer)';
  let text = '';
  for (const element of path) {
    if (typeof element === 'number') text += `[${String(element)}]`;
    else text += text === '' ? element : `.${element}`;
  }
  return text;
}

export function describeIssues(prefix: string, issues: readonly FailureIssue[]): string {
  const first = issues[0];
  if (first === undefined) return prefix;
  const more = issues.length > 1 ? ` (+${String(issues.length - 1)} more)` : '';
  return `${prefix}: ${formatIssuePath(first.path)}: ${first.message}${more}`;
}
