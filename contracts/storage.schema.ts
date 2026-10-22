/**
 * AL5 CONTRACT: Place Store (feature `storage`, Stage 1 substep 2).
 *
 * Layer:    AL5 (Contracts). Source of truth for AL4 design and AL2 implementation.
 * Derives:  docs/al6-requirements/20261021-storage-al6.md (revision 2, AC-1 .. AC-72,
 *           decisions D1 .. D6), intent docs/al7-intent/20261021-storage-al7.md
 * Enforces: .agrules section 2 (every input re-checked with Zod before use, invalid input is a
 *           handled error; no embedding column yet, so the 1536-dim rule has nothing to gate),
 *           section 3 (all SQL in `src/db/`, extensions created by migration, parameterized
 *           queries), section 4 "No Commenter IPs" (no `user_ip` in any input, column or
 *           output), section 4 "Licensing" (every Stored Place keeps a Wikimapia Link, every
 *           Comment keeps its author), section 4 "Strict Types Only" (all I/O via `z.infer`).
 *
 * Reuses the Client shapes from ./wikimapia-client.schema (PlaceSummary, ListingPage,
 * PlaceDetails, Comment, Tag, Location, Point, FailureIssue): the Place Store receives exactly
 * what the Client returns (AL6 rule 1) and reads back in the same shapes plus Presence Marks.
 *
 * Public entry points (black box for ./storage.test.ts):
 * - `src/db/place-store.ts`  exports `createPlaceStore: CreatePlaceStoreFn`   (ENTRY_POINT)
 * - `src/db/schema-setup.ts` exports `createSchemaSetup: CreateSchemaSetupFn` (SCHEMA_SETUP_ENTRY_POINT)
 *
 * Test database (AC-60, AC-61): tests read the connection string of the Test Database from the
 * environment variable `TEST_DATABASE_URL` (TEST_DATABASE_URL_ENV) and fail loudly when it is
 * unset. Its database name must end in `_test`, and it must differ from `DATABASE_URL`
 * (DATABASE_URL_ENV, the Development Database). How the variable is provided (docker-compose
 * port, `.env.test`, Vitest `globalSetup`, CI) is decided at AL4; the connection string itself
 * is never committed in `contracts/`.
 *
 * Every call resolves (never rejects) to a `StoreResult`: `{ ok: true, value }` or
 * `{ ok: false, failure }` with `failure.kind` naming the Store Failure (AL6 glossary).
 *
 * Stored data is Wikimapia data, CC BY-NC-SA 3.0, non-commercial only.
 */
import { z } from 'zod';
import {
  BoundsLocationSchema,
  CommentSchema,
  FailureIssueSchema,
  ListingPageSchema,
  LocationSchema,
  PlaceDetailsSchema,
  PlaceIdSchema,
  PointSchema,
  TagSchema,
  isWikimapiaPlaceUrl,
  type Comment,
  type PlaceDetails,
  type Point,
} from './wikimapia-client.schema';

// ---------------------------------------------------------------------------
// Entry points, environment and fixed names
// ---------------------------------------------------------------------------

/** Module path (under the repo root) that must export the Place Store factory. */
export const ENTRY_POINT = {
  module: 'src/db/place-store.ts',
  export: 'createPlaceStore',
} as const;

/** Module path that must export the Schema Setup (migrations) factory. */
export const SCHEMA_SETUP_ENTRY_POINT = {
  module: 'src/db/schema-setup.ts',
  export: 'createSchemaSetup',
} as const;

/** Env var holding the Test Database connection string (AC-60). Required by the tests. */
export const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL';
/** Env var holding the Development Database connection string. Tests never connect to it. */
export const DATABASE_URL_ENV = 'DATABASE_URL';
/** The Test Database name must end with this suffix (guard against wiping development data). */
export const TEST_DATABASE_NAME_SUFFIX = '_test';

