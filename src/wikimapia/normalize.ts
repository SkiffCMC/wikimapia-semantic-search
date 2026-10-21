/**
 * Normalisation (AL4 1.4.6, section 2): maps validated raw Wikimapia wire objects to strict
 * output objects. Every output object is built field by field (allow-list); raw objects are
 * never spread, and `user_ip` is never read (.agrules section 4, No Commenter IPs).
 */
import type { z } from 'zod';
import {
  ListingPageSchema,
  MAX_PAGE_SIZE,
  PlaceDetailsSchema,
  isWikimapiaPlaceUrl,
  type BoundsLocation,
  type Comment,
  type FailureIssue,
  type ListingPage,
  type Location,
  type PlaceDetails,
  type PlaceSummary,
  type Point,
  type RawBoxResponse,
  type RawComment,
  type RawPlaceDetails,
  type RawPoint,
} from '../../contracts/wikimapia-client.schema.js';
import { toFailureIssues } from './issues.js';

export type Normalized<T> = { ok: true; value: T } | { ok: false; issues: FailureIssue[] };

const UNSAFE_ID_MESSAGE = 'id is not a safe whole number';

function toWhole(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function presentText(v: string | null | undefined): string | undefined {
  return v === null || v === undefined || v === '' ? undefined : v;
}

function toPoint(raw: RawPoint): Point {
  return { lon: raw.x, lat: raw.y };
}

function toBounds(raw: BoundsLocation): BoundsLocation {
  return {
    lon: raw.lon,
    lat: raw.lat,
    north: raw.north,
    south: raw.south,
    east: raw.east,
    west: raw.west,
  };
}

function gate<T>(result: z.ZodSafeParseResult<T>): Normalized<T> {
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: toFailureIssues(result.error.issues).map((issue) => ({
      path: issue.path,
      message: `output check: ${issue.message}`,
    })),
  };
}

export function normalizeListingPage(raw: RawBoxResponse): Normalized<ListingPage> {
  const issues: FailureIssue[] = [];
  const page = toWhole(raw.page);
  const count = toWhole(raw.count);
  const found = toWhole(raw.found);
  if (!(page >= 1)) issues.push({ path: ['page'], message: 'page must be at least 1' });
  if (!(count >= 1 && count <= MAX_PAGE_SIZE)) {
    issues.push({ path: ['count'], message: `count must be between 1 and ${String(MAX_PAGE_SIZE)}` });
  }
  if (!Number.isSafeInteger(found)) {
    issues.push({ path: ['found'], message: 'found is not a safe whole number' });
  }
  raw.folder.forEach((place, i) => {
    const id = toWhole(place.id);
    if (!Number.isSafeInteger(id)) {
      issues.push({ path: ['folder', i, 'id'], message: UNSAFE_ID_MESSAGE });
    }
    if (!isWikimapiaPlaceUrl(place.url, id)) {
      issues.push({
        path: ['folder', i, 'url'],
        message: 'url is not the Wikimapia page link of this place',
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  const places = raw.folder.map(
    (place): PlaceSummary => ({
      placeId: toWhole(place.id),
      name: place.name,
      url: place.url,
      location: toBounds(place.location),
      outline: place.polygon.map(toPoint),
    }),
  );
  const built: ListingPage = { page, pageSize: count, totalFound: found, places };
  return gate(ListingPageSchema.safeParse(built));
}

export function normalizeComment(raw: RawComment): Comment {
  const authorPhotoUrl = presentText(raw.user_photo);
  const moderatorName = presentText(raw.moder_name);
  return {
    placeId: raw.place_id,
    num: raw.num,
    langId: raw.lang_id,
    author: raw.name,
    authorUserId: raw.user_id,
    ...(authorPhotoUrl === undefined ? {} : { authorPhotoUrl }),
    message: raw.message,
    goodVotes: raw.good,
    badVotes: raw.bad,
    isBlocked: raw.block,
    isDeleted: raw.is_deleted,
    postedAtEpochSeconds: raw.date,
    moderatorUserId: raw.moder_uid,
    ...(moderatorName === undefined ? {} : { moderatorName }),
    replies: raw.replies.map(normalizeComment),
  };
}

function toLocation(raw: RawPlaceDetails['location']): Location {
  const location: Location = toBounds(raw);
  const street = presentText(raw.street);
  const houseNumber = presentText(raw.housenumber);
  const city = presentText(raw.city);
  const place = presentText(raw.place);
  const state = presentText(raw.state);
  const country = presentText(raw.country);
  if (street !== undefined) location.street = street;
  if (houseNumber !== undefined) location.houseNumber = houseNumber;
  if (city !== undefined) location.city = city;
  if (place !== undefined) location.place = place;
  if (state !== undefined) location.state = state;
  if (country !== undefined) location.country = country;
  return location;
}

export function normalizePlaceDetails(raw: RawPlaceDetails): Normalized<PlaceDetails> {
  const issues: FailureIssue[] = [];
  const placeId = toWhole(raw.id);
  const parentId = toWhole(raw.parent_id);
  if (!Number.isSafeInteger(placeId)) issues.push({ path: ['id'], message: UNSAFE_ID_MESSAGE });
  if (!Number.isSafeInteger(parentId)) {
    issues.push({ path: ['parent_id'], message: UNSAFE_ID_MESSAGE });
  }
  if (issues.length > 0) return { ok: false, issues };

  const wikipediaUrl = presentText(raw.wikipedia);
  const built: PlaceDetails = {
    placeId,
    title: raw.title,
    description: raw.description,
    tags: raw.tags.map((tag) => ({ id: tag.id, title: tag.title })),
    ...(parentId === 0 ? {} : { parentPlaceId: parentId }),
    isBuilding: raw.is_building,
    isRegion: raw.is_region,
    isDeleted: raw.is_deleted,
    ...(wikipediaUrl === undefined ? {} : { wikipediaUrl }),
    outline: raw.polygon.map(toPoint),
    location: toLocation(raw.location),
    comments: raw.comments.map(normalizeComment),
  };
  return gate(PlaceDetailsSchema.safeParse(built));
}
