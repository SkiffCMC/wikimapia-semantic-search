/**
 * Internal types of `src/db/` (AL4 1.3 `types.ts` block). Types only, no runtime code. Contract
 * `z.infer` types stay in the contract and are not re-exported here.
 */
import type { z } from 'zod';
import type { Knex } from 'knex';
import type {
  SaveOutcomeKind,
  SavePlaceDetailsInput,
  SaveReport,
  StoreFailure,
  WriteHook,
} from '../../contracts/storage.schema';
import type {
  BoundingBox,
  Comment,
  ListingPage,
  PlaceSummary,
  Point,
  Tag,
} from '../../contracts/wikimapia-client.schema';
import type { FailureRecord } from '../../contracts/crawl-run1-fixes.schema';
import type { Embedding } from '../../contracts/embeddings.schema';
import type {
  AreaFilter,
  LatLon,
  SearchMode,
  SearchResult,
} from '../../contracts/hybrid-search.schema';
import type {
  DuePlace,
  ItemFailureKind,
  Moment,
  PlacesDueInput,
  RunCounts,
  RunRecordStatus,
  TileSize,
} from '../../contracts/hydration.schema';
import type {
  BigintProbeRowSchema,
  ColumnRowSchema,
  CommentRowSchema,
  CountRowSchema,
  CountsRowSchema,
  DuePlaceRowSchema,
  EmbeddingCountsRowSchema,
  EmbeddingRowSchema,
  FailureRowSchema,
  FinishedPageRowSchema,
  IdRowSchema,
  KeyColumnRowSchema,
  LiveRunRowSchema,
  NameRowSchema,
  ParkingRowSchema,
  PassRowSchema,
  PassTileRowSchema,
  PlaceRowSchema,
  RetryRowSchema,
  RingPointRowSchema,
  RunRowSchema,
  SearchRowSchema,
  ShapeRowSchema,
  TagLinkRowSchema,
  TagRowSchema,
  TypmodRowSchema,
  VectorIndexRowSchema,
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
export type RunRow = z.infer<typeof RunRowSchema>;
export type PassRow = z.infer<typeof PassRowSchema>;
export type FinishedPageRow = z.infer<typeof FinishedPageRowSchema>;
export type PassTileRow = z.infer<typeof PassTileRowSchema>;
export type DuePlaceRow = z.infer<typeof DuePlaceRowSchema>;
export type CountRow = z.infer<typeof CountRowSchema>;
export type IdRow = z.infer<typeof IdRowSchema>;
export type LiveRunRow = z.infer<typeof LiveRunRowSchema>;
export type FailureRow = z.infer<typeof FailureRowSchema>;
export type RetryRow = z.infer<typeof RetryRowSchema>;
export type ParkingRow = z.infer<typeof ParkingRowSchema>;
export type EmbeddingRow = z.infer<typeof EmbeddingRowSchema>;
export type EmbeddingCountsRow = z.infer<typeof EmbeddingCountsRowSchema>;
export type TypmodRow = z.infer<typeof TypmodRowSchema>;
export type KeyColumnRow = z.infer<typeof KeyColumnRowSchema>;
export type VectorIndexRow = z.infer<typeof VectorIndexRowSchema>;

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

export interface NamedMigration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

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
export interface ListingState {
  rows: PlaceRow[];
}

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

/** State of a Region's current Listing Pass (AL4 hydration 1.4.6 "PassState query"). */
export interface PassState {
  passNumber: number;
  tileCount: number;
  /** Tile Numbers with a Short Page, ascending. */
  finishedTiles: number[];
  /** `[tileNumber, last finished page]` for every Tile with a Finished Page, ascending. */
  lastFinishedPage: [number, number][];
}

/** The newest pass of a Region: its row and derived state (`readCurrentPass`). */
export interface CurrentPass {
  row: PassRow;
  state: PassState;
}

/**
 * R1 query input plus an optional row limit (AL4 hydration 1.3, 1.4.7) and the Places to leave
 * out (the Parked Places, AL4 crawl-run1-fixes 1.4.7).
 */
export interface DueQuery extends PlacesDueInput {
  limit?: number;
  excludePlaceIds?: readonly number[];
}

// ---------------------------------------------------------------------------
// Crawl repository (AL4 hydration 1.3, 1.4.5 .. 1.4.9)
// ---------------------------------------------------------------------------

/** Run start input (`beginRunStep`). */
export interface BeginRunInput {
  regionName: string;
  bbox: BoundingBox;
  tileSize: TileSize;
  tileCount: number;
  relist: boolean;
  startedAt: Moment;
  abandonBefore: Moment;
  counts: RunCounts;
  /** Release the Parked Places of the Region and keep an Explicit Retry (AL4 crawl-run1-fixes 1.4.5). */
  retryParked: boolean;
}

/**
 * Result of a Run start. A `started` value without `pass` means the current pass is complete and
 * there is no Listing Phase (the key is omitted, never set to `undefined`).
 */
export type BeginRunValue =
  | {
      kind: 'started';
      runId: number;
      pass?: PassState;
      abandonedRunIds: number[];
      placesReleased: number;
    }
  | { kind: 'run_in_progress'; runId: number; lastActivity: Moment }
  | { kind: 'region_changed'; passNumber: number };

export interface RenewInput {
  runId: number;
  at: Moment;
  counts: RunCounts;
}

export interface ListingStepInput {
  runId: number;
  regionName: string;
  passNumber: number;
  tileNumber: number;
  page: number;
  listing: ListingPage;
  short: boolean;
  finishedAt: Moment;
}

export type ListingStepValue = { kind: 'saved'; report: SaveReport } | { kind: 'taken_over' };

export type FinalRunStatus = Exclude<RunRecordStatus, 'in_progress' | 'abandoned'>;

export interface FinishInput {
  runId: number;
  status: FinalRunStatus;
  endedAt: Moment;
  counts: RunCounts;
}

/** A Parked Place and the Item Failure Kind that parks it (AL4 crawl-run1-fixes 1.3). */
export interface ParkedPlace {
  placeId: number;
  failureKind: ItemFailureKind;
}

/** Scope of a Parking read: the Places of a bbox, or one Place (AL4 crawl-run1-fixes 1.4.6). */
export type ParkingScope = { bbox: BoundingBox } | { placeId: number };

/** Input of the Explicit Retry releases inside the Run start (AL4 crawl-run1-fixes 1.4.5). */
export interface ReleaseInput {
  runId: number;
  regionName: string;
  bbox: BoundingBox;
  at: Moment;
}

/** Due and Parked Place counts of a Region (AL4 crawl-run1-fixes 1.4.7). */
export interface RegionTotals {
  placesDue: number;
  placesParked: number;
}

/** Result of the Failure Record step; `parked` only for a Place Parked after this record. */
export type FailureStepValue = { kind: 'recorded'; parked?: ParkedPlace } | { kind: 'taken_over' };

export interface CrawlRepositoryOptions {
  connectionString: string;
  onWrite?: WriteHook;
}

/** The Run's database handle (`crawl-repository.ts`). Every method resolves, never rejects. */
export interface CrawlRepository {
  beginRun(input: BeginRunInput): Promise<StoreResult<BeginRunValue>>;
  renewActivity(input: RenewInput): Promise<StoreResult<{ alive: boolean }>>;
  recordListingPage(input: ListingStepInput): Promise<StoreResult<ListingStepValue>>;
  recordItemFailure(record: FailureRecord): Promise<StoreResult<FailureStepValue>>;
  saveDetails(input: SavePlaceDetailsInput): Promise<StoreResult<SaveReport>>;
  /** Excludes the Parked Places of the bbox itself. */
  listPlacesDue(query: DueQuery): Promise<StoreResult<DuePlace[]>>;
  listParkedPlaces(input: { bbox: BoundingBox }): Promise<StoreResult<ParkedPlace[]>>;
  regionTotals(input: PlacesDueInput): Promise<StoreResult<RegionTotals>>;
  finishRun(input: FinishInput): Promise<StoreResult<{ updated: boolean }>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Embedding Store (AL4 embeddings 1.3, 1.4.8)
// ---------------------------------------------------------------------------

/** One `place_embeddings` upsert row; `embedding` is the `?::vector` raw binding. */
export interface EmbeddingRowColumns {
  place_id: number;
  embedding: Knex.Raw;
  embedding_model: string;
  document_fingerprint: string;
  embedded_at: string;
}

// ---------------------------------------------------------------------------
// Place Search (AL4 hybrid-search 1.3, 1.4.3, 1.4.8)
// ---------------------------------------------------------------------------

/** Input of one search statement; checked by `validatePlaceSearchQuery` before any SQL. */
export interface PlaceSearchQuery {
  /** Gated by `EmbeddingSchema`. */
  queryEmbedding: Embedding;
  mode: SearchMode;
  /** 1 .. MAX_RESULT_LIMIT. */
  limit: number;
  /** Never together with `area`. */
  radius?: { centre: LatLon; radiusMetres: number };
  area?: AreaFilter;
  /** Normalized, unique, at least one; any count. */
  tagTitles?: readonly string[];
}

export type SqlBinding = string | number | string[];

export interface SqlStatement {
  sql: string;
  bindings: SqlBinding[];
}

export type SearchRow = z.infer<typeof SearchRowSchema>;

export interface PlaceSearchStoreOptions {
  connectionString: string;
}

export interface PlaceSearchStore {
  /** Never rejects. */
  searchMatchingPlaces(query: PlaceSearchQuery): Promise<StoreResult<SearchResult[]>>;
  /** Idempotent, never rejects. */
  close(): Promise<void>;
}
