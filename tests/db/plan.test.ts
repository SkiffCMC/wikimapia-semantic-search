/**
 * AL2 unit tests: `src/db/plan.ts` (AL4 1.3 `plan.ts` and `types.ts` blocks, 1.4.5 Listing Save,
 * 1.4.6 Details Save; AC-7, AC-9 .. AC-13, AC-63 on the listing side; AC-16, AC-20 .. AC-27,
 * AC-31, AC-37, AC-40 .. AC-43, AC-64 .. AC-69 on the details side; decisions D1, D2, D3, D6).
 *
 * Pure. Inputs are the Client's reading of the recorded fixtures (`contracts/storage.support`)
 * or small synthetic values. Stored state is built from synthetic rows passed through the row
 * schemas of `src/db/rows`, so every row used here is a valid row. No database, no network.
 */
import { dedupeListing, planDetailsSave, planListingSave } from '../../src/db/plan';
import {
  commentColumns,
  detailsColumns,
  flattenComments,
  summaryColumns,
} from '../../src/db/mappers';
import { CommentRowSchema, PlaceRowSchema, TagLinkRowSchema } from '../../src/db/rows';
import type {
  CommentRow,
  DetailsPlan,
  DetailsState,
  ListingState,
  PlaceDetailsWrite,
  PlaceRow,
  TagLinkRow,
} from '../../src/db/types';
import { buildWikimapiaLink } from '../../contracts/storage.schema';
import type { SaveOutcomeKind, SavePlaceDetailsInput } from '../../contracts/storage.schema';
import {
  EVEN_LATER_FETCHED_AT,
  FETCHED_AT,
  LATER_FETCHED_AT,
  at,
  clientDetails,
  clientListing,
  nestedDetails,
  nestedParts,
  omitKeys,
  rehome,
  summaryOf,
} from '../../contracts/storage.support';
import type {
  Comment,
  PlaceDetails,
  PlaceSummary,
  Tag,
} from '../../contracts/wikimapia-client.schema';

type Presence = 'present' | 'gone';

const PLACE = 62587;
const PARK = 1381893;
const LIBRARY = 164369;

// ---------------------------------------------------------------------------
// Synthetic stored state
// ---------------------------------------------------------------------------

const NULL_DETAILS = {
  description: null,
  is_building: null,
  is_region: null,
  is_deleted: null,
  parent_place_id: null,
  wikipedia_url: null,
  address_street: null,
  address_house_number: null,
  address_city: null,
  address_place: null,
  address_state: null,
  address_country: null,
  details_fetched_at_text: null,
};

/** A summary-only `places` row holding exactly this summary. */
function summaryOnlyRow(s: PlaceSummary): PlaceRow {
  return PlaceRowSchema.parse({ place_id: s.placeId, ...summaryColumns(s), ...NULL_DETAILS });
}

/** A detailed `places` row holding exactly these details, this link and this moment. */
function detailedRow(
  d: PlaceDetails,
  link: string = buildWikimapiaLink(d.placeId),
  moment: string = FETCHED_AT,
): PlaceRow {
  return PlaceRowSchema.parse({
    place_id: d.placeId,
    wikimapia_url: link,
    ...detailsColumns(d, moment),
    details_fetched_at_text: moment,
  });
}

/** Present `comments` rows for these comments, as a Details Save of them would leave them. */
function presentCommentRows(placeId: number, comments: readonly Comment[]): CommentRow[] {
  return flattenComments(comments).map((flat) =>
    CommentRowSchema.parse(commentColumns(placeId, flat)),
  );
}

/** The same row marked Gone (keeps every value and its `parent_num`). */
function gone(row: CommentRow): CommentRow {
  return CommentRowSchema.parse({ ...row, presence: 'gone', position: null });
}

function commentRowOf(rows: readonly CommentRow[], num: number): CommentRow {
  const row = rows.find((r) => r.num === num);
  if (row === undefined) throw new Error(`no comment row ${String(num)}`);
  return row;
}

function linkRow(
  placeId: number,
  tag: Tag,
  presence: Presence,
  position: number | null,
): TagLinkRow {
  return TagLinkRowSchema.parse({
    place_id: placeId,
    tag_id: tag.id,
    presence,
    position,
    title: tag.title,
  });
}

function presentLinkRows(d: PlaceDetails): TagLinkRow[] {
  return d.tags.map((t, i) => linkRow(d.placeId, t, 'present', i));
}

function titlesOf(tags: readonly Tag[]): Map<number, string> {
  return new Map(tags.map((t): [number, string] => [t.id, t.title]));
}

/** Stored state equal to what a Details Save of `d` at `moment` leaves behind. */
function stateOf(
  d: PlaceDetails,
  moment: string = FETCHED_AT,
  link: string = buildWikimapiaLink(d.placeId),
): DetailsState {
  return {
    place: detailedRow(d, link, moment),
    comments: presentCommentRows(d.placeId, d.comments),
    links: presentLinkRows(d),
    tagTitles: titlesOf(d.tags),
  };
}

function emptyState(): DetailsState {
  return { place: undefined, comments: [], links: [], tagTitles: new Map() };
}

function input(d: PlaceDetails, fetchedAt: string = FETCHED_AT): SavePlaceDetailsInput {
  return { details: d, fetchedAt };
}

function noWrites(outcome: SaveOutcomeKind, place: PlaceDetailsWrite | undefined): DetailsPlan {
  return {
    outcome,
    place,
    tagUpserts: [],
    linkWrites: [],
    goneLinks: [],
    commentWrites: [],
    goneComments: [],
  };
}

