/**
 * Pure save planning (AL4 1.3 `plan.ts`, 1.4.5 Listing Save, 1.4.6 Details Save). Compares the
 * incoming Client values with the stored rows and decides which writes a save needs and which
 * outcome it reports. No Knex, no SQL, no I/O. Inputs and state are never mutated. Numbers are
 * compared with exact `===`: no rounding, no tolerance.
 */
import { buildWikimapiaLink } from '../../contracts/storage.schema';
import type { SaveOutcomeKind, SavePlaceDetailsInput } from '../../contracts/storage.schema';
import type { PlaceSummary, Point, Tag } from '../../contracts/wikimapia-client.schema';
import {
  commentColumns,
  detailsColumns,
  encodeOutline,
  flattenComments,
  summaryColumns,
} from './mappers';
import type {
  ColumnValue,
  CommentRow,
  DetailsPlan,
  DetailsState,
  ListingPlan,
  ListingState,
  ListingWrite,
  OutlinePairs,
  PlaceDetailsWrite,
  PlaceRow,
  TagLinkRow,
} from './types';

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Pairwise exact comparison of an outline with its stored jsonb form. */
function sameOutline(outline: readonly Point[], stored: OutlinePairs): boolean {
  const pairs = encodeOutline(outline);
  if (pairs.length !== stored.length) return false;
  return pairs.every((pair, i) => {
    const other = stored[i];
    return other !== undefined && pair[0] === other[0] && pair[1] === other[1];
  });
}

/** True when any key of `columns` (except the skipped ones) differs from the row by `===`. */
function columnsDiffer(
  columns: Readonly<Record<string, ColumnValue>>,
  row: Readonly<Partial<Record<string, ColumnValue>>>,
  skip: ReadonlySet<string>,
): boolean {
  return Object.keys(columns).some((key) => !skip.has(key) && columns[key] !== row[key]);
}

const OUTLINE_ONLY: ReadonlySet<string> = new Set(['outline']);
const DETAILS_SKIP: ReadonlySet<string> = new Set(['outline', 'details_fetched_at']);
const NO_SKIP: ReadonlySet<string> = new Set();

function isSummaryOnly(row: PlaceRow): boolean {
  return row.details_fetched_at_text === null;
}

// ---------------------------------------------------------------------------
// Listing Save
// ---------------------------------------------------------------------------

/** First index of each Place ID fixes the order, the last value wins (AC-13). */
export function dedupeListing(places: readonly PlaceSummary[]): PlaceSummary[] {
  const order: number[] = [];
  const latest = new Map<number, PlaceSummary>();
  for (const place of places) {
    if (!latest.has(place.placeId)) order.push(place.placeId);
    latest.set(place.placeId, place);
  }
  const out: PlaceSummary[] = [];
  for (const id of order) {
    const place = latest.get(id);
    if (place !== undefined) out.push(place);
  }
  return out;
}

export function planListingSave(places: readonly PlaceSummary[], state: ListingState): ListingPlan {
  const rowsById = new Map<number, PlaceRow>();
  for (const row of state.rows) rowsById.set(row.place_id, row);

  const outcomes: { placeId: number; outcome: SaveOutcomeKind }[] = [];
  const writes: ListingWrite[] = [];
  for (const summary of dedupeListing(places)) {
    const row = rowsById.get(summary.placeId);
    let write: ListingWrite | undefined;
    if (row === undefined) {
      write = { kind: 'insert_summary', summary };
    } else if (isSummaryOnly(row)) {
      const differs =
        columnsDiffer(summaryColumns(summary), row, OUTLINE_ONLY) ||
        !sameOutline(summary.outline, row.outline);
      if (differs) write = { kind: 'update_summary', summary };
    } else if (row.wikimapia_url !== summary.url) {
      // D1: a detailed place only takes the link from a listing (D6, AC-63).
      write = { kind: 'update_link', placeId: summary.placeId, url: summary.url };
    }

    if (write !== undefined) writes.push(write);
    const outcome: SaveOutcomeKind =
      row === undefined ? 'created' : write !== undefined ? 'updated' : 'unchanged';
    outcomes.push({ placeId: summary.placeId, outcome });
  }
  return { outcomes, writes };
}

