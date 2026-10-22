/**
 * AL5 CONTRACT SUPPORT: test doubles, synthetic pages and test Regions for the `hydration`
 * contracts.
 *
 * Layer:    AL5 (Contracts). Not part of the subject under test.
 * Derives:  docs/al6-requirements/20261022-hydration-al6.md (section 3 preamble: Simulated
 *           Wikimapia answering from the recorded fixtures or small synthetic pages, Simulated
 *           Clock, Test Database, dummy API Key, "Region T"; AC-63 .. AC-65)
 * Enforces: .agrules section 4 (no live network, recorded fixtures from
 *           contracts/fixtures/wikimapia/ only, synthetic API key, no bulk data, no Commenter IPs).
 *
 * Only the injected collaborators are doubled here (transport and clock). The Crawl, the Client
 * it builds, the Place Store and the Crawl Store are always the real ones.
 */
import type { CrawlClock, CrawlConfiguration, Region, Tile } from './hydration.schema';
import {
  RawBoxResponseSchema,
  type BoundingBox,
  type RawPlaceDetails,
  type TransportRequest,
  type TransportResponse,
  type WikimapiaTransport,
} from './wikimapia-client.schema';
import {
  answer,
  fixtureAnswer,
  fixtureText,
  rateLimitAnswer,
  rawDetails,
  type FixtureName,
} from './wikimapia-client.support';

export { TEST_API_KEY, SYNTHETIC_IPS, addCommenterIps, at } from './wikimapia-client.support';
export { answer, fixtureAnswer, fixtureText, rateLimitAnswer, rawDetails };

// ---------------------------------------------------------------------------
// Simulated Clock with a readable current moment
// ---------------------------------------------------------------------------

/** The Simulated Clock's default start (AL6 AC-28: 2026-10-22T09:00:00Z). */
export const RUN_START = '2026-10-22T09:00:00Z';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface RecordedSleep {
  readonly atMs: number;
  readonly ms: number;
}

/**
 * Simulated Clock (AL6 glossary): `now()` starts at the given moment and moves only when
 * something sleeps on it (or a test answer calls `advance`). Sleeping never waits for real.
 * `onSleep` is awaited at the start of every sleep, before time moves; tests use it to look at
 * the database "during" a wait (AC-70).
 */
export class SimulatedCrawlClock implements CrawlClock {
  readonly sleeps: RecordedSleep[] = [];
  private nowMs: number;
  private readonly onSleep: ((atMs: number, ms: number) => void | Promise<void>) | undefined;

  constructor(
    start: string | number = RUN_START,
    options: { onSleep?: (atMs: number, ms: number) => void | Promise<void> } = {},
  ) {
    this.nowMs = typeof start === 'number' ? start : Date.parse(start);
    this.onSleep = options.onSleep;
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  get nowMilliseconds(): number {
    return this.nowMs;
  }

  async sleep(milliseconds: number): Promise<void> {
    const ms = Math.max(0, milliseconds);
    this.sleeps.push({ atMs: this.nowMs, ms });
    if (this.onSleep !== undefined) await this.onSleep(this.nowMs, ms);
    this.nowMs += ms;
  }

  /** Lets time pass without a sleep (an answer that takes a while, AC-40). */
  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------------------
// Routed Simulated Wikimapia
// ---------------------------------------------------------------------------

/** One request as Simulated Wikimapia saw it. */
export interface WikimapiaCall {
  readonly index: number;
  /** Simulated Clock reading when the request started. */
  readonly startedAtMs: number;
  readonly fn: 'box' | 'place.getbyid' | 'other';
  readonly url: string;
  readonly bbox?: BoundingBox;
  readonly page?: number;
  readonly count?: number;
  readonly placeId?: number;
  /** 1 for the first request for the same page (bbox + page) or Place, 2 for the next, ... */
  readonly attempt: number;
}

/** Release valve for a request that should hang until the test says so (AC-22, AC-62, AC-69). */
export class Gate {
  private release: ((answer: SimulatedAnswer) => void) | undefined;
  private markReached: (() => void) | undefined;
  readonly reached: Promise<void>;
  private readonly pending: Promise<SimulatedAnswer>;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.markReached = resolve;
    });
    this.pending = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  /** Called by Simulated Wikimapia when the gated request arrives. */
  wait(): Promise<SimulatedAnswer> {
    this.markReached?.();
    return this.pending;
  }

  open(answerWith: SimulatedAnswer): void {
    this.release?.(answerWith);
  }
}

