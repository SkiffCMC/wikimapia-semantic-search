/**
 * Place Search (AL4 hybrid-search 1.2, U4): validation, key check, adapter selection, the one
 * Embedding Request, the search store lifecycle (closed before the call resolves) and the
 * outcome gate. Never rejects; never copies an error's own message into a failure.
 */
import {
  SearchOutcomeSchema,
  checkSearchRequest,
  effectiveLimit,
  effectiveMode,
  hasRadiusFilter,
  normalizeTagTitle,
  queryTextToEmbed,
} from '../../contracts/hybrid-search.schema';
import type {
  QueryEmbeddingService,
  SearchDependencies,
  SearchOutcome,
  SearchPlacesFn,
  SearchRequest,
} from '../../contracts/hybrid-search.schema';
import type { Embedding } from '../../contracts/embeddings.schema';
import { createPlaceSearchStore } from '../db/search-store';
import type { PlaceSearchQuery, PlaceSearchStore } from '../db/types';
import { isMissingApiKey } from '../embed/settings';
import { createVoyageQueryEmbeddingService } from '../embed/voyage-service';
import { INTERNAL_FAILURE, embeddingFailure, missingKeyFailure, storeFailure } from './failures';
import { QUERY_EMBEDDING_TIMEOUT_SECONDS, embedQueryText } from './query-embedding';

const CLIENT_NOT_LOADED_MESSAGE = 'Embedding Service client could not be loaded';
const RESULT_CHECK_MESSAGE = 'Place Store unavailable: search results failed the result check';

/** The injected service, or the Voyage adapter built with the trimmed key; undefined if it fails. */
async function resolveService(
  deps: SearchDependencies,
  apiKey: string,
): Promise<QueryEmbeddingService | undefined> {
  if (deps.embeddingService !== undefined) return deps.embeddingService;
  try {
    return await Promise.resolve().then(() =>
      createVoyageQueryEmbeddingService({
        apiKey: apiKey.trim(),
        timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS,
      }),
    );
  } catch {
    return undefined;
  }
}

/** The search statement input of AL4 1.2 step 5; no `undefined`-valued keys. */
function buildPlaceSearchQuery(r: SearchRequest, queryEmbedding: Embedding): PlaceSearchQuery {
  return {
    queryEmbedding,
    mode: effectiveMode(r),
    limit: effectiveLimit(r),
    ...(hasRadiusFilter(r) ? { radius: { centre: r.centre, radiusMetres: r.radiusMetres } } : {}),
    ...(r.area !== undefined ? { area: r.area } : {}),
    ...(r.tags !== undefined ? { tagTitles: [...new Set(r.tags.map(normalizeTagTitle))] } : {}),
  };
}

async function runSearch(request: SearchRequest, deps: SearchDependencies): Promise<SearchOutcome> {
  const checked = checkSearchRequest(request);
  if (!checked.ok) return { ok: false, failure: checked.failure };
  const r = checked.request;

  const apiKey = deps.apiKey;
  if (apiKey === undefined || isMissingApiKey(apiKey)) {
    return { ok: false, failure: missingKeyFailure() };
  }

  const service = await resolveService(deps, apiKey);
  if (service === undefined) {
    return { ok: false, failure: embeddingFailure('connection', CLIENT_NOT_LOADED_MESSAGE) };
  }

  const embedded = await embedQueryText(service, queryTextToEmbed(r.queryText));
  if (!embedded.ok) return { ok: false, failure: embedded.failure };

  const query = buildPlaceSearchQuery(r, embedded.embedding);

  const searched = await searchAndClose(deps.connectionString, query);
  if (!searched.ok) return { ok: false, failure: storeFailure(searched.failure) };

  const gate = SearchOutcomeSchema.safeParse({ ok: true, results: searched.value });
  if (!gate.success) {
    return { ok: false, failure: storeFailure({ message: RESULT_CHECK_MESSAGE }) };
  }
  return gate.data;
}

/** Opens the search store only now and closes it before resolving (AL4 1.2 step 6, 1.4.8). */
async function searchAndClose(
  connectionString: string,
  query: PlaceSearchQuery,
): ReturnType<PlaceSearchStore['searchMatchingPlaces']> {
  const store = createPlaceSearchStore({ connectionString });
  try {
    return await store.searchMatchingPlaces(query);
  } finally {
    await store.close();
  }
}

/** Place Search (AL4 1.2). Resolves with a Search Outcome; never rejects. */
export const searchPlaces: SearchPlacesFn = async (request, deps) => {
  try {
    return await runSearch(request, deps);
  } catch {
    return { ok: false, failure: INTERNAL_FAILURE };
  }
};
