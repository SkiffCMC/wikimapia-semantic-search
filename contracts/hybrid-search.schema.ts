/**
 * AL5 CONTRACT: Hybrid Search, Place Search (feature `hybrid-search`, Stage 2 substep 2a).
 *
 * Layer:    AL5 (Contracts). Source of truth for AL4 design and AL2 implementation.
 * Derives:  docs/al6-requirements/20261027-hybrid-search-al6.md (revision 3, approved
 *           2026-10-30: AC-1 .. AC-72, rules 1 .. 13, decisions Q1 .. Q11, R-A, R-B), intent
 *           docs/al7-intent/20261027-hybrid-search-al7.md. Revision 3 (decision Q11) changes
 *           only the documented command form to `pnpm run search "<Query Text>" [options]`
 *           (AC-41, AC-71, rule 13) and adds AC-72; the AL7 wording `pnpm search` is superseded.
 *           Revision 4 (2026-10-31, section 6.2 item 14) changes only AC-72's precondition: it
 *           holds for the pnpm the project has installed, whatever its version.
 * Enforces: .agrules section 1 "Spatial-Filtered Hybrid Search" (the Spatial Filter and the Tag
 *           Filter restrict, the Similarity Score ranks; a Place outside the filters is never
 *           returned, in either Search Mode), "Offline Ingestion" (search embeds only the Query
 *           Text, never stored content, and never calls Wikimapia), section 2 "Validated
 *           output" (every Embedding Service answer is checked with `findEmbeddingAnswerIssues`
 *           before use; an invalid one is a handled Query Embedding Failure), "One Embedding
 *           Model per Column" (the Query Embedding is exactly 1024 finite numbers from
 *           `voyage-4`, sent as `inputType: "query"`; only Embedding Records of `voyage-4` are
 *           compared with it), "Result Cards" as far as AL6 decision Q1 places it in this
 *           feature (every Search Result carries its Place ID, name, Tag titles as category
 *           info, and a Wikimapia Link that points to that Place; the `/ru/{title_slug}` card
 *           link and per-card attribution belong to the Stage 3 result cards), section 3 (all
 *           SQL, the PostGIS filters and the pgvector `<=>` ranking, lives in `src/db/`;
 *           parameterized only: the Query Text, Tag titles and numbers never reach SQL by string
 *           interpolation, AC-40), section 4 "Licensing" (read-only, at most 50 Places per answer,
 *           the Search Command prints the Wikimapia attribution line), "No Live External Calls
 *           in Tests", "Strict Types Only" (all I/O typed through `z.infer`).
 *
 * Reuses the Embedding seam of ./embeddings.schema (EMBEDDING_MODEL, EMBEDDING_DIMENSIONS,
 * QUERY_INPUT_TYPE, `findEmbeddingAnswerIssues`, `classifyEmbeddingServiceError`,
 * EmbeddingFailureKind) and the Place shapes of ./wikimapia-client.schema (PlaceIdSchema,
 * latitude and longitude ranges, `isWikimapiaPlaceUrl`).
 *
 * Public entry points (black box for ./hybrid-search.test.ts):
 * - `src/search/search-places.ts` exports `searchPlaces: SearchPlacesFn`          (ENTRY_POINT)
 * - `src/search/command.ts`       exports `runSearchCommand: RunSearchCommandFn` (SEARCH_COMMAND_ENTRY_POINT)
 * - `package.json` script `search` runs the Search Command through `tsx` (SEARCH_SCRIPT, AC-41);
 *   the Developer runs it as `pnpm run search ...` (SEARCH_COMMAND_FORM, decision Q11, AC-72).
 * The finished `createPlaceStore`, `createSchemaSetup`, `createEmbeddingStore` and
 * `buildPlaceDocument` are used unchanged; this feature adds no Schema Setup step and changes
 * no stored data (AC-39).
 *
 * Embedding Service seam: `QueryEmbeddingService.embed` has the name and camelCase request shape
 * of `VoyageAIClient.embed` of the `voyageai` package (`input`, `model`, `inputType`,
 * `outputDimension`, `truncation`). Production code passes Voyage (the adapter of the Embed Run
 * or a sibling) built with VOYAGE_API_KEY; every test passes a Simulated Embedding Service. The
 * answer is untrusted (`unknown`) and checked with `findEmbeddingAnswerIssues(answer, 1)`; a
 * thrown error is classified with `classifyEmbeddingServiceError`. No retry (decision Q10).
 *
 * Order of checks (rule 6, section 3.7, AC-56, AC-57): the Search Request is validated first
 * (Invalid Search Request: no Embedding Service call, the Place Store not consulted), then the
 * key (Missing Key: no call, not consulted), then the Query Text is embedded once (Query
 * Embedding Failure: the Place Store not consulted), then the Place Store is searched.
 *
 * Every entry point resolves (never rejects): `searchPlaces` to a SearchOutcome,
 * `runSearchCommand` to a SearchCommandResult.
 *
 * Search Results are Wikimapia data, CC BY-NC-SA 3.0, non-commercial only.
 */
