/**
 * Failures (AL4 1.4.3): builds `invalid_data` and `store_unavailable` failures. Thrown errors
 * are mapped to a fixed template plus a safe code only; no error message, detail, SQL text,
 * binding or connection string ever reaches a failure (AC-57).
 */
import type { StoreFailure, StoreIssue } from '../../contracts/storage.schema';
import { MAX_REPORTED_ISSUES, formatIssuePath } from '../wikimapia/issues';

const FALLBACK_ISSUE_MESSAGE = 'invalid value';
const WHOLE_INPUT = '(whole input)';
const ERRNO_CODE = /^E[A-Z0-9_]+$/;
const SQLSTATE_CODE = /^[0-9A-Z]{5}$/;

function copyIssue(issue: StoreIssue): StoreIssue {
  const copy: StoreIssue = { path: [...issue.path], message: issue.message };
  if (issue.commentNum !== undefined) copy.commentNum = issue.commentNum;
  if (issue.placeId !== undefined) copy.placeId = issue.placeId;
  return copy;
}

export function describeStoreIssues(prefix: string, issues: readonly StoreIssue[]): string {
  const first = issues[0];
  if (first === undefined) return prefix;
  const path = first.path.length === 0 ? WHOLE_INPUT : formatIssuePath(first.path);
  const more = issues.length > 1 ? ` (+${String(issues.length - 1)} more)` : '';
  return `${prefix}: ${path}: ${first.message}${more}`;
}

export function invalidData(issues: readonly StoreIssue[]): StoreFailure {
  const capped = issues.slice(0, MAX_REPORTED_ISSUES).map(copyIssue);
  const kept: StoreIssue[] =
    capped.length > 0 ? capped : [{ path: [], message: FALLBACK_ISSUE_MESSAGE }];
  return { kind: 'invalid_data', message: describeStoreIssues('Invalid data', kept), issues: kept };
}

export function storeUnavailable(message: string): StoreFailure {
  return { kind: 'store_unavailable', message };
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function acceptedCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return ERRNO_CODE.test(value) || SQLSTATE_CODE.test(value) ? value : undefined;
}

export function safeErrorCode(error: unknown): string | undefined {
  try {
    if (!isObject(error)) return undefined;
    const own = acceptedCode(Reflect.get(error, 'code'));
    if (own !== undefined) return own;
    const cause: unknown = Reflect.get(error, 'cause');
    if (!isObject(cause)) return undefined;
    return acceptedCode(Reflect.get(cause, 'code'));
  } catch {
    return undefined;
  }
}

export function unavailableFrom(error: unknown, action: string): StoreFailure {
  const code = safeErrorCode(error);
  const suffix = code === undefined ? '' : ` (${code})`;
  return storeUnavailable(`Place Store unavailable: ${action} failed${suffix}`);
}
