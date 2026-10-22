/**
 * Public factory (AL4 1.2 steps 1 to 3, 1.4.1 Configuration, 1.4.2 Input validation, 1.4.8
 * last bullet, 1.5 Transaction boundaries, U5): resolves the configuration once at creation,
 * validates each call's input, builds the request URL and hands it to the execution core.
 * Never throws, never rejects, keeps no state between calls.
 */
import type { z } from 'zod';
import {
  ClientConfigSchema,
  DEFAULT_FALLBACK_WAIT_SECONDS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETRY_LIMIT,
  ListPlacesInputSchema,
  PlaceDetailsInputSchema,
  type ClientConfig,
  type ClientFailure,
  type FailureIssue,
  type ListPlacesInput,
  type ListPlacesResult,
  type PlaceDetailsInput,
  type PlaceDetailsResult,
  type WikimapiaClient,
  type WikimapiaClientOptions,
} from '../../contracts/wikimapia-client.schema';
import { executeRequest } from './execute';
import { interpretBoxAnswer, interpretPlaceDetailsAnswer } from './interpret';
import { describeIssues, toFailureIssues } from './issues';
import { redactFailure } from './redact';
import { buildBoxUrl, buildPlaceDetailsUrl } from './request';
import { createFetchTransport, systemClock } from './runtime';
import type { Resolved, UncheckedOptions } from './types';

export { createFetchTransport, systemClock } from './runtime';

const INTERNAL_ISSUES: readonly FailureIssue[] = [{ path: [], message: 'internal client error' }];

function configCandidate(source: UncheckedOptions): Partial<ClientConfig> {
  if (source === null || source === undefined) return {};
  return {
    ...(source.apiKey === undefined ? {} : { apiKey: source.apiKey }),
    ...(source.language === undefined ? {} : { language: source.language }),
    ...(source.retryLimit === undefined ? {} : { retryLimit: source.retryLimit }),
    ...(source.fallbackWaitSeconds === undefined
      ? {}
      : { fallbackWaitSeconds: source.fallbackWaitSeconds }),
  };
}

function resolveConfig(options: WikimapiaClientOptions): Resolved {
  const candidate: Partial<ClientConfig> = configCandidate(options);

  const parsed = ClientConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const trimmedKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : '';
    const failure: ClientFailure = {
      kind: 'configuration',
      message: describeIssues(
        'Wikimapia client is not configured',
        toFailureIssues(parsed.error.issues),
      ),
    };
    return { ok: false, failure: redactFailure(failure, trimmedKey) };
  }

  const config = parsed.data;
  const { transport, clock } = options;
  return {
    ok: true,
    language: config.language,
    deps: {
      transport: transport ?? createFetchTransport(),
      clock: clock ?? systemClock,
      apiKey: config.apiKey,
      retryLimit: config.retryLimit ?? DEFAULT_RETRY_LIMIT,
      fallbackWaitSeconds: config.fallbackWaitSeconds ?? DEFAULT_FALLBACK_WAIT_SECONDS,
    },
  };
}

function invalidRequest(
  issues: readonly z.core.$ZodIssue[],
  apiKey: string,
): ClientFailure {
  const failureIssues = toFailureIssues(issues);
  return redactFailure(
    {
      kind: 'invalid_request',
      message: describeIssues('Invalid request', failureIssues),
      issues: failureIssues,
    },
    apiKey,
  );
}

function internalError(apiKey: string): { ok: false; failure: ClientFailure } {
  return {
    ok: false,
    failure: redactFailure(
      {
        kind: 'unexpected_response',
        message: describeIssues('Unexpected Wikimapia response', INTERNAL_ISSUES),
        issues: INTERNAL_ISSUES.map((issue) => ({ path: [...issue.path], message: issue.message })),
      },
      apiKey,
    ),
  };
}

export function createWikimapiaClient(options: WikimapiaClientOptions): WikimapiaClient {
  const resolved = resolveConfig(options);

  function listPlaces(input: ListPlacesInput): Promise<ListPlacesResult> {
    if (!resolved.ok) return Promise.resolve({ ok: false, failure: resolved.failure });
    const { deps, language } = resolved;
    try {
      const parsed = ListPlacesInputSchema.safeParse(input);
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          failure: invalidRequest(parsed.error.issues, deps.apiKey),
        });
      }
      const url = buildBoxUrl({
        apiKey: deps.apiKey,
        ...(language === undefined ? {} : { language }),
        bbox: parsed.data.bbox,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize ?? DEFAULT_PAGE_SIZE,
      });
      return executeRequest(url, interpretBoxAnswer, deps).catch(() =>
        internalError(deps.apiKey),
      );
    } catch {
      return Promise.resolve(internalError(deps.apiKey));
    }
  }

  function getPlaceDetails(input: PlaceDetailsInput): Promise<PlaceDetailsResult> {
    if (!resolved.ok) return Promise.resolve({ ok: false, failure: resolved.failure });
    const { deps, language } = resolved;
    try {
      const parsed = PlaceDetailsInputSchema.safeParse(input);
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          failure: invalidRequest(parsed.error.issues, deps.apiKey),
        });
      }
      const url = buildPlaceDetailsUrl({
        apiKey: deps.apiKey,
        ...(language === undefined ? {} : { language }),
        placeId: parsed.data.placeId,
      });
      return executeRequest(url, interpretPlaceDetailsAnswer, deps).catch(() =>
        internalError(deps.apiKey),
      );
    } catch {
      return Promise.resolve(internalError(deps.apiKey));
    }
  }

  return { listPlaces, getPlaceDetails };
}
