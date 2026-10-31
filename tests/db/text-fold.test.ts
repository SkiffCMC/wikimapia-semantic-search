/**
 * AL2 unit tests: `src/db/text-fold.ts` (AL4 hybrid-search 1.3, 1.4.5, U2 "text-fold.test.ts").
 * The trim character set must be exactly what `String.prototype.trim` removes, so that the SQL
 * fold `FOLDED_TAG_TITLE_SQL` can mirror the contract's `normalizeTagTitle`.
 */
import { FOLDED_TAG_TITLE_SQL, JS_TRIM_CHARACTERS } from '../../src/db/text-fold';

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

it('JS_TRIM_CHARACTERS holds exactly the code points String.prototype.trim removes', () => {
  const set = new Set(JS_TRIM_CHARACTERS);
  const mismatches: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if ((ch.trim() === '') !== set.has(ch)) mismatches.push(hex(cp));
  }
  expect(mismatches).toStrictEqual([]);
  expect([...set].every((ch) => ch.trim() === '')).toBe(true);
});

it('JS_TRIM_CHARACTERS has no duplicates', () => {
  const chars = Array.from(JS_TRIM_CHARACTERS);
  expect(new Set(chars).size).toBe(chars.length);
});

it('FOLDED_TAG_TITLE_SQL is the AL4 fold: one binding, ICU root collation, the catalogue title', () => {
  expect(FOLDED_TAG_TITLE_SQL).toBe('lower(btrim(t.title, ?::text) COLLATE "und-x-icu")');
  expect(FOLDED_TAG_TITLE_SQL.split('?')).toHaveLength(2);
});
