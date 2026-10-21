/**
 * Secret redaction (AL4 1.4.9, AC-36): removes the API key and keyed request addresses
 * from failure text. The key is matched with plain string operations only and is never
 * compiled into a RegExp.
 */
import type { ClientFailure, FailureIssue } from '../../contracts/wikimapia-client.schema';

const ADDRESS_REMOVED = '[request address removed]';
const KEY_REMOVED = '[key removed]';

export function redactSecrets(text: string, apiKey: string): string {
  // Step 1: keyed request addresses.
  let result = text.replace(/https?:\/\/[^\s"'<>]+/g, (match) =>
    match.includes('key=') || (apiKey !== '' && match.includes(apiKey))
      ? ADDRESS_REMOVED
      : match,
  );
  // Step 2: key parameters outside any address.
  result = result.replace(/[?&]key=[^&\s"'<>]*/gi, KEY_REMOVED);
  // Step 3: bare key occurrences (split/join, never a RegExp built from the key).
  if (apiKey !== '') result = result.split(apiKey).join(KEY_REMOVED);
  return result;
}

function redactIssues(issues: readonly FailureIssue[], apiKey: string): FailureIssue[] {
  return issues.map(
    (issue): FailureIssue => ({
      path: issue.path.map((element) =>
        typeof element === 'string' ? redactSecrets(element, apiKey) : element,
      ),
      message: redactSecrets(issue.message, apiKey),
    }),
  );
}

export function redactFailure(failure: ClientFailure, apiKey: string): ClientFailure {
  const message = redactSecrets(failure.message, apiKey);
  switch (failure.kind) {
    case 'configuration':
    case 'rate_limit_exhausted':
    case 'connection':
      return { ...failure, message };
    case 'wikimapia_error':
      return {
        ...failure,
        message,
        wikimapiaMessage: redactSecrets(failure.wikimapiaMessage, apiKey),
      };
    case 'invalid_request':
    case 'unexpected_response':
      return { ...failure, message, issues: redactIssues(failure.issues, apiKey) };
    default: {
      const unreachable: never = failure;
      return unreachable;
    }
  }
}
