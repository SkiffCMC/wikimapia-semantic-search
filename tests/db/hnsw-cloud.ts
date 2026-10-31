/**
 * HNSW cloud: the test data that proves decision D-EF (AL4 hybrid-search 1.4.11, U3).
 *
 * The contract's orthogonal vectors fragment the HNSW graph, so a forced HNSW scan over them
 * reaches only a few dozen tuples at any ef_search. This cloud is connected instead: every
 * vector is axis 0 plus a uniform random offset in a small subspace, normalised and rounded to
 * float32, so neighbours carry real local structure and at least 100 tuples are reachable.
 *
 * Active parameters: the primary set of AL4 1.4.11 (seed 20261029, 1,000 Places with IDs
 * 50001 .. 51000, subspace axes 1 .. 16). The pre-approved fallback (2,000 Places, 8 axes) is
 * not in use: a probe on the Test Database gave 50 rows on the Approximate connection and 40 on
 * the Exact one under the forced HNSW plan.
 *
 * Deterministic (mulberry32, no Math.random), no literal vectors, no direct SQL: seeding goes
 * through the contract support's `savePlace` / `saveRecords` and the real stores.
 */
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  documentFingerprint,
  type EmbeddingRecord,
  type EmbeddingStore,
} from '../../contracts/embeddings.schema';
import {
  cosineSimilarity,
  queryEmbeddingQ,
  saveRecords,
  savePlace,
  type SyntheticSearchPlace,
} from '../../contracts/hybrid-search.support';
import type { PlaceStore } from '../../contracts/storage.schema';

export const HNSW_CLOUD = {
  seed: 20261029,
  count: 1000,
  firstId: 50001,
  subspaceAxes: 16,
  centre: { lat: 44.9, lon: 20.4 },
} as const;

export interface HnswCloudPlace extends SyntheticSearchPlace {
  /** True cosine similarity with Q, from the float32-rounded vector. */
  similarity: number;
  /** 1024 numbers, unit length, each already `Math.fround`-ed. */
  embedding: number[];
}

/** mulberry32: uniform numbers in [0, 1) from a uint32 seed. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The cloud, place by place; random draws go axis 1 .. subspaceAxes per Place. */
export function hnswCloud(): HnswCloudPlace[] {
  const next = mulberry32(HNSW_CLOUD.seed);
  const q = queryEmbeddingQ();
  return Array.from({ length: HNSW_CLOUD.count }, (_, i) => {
    const raw = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    raw[0] = 1;
    for (let j = 1; j <= HNSW_CLOUD.subspaceAxes; j += 1) raw[j] = 2 * next() - 1;
    const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0));
    const embedding = raw.map((x) => Math.fround(x / norm));
    const placeId = HNSW_CLOUD.firstId + i;
    return {
      placeId,
      name: `HNSW cloud place ${String(placeId)}`,
      centre: HNSW_CLOUD.centre,
      similarity: cosineSimilarity(q, embedding),
      embedding,
    };
  });
}

/** Saves every cloud Place (Details Save, no tags), then all Embedding Records; returns the cloud. */
export async function seedHnswCloud(
  places: PlaceStore,
  embeddings: EmbeddingStore,
): Promise<HnswCloudPlace[]> {
  const cloud = hnswCloud();
  for (const place of cloud) await savePlace(places, place);
  const records: EmbeddingRecord[] = cloud.map((place) => ({
    placeId: place.placeId,
    embedding: place.embedding,
    model: EMBEDDING_MODEL,
    documentFingerprint: documentFingerprint(`hnsw cloud ${String(place.placeId)}`),
    embeddedAt: '2026-10-24T00:00:00Z',
  }));
  await saveRecords(embeddings, records);
  return cloud;
}
