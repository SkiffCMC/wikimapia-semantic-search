/**
 * AL2 unit tests: `src/embed/place-document.ts` (AL4 embeddings 1.4.1, U3). AL3 routing
 * 20261023-embeddings-03-place-document, section 2.1.
 *
 * Pure: no database, no network, no fixture files. Every input is a Detailed Place in the
 * Place Store's read-back shape, built with `detailedPlace`, `storedTags` and `storedComments`.
 */
import { buildPlaceDocument } from '../../src/embed/place-document';
import { documentFingerprint } from '../../contracts/embeddings.schema';
import type { BuildPlaceDocumentFn } from '../../contracts/embeddings.schema';
import {
  K_ADDRESS,
  K_COMMENT_1,
  K_COMMENT_3,
  K_COMMENT_4,
  K_DESCRIPTION,
  K_DOCUMENT,
  K_TAGS,
  PLACE_K_ID,
  detailedPlace,
  partsOf,
  storedComments,
  storedTags,
} from '../../contracts/embeddings.support';
import { DetailedPlaceSchema } from '../../contracts/storage.schema';
import type { DetailedPlace, StoredComment } from '../../contracts/storage.schema';
import { longMixedDescription } from '../../contracts/storage.support';

const build: BuildPlaceDocumentFn = buildPlaceDocument;

function placeK(): DetailedPlace {
  return detailedPlace({
    placeId: PLACE_K_ID,
    name: 'Kalemegdan Park',
    description: K_DESCRIPTION,
    address: { ...K_ADDRESS },
    tags: storedTags(
      [K_TAGS.park.title, 'present'],
      [K_TAGS.fortress.title, 'present'],
      [K_TAGS.garden.title, 'gone'],
    ),
    comments: [K_COMMENT_1, { ...K_COMMENT_3, presence: 'gone' }, K_COMMENT_4],
  });
}

function descriptionPart(place: DetailedPlace): string | undefined {
  return partsOf(build(place)).find((p) => p.startsWith('Description:'));
}

function addressPart(place: DetailedPlace): string | undefined {
  return partsOf(build(place)).find((p) => p.startsWith('Address:'));
}

describe('AC-1 Synthetic Place K in the read-back shape', () => {
  it('gives exactly K_DOCUMENT', () => {
    const document = build(placeK());
    expect(document).toBe(K_DOCUMENT);
  });

  it('has no line break before the first or after the last Part', () => {
    const document = build(placeK());
    expect(document.startsWith('\n')).toBe(false);
    expect(document.endsWith('\n')).toBe(false);
  });
});

describe('AC-2 Order of Parts and labels', () => {
  it('Name, Tags (given order), Address (six items in order), Description, Comments, joined by one \\n', () => {
    const place = detailedPlace({
      name: 'Name',
      tags: storedTags(['b-tag', 'present'], ['a-tag', 'present']),
      address: {
        country: 'Country',
        state: 'State',
        place: 'Place',
        city: 'City',
        houseNumber: '7',
        street: 'Street',
      },
      description: 'Text.',
      comments: [
        { num: 1, message: 'First' },
        { num: 2, message: 'Second' },
      ],
    });
    const document = build(place);
    expect(partsOf(document)).toStrictEqual([
      'Name',
      'Tags: b-tag, a-tag',
      'Address: Street, 7, City, Place, State, Country',
      'Description: Text.',
      'Comment: First',
      'Comment: Second',
    ]);
    expect(document).toBe(
      'Name\nTags: b-tag, a-tag\nAddress: Street, 7, City, Place, State, Country\nDescription: Text.\nComment: First\nComment: Second',
    );
    expect(document).not.toContain('\n\n');
  });
});

describe('AC-3 Empty Parts left out', () => {
  it('a Place with nothing but a name gives exactly its name', () => {
    expect(build(detailedPlace({ name: 'Lonely Name' }))).toBe('Lonely Name');
  });

  it('a Place with only Gone Tags and Gone Comments also gives exactly its name', () => {
    const place = detailedPlace({
      name: 'Lonely Name',
      tags: storedTags(['old', 'gone']),
      comments: [{ num: 1, message: 'gone text', presence: 'gone' }],
    });
    expect(build(place)).toBe('Lonely Name');
  });
});