import { z } from 'zod';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingFailureKindSchema,
  QUERY_INPUT_TYPE,
} from './embeddings.schema';
import {
  LatitudeSchema,
  LongitudeSchema,
  PlaceIdSchema,
  isWikimapiaPlaceUrl,
} from './wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Entry points, environment and fixed names
// ---------------------------------------------------------------------------

/** Module path that must export Place Search. */
export const ENTRY_POINT = {
  module: 'src/search/search-places.ts',
  export: 'searchPlaces',
} as const;

/** Module path that must export the Search Command (argument parsing, env, output, exit code). */
export const SEARCH_COMMAND_ENTRY_POINT = {
  module: 'src/search/command.ts',
  export: 'runSearchCommand',
} as const;

/**
 * AC-41, decision Q11: the `package.json` script `search` runs the Search Command through `tsx`;
 * the Developer runs it as `pnpm run search "<Query Text>" [options]`. The short form
 * `pnpm search ...` is not the Search Command (pnpm 10.33 treats it as an npm registry search).
 */
export const SEARCH_SCRIPT = { name: 'search', runner: 'tsx' } as const;

/**
 * Rule 13, decision Q11: the documented form of the Search Command, shown verbatim in its usage
 * message (AC-44, AC-72) and wherever the Developer is told how to run it.
 */
export const SEARCH_COMMAND_FORM = 'pnpm run search "<Query Text>" [options]';

/** Environment variables read by the Search Command (AC-45, rule 11). */
export const VOYAGE_API_KEY_ENV = 'VOYAGE_API_KEY';
export const DATABASE_URL_ENV = 'DATABASE_URL';

// ---------------------------------------------------------------------------
// Constants (AL6 glossary and decisions)
// ---------------------------------------------------------------------------

/** Glossary "Result Limit" (decision Q7): default 20, at most 50; above 50 is refused. */
export const DEFAULT_RESULT_LIMIT = 20;
export const MAX_RESULT_LIMIT = 50;

/** Decision Q8: Query Text at most 1,000 characters (Unicode code points) after trimming. */
export const MAX_QUERY_TEXT_LENGTH = 1000;

/** Decision Q8: the Maximum Radius in metres. */
export const MAX_RADIUS_METRES = 50_000;

/** AC-14: a reported Distance is within this many metres of the true WGS 84 surface distance. */
export const DISTANCE_TOLERANCE_METRES = 1;

/** AC-1, AC-66: a reported Similarity Score is within this of the true cosine similarity. */
export const SIMILARITY_TOLERANCE = 0.000001;

/** Glossary "Search Mode" (decision Q6). */
export const SearchModeSchema = z.enum(['exact', 'approximate']);
export type SearchMode = z.infer<typeof SearchModeSchema>;
export const DEFAULT_SEARCH_MODE: SearchMode = 'exact';

/** Embedding Model of the only Embedding Records that are searched (decision R-A). */
export const SEARCHABLE_EMBEDDING_MODEL = EMBEDDING_MODEL;

