/**
 * Row schemas (AL4 1.1 `rows.ts`, 2.2 .. 2.4, 1.4.8): what SQL returns is a boundary, so rows
 * are parsed, never trusted. Non-strict objects, because Objection instances may carry extra
 * own properties. Keys are the snake_case column names (or the aliases chosen here for
 * read-only queries). `bigint` columns arrive as JS numbers through the per-connection int8
 * parser (`connection.ts`).
 */
import { z } from 'zod';
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