describe('AC-5 Repeated address values once', () => {
  it('city and place both "Belgrade": once, at the position of the first', () => {
    const place = detailedPlace({
      address: { street: 'Knez Mihailova', city: 'Belgrade', place: 'Belgrade', country: 'Serbia' },
    });
    expect(addressPart(place)).toBe('Address: Knez Mihailova, Belgrade, Serbia');
  });

  it('values are compared exactly: "Belgrade" and "belgrade" are both kept', () => {
    const place = detailedPlace({ address: { city: 'Belgrade', place: 'belgrade' } });
    expect(addressPart(place)).toBe('Address: Belgrade, belgrade');
  });

  it('values equal only after tidying appear once', () => {
    const place = detailedPlace({
      address: { city: ' Belgrade ', place: 'Belgrade', state: 'Bel\tgrade', country: 'Bel grade' },
    });
    expect(addressPart(place)).toBe('Address: Belgrade, Bel grade');
  });

  it('items that are blank after tidying are left out', () => {
    const place = detailedPlace({
      address: { street: '   ', houseNumber: '\t', city: 'Belgrade', place: '\r\n', country: 'Serbia' },
    });
    expect(addressPart(place)).toBe('Address: Belgrade, Serbia');
  });

  it('an address whose every item is blank gives no Address Part', () => {
    const place = detailedPlace({
      name: 'N',
      address: {
        street: ' ',
        houseNumber: '\t',
        city: '\r\n',
        place: '  \n ',
        state: ' ',
        country: ' \t ',
      },
    });
    expect(addressPart(place)).toBeUndefined();
    expect(build(place)).toBe('N');
  });

  it('a Place without any address item gives no Address Part', () => {
    expect(addressPart(detailedPlace({ name: 'N' }))).toBeUndefined();
  });
});

describe('AC-6 Bare Web Addresses removed from the description', () => {
  const cases: [string, string | undefined][] = [
    ['See http://example.org/a for more.', 'Description: See for more.'],
    ['Visit www.Example.org today', 'Description: Visit today'],
    ['HTTPS://example.org/x', undefined],
    ['Info: https://a.rs/b?c=1, http://d.rs', 'Description: Info:'],
    ['Birds go awww. at dusk', 'Description: Birds go awww. at dusk'],
  ];
  it.each(cases)('description %j', (description, expected) => {
    expect(descriptionPart(detailedPlace({ name: 'N', description }))).toBe(expected);
  });

  it('"a http://x b" gives "Description: a b" (no words glued together)', () => {
    expect(descriptionPart(detailedPlace({ name: 'N', description: 'a http://x b' }))).toBe(
      'Description: a b',
    );
  });
});

describe('AC-7 Description that is only a web address', () => {
  it.each(['http://example.org', '  https://example.org/x  ', '\n www.example.org \r\n'])(
    'description %j gives no Description Part',
    (description) => {
      expect(build(detailedPlace({ name: 'N', description }))).toBe('N');
    },
  );
});