/**
 * 62587 after the AC-27 reduction saved at LATER_FETCHED_AT: comment 1 and tag 44926 Gone,
 * comment 2 and tag 46360 Present at position 0.
 */
function reducedState(d: PlaceDetails, tagTitles: Map<number, string>): DetailsState {
  const c1 = at(d.comments, 0);
  const c2 = at(d.comments, 1);
  const t0 = at(d.tags, 0);
  const t1 = at(d.tags, 1);
  const full = presentCommentRows(d.placeId, d.comments);
  return {
    place: detailedRow(d, buildWikimapiaLink(d.placeId), LATER_FETCHED_AT),
    comments: [gone(commentRowOf(full, c1.num)), ...presentCommentRows(d.placeId, [c2])],
    links: [linkRow(d.placeId, t0, 'gone', null), linkRow(d.placeId, t1, 'present', 0)],
    tagTitles,
  };
}

function reduced(d: PlaceDetails): PlaceDetails {
  return { ...d, comments: [at(d.comments, 1)], tags: [at(d.tags, 1)] };
}

/** `[kind, num, parentNum, position]` of each planned comment write. */
function commentWriteKeys(plan: DetailsPlan): [string, number, number | null, number][] {
  return plan.commentWrites.map((w) => [
    w.kind,
    w.flat.comment.num,
    w.flat.parentNum,
    w.flat.position,
  ]);
}

async function belgradePage(): Promise<PlaceSummary[]> {
  return (await clientListing('box-belgrade-page1.json')).places;
}

// ===========================================================================
// dedupeListing (AL4 1.4.5; AC-13)
// ===========================================================================

describe('dedupeListing', () => {
  it('keeps the first-appearance order and the last value of each Place ID', async () => {
    const page = await belgradePage();
    const first = summaryOf({ page: 1, pageSize: 10, totalFound: 290, places: page }, PARK);
    const square = summaryOf({ page: 1, pageSize: 10, totalFound: 290, places: page }, PLACE);
    const last: PlaceSummary = { ...first, name: 'Studentski park' };
    const places = [first, square, last];
    const copy = structuredClone(places);

    expect(dedupeListing(places)).toStrictEqual([last, square]);
    expect(places).toStrictEqual(copy);
  });

  it('returns a page without duplicates unchanged, as a new array', async () => {
    const page = await belgradePage();
    const copy = structuredClone(page);
    const deduped = dedupeListing(page);
    expect(deduped).toStrictEqual(page);
    expect(deduped).not.toBe(page);
    expect(page).toStrictEqual(copy);
  });

  it('returns [] for an empty list', () => {
    expect(dedupeListing([])).toStrictEqual([]);
  });

  it('is idempotent', async () => {
    const page = await belgradePage();
    const park = summaryOf({ page: 1, pageSize: 10, totalFound: 290, places: page }, PARK);
    const once = dedupeListing([park, ...page, { ...park, name: 'x' }]);
    expect(dedupeListing(once)).toStrictEqual(once);
  });
});

// ===========================================================================
// planListingSave (AL4 1.4.5 table; AC-7, AC-9 .. AC-13, AC-63, D1, D6)
// ===========================================================================

