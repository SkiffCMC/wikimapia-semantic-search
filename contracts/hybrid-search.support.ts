/**
 * AL5 CONTRACT SUPPORT: the Search Set, synthetic Embeddings, the Simulated Embedding Service
 * (query side) and test oracles for the `hybrid-search` contracts.
 *
 * Layer:    AL5 (Contracts). Not part of the subject under test.
 * Derives:  docs/al6-requirements/20261027-hybrid-search-al6.md (section 3 preamble: the
 *           Search Set, Point S, Area B, the fixed Query Embedding Q, the Simulated Embedding
 *           Service, a dummy VOYAGE_API_KEY; AC-61, AC-62)
 * Enforces: .agrules section 4 (no live Voyage, Anthropic or Wikimapia calls, synthetic keys
 *           only, small synthetic Places and deterministic 1024-number Embeddings, recorded
 *           fixtures only from contracts/fixtures/wikimapia/ and never edited).
 *
 * Only the Embedding Service is doubled. Places and Embedding Records are written through the
 * real, finished Place Store and Embedding Store; Place Search itself is never doubled.
 */
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, documentFingerprint } from './embeddings.schema';
import type { EmbeddingRecord, EmbeddingStore } from './embeddings.schema';
import { SaveEmbeddingRecordsResultSchema } from './embeddings.schema';
import type {
  AreaFilter,
  LatLon,
  QueryEmbeddingRequest,
  QueryEmbeddingService,
} from './hybrid-search.schema';
import { SaveResultSchema, type PlaceStore } from './storage.schema';
import { FETCHED_AT, LATER_FETCHED_AT } from './storage.support';
import type { ListingPage, PlaceDetails, Point, Tag } from './wikimapia-client.schema';

export {
  TEST_VOYAGE_API_KEY,
  connectionError,
  fakeVector,
  rateLimitError,
  refusedError,
  unavailableError,
} from './embeddings.support';

// ---------------------------------------------------------------------------
// Deterministic synthetic Embeddings with exact cosine similarities
// ---------------------------------------------------------------------------

/**
 * The fixed Query Embedding Q: the unit vector along axis 0. A Place Embedding
 * `s * e0 + sqrt(1 - s^2) * e_axis` (axis 1 .. 1023) has cosine similarity exactly `s` with Q;
 * stored as 32-bit floats it stays within 0.0000002 of `s`.
 */
export function queryEmbeddingQ(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
}

export function embeddingWithSimilarity(similarity: number, axis: number): number[] {
  if (axis < 1 || axis >= EMBEDDING_DIMENSIONS)
    throw new Error(`axis ${String(axis)} out of range`);
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = similarity;
  vector[axis] = Math.sqrt(1 - similarity * similarity);
  return vector;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  });
  return dot / Math.sqrt(na * nb);
}

/** A readable `voyageai` answer holding the given Embeddings (default: Q alone). */
export function queryAnswer(
  embeddings: readonly (readonly number[])[] = [queryEmbeddingQ()],
  model: string = EMBEDDING_MODEL,
) {
  return {
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding',
      embedding: [...embedding],
      index,
    })),
    model,
    usage: { totalTokens: 3 },
  };
}

// ---------------------------------------------------------------------------
// Simulated Embedding Service (query side)
// ---------------------------------------------------------------------------

/** The prepared answer: the normal answer (Q), a raw answer value, or a thrown error. */
export type QueryServiceAnswer =
  { readonly normal: true } | { readonly raw: unknown } | { readonly error: Error };

export const NORMAL_QUERY_ANSWER: QueryServiceAnswer = { normal: true };

/**
 * Simulated Embedding Service (AL6 section 3 preamble): answers any Query Text with Q (or the
 * prepared answer) and records a copy of every request exactly as sent. Never touches the
 * network.
 */
export class SimulatedQueryEmbeddingService implements QueryEmbeddingService {
  readonly calls: QueryEmbeddingRequest[] = [];

  constructor(private readonly answer: QueryServiceAnswer = NORMAL_QUERY_ANSWER) {}

