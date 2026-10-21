/**
 * AL5 CONTRACT: Wikimapia API client (feature `wikimapia-client`, Stage 1 substep 1).
 *
 * Layer:    AL5 (Contracts). Source of truth for AL4 design and AL2 implementation.
 * Derives:  docs/al6-requirements/20261020-wikimapia-client-al6.md (AC-1 .. AC-50)
 * Enforces: .agrules section 2 (boundary rules: every external response is parsed with Zod
 *           before use, invalid input is a handled error), section 4 "No Commenter IPs"
 *           (the parsed comment type has no `user_ip`, at any reply depth), section 4
 *           "Licensing" (every Place Summary keeps its Wikimapia link for attribution),
 *           section 4 "Strict Types Only" (all I/O typed through `z.infer`).
 *
 * Public entry point (see ENTRY_POINT): `src/wikimapia/client.ts` must export
 * `createWikimapiaClient: CreateWikimapiaClientFn`.
 *
 * Shapes:
 * - `Raw*` schemas describe the Wikimapia wire format (snake_case, ids sometimes as text).
 *   They are loose: unknown items are allowed (AC-16) and must not reach the output.
 * - Output schemas (`ListingPage`, `PlaceDetails`, `Comment`, ...) are strict: camelCase,
 *   whole-number ids, optional details absent rather than empty or placeholder values.
 * - Every client call resolves (never rejects) to a `ClientResult`: `{ ok: true, value }` or
 *   `{ ok: false, failure }` where `failure.kind` names the Client Failure (AL6 glossary).
 *
 * Data returned by the client is Wikimapia data, CC BY-NC-SA 3.0.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants (AL6 glossary and business rules)
// ---------------------------------------------------------------------------

/** Module path (under the repo root) that must export the public entry point. */
export const ENTRY_POINT = {
  module: 'src/wikimapia/client.ts',
  export: 'createWikimapiaClient',
} as const;

/**
 * Base address of the Wikimapia API (CLAUDE.md "Wikimapia API Reference"). HTTPS so the API
 * key never travels unencrypted (stakeholder-approved change, 2026-10-21: the API answers
 * `box` and `place.getbyid` identically over HTTPS, and HTTP does not redirect, so the client
 * must request HTTPS itself). Place links in responses stay `http://wikimapia.org/...`.
 */
export const WIKIMAPIA_API_URL = 'https://api.wikimapia.org/';
/** AC-4: Page Size used when the Operator states none; also the largest Wikimapia allows. */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;
/** AC-26, rule 4: Retries per request before Rate Limit Exhausted. */
export const DEFAULT_RETRY_LIMIT = 5;
/** AC-27, rule 4: Wait Time used when a Rate-Limit Response states no readable seconds. */
export const DEFAULT_FALLBACK_WAIT_SECONDS = 60;
/** AC-17: information blocks requested from `place.getbyid`. */
export const PLACE_DETAILS_DATA_BLOCKS = ['main', 'geometry', 'location', 'comments'] as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Place ID: a positive whole number (AL6 glossary). */
export const PlaceIdSchema = z.number().int().positive();
export const LongitudeSchema = z.number().min(-180).max(180);
export const LatitudeSchema = z.number().min(-90).max(90);
/** Two-letter ISO 639-1 language code, lower case (AC-5). */
export const LanguageCodeSchema = z.string().regex(/^[a-z]{2}$/, 'expected a two-letter code');
const NonEmptyTextSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Client configuration and injected collaborators
// ---------------------------------------------------------------------------