describe('planListingSave', () => {
  async function park(): Promise<PlaceSummary> {
    return summaryOf(await clientListing('box-belgrade-page1.json'), PARK);
  }

  const LOCATION_KEYS = ['lon', 'lat', 'north', 'south', 'east', 'west'] as const;

  it('no stored row: insert_summary carrying the summary, Created (AC-7)', async () => {
    const page = await belgradePage();
    const plan = planListingSave(page, { rows: [] });
    expect(plan).toStrictEqual({
      outcomes: page.map((s) => ({ placeId: s.placeId, outcome: 'created' })),
      writes: page.map((s) => ({ kind: 'insert_summary', summary: s })),
    });
    expect(plan.outcomes.map((o) => o.placeId)).toStrictEqual([PARK, PLACE, LIBRARY]);
  });

  it('summary-only rows equal to the page: no write, Unchanged (AC-9)', async () => {
    const page = await belgradePage();
    const state: ListingState = { rows: page.map(summaryOnlyRow) };
    expect(planListingSave(page, state)).toStrictEqual({
      outcomes: page.map((s) => ({ placeId: s.placeId, outcome: 'unchanged' })),
      writes: [],
    });
  });

  describe('summary-only row, one difference: update_summary, Updated (AC-10)', () => {
    function expectUpdate(stored: PlaceSummary, incoming: PlaceSummary): void {
      expect(planListingSave([incoming], { rows: [summaryOnlyRow(stored)] })).toStrictEqual({
        outcomes: [{ placeId: incoming.placeId, outcome: 'updated' }],
        writes: [{ kind: 'update_summary', summary: incoming }],
      });
    }

    it('name', async () => {
      const s = await park();
      expectUpdate(s, { ...s, name: 'University Park (Studentski park)' });
    });

    it('wikimapia_url', async () => {
      const s = await park();
      expectUpdate(s, { ...s, url: 'http://wikimapia.org/1381893/Studentski-park' });
    });

    it.each(LOCATION_KEYS)('location %s (tiny float change, exact ===)', async (key) => {
      const s = await park();
      const location = { ...s.location, [key]: s.location[key] + 1e-12 };
      expect(location[key]).not.toBe(s.location[key]);
      expectUpdate(s, { ...s, location });
    });

    it('one outline point', async () => {
      const s = await park();
      const p0 = at(s.outline, 0);
      expectUpdate(s, {
        ...s,
        outline: [{ lon: p0.lon, lat: p0.lat + 1e-12 }, ...s.outline.slice(1)],
      });
    });

    it('0.1 + 0.2 is not 0.3: no rounding, no tolerance', async () => {
      const s = await park();
      const storedOutline = [{ lon: 0.1 + 0.2, lat: 44.8198 }, ...s.outline.slice(1)];
      const incomingOutline = [{ lon: 0.3, lat: 44.8198 }, ...s.outline.slice(1)];
      expectUpdate({ ...s, outline: storedOutline }, { ...s, outline: incomingOutline });
    });

    it('an outline with one point more', async () => {
      const s = await park();
      expectUpdate(s, { ...s, outline: [...s.outline, at(s.outline, 0)] });
    });

    it('an outline with one point fewer', async () => {
      const s = await park();
      expectUpdate(s, { ...s, outline: s.outline.slice(0, 3) });
    });
  });

  it('detailed row with a different name, location and outline but the same link: no write, Unchanged (AC-11, D1)', async () => {
    const square = summaryOf(await clientListing('box-belgrade-page1.json'), PLACE);
    const d = await clientDetails('getbyid-62587.json');
    const summary: PlaceSummary = {
      ...square,
      name: 'Republic Square',
      location: {
        lon: 20.46,
        lat: 44.816,
        north: 44.817,
        south: 44.815,
        east: 20.461,
        west: 20.459,
      },
      outline: [
        { lon: 20.459, lat: 44.815 },
        { lon: 20.461, lat: 44.815 },
        { lon: 20.46, lat: 44.817 },
      ],
    };
    const state: ListingState = { rows: [detailedRow(d, square.url)] };
    expect(planListingSave([summary], state)).toStrictEqual({
      outcomes: [{ placeId: PLACE, outcome: 'unchanged' }],
      writes: [],
    });
  });

  it('detailed row with the Built Link: exactly one update_link, Updated (AC-63, D6)', async () => {
    const summary = await park();
    const d = await clientDetails('getbyid-1381893.json');
    const state: ListingState = { rows: [detailedRow(d, buildWikimapiaLink(PARK))] };
    expect(planListingSave([summary], state)).toStrictEqual({
      outcomes: [{ placeId: PARK, outcome: 'updated' }],
      writes: [
        {
          kind: 'update_link',
          placeId: PARK,
          url: 'http://wikimapia.org/1381893/University-Park',
        },
      ],
    });
  });

  it('mixed page: outcomes in page order, one write per changed place in the same order', async () => {
    const page = await belgradePage();
    const book = { page: 1, pageSize: 10, totalFound: 290, places: page };
    const parkSummary = summaryOf(book, PARK);
    const squareSummary = summaryOf(book, PLACE);
    const library = summaryOf(book, LIBRARY);
    const changedLibrary: PlaceSummary = { ...library, name: `${library.name} (renamed)` };
    const fresh: PlaceSummary = {
      ...library,
      placeId: 4242,
      url: 'http://wikimapia.org/4242/Synthetic-Place',
    };
    const square = await clientDetails('getbyid-62587.json');
    const state: ListingState = {
      rows: [
        detailedRow(square, buildWikimapiaLink(PLACE)),
        summaryOnlyRow(library),
        summaryOnlyRow(parkSummary),
      ],
    };

    const plan = planListingSave([fresh, parkSummary, changedLibrary, squareSummary], state);
    expect(plan).toStrictEqual({
      outcomes: [
        { placeId: 4242, outcome: 'created' },
        { placeId: PARK, outcome: 'unchanged' },
        { placeId: LIBRARY, outcome: 'updated' },
        { placeId: PLACE, outcome: 'updated' },
      ],
      writes: [
        { kind: 'insert_summary', summary: fresh },
        { kind: 'update_summary', summary: changedLibrary },
        { kind: 'update_link', placeId: PLACE, url: squareSummary.url },
      ],
    });
  });

  describe('duplicate ids on the page (AC-13)', () => {
    it('no stored row: one outcome per id at the first appearance, planned from the last value', async () => {
      const page = await belgradePage();
      const book = { page: 1, pageSize: 10, totalFound: 290, places: page };
      const first = summaryOf(book, PARK);
      const square = summaryOf(book, PLACE);
      const last: PlaceSummary = { ...first, name: 'Studentski park' };
      expect(planListingSave([first, square, last], { rows: [] })).toStrictEqual({
        outcomes: [
          { placeId: PARK, outcome: 'created' },
          { placeId: PLACE, outcome: 'created' },
        ],
        writes: [
          { kind: 'insert_summary', summary: last },
          { kind: 'insert_summary', summary: square },
        ],
      });
    });

    it('stored row equal to the first value: the last value decides (Updated)', async () => {
      const first = await park();
      const last: PlaceSummary = { ...first, name: 'Studentski park' };
      expect(planListingSave([first, last], { rows: [summaryOnlyRow(first)] })).toStrictEqual({
        outcomes: [{ placeId: PARK, outcome: 'updated' }],
        writes: [{ kind: 'update_summary', summary: last }],
      });
    });

    it('stored row equal to the last value: Unchanged', async () => {
      const first = await park();
      const last: PlaceSummary = { ...first, name: 'Studentski park' };
      expect(planListingSave([first, last], { rows: [summaryOnlyRow(last)] })).toStrictEqual({
        outcomes: [{ placeId: PARK, outcome: 'unchanged' }],
        writes: [],
      });
    });
  });

  it('empty page plans nothing (AC-12)', async () => {
    const page = await belgradePage();
    const state: ListingState = { rows: page.map(summaryOnlyRow) };
    expect(planListingSave([], state)).toStrictEqual({ outcomes: [], writes: [] });
  });

  it('stored rows for ids not on the page are ignored', async () => {
    const page = await belgradePage();
    const s = await park();
    const state: ListingState = {
      rows: page.map((p) => summaryOnlyRow({ ...p, name: `${p.name} (old)` })),
    };
    const changed = { ...s, name: `${s.name} (old)` };
    expect(planListingSave([changed], state)).toStrictEqual({
      outcomes: [{ placeId: PARK, outcome: 'unchanged' }],
      writes: [],
    });
  });

  it('is deterministic and never mutates the input or the state', async () => {
    const page = await belgradePage();
    const s = await park();
    const places = [...page, { ...s, name: 'Studentski park' }];
    const state: ListingState = { rows: page.slice(1).map(summaryOnlyRow) };
    const placesCopy = structuredClone(places);
    const stateCopy = structuredClone(state);
    const a = planListingSave(places, state);
    const b = planListingSave(places, state);
    expect(a).toStrictEqual(b);
    expect(places).toStrictEqual(placesCopy);
    expect(state).toStrictEqual(stateCopy);
  });
});

