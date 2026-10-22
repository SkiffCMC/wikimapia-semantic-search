/**
 * Pure mapping (AL4 1.3 `mappers.ts`, 1.4.6, 1.4.8, 2.2 .. 2.5): contract values <-> column
 * values, outline encoding, comment flattening (pre-order with parent and position), comment
 * tree rebuild and ordering, tag ordering and read-back assembly. No Knex, no SQL, no I/O.
 * Inputs are never mutated.
 */
import type {
  DetailedPlace,
  StoredComment,
  StoredTag,
  SummaryOnlyPlace,
} from '../../contracts/storage.schema';
import type {
  Comment,
  Location,
  PlaceDetails,
  PlaceSummary,
  Point,
} from '../../contracts/wikimapia-client.schema';
import type {
  CommentColumns,
  CommentPatchColumns,
  CommentRow,
  DetailsColumns,
  FlatComment,
  OutlinePairs,
  PlaceRow,
  SummaryColumns,
  TagLinkRow,
} from './types';

const NOT_DETAILED = 'stored place row is not a detailed place';

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export function encodeOutline(outline: readonly Point[]): OutlinePairs {
  return outline.map((p): [number, number] => [p.lon, p.lat]);
}

export function decodeOutline(pairs: OutlinePairs): Point[] {
  return pairs.map(([lon, lat]) => ({ lon, lat }));
}

// ---------------------------------------------------------------------------
// Contract values -> columns
// ---------------------------------------------------------------------------

export function summaryColumns(summary: PlaceSummary): SummaryColumns {
  return {
    name: summary.name,
    wikimapia_url: summary.url,
    location_lon: summary.location.lon,
    location_lat: summary.location.lat,
    bound_north: summary.location.north,
    bound_south: summary.location.south,
    bound_east: summary.location.east,
    bound_west: summary.location.west,
    outline: encodeOutline(summary.outline),
  };
}

/** Every key is always present, so an update overwrites a removed item with `null` (AC-24). */
export function detailsColumns(details: PlaceDetails, fetchedAt: string): DetailsColumns {
  const { location } = details;
  return {
    name: details.title,
    description: details.description,
    is_building: details.isBuilding,
    is_region: details.isRegion,
    is_deleted: details.isDeleted,
    parent_place_id: details.parentPlaceId ?? null,
    wikipedia_url: details.wikipediaUrl ?? null,
    location_lon: location.lon,
    location_lat: location.lat,
    bound_north: location.north,
    bound_south: location.south,
    bound_east: location.east,
    bound_west: location.west,
    address_street: location.street ?? null,
    address_house_number: location.houseNumber ?? null,
    address_city: location.city ?? null,
    address_place: location.place ?? null,
    address_state: location.state ?? null,
    address_country: location.country ?? null,
    outline: encodeOutline(details.outline),
    details_fetched_at: fetchedAt,
  };
}

/** Pre-order depth-first walk: a parent always comes before its replies. */
export function flattenComments(comments: readonly Comment[]): FlatComment[] {
  const out: FlatComment[] = [];
  const walk = (siblings: readonly Comment[], parentNum: number | null): void => {
    siblings.forEach((comment, position) => {
      out.push({ comment, parentNum, position });
      walk(comment.replies, comment.num);
    });
  };
  walk(comments, null);
  return out;
}

/** Every comment column except the key (`place_id`, `num`), in column order. */
export function commentPatchColumns(flat: FlatComment): CommentPatchColumns {
  const { comment } = flat;
  return {
    parent_num: flat.parentNum,
    lang_id: comment.langId,
    author: comment.author,
    author_user_id: comment.authorUserId,
    author_photo_url: comment.authorPhotoUrl ?? null,
    message: comment.message,
    good_votes: comment.goodVotes,
    bad_votes: comment.badVotes,
    is_blocked: comment.isBlocked,
    is_deleted: comment.isDeleted,
    posted_at_epoch_seconds: comment.postedAtEpochSeconds,
    moderator_user_id: comment.moderatorUserId,
    moderator_name: comment.moderatorName ?? null,
    presence: 'present',
    position: flat.position,
  };
}

export function commentColumns(placeId: number, flat: FlatComment): CommentColumns {
  return { place_id: placeId, num: flat.comment.num, ...commentPatchColumns(flat) };
}

// ---------------------------------------------------------------------------
// Rows -> read-back values
// ---------------------------------------------------------------------------

/** Present first by position (then key), then gone by key (AC-52, AC-72). */
function comparePresenceOrder(
  a: { presence: 'present' | 'gone'; position: number | null; key: number },
  b: { presence: 'present' | 'gone'; position: number | null; key: number },
): number {
  if (a.presence !== b.presence) return a.presence === 'present' ? -1 : 1;
  if (a.presence === 'present') {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
  }
  return a.key - b.key;
}

function sortSiblings(rows: readonly CommentRow[]): CommentRow[] {
  return [...rows].sort((a, b) =>
    comparePresenceOrder(
      { presence: a.presence, position: a.position, key: a.num },
      { presence: b.presence, position: b.position, key: b.num },
    ),
  );
}

