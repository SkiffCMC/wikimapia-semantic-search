/**
 * AL2 unit tests: `src/db/mappers.ts` (AL4 1.4.6, 1.4.8). Only what the storage contract tests
 * do not reach: absent optional address items in both directions, the defensive comment-tree
 * rule (missing parent, parent cycle) and the not-a-detailed-row guard. Ordering and the
 * ordinary read-back are pinned by the contract tests through the Place Store.
 */
import {
  buildStoredComments,
  commentColumns,
  detailsColumns,
  toDetailedPlace,
} from '../../src/db/mappers';
import { CommentRowSchema, PlaceRowSchema } from '../../src/db/rows';
import type { PlaceRow } from '../../src/db/types';
import { buildWikimapiaLink, type StoredComment } from '../../contracts/storage.schema';
import {
  FETCHED_AT,
  asPlaceDetails,
  clientDetails,
  nestedParts,
  omitKeys,
  rehome,
} from '../../contracts/storage.support';
import type { PlaceDetails } from '../../contracts/wikimapia-client.schema';

const PLACE = 62587;
const ADDRESS_KEYS = ['street', 'houseNumber', 'city', 'place', 'state', 'country'] as const;

async function bareDetails(): Promise<PlaceDetails> {
  const d = await clientDetails('getbyid-62587.json');
  const bare = omitKeys(d, 'parentPlaceId', 'wikipediaUrl');
  return { ...bare, location: omitKeys(d.location, ...ADDRESS_KEYS), tags: [], comments: [] };
}

function detailedRow(d: PlaceDetails): PlaceRow {
  return PlaceRowSchema.parse({
    place_id: d.placeId,
    wikimapia_url: buildWikimapiaLink(d.placeId),
    ...detailsColumns(d, FETCHED_AT),
    details_fetched_at_text: FETCHED_AT,
  });
}

it('absent optional items become null columns and read back as absent keys', async () => {
  const d = await bareDetails();
  const row = detailedRow(d);
  for (const key of ['street', 'house_number', 'city', 'place', 'state', 'country']) {
    expect(row[`address_${key}` as keyof PlaceRow]).toBeNull();
  }
  expect(asPlaceDetails(toDetailedPlace(row, [], []))).toStrictEqual(d);
});

/** `[num, replies]` per node, so the whole tree shape is compared at once. */
type Shape = [number, Shape[]];
const shape = (nodes: StoredComment[]): Shape[] => nodes.map((n) => [n.num, shape(n.replies)]);

it.each<[string, [number, number | null][], Shape[]]>([
  [
    'a missing parent: appended at the top level with its replies',
    [
      [8, 99],
      [3, null],
      [12, 8],
      [1, null],
    ],
    [
      [1, []],
      [3, []],
      [8, [[12, []]]],
    ],
  ],
  [
    'a parent cycle: each row once',
    [
      [10, 11],
      [11, 10],
      [1, null],
    ],
    [
      [1, []],
      [10, [[11, []]]],
    ],
  ],
])('buildStoredComments, %s', async (_, links, expected) => {
  const { mateja } = await nestedParts();
  const rows = links.map(([num, parentNum]) =>
    CommentRowSchema.parse({
      ...commentColumns(PLACE, { comment: rehome(mateja, PLACE, num), parentNum, position: 0 }),
      presence: num === 1 ? 'present' : 'gone',
      position: num === 1 ? 0 : null,
    }),
  );
  expect(shape(buildStoredComments(rows))).toStrictEqual(expected);
});

it.each([
  'description',
  'is_building',
  'is_region',
  'is_deleted',
  'details_fetched_at_text',
] as const)('toDetailedPlace throws a value-free error when %s is null', async (column) => {
  const row = { ...detailedRow(await bareDetails()), [column]: null };
  expect(() => toDetailedPlace(row, [], [])).toThrow(
    new Error('stored place row is not a detailed place'),
  );
});
