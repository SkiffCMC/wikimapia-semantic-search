/**
 * AL2 unit tests: `src/crawl/tile-plan.ts` (AL4 1.3 `planTiles`, 1.4.2 Tile Plan; AL6 AC-2, AC-3,
 * AC-4, AC-66, AC-67).
 *
 * Pure and synchronous: no database, no network, no clock. Regions come from the contract
 * (`BELGRADE_*_REGION`) and the support file (Region T variants); the expected Tiles of AC-2 and
 * AC-66 are the values stated by AL6 / `contracts/hydration.test.ts`.
 */
import { planTiles } from '../../src/crawl/tile-plan';
import {
  BELGRADE_REGION,
  BELGRADE_SMALL_REGION,
  COORDINATE_TOLERANCE,
  TilePlanSchema,
  findTilePlanIssues,
  type Region,
  type Tile,
  type TilePlan,
} from '../../contracts/hydration.schema';
import type { BoundingBox } from '../../contracts/wikimapia-client.schema';
import {
  FAR_TILES,
  REGION_FAR,
  REGION_T1,
  REGION_T2,
  REGION_T4,
  SMALL_BBOX,
  T1_TILES,
  T2_TILES,
  T4_TILES,
  at,
} from '../../contracts/hydration.support';

/** The Tile Plan of `belgrade-small` stated by AC-2. */
const BELGRADE_SMALL_TILES: readonly Tile[] = [
  { tileNumber: 1, bbox: { west: 20.452, south: 44.814, east: 20.457, north: 44.819 } },
  { tileNumber: 2, bbox: { west: 20.457, south: 44.814, east: 20.462, north: 44.819 } },
  { tileNumber: 3, bbox: { west: 20.452, south: 44.819, east: 20.457, north: 44.82 } },
  { tileNumber: 4, bbox: { west: 20.457, south: 44.819, east: 20.462, north: 44.82 } },
];

const SIDES = ['west', 'south', 'east', 'north'] as const;

function expectBboxNear(actual: BoundingBox, expected: BoundingBox): void {
  for (const side of SIDES) {
    expect(Math.abs(actual[side] - expected[side])).toBeLessThanOrEqual(COORDINATE_TOLERANCE);
  }
}

function expectTilesNear(plan: TilePlan, expected: readonly Tile[]): void {
  expect(plan.tiles).toHaveLength(expected.length);
  expected.forEach((tile, i) => {
    const got = at(plan.tiles, i);
    expect(got.tileNumber).toBe(tile.tileNumber);
    expectBboxNear(got.bbox, tile.bbox);
  });
}

describe('planTiles: belgrade-small (AC-2)', () => {
  it('is 2 columns x 2 rows with the 4 Tiles of AC-2 in plan order', () => {
    const plan = planTiles(BELGRADE_SMALL_REGION);
    expect(plan.columns).toBe(2);
    expect(plan.rows).toBe(2);
    expectTilesNear(plan, BELGRADE_SMALL_TILES);
  });

  it('passes TilePlanSchema and findTilePlanIssues reports nothing', () => {
    const plan = planTiles(BELGRADE_SMALL_REGION);
    expect(() => TilePlanSchema.parse(plan)).not.toThrow();
    expect(findTilePlanIssues(BELGRADE_SMALL_REGION, plan)).toStrictEqual([]);
  });
});

describe('planTiles: belgrade (AC-66)', () => {
  const plan = planTiles(BELGRADE_REGION);

  it('is 120 columns x 66 rows = 7,920 Tiles', () => {
    expect(plan.columns).toBe(120);
    expect(plan.rows).toBe(66);
    expect(plan.tiles).toHaveLength(7920);
    expect(() => TilePlanSchema.parse(plan)).not.toThrow();
  });

  it('Tiles 1, 120, 121 and 7920 are as AC-66 states', () => {
    const expected: [number, BoundingBox][] = [
      [1, { west: 20.15, south: 44.65, east: 20.155, north: 44.655 }],
      [120, { west: 20.745, south: 44.65, east: 20.75, north: 44.655 }],
      [121, { west: 20.15, south: 44.655, east: 20.155, north: 44.66 }],
      [7920, { west: 20.745, south: 44.975, east: 20.75, north: 44.98 }],
    ];
    for (const [tileNumber, bbox] of expected) {
      const tile = at(plan.tiles, tileNumber - 1);
      expect(tile.tileNumber).toBe(tileNumber);
      expectBboxNear(tile.bbox, bbox);
    }
  });

  it('every Tile is 0.005 wide and 0.005 high (no cut-back, no thin edge Tile)', () => {
    for (const tile of plan.tiles) {
      expect(Math.abs(tile.bbox.east - tile.bbox.west - 0.005)).toBeLessThanOrEqual(
        COORDINATE_TOLERANCE,
      );
      expect(Math.abs(tile.bbox.north - tile.bbox.south - 0.005)).toBeLessThanOrEqual(
        COORDINATE_TOLERANCE,
      );
    }
  });

  it('findTilePlanIssues reports nothing', () => {
    expect(findTilePlanIssues(BELGRADE_REGION, plan)).toStrictEqual([]);
  });

  it('inner edges carry no float noise: every coordinate has at most 9 decimals', () => {
    for (const tile of plan.tiles) {
      for (const side of SIDES) {
        const x = tile.bbox[side];
        expect(Number(x.toFixed(9))).toBe(x);
      }
    }
  });

  it('the outer edges are the Region edges exactly', () => {
    expect(at(plan.tiles, 0).bbox.west).toBe(BELGRADE_REGION.bbox.west);
    expect(at(plan.tiles, 0).bbox.south).toBe(BELGRADE_REGION.bbox.south);
    expect(at(plan.tiles, 7919).bbox.east).toBe(BELGRADE_REGION.bbox.east);
    expect(at(plan.tiles, 7919).bbox.north).toBe(BELGRADE_REGION.bbox.north);
  });
});

