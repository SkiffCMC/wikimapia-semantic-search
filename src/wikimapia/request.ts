/**
 * Request building (AL4 1.4.3): turns validated call parameters into Wikimapia request
 * URLs. Parameters are added through `URLSearchParams.set` in a fixed order, so the same
 * arguments always give the same string (AC-22). Inputs are validated by the caller (U5).
 */
import {
  PLACE_DETAILS_DATA_BLOCKS,
  WIKIMAPIA_API_URL,
  type BoundingBox,
} from '../../contracts/wikimapia-client.schema';

function baseUrl(apiFunction: string, apiKey: string, language: string | undefined): URL {
  const url = new URL(WIKIMAPIA_API_URL);
  url.searchParams.set('function', apiFunction);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('format', 'json');
  if (language !== undefined) url.searchParams.set('language', language);
  return url;
}

export function buildBoxUrl(p: {
  apiKey: string;
  language?: string;
  bbox: BoundingBox;
  page: number;
  pageSize: number;
}): string {
  const url = baseUrl('box', p.apiKey, p.language);
  const { west, south, east, north } = p.bbox;
  url.searchParams.set('bbox', [west, south, east, north].map(String).join(','));
  url.searchParams.set('page', String(p.page));
  url.searchParams.set('count', String(p.pageSize));
  return url.toString();
}

export function buildPlaceDetailsUrl(p: {
  apiKey: string;
  language?: string;
  placeId: number;
}): string {
  const url = baseUrl('place.getbyid', p.apiKey, p.language);
  url.searchParams.set('id', String(p.placeId));
  url.searchParams.set('data_blocks', PLACE_DETAILS_DATA_BLOCKS.join(','));
  return url.toString();
}