  embed(request: QueryEmbeddingRequest): Promise<unknown> {
    this.calls.push(structuredClone(request));
    const prepared = this.answer;
    if ('error' in prepared) return Promise.reject(prepared.error);
    if ('raw' in prepared) return Promise.resolve(structuredClone(prepared.raw));
    return Promise.resolve(queryAnswer());
  }

  /** Every text sent, in order. */
  get texts(): string[] {
    return this.calls.flatMap((call) => [...call.input]);
  }
}

// ---------------------------------------------------------------------------
// Point S, Area B and the Search Set (AL6 section 3 preamble)
// ---------------------------------------------------------------------------

export const POINT_S: LatLon = { lat: 44.817, lon: 20.457 };

export const AREA_B: AreaFilter = { south: 44.816, north: 44.82, west: 20.456, east: 20.458 };

/** Tag Catalogue of the synthetic Places; ids are not used by any recorded fixture. */
export const SEARCH_TAGS = {
  museum: { id: 99101, title: 'museum' },
  'art gallery': { id: 99102, title: 'art gallery' },
  hotel: { id: 99103, title: 'hotel' },
  restaurant: { id: 99104, title: 'restaurant' },
  park: { id: 99105, title: 'park' },
  monument: { id: 99106, title: 'monument' },
  'needle tag': { id: 99107, title: 'needle tag' },
} as const satisfies Record<string, Tag>;
export type SearchTagTitle = keyof typeof SEARCH_TAGS;

/**
 * One synthetic Place for search tests.
 * - `tags`: Present Tags in save order (= read-back order); `goneTags`: Tags of an earlier
 *   Details Save that the latest one no longer carries.
 * - `outlineBox`: an Outline Shape (a 4-point box); absent = no Outline Shape.
 * - `similarity` / `axis`: its Embedding Record (absent = none); `model` defaults to voyage-4.
 * - `summaryOnly`: saved by a Listing Save only.
 */
export interface SyntheticSearchPlace {
  placeId: number;
  name: string;
  centre: LatLon;
  tags?: readonly SearchTagTitle[];
  goneTags?: readonly SearchTagTitle[];
  outlineBox?: AreaFilter;
  isDeleted?: boolean;
  summaryOnly?: boolean;
  similarity?: number;
  axis?: number;
  model?: string;
}

/** The Search Set row with the stated Distance from Point S in metres (AL6 table). */
export interface SearchSetPlace extends SyntheticSearchPlace {
  statedDistance: number;
}

export const SEARCH_SET: readonly SearchSetPlace[] = [
  {
    placeId: 101,
    name: 'City Museum',
    centre: { lat: 44.817, lon: 20.457 },
    statedDistance: 0,
    tags: ['museum'],
    similarity: 0.9,
  },
  {
    placeId: 102,
    name: 'Art Gallery',
    centre: { lat: 44.8197, lon: 20.457 },
    statedDistance: 300,
    tags: ['museum', 'art gallery'],
    similarity: 0.95,
  },
  {
    placeId: 103,
    name: 'Old Hotel',
    centre: { lat: 44.8242, lon: 20.457 },
    statedDistance: 800,
    tags: ['hotel'],
    similarity: 0.99,
  },
  {
    placeId: 104,
    name: 'Corner Cafe',
    centre: { lat: 44.821, lon: 20.457 },
    statedDistance: 445,
    tags: ['restaurant'],
    similarity: 0.5,
  },
  {
    placeId: 105,
    name: 'Unembedded Museum',
    centre: { lat: 44.817, lon: 20.4571 },
    statedDistance: 8,
    tags: ['museum'],
  },
  {
    placeId: 106,
    name: 'Listed Place',
    centre: { lat: 44.817, lon: 20.457 },
    statedDistance: 0,
    summaryOnly: true,
  },
  {
    placeId: 107,
    name: 'Other Model Museum',
    centre: { lat: 44.8172, lon: 20.457 },
    statedDistance: 22,
    tags: ['museum'],
    similarity: 0.97,
    model: 'voyage-3.5',
  },
  {
    placeId: 108,
    name: 'Former Museum',
    centre: { lat: 44.8179, lon: 20.457 },
    statedDistance: 100,
    tags: ['monument'],
    goneTags: ['museum'],
    similarity: 0.7,
  },
  {
    placeId: 109,
    name: 'Riverside Park',
    centre: { lat: 44.818, lon: 20.459 },
    statedDistance: 193,
    tags: ['park'],
    outlineBox: { south: 44.8175, north: 44.8185, west: 20.4575, east: 20.4605 },
    similarity: 0.6,
  },
  {
    placeId: 110,
    name: 'Deleted Museum',
    centre: { lat: 44.8174, lon: 20.457 },
    statedDistance: 44,
    tags: ['museum'],
    similarity: 0.8,
    isDeleted: true,
  },
];

