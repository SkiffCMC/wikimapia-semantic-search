/**
 * AL5 CONTRACT SUPPORT: Simulated Embedding Service, synthetic Places and helpers for the
 * `embeddings` contracts.
 *
 * Layer:    AL5 (Contracts). Not part of the subject under test.
 * Derives:  docs/al6-requirements/20261023-embeddings-al6.md (glossary "Simulated Embedding
 *           Service"; section 3 preamble: deterministic fake Embeddings of 1024 numbers, stated
 *           token counts, Simulated Clock, Test Database, dummy VOYAGE_API_KEY, "Synthetic
 *           Place K"; AC-59 .. AC-62)
 * Enforces: .agrules section 4 (no live Voyage, Anthropic or Wikimapia calls, synthetic keys
 *           only, small synthetic data, recorded fixtures only from contracts/fixtures/wikimapia/).
 *
 * Only the injected collaborators are doubled here (the Embedding Service and the clock). The
 * Embedding Run, the Place Document builder, the Embedding Store and the Place Store are always
 * the real ones.
 */
import { createHash } from 'node:crypto';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type EmbeddingService,
  type EmbeddingServiceRequest,
} from './embeddings.schema';
import { SimulatedCrawlClock } from './hydration.support';
import { buildWikimapiaLink, DetailedPlaceSchema } from './storage.schema';
import type { DetailedPlace, StoredComment, StoredTag } from './storage.schema';
import { FETCHED_AT, clientDetails, rehome } from './storage.support';
import type { Comment, Location, PlaceDetails, Tag } from './wikimapia-client.schema';

export { SimulatedCrawlClock as SimulatedEmbeddingClock } from './hydration.support';
export { RUN_START, SECOND, MINUTE, HOUR, iso, settle } from './hydration.support';

/** Synthetic Voyage key. Not a real key; must never appear in any output (AC-51, AC-60). */
export const TEST_VOYAGE_API_KEY = 'pa-test-voyage-key-0000-synthetic';

// ---------------------------------------------------------------------------
// Deterministic fake Embeddings
// ---------------------------------------------------------------------------

/**
 * A deterministic fake Embedding for `text`: 1024 numbers k/256 with k in -128 .. 127, derived
 * from the SHA-256 of the text. Every value is exactly representable as a 32-bit float, so it
 * reads back from `vector(1024)` unchanged. Different texts give different Embeddings.
 */
export function fakeEmbedding(text: string): number[] {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => {
    const byte = (digest[i % digest.length] ?? 0) ^ ((i * 37) & 0xff);
    return (byte - 128) / 256;
  });
}

/** A fake Embedding of the given length (for AC-38, AC-39). */
export function fakeVector(length: number, seed = 'wrong length'): number[] {
  const base = fakeEmbedding(seed);
  return Array.from({ length }, (_, i) => base[i % base.length] ?? 0);
}

/** A readable answer (the `voyageai` shape) for the given texts, in order, with indexes. */
export function normalAnswer(texts: readonly string[], totalTokens: number, withIndex = true) {
  return {
    object: 'list',
    data: texts.map((text, index) => ({
      object: 'embedding',
      embedding: fakeEmbedding(text),
      ...(withIndex ? { index } : {}),
    })),
    model: EMBEDDING_MODEL,
    usage: { totalTokens },
  };
}

// ---------------------------------------------------------------------------
// Errors as the `voyageai` package throws them (numeric statusCode) and network errors
// ---------------------------------------------------------------------------

/** An error with a numeric `statusCode`, like `VoyageAIError`. The message carries the key. */
export class SimulatedServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SimulatedServiceError';
  }
}

/** Service Rate Limit (HTTP 429). */
export function rateLimitError(): SimulatedServiceError {
  return new SimulatedServiceError(429, 'Status code: 429 Too Many Requests: rate limit exceeded');
}

/** Service Refused (HTTP 401), with the key in the message as some SDK errors include it. */
export function refusedError(): SimulatedServiceError {
  return new SimulatedServiceError(
    401,
    `Status code: 401 Provided API key is invalid: Authorization: Bearer ${TEST_VOYAGE_API_KEY}`,
  );
}

/** Temporarily unavailable (HTTP 503): a Connection Failure. */
export function unavailableError(): SimulatedServiceError {
  return new SimulatedServiceError(503, 'Status code: 503 Service Unavailable');
}

