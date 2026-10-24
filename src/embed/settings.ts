/**
 * Settings, key and messages of the Embedding Run (AL4 embeddings 1.4.5; AC-40, AC-41). Pure.
 * Only Zod paths and messages go into a failure message, never an input value.
 */
import type { z } from 'zod';
import {
  DEFAULT_BATCH_TOKEN_LIMIT,
  DEFAULT_EMBEDDING_LIMIT,
  EMBEDDING_SETTING_KEYS,
  EMBED_COMMAND_OPTIONS,
  EmbeddingRunRequestSchema,
  EmbeddingSettingsSchema,
  VOYAGE_API_KEY_ENV,
} from '../../contracts/embeddings.schema';
import type { EmbeddingRunRequest } from '../../contracts/embeddings.schema';
import { formatIssuePath, toFailureIssues } from '../wikimapia/issues';
import type { Resolution } from './types';

export const MISSING_KEY_MESSAGE = `Embedding Service key is missing: set ${VOYAGE_API_KEY_ENV}.`;

export function usageMessage(): string {
  return `Usage: pnpm embed [${EMBED_COMMAND_OPTIONS.limit} <n>]`;
}

export function isMissingApiKey(apiKey: string | undefined): boolean {
  return apiKey === undefined || apiKey.trim() === '';
}

function settingKeyOf(element: string | number | undefined): string | undefined {
  return EMBEDDING_SETTING_KEYS.find((key) => key === element);
}

/** Message of the first issue only. */
function settingMessage(issues: readonly z.core.$ZodIssue[]): string {
  const [first] = toFailureIssues(issues);
  if (first === undefined) return 'Invalid embedding request';
  const key = settingKeyOf(first.path[0]);
  if (key !== undefined) return `Invalid embedding setting "${key}": ${first.message}`;
  return `Invalid embedding request: ${formatIssuePath(first.path)}: ${first.message}`;
}

export function resolveSettings(
  request: EmbeddingRunRequest,
  batchTokenLimit: number | undefined,
): Resolution {
  const r = EmbeddingRunRequestSchema.safeParse(request);
  if (!r.success) return { ok: false, message: settingMessage(r.error.issues) };
  const candidate = {
    embeddingLimit: r.data.embeddingLimit ?? DEFAULT_EMBEDDING_LIMIT,
    batchTokenLimit: batchTokenLimit ?? DEFAULT_BATCH_TOKEN_LIMIT,
  };
  const s = EmbeddingSettingsSchema.safeParse(candidate);
  if (!s.success) return { ok: false, message: settingMessage(s.error.issues) };
  return { ok: true, settings: s.data };
}