/** AC-4: Places of the Search Set that are never returned. */
export const NOT_SEARCHABLE_IDS: readonly number[] = [105, 106, 107, 110];

/** AC-1: the Searchable Places of the Search Set in Ranking Order for Q. */
export const SEARCHABLE_RANKING: readonly number[] = [103, 102, 101, 108, 109, 104];

export function searchSetPlace(placeId: number): SearchSetPlace {
  const place = SEARCH_SET.find((p) => p.placeId === placeId);
  if (place === undefined) throw new Error(`no Search Set place ${String(placeId)}`);
  return place;
}

/** The stated similarity of a Searchable Place (the true Similarity Score with Q). */
export function similarityOf(
  placeId: number,
  places: readonly SyntheticSearchPlace[] = SEARCH_SET,
): number {
  const place = places.find((p) => p.placeId === placeId);
  if (place?.similarity === undefined) throw new Error(`place ${String(placeId)} has no Embedding`);
  return place.similarity;
}

// ---------------------------------------------------------------------------
// Oracles over synthetic Places (what the AL6 glossary says must pass a filter)
// ---------------------------------------------------------------------------

/** Glossary "Searchable Place" (R-A, Q5). */
export function isSearchable(place: SyntheticSearchPlace): boolean {
  return (
    place.summaryOnly !== true &&
    place.isDeleted !== true &&
    place.similarity !== undefined &&
    (place.model ?? EMBEDDING_MODEL) === EMBEDDING_MODEL
  );
}

/** Glossary "Lies In the Area" (Q3): Outline Shape touches or overlaps, else Centre Point inside (edge included). */
export function liesInArea(place: SyntheticSearchPlace, area: AreaFilter): boolean {
  const box = place.outlineBox;
  if (box !== undefined) {
    return !(
      box.east < area.west ||
      box.west > area.east ||
      box.north < area.south ||
      box.south > area.north
    );
  }
  const { lat, lon } = place.centre;
  return lat >= area.south && lat <= area.north && lon >= area.west && lon <= area.east;
}

// ---------------------------------------------------------------------------
// Saving synthetic Places through the real stores
// ---------------------------------------------------------------------------

function boxOutline(box: AreaFilter): Point[] {
  return [
    { lon: box.west, lat: box.south },
    { lon: box.east, lat: box.south },
    { lon: box.east, lat: box.north },
    { lon: box.west, lat: box.north },
  ];
}

function detailsOf(place: SyntheticSearchPlace, tags: readonly SearchTagTitle[]): PlaceDetails {
  const { lat, lon } = place.centre;
  const box = place.outlineBox;
  return {
    placeId: place.placeId,
    title: place.name,
    description: `Synthetic search place ${String(place.placeId)}.`,
    tags: tags.map((title) => ({ ...SEARCH_TAGS[title] })),
    isBuilding: false,
    isRegion: false,
    isDeleted: place.isDeleted ?? false,
    outline: box === undefined ? [] : boxOutline(box),
    location: {
      lon,
      lat,
      north: box?.north ?? lat,
      south: box?.south ?? lat,
      east: box?.east ?? lon,
      west: box?.west ?? lon,
      city: 'Belgrade',
    },
    comments: [],
  };
}

function listingOf(place: SyntheticSearchPlace): ListingPage {
  const { lat, lon } = place.centre;
  return {
    page: 1,
    pageSize: 10,
    totalFound: 1,
    places: [
      {
        placeId: place.placeId,
        name: place.name,
        url: `http://wikimapia.org/${String(place.placeId)}`,
        location: { lon, lat, north: lat, south: lat, east: lon, west: lon },
        outline: [],
      },
    ],
  };
}