/** Table names fixed by the AL7 intent; inspected structurally by AC-2, AC-4, AC-5, AC-6, AC-14. */
export const STORE_TABLES = {
  places: 'places',
  comments: 'comments',
  tags: 'tags',
  placeTags: 'place_tags',
} as const;

/** Database extensions Schema Setup must enable (AC-1, AC-2, `.agrules` section 3). */
export const REQUIRED_EXTENSIONS = ['postgis', 'vector'] as const;

/** Spatial reference of every stored shape: WGS 84 longitude/latitude (AL6 rule 9). */
export const WGS84_SRID = 4326;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Presence Mark (D2): contained in the most recent Place Details, or not any more. */
export const PresenceSchema = z.enum(['present', 'gone']);
export type Presence = z.infer<typeof PresenceSchema>;

/**
 * Details Fetched At (D3): a UTC moment to the second, ISO 8601 with `Z` and no fraction,
 * e.g. `2026-10-21T10:00:00Z`. Read back in exactly this form. Anything else (missing,
 * fractional seconds, an offset, `2026-13-01T00:00:00Z`) is Invalid Data (AC-55).
 */
export const DetailsFetchedAtSchema = z.iso.datetime({ precision: 0 });
export type DetailsFetchedAt = z.infer<typeof DetailsFetchedAtSchema>;

/** Built Link (D6): exactly `http://wikimapia.org/<Place ID>`. */
export function buildWikimapiaLink(placeId: number): string {
  return `http://wikimapia.org/${String(placeId)}`;
}

/** Wikimapia Link of a Stored Place: a Listing Link or the Built Link, pointing to that Place. */
const WikimapiaLinkSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Configuration and injected collaborators
// ---------------------------------------------------------------------------

/**
 * Data part of the store options. An empty or unreachable connection string never throws:
 * every call then resolves to a `store_unavailable` failure (AC-57).
 */
export const StoreConfigSchema = z.strictObject({
  connectionString: z.string().min(1),
});
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

/**
 * Fault-injection seam for AC-56 (all-or-nothing saves). When given, the store calls it after
 * every write statement it executes inside a save's transaction, with the 1-based number of
 * that write within the save. If it throws or rejects, the store treats the Place Store as
 * having become unavailable: it rolls the whole save back and resolves `store_unavailable`.
 * Every save that writes anything calls it at least once. Production code never passes it.
 */
export type WriteHook = (writeNumber: number) => void | Promise<void>;

export interface PlaceStoreOptions extends StoreConfig {
  onWrite?: WriteHook;
}

export type SchemaSetupOptions = StoreConfig;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Listing Save input (AC-7 .. AC-15): exactly the Client's Listing Page. The same Place ID may
 * appear twice; the last occurrence wins (AC-13). `page`, `pageSize` and `totalFound` are
 * checked but never stored (AC-14).
 */
export const SaveListingPageInputSchema = ListingPageSchema;
export type SaveListingPageInput = z.infer<typeof SaveListingPageInputSchema>;

export const StoreIssueSchema = FailureIssueSchema.extend({
  /** Comment number the issue is about (AC-38, AC-39). */
  commentNum: z.number().int().nonnegative().exactOptional(),
  /** Place ID the offending item carries (AC-38). */
  placeId: z.number().int().exactOptional(),
});
export type StoreIssue = z.infer<typeof StoreIssueSchema>;

type CommentPath = (string | number)[];

/**
 * Pure validator for the Comment rules of a Details Save (AL6 rule 11, D5, Comment Key).
 * Paths are relative to the Place Details value (e.g. `['comments', 0, 'replies', 0, 'placeId']`).
 * - A Comment or Reply at any depth whose `placeId` differs from the Place's: one issue at its
 *   `placeId`, carrying `commentNum` and `placeId` (AC-38).
 * - A comment number used twice at any depth: one issue at the `num` of every later
 *   occurrence, carrying `commentNum` (AC-39).
 */
