/**
 * Internal types of `src/db/` (AL4 1.3 `types.ts` block). Types only, no runtime code. Contract
 * `z.infer` types stay in the contract and are not re-exported here.
 */
import type { z } from 'zod';
import type { Knex } from 'knex';
import type { SaveOutcomeKind, StoreFailure } from '../../contracts/storage.schema';
import type { Comment, PlaceSummary, Point, Tag } from '../../contracts/wikimapia-client.schema';
import type {
  BigintProbeRowSchema,
  ColumnRowSchema,
  CommentRowSchema,
  CountsRowSchema,
  NameRowSchema,
  PlaceRowSchema,
  RingPointRowSchema,
  ShapeRowSchema,
  TagLinkRowSchema,
  TagRowSchema,
} from './rows';

export type StoreResult<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };
export type Validated<T> = { ok: true; value: T } | { ok: false; failure: StoreFailure };

export type PlaceRow = z.infer<typeof PlaceRowSchema>;
export type CommentRow = z.infer<typeof CommentRowSchema>;
export type TagLinkRow = z.infer<typeof TagLinkRowSchema>;
export type TagRow = z.infer<typeof TagRowSchema>;
export type ShapeRow = z.infer<typeof ShapeRowSchema>;
export type RingPointRow = z.infer<typeof RingPointRowSchema>;
export type CountsRow = z.infer<typeof CountsRowSchema>;
export type ColumnRow = z.infer<typeof ColumnRowSchema>;
export type NameRow = z.infer<typeof NameRowSchema>;
export type BigintProbeRow = z.infer<typeof BigintProbeRowSchema>;

/** jsonb form of an Outline: `[[lon, lat], ...]`. */
export type OutlinePairs = [number, number][];

/** Any non-geometry column value of a column map (written by `mappers.ts`, compared by `plan.ts`). */
export type ColumnValue = string | number | boolean | null | OutlinePairs;

/** `places` columns written by a Listing Save (geometries are added as `Knex.Raw` by the caller). */
export type SummaryColumns = Pick<
  PlaceRow,
  | 'name'
  | 'wikimapia_url'
  | 'location_lon'
  | 'location_lat'
  | 'bound_north'
  | 'bound_south'
  | 'bound_east'
  | 'bound_west'
  | 'outline'
>;

/** `places` columns written by a Details Save; `details_fetched_at` is the whole-second UTC ISO text. */
export type DetailsColumns = Pick<
  PlaceRow,
  | 'name'
  | 'parent_place_id'
  | 'wikipedia_url'
  | 'location_lon'
  | 'location_lat'
  | 'bound_north'
  | 'bound_south'
  | 'bound_east'
  | 'bound_west'
  | 'address_street'
  | 'address_house_number'
  | 'address_city'
  | 'address_place'
  | 'address_state'
  | 'address_country'
  | 'outline'
> & {
  description: string;
  is_building: boolean;
  is_region: boolean;
  is_deleted: boolean;
  details_fetched_at: string;
};

/** All 17 `comments` columns, write side. */
export type CommentColumns = CommentRow;

/** Every `comments` column except the key (`place_id`, `num`). */
export type CommentPatchColumns = Omit<CommentColumns, 'place_id' | 'num'>;

/** Pre-gate read-back of the map shapes: the literals are checked by `ReadShapesValueSchema`, not by the type. */
export interface ShapesCandidate {
  placeId: number;
  centrePoint: { type: string; srid: number; point: Point };
  outlineShape?: { type: string; srid: number | null; ring: Point[] };
}

/** One Comment/Reply of a Details Save, pre-order. `comment.replies` is ignored by consumers. */
export interface FlatComment {
  comment: Comment;
  parentNum: number | null;
  /** 0-based index among its siblings. */
  position: number;
}

export interface NamedMigration { name: string; up(knex: Knex): Promise<void>; down(knex: Knex): Promise<void>; }

/** Executes write statements, numbers them from 1 and calls the `onWrite` hook (`writer.ts`). */
export interface Writer {
  /**
   * Awaits the statement, counts it, then awaits the hook (if any) with the new count. The
   * resolved library result is discarded.
   */
  run(statement: PromiseLike<unknown>): Promise<void>;
  readonly count: number;
}

/** Existing rows for the page's ids (Listing Save). */
export interface ListingState { rows: PlaceRow[] }

/** Stored state of one place before a Details Save. */
export interface DetailsState {
  place: PlaceRow | undefined;
  /** All comment rows of this place. */
  comments: CommentRow[];
  /** All tag links of this place. */
  links: TagLinkRow[];
  /** Stored titles of the input's tag ids. */
  tagTitles: Map<number, string>;
}

export type ListingWrite =
  | { kind: 'insert_summary'; summary: PlaceSummary }
  | { kind: 'update_summary'; summary: PlaceSummary }
  | { kind: 'update_link'; placeId: number; url: string };
export interface ListingPlan {
  outcomes: { placeId: number; outcome: SaveOutcomeKind }[];
  writes: ListingWrite[];
}

export type PlaceDetailsWrite =
  /** New place, Built Link. */
  | { kind: 'insert'; wikimapiaUrl: string }
  /** All details columns + shapes + fetched at. */
  | { kind: 'update_details' }
  /** D3: only the moment moved. */
  | { kind: 'update_fetched_at' };
export interface DetailsPlan {
  outcome: SaveOutcomeKind;
  place: PlaceDetailsWrite | undefined;
  /** Ascending id. */
  tagUpserts: Tag[];
  /** Input order, present. */
  linkWrites: { kind: 'insert' | 'update'; tagId: number; position: number }[];
  /** Tag ids, ascending. */
  goneLinks: number[];
  /** Pre-order, present. */
  commentWrites: { kind: 'insert' | 'update'; flat: FlatComment }[];
  /** Nums, ascending. */
  goneComments: number[];
}