// ===========================================================================
// planDetailsSave (AL4 1.4.6)
// ===========================================================================

describe('planDetailsSave: place row', () => {
  it('new place: insert with the Built Link, every tag upserted and linked, every comment inserted, Created (AC-16)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const plan = planDetailsSave(input(d), emptyState());
    expect(plan).toStrictEqual({
      outcome: 'created',
      place: { kind: 'insert', wikimapiaUrl: 'http://wikimapia.org/62587' },
      tagUpserts: [...d.tags].sort((a, b) => a.id - b.id),
      linkWrites: d.tags.map((t, i) => ({ kind: 'insert', tagId: t.id, position: i })),
      goneLinks: [],
      commentWrites: flattenComments(d.comments).map((flat) => ({ kind: 'insert', flat })),
      goneComments: [],
    });
    expect(plan.linkWrites.map((w) => w.tagId)).toStrictEqual([44926, 46360]);
    expect(commentWriteKeys(plan)).toStrictEqual([
      ['insert', 1, null, 0],
      ['insert', 2, null, 1],
    ]);
  });

  it('new details-only place gets the Built Link (AC-31)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    expect(planDetailsSave(input(d), emptyState())).toStrictEqual({
      outcome: 'created',
      place: { kind: 'insert', wikimapiaUrl: buildWikimapiaLink(PARK) },
      tagUpserts: [{ id: 194, title: 'park' }],
      linkWrites: [{ kind: 'insert', tagId: 194, position: 0 }],
      goneLinks: [],
      commentWrites: [],
      goneComments: [],
    });
  });

  it('new place with nested replies: comment inserts in pre-order with parents and positions', async () => {
    const d = await nestedDetails();
    const plan = planDetailsSave(input(d), emptyState());
    expect(plan.outcome).toBe('created');
    expect(commentWriteKeys(plan)).toStrictEqual([
      ['insert', 1, null, 0],
      ['insert', 2, 1, 0],
      ['insert', 5, 2, 0],
    ]);
    expect(plan.commentWrites).toStrictEqual(
      flattenComments(d.comments).map((flat) => ({ kind: 'insert', flat })),
    );
  });

  it('new place whose tag is already in the catalogue with the same title: not upserted, still linked (AC-40)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const withShared: PlaceDetails = {
      ...d,
      tags: [...d.tags, { id: 46360, title: 'town square' }],
    };
    const state: DetailsState = {
      ...emptyState(),
      tagTitles: new Map([[46360, 'town square']]),
    };
    const plan = planDetailsSave(input(withShared), state);
    expect(plan.outcome).toBe('created');
    expect(plan.tagUpserts).toStrictEqual([{ id: 194, title: 'park' }]);
    expect(plan.linkWrites).toStrictEqual([
      { kind: 'insert', tagId: 194, position: 0 },
      { kind: 'insert', tagId: 46360, position: 1 },
    ]);
  });

  it('summary-only row: update_details, Updated; no plan field carries a link (AC-20, D6)', async () => {
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), PARK);
    const d = await clientDetails('getbyid-1381893.json');
    const state: DetailsState = {
      ...emptyState(),
      place: summaryOnlyRow({ ...summary, name: 'Univerzitetski park' }),
    };
    const plan = planDetailsSave(input(d), state);
    expect(plan).toStrictEqual({
      outcome: 'updated',
      place: { kind: 'update_details' },
      tagUpserts: [{ id: 194, title: 'park' }],
      linkWrites: [{ kind: 'insert', tagId: 194, position: 0 }],
      goneLinks: [],
      commentWrites: [],
      goneComments: [],
    });
    expect(JSON.stringify(plan)).not.toContain('wikimapia.org');
  });

  it('summary-only row equal in every shared value still becomes update_details (Updated)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const summary = summaryOf(await clientListing('box-belgrade-page1.json'), PARK);
    const state: DetailsState = {
      place: summaryOnlyRow({ ...summary, name: d.title, location: summary.location }),
      comments: [],
      links: presentLinkRows(d),
      tagTitles: titlesOf(d.tags),
    };
    expect(planDetailsSave(input(d), state)).toStrictEqual(
      noWrites('updated', { kind: 'update_details' }),
    );
  });

  it.each<[string, () => Promise<PlaceDetails>]>([
    ['62587', (): Promise<PlaceDetails> => clientDetails('getbyid-62587.json')],
    ['1381893', (): Promise<PlaceDetails> => clientDetails('getbyid-1381893.json')],
    ['nested replies', nestedDetails],
  ])('identical state and moment (%s): nothing planned, Unchanged (AC-21)', async (_name, load) => {
    const d = await load();
    expect(planDetailsSave(input(d), stateOf(d))).toStrictEqual(noWrites('unchanged', undefined));
  });

  it('a Listing Link stored on a detailed row is irrelevant to the plan (D6, AC-31)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const state = stateOf(d, FETCHED_AT, 'http://wikimapia.org/1381893/University-Park');
    expect(planDetailsSave(input(d), state)).toStrictEqual(noWrites('unchanged', undefined));
    const changed = planDetailsSave(
      input({ ...d, description: 'changed' }, LATER_FETCHED_AT),
      state,
    );
    expect(changed).toStrictEqual(noWrites('updated', { kind: 'update_details' }));
    expect(JSON.stringify(changed)).not.toContain('wikimapia.org');
  });

  it('only the moment moved: update_fetched_at, Unchanged (AC-22, D3)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    expect(planDetailsSave(input(d, LATER_FETCHED_AT), stateOf(d))).toStrictEqual(
      noWrites('unchanged', { kind: 'update_fetched_at' }),
    );
  });

  it('absent optional items equal stored nulls (AC-24)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    expect(d).not.toHaveProperty('parentPlaceId');
    expect(d.location).not.toHaveProperty('street');
    expect(planDetailsSave(input(d), stateOf(d))).toStrictEqual(noWrites('unchanged', undefined));
  });

  type Change = (d: PlaceDetails) => { stored: PlaceDetails; incoming: PlaceDetails };
  const same =
    (f: (d: PlaceDetails) => PlaceDetails): Change =>
    (d) => ({ stored: d, incoming: f(d) });

  it.each<[string, Change]>([
    ['title', same((d) => ({ ...d, title: 'Republic Square' }))],
    ['description', same((d) => ({ ...d, description: `${d.description}\nRenovated in 2019.` }))],
    ['is_building flag', same((d) => ({ ...d, isBuilding: !d.isBuilding }))],
    ['is_region flag', same((d) => ({ ...d, isRegion: !d.isRegion }))],
    ['is_deleted flag', same((d) => ({ ...d, isDeleted: !d.isDeleted }))],
    ['parentPlaceId added', same((d) => ({ ...d, parentPlaceId: 999 }))],
    [
      'parentPlaceId removed',
      (d) => ({ stored: { ...d, parentPlaceId: 999 }, incoming: omitKeys(d, 'parentPlaceId') }),
    ],
    ['wikipediaUrl removed', same((d) => omitKeys(d, 'wikipediaUrl'))],
    [
      'wikipediaUrl changed',
      same((d) => ({ ...d, wikipediaUrl: 'http://sr.wikipedia.org/wiki/Trg_Republike' })),
    ],
    ['address item removed', same((d) => ({ ...d, location: omitKeys(d.location, 'city') }))],
    [
      'address item added',
      same((d) => ({ ...d, location: { ...d.location, street: 'Trg Republike' } })),
    ],
    ['address item changed', same((d) => ({ ...d, location: { ...d.location, city: 'Beograd' } }))],
    [
      'location number (tiny float change)',
      same((d) => ({ ...d, location: { ...d.location, lon: d.location.lon + 1e-12 } })),
    ],
    [
      'bound number',
      same((d) => ({ ...d, location: { ...d.location, north: d.location.north + 1e-12 } })),
    ],
    [
      'outline point',
      same((d) => {
        const p = at(d.outline, 3);
        return {
          ...d,
          outline: [
            ...d.outline.slice(0, 3),
            { lon: p.lon, lat: p.lat + 1e-12 },
            ...d.outline.slice(4),
          ],
        };
      }),
    ],
    ['outline shortened', same((d) => ({ ...d, outline: d.outline.slice(0, 5) }))],
  ])(
    'details column changed (%s): update_details, Updated (AC-23, AC-24)',
    async (_name, change) => {
      const d = await clientDetails('getbyid-62587.json');
      const { stored, incoming } = change(d);
      expect(planDetailsSave(input(incoming), stateOf(stored))).toStrictEqual(
        noWrites('updated', { kind: 'update_details' }),
      );
      expect(planDetailsSave(input(incoming, LATER_FETCHED_AT), stateOf(stored))).toStrictEqual(
        noWrites('updated', { kind: 'update_details' }),
      );
    },
  );

  it('several details changes at once are still one update_details (AC-23)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const d2: PlaceDetails = {
      ...d,
      title: 'Republic Square',
      isBuilding: true,
      outline: d.outline.slice(0, 5),
      location: { ...d.location, lon: 20.4604, street: 'Trg Republike' },
    };
    expect(planDetailsSave(input(d2, LATER_FETCHED_AT), stateOf(d))).toStrictEqual(
      noWrites('updated', { kind: 'update_details' }),
    );
  });
});