export function findCommentRuleIssues(details: PlaceDetails): StoreIssue[] {
  const issues: StoreIssue[] = [];
  const seen = new Set<number>();
  const visit = (comments: readonly Comment[], path: CommentPath): void => {
    comments.forEach((comment, index) => {
      const here = [...path, index];
      if (comment.placeId !== details.placeId) {
        issues.push({
          path: [...here, 'placeId'],
          message: `comment ${String(comment.num)} belongs to place ${String(comment.placeId)}, not ${String(details.placeId)}`,
          commentNum: comment.num,
          placeId: comment.placeId,
        });
      }
      if (seen.has(comment.num)) {
        issues.push({
          path: [...here, 'num'],
          message: `comment number ${String(comment.num)} is used more than once`,
          commentNum: comment.num,
        });
      }
      seen.add(comment.num);
      visit(comment.replies, [...here, 'replies']);
    });
  };
  visit(details.comments, ['comments']);
  return issues;
}

/**
 * Details Save input (AC-16 .. AC-39, AC-53 .. AC-55). Issues from `findCommentRuleIssues`
 * are reported under `['details', ...]`. A Commenter IP at any depth is an unknown key of the
 * strict Comment shape and therefore Invalid Data (AC-54).
 */
export const SavePlaceDetailsInputSchema = z
  .strictObject({
    details: PlaceDetailsSchema,
    fetchedAt: DetailsFetchedAtSchema,
  })
  .superRefine((input, ctx) => {
    for (const issue of findCommentRuleIssues(input.details)) {
      ctx.addIssue({ code: 'custom', path: ['details', ...issue.path], message: issue.message });
    }
  });
export type SavePlaceDetailsInput = z.infer<typeof SavePlaceDetailsInputSchema>;

/** Read input (AC-50, AC-51). An invalid Place ID is Invalid Data and never reaches the database. */
export const PlaceRefInputSchema = z.strictObject({ placeId: PlaceIdSchema });
export type PlaceRefInput = z.infer<typeof PlaceRefInputSchema>;

export const TagRefInputSchema = z.strictObject({ tagId: z.number().int().nonnegative() });
export type TagRefInput = z.infer<typeof TagRefInputSchema>;

// ---------------------------------------------------------------------------
// Outputs: save outcomes
// ---------------------------------------------------------------------------

/** Save Outcome per Place (AL6 glossary). Details Fetched At alone never makes `updated`. */
export const SaveOutcomeKindSchema = z.enum(['created', 'updated', 'unchanged']);
export type SaveOutcomeKind = z.infer<typeof SaveOutcomeKindSchema>;

export const PlaceSaveOutcomeSchema = z.strictObject({
  placeId: PlaceIdSchema,
  outcome: SaveOutcomeKindSchema,
});
export type PlaceSaveOutcome = z.infer<typeof PlaceSaveOutcomeSchema>;

/**
 * What a save reports: one entry per distinct Place it touched, each Place once (AC-13), in
 * order of first appearance. A Listing Save of an empty page reports none (AC-12); a Details
 * Save reports exactly one.
 */
export const SaveReportSchema = z
  .strictObject({ places: z.array(PlaceSaveOutcomeSchema) })
  .refine((r) => new Set(r.places.map((p) => p.placeId)).size === r.places.length, {
    message: 'each Place is reported once',
    path: ['places'],
  });
export type SaveReport = z.infer<typeof SaveReportSchema>;

// ---------------------------------------------------------------------------
// Outputs: read-back (AC-49, AC-71, AC-52, AC-72)
// ---------------------------------------------------------------------------

/** A Tag of a Place with the Presence Mark of its Place-Tag Link. */
export const StoredTagSchema = TagSchema.extend({ presence: PresenceSchema });
export type StoredTag = z.infer<typeof StoredTagSchema>;

/**
 * The Client's Comment shape plus a Presence Mark, recursively (Replies nested). Still strict:
 * no Commenter IP at any depth; the Comment Author is always present (AC-59).
 */
const commentFields = CommentSchema.omit({ replies: true }).shape;