/**
 * One prepared answer: an HTTP response, "Wikimapia cannot be reached" (rejects with a message
 * that contains the request address and therefore the API Key, as real network errors may,
 * AC-49), an answer that takes `delayMs` of Simulated Clock time (AC-40), a gated answer, or a
 * side effect run when the request arrives (e.g. an Operator interrupt, AC-46) before answering.
 */
export type SimulatedAnswer =
  | TransportResponse
  | { readonly unreachable: true }
  | { readonly delayMs: number; readonly then: SimulatedAnswer }
  | { readonly gate: Gate }
  | {
      readonly effect: (call: WikimapiaCall) => void | Promise<void>;
      readonly then: SimulatedAnswer;
    };

export const UNREACHABLE: SimulatedAnswer = { unreachable: true };

export type Responder = (call: WikimapiaCall) => SimulatedAnswer;

function parseBbox(text: string | null): BoundingBox | undefined {
  if (text === null) return undefined;
  const [west, south, east, north] = text.split(',').map(Number);
  if (west === undefined || south === undefined || east === undefined || north === undefined) {
    return undefined;
  }
  return { west, south, east, north };
}

function optionalNumber(text: string | null): number | undefined {
  return text === null ? undefined : Number(text);
}

/**
 * Simulated Wikimapia for the Crawl: every request is parsed, recorded with the Simulated Clock
 * reading at its start and answered by the test's responder. Never contacts the network.
 */
export class CrawlWikimapia {
  readonly calls: WikimapiaCall[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly clock: SimulatedCrawlClock,
    private readonly responder: Responder,
  ) {}

  readonly transport: WikimapiaTransport = (request: TransportRequest) => {
    const url = new URL(request.url);
    const params = url.searchParams;
    const fnText = params.get('function');
    const fn = fnText === 'box' || fnText === 'place.getbyid' ? fnText : 'other';
    const bbox = parseBbox(params.get('bbox'));
    const page = optionalNumber(params.get('page'));
    const count = optionalNumber(params.get('count'));
    const placeId = optionalNumber(params.get('id'));
    const key =
      fn === 'box' ? `box:${params.get('bbox') ?? ''}:${String(page)}` : `${fn}:${String(placeId)}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const call: WikimapiaCall = {
      index: this.calls.length,
      startedAtMs: this.clock.nowMilliseconds,
      fn,
      url: request.url,
      attempt,
      ...(bbox === undefined ? {} : { bbox }),
      ...(page === undefined ? {} : { page }),
      ...(count === undefined ? {} : { count }),
      ...(placeId === undefined ? {} : { placeId }),
    };
    this.calls.push(call);
    return this.deliver(call, this.responder(call));
  };

  private async deliver(
    call: WikimapiaCall,
    prepared: SimulatedAnswer,
  ): Promise<TransportResponse> {
    if ('unreachable' in prepared) {
      throw new Error(`connect ECONNREFUSED while requesting ${call.url}`);
    }
    if ('delayMs' in prepared) {
      this.clock.advance(prepared.delayMs);
      return this.deliver(call, prepared.then);
    }
    if ('gate' in prepared) {
      return this.deliver(call, await prepared.gate.wait());
    }
    if ('effect' in prepared) {
      await prepared.effect(call);
      return this.deliver(call, prepared.then);
    }
    return prepared;
  }

  get listingCalls(): WikimapiaCall[] {
    return this.calls.filter((c) => c.fn === 'box');
  }

  get detailsCalls(): WikimapiaCall[] {
    return this.calls.filter((c) => c.fn === 'place.getbyid');
  }

  /** Place IDs of the details requests, in order (retries repeat the ID). */
  get detailsIds(): number[] {
    return this.detailsCalls.map((c) => c.placeId ?? 0);
  }

  get startTimes(): number[] {
    return this.calls.map((c) => c.startedAtMs);
  }
}

// ---------------------------------------------------------------------------
// Scripted answers by Tile, page and Place
// ---------------------------------------------------------------------------

/** Answers for one page: a single answer for every attempt, or one per attempt (last repeats). */
export type PageScript = SimulatedAnswer | readonly SimulatedAnswer[];

export interface Script {
  /** The Tile Plan the test expects; requests are matched to its Tiles by Bounding Box. */
  tiles: readonly Tile[];
  /** `listing[tileNumber][page - 1]`. Pages not given are answered with an empty page. */
  listing?: Readonly<Record<number, readonly PageScript[]>>;
  /** Details answers by Place ID. Places not given get `syntheticDetailsAnswer(id)`. */
  details?: Readonly<Record<number, PageScript>>;
}

function pick(script: PageScript, attempt: number): SimulatedAnswer {
  if (!Array.isArray(script)) return script as SimulatedAnswer;
  const list = script as readonly SimulatedAnswer[];
  const chosen = list[Math.min(attempt, list.length) - 1];
  if (chosen === undefined) throw new Error('empty answer list');
  return chosen;
}

function sameBbox(a: BoundingBox, b: BoundingBox): boolean {
  const tol = 0.000001;
  return (
    Math.abs(a.west - b.west) <= tol &&
    Math.abs(a.south - b.south) <= tol &&
    Math.abs(a.east - b.east) <= tol &&
    Math.abs(a.north - b.north) <= tol
  );
}

/** Tile Number of the Tile whose Bounding Box was requested (0 if it matches none). */
export function tileNumberOf(tiles: readonly Tile[], bbox: BoundingBox | undefined): number {
  if (bbox === undefined) return 0;
  return tiles.find((t) => sameBbox(t.bbox, bbox))?.tileNumber ?? 0;
}

/** A responder from a script. Requests for an unknown Tile get an Unexpected Response body. */
export function scripted(script: Script): Responder {
  return (call) => {
    if (call.fn === 'box') {
      const tileNumber = tileNumberOf(script.tiles, call.bbox);
      if (tileNumber === 0) return answer('{"unexpected":"bbox is not a Tile of the test plan"}');
      const pageScript = script.listing?.[tileNumber]?.[(call.page ?? 1) - 1];
      return pageScript === undefined
        ? listingAnswer([], call.page ?? 1, call.count ?? 100)
        : pick(pageScript, call.attempt);
    }
    if (call.fn === 'place.getbyid') {
      const id = call.placeId ?? 0;
      const detailsScript = script.details?.[id];
      return detailsScript === undefined
        ? syntheticDetailsAnswer(id)
        : pick(detailsScript, call.attempt);
    }
    return answer('{"unexpected":true}');
  };
}

// ---------------------------------------------------------------------------
// Synthetic and recorded Wikimapia answers
// ---------------------------------------------------------------------------

/** A synthetic place of a `box` page (wire format), a point-sized place at lon/lat, no outline. */
export interface SyntheticBoxPlace {
  id: string;
  name: string;
  url: string;
  location: { north: number; south: number; east: number; west: number; lon: number; lat: number };
  polygon: { x: number; y: number }[];
}

export function syntheticBoxPlace(id: number, lon: number, lat: number): SyntheticBoxPlace {
  return {
    id: String(id),
    name: `Synthetic place ${String(id)}`,
    url: `http://wikimapia.org/${String(id)}/Synthetic-place-${String(id)}`,
    location: { north: lat, south: lat, east: lon, west: lon, lon, lat },
    polygon: [],
  };
}