// ---------------------------------------------------------------------------
// Search Request (glossary; AC-46 .. AC-55, AC-70)
// ---------------------------------------------------------------------------

/**
 * Parameter names an Invalid Search Request reports (AC-46 .. AC-55, AC-70). An unknown
 * top-level key is reported under its own name (AC-55); a value that is not an object at all
 * under `request`.
 */
export const SEARCH_PARAMETERS = {
  queryText: 'queryText',
  centre: 'centre',
  radiusMetres: 'radiusMetres',
  area: 'area',
  spatialFilter: 'spatialFilter',
  tags: 'tags',
  limit: 'limit',
  mode: 'mode',
  request: 'request',
} as const;
export type KnownSearchParameter = (typeof SEARCH_PARAMETERS)[keyof typeof SEARCH_PARAMETERS];

/** Number of Unicode code points (the "characters" of decision Q8). */
export function characterCount(text: string): number {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length;
}

/**
 * The Query Text as sent to the Embedding Service (AC-3): spacing removed at both ends only
 * (`String.prototype.trim`), everything else unchanged.
 */
export function queryTextToEmbed(queryText: string): string {
  return queryText.trim();
}

/** Glossary "Tag Title Match" (decision Q4): equal after trimming and ignoring case. */
export function normalizeTagTitle(title: string): string {
  return title.trim().toLowerCase();
}

export function tagTitlesMatch(filterTitle: string, catalogueTitle: string): boolean {
  return normalizeTagTitle(filterTitle) === normalizeTagTitle(catalogueTitle);
}

/** Search Centre and result Centre Point: latitude first (decision Q2), WGS 84. */
export const LatLonSchema = z.strictObject({ lat: LatitudeSchema, lon: LongitudeSchema });
export type LatLon = z.infer<typeof LatLonSchema>;

/** Area Filter edges (glossary): south below north, west below east (no antimeridian box). */
export const AreaFilterSchema = z
  .strictObject({
    south: LatitudeSchema,
    west: LongitudeSchema,
    north: LatitudeSchema,
    east: LongitudeSchema,
  })
  .refine((a) => a.south < a.north && a.west < a.east, {
    message: 'south must be below north and west below east',
  });
export type AreaFilter = z.infer<typeof AreaFilterSchema>;

const QueryTextSchema = z.string().refine(
  (text) => {
    const length = characterCount(queryTextToEmbed(text));
    return length >= 1 && length <= MAX_QUERY_TEXT_LENGTH;
  },
  { message: `must hold 1 .. ${String(MAX_QUERY_TEXT_LENGTH)} characters after trimming` },
);

const TagFilterSchema = z
  .array(
    z.string().refine((title) => title.trim() !== '', {
      message: 'a Tag title must not be empty or only spacing',
    }),
  )
  .min(1);

/**
 * The Search Request a Search Caller gives to Place Search. A Radius Filter is `centre` plus
 * `radiusMetres` (both or neither, AC-49); an Area Filter is `area`; never both (decision R-B,
 * AC-48). `tags` is the Tag Filter (any one of the titles, Present links only, Q4); `limit`
 * the Result Limit (default 20); `mode` the Search Mode (default `exact`). Unknown keys are
 * refused (AC-55). Values are never changed by the schema: the Query Text is trimmed only when
 * sent (AC-3), Tag titles only when matched.
 */
