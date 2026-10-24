/**
 * AL2 unit tests: `src/db/plan.ts` (AL4 1.4.5, 1.4.6). The contract tests pin every save
 * outcome through the Place Store; what they cannot see is the planned write list. Here: values
 * are compared with exact `===` (no tolerance), and an unchanged save plans no write beyond
 * moving Details Fetched At (D3).
 */
import { planDetailsSave, planListingSave } from '../../src/db/plan';
import {
  commentColumns,
  detailsColumns,
  flattenComments,
  summaryColumns,
} from '../../src/db/mappers';
import { CommentRowSchema, PlaceRowSchema, TagLinkRowSchema } from '../../src/db/rows';
import type { DetailsState } from '../../src/db/types';
import { buildWikimapiaLink } from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  LATER_FETCHED_AT,
  clientDetails,
  clientListing,
  summaryOf,
} from '../../contracts/storage.support';
import type { PlaceDetails, PlaceSummary } from '../../contracts/wikimapia-client.schema';

const NULL_DETAILS = Object.fromEntries(
  [
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
    'details_fetched_at_text',
  ].map((key) => [key, null]),
);

/** Stored state equal to what a Details Save of `d` at FETCHED_AT leaves behind. */
function stateOf(d: PlaceDetails): DetailsState {
  return {
    place: PlaceRowSchema.parse({
      place_id: d.placeId,
      wikimapia_url: buildWikimapiaLink(d.placeId),
      ...detailsColumns(d, FETCHED_AT),
      details_fetched_at_text: FETCHED_AT,
    }),
    comments: flattenComments(d.comments).map((flat) =>
      CommentRowSchema.parse(commentColumns(d.placeId, flat)),
    ),
    links: d.tags.map((t, position) =>
      TagLinkRowSchema.parse({
        place_id: d.placeId,
        tag_id: t.id,
        presence: 'present',
        position,
        title: t.title,
      }),
    ),
    tagTitles: new Map(d.tags.map((t): [number, string] => [t.id, t.title])),
  };
}

it.each<[string, (s: PlaceSummary) => PlaceSummary, boolean]>([
  ['an equal summary', (s) => s, false],
  [
    'a location moved by 1e-12',
    (s) => ({ ...s, location: { ...s.location, lat: s.location.lat + 1e-12 } }),
    true,
  ],
  [
    'an outline point moved by 1e-12',
    (s) => ({
      ...s,
      outline: s.outline.map((p, i) => (i === 0 ? { ...p, lon: p.lon + 1e-12 } : p)),
    }),
    true,
  ],
  ['an outline one point shorter', (s) => ({ ...s, outline: s.outline.slice(1) }), true],
])('planListingSave on a Summary-Only row: %s', async (_, change, updates) => {
  const stored = summaryOf(await clientListing('box-belgrade-page1.json'), 1381893);
  const row = PlaceRowSchema.parse({
    place_id: stored.placeId,
    ...summaryColumns(stored),
    ...NULL_DETAILS,
  });
  const incoming = change(stored);
  expect(planListingSave([incoming], { rows: [row] })).toStrictEqual({
    outcomes: [{ placeId: stored.placeId, outcome: updates ? 'updated' : 'unchanged' }],
    writes: updates ? [{ kind: 'update_summary', summary: incoming }] : [],
  });
});

it.each([
  ['the same moment', FETCHED_AT, undefined],
  ['a later moment', LATER_FETCHED_AT, { kind: 'update_fetched_at' }],
])(
  'planDetailsSave of unchanged details at %s plans no other write',
  async (_, fetchedAt, place) => {
    const d = await clientDetails('getbyid-62587.json');
    expect(planDetailsSave({ details: d, fetchedAt }, stateOf(d))).toStrictEqual({
      outcome: 'unchanged',
      place,
      tagUpserts: [],
      linkWrites: [],
      goneLinks: [],
      commentWrites: [],
      goneComments: [],
    });
  },
);
