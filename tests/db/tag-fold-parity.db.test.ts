/**
 * AL2 unit tests: Tag title folding parity (AL4 hybrid-search 1.4.5, U2 "tag-fold-parity").
 * `FOLDED_TAG_TITLE_SQL` with the `JS_TRIM_CHARACTERS` binding must give byte-identical text to
 * the contract's `normalizeTagTitle` for every BMP code point and for a contextual corpus. Runs
 * on the Test Database through the test's own handle; no table is read or written.
 *
 * U+0000 is left out of the sweep: PostgreSQL `text` cannot hold NUL, so it can never be a
 * catalogue title.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { createDb, destroyQuietly } from '../../src/db/connection';
import { FOLDED_TAG_TITLE_SQL, JS_TRIM_CHARACTERS } from '../../src/db/text-fold';
import { normalizeTagTitle } from '../../contracts/hybrid-search.schema';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const CHUNK = 5_000;
const FoldedSchema = z.object({ rows: z.array(z.object({ folded: z.array(z.string()) })) });
const CountSchema = z.object({ rows: z.array(z.object({ n: z.number() })) });

let db: Knex;

beforeAll(() => {
  db = createDb(requireTestDatabaseUrl(), 1);
});

afterAll(async () => {
  await destroyQuietly(db);
});

/** SQL fold of every title, in input order. */
async function foldInSql(titles: readonly string[]): Promise<string[]> {
  const raw: unknown = await db.raw(
    `select coalesce(array_agg(${FOLDED_TAG_TITLE_SQL} order by t.ord), '{}'::text[]) as folded
       from unnest(?::text[]) with ordinality as t(title, ord)`,
    [JS_TRIM_CHARACTERS, [...titles]],
  );
  return FoldedSchema.parse(raw).rows[0]?.folded ?? [];
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

it('the und-x-icu collation exists', async () => {
  const raw: unknown = await db.raw(
    `select count(*)::int as n from pg_collation where collname = 'und-x-icu'`,
  );
  expect(CountSchema.parse(raw).rows[0]?.n).toBe(1);
});

it('every non-surrogate BMP code point, wrapped in JS whitespace, folds as normalizeTagTitle', async () => {
  const codePoints: number[] = [];
  for (let cp = 1; cp <= 0xffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) codePoints.push(cp);
  for (let i = 0; i < codePoints.length; i += CHUNK) {
    const chunk = codePoints.slice(i, i + CHUNK);
    const titles = chunk.map((cp) => `${String.fromCodePoint(0x3000, cp)} \t`);
    const folded = await foldInSql(titles);
    expect(folded).toHaveLength(titles.length);
    const at = titles.findIndex((title, j) => folded[j] !== normalizeTagTitle(title));
    const firstMismatch =
      at === -1
        ? undefined
        : `${hex(chunk[at] ?? -1)}: sql ${JSON.stringify(folded[at])}, js ${JSON.stringify(normalizeTagTitle(titles[at] ?? ''))}`;
    expect(firstMismatch).toBeUndefined();
  }
}, 120_000);

it('a contextual corpus folds as normalizeTagTitle', async () => {
  const corpus = [
    'МУЗЕЈ',
    '  Трг Републике ',
    'ĐINĐIĆ',
    'ΟΔΟΣ',
    'ΣΑΣ ΟΔΟΣ',
    'İSTANBUL',
    'STRAẞE',
    'ᲐᲑᲒ',
    `${String.fromCodePoint(0xfeff)}Museum `,
    'Ꭰ',
    'Музеј Of ART',
  ];
  expect(await foldInSql(corpus)).toStrictEqual(corpus.map(normalizeTagTitle));
});