/** No answer at all (no statusCode), with the key in the message. */
export function connectionError(): Error {
  return new Error(
    `fetch failed: connect ECONNREFUSED api.voyageai.com:443 (Authorization: Bearer ${TEST_VOYAGE_API_KEY})`,
  );
}

// ---------------------------------------------------------------------------
// Simulated Embedding Service
// ---------------------------------------------------------------------------

/** One Embedding Request as the Simulated Embedding Service saw it. */
export interface EmbeddingCall {
  readonly index: number;
  /** Simulated Clock reading when the request started. */
  readonly startedAtMs: number;
  /** Simulated Clock reading when it was answered (or failed); set when it settles. */
  answeredAtMs?: number;
  /** A copy of the request exactly as sent. */
  readonly request: EmbeddingServiceRequest;
  /** 1 for the first request with the same `input` list, 2 for the next, ... */
  readonly attempt: number;
}

/** Release valve for a request that should hang until the test says so (AC-43, AC-44). */
export class ServiceGate {
  private release: ((answer: ServiceAnswer) => void) | undefined;
  private markReached: (() => void) | undefined;
  readonly reached: Promise<void>;
  private readonly pending: Promise<ServiceAnswer>;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.markReached = resolve;
    });
    this.pending = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  wait(): Promise<ServiceAnswer> {
    this.markReached?.();
    return this.pending;
  }

  open(answerWith: ServiceAnswer): void {
    this.release?.(answerWith);
  }
}

/**
 * One prepared answer: the normal answer for the request (fake Embeddings, stated tokens), a
 * raw answer value, a thrown error, an answer that takes `delayMs` of Simulated Clock time, a
 * gated answer, or a side effect run when the request arrives before answering.
 */
export type ServiceAnswer =
  | { readonly normal: true; readonly tokens?: number }
  | { readonly raw: unknown }
  | { readonly error: unknown }
  | { readonly delayMs: number; readonly then: ServiceAnswer }
  | { readonly gate: ServiceGate }
  | {
      readonly effect: (call: EmbeddingCall) => void | Promise<void>;
      readonly then: ServiceAnswer;
    };

export const NORMAL: ServiceAnswer = { normal: true };

export function normal(tokens?: number): ServiceAnswer {
  return tokens === undefined ? NORMAL : { normal: true, tokens };
}

export function raw(value: unknown): ServiceAnswer {
  return { raw: value };
}

export function fail(error: unknown): ServiceAnswer {
  return { error };
}

export type ServiceResponder = (call: EmbeddingCall) => ServiceAnswer;

/**
 * Simulated Embedding Service (AL6 glossary): records every request with the Simulated Clock
 * reading, answers through the test's responder (default: the normal answer) and never touches
 * the network. Default token count per request: `tokensPerRequest` (10).
 */
export class SimulatedEmbeddingService implements EmbeddingService {
  readonly calls: EmbeddingCall[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly clock: SimulatedCrawlClock,
    private readonly responder: ServiceResponder = () => NORMAL,
    private readonly tokensPerRequest = 10,
  ) {}

  embed(request: EmbeddingServiceRequest): Promise<unknown> {
    const copy: EmbeddingServiceRequest = structuredClone(request);
    const key = JSON.stringify(copy.input);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const call: EmbeddingCall = {
      index: this.calls.length,
      startedAtMs: this.clock.nowMilliseconds,
      request: copy,
      attempt,
    };
    this.calls.push(call);
    return this.deliver(call, this.responder(call)).finally(() => {
      call.answeredAtMs = this.clock.nowMilliseconds;
    });
  }

  private async deliver(call: EmbeddingCall, prepared: ServiceAnswer): Promise<unknown> {
    if ('normal' in prepared) {
      return normalAnswer(call.request.input, prepared.tokens ?? this.tokensPerRequest);
    }
    if ('raw' in prepared) return structuredClone(prepared.raw);
    if ('error' in prepared) throw prepared.error;
    if ('delayMs' in prepared) {
      this.clock.advance(prepared.delayMs);
      return this.deliver(call, prepared.then);
    }
    if ('gate' in prepared) return this.deliver(call, await prepared.gate.wait());
    await prepared.effect(call);
    return this.deliver(call, prepared.then);
  }

  /** The `input` lists of every request, in order (retries repeat a list). */
  get inputs(): string[][] {
    return this.calls.map((c) => [...c.request.input]);
  }

  /** Every text sent, in order (retries repeat texts). */
  get texts(): string[] {
    return this.inputs.flat();
  }
}

