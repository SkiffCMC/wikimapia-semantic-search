/**
 * Map shapes (AL4 1.4.9; AC-44 .. AC-48, D4): GeoJSON text for a centre point and an outline
 * ring, and parameterized `Knex.Raw` fragments that build the PostGIS values. Coordinates always
 * travel as bindings, never as SQL text. `JSON.stringify` of a JS double gives the shortest
 * round-trip text, so nothing is rounded. Outlines are stored as given (no repair).
 */
import type { Knex } from 'knex';
import { outlineShapeRing } from '../../contracts/storage.schema';
import type { Point } from '../../contracts/wikimapia-client.schema';

export function pointGeoJson(lon: number, lat: number): string {
  return JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
}

export function polygonGeoJson(ring: readonly Point[]): string {
  return JSON.stringify({ type: 'Polygon', coordinates: [ring.map((p) => [p.lon, p.lat])] });
}

export function centrePointSql(
  db: Knex | Knex.Transaction,
  location: { lon: number; lat: number },
): Knex.Raw {
  return db.raw('ST_SetSRID(ST_MakePoint(?, ?), 4326)', [location.lon, location.lat]);
}

export function outlineShapeSql(
  db: Knex | Knex.Transaction,
  outline: readonly Point[],
): Knex.Raw | null {
  const ring = outlineShapeRing(outline);
  if (ring === undefined) return null;
  return db.raw('ST_SetSRID(ST_GeomFromGeoJSON(?), 4326)', [polygonGeoJson(ring)]);
}