export const StoredCommentSchema = z.strictObject({
  placeId: commentFields.placeId,
  num: commentFields.num,
  langId: commentFields.langId,
  author: commentFields.author,
  authorUserId: commentFields.authorUserId,
  authorPhotoUrl: commentFields.authorPhotoUrl,
  message: commentFields.message,
  goodVotes: commentFields.goodVotes,
  badVotes: commentFields.badVotes,
  isBlocked: commentFields.isBlocked,
  isDeleted: commentFields.isDeleted,
  postedAtEpochSeconds: commentFields.postedAtEpochSeconds,
  moderatorUserId: commentFields.moderatorUserId,
  moderatorName: commentFields.moderatorName,
  presence: PresenceSchema,
  get replies(): z.ZodArray<typeof StoredCommentSchema> {
    return z.array(StoredCommentSchema);
  },
});
export type StoredComment = z.infer<typeof StoredCommentSchema>;

const placeLinkRefinement = {
  check: (p: { placeId: number; wikimapiaUrl: string }): boolean =>
    isWikimapiaPlaceUrl(p.wikimapiaUrl, p.placeId),
  params: { message: 'wikimapiaUrl must link to this place', path: ['wikimapiaUrl'] },
};

/**
 * Summary-Only Place (AC-8): only what a Place Summary carries. Location has no address
 * items; no details items, no Details Fetched At; Tags and Comments are empty.
 */
export const SummaryOnlyPlaceSchema = z
  .strictObject({
    status: z.literal('summary_only'),
    placeId: PlaceIdSchema,
    name: z.string(),
    wikimapiaUrl: WikimapiaLinkSchema,
    location: BoundsLocationSchema,
    outline: z.array(PointSchema),
    tags: z.array(StoredTagSchema).length(0),
    comments: z.array(StoredCommentSchema).length(0),
  })
  .refine(placeLinkRefinement.check, placeLinkRefinement.params);
export type SummaryOnlyPlace = z.infer<typeof SummaryOnlyPlaceSchema>;

/**
 * Detailed Place (AC-16 .. AC-18, AC-49): the Client's Place Details fields (title read back as
 * `name`), plus `wikimapiaUrl`, `detailsFetchedAt`, and a Presence Mark on every Tag, Comment
 * and Reply. Absent items stay absent (never empty text or placeholders, rule 6).
 */
export const DetailedPlaceSchema = z
  .strictObject({
    status: z.literal('detailed'),
    placeId: PlaceIdSchema,
    name: z.string(),
    wikimapiaUrl: WikimapiaLinkSchema,
    description: z.string(),
    tags: z.array(StoredTagSchema),
    parentPlaceId: PlaceIdSchema.exactOptional(),
    isBuilding: z.boolean(),
    isRegion: z.boolean(),
    isDeleted: z.boolean(),
    wikipediaUrl: z.string().min(1).exactOptional(),
    outline: z.array(PointSchema),
    location: LocationSchema,
    comments: z.array(StoredCommentSchema),
    detailsFetchedAt: DetailsFetchedAtSchema,
  })
  .refine(placeLinkRefinement.check, placeLinkRefinement.params);
export type DetailedPlace = z.infer<typeof DetailedPlaceSchema>;

export const StoredPlaceSchema = z.discriminatedUnion('status', [
  SummaryOnlyPlaceSchema,
  DetailedPlaceSchema,
]);
export type StoredPlace = z.infer<typeof StoredPlaceSchema>;

/** Read-back answer. Place Not Found is an answer, not a failure (AC-50). */
export const ReadPlaceValueSchema = z.discriminatedUnion('found', [
  z.strictObject({ found: z.literal(true), place: StoredPlaceSchema }),
  z.strictObject({ found: z.literal(false), placeId: PlaceIdSchema }),
]);
export type ReadPlaceValue = z.infer<typeof ReadPlaceValueSchema>;

// ---------------------------------------------------------------------------
// Outputs: inspection (Tag Catalogue, Place-Tag Links, Comment Keys, map shapes, counts)
// ---------------------------------------------------------------------------