describe('AC-8 Spacing tidied in every Part kind', () => {
  it('line breaks, CR LF, tabs and runs of spaces become one space, trimmed; blank Tag and Comment left out', () => {
    const place = detailedPlace({
      name: '  Kalemegdan \n Park ',
      tags: storedTags([' old\tfort ', 'present'], ['   ', 'present']),
      address: { street: ' Bulevar \r\n vojvode ', city: '\tBelgrade ' },
      description: '\r\nLine one.\r\nLine\ttwo.   End.  ',
      comments: [
        { num: 1, message: ' a \n\n b ' },
        { num: 2, message: ' \r\n\t ' },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual([
      'Kalemegdan Park',
      'Tags: old fort',
      'Address: Bulevar vojvode, Belgrade',
      'Description: Line one. Line two. End.',
      'Comment: a b',
    ]);
  });

  it('a blank Tag title between others is left out of the list', () => {
    const place = detailedPlace({
      name: 'N',
      tags: storedTags(['first', 'present'], [' \t ', 'present'], ['second', 'present']),
    });
    expect(partsOf(build(place))).toStrictEqual(['N', 'Tags: first, second']);
  });

  it('a blank name gives no Name Part', () => {
    const place = detailedPlace({ name: ' \r\n\t ', description: 'Text.' });
    expect(build(place)).toBe('Description: Text.');
  });
});

describe('AC-9 Text otherwise kept as stored', () => {
  it('HTML entities, Cyrillic and Latin diacritics are kept exactly', () => {
    const description = 'He said &quot;Трг Републике&quot; &amp; Đinđić, Kolarčeva.';
    expect(descriptionPart(detailedPlace({ name: 'N', description }))).toBe(
      `Description: ${description}`,
    );
  });

  it('entities, Cyrillic and diacritics in name, Tags, address and Comments are kept exactly', () => {
    const place = detailedPlace({
      name: 'Трг &amp; Đinđić',
      tags: storedTags(['споменик &quot;', 'present'], ['Čukarica', 'present']),
      address: { street: 'Kolarčeva', city: 'Београд' },
      comments: [{ num: 1, message: 'Lepo &amp; čisto, хвала' }],
    });
    expect(partsOf(build(place))).toStrictEqual([
      'Трг &amp; Đinđić',
      'Tags: споменик &quot;, Čukarica',
      'Address: Kolarčeva, Београд',
      'Comment: Lepo &amp; čisto, хвала',
    ]);
  });
});

describe('AC-10 Long description kept whole', () => {
  it('a description of 7,000+ characters is kept whole, only spacing tidied', () => {
    const description = longMixedDescription('Kalemegdan.');
    expect(description.length).toBeGreaterThanOrEqual(7000);
    expect(descriptionPart(detailedPlace({ name: 'N', description }))).toBe(
      `Description: ${description.replace(/\s+/gu, ' ').trim()}`,
    );
  });
});

describe('AC-11 Which Comments are included', () => {
  it('deleted, blocked and Gone Comments are left out', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        { num: 1, message: 'deleted', isDeleted: true },
        { num: 2, message: 'kept' },
        { num: 3, message: 'blocked', isBlocked: true },
        { num: 4, message: 'gone', presence: 'gone' },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual(['N', 'Comment: kept']);
  });

  it('a Present Reply of a deleted Comment and of a Gone Comment is still included', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        {
          num: 1,
          message: 'deleted parent',
          isDeleted: true,
          replies: [{ num: 2, message: 'reply of deleted' }],
        },
        { num: 3, message: 'blocked', isBlocked: true },
        {
          num: 4,
          message: 'gone parent',
          presence: 'gone',
          replies: [{ num: 5, message: 'reply of gone' }],
        },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual([
      'N',
      'Comment: reply of deleted',
      'Comment: reply of gone',
    ]);
  });

  it('a Present Reply of a blocked Comment is still included', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        {
          num: 1,
          message: 'blocked parent',
          isBlocked: true,
          replies: [{ num: 2, message: 'reply of blocked' }],
        },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual(['N', 'Comment: reply of blocked']);
  });

  it('Gone, deleted and blocked Replies are left out', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        {
          num: 1,
          message: 'parent',
          replies: [
            { num: 2, message: 'gone reply', presence: 'gone' },
            { num: 3, message: 'deleted reply', isDeleted: true },
            { num: 4, message: 'blocked reply', isBlocked: true },
            { num: 5, message: 'kept reply' },
          ],
        },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual(['N', 'Comment: parent', 'Comment: kept reply']);
  });

  it('a Present Reply nested under a left-out Reply of a left-out Comment is still included', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        {
          num: 1,
          message: 'gone top',
          presence: 'gone',
          replies: [
            {
              num: 2,
              message: 'deleted middle',
              isDeleted: true,
              replies: [{ num: 3, message: 'deep kept' }],
            },
          ],
        },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual(['N', 'Comment: deep kept']);
  });
});

