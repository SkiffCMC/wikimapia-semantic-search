/**
 * One Batch (AL4 embeddings 1.4.4): build the Embedding Request, send it with the Run's retry
 * rule (30 s, then 60 s, on the injected clock), classify failures, validate the answer, map
 * each Embedding to its Place and keep the Batch's Embedding Records before returning.
 *
 * `sendBatch` prints only the "sending" and "retrying" progress lines and never calls
 * `tally.failed`; the scan-and-send loop does the rest (AL4 1.4.2). No error's own message, key,
 * URL or Place Document ever reaches a result message or a progress line.
 */
import {
  DOCUMENT_INPUT_TYPE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_RETRY_WAITS_SECONDS,
  EmbeddingAnswerSchema,
  VOYAGE_API_KEY_ENV,
  classifyEmbeddingServiceError,
  findEmbeddingAnswerIssues,
} from '../../contracts/embeddings.schema';
import type { EmbeddingRecord, EmbeddingServiceRequest } from '../../contracts/embeddings.schema';
import { toMoment } from '../../contracts/hydration.schema';
import type { BatchResult, DueItem, SendContext } from './types';

const TRIES = String(EMBEDDING_RETRY_WAITS_SECONDS.length + 1);
const CONNECTION_REASON = `connection failure after ${TRIES} tries`;
const RATE_LIMITED_MESSAGE = `The Embedding Service kept answering with its rate limit after ${TRIES} tries.`;
const STORE_REJECTED_PREFIX = 'the Place Store rejected the Embedding Records: ';
const RETRY_LABELS = { connection: 'connection failure', rate_limit: 'rate limit' } as const;

/** Read through a call so the check after an await is not narrowed away by TypeScript. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function interrupted(): BatchResult {
  return { kind: 'stopped', stop: { outcome: 'interrupted' } };
}

/** Service Refused stop message; names the HTTP status only, never the error's own text. */
function refusedMessage(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode
      : undefined;
  const http = typeof status === 'number' ? ` (HTTP ${String(status)})` : '';
  return `The Embedding Service refused the request${http}. Check ${VOYAGE_API_KEY_ENV} and the Voyage account.`;
}

/** Validates the answer, maps it to the items and keeps the records (AC-18, AC-26, AC-38). */
async function keepAnswer(
  ctx: SendContext,
  items: readonly DueItem[],
  answer: unknown,
): Promise<BatchResult> {
  const embeddedAt = toMoment(ctx.clock.now());
  const issue = findEmbeddingAnswerIssues(answer, items.length)[0];
  if (issue !== undefined) return { kind: 'failed', failureKind: 'invalid_answer', reason: issue };
  const parsed = EmbeddingAnswerSchema.parse(answer);
  const indexed = parsed.data.some((entry) => entry.index !== undefined);
  const records: EmbeddingRecord[] = [];
  for (const [i, item] of items.entries()) {
    const entry = indexed ? parsed.data.find((e) => e.index === i) : parsed.data[i];
    if (entry === undefined) {
      // Unreachable after the gate above; kept so a missing entry is never stored.
      return {
        kind: 'failed',
        failureKind: 'invalid_answer',
        reason: `no embedding for text ${String(i)}`,
      };
    }
    records.push({
      placeId: item.placeId,
      embedding: entry.embedding,
      model: EMBEDDING_MODEL,
      documentFingerprint: item.fingerprint,
      embeddedAt,
    });
  }
  const saved = await ctx.store.saveEmbeddingRecords({ records });
  if (saved.ok) {
    const tokens = parsed.usage.totalTokens;
    ctx.tally.embedded(items.length, tokens);
    return { kind: 'kept', tokens };
  }
  const { failure } = saved;
  if (failure.kind === 'invalid_data') {
    return {
      kind: 'failed',
      failureKind: 'invalid_data',
      reason: `${STORE_REJECTED_PREFIX}${failure.message}`,
    };
  }
  return { kind: 'stopped', stop: { outcome: 'failed', message: failure.message } };
}

export async function sendBatch(ctx: SendContext, items: readonly DueItem[]): Promise<BatchResult> {
  const { service, clock, signal, tally, progress } = ctx;
  const label = `Batch ${String(ctx.batchNumber)}`;
  const request: EmbeddingServiceRequest = {
    input: items.map((item) => item.document),
    model: EMBEDDING_MODEL,
    inputType: DOCUMENT_INPUT_TYPE,
    outputDimension: EMBEDDING_DIMENSIONS,
    truncation: true,
  };
  tally.batch();
  progress(`${label}: sending ${String(items.length)} places`);
  for (let attempt = 0; ; attempt += 1) {
    tally.request();
    let answer: unknown;
    try {
      // Through `then`, so a synchronous throw of `embed` is caught like a rejection.
      answer = await Promise.resolve().then(() => service.embed(request));
    } catch (error) {
      const kind = classifyEmbeddingServiceError(error);
      if (kind === 'refused') {
        return { kind: 'stopped', stop: { outcome: 'failed', message: refusedMessage(error) } };
      }
      const wait = EMBEDDING_RETRY_WAITS_SECONDS[attempt];
      if (wait === undefined) {
        return kind === 'connection'
          ? { kind: 'failed', failureKind: 'connection', reason: CONNECTION_REASON }
          : { kind: 'stopped', stop: { outcome: 'rate_limited', message: RATE_LIMITED_MESSAGE } };
      }
      if (isAborted(signal)) return interrupted();
      progress(`${label}: ${RETRY_LABELS[kind]}, retrying in ${String(wait)} s`);
      await clock.sleep(wait * 1000);
      if (isAborted(signal)) return interrupted();
      continue;
    }
    return keepAnswer(ctx, items, answer);
  }
}