/** Tag Catalogue (AC-40, AC-42), ascending Tag id, each Tag once. */
export const TagCatalogueSchema = z
  .array(TagSchema)
  .refine((tags) => tags.every((t, i) => i === 0 || (tags[i - 1]?.id ?? -1) < t.id), {
    message: 'tags are listed once each, ascending by id',
  });
export type TagCatalogue = z.infer<typeof TagCatalogueSchema>;

/** One Place-Tag Link (AC-41, AC-69). Listed ascending by Place ID. */
export const PlaceTagLinkSchema = z.strictObject({
  placeId: PlaceIdSchema,
  tagId: z.number().int().nonnegative(),
  presence: PresenceSchema,
});
export type PlaceTagLink = z.infer<typeof PlaceTagLinkSchema>;

/**
 * One stored Comment row seen flat (AC-35): Comment Key (Place ID, comment number), the
 * Parent Comment's number for a Reply (absent at top level) and its Presence Mark.
 * Listed ascending by comment number.
 */
export const StoredCommentKeySchema = z.strictObject({
  placeId: PlaceIdSchema,
  num: z.number().int().nonnegative(),
  parentNum: z.number().int().nonnegative().exactOptional(),
  presence: PresenceSchema,
});
export type StoredCommentKey = z.infer<typeof StoredCommentKeySchema>;

/**
 * Map shapes as stored (AC-44 .. AC-48, AC-70), read from the spatial columns themselves (not
 * from a copy of the Outline). `outlineShape` is a closed Polygon ring (first point repeated
 * last) and is absent when the Place has no Outline Shape (D4).
 */
export const PlaceShapesSchema = z.strictObject({
  placeId: PlaceIdSchema,
  centrePoint: z.strictObject({
    type: z.literal('Point'),
    srid: z.literal(WGS84_SRID),
    point: PointSchema,
  }),
  outlineShape: z
    .strictObject({
      type: z.literal('Polygon'),
      srid: z.literal(WGS84_SRID),
      ring: z.array(PointSchema).min(4),
    })
    .exactOptional(),
});
export type PlaceShapes = z.infer<typeof PlaceShapesSchema>;

export const ReadShapesValueSchema = z.discriminatedUnion('found', [
  z.strictObject({ found: z.literal(true), shapes: PlaceShapesSchema }),
  z.strictObject({ found: z.literal(false), placeId: PlaceIdSchema }),
]);
export type ReadShapesValue = z.infer<typeof ReadShapesValueSchema>;

/** Totals of everything stored (AC-7, AC-9, AC-35, AC-61). Gone items are counted. */
export const StoreCountsSchema = z.strictObject({
  places: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  tags: z.number().int().nonnegative(),
  placeTagLinks: z.number().int().nonnegative(),
});
export type StoreCounts = z.infer<typeof StoreCountsSchema>;

/**
 * Pure helper: the closed ring of the Outline Shape for an Outline, or `undefined` when the
 * Outline gets none (D4). An open Outline of 3+ points is closed by repeating its first point
 * (AC-44); an already closed one is kept as is (AC-46). A Polygon ring needs at least 4 points,
 * so an already closed Outline of exactly 3 points (A, B, A) also gets no Outline Shape.
 */
export function outlineShapeRing(outline: readonly Point[]): Point[] | undefined {
  const first = outline[0];
  const last = outline[outline.length - 1];
  if (first === undefined || last === undefined || outline.length < 3) return undefined;
  const closed = first.lon === last.lon && first.lat === last.lat;
  const ring = closed ? [...outline] : [...outline, first];
  return ring.length >= 4 ? ring : undefined;
}

// ---------------------------------------------------------------------------
// Outputs: Schema Setup (AC-1 .. AC-6, AC-14)
// ---------------------------------------------------------------------------

