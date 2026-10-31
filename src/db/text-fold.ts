/**
 * Tag title folding (AL4 hybrid-search 1.3, 1.4.5): the only place that knows how SQL folds a
 * catalogue Tag title the way the contract's `normalizeTagTitle` (`trim().toLowerCase()`) does.
 * Pure constants, no I/O.
 */

/**
 * Every code point ECMAScript `String.prototype.trim` removes (WhiteSpace and LineTerminator):
 * U+0009 .. U+000D, U+0020, U+00A0, U+1680, U+2000 .. U+200A, U+2028, U+2029, U+202F, U+205F,
 * U+3000, U+FEFF. Bound as the `btrim` character set, never written into SQL text.
 */
export const JS_TRIM_CHARACTERS: string = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
]
  .map((cp) => String.fromCodePoint(cp))
  .join('');

/**
 * Folds the catalogue title `t.title`: trim with the JS set (one binding: `JS_TRIM_CHARACTERS`),
 * then ICU root lowercasing (full Unicode case mapping, as `toLowerCase()`).
 */
export const FOLDED_TAG_TITLE_SQL = 'lower(btrim(t.title, ?::text) COLLATE "und-x-icu")';
