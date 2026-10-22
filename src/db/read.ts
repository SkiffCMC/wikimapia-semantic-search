/**
 * Read queries of the Place Store (AL4 1.4.8; AC-8, AC-40 .. AC-52, AC-70). Every function runs
 * its queries on the handle it is given (`Knex` or a transaction) and never opens a transaction
 * itself: the caller wraps multi-query reads. Every result is parsed with a row schema from
 * `rows.ts`, every assembled public value is gated with its contract schema (`.parse`, which
 * throws on mismatch; the public layer maps that to `store_unavailable`). Values always travel
 * as bindings.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  PlaceTagLinkSchema,
  ReadPlaceValueSchema,
  ReadShapesValueSchema,
  STORE_TABLES,
  StoreCountsSchema,
  StoredCommentKeySchema,
  TagCatalogueSchema,
} from '../../contracts/storage.schema';
import type {
  PlaceTagLink,
  ReadPlaceValue,
  ReadShapesValue,
  StoreCounts,
  StoredCommentKey,
  TagCatalogue,
} from '../../contracts/storage.schema';
import type { PlaceDetails } from '../../contracts/wikimapia-client.schema';
import { toDetailedPlace, toSummaryOnlyPlace } from './mappers';
import {
  CommentRowSchema,
  CountsRowSchema,
  PlaceRowSchema,
  RingPointRowSchema,
  ShapeRowSchema,
  TagLinkRowSchema,
  TagRowSchema,
} from './rows';
import type {
  CommentRow,
  DetailsState,
  ListingState,
  PlaceRow,
  ShapesCandidate,
  TagLinkRow,
} from './types';

const PlaceRowsSchema = z.array(PlaceRowSchema);
const CommentRowsSchema = z.array(CommentRowSchema);
const TagRowsSchema = z.array(TagRowSchema);
const TagLinkRawSchema = z.object({ rows: z.array(TagLinkRowSchema) });
const ShapeRawSchema = z.object({ rows: z.array(ShapeRowSchema) });
const RingRawSchema = z.object({ rows: z.array(RingPointRowSchema) });
const CountsRawSchema = z.object({ rows: z.array(CountsRowSchema) });
const PlaceTagLinksSchema = z.array(PlaceTagLinkSchema);
const StoredCommentKeysSchema = z.array(StoredCommentKeySchema);

/** Every `places` column except `centre_point` and `outline_shape`. */
const PLACE_COLUMNS = [
  'place_id',
  'name',
  'wikimapia_url',
  'location_lon',
  'location_lat',
  'bound_north',
  'bound_south',
  'bound_east',
  'bound_west',
  'outline',
  'description',
  'is_building',
  'is_region',
  'is_deleted',
  'parent_place_id',
  'wikipedia_url',
  'address_street',
  'address_house_number',
  'address_city',
  'address_place',
  'address_state',
  'address_country',
];

const FETCHED_AT_TEXT_SQL =
  'to_char(details_fetched_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as details_fetched_at_text';

const TAG_LINKS_OF_PLACE_SQL =
  'select pt.place_id, pt.tag_id, pt.presence, pt.position, t.title' +
  ' from place_tags pt join tags t on t.tag_id = pt.tag_id' +
  ' where pt.place_id = ? order by pt.tag_id';

const TAG_LINKS_OF_TAG_SQL =
  'select pt.place_id, pt.tag_id, pt.presence, pt.position, t.title' +
  ' from place_tags pt join tags t on t.tag_id = pt.tag_id' +
  ' where pt.tag_id = ? order by pt.place_id';

const SHAPE_SQL =
  'select ST_SRID(centre_point) as centre_srid, GeometryType(centre_point) as centre_type,' +
  ' ST_X(centre_point) as centre_x, ST_Y(centre_point) as centre_y,' +
  ' ST_SRID(outline_shape) as outline_srid, GeometryType(outline_shape) as outline_type' +
  ' from places where place_id = ?';

const RING_SQL =
  'select ST_X(dp.geom) as x, ST_Y(dp.geom) as y' +
  ' from places p cross join lateral ST_DumpPoints(ST_ExteriorRing(p.outline_shape)) as dp' +
  ' where p.place_id = ? order by dp.path[1]';

const COUNTS_SQL =
  'select (select count(*) from places) as places,' +
  ' (select count(*) from comments) as comments,' +
  ' (select count(*) from tags) as tags,' +
  ' (select count(*) from place_tags) as place_tags';

// ---------------------------------------------------------------------------
// Row loaders (private)
// ---------------------------------------------------------------------------

async function selectPlaceRows(
  db: Knex | Knex.Transaction,
  placeIds: readonly number[],
): Promise<PlaceRow[]> {
  const result: unknown = await db
    .select([...PLACE_COLUMNS, db.raw(FETCHED_AT_TEXT_SQL)])
    .from(STORE_TABLES.places)
    .whereIn('place_id', [...placeIds])
    .orderBy('place_id');
  return PlaceRowsSchema.parse(result);
}

async function selectPlaceRow(
  db: Knex | Knex.Transaction,
  placeId: number,
): Promise<PlaceRow | undefined> {
  const [row] = await selectPlaceRows(db, [placeId]);
  return row;
}

