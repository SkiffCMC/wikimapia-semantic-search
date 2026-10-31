/**
 * The production Embedding Services over the `voyageai` SDK: the document adapter of the
 * Embedding Run (AL4 embeddings 1.4.6, section 3) and the query adapter of Place Search
 * (AL4 hybrid-search 1.4.1). Both share one private client setup.
 *
 * The SDK is loaded lazily inside the factories, so a Run, a search or a test that injects its
 * own service never loads it. The SDK's own retries are turned off on every call (the Run's 30 s / 60 s
 * retries are the only ones; a search never retries) and every call has a timeout. Errors are rethrown unchanged so
 * `classifyEmbeddingServiceError` sees their `statusCode`; the adapter never logs, never reads
 * the environment and never builds a message of its own.
 */
import type { EmbeddingService } from '../../contracts/embeddings.schema';
import type { QueryEmbeddingService } from '../../contracts/hybrid-search.schema';
import type { VoyageEmbedRequest, VoyageServiceOptions } from './types';

/** Seconds one request may take before it counts as a Connection Failure (AL4 section 3). */
const DEFAULT_TIMEOUT_SECONDS = 120;

/** The numeric `statusCode` a caught error carries, if any. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const status = error.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Adds `usage.totalTokens` from a numeric `usage.total_tokens` when `totalTokens` is absent,
 * as a copy; anything else is returned as it came. Never mutates its input.
 */
export function normaliseVoyageAnswer(answer: unknown): unknown {
  if (typeof answer !== 'object' || answer === null || !('usage' in answer)) return answer;
  const usage = answer.usage;
  if (typeof usage !== 'object' || usage === null) return answer;
  if ('totalTokens' in usage || !('total_tokens' in usage)) return answer;
  const total = usage.total_tokens;
  if (typeof total !== 'number') return answer;
  return { ...answer, usage: { ...usage, totalTokens: total } };
}

/**
 * Loads the SDK lazily, builds the client and returns the one call both adapters share: SDK
 * retries off, a per-call timeout, `truncation` only when the request carries it, the answer
 * normalised, a 2xx error read as an unreadable answer and every other error rethrown unchanged.
 */
async function openVoyageEmbed(
  options: VoyageServiceOptions,
): Promise<(request: VoyageEmbedRequest) => Promise<unknown>> {
  const { VoyageAIClient } = await import('voyageai');
  const client = new VoyageAIClient({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  const timeoutInSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  return async (request) => {
    try {
      const answer = await client.embed(
        {
          input: request.input,
          model: request.model,
          inputType: request.inputType,
          outputDimension: request.outputDimension,
          ...(request.truncation === undefined ? {} : { truncation: request.truncation }),
        },
        { maxRetries: 0, timeoutInSeconds },
      );
      return normaliseVoyageAnswer(answer);
    } catch (error) {
      // An unreadable 2xx body is an Invalid Embedding Answer downstream, not Service Refused.
      const status = statusCodeOf(error);
      if (status !== undefined && status >= 200 && status <= 299) return undefined;
      throw error;
    }
  };
}

/** The document-side Embedding Service of the Embedding Run (AL4 embeddings 1.4.6). */
export async function createVoyageEmbeddingService(
  options: VoyageServiceOptions,
): Promise<EmbeddingService> {
  return { embed: await openVoyageEmbed(options) };
}

/**
 * The query-side Embedding Service of Place Search (AL4 hybrid-search 1.4.1). Place Search
 * passes `timeoutSeconds: QUERY_EMBEDDING_TIMEOUT_SECONDS`; without it the timeout is 120 s.
 */
export async function createVoyageQueryEmbeddingService(
  options: VoyageServiceOptions,
): Promise<QueryEmbeddingService> {
  return { embed: await openVoyageEmbed(options) };
}
