/**
 * AL2 unit tests: the behavioural proof of decision D-EF (AL4 hybrid-search 1.4.9, 1.4.10,
 * 1.4.11, U3). The Test Database holds only the HNSW cloud, analyzed. The same Approximate
 * statement runs under `PLAN_FORCE_INDEX` with an asserted HNSW plan on the Approximate and the
 * Exact search connection: the HNSW scan returns min(ef_search, reachable) tuples, so 50 rows
 * versus 40 shows that the connection's ef_search reaches the index scan. Recall against the
 * true top 50 is not asserted (Approximate mode may miss). The tests only read the setting.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createDb, destroyQuietly } from '../../src/db/connection';
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { buildPlaceSearchStatement, selectMatchingPlaces } from '../../src/db/place-search';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import { openSearchDb } from '../../src/db/search-store';
import type { PlaceSearchQuery } from '../../src/db/types';
import {
  MAX_RESULT_LIMIT,
  SIMILARITY_TOLERANCE,
  isInRankingOrder,
  type SearchMode,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';
import { queryEmbeddingQ } from '../../contracts/hybrid-search.support';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';
import { HNSW_CLOUD, hnswCloud, seedHnswCloud } from './hnsw-cloud';

const HNSW_INDEX = 'place_embeddings_embedding_hnsw_idx';
const CLOUD = hnswCloud();
const QUERY: PlaceSearchQuery = {
  queryEmbedding: queryEmbeddingQ(),
  mode: 'approximate',
  limit: MAX_RESULT_LIMIT,
};

let testUrl = '';
let db: Knex | undefined;

/** Read-only tests: the cloud is seeded once and the seeding stores are closed right after. */
beforeAll(async () => {
  testUrl = requireTestDatabaseUrl();
  const setup = createSchemaSetup({ connectionString: testUrl });
  const places = createPlaceStore({ connectionString: testUrl });
  const embeddings = createEmbeddingStore({ connectionString: testUrl });
  try {
    expect((await setup.apply()).ok).toBe(true);
    expect((await setup.emptyStore()).ok).toBe(true);
    await seedHnswCloud(places, embeddings);
  } finally {
    await embeddings.close();
    await places.close();
    await setup.close();
  }
  db = createDb(testUrl, 1);
  await db.raw('analyze places, place_embeddings, place_tags, tags');
}, 300_000);

afterAll(async () => {
  const setup = createSchemaSetup({ connectionString: testUrl });
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await destroyQuietly(db);
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PlanNodeSchema = z.object({
  'Index Name': z.string().optional(),
  get Plans() {
    return z.array(PlanNodeSchema).optional();
  },
});
type PlanNode = z.infer<typeof PlanNodeSchema>;
const ExplainSchema = z.object({
  rows: z.array(z.object({ 'QUERY PLAN': z.array(z.object({ Plan: PlanNodeSchema })) })),
});
const SettingSchema = z.object({ rows: z.array(z.object({ value: z.string().nullable() })) });

/** True when the node or any node below it (InitPlans and SubPlans sit in `Plans`) uses HNSW. */
function usesHnsw(node: PlanNode): boolean {
  return node['Index Name'] === HNSW_INDEX || (node.Plans ?? []).some(usesHnsw);
}

interface ForcedRun {
  hnsw: boolean;
  setting: string | null | undefined;
  list: SearchResult[];
}

/** Plan, setting and rows of the built Approximate statement under `PLAN_FORCE_INDEX`. */
async function forcedRun(handle: Knex): Promise<ForcedRun> {
  const { sql, bindings } = buildPlaceSearchStatement(QUERY);
  return handle.transaction(async (trx) => {
    await trx.raw('SET LOCAL enable_seqscan = off');
    await trx.raw('SET LOCAL enable_sort = off');
    const plan: unknown = await trx.raw(`explain (format json) ${sql}`, bindings);
    const plans = ExplainSchema.parse(plan).rows.flatMap((row) => row['QUERY PLAN']);
    const setting: unknown = await trx.raw(
      "select current_setting('hnsw.ef_search', true) as value",
    );
    const value = SettingSchema.parse(setting).rows[0]?.value;
    const list = await selectMatchingPlaces(trx, QUERY);
    return {
      hnsw: plans.length === 1 && plans.every((p) => usesHnsw(p.Plan)),
      setting: value,
      list,
    };
  });
}

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
}

// ---------------------------------------------------------------------------
// Self-checks of the cloud (AL4 1.4.11)
// ---------------------------------------------------------------------------

describe('HNSW cloud self-checks', () => {
  it('is deterministic', () => {
    expect(hnswCloud()).toStrictEqual(hnswCloud());
  });

  it('has HNSW_CLOUD.count distinct Place IDs and distinct similarities', () => {
    expect(new Set(CLOUD.map((p) => p.placeId)).size).toBe(HNSW_CLOUD.count);
    expect(new Set(CLOUD.map((p) => p.similarity)).size).toBe(HNSW_CLOUD.count);
  });

  it('every embedding has 1024 entries and unit length', () => {
    for (const place of CLOUD) {
      expect(place.embedding).toHaveLength(1024);
      expect(Math.abs(norm(place.embedding) - 1)).toBeLessThanOrEqual(1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// D-EF proof under a forced HNSW plan
// ---------------------------------------------------------------------------

describe('D-EF: the same statement, plan and graph give 50 versus 40 rows', () => {
  it.each<[SearchMode, string, number]>([
    ['approximate', '100', 50],
    ['exact', '40', 40],
  ])(
    'the %s search connection: HNSW plan, ef_search %s, exactly %i rows',
    async (mode, setting, count) => {
      const handle = openSearchDb(testUrl, mode);
      try {
        const run = await forcedRun(handle);
        expect(run.hnsw).toBe(true);
        expect(run.setting).toBe(setting);
        expect(run.list).toHaveLength(count);
        expect(isInRankingOrder(run.list)).toBe(true);
        expect(new Set(run.list.map((r) => r.placeId)).size).toBe(run.list.length);
        for (const r of run.list) {
          const place = CLOUD.find((p) => p.placeId === r.placeId);
          if (place === undefined) throw new Error(`not a cloud place: ${String(r.placeId)}`);
          expect(Math.abs(r.similarity - place.similarity)).toBeLessThanOrEqual(
            SIMILARITY_TOLERANCE,
          );
        }
      } finally {
        await destroyQuietly(handle);
      }
    },
  );
});