export const SearchRequestSchema = z
  .strictObject({
    queryText: QueryTextSchema,
    centre: LatLonSchema.exactOptional(),
    radiusMetres: z.number().positive().max(MAX_RADIUS_METRES).exactOptional(),
    area: AreaFilterSchema.exactOptional(),
    tags: TagFilterSchema.exactOptional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).exactOptional(),
    mode: SearchModeSchema.exactOptional(),
  })
  .superRefine((request, ctx) => {
    const hasCentre = request.centre !== undefined;
    const hasRadius = request.radiusMetres !== undefined;
    if ((hasCentre || hasRadius) && request.area !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [SEARCH_PARAMETERS.spatialFilter],
        message:
          'give either a Radius Filter (centre and radiusMetres) or an Area Filter, not both',
      });
    } else if (hasCentre && !hasRadius) {
      ctx.addIssue({
        code: 'custom',
        path: [SEARCH_PARAMETERS.radiusMetres],
        message: 'a Search Centre needs a Radius',
      });
    } else if (hasRadius && !hasCentre) {
      ctx.addIssue({
        code: 'custom',
        path: [SEARCH_PARAMETERS.centre],
        message: 'a Radius needs a Search Centre',
      });
    }
  });
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/**
 * The same shape without the value rules: what the Search Command built from its arguments
 * before Place Search checked it (AC-41, AC-43). Numbers are finite (the command refuses text
 * that is not a number as a usage error, AC-44).
 */
export const SearchRequestDraftSchema = z.strictObject({
  queryText: z.string(),
  centre: z.strictObject({ lat: z.number(), lon: z.number() }).exactOptional(),
  radiusMetres: z.number().exactOptional(),
  area: z
    .strictObject({ south: z.number(), west: z.number(), north: z.number(), east: z.number() })
    .exactOptional(),
  tags: z.array(z.string()).exactOptional(),
  limit: z.number().exactOptional(),
  mode: SearchModeSchema.exactOptional(),
});
export type SearchRequestDraft = z.infer<typeof SearchRequestDraftSchema>;

export function effectiveLimit(request: Pick<SearchRequest, 'limit'>): number {
  return request.limit ?? DEFAULT_RESULT_LIMIT;
}

export function effectiveMode(request: Pick<SearchRequest, 'mode'>): SearchMode {
  return request.mode ?? DEFAULT_SEARCH_MODE;
}

export function hasRadiusFilter(
  request: Pick<SearchRequest, 'centre' | 'radiusMetres'>,
): request is SearchRequest & { centre: LatLon; radiusMetres: number } {
  return request.centre !== undefined && request.radiusMetres !== undefined;
}

// ---------------------------------------------------------------------------
// Embedding Service seam (query side)
// ---------------------------------------------------------------------------

/**
 * The one Embedding Request of a valid search (AC-2, AC-3): exactly the trimmed Query Text,
 * model `voyage-4`, Document Kind `query`, output dimension 1024. `truncation` may only be left
 * out or `true` (Voyage's default).
 */
export const QueryEmbeddingRequestSchema = z.strictObject({
  input: z.tuple([z.string().min(1)]),
  model: z.literal(EMBEDDING_MODEL),
  inputType: z.literal(QUERY_INPUT_TYPE),
  outputDimension: z.literal(EMBEDDING_DIMENSIONS),
  truncation: z.literal(true).exactOptional(),
});
export type QueryEmbeddingRequest = z.infer<typeof QueryEmbeddingRequestSchema>;

/**
 * The Embedding Service as Place Search uses it. `embed` resolves with the raw, untrusted
 * answer (checked with `findEmbeddingAnswerIssues(answer, 1)`: exactly one Embedding of 1024
 * finite numbers, `model` absent or `voyage-4`, AC-57, AC-58) or throws / rejects with an error
 * classified by `classifyEmbeddingServiceError` (AC-57). Structurally satisfied by
 * `VoyageAIClient` of `voyageai`.
 */
export interface QueryEmbeddingService {
  embed(request: QueryEmbeddingRequest): Promise<unknown>;
}

/**
 * Collaborators of one search.
 * - `connectionString`: the database holding the Place Store and the Embedding Records. An
 *   unreachable one is Store Unavailable (AC-59). Each call releases what it opened before it
 *   resolves (a long-lived pool for the Stage 3 API is a later contract).
 * - `apiKey`: VOYAGE_API_KEY; absent, empty or only spacing = Missing Key (AC-56), also when
 *   `embeddingService` is given.
 * - `embeddingService`: defaults to Voyage (`voyageai`) built with `apiKey`; tests always
 *   inject a Simulated Embedding Service (AC-61).
 */
