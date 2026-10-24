/**
 * AL2 unit tests: `src/db/vector.ts` (AL4 embeddings 1.3 `src/db/*.ts (additions)`, 1.4.8 the
 * `vector.ts` paragraph; 0.1 "Vector encoding"). AL3 routing 20261023-embeddings-02-store,
 * section 2.1 A.
 *
 * Pure: no database. Vectors are generated in code (`fakeEmbedding`); no vector literal appears
 * in this file (contract AC-59).
 */
import { parseVectorText, toVectorLiteral } from '../../src/db/vector';
import { EMBEDDING_DIMENSIONS } from '../../contracts/embeddings.schema';
import { fakeEmbedding } from '../../contracts/embeddings.support';

describe('toVectorLiteral / parseVectorText', () => {
  it("round-trips fakeEmbedding('x') exactly", () => {
    const embedding = fakeEmbedding('x');
    expect(parseVectorText(toVectorLiteral(embedding))).toStrictEqual(embedding);
  });

  it('round-trips two different Embeddings to two different values', () => {
    const a = fakeEmbedding('a');
    const b = fakeEmbedding('b');
    expect(parseVectorText(toVectorLiteral(a))).toStrictEqual(a);
    expect(parseVectorText(toVectorLiteral(b))).toStrictEqual(b);
    expect(toVectorLiteral(a)).not.toBe(toVectorLiteral(b));
  });

  it('toVectorLiteral gives bracketed text with 1024 comma-separated values', () => {
    const text = toVectorLiteral(fakeEmbedding('x'));
    expect(text.startsWith('[')).toBe(true);
    expect(text.endsWith(']')).toBe(true);
    const values = text.slice(1, -1).split(',');
    expect(values).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const value of values) expect(Number.isFinite(Number(value))).toBe(true);
  });

  it('parseVectorText of a short literal returns those numbers', () => {
    const numbers = [1.5, -2, 0.25];
    const text = `[${numbers.join(',')}]`;
    expect(parseVectorText(text)).toStrictEqual(numbers);
  });

  it('parseVectorText returns plain numbers (an array of type number)', () => {
    const parsed = parseVectorText(toVectorLiteral(fakeEmbedding('y')));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.every((v) => typeof v === 'number')).toBe(true);
  });
});