/** Data part of the client options. A missing or empty API Key is a Configuration Failure (AC-31). */
export const ClientConfigSchema = z.strictObject({
  apiKey: z.string().trim().min(1, 'API key is required'),
  language: LanguageCodeSchema.optional(),
  retryLimit: z.number().int().nonnegative().optional(),
  fallbackWaitSeconds: z.number().nonnegative().optional(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

/** What the client hands to the transport: the full request address (contains the API Key). */
export const TransportRequestSchema = z.strictObject({ url: z.url() });
export type TransportRequest = z.infer<typeof TransportRequestSchema>;

/** What the transport hands back: HTTP status and raw body text (parsed by the client). */
export const TransportResponseSchema = z.strictObject({
  status: z.number().int(),
  body: z.string(),
});
export type TransportResponse = z.infer<typeof TransportResponseSchema>;

/**
 * Network collaborator ("Simulated Wikimapia" in tests). Rejects when Wikimapia cannot be
 * reached; the client turns that, and any non-2xx status, into a Connection Failure (AC-33).
 */
export type WikimapiaTransport = (request: TransportRequest) => Promise<TransportResponse>;

/** Time collaborator ("Simulated Clock" in tests). All rate-limit waiting goes through it (AC-30). */
export interface Clock {
  sleep(milliseconds: number): Promise<void>;
}

export interface WikimapiaClientOptions extends ClientConfig {
  /** Defaults to a real HTTP transport; tests always inject one (AC-38). */
  transport?: WikimapiaTransport;
  /** Defaults to real time; tests always inject one (AC-38). */
  clock?: Clock;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Bounding Box: west, south, east, north; west < east, south < north (AL6 glossary, AC-7). */
export const BoundingBoxSchema = z
  .strictObject({
    west: LongitudeSchema,
    south: LatitudeSchema,
    east: LongitudeSchema,
    north: LatitudeSchema,
  })
  .refine((b) => b.west < b.east, { message: 'west must be less than east', path: ['east'] })
  .refine((b) => b.south < b.north, { message: 'south must be less than north', path: ['north'] });
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** AC-3, AC-4, AC-7, AC-8. Invalid input is reported as `invalid_request` with issue paths. */
export const ListPlacesInputSchema = z.strictObject({
  bbox: BoundingBoxSchema,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});
export type ListPlacesInput = z.input<typeof ListPlacesInputSchema>;

/** AC-17, AC-18. */
export const PlaceDetailsInputSchema = z.strictObject({ placeId: PlaceIdSchema });
export type PlaceDetailsInput = z.input<typeof PlaceDetailsInputSchema>;

// ---------------------------------------------------------------------------
// Raw Wikimapia wire format (validation only; loose so extra items are tolerated, AC-16)
// ---------------------------------------------------------------------------

/** Ids arrive as numbers or as digit strings (`"7291521"`). */
export const RawIdSchema = z.union([PlaceIdSchema, z.string().regex(/^[1-9]\d*$/)]);
/** Whole numbers that may arrive as text (`found: "290"`, `parent_id: "0"`). */
export const RawWholeNumberSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const RawPointSchema = z.looseObject({ x: LongitudeSchema, y: LatitudeSchema });
export type RawPoint = z.infer<typeof RawPointSchema>;

export const RawBoundsLocationSchema = z.looseObject({
  lon: LongitudeSchema,
  lat: LatitudeSchema,
  north: LatitudeSchema,
  south: LatitudeSchema,
  east: LongitudeSchema,
  west: LongitudeSchema,
});

export const RawDetailsLocationSchema = RawBoundsLocationSchema.extend({
  street: z.string().nullish(),
  housenumber: z.string().nullish(),
  city: z.string().nullish(),
  place: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
});

/** One item of a `box` page (`folder`). */
export const RawBoxPlaceSchema = z.looseObject({
  id: RawIdSchema,
  name: z.string(),
  url: z.string(),
  location: RawBoundsLocationSchema,
  polygon: z.array(RawPointSchema),
});

/** `function=box` answer. */
export const RawBoxResponseSchema = z.looseObject({
  page: RawWholeNumberSchema,
  count: RawWholeNumberSchema,
  found: RawWholeNumberSchema,
  folder: z.array(RawBoxPlaceSchema),
});
export type RawBoxResponse = z.infer<typeof RawBoxResponseSchema>;

/**
 * A comment or reply as Wikimapia sends it. `user_ip` is tolerated on the wire (and only
 * there): it must never appear in any output (`.agrules` section 4).
 */
export const RawCommentSchema = z.looseObject({
  place_id: PlaceIdSchema,
  num: z.number().int().nonnegative(),
  lang_id: z.number().int().nonnegative(),
  user_id: z.number().int().nonnegative(),
  user_ip: z.number().int().optional(),
  user_photo: z.string(),
  name: z.string(),
  message: z.string(),
  good: z.number().int().nonnegative(),
  bad: z.number().int().nonnegative(),
  block: z.boolean(),
  date: z.number().int().nonnegative(),
  moder_uid: z.number().int().nonnegative(),
  moder_name: z.string().nullable(),
  is_deleted: z.boolean(),
  get replies(): z.ZodArray<typeof RawCommentSchema> {
    return z.array(RawCommentSchema);
  },
});
export type RawComment = z.infer<typeof RawCommentSchema>;

/** `function=place.getbyid` answer with `data_blocks=main,geometry,location,comments`. */
export const RawPlaceDetailsSchema = z.looseObject({
  id: RawIdSchema,
  title: z.string(),
  description: z.string(),
  wikipedia: z.string().nullish(),
  is_building: z.boolean(),
  is_region: z.boolean(),
  is_deleted: z.boolean(),
  tags: z.array(z.looseObject({ id: z.number().int().nonnegative(), title: z.string() })),
  parent_id: RawWholeNumberSchema,
  polygon: z.array(RawPointSchema),
  location: RawDetailsLocationSchema,
  comments: z.array(RawCommentSchema),
});
export type RawPlaceDetails = z.infer<typeof RawPlaceDetailsSchema>;

/** Wikimapia's message envelope, used both for Rate-Limit Responses and for other errors. */
export const RawDebugResponseSchema = z.looseObject({
  debug: z.looseObject({ message: z.string() }),
});
export type RawDebugResponse = z.infer<typeof RawDebugResponseSchema>;

// ---------------------------------------------------------------------------
// Outputs (strict: nothing beyond what AL6 lists, AC-16; no Commenter IP, AC-11 / AC-45)
// ---------------------------------------------------------------------------

/** Outline point (Wikimapia `{x, y}` -> `{lon, lat}`). */
export const PointSchema = z.strictObject({ lon: LongitudeSchema, lat: LatitudeSchema });
export type Point = z.infer<typeof PointSchema>;

export const BoundsLocationSchema = z.strictObject({
  lon: LongitudeSchema,
  lat: LatitudeSchema,
  north: LatitudeSchema,
  south: LatitudeSchema,
  east: LongitudeSchema,
  west: LongitudeSchema,
});
export type BoundsLocation = z.infer<typeof BoundsLocationSchema>;

/** Location with address details; each detail is absent (not empty) when Wikimapia has none (AC-13). */
export const LocationSchema = BoundsLocationSchema.extend({
  street: NonEmptyTextSchema.exactOptional(),
  houseNumber: NonEmptyTextSchema.exactOptional(),
  city: NonEmptyTextSchema.exactOptional(),
  place: NonEmptyTextSchema.exactOptional(),
  state: NonEmptyTextSchema.exactOptional(),
  country: NonEmptyTextSchema.exactOptional(),
});
export type Location = z.infer<typeof LocationSchema>;

/**
 * Invariant: a Wikimapia page link for place N has the form `http(s)://wikimapia.org/N[/...]`.
 * Licensing (.agrules section 4, AL6 rule 8): every Place Summary keeps a link back.
 */
export function isWikimapiaPlaceUrl(url: string, placeId: number): boolean {
  const match = /^https?:\/\/wikimapia\.org\/([1-9]\d*)(?:[/?#]|$)/.exec(url);
  return match !== null && Number(match[1]) === placeId;
}

/** Place Summary from a Listing Page (AC-2). */
export const PlaceSummarySchema = z
  .strictObject({
    placeId: PlaceIdSchema,
    name: z.string(),
    url: z.string(),
    location: BoundsLocationSchema,
    outline: z.array(PointSchema),
  })
  .refine((p) => isWikimapiaPlaceUrl(p.url, p.placeId), {
    message: 'url must be the Wikimapia page link of this place',
    path: ['url'],
  });
export type PlaceSummary = z.infer<typeof PlaceSummarySchema>;

/** Listing Page (AC-1, AC-6). `pageSize` is the page size Wikimapia reports (`count`). */
export const ListingPageSchema = z.strictObject({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
  totalFound: z.number().int().nonnegative(),
  places: z.array(PlaceSummarySchema),
});
export type ListingPage = z.infer<typeof ListingPageSchema>;

export const TagSchema = z.strictObject({ id: z.number().int().nonnegative(), title: z.string() });
export type Tag = z.infer<typeof TagSchema>;

/**
 * Comment, and recursively Reply (AL6 glossary, rule 7, Q3). No Commenter IP field at any
 * depth: the strict object rejects `user_ip`, `userIp` or any other unlisted key.
 * `authorPhotoUrl` and `moderatorName` are absent when Wikimapia sends an empty value or null.
 */
export const CommentSchema = z.strictObject({
  placeId: PlaceIdSchema,
  num: z.number().int().nonnegative(),
  langId: z.number().int().nonnegative(),
  author: z.string(),
  /** 0 for anonymous authors. */
  authorUserId: z.number().int().nonnegative(),
  authorPhotoUrl: NonEmptyTextSchema.exactOptional(),
  message: z.string(),
  goodVotes: z.number().int().nonnegative(),
  badVotes: z.number().int().nonnegative(),
  isBlocked: z.boolean(),
  isDeleted: z.boolean(),
  /** Posting moment as whole seconds since 1970-01-01T00:00:00Z (Wikimapia `date`). */
  postedAtEpochSeconds: z.number().int().nonnegative(),
  moderatorUserId: z.number().int().nonnegative(),
  moderatorName: NonEmptyTextSchema.exactOptional(),
  get replies(): z.ZodArray<typeof CommentSchema> {
    return z.array(CommentSchema);
  },
});
export type Comment = z.infer<typeof CommentSchema>;

/** Place Details (AC-9 .. AC-20). Optional items are absent, never empty or placeholder. */
export const PlaceDetailsSchema = z.strictObject({
  placeId: PlaceIdSchema,
  title: z.string(),
  description: z.string(),
  tags: z.array(TagSchema),
  /** Absent when Wikimapia reports parent id "0" (AC-15). */
  parentPlaceId: PlaceIdSchema.exactOptional(),
  isBuilding: z.boolean(),
  isRegion: z.boolean(),
  isDeleted: z.boolean(),
  wikipediaUrl: NonEmptyTextSchema.exactOptional(),
  outline: z.array(PointSchema),
  location: LocationSchema,
  comments: z.array(CommentSchema),
});
export type PlaceDetails = z.infer<typeof PlaceDetailsSchema>;

// ---------------------------------------------------------------------------
// Client Failures (AL6 glossary, AC-31 .. AC-37)
// ---------------------------------------------------------------------------

/**
 * Names the offending item. For `invalid_request` the path is into the client input
 * (e.g. `['bbox', 'east']`, `['pageSize']`, `['placeId']`); for `unexpected_response` it is
 * into the raw Wikimapia answer (e.g. `['title']`, `['comments', 0, 'replies', 0, 'name']`).
 * An empty path means the whole answer (e.g. not valid JSON).
 */
export const FailureIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: NonEmptyTextSchema,
});
export type FailureIssue = z.infer<typeof FailureIssueSchema>;

export const ConfigurationFailureSchema = z.strictObject({
  kind: z.literal('configuration'),
  message: NonEmptyTextSchema,
});

export const InvalidRequestFailureSchema = z.strictObject({
  kind: z.literal('invalid_request'),
  message: NonEmptyTextSchema,
  issues: z.array(FailureIssueSchema).min(1),
});

export const RateLimitExhaustedFailureSchema = z.strictObject({
  kind: z.literal('rate_limit_exhausted'),
  message: NonEmptyTextSchema,
  /** Requests sent for this call, i.e. Retry Limit + 1. */
  attempts: z.number().int().min(1),
  /** Wait Time (seconds) of the last Rate-Limit Response; the Fallback Wait Time if unreadable. */
  lastWaitSeconds: z.number().nonnegative(),
});

export const WikimapiaErrorFailureSchema = z.strictObject({
  kind: z.literal('wikimapia_error'),
  message: NonEmptyTextSchema,
  /** Wikimapia's own message text, unchanged. */
  wikimapiaMessage: z.string(),
});

export const ConnectionFailureSchema = z.strictObject({
  kind: z.literal('connection'),
  message: NonEmptyTextSchema,
  /** HTTP status when Wikimapia answered with a non-success status; absent if unreachable. */
  status: z.number().int().exactOptional(),
});

export const UnexpectedResponseFailureSchema = z.strictObject({
  kind: z.literal('unexpected_response'),
  message: NonEmptyTextSchema,
  issues: z.array(FailureIssueSchema).min(1),
});

export const ClientFailureSchema = z.discriminatedUnion('kind', [
  ConfigurationFailureSchema,
  InvalidRequestFailureSchema,
  RateLimitExhaustedFailureSchema,
  WikimapiaErrorFailureSchema,
  ConnectionFailureSchema,
  UnexpectedResponseFailureSchema,
]);
export type ClientFailure = z.infer<typeof ClientFailureSchema>;
export type ClientFailureKind = ClientFailure['kind'];

// ---------------------------------------------------------------------------
// Results and public API
// ---------------------------------------------------------------------------

/** A failure result carries no partial data (AC-35, AC-46): only `ok` and `failure`. */
function clientResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), failure: ClientFailureSchema }),
  ]);
}