export interface SearchDependencies {
  connectionString: string;
  apiKey?: string | undefined;
  embeddingService?: QueryEmbeddingService;
}

// ---------------------------------------------------------------------------
// Search Results and Search Outcome (AC-1, AC-9, AC-14, AC-21, AC-35 .. AC-38, AC-66 .. AC-68)
// ---------------------------------------------------------------------------

/**
 * One Search Result (glossary, AC-35):
 * - `wikimapiaUrl`: the stored Wikimapia Link as is (Listing Link or Built Link, decision Q1);
 *   it always points to this Place (licensing, attribution).
 * - `tags`: Result Tag Titles, the Present Tags in Place Store read-back order (AC-36, AC-37).
 * - `centre`: the Centre Point, latitude first.
 * - `distanceMetres`: only with a Radius Filter (AC-21); the WGS 84 surface distance from the
 *   Search Centre to the Centre Point, not rounded (the value Place Search compared with the
 *   Radius, AC-16), within 1 m of the true distance (AC-14).
 * - `similarity`: cosine similarity with the Query Embedding, -1 .. 1, within 0.000001 of the
 *   true value in either Search Mode (AC-1, AC-66).
 */
export const SearchResultSchema = z
  .strictObject({
    placeId: PlaceIdSchema,
    name: z.string(),
    wikimapiaUrl: z.string().min(1),
    tags: z.array(z.string()),
    centre: LatLonSchema,
    distanceMetres: z.number().nonnegative().exactOptional(),
    similarity: z.number().min(-1).max(1),
  })
  .refine((r) => isWikimapiaPlaceUrl(r.wikimapiaUrl, r.placeId), {
    message: 'wikimapiaUrl must link to this place',
    path: ['wikimapiaUrl'],
  });
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** Glossary "Ranking Order": descending Similarity Score, then ascending Place ID. */
export function compareRankingOrder(
  a: Pick<SearchResult, 'similarity' | 'placeId'>,
  b: Pick<SearchResult, 'similarity' | 'placeId'>,
): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity;
  return a.placeId - b.placeId;
}

/** True when every Place appears once and the list is in Ranking Order (AC-9, AC-66, AC-67). */
export function isInRankingOrder(
  results: readonly Pick<SearchResult, 'similarity' | 'placeId'>[],
): boolean {
  return results.every((r, i) => {
    const previous = results[i - 1];
    return previous === undefined || compareRankingOrder(previous, r) < 0;
  });
}

/**
 * The Search Failures (glossary). Messages never contain a key value, a password or a
 * connection string (AC-60).
 * - `invalid_request`: `parameter` names the offending parameter (SEARCH_PARAMETERS, or the
 *   unknown key itself, AC-55).
 * - `missing_key`: the message names VOYAGE_API_KEY (AC-56).
 * - `query_embedding_failed`: `embeddingFailure` is the kind (AC-57, AC-58).
 * - `store_unavailable`: the Place Store could not be reached or could not complete (AC-59).
 */
export const InvalidSearchRequestFailureSchema = z.strictObject({
  kind: z.literal('invalid_request'),
  parameter: z.string().min(1),
  message: z.string().min(1),
});
export type InvalidSearchRequestFailure = z.infer<typeof InvalidSearchRequestFailureSchema>;

export const SearchFailureSchema = z.discriminatedUnion('kind', [
  InvalidSearchRequestFailureSchema,
  z
    .strictObject({ kind: z.literal('missing_key'), message: z.string().min(1) })
    .refine((f) => f.message.includes(VOYAGE_API_KEY_ENV), {
      message: `a Missing Key failure names ${VOYAGE_API_KEY_ENV}`,
      path: ['message'],
    }),
  z.strictObject({
    kind: z.literal('query_embedding_failed'),
    embeddingFailure: EmbeddingFailureKindSchema,
    message: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('store_unavailable'), message: z.string().min(1) }),
]);
export type SearchFailure = z.infer<typeof SearchFailureSchema>;
export type SearchFailureKind = SearchFailure['kind'];