describe('planTiles: Region smaller than a Tile (AC-3)', () => {
  it('gives exactly 1 Tile, Tile Number 1, equal to the Region bbox', () => {
    const region: Region = {
      name: 'tiny',
      bbox: { west: 20.456, south: 44.816, east: 20.458, north: 44.817 },
      tileSize: { width: 0.005, height: 0.005 },
    };
    const plan = planTiles(region);
    expect(plan.columns).toBe(1);
    expect(plan.rows).toBe(1);
    expect(plan.tiles).toHaveLength(1);
    expect(at(plan.tiles, 0).tileNumber).toBe(1);
    expect(at(plan.tiles, 0).bbox).toStrictEqual(region.bbox);
    expect(findTilePlanIssues(region, plan)).toStrictEqual([]);
  });
});

describe('planTiles: Region T variants of the support file (exact values)', () => {
  const cases: [string, Region, readonly Tile[]][] = [
    ['REGION_T1', REGION_T1, T1_TILES],
    ['REGION_T2', REGION_T2, T2_TILES],
    ['REGION_T4', REGION_T4, T4_TILES],
    ['REGION_FAR', REGION_FAR, FAR_TILES],
  ];

  for (const [label, region, tiles] of cases) {
    it(`${label} gives exactly the expected Tiles`, () => {
      const plan = planTiles(region);
      expect(plan.tiles).toStrictEqual(tiles);
      expect(findTilePlanIssues(region, plan)).toStrictEqual([]);
    });
  }

  it('REGION_T4 is 2 columns x 2 rows, REGION_T2 is 2 columns x 1 row', () => {
    expect([planTiles(REGION_T4).columns, planTiles(REGION_T4).rows]).toStrictEqual([2, 2]);
    expect([planTiles(REGION_T2).columns, planTiles(REGION_T2).rows]).toStrictEqual([2, 1]);
  });
});

describe('planTiles: plan-level fields', () => {
  it('carries the Region name, bbox and Tile Size', () => {
    const plan = planTiles(REGION_T4);
    expect(plan.regionName).toBe(REGION_T4.name);
    expect(plan.bbox).toStrictEqual(REGION_T4.bbox);
    expect(plan.tileSize).toStrictEqual(REGION_T4.tileSize);
  });

  it('bbox and tileSize are fresh copies: mutating the plan leaves the Region unchanged', () => {
    const region = structuredClone(REGION_T4);
    const before = structuredClone(region);
    const plan = planTiles(region);
    expect(plan.bbox).not.toBe(region.bbox);
    expect(plan.tileSize).not.toBe(region.tileSize);
    plan.bbox.west = 0;
    plan.bbox.north = 0;
    plan.tileSize.width = 1;
    plan.tileSize.height = 1;
    expect(region).toStrictEqual(before);
  });

  it('does not change its input Region', () => {
    const region = structuredClone(BELGRADE_SMALL_REGION);
    const before = structuredClone(region);
    planTiles(region);
    expect(region).toStrictEqual(before);
  });
});

describe('planTiles: stability (AC-4)', () => {
  it('two calls and a call on a structured clone give identical plans', () => {
    const first = planTiles(BELGRADE_SMALL_REGION);
    expect(planTiles(BELGRADE_SMALL_REGION)).toStrictEqual(first);
    expect(planTiles(structuredClone(BELGRADE_SMALL_REGION))).toStrictEqual(first);
  });
});

describe('planTiles: Tile Size is per Region (AC-67)', () => {
  it('the same bbox with Tile Sizes 0.005 and 0.01 gives 4 and 1 Tiles, each with its own tileSize', () => {
    const a: Region = { name: 'region-a', bbox: SMALL_BBOX, tileSize: { width: 0.005, height: 0.005 } };
    const b: Region = { name: 'region-b', bbox: SMALL_BBOX, tileSize: { width: 0.01, height: 0.01 } };
    const pa = planTiles(a);
    const pb = planTiles(b);
    expect(pa.tiles).toHaveLength(4);
    expect(pb.tiles).toHaveLength(1);
    expect(pa.tileSize).toStrictEqual(a.tileSize);
    expect(pb.tileSize).toStrictEqual(b.tileSize);
    expect(findTilePlanIssues(a, pa)).toStrictEqual([]);
    expect(findTilePlanIssues(b, pb)).toStrictEqual([]);
  });
});
