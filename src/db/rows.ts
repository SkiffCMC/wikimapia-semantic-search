/**
 * Row schemas (AL4 1.1 `rows.ts`, 2.2 .. 2.4, 1.4.8): what SQL returns is a boundary, so rows
 * are parsed, never trusted. Non-strict objects, because Objection instances may carry extra
 * own properties. Keys are the snake_case column names (or the aliases chosen here for
 * read-only queries). `bigint` columns arrive as JS numbers through the per-connection int8
 * parser (`connection.ts`).
 */
import { z } from 'zod';
import {
  ItemFailureKindSchema,
  RunCountsSchema,
  RunRecordStatusSchema,
} from '../../contracts/hydration.schema';
import { PresenceSchema } from '../../contracts/storage.schema';

const BigintSchema = z.number().int();
const OutlinePairSchema = z.tuple([z.number(), z.number()]);

/** `places`, every column except the two geometries, plus the formatted fetch moment. */
export const PlaceRowSchema = z.object({
  place_id: BigintSchema,
  name: z.string(),
  wikimapia_url: z.string(),
  location_lon: z.number(),
  location_lat: z.number(),
  bound_north: z.number(),
  bound_south: z.number(),
  bound_east: z.number(),
  bound_west: z.number(),
  outline: z.array(OutlinePairSchema),
  description: z.string().nullable(),
  is_building: z.boolean().nullable(),
  is_region: z.boolean().nullable(),
  is_deleted: z.boolean().nullable(),
  parent_place_id: BigintSchema.nullable(),
  wikipedia_url: z.string().nullable(),
  address_street: z.string().nullable(),
  address_house_number: z.string().nullable(),
  address_city: z.string().nullable(),
  address_place: z.string().nullable(),
  address_state: z.string().nullable(),
  address_country: z.string().nullable(),
  details_fetched_at_text: z.string().nullable(),
});

/** `comments`. */
export const CommentRowSchema = z.object({
  place_id: BigintSchema,
  num: BigintSchema,
  parent_num: BigintSchema.nullable(),
  lang_id: BigintSchema,
  author: z.string(),
  author_user_id: BigintSchema,
  author_photo_url: z.string().nullable(),
  message: z.string(),
  good_votes: BigintSchema,
  bad_votes: BigintSchema,
  is_blocked: z.boolean(),
  is_deleted: z.boolean(),
  posted_at_epoch_seconds: BigintSchema,
  moderator_user_id: BigintSchema,
  moderator_name: z.string().nullable(),
  presence: PresenceSchema,
  position: z.number().int().nullable(),
});

/** `place_tags` joined with `tags.title`. */
export const TagLinkRowSchema = z.object({
  place_id: BigintSchema,
  tag_id: BigintSchema,
  presence: PresenceSchema,
  position: z.number().int().nullable(),
  title: z.string(),
});

/** `tags`. */
export const TagRowSchema = z.object({
  tag_id: BigintSchema,
  title: z.string(),
});

/** Map shapes of one place (1.4.8 "Shapes"). */
export const ShapeRowSchema = z.object({
  centre_srid: z.number().int(),
  centre_type: z.string(),
  centre_x: z.number(),
  centre_y: z.number(),
  outline_srid: z.number().int().nullable(),
  outline_type: z.string().nullable(),
});

/** One point of the outline shape's exterior ring. */
export const RingPointRowSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/** Row counts, one per table. */
export const CountsRowSchema = z.object({
  places: BigintSchema,
  comments: BigintSchema,
  tags: BigintSchema,
  place_tags: BigintSchema,
});

/** `information_schema.columns`. */
export const ColumnRowSchema = z.object({
  table_name: z.string(),
  column_name: z.string(),
  data_type: z.string(),
  udt_name: z.string(),
});

/** Any single-name row (migration names, extension names, database name). */
export const NameRowSchema = z.object({
  name: z.string(),
});

/** Result row of `selectBigint`. */
export const BigintProbeRowSchema = z.object({
  value: z.number(),
});

// ---------------------------------------------------------------------------
// Old Run Records (AL4 crawl-run1-fixes 1.4.12, decision 5): read path only, never rewritten
// ---------------------------------------------------------------------------

/** Counts that Run Records stored before crawl-run1-fixes do not carry. */
export const PARKING_COUNT_DEFAULTS = {
  placesParkedThisRun: 0,
  placesParked: 0,
  placesReleased: 0,
} as const;

function isPlainObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validator pre-step over untrusted database JSON (`unknown` allowed, `.agrules` section 5):
 * fills missing parking counts with 0 under a plain object; stored values win. Anything else
 * is returned unchanged, so it still fails `RunCountsSchema`.
 */
export function withParkingCounts(value: unknown): unknown {
  return isPlainObject(value) ? { ...PARKING_COUNT_DEFAULTS, ...value } : value;
}

/** `crawl_runs.counts` as stored: old records read with the parking counts as 0. */
export const StoredRunCountsSchema = z.preprocess(withParkingCounts, RunCountsSchema);

// ---------------------------------------------------------------------------
// Crawl Progress and Places Due rows (AL4 hydration 1.1 `rows.ts`, 1.4.6, 1.4.7, 1.4.11, 2.2 .. 2.4)
// ---------------------------------------------------------------------------