describe('planDetailsSave: comments', () => {
  it('one value field of one comment changed: one update, Updated (AC-25)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const changed: Comment = { ...at(d.comments, 0), message: 'Still waiting.' };
    const plan = planDetailsSave(
      input({ ...d, comments: [changed, at(d.comments, 1)] }),
      stateOf(d),
    );
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      commentWrites: [{ kind: 'update', flat: { comment: changed, parentNum: null, position: 0 } }],
    });
  });

  it.each<[string, (c: Comment) => Comment]>([
    ['langId', (c) => ({ ...c, langId: c.langId + 1 })],
    ['author', (c) => ({ ...c, author: `${c.author} Jr.` })],
    ['authorUserId', (c) => ({ ...c, authorUserId: c.authorUserId + 1 })],
    ['goodVotes', (c) => ({ ...c, goodVotes: c.goodVotes + 1 })],
    ['badVotes', (c) => ({ ...c, badVotes: c.badVotes + 1 })],
    ['isBlocked', (c) => ({ ...c, isBlocked: !c.isBlocked })],
    ['isDeleted', (c) => ({ ...c, isDeleted: !c.isDeleted })],
    ['postedAtEpochSeconds', (c) => ({ ...c, postedAtEpochSeconds: c.postedAtEpochSeconds + 1 })],
    ['moderatorUserId', (c) => ({ ...c, moderatorUserId: c.moderatorUserId + 1 })],
    ['moderatorName set', (c) => ({ ...c, moderatorName: 'Synthetic Moderator' })],
    ['authorPhotoUrl set', (c) => ({ ...c, authorPhotoUrl: 'http://example.org/synthetic.png' })],
  ])('comment field %s changed: one update', async (_name, change) => {
    const d = await clientDetails('getbyid-62587.json');
    const base = at(d.comments, 1);
    const changed = change(base);
    expect(changed).not.toStrictEqual(base);
    const plan = planDetailsSave(
      input({ ...d, comments: [at(d.comments, 0), changed] }),
      stateOf(d),
    );
    expect(plan.outcome).toBe('updated');
    expect(plan.commentWrites).toStrictEqual([
      { kind: 'update', flat: { comment: changed, parentNum: null, position: 1 } },
    ]);
  });

  it('several value fields of one comment changed: still one update (AC-25)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const changed: Comment = {
      ...at(d.comments, 0),
      message: 'Still waiting.',
      goodVotes: 6,
      badVotes: 16,
      isDeleted: true,
      isBlocked: true,
    };
    const plan = planDetailsSave(
      input({ ...d, comments: [changed, at(d.comments, 1)] }, LATER_FETCHED_AT),
      stateOf(d),
    );
    expect(plan).toStrictEqual({
      ...noWrites('updated', { kind: 'update_fetched_at' }),
      commentWrites: [{ kind: 'update', flat: { comment: changed, parentNum: null, position: 0 } }],
    });
  });

  it('one new comment: one insert, Updated (AC-26)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const { paul } = await nestedParts();
    const third = rehome(paul, PLACE, 3);
    const plan = planDetailsSave(input({ ...d, comments: [...d.comments, third] }), stateOf(d));
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      commentWrites: [{ kind: 'insert', flat: { comment: third, parentNum: null, position: 2 } }],
    });
  });

  it('two top-level comments swapped: update for both, in pre-order', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const c1 = at(d.comments, 0);
    const c2 = at(d.comments, 1);
    const plan = planDetailsSave(input({ ...d, comments: [c2, c1] }), stateOf(d));
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      commentWrites: [
        { kind: 'update', flat: { comment: c2, parentNum: null, position: 0 } },
        { kind: 'update', flat: { comment: c1, parentNum: null, position: 1 } },
      ],
    });
  });

  it('reply moved to the top level: update for that reply only (AC-37)', async () => {
    const d = await nestedDetails();
    const { mateja, serbia, paul } = await nestedParts();
    const moved: PlaceDetails = { ...d, comments: [{ ...mateja, replies: [serbia] }, paul] };
    const plan = planDetailsSave(input(moved), stateOf(d));
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      commentWrites: [{ kind: 'update', flat: { comment: paul, parentNum: null, position: 1 } }],
    });
  });

  it('a stored gone comment present again with the same values: one update, Updated (AC-65)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const c1 = at(d.comments, 0);
    const c2 = at(d.comments, 1);
    const state = reducedState(d, titlesOf(reduced(d).tags));
    const plan = planDetailsSave(
      input({ ...reduced(d), comments: [c2, c1] }, LATER_FETCHED_AT),
      state,
    );
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      commentWrites: [{ kind: 'update', flat: { comment: c1, parentNum: null, position: 1 } }],
    });
  });

  it('a stored gone comment present again with new values: one update, Updated (AC-65)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const back: Comment = {
      ...at(d.comments, 0),
      message: 'Everybody is waiting for someone here',
      goodVotes: 9,
    };
    const state = reducedState(d, titlesOf(reduced(d).tags));
    const plan = planDetailsSave(
      input({ ...reduced(d), comments: [at(d.comments, 1), back] }, LATER_FETCHED_AT),
      state,
    );
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      commentWrites: [{ kind: 'update', flat: { comment: back, parentNum: null, position: 1 } }],
    });
  });
});