async function selectCommentRows(
  db: Knex | Knex.Transaction,
  placeId: number,
): Promise<CommentRow[]> {
  const result: unknown = await db
    .select('*')
    .from(STORE_TABLES.comments)
    .where('place_id', placeId)
    .orderBy('num');
  return CommentRowsSchema.parse(result);
}

async function selectTagLinksOfPlace(
  db: Knex | Knex.Transaction,
  placeId: number,
): Promise<TagLinkRow[]> {
  const result: unknown = await db.raw(TAG_LINKS_OF_PLACE_SQL, [placeId]);
  return TagLinkRawSchema.parse(result).rows;
}

function geometryTypeName(type: string): string {
  if (type === 'POINT') return 'Point';
  if (type === 'POLYGON') return 'Polygon';
  return type;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function readPlaceValue(
  db: Knex | Knex.Transaction,
  placeId: number,
): Promise<ReadPlaceValue> {
  const row = await selectPlaceRow(db, placeId);
  if (row === undefined) return ReadPlaceValueSchema.parse({ found: false, placeId });
  if (row.details_fetched_at_text === null) {
    return ReadPlaceValueSchema.parse({ found: true, place: toSummaryOnlyPlace(row) });
  }
  const links = await selectTagLinksOfPlace(db, placeId);
  const comments = await selectCommentRows(db, placeId);
  return ReadPlaceValueSchema.parse({
    found: true,
    place: toDetailedPlace(row, links, comments),
  });
}

export async function readShapesValue(
  db: Knex | Knex.Transaction,
  placeId: number,
): Promise<ReadShapesValue> {
  const result: unknown = await db.raw(SHAPE_SQL, [placeId]);
  const [row] = ShapeRawSchema.parse(result).rows;
  if (row === undefined) return ReadShapesValueSchema.parse({ found: false, placeId });

  const shapes: ShapesCandidate = {
    placeId,
    centrePoint: {
      type: geometryTypeName(row.centre_type),
      srid: row.centre_srid,
      point: { lon: row.centre_x, lat: row.centre_y },
    },
  };
  if (row.outline_type !== null) {
    const ringResult: unknown = await db.raw(RING_SQL, [placeId]);
    const ring = RingRawSchema.parse(ringResult).rows.map((p) => ({ lon: p.x, lat: p.y }));
    shapes.outlineShape = {
      type: geometryTypeName(row.outline_type),
      srid: row.outline_srid,
      ring,
    };
  }
  return ReadShapesValueSchema.parse({ found: true, shapes });
}

export async function listTagCatalogue(db: Knex | Knex.Transaction): Promise<TagCatalogue> {
  const result: unknown = await db
    .select('tag_id', 'title')
    .from(STORE_TABLES.tags)
    .orderBy('tag_id');
  const rows = TagRowsSchema.parse(result);
  return TagCatalogueSchema.parse(rows.map((row) => ({ id: row.tag_id, title: row.title })));
}

export async function listLinksOfTag(
  db: Knex | Knex.Transaction,
  tagId: number,
): Promise<PlaceTagLink[]> {
  const result: unknown = await db.raw(TAG_LINKS_OF_TAG_SQL, [tagId]);
  const rows = TagLinkRawSchema.parse(result).rows;
  return PlaceTagLinksSchema.parse(
    rows.map((row) => ({ placeId: row.place_id, tagId: row.tag_id, presence: row.presence })),
  );
}

export async function listCommentKeys(
  db: Knex | Knex.Transaction,
  placeId: number,
): Promise<StoredCommentKey[]> {
  const rows = await selectCommentRows(db, placeId);
  return StoredCommentKeysSchema.parse(
    rows.map((row) => {
      const key: StoredCommentKey = { placeId: row.place_id, num: row.num, presence: row.presence };
      if (row.parent_num !== null) key.parentNum = row.parent_num;
      return key;
    }),
  );
}

export async function countAll(db: Knex | Knex.Transaction): Promise<StoreCounts> {
  const result: unknown = await db.raw(COUNTS_SQL);
  const [row] = CountsRawSchema.parse(result).rows;
  if (row === undefined) throw new Error('count query returned no row');
  return StoreCountsSchema.parse({
    places: row.places,
    comments: row.comments,
    tags: row.tags,
    placeTagLinks: row.place_tags,
  });
}

// ---------------------------------------------------------------------------
// State loaders (run inside the save transactions)
// ---------------------------------------------------------------------------

export async function loadListingState(
  trx: Knex.Transaction,
  placeIds: readonly number[],
): Promise<ListingState> {
  if (placeIds.length === 0) return { rows: [] };
  return { rows: await selectPlaceRows(trx, placeIds) };
}

export async function loadDetailsState(
  trx: Knex.Transaction,
  details: PlaceDetails,
): Promise<DetailsState> {
  const place = await selectPlaceRow(trx, details.placeId);
  const comments = await selectCommentRows(trx, details.placeId);
  const links = await selectTagLinksOfPlace(trx, details.placeId);
  const tagTitles = new Map<number, string>();
  const tagIds = [...new Set(details.tags.map((tag) => tag.id))];
  if (tagIds.length > 0) {
    const result: unknown = await trx
      .select('tag_id', 'title')
      .from(STORE_TABLES.tags)
      .whereIn('tag_id', tagIds)
      .orderBy('tag_id');
    for (const row of TagRowsSchema.parse(result)) tagTitles.set(row.tag_id, row.title);
  }
  return { place, comments, links, tagTitles };
}