// ---------------------------------------------------------------------------
// Details Save
// ---------------------------------------------------------------------------

/** First occurrence of each tag id wins (title and position). */
function dedupeTags(tags: readonly Tag[]): Tag[] {
  const seen = new Set<number>();
  const out: Tag[] = [];
  for (const tag of tags) {
    if (seen.has(tag.id)) continue;
    seen.add(tag.id);
    out.push(tag);
  }
  return out;
}

function planPlaceRow(input: SavePlaceDetailsInput, row: PlaceRow | undefined): PlaceDetailsWrite | undefined {
  const { details, fetchedAt } = input;
  if (row === undefined) return { kind: 'insert', wikimapiaUrl: buildWikimapiaLink(details.placeId) };
  if (isSummaryOnly(row)) return { kind: 'update_details' };
  const differs =
    columnsDiffer(detailsColumns(details, fetchedAt), row, DETAILS_SKIP) ||
    !sameOutline(details.outline, row.outline);
  if (differs) return { kind: 'update_details' };
  if (row.details_fetched_at_text !== fetchedAt) return { kind: 'update_fetched_at' };
  return undefined;
}

export function planDetailsSave(input: SavePlaceDetailsInput, state: DetailsState): DetailsPlan {
  const { details } = input;
  const place = planPlaceRow(input, state.place);
  // D3: update_fetched_at alone is not a change.
  let changed = place !== undefined && place.kind === 'update_details';

  // Tags and links
  const tags = dedupeTags(details.tags);
  const linksByTag = new Map<number, TagLinkRow>();
  for (const link of state.links) linksByTag.set(link.tag_id, link);

  const tagUpserts: Tag[] = [];
  const linkWrites: DetailsPlan['linkWrites'] = [];
  tags.forEach((tag, position) => {
    if (state.tagTitles.get(tag.id) !== tag.title) {
      tagUpserts.push({ id: tag.id, title: tag.title });
    }
    const link = linksByTag.get(tag.id);
    if (link === undefined) {
      linkWrites.push({ kind: 'insert', tagId: tag.id, position });
    } else if (link.presence !== 'present' || link.position !== position) {
      linkWrites.push({ kind: 'update', tagId: tag.id, position });
    }
  });
  const inputTagIds = new Set(tags.map((t) => t.id));
  const goneLinks = state.links
    .filter((link) => link.presence === 'present' && !inputTagIds.has(link.tag_id))
    .map((link) => link.tag_id)
    .sort((a, b) => a - b);
  tagUpserts.sort((a, b) => a.id - b.id);

  // Comments
  const commentsByNum = new Map<number, CommentRow>();
  for (const row of state.comments) commentsByNum.set(row.num, row);

  const flats = flattenComments(details.comments);
  const commentWrites: DetailsPlan['commentWrites'] = [];
  for (const flat of flats) {
    const row = commentsByNum.get(flat.comment.num);
    if (row === undefined) {
      commentWrites.push({ kind: 'insert', flat });
    } else if (columnsDiffer(commentColumns(details.placeId, flat), row, NO_SKIP)) {
      commentWrites.push({ kind: 'update', flat });
    }
  }
  const inputNums = new Set(flats.map((flat) => flat.comment.num));
  const goneComments = state.comments
    .filter((row) => row.presence === 'present' && !inputNums.has(row.num))
    .map((row) => row.num)
    .sort((a, b) => a - b);

  changed =
    changed ||
    tagUpserts.length > 0 ||
    linkWrites.length > 0 ||
    goneLinks.length > 0 ||
    commentWrites.length > 0 ||
    goneComments.length > 0;

  const outcome: SaveOutcomeKind =
    state.place === undefined ? 'created' : changed ? 'updated' : 'unchanged';
  return { outcome, place, tagUpserts, linkWrites, goneLinks, commentWrites, goneComments };
}
