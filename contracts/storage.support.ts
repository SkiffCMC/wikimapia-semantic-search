/**
 * AL5 CONTRACT SUPPORT: inputs and helpers for the `storage` contracts.
 *
 * Layer:    AL5 (Contracts). Not part of the subject under test.
 * Derives:  docs/al6-requirements/20261021-storage-al6.md (section 3 preamble: test inputs are
 *           the Client's reading of the trimmed fixtures, or small synthetic values with the
 *           same field values; AC-34 synthetic nesting; AC-60 .. AC-62)
 * Enforces: .agrules section 4 (recorded fixtures only from contracts/fixtures/wikimapia/, no
 *           live network, synthetic API key, no connection string committed).
 *
 * "The Client's reading of a fixture" is produced by the real, finished Wikimapia Client
 * (`createWikimapiaClient`, feature `wikimapia-client`) fed by the Simulated Wikimapia, so the
 * Place Store receives exactly what the crawl will give it. The Place Store itself is never
 * doubled.
 */
import { createWikimapiaClient } from '../src/wikimapia/client';
import {
  DATABASE_URL_ENV,
  TEST_DATABASE_NAME_SUFFIX,
  TEST_DATABASE_URL_ENV,
} from './storage.schema';
import type { DetailedPlace, StoredComment, StoredPlace, StoredTag } from './storage.schema';
import {
  ListingPageSchema,
  PlaceDetailsSchema,
  type Comment,
  type ListingPage,
  type PlaceDetails,
  type PlaceSummary,
} from './wikimapia-client.schema';
import {
  SimulatedClock,
  SimulatedWikimapia,
  TEST_API_KEY,
  fixtureAnswer,
  type FixtureName,
} from './wikimapia-client.support';

export { at } from './wikimapia-client.support';

// ---------------------------------------------------------------------------
// Test Database (AC-60, AC-61)
// ---------------------------------------------------------------------------

/**
 * Connection string of the Test Database from `TEST_DATABASE_URL`. Fails loudly (never skips)
 * when unset, when its database name does not end in `_test`, or when it equals
 * `DATABASE_URL` (the Development Database).
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env[TEST_DATABASE_URL_ENV];
  if (url === undefined || url.trim() === '') {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} is not set: storage contract tests need the Test Database`,
    );
  }
  const name = databaseName(url);
  if (!name.endsWith(TEST_DATABASE_NAME_SUFFIX)) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} must name a database ending in "${TEST_DATABASE_NAME_SUFFIX}"`,
    );
  }
  const devUrl = process.env[DATABASE_URL_ENV];
  if (
    devUrl !== undefined &&
    devUrl.trim() !== '' &&
    databaseName(devUrl) === name &&
    sameServer(devUrl, url)
  ) {
    throw new Error(`${TEST_DATABASE_URL_ENV} must not point to the Development Database`);
  }
  return url;
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function sameServer(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.hostname === ub.hostname && ua.port === ub.port;
}

/**
 * A syntactically valid connection string to a port where nothing listens (AC-57), with a
 * synthetic password that must never appear in a failure.
 */
export const UNREACHABLE_PASSWORD = 'synthetic-pw-7f3a9c';
export const UNREACHABLE_DATABASE_URL = `postgres://wm_contract:${UNREACHABLE_PASSWORD}@127.0.0.1:1/wm_unreachable_test`;

// ---------------------------------------------------------------------------
// The Client's reading of the recorded fixtures
// ---------------------------------------------------------------------------

function client(name: FixtureName) {
  const wikimapia = new SimulatedWikimapia([fixtureAnswer(name)]);
  return createWikimapiaClient({
    apiKey: TEST_API_KEY,
    transport: wikimapia.transport,
    clock: new SimulatedClock(),
  });
}

/** Client reading of a `place.getbyid` fixture (fresh copy each call). */
export async function clientDetails(name: FixtureName): Promise<PlaceDetails> {
  const placeId = Number(/getbyid-(\d+)/.exec(name)?.[1] ?? '1');
  const result = await client(name).getPlaceDetails({ placeId });
  if (!result.ok) throw new Error(`client could not read ${name}: ${result.failure.kind}`);
  return PlaceDetailsSchema.parse(result.value);
}

/** Client reading of a `box` fixture (fresh copy each call). */
export async function clientListing(name: FixtureName): Promise<ListingPage> {
  const bbox = { west: 20.452, south: 44.814, east: 20.462, north: 44.82 };
  const result = await client(name).listPlaces({ bbox, page: 1 });
  if (!result.ok) throw new Error(`client could not read ${name}: ${result.failure.kind}`);
  return ListingPageSchema.parse(result.value);
}

export function summaryOf(page: ListingPage, placeId: number): PlaceSummary {
  const summary = page.places.find((p) => p.placeId === placeId);
  if (summary === undefined) throw new Error(`listing has no place ${String(placeId)}`);
  return summary;
}

/** A Listing Page holding exactly the given summaries (page 1, page size 10, 290 found). */
export function listingOf(...places: PlaceSummary[]): ListingPage {
  return { page: 1, pageSize: 10, totalFound: 290, places };
}

export function commentNum(comments: readonly Comment[], num: number): Comment {
  const comment = comments.find((c) => c.num === num);
  if (comment === undefined) throw new Error(`no comment number ${String(num)}`);
  return comment;
}

