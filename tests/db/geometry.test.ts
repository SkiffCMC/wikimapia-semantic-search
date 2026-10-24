/**
 * AL2 unit tests: `src/db/geometry.ts` (AL4 1.4.9). The contract tests store and read back
 * shapes; here: exact Point text and that coordinates travel only as bindings (`.toSQL()` on a
 * Knex handle that never connects).
 */
import knex from 'knex';
import {
  centrePointSql,
  outlineShapeSql,
  pointGeoJson,
  polygonGeoJson,
} from '../../src/db/geometry';

const db = knex({ client: 'pg' });
afterAll(() => db.destroy());

const A = { lon: 20.4566, lat: 44.8198 };
const B = { lon: 20.4575, lat: 44.8204 };
const C = { lon: 20.459, lat: 44.8191 };

it('pointGeoJson keeps doubles exactly', () => {
  const lon = 0.1 + 0.2;
  expect(JSON.parse(pointGeoJson(lon, -44.8))).toStrictEqual({
    type: 'Point',
    coordinates: [lon, -44.8],
  });
});

it('coordinates are bindings, never SQL text', () => {
  const point = centrePointSql(db, A).toSQL();
  expect(point.bindings).toStrictEqual([A.lon, A.lat]);
  const outline = outlineShapeSql(db, [A, B, C])?.toSQL();
  expect(outline?.bindings).toStrictEqual([polygonGeoJson([A, B, C, A])]);
  for (const sql of [point.sql, outline?.sql]) expect(sql).not.toMatch(/20\.45|44\.8/);
});