export const ListPlacesResultSchema = clientResultSchema(ListingPageSchema);
export type ListPlacesResult = z.infer<typeof ListPlacesResultSchema>;

export const PlaceDetailsResultSchema = clientResultSchema(PlaceDetailsSchema);
export type PlaceDetailsResult = z.infer<typeof PlaceDetailsResultSchema>;

/** Calls never reject; every outcome is a `ClientResult`. */
export interface WikimapiaClient {
  /** One Listing Page of `function=box` (US-1). */
  listPlaces(input: ListPlacesInput): Promise<ListPlacesResult>;
  /** Place Details of `function=place.getbyid` (US-2). */
  getPlaceDetails(input: PlaceDetailsInput): Promise<PlaceDetailsResult>;
}

/**
 * Public entry point, exported as `createWikimapiaClient` from `src/wikimapia/client.ts`.
 * Never throws: with a missing or empty API Key it still returns a client, whose every call
 * resolves to a `configuration` failure without contacting Wikimapia (AC-31).
 */
export type CreateWikimapiaClientFn = (options: WikimapiaClientOptions) => WikimapiaClient;

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

export interface RateLimitMessageInfo {
  /** The message says the limit was reached and/or asks to wait (AL6 rule 5). */
  isRateLimit: boolean;
  /** Whole seconds stated in "wait for N seconds"; absent when not readable (AC-27). */
  waitSeconds?: number;
}