/** A synthetic `box` answer holding exactly `places` (wire format), echoing page and count. */
export function listingAnswer(
  places: readonly SyntheticBoxPlace[],
  page = 1,
  count = 100,
  found = places.length,
): TransportResponse {
  const body = {
    version: '1.0',
    language: 'en',
    folder: places,
    page,
    count,
    found: String(found),
  };
  RawBoxResponseSchema.parse(body);
  return answer(body);
}

/** The recorded first page of central Belgrade (3 Places, Total Found 290). */
export function belgradePage1(): TransportResponse {
  return fixtureAnswer('box-belgrade-page1.json');
}

/** The recorded empty page (reconstructed past-the-end page). */
export function emptyRecordedPage(): TransportResponse {
  return fixtureAnswer('box-belgrade-empty-page.json');
}

/** The reconstructed Wikimapia Error (`Invalid API key.`). */
export function wikimapiaErrorAnswer(): TransportResponse {
  return fixtureAnswer('debug-error.json');
}

/** An Unexpected Response: valid JSON of the wrong shape. */
export function unexpectedAnswer(): TransportResponse {
  return answer('{"surprise":"this is not a Wikimapia answer"}');
}

/** The recorded Rate-Limit Response, every attempt (Rate Limit Exhausted after the Retry Limit). */
export function rateLimitForever(): TransportResponse {
  return fixtureAnswer('debug-rate-limit.json');
}

export function detailsAnswer(name: FixtureName): TransportResponse {
  return fixtureAnswer(name);
}

/** A details answer built from the given raw Place Details (e.g. a fixture with a change). */
export function rawDetailsAnswer(details: RawPlaceDetails): TransportResponse {
  return answer(details);
}

