/**
 * AL5 CONTRACT SUPPORT: test doubles and fixture loaders for the `wikimapia-client` contracts.
 *
 * Layer:    AL5 (Contracts). Not part of the subject under test.
 * Derives:  docs/al6-requirements/20261020-wikimapia-client-al6.md (glossary "Simulated
 *           Wikimapia", "Simulated Clock", "Recorded Response", "Reconstructed Fixture"; AC-38)
 * Enforces: .agrules section 4 (no live network in tests, recorded fixtures without key or
 *           Commenter IPs, synthetic API key only).
 *
 * Only the injected collaborators are doubled here (transport and clock). The client itself
 * is always the real `createWikimapiaClient` from `src/wikimapia/client.ts`.
 */
import { readFileSync } from 'node:fs';
import {
  RawBoxResponseSchema,
  RawPlaceDetailsSchema,
  type Clock,
  type RawBoxResponse,
  type RawComment,
  type RawPlaceDetails,
  type TransportRequest,
  type TransportResponse,
  type WikimapiaTransport,
} from './wikimapia-client.schema.js';

/** Synthetic API Key. Not a real key; must never appear in any failure (AC-36). */
export const TEST_API_KEY = 'wm-test-key-0000-synthetic';

export type FixtureName =
  | 'box-belgrade-page1.json'
  | 'box-belgrade-empty-page.json'
  | 'getbyid-62587.json'
  | 'getbyid-1381893.json'
  | 'getbyid-55.json'
  | 'getbyid-62587-nested-replies.json'
  | 'debug-rate-limit.json'
  | 'debug-error.json';

export const FIXTURE_NAMES: readonly FixtureName[] = [
  'box-belgrade-page1.json',
  'box-belgrade-empty-page.json',
  'getbyid-62587.json',
  'getbyid-1381893.json',
  'getbyid-55.json',
  'getbyid-62587-nested-replies.json',
  'debug-rate-limit.json',
  'debug-error.json',
];

export function fixturePath(name: FixtureName | 'README.md'): URL {
  return new URL(`./fixtures/wikimapia/${name}`, import.meta.url);
}

/** Raw fixture text, exactly as stored. */
export function fixtureText(name: FixtureName | 'README.md'): string {
  return readFileSync(fixturePath(name), 'utf8');
}

/** A fresh, mutable copy of a `place.getbyid` fixture, checked against the wire schema. */
export function rawDetails(name: FixtureName): RawPlaceDetails {
  return RawPlaceDetailsSchema.parse(JSON.parse(fixtureText(name)));
}

/** A fresh, mutable copy of a `box` fixture, checked against the wire schema. */
export function rawBox(name: FixtureName): RawBoxResponse {
  return RawBoxResponseSchema.parse(JSON.parse(fixtureText(name)));
}

/** Element `index` of a list, failing loudly instead of yielding `undefined`. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture has no element at index ${String(index)}`);
  return item;
}

/** A successful HTTP answer carrying `body` (a string is sent as is, anything else as JSON). */
export function answer(body: unknown, status = 200): TransportResponse {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

/** The fixture file as a successful HTTP answer. */
export function fixtureAnswer(name: FixtureName): TransportResponse {
  return answer(fixtureText(name));
}

/**
 * Reconstructed Rate-Limit Response (AC-40): the body quoted in CLAUDE.md with the number of
 * seconds replaced. Pass a non-numeric text (e.g. 'a few') for an unreadable Wait Time.
 */
export function rateLimitAnswer(seconds: number | string): TransportResponse {
  const text = fixtureText('debug-rate-limit.json');
  if (!text.includes('7 seconds')) throw new Error('rate-limit fixture changed unexpectedly');
  return answer(text.replace('7 seconds', `${String(seconds)} seconds`));
}

/** Synthetic Commenter IPs re-added for privacy tests (AC-11, AC-37, AC-45). Not real IPs. */
export const SYNTHETIC_IPS = [1111111111, -2022222222, 1333333333, -1444444444] as const;

/** Re-adds a synthetic `user_ip` to every comment and reply, at every depth, in place. */
export function addCommenterIps(details: RawPlaceDetails): RawPlaceDetails {
  let next = 0;
  const visit = (comments: RawComment[]): void => {
    for (const comment of comments) {
      comment.user_ip = SYNTHETIC_IPS[next % SYNTHETIC_IPS.length];
      next += 1;
      visit(comment.replies);
    }
  };
  visit(details.comments);
  return details;
}

/** One prepared answer: an HTTP response, or "Wikimapia cannot be reached". */
export type SimulatedAnswer = TransportResponse | { readonly unreachable: true };

/**
 * Simulated Wikimapia (AL6 glossary): answers requests from a prepared list, in order, and
 * remembers every request. With `repeatLast`, the last answer is repeated forever.
 * An unreachable answer rejects with an error whose message contains the request address
 * (and therefore the API Key), as real network errors may (AC-36).
 */
export class SimulatedWikimapia {
  readonly requests: TransportRequest[] = [];
  private readonly answers: readonly SimulatedAnswer[];
  private readonly repeatLast: boolean;
  private readonly log: string[] | undefined;

  constructor(
    answers: readonly SimulatedAnswer[],
    options: { repeatLast?: boolean; log?: string[] } = {},
  ) {
    this.answers = answers;
    this.repeatLast = options.repeatLast ?? false;
    this.log = options.log;
  }

  readonly transport: WikimapiaTransport = (request) => {
    const index = this.requests.length;
    this.requests.push(request);
    this.log?.push('request');
    const prepared =
      this.repeatLast && index >= this.answers.length
        ? this.answers[this.answers.length - 1]
        : this.answers[index];
    if (prepared === undefined) {
      return Promise.reject(
        new Error(`Simulated Wikimapia: no answer prepared for #${String(index + 1)}`),
      );
    }
    if ('unreachable' in prepared) {
      return Promise.reject(new Error(`connect ECONNREFUSED while requesting ${request.url}`));
    }
    return Promise.resolve(prepared);
  };

  /** Query parameters of request `index`. */
  params(index: number): URLSearchParams {
    return new URL(at(this.requests, index).url).searchParams;
  }
}

/**
 * Simulated Clock (AL6 glossary): records every wait without real waiting. In `manual` mode a
 * wait only finishes when the test calls `elapseAll()` (AC-30).
 */
export class SimulatedClock implements Clock {
  readonly sleeps: number[] = [];
  private readonly manual: boolean;
  private readonly log: string[] | undefined;
  private pending: (() => void)[] = [];

  constructor(options: { manual?: boolean; log?: string[] } = {}) {
    this.manual = options.manual ?? false;
    this.log = options.log;
  }

  sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.log?.push(`sleep:${String(milliseconds)}`);
    if (!this.manual) return Promise.resolve();
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  get totalMilliseconds(): number {
    return this.sleeps.reduce((sum, ms) => sum + ms, 0);
  }

  get pendingWaits(): number {
    return this.pending.length;
  }

  /** Lets every pending wait finish. */
  elapseAll(): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
  }
}

/** Lets queued promise callbacks and timers of the current turn run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