export const ColumnInfoSchema = z.strictObject({
  name: z.string().min(1),
  /** `information_schema.columns.data_type`, e.g. `integer`, `USER-DEFINED`. */
  dataType: z.string().min(1),
  /** `information_schema.columns.udt_name`, e.g. `int4`, `geometry`, `vector`, `inet`. */
  udtName: z.string().min(1),
});
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>;

/**
 * What Schema Setup reports about the database it is connected to. `tables` lists every base
 * table of the store's schema except the migration tool's own bookkeeping tables.
 * The Comment Author column of `comments` has a name containing `author` (AC-6).
 */
export const StoreStructureSchema = z.strictObject({
  appliedSteps: z.array(z.string().min(1)),
  pendingSteps: z.array(z.string().min(1)),
  enabledExtensions: z.array(z.string().min(1)),
  availableExtensions: z.array(z.string().min(1)),
  tables: z.array(z.strictObject({ name: z.string().min(1), columns: z.array(ColumnInfoSchema) })),
});
export type StoreStructure = z.infer<typeof StoreStructureSchema>;

export const SchemaStepsSchema = z.strictObject({ steps: z.array(z.string().min(1)) });
export type SchemaSteps = z.infer<typeof SchemaStepsSchema>;

// ---------------------------------------------------------------------------
// Store Failures (AL6 glossary, AC-15, AC-38, AC-39, AC-51, AC-53 .. AC-58)
// ---------------------------------------------------------------------------

/**
 * Invalid Data: the input does not have the Client's shape or breaks an AL6 rule. Issue paths
 * are into the call's input: `['places', 1, 'url']` for a Listing Save,
 * `['details', 'comments', 0, 'replies', 0, 'author']` or `['fetchedAt']` for a Details Save,
 * `['placeId']` for a read. Never echoes a Commenter IP value (AC-54).
 */
export const InvalidDataFailureSchema = z.strictObject({
  kind: z.literal('invalid_data'),
  message: z.string().min(1),
  issues: z.array(StoreIssueSchema).min(1),
});

/** Store Unavailable: unreachable, or failed part way. No password or connection string (AC-57). */
export const StoreUnavailableFailureSchema = z.strictObject({
  kind: z.literal('store_unavailable'),
  message: z.string().min(1),
});

export const StoreFailureSchema = z.discriminatedUnion('kind', [
  InvalidDataFailureSchema,
  StoreUnavailableFailureSchema,
]);
export type StoreFailure = z.infer<typeof StoreFailureSchema>;
export type StoreFailureKind = StoreFailure['kind'];

// ---------------------------------------------------------------------------
// Results and public API
// ---------------------------------------------------------------------------

/** A failure carries no partial data: only `ok` and `failure`. */
export function storeResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), failure: StoreFailureSchema }),
  ]);
}

export const SaveResultSchema = storeResultSchema(SaveReportSchema);
export type SaveResult = z.infer<typeof SaveResultSchema>;

export const ReadPlaceResultSchema = storeResultSchema(ReadPlaceValueSchema);
export type ReadPlaceResult = z.infer<typeof ReadPlaceResultSchema>;

export const TagCatalogueResultSchema = storeResultSchema(TagCatalogueSchema);
export type TagCatalogueResult = z.infer<typeof TagCatalogueResultSchema>;

export const PlaceTagLinksResultSchema = storeResultSchema(z.array(PlaceTagLinkSchema));
export type PlaceTagLinksResult = z.infer<typeof PlaceTagLinksResultSchema>;

export const StoredCommentKeysResultSchema = storeResultSchema(z.array(StoredCommentKeySchema));
export type StoredCommentKeysResult = z.infer<typeof StoredCommentKeysResultSchema>;

export const ReadShapesResultSchema = storeResultSchema(ReadShapesValueSchema);
export type ReadShapesResult = z.infer<typeof ReadShapesResultSchema>;

export const StoreCountsResultSchema = storeResultSchema(StoreCountsSchema);
export type StoreCountsResult = z.infer<typeof StoreCountsResultSchema>;