/** Central Belgrade point used for synthetic details when no location is given. */
export const CENTRAL_BELGRADE_POINT = { lon: 20.457, lat: 44.817 } as const;

/**
 * Synthetic Place Details for `placeId` built from the recorded `getbyid-1381893.json` by the
 * smallest change: id, title and location replaced, no outline, no comments, no parent.
 */
export function syntheticDetails(
  placeId: number,
  point: { lon: number; lat: number } = CENTRAL_BELGRADE_POINT,
): RawPlaceDetails {
  const base = rawDetails('getbyid-1381893.json');
  return {
    ...base,
    id: placeId,
    title: `Synthetic place ${String(placeId)}`,
    description: `Synthetic description ${String(placeId)}.`,
    parent_id: '0',
    polygon: [],
    comments: [],
    location: {
      ...base.location,
      lon: point.lon,
      lat: point.lat,
      north: point.lat,
      south: point.lat,
      east: point.lon,
      west: point.lon,
    },
  };
}

export function syntheticDetailsAnswer(
  placeId: number,
  point?: { lon: number; lat: number },
): TransportResponse {
  return answer(syntheticDetails(placeId, point));
}

// ---------------------------------------------------------------------------
// Test Regions ("Region T") and configuration
// ---------------------------------------------------------------------------

/** Bounding Box of `belgrade-small`; holds all three Places of the recorded `box` page. */
export const SMALL_BBOX: BoundingBox = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 };

/** Region T with 1 Tile (Tile Size larger than the Region, AC-3): the Tile is the Region. */
export const REGION_T1: Region = {
  name: 'test-one',
  bbox: SMALL_BBOX,
  tileSize: { width: 0.02, height: 0.02 },
};
export const T1_TILES: readonly Tile[] = [{ tileNumber: 1, bbox: SMALL_BBOX }];

/** Region T with 2 Tiles side by side (0.006 then 0.004 degrees wide). */
export const REGION_T2: Region = {
  name: 'test-two',
  bbox: SMALL_BBOX,
  tileSize: { width: 0.006, height: 0.02 },
};
export const T2_TILES: readonly Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.458, north: 44.82 } },
  { tileNumber: 2, bbox: { west: 20.458, south: 44.814, east: 20.462, north: 44.82 } },
];

/** Region T with 4 Tiles, 2 by 2. */
export const REGION_T4: Region = {
  name: 'test-four',
  bbox: SMALL_BBOX,
  tileSize: { width: 0.006, height: 0.004 },
};
export const T4_TILES: readonly Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.458, north: 44.818 } },
  { tileNumber: 2, bbox: { west: 20.458, south: 44.814, east: 20.462, north: 44.818 } },
  { tileNumber: 3, bbox: { west: 20.452, south: 44.818, east: 20.458, north: 44.82 } },
  { tileNumber: 4, bbox: { west: 20.458, south: 44.818, east: 20.462, north: 44.82 } },
];

/** A Region far from central Belgrade (south-west outskirts), 1 Tile, for independence checks. */
export const REGION_FAR: Region = {
  name: 'test-far',
  bbox: { west: 20.3, south: 44.7, east: 20.31, north: 44.71 },
  tileSize: { width: 0.02, height: 0.02 },
};
export const FAR_TILES: readonly Tile[] = [{ tileNumber: 1, bbox: REGION_FAR.bbox }];

/** A Crawl Configuration with every test Region and the default settings, plus overrides. */
export function testConfiguration(overrides: Partial<CrawlConfiguration> = {}): CrawlConfiguration {
  return {
    regions: [REGION_T1, REGION_T2, REGION_T4, REGION_FAR],
    listingPageSize: 100,
    refreshAgeDays: 30,
    minRequestIntervalSeconds: 6,
    requestBudget: 500,
    ...overrides,
  };
}

/** `count` synthetic Place Summaries (wire format) spread inside `bbox`, ids from `firstId`. */
export function syntheticPlacesIn(
  bbox: BoundingBox,
  count: number,
  firstId: number,
): SyntheticBoxPlace[] {
  return Array.from({ length: count }, (_, i) => {
    const f = (i + 1) / (count + 1);
    return syntheticBoxPlace(
      firstId + i,
      Number((bbox.west + (bbox.east - bbox.west) * f).toFixed(6)),
      Number((bbox.south + (bbox.north - bbox.south) * f).toFixed(6)),
    );
  });
}

/** Lets queued promise callbacks of the current turn run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
