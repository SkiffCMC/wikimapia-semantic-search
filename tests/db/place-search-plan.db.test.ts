/**
 * AL2 unit tests: plan guards of the search statement (AL4 hybrid-search 1.4.4 "Why this is
 * exact", 1.4.10, U3). With the Search Set plus 1,000 Places analyzed, the Exact plan never
 * uses the HNSW index and ranks over the materialized `candidates` CTE (AC-10), under the
 * default settings and under the test-only `PLAN_FORCE_INDEX`. Under `PLAN_FORCE_INDEX` the
 * unfiltered Approximate plan uses the HNSW index (a Sort node for the outer Ranking Order is
 * allowed).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createDb, destroyQuietly } from '../../src/db/connection';
import { createEmbeddingStore } from '../../src/db/embedding-store';
import { buildPlaceSearchStatement } from '../../src/db/place-search';
import { createPlaceStore } from '../../src/db/place-store';
import { createSchemaSetup } from '../../src/db/schema-setup';
import type { PlaceSearchQuery } from '../../src/db/types';
import { MAX_RESULT_LIMIT } from '../../contracts/hybrid-search.schema';
import {
  AREA_B,
  POINT_S,
  SEARCH_SET,
  manyPlaces,
  queryEmbeddingQ,
  seedPlaces,
} from '../../contracts/hybrid-search.support';
import type { SchemaSetup } from '../../contracts/storage.schema';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const HNSW_INDEX = 'place_embeddings_embedding_hnsw_idx';

let setup: SchemaSetup;
let db: Knex;

/** All tests here are read-only, so the 1,000 Places are seeded once. */
beforeAll(async () => {
  const testUrl = requireTestDatabaseUrl();
  setup = createSchemaSetup({ connectionString: testUrl });
  expect((await setup.apply()).ok).toBe(true);
  expect((await setup.emptyStore()).ok).toBe(true);
  db = createDb(testUrl, 1);
  const places = createPlaceStore({ connectionString: testUrl });
  const embeddings = createEmbeddingStore({ connectionString: testUrl });
  try {
    const many = manyPlaces({
      firstId: 3001,
      count: 1000,
      centre: { lat: 45.5, lon: 20.457 },
      tag: 'hotel',
      top: 0.9849,
      step: 0.0005,
    });
    await seedPlaces(places, embeddings, [...SEARCH_SET, ...many]);
  } finally {
    await embeddings.close();
    await places.close();
  }
  await db.raw('analyze places, place_embeddings, place_tags, tags');
}, 300_000);

afterAll(async () => {
  try {
    expect((await setup.apply()).ok).toBe(true);
  } finally {
    await destroyQuietly(db);
    await setup.close();
  }
});

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

const PlanNodeSchema = z.object({
  'Node Type': z.string(),
  'Index Name': z.string().optional(),
  'CTE Name': z.string().optional(),
  get Plans() {
    return z.array(PlanNodeSchema).optional();
  },
});
type PlanNode = z.infer<typeof PlanNodeSchema>;
const ExplainSchema = z.object({
  rows: z.array(z.object({ 'QUERY PLAN': z.array(z.object({ Plan: PlanNodeSchema })) })),
});

/** Every node of the plan, InitPlans and SubPlans included (they sit in `Plans`). */
function allNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(allNodes)];
}

function nodesOf(explained: z.infer<typeof ExplainSchema>): PlanNode[] {
  const plans = explained.rows.flatMap((row) => row['QUERY PLAN']);
  expect(plans).toHaveLength(1);
  return plans.flatMap((p) => allNodes(p.Plan));
}

/** `EXPLAIN (FORMAT JSON)` of the built statement under the default settings. */
async function defaultPlanNodes(query: PlaceSearchQuery): Promise<PlanNode[]> {
  const { sql, bindings } = buildPlaceSearchStatement(query);
  const raw: unknown = await db.raw(`explain (format json) ${sql}`, bindings);
  return nodesOf(ExplainSchema.parse(raw));
}

/** `EXPLAIN (FORMAT JSON)` of the built statement under `PLAN_FORCE_INDEX` (AL4 1.4.10). */
async function forcedPlanNodes(query: PlaceSearchQuery): Promise<PlanNode[]> {
  const { sql, bindings } = buildPlaceSearchStatement(query);
  const explained = await db.transaction(async (trx) => {
    await trx.raw('SET LOCAL enable_seqscan = off');
    await trx.raw('SET LOCAL enable_sort = off');
    const raw: unknown = await trx.raw(`explain (format json) ${sql}`, bindings);
    return ExplainSchema.parse(raw);
  });
  return nodesOf(explained);
}

const PLANNERS: [string, (query: PlaceSearchQuery) => Promise<PlanNode[]>][] = [
  ['default settings', defaultPlanNodes],
  ['PLAN_FORCE_INDEX', forcedPlanNodes],
];

const usesHnsw = (nodes: readonly PlanNode[]): boolean =>
  nodes.some((n) => n['Index Name'] === HNSW_INDEX);

function query(parts: Partial<PlaceSearchQuery>): PlaceSearchQuery {
  return { queryEmbedding: queryEmbeddingQ(), mode: 'exact', limit: MAX_RESULT_LIMIT, ...parts };
}

const radius = { radius: { centre: POINT_S, radiusMetres: 500 } };

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const EXACT_CASES: [string, Partial<PlaceSearchQuery>][] = [
  ['no filter', {}],
  ['Radius', radius],
  ['Area', { area: AREA_B }],
  ['Tags', { tagTitles: ['museum'] }],
  ['Tags and Radius', { ...radius, tagTitles: ['museum', 'hotel'] }],
];

describe('plan guards', () => {
  it.each(
    PLANNERS.flatMap(([planner, plan]) =>
      EXACT_CASES.map(([name, parts]): [string, string, typeof plan, Partial<PlaceSearchQuery>] => [
        name,
        planner,
        plan,
        parts,
      ]),
    ),
  )('Exact, %s, %s: no HNSW index node, a CTE Scan of candidates', async (_n, _p, plan, parts) => {
    const nodes = await plan(query(parts));
    expect(usesHnsw(nodes)).toBe(false);
    expect(nodes.some((n) => n['Node Type'] === 'CTE Scan' && n['CTE Name'] === 'candidates')).toBe(
      true,
    );
  });

  it('Approximate without filters, PLAN_FORCE_INDEX: uses the HNSW index', async () => {
    expect(usesHnsw(await forcedPlanNodes(query({ mode: 'approximate' })))).toBe(true);
  });
});