// ---------------------------------------------------------------------------
// Synthetic values (AC-34 nesting, D5: every Comment carries Place ID 62587)
// ---------------------------------------------------------------------------

export const FETCHED_AT = '2026-10-21T10:00:00Z';
export const LATER_FETCHED_AT = '2026-10-22T08:30:00Z';
export const EVEN_LATER_FETCHED_AT = '2026-10-23T12:00:00Z';

/** A Comment with the field values of `base`, re-homed to `placeId` and given `num` and replies. */
export function rehome(
  base: Comment,
  placeId: number,
  num: number,
  replies: Comment[] = [],
): Comment {
  return { ...base, placeId, num, replies };
}

export interface NestedParts {
  mateja: Comment;
  serbia: Comment;
  paul: Comment;
  ramona: Comment;
}

/**
 * Field values of "Mateja" (62587 #1), "Serbia" (62587 #2), "Paul" (55 #5) and "Ramona" (55 #1)
 * from the Client's reading of the recorded fixtures, with no replies. "Paul" and "Ramona" are
 * re-homed to Place 62587 (Paul keeps #5, Ramona becomes #7) as decision D5 requires.
 */
export async function nestedParts(): Promise<NestedParts> {
  const square = await clientDetails('getbyid-62587.json');
  const eiffel = await clientDetails('getbyid-55.json');
  return {
    mateja: rehome(commentNum(square.comments, 1), 62587, 1),
    serbia: rehome(commentNum(square.comments, 2), 62587, 2),
    paul: rehome(commentNum(eiffel.comments, 5), 62587, 5),
    ramona: rehome(commentNum(eiffel.comments, 1), 62587, 7),
  };
}

/** AC-34: Place 62587 where Mateja (#1) > Serbia (#2) > Paul (#5), all with Place ID 62587. */
export async function nestedDetails(): Promise<PlaceDetails> {
  const square = await clientDetails('getbyid-62587.json');
  const { mateja, serbia, paul } = await nestedParts();
  return {
    ...square,
    comments: [{ ...mateja, replies: [{ ...serbia, replies: [paul] }] }],
  };
}

/** A shallow copy of `value` without the given keys (for "item missing" inputs). */
export function omitKeys<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !drop.has(key))) as Omit<T, K>;
}

// ---------------------------------------------------------------------------
// Read-back helpers
// ---------------------------------------------------------------------------

/** Removes Presence Marks recursively, giving the Client's Comment shape. */
export function withoutPresence(comment: StoredComment): Comment {
  const rest = omitKeys(comment, 'presence', 'replies');
  return { ...rest, replies: comment.replies.map(withoutPresence) };
}

export function tagsWithoutPresence(tags: readonly StoredTag[]): { id: number; title: string }[] {
  return tags.map(({ id, title }) => ({ id, title }));
}

/** The Client's Place Details as they read back from a Detailed Place (AC-18). */
export function asPlaceDetails(place: DetailedPlace): PlaceDetails {
  const details: PlaceDetails = {
    placeId: place.placeId,
    title: place.name,
    description: place.description,
    tags: tagsWithoutPresence(place.tags),
    isBuilding: place.isBuilding,
    isRegion: place.isRegion,
    isDeleted: place.isDeleted,
    outline: place.outline,
    location: place.location,
    comments: place.comments.map(withoutPresence),
  };
  if (place.parentPlaceId !== undefined) details.parentPlaceId = place.parentPlaceId;
  if (place.wikipediaUrl !== undefined) details.wikipediaUrl = place.wikipediaUrl;
  return details;
}

/** Every Comment and Reply at any depth, depth first, in read-back order. */
export function flattenComments(comments: readonly StoredComment[]): StoredComment[] {
  return comments.flatMap((c) => [c, ...flattenComments(c.replies)]);
}

/** Every Presence Mark of a Place (tags and comments at any depth). */
export function presenceMarks(place: StoredPlace): string[] {
  return [
    ...place.tags.map((t) => `tag ${String(t.id)}: ${t.presence}`),
    ...flattenComments(place.comments).map((c) => `comment ${String(c.num)}: ${c.presence}`),
  ];
}

/** The top-level Comment (or Reply, via `.replies`) with this number. */
export function storedNum(comments: readonly StoredComment[], num: number): StoredComment {
  const comment = comments.find((c) => c.num === num);
  if (comment === undefined)
    throw new Error(`no stored comment number ${String(num)} at this level`);
  return comment;
}

/** `[num, presence]` pairs of one level of Comments, in read-back order. */
export function levelOrder(comments: readonly StoredComment[]): [number, string][] {
  return comments.map((c) => [c.num, c.presence]);
}

/** Description of at least 7,000 characters mixing Cyrillic, Latin diacritics, line breaks and entities (AC-32). */
export function longMixedDescription(seed: string): string {
  const parts = [
    seed,
    'Трг Републике — Đinđić, Kolarčeva, Dorćol, Zeleni Venac.\n',
    'He said &quot;meet me at the horse&quot; &amp; left.\r\n',
  ];
  let text = '';
  while (text.length < 7000) text += parts.join('\n\n');
  return text;
}
