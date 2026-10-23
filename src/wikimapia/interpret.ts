/**
 * Answer interpretation (AL4 1.4.4): classifies one Wikimapia HTTP body as data, a rate
 * limit, a Wikimapia error or an unexpected response. Pure and synchronous. No body text and
 * no `SyntaxError` text ever enters the result (.agrules section 4, No Commenter IPs).
 */
import type { z } from 'zod';
import {
  RawBoxResponseSchema,
  RawDebugResponseSchema,
  RawPlaceDetailsSchema,
  classifyDebugResponse,
  type ListingPage,
  type PlaceDetails,
} from '../../contracts/wikimapia-client.schema';
import { toFailureIssues } from './issues';
import { normalizeListingPage, normalizePlaceDetails } from './normalize';
import type { Interpretation, Normalized } from './types';

const NOT_JSON_MESSAGE = 'Wikimapia answer is not valid JSON';

function parseJson(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(body);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export function interpretAnswer<S extends z.ZodType, T>(
  body: string,
  rawSchema: S,
  normalize: (raw: z.output<S>) => Normalized<T>,
): Interpretation<T> {
  const parsed = parseJson(body);
  if (!parsed.ok) {
    return { kind: 'unexpected', issues: [{ path: [], message: NOT_JSON_MESSAGE }] };
  }

  const debug = RawDebugResponseSchema.safeParse(parsed.value);
  if (debug.success) {
    const info = classifyDebugResponse(debug.data.debug);
    switch (info.kind) {
      case 'key_quota':
        return { kind: 'key_quota', message: info.message };
      case 'rate_limit':
        return { kind: 'rate_limit', waitSeconds: info.waitSeconds };
      case 'wikimapia_error':
        return { kind: 'wikimapia_error', message: info.message };
      default: {
        const unreachable: never = info;
        return unreachable;
      }
    }
  }

  const raw = rawSchema.safeParse(parsed.value);
  if (!raw.success) {
    return { kind: 'unexpected', issues: toFailureIssues(raw.error.issues) };
  }

  const normalized = normalize(raw.data);
  return normalized.ok
    ? { kind: 'data', value: normalized.value }
    : { kind: 'unexpected', issues: normalized.issues };
}

export function interpretBoxAnswer(body: string): Interpretation<ListingPage> {
  return interpretAnswer(body, RawBoxResponseSchema, normalizeListingPage);
}

export function interpretPlaceDetailsAnswer(body: string): Interpretation<PlaceDetails> {
  return interpretAnswer(body, RawPlaceDetailsSchema, normalizePlaceDetails);
}