/** `crawl_runs`, moments formatted with `to_char` (`*_text`); `counts` arrives parsed (jsonb). */
export const RunRowSchema = z.object({
  run_id: BigintSchema,
  region_name: z.string(),
  status: RunRecordStatusSchema,
  started_at_text: z.string(),
  ended_at_text: z.string().nullable(),
  last_activity_text: z.string(),
  counts: StoredRunCountsSchema,
});

/** `crawl_passes`, the Tile Plan inputs of one Listing Pass. */
export const PassRowSchema = z.object({
  region_name: z.string(),
  pass_number: z.number().int(),
  bbox_west: z.number(),
  bbox_south: z.number(),
  bbox_east: z.number(),
  bbox_north: z.number(),
  tile_width: z.number(),
  tile_height: z.number(),
  tile_count: z.number().int(),
});

/** `crawl_finished_pages`. */
export const FinishedPageRowSchema = z.object({
  pass_number: z.number().int(),
  tile_number: z.number().int(),
  page_no: z.number().int(),
  run_id: BigintSchema,
  place_count: z.number().int(),
  is_short: z.boolean(),
  reported_total: BigintSchema.nullable(),
});

/** PassState aggregate: one row per Tile with a Finished Page. */
export const PassTileRowSchema = z.object({
  tile_number: z.number().int(),
  last_page: z.number().int(),
  finished: z.boolean(),
});

/** One Place Due for Details (R1 query). */
export const DuePlaceRowSchema = z.object({
  place_id: BigintSchema,
  details_fetched_at_text: z.string().nullable(),
});

/** `count(*)`. */
export const CountRowSchema = z.object({
  count: BigintSchema,
});

/** `nextval(...) as id`. */
export const IdRowSchema = z.object({
  id: BigintSchema,
});

/** Live Run row of a Region during Run start (`last_activity` formatted with `to_char`). */
export const LiveRunRowSchema = z.object({
  run_id: BigintSchema,
  last_activity_text: z.string(),
});

// ---------------------------------------------------------------------------
// Failure Records and Explicit Retries (AL4 crawl-run1-fixes 1.4.8, 2.2, 2.3, 2.5)
// ---------------------------------------------------------------------------

/** `crawl_item_failures`, `failed_at` formatted with `to_char`. */
export const FailureRowSchema = z.object({
  run_id: BigintSchema,
  place_id: BigintSchema.nullable(),
  tile_number: z.number().int().nullable(),
  page_no: z.number().int().nullable(),
  failure_kind: ItemFailureKindSchema,
  message: z.string(),
  failed_at_text: z.string(),
});

/** `crawl_explicit_retries`, `retried_at` formatted with `to_char`. */
export const RetryRowSchema = z.object({
  run_id: BigintSchema,
  region_name: z.string(),
  retried_at_text: z.string(),
  places_released: z.number().int(),
});

/** Parking inputs of one Failure Record about a Place (AL4 crawl-run1-fixes 1.4.6, 2.5). */
export const ParkingRowSchema = z.object({
  run_id: BigintSchema,
  place_id: BigintSchema,
  failure_kind: ItemFailureKindSchema,
  message: z.string(),
  failed_at_text: z.string(),
  details_fetched_at_text: z.string().nullable(),
  released_at_text: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Embedding Records (AL4 embeddings 1.4.8, 2.1)
// ---------------------------------------------------------------------------

/** `place_embeddings`, the vector as `embedding::text`, `embedded_at` formatted with `to_char`. */
export const EmbeddingRowSchema = z.object({
  place_id: BigintSchema,
  embedding_text: z.string(),
  embedding_model: z.string(),
  document_fingerprint: z.string(),
  embedded_at_text: z.string(),
});

/** Summary-Only Places, Detailed Places and Embedding Records (int8 counts). */
export const EmbeddingCountsRowSchema = z.object({
  summary_only_places: BigintSchema,
  detailed_places: BigintSchema,
  embedding_records: BigintSchema,
});

/** `pg_attribute.atttypmod` of the vector column (pgvector: the dimension count). */
export const TypmodRowSchema = z.object({
  atttypmod: z.number().int(),
});

/** One primary-key column name, in key order. */
export const KeyColumnRowSchema = z.object({
  attname: z.string(),
});

/** One index on the vector column. */
export const VectorIndexRowSchema = z.object({
  name: z.string(),
  method: z.string(),
  operator_class: z.string(),
  partial: z.boolean(),
});

// ---------------------------------------------------------------------------
// Place Search (AL4 hybrid-search 1.4.8)
// ---------------------------------------------------------------------------

/**
 * One row of the search statement. `float8` arrives as a JS number and `text[]` as a string
 * array (pg's default parsers); `distance_metres` is null without a Radius Filter.
 */
export const SearchRowSchema = z.object({
  place_id: BigintSchema,
  name: z.string(),
  wikimapia_url: z.string(),
  location_lat: z.number(),
  location_lon: z.number(),
  similarity: z.number(),
  distance_metres: z.number().nullable(),
  tags: z.array(z.string()),
});