/**
 * Search Outcome (glossary, rule 6): a list of Search Results (possibly empty; at most 50, each
 * Place once, in Ranking Order) or exactly one Search Failure, never both.
 */
export const SearchOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    results: z.array(SearchResultSchema).max(MAX_RESULT_LIMIT).refine(isInRankingOrder, {
      message: 'results are in Ranking Order and each Place appears once',
    }),
  }),
  z.strictObject({ ok: z.literal(false), failure: SearchFailureSchema }),
]);
export type SearchOutcome = z.infer<typeof SearchOutcomeSchema>;

/**
 * Place Search, exported as `searchPlaces` from `src/search/search-places.ts`. The request is
 * typed but re-validated at runtime (anything else is an Invalid Search Request). Never rejects.
 */
export type SearchPlacesFn = (
  request: SearchRequest,
  deps: SearchDependencies,
) => Promise<SearchOutcome>;

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

export type SearchRequestCheck =
  { ok: true; request: SearchRequest } | { ok: false; failure: InvalidSearchRequestFailure };

/**
 * Validates an untrusted Search Request and names the offending parameter (section 3.7): the
 * first top-level key of the first issue, the unknown key itself for an unknown key (AC-55),
 * `spatialFilter` for both filters (AC-48), the missing part of a Radius Filter (AC-49),
 * `request` when the value is not an object.
 */
export function checkSearchRequest(input: unknown): SearchRequestCheck {
  const parsed = SearchRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, request: parsed.data };
  const issue = parsed.error.issues[0];
  let parameter: string = SEARCH_PARAMETERS.request;
  if (issue !== undefined) {
    const top = issue.path[0];
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      parameter = issue.keys[0] ?? parameter;
    } else if (top !== undefined) {
      parameter = String(top);
    }
  }
  return {
    ok: false,
    failure: {
      kind: 'invalid_request',
      parameter,
      message: `invalid ${parameter}: ${issue?.message ?? 'not a Search Request'}`,
    },
  };
}

/**
 * WGS 84 ellipsoid surface distance in metres (Vincenty's inverse formula, accurate to well
 * under a millimetre for the distances searched here). The reference for AC-14 and AC-16.
 */
export function wgs84DistanceMetres(from: LatLon, to: LatLon): number {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const rad = Math.PI / 180;
  const L = (to.lon - from.lon) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(from.lat * rad));
  const U2 = Math.atan((1 - f) * Math.tan(to.lat * rad));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 1;
  let sigma = 0;
  let cos2Alpha = 1;
  let cos2SigmaM = 0;
  for (let i = 0; i < 200; i += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }
  const u2 = (cos2Alpha * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return b * A * (sigma - deltaSigma);
}

/**
 * Pure property check of a result list against the valid request that produced it, for both
 * Search Modes (AC-14, AC-15, AC-21, AC-66, AC-67). Empty when the list keeps every rule:
 * - at most the Result Limit, each Place once, in Ranking Order;
 * - with a Radius Filter every result has a Distance, at most the Radius, within 1 m of the
 *   WGS 84 distance from the Search Centre to its Centre Point;
 * - without one, no result has a Distance.
 * Whether a Place Lies In an Area or carries a Tag needs stored data and is checked by the
 * tests against the Search Set.
 */
