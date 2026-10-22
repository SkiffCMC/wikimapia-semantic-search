/**
 * AL2 unit tests: `src/db/geometry.ts` (AL4 1.3 `geometry.ts` block, 1.4.9 Map shapes;
 * AC-44, AC-46 .. AC-48).
 *
 * Pure. The `Knex.Raw` fragments come from a Knex handle that points at an unreachable
 * address and never connects: fragments are only inspected through `.toSQL()` and are never
 * awaited (awaiting would run them). No database, no network.
 */
import { z } from 'zod';
import type { Knex } from 'knex';
import {
  centrePointSql,
  outlineShapeSql,
  pointGeoJson,
  polygonGeoJson,
} from '../../src/db/geometry';
import { POOL_MAX_STORE, createDb, destroyQuietly } from '../../src/db/connection';
import { outlineShapeRing } from '../../contracts/storage.schema';
import { UNREACHABLE_DATABASE_URL, clientDetails } from '../../contracts/storage.support';
import type { Point } from '../../contracts/wikimapia-client.schema';

const PointGeoJsonSchema = z.strictObject({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
});

const PolygonGeoJsonSchema = z.strictObject({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

function parsePolygon(text: string): z.infer<typeof PolygonGeoJsonSchema> {
  return PolygonGeoJsonSchema.parse(JSON.parse(text));
}

/** The single ring of a parsed Polygon. */
function ringPositions(text: string): [number, number][] {
  const polygon = parsePolygon(text);
  expect(polygon.coordinates).toHaveLength(1);
  const ring = polygon.coordinates[0];
  if (ring === undefined) throw new Error('polygon has no ring');
  return ring;
}

function closedRing(outline: readonly Point[]): Point[] {
  const ring = outlineShapeRing(outline);
  if (ring === undefined) throw new Error('outline gets no outline shape');
  return ring;
}

function pairs(points: readonly Point[]): [number, number][] {
  return points.map((p): [number, number] => [p.lon, p.lat]);
}

const A: Point = { lon: 20.4566, lat: 44.8198 };
const B: Point = { lon: 20.4575, lat: 44.8204 };
const C: Point = { lon: 20.459, lat: 44.8191 };
const D: Point = { lon: 20.4584, lat: 44.8187 };

const OPEN_3: Point[] = [A, B, C];
const CLOSED_4: Point[] = [A, B, C, A];
const BOW_TIE: Point[] = [
  { lon: 20.456, lat: 44.818 },
  { lon: 20.459, lat: 44.821 },
  { lon: 20.459, lat: 44.818 },
  { lon: 20.456, lat: 44.821 },
];

/** Every coordinate of an outline as text, to prove none is interpolated into SQL. */
function coordinateTexts(points: readonly Point[]): string[] {
  return points.flatMap((p) => [String(p.lon), String(p.lat)]);
}

let db: Knex | undefined;

function handle(): Knex {
  if (db === undefined) throw new Error('knex handle not created');
  return db;
}

beforeAll(() => {
  db = createDb(UNREACHABLE_DATABASE_URL, POOL_MAX_STORE);
});

afterAll(async () => {
  await destroyQuietly(db);
  db = undefined;
});

// ---------------------------------------------------------------------------
// 1. pointGeoJson
// ---------------------------------------------------------------------------

describe('pointGeoJson', () => {
  it('parses to a GeoJSON Point [lon, lat]', () => {
    const text = pointGeoJson(20.4573249816895, 44.8165469050407);
    expect(PointGeoJsonSchema.parse(JSON.parse(text))).toStrictEqual({
      type: 'Point',
      coordinates: [20.4573249816895, 44.8165469050407],
    });
  });

  it('keeps doubles exactly (no rounding)', () => {
    const lon = 0.1 + 0.2;
    const lat = -(0.1 + 0.7);
    const parsed = PointGeoJsonSchema.parse(JSON.parse(pointGeoJson(lon, lat)));
    expect(parsed.coordinates[0]).toBe(lon);
    expect(parsed.coordinates[1]).toBe(lat);
  });
});

// ---------------------------------------------------------------------------
// 2. polygonGeoJson
// ---------------------------------------------------------------------------

describe('polygonGeoJson', () => {
  it('an open 3-point outline closed by outlineShapeRing gives 4 positions, last = first', () => {
    const ring = ringPositions(polygonGeoJson(closedRing(OPEN_3)));
    expect(ring).toHaveLength(4);
    expect(ring).toStrictEqual([...pairs(OPEN_3), [A.lon, A.lat]]);
    expect(ring[3]).toStrictEqual(ring[0]);
  });

  it('an already closed 4-point outline keeps exactly 4 positions (AC-46)', () => {
    const ring = ringPositions(polygonGeoJson(closedRing(CLOSED_4)));
    expect(ring).toHaveLength(4);
    expect(ring).toStrictEqual(pairs(CLOSED_4));
  });

  it('gives exactly the positions it was given, in order', () => {
    const ring = ringPositions(polygonGeoJson([A, B, C, D, A]));
    expect(ring).toStrictEqual(pairs([A, B, C, D, A]));
  });

  it('round-trips coordinates exactly, without rounding', () => {
    const odd = 0.1 + 0.2;
    const points: Point[] = [
      { lon: 20.4573249816895, lat: 44.8165469050407 },
      { lon: odd, lat: odd },
      { lon: 20.45812345678901, lat: 44.81712345678901 },
      { lon: 20.4573249816895, lat: 44.8165469050407 },
    ];
    const ring = ringPositions(polygonGeoJson(points));
    expect(ring).toStrictEqual(pairs(points));
    expect(ring[1]?.[0]).toBe(odd);
    expect(ring[0]?.[0]).toBe(20.4573249816895);
    expect(ring[0]?.[1]).toBe(44.8165469050407);
  });

  it('the 19-point outline of 62587 gives 20 positions in order, closed with the first (AC-44)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    expect(d.outline).toHaveLength(19);
    const first = d.outline[0];
    if (first === undefined) throw new Error('62587 has no outline');
    const ring = ringPositions(polygonGeoJson(closedRing(d.outline)));
    expect(ring).toHaveLength(20);
    expect(ring).toStrictEqual([...pairs(d.outline), [first.lon, first.lat]]);
  });
});

// ---------------------------------------------------------------------------
// 3. centrePointSql
// ---------------------------------------------------------------------------

describe('centrePointSql', () => {
  it('binds exactly [lon, lat] and builds an SRID 4326 point without coordinate text', () => {
    const lon = 20.4573249816895;
    const lat = 44.8165469050407;
    const sql = centrePointSql(handle(), { lon, lat }).toSQL();
    expect(sql.bindings).toStrictEqual([lon, lat]);
    expect(sql.sql).toContain('ST_MakePoint');
    expect(sql.sql).toContain('ST_SetSRID');
    expect(sql.sql).toContain('4326');
    expect(sql.sql).not.toContain(String(lon));
    expect(sql.sql).not.toContain(String(lat));
    expect(sql.sql).not.toContain('20.457');
    expect(sql.sql).not.toContain('44.816');
  });
});

// ---------------------------------------------------------------------------
// 4. outlineShapeSql
// ---------------------------------------------------------------------------

describe('outlineShapeSql', () => {
  const noShape: [string, Point[]][] = [
    ['no points', []],
    ['1 point', [A]],
    ['2 points', [A, B]],
    ['closed A, B, A (AC-48, approved contract choice)', [A, B, A]],
  ];

  it.each(noShape)('returns null for %s', (_name, outline) => {
    expect(outlineShapeSql(handle(), outline)).toBeNull();
  });

  const withShape: [string, Point[]][] = [
    ['an open 3-point outline', OPEN_3],
    ['a closed 4-point outline (AC-46)', CLOSED_4],
    ['a self-crossing bow tie of 4 points (AC-47)', BOW_TIE],
  ];

  it.each(withShape)(
    'for %s binds only the GeoJSON of the closed ring, SRID 4326',
    (_name, outline) => {
      const raw = outlineShapeSql(handle(), outline);
      expect(raw).not.toBeNull();
      if (raw === null) return;
      const sql = raw.toSQL();
      expect(sql.sql).toContain('ST_GeomFromGeoJSON');
      expect(sql.sql).toContain('4326');
      expect(sql.bindings).toStrictEqual([polygonGeoJson(closedRing(outline))]);
      for (const text of coordinateTexts(outline)) expect(sql.sql).not.toContain(text);
    },
  );

  it('the bow tie is bound as given plus the closing point (no repair)', () => {
    const raw = outlineShapeSql(handle(), BOW_TIE);
    if (raw === null) throw new Error('bow tie got no shape');
    const binding = raw.toSQL().bindings[0];
    expect(typeof binding).toBe('string');
    const first = BOW_TIE[0];
    if (typeof binding !== 'string' || first === undefined) return;
    expect(ringPositions(binding)).toStrictEqual([...pairs(BOW_TIE), [first.lon, first.lat]]);
  });

  it.each([...noShape, ...withShape])('never mutates the input (%s)', (_name, outline) => {
    const copy = structuredClone(outline);
    outlineShapeSql(handle(), outline);
    expect(outline).toStrictEqual(copy);
  });
});