describe('AC-12 Comment order', () => {
  it('A, A1, A1x, A2, B: each Comment followed by its Replies at every depth', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        {
          num: 1,
          message: 'A',
          replies: [
            { num: 2, message: 'A1', replies: [{ num: 3, message: 'A1x' }] },
            { num: 4, message: 'A2' },
          ],
        },
        { num: 5, message: 'B' },
      ],
    });
    expect(partsOf(build(place)).filter((p) => p.startsWith('Comment:'))).toStrictEqual([
      'Comment: A',
      'Comment: A1',
      'Comment: A1x',
      'Comment: A2',
      'Comment: B',
    ]);
  });

  it('read-back order is kept, not re-sorted by number', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [
        { num: 9, message: 'nine' },
        { num: 2, message: 'two' },
      ],
    });
    expect(partsOf(build(place))).toStrictEqual(['N', 'Comment: nine', 'Comment: two']);
  });
});

describe('AC-13 Gone Tags left out', () => {
  it('a Gone Tag title appears nowhere in the Document', () => {
    const document = build(placeK());
    expect(partsOf(document)).toContain('Tags: park, fortress');
    expect(document).not.toContain('garden');
  });

  it('a Place whose only Tags are Gone has no Tags Part', () => {
    const place = detailedPlace({
      name: 'N',
      description: 'Text.',
      tags: storedTags(['old one', 'gone'], ['old two', 'gone']),
    });
    const document = build(place);
    expect(partsOf(document).some((p) => p.startsWith('Tags:'))).toBe(false);
    expect(document).toBe('N\nDescription: Text.');
  });
});

describe('AC-14 Bare Web Addresses only removed from descriptions', () => {
  it('a Comment message keeps its web address', () => {
    const place = detailedPlace({
      name: 'N',
      comments: [{ num: 1, message: 'great photos at http://example.org' }],
    });
    expect(partsOf(build(place))).toContain('Comment: great photos at http://example.org');
  });

  it('the name, a Tag title and an address item keep their web addresses', () => {
    const place = detailedPlace({
      name: 'See www.example.org',
      tags: storedTags(['http://tag.example', 'present']),
      address: { street: 'https://street.example/x' },
      description: 'Only http://gone.example here',
    });
    expect(partsOf(build(place))).toStrictEqual([
      'See www.example.org',
      'Tags: http://tag.example',
      'Address: https://street.example/x',
      'Description: Only here',
    ]);
  });
});

describe('Empty Document', () => {
  it('an all-blank Place gives the empty string', () => {
    const place = detailedPlace({
      name: ' \t\r\n ',
      tags: storedTags(['gone tag', 'gone'], ['  ', 'present']),
      address: { street: ' ', city: '\t', country: '\r\n' },
      description: '  https://example.org/only  ',
      comments: [
        { num: 1, message: 'deleted', isDeleted: true },
        { num: 2, message: 'blocked', isBlocked: true },
        { num: 3, message: 'gone', presence: 'gone' },
        { num: 4, message: ' \n\t ' },
      ],
    });
    expect(build(place)).toBe('');
  });

  it('an empty name with nothing else gives the empty string', () => {
    expect(build(detailedPlace({ name: '' }))).toBe('');
  });
});

describe('Deleted Places (Q4)', () => {
  it('isDeleted: true on the Place gives the same Document as isDeleted: false', () => {
    const spec = {
      name: 'Kalemegdan Park',
      description: K_DESCRIPTION,
      address: { ...K_ADDRESS },
      tags: storedTags(['park', 'present']),
      comments: [{ num: 1, message: 'Great sunsets' }],
    };
    const deleted = build(detailedPlace({ ...spec, isDeleted: true }));
    const kept = build(detailedPlace({ ...spec, isDeleted: false }));
    expect(deleted).toBe(kept);
    expect(deleted).not.toBe('');
  });
});

