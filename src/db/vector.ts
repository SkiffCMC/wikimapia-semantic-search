/**
 * pgvector text format (AL4 embeddings 0.1 "Vector encoding", 1.4.8 `vector.ts`): the only
 * module that knows how a `vector` value is written as text and read back. Pure, no SQL.
 */
import { fromSql, toSql } from 'pgvector';
import { z } from 'zod';
import type { Embedding } from '../../contracts/embeddings.schema';

const VectorNumbersSchema = z.array(z.number());

/** `[v1,...,v1024]`, written as a `?::vector` binding. The input is already a gated Embedding. */
export function toVectorLiteral(embedding: Embedding): string {
  const text = toSql(embedding);
  if (text === null) throw new Error('vector literal could not be built');
  return text;
}

/** Numbers of an `embedding::text` value; the caller gates the result with `EmbeddingSchema`. */
export function parseVectorText(text: string): number[] {
  return VectorNumbersSchema.parse(fromSql(text));
}