export const SchemaStepsResultSchema = storeResultSchema(SchemaStepsSchema);
export type SchemaStepsResult = z.infer<typeof SchemaStepsResultSchema>;

export const StoreStructureResultSchema = storeResultSchema(StoreStructureSchema);
export type StoreStructureResult = z.infer<typeof StoreStructureResultSchema>;

export const EmptyResultSchema = storeResultSchema(z.strictObject({}));
export type EmptyResult = z.infer<typeof EmptyResultSchema>;

/**
 * The Place Store (US-1 .. US-9). Calls never reject. Inputs are typed as the Client shapes
 * but are re-validated at runtime (AL6 rule 1): anything else is `invalid_data`.
 */
export interface PlaceStore {
  /** Listing Save (US-1, AC-7 .. AC-15, AC-63). All or nothing. */
  saveListingPage(page: SaveListingPageInput): Promise<SaveResult>;
  /** Details Save (US-2, AC-16 .. AC-39). All or nothing. */
  savePlaceDetails(input: SavePlaceDetailsInput): Promise<SaveResult>;
  /** Read one Place back with Present and Gone items together (US-4, AC-49 .. AC-52, AC-71, AC-72). */
  readPlace(input: PlaceRefInput): Promise<ReadPlaceResult>;
  /** Tag Catalogue (AC-40, AC-42). */
  listTags(): Promise<TagCatalogueResult>;
  /** Place-Tag Links of one Tag, Present and Gone (AC-41, AC-69). */
  listPlaceTagLinks(input: TagRefInput): Promise<PlaceTagLinksResult>;
  /** Every stored Comment and Reply of a Place, flat (AC-35). Empty for an unknown Place. */
  listStoredComments(input: PlaceRefInput): Promise<StoredCommentKeysResult>;
  /** Centre Point and Outline Shape as stored (AC-44 .. AC-48, AC-70). */
  readPlaceShapes(input: PlaceRefInput): Promise<ReadShapesResult>;
  /** Totals of everything stored (AC-7, AC-9, AC-35, AC-61). */
  countStored(): Promise<StoreCountsResult>;
  /** Releases the connection pool. Never rejects. */
  close(): Promise<void>;
}

/** Public entry point, exported as `createPlaceStore` from `src/db/place-store.ts`. Never throws. */
export type CreatePlaceStoreFn = (options: PlaceStoreOptions) => PlaceStore;

/**
 * Schema Setup (US-7, AC-2 .. AC-6): versioned, ordered steps, each with an undo. Calls never
 * reject. `postgis` and `vector` are enabled by a step (and `vector` disabled by its undo).
 */
export interface SchemaSetup {
  /** Applies every pending step in order; reports the steps applied now (empty if none, AC-3). */
  apply(): Promise<SchemaStepsResult>;
  /** Undoes every applied step, newest first; reports the steps undone (AC-4). */
  undoAll(): Promise<SchemaStepsResult>;
  /**
   * Undoes only the newest applied step and reports it (empty if none is applied). Added by
   * feature `hydration` (AC-56): undoing the Crawl Progress step leaves every Place, Comment,
   * Tag and Place-Tag Link unchanged.
   */
  undoLast(): Promise<SchemaStepsResult>;
  /** Describes steps, extensions and tables of the connected database. */
  inspect(): Promise<StoreStructureResult>;
  /**
   * Removes every Place, Comment, Tag and Place-Tag Link, keeping the structure (AC-61), and,
   * once the `hydration` Schema Setup step exists, all Crawl Progress and Run Records too
   * (hydration AC-57, gap G3). Refuses with `store_unavailable` unless the database name ends
   * in `_test`.
   */
  emptyStore(): Promise<EmptyResult>;
  /** Releases the connection. Never rejects. */
  close(): Promise<void>;
}

/** Public entry point, exported as `createSchemaSetup` from `src/db/schema-setup.ts`. Never throws. */
export type CreateSchemaSetupFn = (options: SchemaSetupOptions) => SchemaSetup;