/**
 * Classifies the `debug.message` of a Wikimapia answer (AL6 rule 5). A Rate-Limit Response
 * says "You have reached the limit for this action. You need to wait for N seconds."; any
 * other message is a Wikimapia Error (AC-32).
 */
export function parseRateLimitMessage(message: string): RateLimitMessageInfo {
  const wait = /\bwait for (\d+) seconds?\b/i.exec(message);
  const limitReached = /\breached the limit\b/i.test(message);
  const asksToWait = /\bwait\b.*\bseconds?\b/i.test(message);
  const isRateLimit = limitReached || asksToWait;
  const seconds = wait?.[1];
  return seconds === undefined ? { isRateLimit } : { isRateLimit, waitSeconds: Number(seconds) };
}

const COMMENTER_IP_KEY = /^(?:user_?ip|commenter_?ip)$/i;

/**
 * Returns the paths of every Commenter IP key (`user_ip`, `userIp`, ...) found anywhere in a
 * value. Gate for outputs, failures and stored fixtures (.agrules section 4): must be empty.
 */
export function findCommenterIpPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findCommenterIpPaths(item, `${path}[${String(index)}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(COMMENTER_IP_KEY.test(key) ? [`${path}.${key}`] : []),
      ...findCommenterIpPaths(item, `${path}.${key}`),
    ]);
  }
  return [];
}