describe('planDetailsSave: gone items (D2)', () => {
  it('present comment and link missing from the input are marked gone; Updated (AC-27)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const r = reduced(d);
    const state: DetailsState = { ...stateOf(d), tagTitles: titlesOf(r.tags) };
    expect(planDetailsSave(input(r, LATER_FETCHED_AT), state)).toStrictEqual({
      outcome: 'updated',
      place: { kind: 'update_fetched_at' },
      tagUpserts: [],
      linkWrites: [{ kind: 'update', tagId: 46360, position: 0 }],
      goneLinks: [44926],
      commentWrites: [
        { kind: 'update', flat: { comment: at(d.comments, 1), parentNum: null, position: 0 } },
      ],
      goneComments: [1],
    });
  });

  it('all comments and links gone: listed ascending whatever the row order (AC-68)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const base = stateOf(d);
    const state: DetailsState = {
      ...base,
      comments: [...base.comments].reverse(),
      links: [...base.links].reverse(),
      tagTitles: new Map(),
    };
    expect(planDetailsSave(input({ ...d, comments: [], tags: [] }), state)).toStrictEqual({
      ...noWrites('updated', undefined),
      goneLinks: [44926, 46360],
      goneComments: [1, 2],
    });
  });

  it('a gone reply under a present parent: listed by num, no write to the kept rows (AC-66)', async () => {
    const d = await nestedDetails();
    const { mateja, serbia } = await nestedParts();
    const plan = planDetailsSave(
      input({ ...d, comments: [{ ...mateja, replies: [{ ...serbia, replies: [] }] }] }),
      stateOf(d),
    );
    expect(plan).toStrictEqual({ ...noWrites('updated', undefined), goneComments: [5] });
  });

  it('a gone parent with its reply: both listed ascending; the kept reply that moved is updated (AC-67)', async () => {
    const d = await nestedDetails();
    const { paul } = await nestedParts();
    const plan = planDetailsSave(input({ ...d, comments: [paul] }, LATER_FETCHED_AT), stateOf(d));
    expect(plan).toStrictEqual({
      ...noWrites('updated', { kind: 'update_fetched_at' }),
      commentWrites: [{ kind: 'update', flat: { comment: paul, parentNum: null, position: 0 } }],
      goneComments: [1, 2],
    });
  });

  it.each<[string, string, PlaceDetailsWrite | undefined]>([
    ['the same moment', LATER_FETCHED_AT, undefined],
    ['a later moment', EVEN_LATER_FETCHED_AT, { kind: 'update_fetched_at' }],
  ])(
    'already gone rows are not listed again: re-saving the reduction with %s is Unchanged (AC-64)',
    async (_name, moment, place) => {
      const d = await clientDetails('getbyid-62587.json');
      const r = reduced(d);
      const state = reducedState(d, titlesOf(r.tags));
      expect(planDetailsSave(input(r, moment), state)).toStrictEqual(noWrites('unchanged', place));
    },
  );
});

