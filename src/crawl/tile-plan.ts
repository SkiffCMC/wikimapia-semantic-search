/**
 * Tile Plan (AL4 1.4.2; AC-2, AC-3, AC-4, AC-66, AC-67). Pure and deterministic: rows south to
 * north, west to east within a row. The first and last edges are the Region edges themselves;
 * inner edges are rounded to 9 decimals to remove float noise. The input is a valid Region.
 */
import { cellsCovering, type PlanTilesFn, type Tile } from '../../contracts/hydration.schema';

function round9(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

export const planTiles: PlanTilesFn = (region) => {
  const { west, south, east, north } = region.bbox;
  const { width, height } = region.tileSize;
  const columns = cellsCovering(east - west, width);
  const rows = cellsCovering(north - south, height);
  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r += 1) {
    const ts = r === 0 ? south : round9(south + r * height);
    const tn = r === rows - 1 ? north : round9(south + (r + 1) * height);
    for (let c = 0; c < columns; c += 1) {
      const tw = c === 0 ? west : round9(west + c * width);
      const te = c === columns - 1 ? east : round9(west + (c + 1) * width);
      tiles.push({ tileNumber: r * columns + c + 1, bbox: { west: tw, south: ts, east: te, north: tn } });
    }
  }
  return {
    regionName: region.name,
    bbox: { ...region.bbox },
    tileSize: { ...region.tileSize },
    columns,
    rows,
    tiles,
  };
};