export function findResultListIssues(
  request: SearchRequest,
  results: readonly SearchResult[],
): string[] {
  const issues: string[] = [];
  const limit = effectiveLimit(request);
  if (results.length > limit) {
    issues.push(`${String(results.length)} results, above the Result Limit ${String(limit)}`);
  }
  if (!isInRankingOrder(results)) issues.push('not in Ranking Order or a Place repeats');
  for (const r of results) {
    const id = String(r.placeId);
    if (!hasRadiusFilter(request)) {
      if (r.distanceMetres !== undefined) issues.push(`place ${id} has a Distance`);
      continue;
    }
    if (r.distanceMetres === undefined) {
      issues.push(`place ${id} has no Distance`);
      continue;
    }
    if (r.distanceMetres > request.radiusMetres) {
      issues.push(`place ${id} lies outside the Radius`);
    }
    const truth = wgs84DistanceMetres(request.centre, r.centre);
    if (Math.abs(r.distanceMetres - truth) > DISTANCE_TOLERANCE_METRES) {
      issues.push(`place ${id} Distance ${String(r.distanceMetres)} is not ${String(truth)}`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Search Command (AC-41 .. AC-45, AC-71, AC-72)
// ---------------------------------------------------------------------------

/**
 * Command-line form: `pnpm run search "<Query Text>" [options]` (SEARCH_COMMAND_FORM, decision
 * Q11, rule 13); the Query Text is the one
 * positional argument (a leading `--` passed through by pnpm is ignored). Options take their
 * value as the next argument; `--approximate` takes none (`--approximate=yes` is an unknown
 * option, AC-44) and may repeat (AC-71); `--tag` may repeat, in the order given; every other
 * option given twice is a usage error.
 * - `--near <lat>,<lon>`   -> `centre` (latitude first, decision Q2)
 * - `--radius <metres>`    -> `radiusMetres`
 * - `--bbox <south>,<west>,<north>,<east>` -> `area`
 * - `--tag <title>`        -> `tags`
 * - `--limit <n>`          -> `limit`
 * - `--approximate`        -> `mode: 'approximate'` (otherwise Exact)
 * Usage errors (AC-44: no Query Text, an unknown option, `--radius` without `--near` or the
 * reverse, both `--near` and `--bbox`, a value that is not a number where a number is needed,
 * a value given to `--approximate`) end the command with exit code 1 and a usage line (one that
 * passes `isSearchUsageLine`: it starts with `Usage: ` followed by SEARCH_COMMAND_FORM verbatim;
 * an option list may follow), before any call to the Embedding Service. A well-formed command whose
 * values Place Search refuses (e.g. `--radius 0`) is an Invalid Search Request: the failure
 * line names the option (SEARCH_OPTION_FOR_PARAMETER, AC-43).
 */
export const SEARCH_COMMAND_OPTIONS = {
  near: '--near',
  radius: '--radius',
  bbox: '--bbox',
  tag: '--tag',
  limit: '--limit',
  approximate: '--approximate',
} as const;

export const SEARCH_USAGE_PREFIX = 'Usage: pnpm run search';

/**
 * Rule 13, AC-44, AC-72: a usage line of the Search Command starts with SEARCH_USAGE_PREFIX and
 * shows the documented form verbatim: `Usage: pnpm run search "<Query Text>" [options]`, exact
 * case and spacing, optionally followed by more text (e.g. the option list) after a space.
 * Trailing whitespace (e.g. a carriage return from a Windows console) is ignored.
 */
export function isSearchUsageLine(line: string): boolean {
  const usage = `Usage: ${SEARCH_COMMAND_FORM}`;
  const text = line.trimEnd();
  return text === usage || text.startsWith(`${usage} `);
}

/** The command option (or argument) an Invalid Search Request is reported under (AC-43). */
export const SEARCH_OPTION_FOR_PARAMETER: Record<
  Exclude<KnownSearchParameter, 'request'>,
  string
> = {
  queryText: 'query text',
  centre: SEARCH_COMMAND_OPTIONS.near,
  radiusMetres: SEARCH_COMMAND_OPTIONS.radius,
  area: SEARCH_COMMAND_OPTIONS.bbox,
  spatialFilter: `${SEARCH_COMMAND_OPTIONS.near} / ${SEARCH_COMMAND_OPTIONS.bbox}`,
  tags: SEARCH_COMMAND_OPTIONS.tag,
  limit: SEARCH_COMMAND_OPTIONS.limit,
  mode: SEARCH_COMMAND_OPTIONS.approximate,
};

/** Failure kind names printed by the command (AC-43): `Search failed: <label>: <message>`. */
export const SEARCH_FAILURE_LABELS: Record<SearchFailureKind, string> = {
  invalid_request: 'Invalid search request',
  missing_key: 'Missing key',
  query_embedding_failed: 'Query embedding failure',
  store_unavailable: 'Store unavailable',
};

/**
 * Output lines (AC-42, AC-71). A successful search prints, in this order: the mode line; one
 * block (`searchResultBlock`) per Search Result in Ranking Order; `resultCountLine(n)`; the
 * attribution line. An empty result prints the mode line, NO_RESULTS_LINE and the attribution
 * line. Nothing else is printed between them.
 */
export const MODE_LINES: Record<SearchMode, string> = {
  exact: 'Mode: exact',
  approximate: 'Mode: approximate',
};
export const NO_RESULTS_LINE = 'No places found.';
export const ATTRIBUTION_LINE = 'Data: Wikimapia (wikimapia.org), CC BY-NC-SA 3.0';

export function resultCountLine(count: number): string {
  return `Results: ${String(count)}`;
}

/**
 * The block of one Search Result (AC-42): rank (1-based) with Place Name and Place ID, then
 * Wikimapia Link, Result Tag Titles (`(none)` when empty), Centre Point (latitude first), the
 * Distance in whole metres (only when the result has one) and the Similarity Score to 4 places.
 */
export function searchResultBlock(rank: number, result: SearchResult): string[] {
  const lines = [
    `${String(rank)}. ${result.name} (place ${String(result.placeId)})`,
    `   Link: ${result.wikimapiaUrl}`,
    `   Tags: ${result.tags.length === 0 ? '(none)' : result.tags.join(', ')}`,
    `   Centre: ${String(result.centre.lat)}, ${String(result.centre.lon)}`,
  ];
  if (result.distanceMetres !== undefined) {
    lines.push(`   Distance: ${String(Math.round(result.distanceMetres))} m`);
  }
  lines.push(`   Similarity: ${result.similarity.toFixed(4)}`);
  return lines;
}

/**
 * What the command reads and writes. `env` stands for `process.env` (only VOYAGE_API_KEY and
 * DATABASE_URL are read; the script fills it from the environment and `.env`, the environment
 * winning, AC-45). `write` receives every output line. Tests inject the Embedding Service.
 */
export interface SearchCommandIO {
  env: Readonly<Partial<Record<typeof VOYAGE_API_KEY_ENV | typeof DATABASE_URL_ENV, string>>>;
  write: (line: string) => void;
  embeddingService?: QueryEmbeddingService;
}

/**
 * What the command resolves to.
 * - `request`: the Search Request it gave to `searchPlaces` (absent after a usage error).
 * - `outcome`: what `searchPlaces` answered (absent after a usage error).
 * - `exitCode`: 0 exactly when the outcome is a list of Search Results, empty included (AC-43).
 */
export const SearchCommandResultSchema = z
  .strictObject({
    exitCode: z.union([z.literal(0), z.literal(1)]),
    request: SearchRequestDraftSchema.exactOptional(),
    outcome: SearchOutcomeSchema.exactOptional(),
  })
  .refine((r) => r.exitCode === (r.outcome?.ok === true ? 0 : 1), {
    message: 'exit code 0 exactly for a list of Search Results',
    path: ['exitCode'],
  })
  .refine((r) => (r.outcome === undefined) === (r.request === undefined), {
    message: 'an outcome comes with the request that produced it',
    path: ['request'],
  });
export type SearchCommandResult = z.infer<typeof SearchCommandResultSchema>;

/**
 * The Search Command, exported as `runSearchCommand` from `src/search/command.ts`. Runs
 * `searchPlaces` over the Place Store at `env.DATABASE_URL` with `env.VOYAGE_API_KEY`. Never
 * rejects. `scripts.search` of package.json is `tsx <script>` calling it with
 * `process.argv.slice(2)`, the environment and console output, setting
 * `process.exitCode = result.exitCode`.
 */
export type RunSearchCommandFn = (
  argv: readonly string[],
  io: SearchCommandIO,
) => Promise<SearchCommandResult>;