function storedCommentNode(row: CommentRow, replies: StoredComment[]): StoredComment {
  const node: StoredComment = {
    placeId: row.place_id,
    num: row.num,
    langId: row.lang_id,
    author: row.author,
    authorUserId: row.author_user_id,
    message: row.message,
    goodVotes: row.good_votes,
    badVotes: row.bad_votes,
    isBlocked: row.is_blocked,
    isDeleted: row.is_deleted,
    postedAtEpochSeconds: row.posted_at_epoch_seconds,
    moderatorUserId: row.moderator_user_id,
    presence: row.presence,
    replies,
  };
  if (row.author_photo_url !== null) node.authorPhotoUrl = row.author_photo_url;
  if (row.moderator_name !== null) node.moderatorName = row.moderator_name;
  return node;
}

/**
 * Rebuilds the reply tree. Each sibling list: present by position, then gone by num. Defensive
 * rule (AL4 1.4.8): rows not reachable from the top level (missing parent, cycle) are appended
 * at the top level in ascending num with their unvisited descendants; every row appears once.
 */
export function buildStoredComments(rows: readonly CommentRow[]): StoredComment[] {
  const children = new Map<number | null, CommentRow[]>();
  for (const row of rows) {
    const group = children.get(row.parent_num);
    if (group === undefined) children.set(row.parent_num, [row]);
    else group.push(row);
  }
  const visited = new Set<number>();
  const build = (siblings: readonly CommentRow[]): StoredComment[] => {
    const out: StoredComment[] = [];
    for (const row of sortSiblings(siblings)) {
      if (visited.has(row.num)) continue;
      visited.add(row.num);
      out.push(storedCommentNode(row, build(children.get(row.num) ?? [])));
    }
    return out;
  };

  const tree = build(children.get(null) ?? []);
  const byNum = [...rows].sort((a, b) => a.num - b.num);
  for (const row of byNum) {
    if (!visited.has(row.num)) tree.push(...build([row]));
  }
  return tree;
}

export function orderStoredTags(rows: readonly TagLinkRow[]): StoredTag[] {
  return [...rows]
    .sort((a, b) =>
      comparePresenceOrder(
        { presence: a.presence, position: a.position, key: a.tag_id },
        { presence: b.presence, position: b.position, key: b.tag_id },
      ),
    )
    .map((row) => ({ id: row.tag_id, title: row.title, presence: row.presence }));
}

export function toSummaryOnlyPlace(row: PlaceRow): SummaryOnlyPlace {
  return {
    status: 'summary_only',
    placeId: row.place_id,
    name: row.name,
    wikimapiaUrl: row.wikimapia_url,
    location: {
      lon: row.location_lon,
      lat: row.location_lat,
      north: row.bound_north,
      south: row.bound_south,
      east: row.bound_east,
      west: row.bound_west,
    },
    outline: decodeOutline(row.outline),
    tags: [],
    comments: [],
  };
}

function detailedLocation(row: PlaceRow): Location {
  const location: Location = {
    lon: row.location_lon,
    lat: row.location_lat,
    north: row.bound_north,
    south: row.bound_south,
    east: row.bound_east,
    west: row.bound_west,
  };
  if (row.address_street !== null) location.street = row.address_street;
  if (row.address_house_number !== null) location.houseNumber = row.address_house_number;
  if (row.address_city !== null) location.city = row.address_city;
  if (row.address_place !== null) location.place = row.address_place;
  if (row.address_state !== null) location.state = row.address_state;
  if (row.address_country !== null) location.country = row.address_country;
  return location;
}

/**
 * Throws a fixed, value-free error when a required details column is null (impossible under
 * the `places_details_consistent` check); the caller maps it to `store_unavailable`.
 */
export function toDetailedPlace(
  row: PlaceRow,
  links: readonly TagLinkRow[],
  comments: readonly CommentRow[],
): DetailedPlace {
  const { description, is_building, is_region, is_deleted, details_fetched_at_text } = row;
  if (
    description === null ||
    is_building === null ||
    is_region === null ||
    is_deleted === null ||
    details_fetched_at_text === null
  ) {
    throw new Error(NOT_DETAILED);
  }
  const place: DetailedPlace = {
    status: 'detailed',
    placeId: row.place_id,
    name: row.name,
    wikimapiaUrl: row.wikimapia_url,
    description,
    tags: orderStoredTags(links),
    isBuilding: is_building,
    isRegion: is_region,
    isDeleted: is_deleted,
    outline: decodeOutline(row.outline),
    location: detailedLocation(row),
    comments: buildStoredComments(comments),
    detailsFetchedAt: details_fetched_at_text,
  };
  if (row.parent_place_id !== null) place.parentPlaceId = row.parent_place_id;
  if (row.wikipedia_url !== null) place.wikipediaUrl = row.wikipedia_url;
  return place;
}