describe('planDetailsSave: tags', () => {
  it('duplicate tag id: one link at the first position, one upsert with the first title (AC-43)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const plan = planDetailsSave(
      input({
        ...d,
        tags: [
          { id: 194, title: 'park' },
          { id: 194, title: 'city park' },
        ],
      }),
      emptyState(),
    );
    expect(plan.tagUpserts).toStrictEqual([{ id: 194, title: 'park' }]);
    expect(plan.linkWrites).toStrictEqual([{ kind: 'insert', tagId: 194, position: 0 }]);
  });

  it('duplicate tag id later in the list: positions follow the deduplicated list', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const t0 = at(d.tags, 0);
    const t1 = at(d.tags, 1);
    const plan = planDetailsSave(
      input({ ...d, tags: [t0, { ...t0, title: 'other title' }, t1] }),
      stateOf(d),
    );
    expect(plan).toStrictEqual(noWrites('unchanged', undefined));
  });

  it('duplicate tag id already stored with the first title: no upsert at all', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const plan = planDetailsSave(
      input({
        ...d,
        tags: [
          { id: 194, title: 'park' },
          { id: 194, title: 'park' },
        ],
      }),
      stateOf(d),
    );
    expect(plan).toStrictEqual(noWrites('unchanged', undefined));
  });

  it('stored title differs from the input title: exactly one upsert, Updated (AC-42)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const base = stateOf(d);
    const state: DetailsState = {
      ...base,
      tagTitles: new Map([
        [44926, 'historic town square'],
        [46360, 'square'],
      ]),
    };
    expect(planDetailsSave(input(d), state)).toStrictEqual({
      ...noWrites('updated', undefined),
      tagUpserts: [{ id: 46360, title: 'town square' }],
    });
  });

  it('title change with a later moment: one upsert plus update_fetched_at, Updated (AC-42)', async () => {
    const park = await clientDetails('getbyid-1381893.json');
    const state: DetailsState = { ...stateOf(park), tagTitles: new Map([[194, 'park']]) };
    expect(
      planDetailsSave(
        input({ ...park, tags: [{ id: 194, title: 'city park' }] }, LATER_FETCHED_AT),
        state,
      ),
    ).toStrictEqual({
      ...noWrites('updated', { kind: 'update_fetched_at' }),
      tagUpserts: [{ id: 194, title: 'city park' }],
    });
  });

  it('tags reordered: update links with the new positions, in input order', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const plan = planDetailsSave(input({ ...d, tags: [...d.tags].reverse() }), stateOf(d));
    expect(plan).toStrictEqual({
      ...noWrites('updated', undefined),
      linkWrites: [
        { kind: 'update', tagId: 46360, position: 0 },
        { kind: 'update', tagId: 44926, position: 1 },
      ],
    });
  });

  it('a stored gone link present again: one link update, Updated (AC-65)', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const t0 = at(d.tags, 0);
    const t1 = at(d.tags, 1);
    const back: PlaceDetails = { ...reduced(d), tags: [t1, t0] };
    const state = reducedState(d, titlesOf(back.tags));
    expect(planDetailsSave(input(back, EVEN_LATER_FETCHED_AT), state)).toStrictEqual({
      ...noWrites('updated', { kind: 'update_fetched_at' }),
      linkWrites: [{ kind: 'update', tagId: 44926, position: 1 }],
    });
  });

  it('a gone link to a shared tag: listed only in goneLinks, no upsert (AC-69)', async () => {
    const square = await clientDetails('getbyid-62587.json');
    const r: PlaceDetails = { ...square, tags: [at(square.tags, 0)] };
    const state: DetailsState = { ...stateOf(square), tagTitles: titlesOf(r.tags) };
    expect(planDetailsSave(input(r, LATER_FETCHED_AT), state)).toStrictEqual({
      ...noWrites('updated', { kind: 'update_fetched_at' }),
      goneLinks: [46360],
    });
  });

  it('a stored link to a tag not in tagTitles is upserted (title unknown counts as missing)', async () => {
    const d = await clientDetails('getbyid-1381893.json');
    const state: DetailsState = { ...stateOf(d), tagTitles: new Map() };
    expect(planDetailsSave(input(d), state)).toStrictEqual({
      ...noWrites('updated', undefined),
      tagUpserts: [{ id: 194, title: 'park' }],
    });
  });
});

