/**
 * The production Embedding Service over the `voyageai` SDK (AL4 embeddings 1.4.6, section 3).
 *
 * The SDK is loaded lazily inside the factory, so a Run or a test that injects its own service
 * never loads it. The SDK's own retries are turned off on every call (the Run's 30 s / 60 s
 * retries are the only ones) and every call has a timeout. Errors are rethrown unchanged so
 * `classifyEmbeddingServiceError` sees their `statusCode`; the adapter never logs, never reads
 * the environment and never builds a message of its own.
 */
import type { EmbeddingService } from '../../contracts/embeddings.schema';
import type { VoyageServiceOptions } from './types';

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

export async function createVoyageEmbeddingService(
  options: VoyageServiceOptions,
): Promise<EmbeddingService> {
  const { VoyageAIClient } = await import('voyageai');
  const client = new VoyageAIClient({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  const timeoutInSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  return {
    embed: async (request) => {
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
    },
  };
}