/** Answers by attempt for one Batch: a single answer for every attempt, or one per attempt (last repeats). */
export function byAttempt(...answers: ServiceAnswer[]): (call: EmbeddingCall) => ServiceAnswer {
  return (call) => {
    const chosen = answers[Math.min(call.attempt, answers.length) - 1];
    if (chosen === undefined) throw new Error('empty answer list');
    return chosen;
  };
}

/** True when the request holds a Place Document whose first line is `name`. */
export function holdsPlace(call: EmbeddingCall, name: string): boolean {
  return call.request.input.some((text) => text.split('\n')[0] === name);
}

// ---------------------------------------------------------------------------
// Synthetic Places (client shapes, saved through the real Place Store)
// ---------------------------------------------------------------------------

export { FETCHED_AT, LATER_FETCHED_AT, EVEN_LATER_FETCHED_AT } from './storage.support';

/** Default Tag of synthetic Places; its id is not used by any recorded fixture. */
export const SYNTHETIC_TAG: Tag = { id: 99001, title: 'synthetic tag' };

/** Name of synthetic Place n (first line of its Place Document). */
export function syntheticName(placeId: number): string {
  return `Synthetic place ${String(placeId)}`;
}

/** A Comment with the field values of the recorded "Mateja" (62587 #1), re-homed. */
export async function baseComment(): Promise<Comment> {
  const square = await clientDetails('getbyid-62587.json');
  const first = square.comments[0];
  if (first === undefined) throw new Error('getbyid-62587.json has no comment');
  return { ...first, replies: [] };
}

export interface CommentSpec {
  num: number;
  message: string;
  isDeleted?: boolean;
  isBlocked?: boolean;
  goodVotes?: number;
  replies?: CommentSpec[];
}

/** Comments of `placeId` from compact specs, field values from `base`. */
export function commentsFrom(
  base: Comment,
  placeId: number,
  specs: readonly CommentSpec[],
): Comment[] {
  return specs.map((spec) => ({
    ...rehome(base, placeId, spec.num, commentsFrom(base, placeId, spec.replies ?? [])),
    message: spec.message,
    isDeleted: spec.isDeleted ?? false,
    isBlocked: spec.isBlocked ?? false,
    goodVotes: spec.goodVotes ?? base.goodVotes,
  }));
}

/** Location of a synthetic Place: central Belgrade point, address items as given. */
export function locationWith(
  address: Partial<
    Pick<Location, 'street' | 'houseNumber' | 'city' | 'place' | 'state' | 'country'>
  >,
): Location {
  const lon = 20.457;
  const lat = 44.817;
  return { lon, lat, north: lat, south: lat, east: lon, west: lon, ...address };
}

export interface SyntheticSpec {
  title?: string;
  description?: string;
  tags?: Tag[];
  comments?: CommentSpec[];
  address?: Parameters<typeof locationWith>[0];
  isDeleted?: boolean;
  wikipediaUrl?: string;
}

/**
 * Synthetic Place Details for `placeId`, built from the Client's reading of the recorded
 * `getbyid-1381893.json` by the smallest change: id, title, description, Tags, Comments and
 * location replaced, no outline, no parent.
 */
export async function syntheticDetails(
  placeId: number,
  spec: SyntheticSpec = {},
): Promise<PlaceDetails> {
  const base = await clientDetails('getbyid-1381893.json');
  const comment = await baseComment();
  const details: PlaceDetails = {
    placeId,
    title: spec.title ?? syntheticName(placeId),
    description: spec.description ?? `Synthetic description ${String(placeId)}.`,
    tags: spec.tags ?? [SYNTHETIC_TAG],
    isBuilding: base.isBuilding,
    isRegion: base.isRegion,
    isDeleted: spec.isDeleted ?? false,
    outline: [],
    location: locationWith(spec.address ?? { city: 'Belgrade', country: 'Serbia' }),
    comments: commentsFrom(comment, placeId, spec.comments ?? []),
  };
  if (spec.wikipediaUrl !== undefined) details.wikipediaUrl = spec.wikipediaUrl;
  return details;
}

// ---------------------------------------------------------------------------
// Synthetic Place K (AL6 section 3 preamble)
// ---------------------------------------------------------------------------

export const PLACE_K_ID = 900;
export const K_TAGS = {
  park: { id: 9001, title: 'park' },
  fortress: { id: 9002, title: 'fortress' },
  garden: { id: 9003, title: 'garden' },
} as const;
export const K_DESCRIPTION = 'Old fortress park.\nSee http://example.org/kalemegdan for more.';
export const K_ADDRESS = {
  street: 'Bulevar vojvode Bojovića',
  city: 'Belgrade',
  place: 'Belgrade',
  country: 'Serbia',
} as const;