describe('planDetailsSave: ordering and determinism', () => {
  it('tagUpserts ascending by id; linkWrites in deduplicated input order', async () => {
    const d = await clientDetails('getbyid-62587.json');
    const tags: Tag[] = [
      { id: 46360, title: 'town square' },
      { id: 194, title: 'park' },
      { id: 46360, title: 'duplicate' },
      { id: 44926, title: 'historic town square' },
    ];
    const plan = planDetailsSave(input({ ...d, tags }), emptyState());
    expect(plan.tagUpserts).toStrictEqual([
      { id: 194, title: 'park' },
      { id: 44926, title: 'historic town square' },
      { id: 46360, title: 'town square' },
    ]);
    expect(plan.linkWrites).toStrictEqual([
      { kind: 'insert', tagId: 46360, position: 0 },
      { kind: 'insert', tagId: 194, position: 1 },
      { kind: 'insert', tagId: 44926, position: 2 },
    ]);
  });

  it('goneLinks and goneComments ascending even when rows arrive scrambled', async () => {
    const d = await nestedDetails();
    const { ramona } = await nestedParts();
    const base = stateOf(d);
    const high = linkRow(PLACE, { id: 900, title: 'z' }, 'present', 2);
    const low = linkRow(PLACE, { id: 7, title: 'a' }, 'present', 3);
    const state: DetailsState = {
      ...base,
      links: [high, ...base.links, low],
      comments: [...base.comments].reverse(),
    };
    const plan = planDetailsSave(input({ ...d, comments: [ramona] }), state);
    expect(plan.goneLinks).toStrictEqual([7, 900]);
    expect(plan.goneComments).toStrictEqual([1, 2, 5]);
    expect(plan.commentWrites).toStrictEqual([
      { kind: 'insert', flat: { comment: ramona, parentNum: null, position: 0 } },
    ]);
  });

  it('two calls with the same input and state give equal plans; neither is mutated', async () => {
    const d = await nestedDetails();
    const { mateja, serbia, paul, ramona } = await nestedParts();
    const incoming: PlaceDetails = {
      ...d,
      title: 'Republic Square',
      tags: [at(d.tags, 1), { id: 194, title: 'park' }],
      comments: [
        { ...mateja, replies: [serbia] },
        ramona,
        { ...paul, goodVotes: paul.goodVotes + 1 },
      ],
    };
    const state: DetailsState = {
      ...stateOf(d),
      tagTitles: new Map([[46360, 'old title']]),
    };
    const inputValue = input(incoming, LATER_FETCHED_AT);
    const inputCopy = structuredClone(inputValue);
    const stateCopy = structuredClone(state);

    const a = planDetailsSave(inputValue, state);
    const b = planDetailsSave(inputValue, state);
    expect(a).toStrictEqual(b);
    expect(inputValue).toStrictEqual(inputCopy);
    expect(state).toStrictEqual(stateCopy);
    expect(state.tagTitles).toStrictEqual(new Map([[46360, 'old title']]));

    expect(a.outcome).toBe('updated');
    expect(a.place).toStrictEqual({ kind: 'update_details' });
    expect(a.tagUpserts).toStrictEqual([
      { id: 194, title: 'park' },
      { id: 46360, title: 'town square' },
    ]);
    expect(a.linkWrites).toStrictEqual([
      { kind: 'update', tagId: 46360, position: 0 },
      { kind: 'insert', tagId: 194, position: 1 },
    ]);
    expect(a.goneLinks).toStrictEqual([44926]);
    expect(commentWriteKeys(a)).toStrictEqual([
      ['insert', 7, null, 1],
      ['update', 5, null, 2],
    ]);
    expect(a.goneComments).toStrictEqual([]);
  });
});