function requireSaved(result: unknown, what: string): void {
  const parsed = SaveResultSchema.parse(result);
  if (!parsed.ok) throw new Error(`could not save ${what}: ${parsed.failure.message}`);
}

/** Saves one Place: Listing Save, or Details Save(s) (Gone Tags by an earlier save). */
export async function savePlace(store: PlaceStore, place: SyntheticSearchPlace): Promise<void> {
  const what = `place ${String(place.placeId)}`;
  if (place.summaryOnly === true) {
    requireSaved(await store.saveListingPage(listingOf(place)), what);
    return;
  }
  const present = place.tags ?? [];
  if (place.goneTags !== undefined && place.goneTags.length > 0) {
    const earlier = detailsOf(place, [...present, ...place.goneTags]);
    requireSaved(await store.savePlaceDetails({ details: earlier, fetchedAt: FETCHED_AT }), what);
    const latest = detailsOf(place, present);
    requireSaved(
      await store.savePlaceDetails({ details: latest, fetchedAt: LATER_FETCHED_AT }),
      what,
    );
    return;
  }
  requireSaved(
    await store.savePlaceDetails({ details: detailsOf(place, present), fetchedAt: FETCHED_AT }),
    what,
  );
}

/**
 * Embedding Record of a synthetic Place. The Document Fingerprint is of a placeholder text, so
 * the Place is Embedding Due (AC-11: an older Embedding is still searched).
 */
export function recordOf(place: SyntheticSearchPlace, index: number): EmbeddingRecord {
  if (place.similarity === undefined)
    throw new Error(`place ${String(place.placeId)} has no Embedding`);
  return {
    placeId: place.placeId,
    embedding: embeddingWithSimilarity(
      place.similarity,
      place.axis ?? 1 + (index % (EMBEDDING_DIMENSIONS - 1)),
    ),
    model: place.model ?? EMBEDDING_MODEL,
    documentFingerprint: documentFingerprint(`older document of ${String(place.placeId)}`),
    embeddedAt: '2026-10-24T00:00:00Z',
  };
}

export async function saveRecords(
  embeddings: EmbeddingStore,
  records: readonly EmbeddingRecord[],
): Promise<void> {
  for (let i = 0; i < records.length; i += 1000) {
    const parsed = SaveEmbeddingRecordsResultSchema.parse(
      await embeddings.saveEmbeddingRecords({ records: records.slice(i, i + 1000) }),
    );
    if (!parsed.ok) throw new Error(`could not save Embedding Records: ${parsed.failure.message}`);
  }
}

/** Saves the Places, then the Embedding Records of those that have one. */
export async function seedPlaces(
  store: PlaceStore,
  embeddings: EmbeddingStore,
  places: readonly SyntheticSearchPlace[],
): Promise<void> {
  for (const place of places) await savePlace(store, place);
  const records = places.flatMap((place, index) =>
    place.similarity === undefined ? [] : [recordOf(place, index)],
  );
  await saveRecords(embeddings, records);
}

export async function seedSearchSet(store: PlaceStore, embeddings: EmbeddingStore): Promise<void> {
  await seedPlaces(store, embeddings, SEARCH_SET);
}

/**
 * `count` Searchable Places from `firstId`, all at `centre` with Tag `tag`, with distinct
 * similarities `top - rank * step`, where rank is a permutation of 0 .. count-1 that differs
 * from Place ID order (AC-6, AC-7, AC-10), so ID order and Ranking Order differ.
 */
export function manyPlaces(spec: {
  firstId: number;
  count: number;
  centre: LatLon;
  tag: SearchTagTitle;
  top: number;
  step: number;
}): SyntheticSearchPlace[] {
  const multiplier = 7;
  if (spec.count % multiplier === 0) throw new Error('count must not be a multiple of 7');
  return Array.from({ length: spec.count }, (_, i) => {
    const rank = (i * multiplier) % spec.count;
    return {
      placeId: spec.firstId + i,
      name: `Synthetic search place ${String(spec.firstId + i)}`,
      centre: spec.centre,
      tags: [spec.tag],
      similarity: spec.top - rank * spec.step,
    };
  });
}