/** AC-1: the exact Place Document of Synthetic Place K. */
export const K_DOCUMENT = [
  'Kalemegdan Park',
  'Tags: park, fortress',
  'Address: Bulevar vojvode Bojovića, Belgrade, Serbia',
  'Description: Old fortress park. See for more.',
  'Comment: Great sunsets',
  'Comment: Agreed!',
].join('\n');

const K_COMMENT_1: CommentSpec = {
  num: 1,
  message: 'Great sunsets',
  replies: [{ num: 2, message: 'Agreed!' }],
};
const K_COMMENT_3: CommentSpec = { num: 3, message: 'Old text' };
const K_COMMENT_4: CommentSpec = { num: 4, message: 'Spam here', isDeleted: true };

/**
 * The two Details Saves that make Synthetic Place K: the first holds Tag "garden" and Comment 3,
 * the second (later) no longer does, so both read back Gone.
 */
export async function placeKSaves(
  change: Partial<SyntheticSpec> = {},
): Promise<[PlaceDetails, PlaceDetails]> {
  const common: SyntheticSpec = {
    title: 'Kalemegdan Park',
    description: K_DESCRIPTION,
    address: { ...K_ADDRESS },
  };
  const first = await syntheticDetails(PLACE_K_ID, {
    ...common,
    tags: [K_TAGS.park, K_TAGS.fortress, K_TAGS.garden],
    comments: [K_COMMENT_1, K_COMMENT_3, K_COMMENT_4],
  });
  const second = await syntheticDetails(PLACE_K_ID, {
    ...common,
    tags: [K_TAGS.park, K_TAGS.fortress],
    comments: [K_COMMENT_1, K_COMMENT_4],
    ...change,
  });
  return [first, second];
}

export { K_COMMENT_1, K_COMMENT_3, K_COMMENT_4 };

// ---------------------------------------------------------------------------
// Detailed Places built directly in the read-back shape (pure Place Document checks)
// ---------------------------------------------------------------------------

export interface StoredCommentSpec {
  num: number;
  message: string;
  presence?: 'present' | 'gone';
  isDeleted?: boolean;
  isBlocked?: boolean;
  replies?: StoredCommentSpec[];
}

export function storedComments(
  placeId: number,
  specs: readonly StoredCommentSpec[],
): StoredComment[] {
  return specs.map((spec) => ({
    placeId,
    num: spec.num,
    langId: 0,
    author: `Author ${String(spec.num)}`,
    authorUserId: 0,
    message: spec.message,
    goodVotes: 0,
    badVotes: 0,
    isBlocked: spec.isBlocked ?? false,
    isDeleted: spec.isDeleted ?? false,
    postedAtEpochSeconds: 1_700_000_000 + spec.num,
    moderatorUserId: 0,
    presence: spec.presence ?? 'present',
    replies: storedComments(placeId, spec.replies ?? []),
  }));
}

export function storedTags(...tags: [string, 'present' | 'gone'][]): StoredTag[] {
  return tags.map(([title, presence], i) => ({ id: 7000 + i, title, presence }));
}

export interface DetailedSpec {
  placeId?: number;
  name?: string;
  description?: string;
  tags?: StoredTag[];
  address?: Parameters<typeof locationWith>[0];
  comments?: StoredCommentSpec[];
  isDeleted?: boolean;
}

/** A Detailed Place exactly in the Place Store's read-back shape, checked with its schema. */
export function detailedPlace(spec: DetailedSpec = {}): DetailedPlace {
  const placeId = spec.placeId ?? 901;
  return DetailedPlaceSchema.parse({
    status: 'detailed',
    placeId,
    name: spec.name ?? 'Test Place',
    wikimapiaUrl: buildWikimapiaLink(placeId),
    description: spec.description ?? '',
    tags: spec.tags ?? [],
    isBuilding: false,
    isRegion: false,
    isDeleted: spec.isDeleted ?? false,
    outline: [],
    location: locationWith(spec.address ?? {}),
    comments: storedComments(placeId, spec.comments ?? []),
    detailsFetchedAt: FETCHED_AT,
  });
}

/** The Parts (lines) of a Place Document. */
export function partsOf(document: string): string[] {
  return document === '' ? [] : document.split('\n');
}