describe('Fields that are never read (AC-20, AC-21, pure side)', () => {
  const base = detailedPlace({
    name: 'Kalemegdan Park',
    description: K_DESCRIPTION,
    address: { ...K_ADDRESS },
    tags: storedTags(['park', 'present']),
    comments: [
      { num: 1, message: 'Great sunsets', replies: [{ num: 2, message: 'Agreed!' }] },
    ],
  });

  function retouch(comments: readonly StoredComment[]): StoredComment[] {
    return comments.map((c) => ({
      ...c,
      author: `${c.author} renamed`,
      goodVotes: c.goodVotes + 5,
      badVotes: c.badVotes + 3,
      postedAtEpochSeconds: c.postedAtEpochSeconds + 86_400,
      replies: retouch(c.replies),
    }));
  }

  const variants: [string, DetailedPlace][] = [
    ['Comment author, votes and posted-at', { ...base, comments: retouch(base.comments) }],
    [
      'outline',
      {
        ...base,
        outline: [
          { lon: 20.45, lat: 44.82 },
          { lon: 20.46, lat: 44.83 },
        ],
      },
    ],
    [
      'location point and bounds',
      {
        ...base,
        location: {
          ...base.location,
          lon: 20.4,
          lat: 44.8,
          north: 44.9,
          south: 44.7,
          east: 20.5,
          west: 20.3,
        },
      },
    ],
    ['wikipediaUrl', { ...base, wikipediaUrl: 'https://en.wikipedia.org/wiki/Kalemegdan' }],
    ['detailsFetchedAt', { ...base, detailsFetchedAt: '2026-10-23T12:00:00Z' }],
    ['isBuilding', { ...base, isBuilding: !base.isBuilding }],
  ];

  it.each(variants)('changing %s leaves the Document unchanged', (_label, variant) => {
    expect(DetailedPlaceSchema.safeParse(variant).success).toBe(true);
    expect(build(variant)).toBe(build(base));
  });
});

describe('AC-16 Determinism and the global regex', () => {
  it('the same URL-bearing input twice gives identical text and fingerprint', () => {
    const place = placeK();
    const first = build(place);
    const second = build(place);
    expect(second).toBe(first);
    expect(documentFingerprint(second)).toBe(documentFingerprint(first));
  });

  it('several URL-bearing Places built one after another each give their stated text', () => {
    const places: [DetailedPlace, string][] = [
      [
        detailedPlace({ placeId: 911, name: 'A', description: 'one http://a.example two' }),
        'A\nDescription: one two',
      ],
      [
        detailedPlace({ placeId: 912, name: 'B', description: 'www.b.example three' }),
        'B\nDescription: three',
      ],
      [
        detailedPlace({
          placeId: 913,
          name: 'C',
          description: 'x https://c.example/1 y http://c.example/2 z',
        }),
        'C\nDescription: x y z',
      ],
      [detailedPlace({ placeId: 914, name: 'D', description: 'http://d.example' }), 'D'],
    ];
    for (let round = 0; round < 3; round += 1) {
      for (const [place, expected] of places) {
        const document = build(place);
        expect(document).toBe(expected);
        expect(documentFingerprint(document)).toBe(documentFingerprint(expected));
      }
    }
    for (const [place, expected] of [...places].reverse()) {
      expect(build(place)).toBe(expected);
    }
  });
});

describe('No mutation', () => {
  it('the input Place is unchanged after the call', () => {
    const place = detailedPlace({
      name: '  Spaced  Name ',
      description: ' See http://example.org/a for\tmore. ',
      address: { street: ' Street ', city: 'Belgrade', place: 'Belgrade' },
      tags: storedTags(['b', 'present'], ['a', 'gone'], [' c ', 'present']),
      comments: [
        {
          num: 2,
          message: ' second ',
          isDeleted: true,
          replies: [
            { num: 4, message: 'r2' },
            { num: 3, message: 'r1', presence: 'gone' },
          ],
        },
        { num: 1, message: 'first' },
      ],
    });
    const clone = structuredClone(place);
    build(place);
    expect(place).toStrictEqual(clone);
  });

  it('storedComments-built Comments are unchanged too (read-back order kept)', () => {
    const comments = storedComments(901, [
      { num: 3, message: 'c' },
      { num: 1, message: 'a' },
    ]);
    const place: DetailedPlace = { ...detailedPlace({ name: 'N' }), comments };
    const clone = structuredClone(place);
    expect(build(place)).toBe('N\nComment: c\nComment: a');
    expect(place).toStrictEqual(clone);
  });
});
