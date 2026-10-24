/**
 * Embedding Store reads (AL4 embeddings 1.4.8, 1.5, 2.1; R2, AC-53, AC-54, AC-57, AC-58): the R2
 * candidates read, one record read, counts and the storage inspection. Every value travels as
 * a binding (ids, limit, table and column names). Every row is parsed with its row schema and
 * every assembled value is gated with its contract schema (`.parse`; the public layer maps a
 * `ZodError` to `store_unavailable`). No function here opens a transaction: the caller does.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  EMBEDDING_COLUMN,
  EMBEDDING_TABLE,
  EmbeddingCandidatesValueSchema,
  EmbeddingStorageInfoSchema,
  EmbeddingStoreCountsSchema,
  ReadEmbeddingRecordValueSchema,
} from '../../contracts/embeddings.schema';
import type {
  EmbeddingCandidatesInput,
  EmbeddingCandidatesValue,
  EmbeddingRecord,
  EmbeddingStorageInfo,
  EmbeddingStoreCounts,
  ReadEmbeddingRecordValue,
} from '../../contracts/embeddings.schema';
import { STORE_TABLES } from '../../contracts/storage.schema';
import { toDetailedPlace } from './mappers';
import {
  FETCHED_AT_TEXT_SQL,
  PLACE_COLUMNS,
  selectCommentRowsOfPlaces,
  selectTagLinksOfPlaces,
} from './read';
import {
  EmbeddingCountsRowSchema,
  EmbeddingRowSchema,
  KeyColumnRowSchema,
  PlaceRowSchema,
  TypmodRowSchema,
  VectorIndexRowSchema,
} from './rows';
import type { CommentRow, EmbeddingRow, TagLinkRow } from './types';
import { parseVectorText } from './vector';

const PlaceRowsSchema = z.array(PlaceRowSchema);
const EmbeddingRowsSchema = z.array(EmbeddingRowSchema);
const CountsRawSchema = z.object({ rows: z.array(EmbeddingCountsRowSchema) });
const TypmodRawSchema = z.object({ rows: z.array(TypmodRowSchema) });
const KeyColumnRawSchema = z.object({ rows: z.array(KeyColumnRowSchema) });
const VectorIndexRawSchema = z.object({ rows: z.array(VectorIndexRowSchema) });

const EMBEDDING_TEXT_SQL = 'embedding::text as embedding_text';
const EMBEDDED_AT_TEXT_SQL =
  'to_char(embedded_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as embedded_at_text';

const COUNTS_SQL =
  'select (select count(*) from places where details_fetched_at is null) as summary_only_places,' +
  ' (select count(*) from places where details_fetched_at is not null) as detailed_places,' +
  ' (select count(*) from place_embeddings) as embedding_records';

/** pgvector stores the dimension count directly as the type modifier. */
const TYPMOD_SQL =
  'select a.atttypmod from pg_attribute a' +
  ' where a.attrelid = to_regclass(?::text) and a.attname = ? and not a.attisdropped';

const KEY_COLUMNS_SQL =
  'select a.attname::text as attname from pg_index i' +
  ' cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, ord)' +
  ' join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum' +
  ' where i.indrelid = to_regclass(?::text) and i.indisprimary order by k.ord';

const VECTOR_INDEX_SQL =
  'select ic.relname::text as name, am.amname::text as method,' +
  ' opc.opcname::text as operator_class, (i.indpred is not null) as partial' +
  ' from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam' +
  ' cross join lateral unnest(i.indkey::int2[], i.indclass::oid[]) k(attnum, opclass)' +
  ' join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum' +
  ' join pg_opclass opc on opc.oid = k.opclass' +
  ' where i.indrelid = to_regclass(?::text) and a.attname = ? order by ic.relname';

// ---------------------------------------------------------------------------
// Row loaders (private)
// ---------------------------------------------------------------------------

async function selectEmbeddingRows(
  db: Knex | Knex.Transaction,
  placeIds: readonly number[],
): Promise<EmbeddingRow[]> {
  const result: unknown = await db
    .select([
      'place_id',
      db.raw(EMBEDDING_TEXT_SQL),
      'embedding_model',
      'document_fingerprint',
      db.raw(EMBEDDED_AT_TEXT_SQL),
    ])
    .from(EMBEDDING_TABLE)
    .whereIn('place_id', [...placeIds])
    .orderBy('place_id');
  return EmbeddingRowsSchema.parse(result);
}

/** The Embedding Record of a row; the caller's contract gate checks every value. */
function toRecordCandidate(row: EmbeddingRow): EmbeddingRecord {
  return {
    placeId: row.place_id,
    embedding: parseVectorText(row.embedding_text),
    model: row.embedding_model,
    documentFingerprint: row.document_fingerprint,
    embeddedAt: row.embedded_at_text,
  };
}

function groupByPlace<R extends { place_id: number }>(rows: readonly R[]): Map<number, R[]> {
  const groups = new Map<number, R[]>();
  for (const row of rows) {
    const group = groups.get(row.place_id);
    if (group === undefined) groups.set(row.place_id, [row]);
    else group.push(row);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/** R2: Detailed Places after `afterPlaceId`, ascending, at most `limit`, with their records. */
export async function selectEmbeddingCandidates(
  trx: Knex.Transaction,
  input: EmbeddingCandidatesInput,
): Promise<EmbeddingCandidatesValue> {
  const query = trx
    .select([...PLACE_COLUMNS, trx.raw(FETCHED_AT_TEXT_SQL)])
    .from(STORE_TABLES.places)
    .whereNotNull('details_fetched_at');
  if (input.afterPlaceId !== undefined) query.where('place_id', '>', input.afterPlaceId);
  const result: unknown = await query.orderBy('place_id').limit(input.limit);
  const rows = PlaceRowsSchema.parse(result);
  if (rows.length === 0) return EmbeddingCandidatesValueSchema.parse({ places: [] });

  const ids = rows.map((row) => row.place_id);
  const links = groupByPlace<TagLinkRow>(await selectTagLinksOfPlaces(trx, ids));
  const comments = groupByPlace<CommentRow>(await selectCommentRowsOfPlaces(trx, ids));
  const records = new Map<number, EmbeddingRow>();
  for (const row of await selectEmbeddingRows(trx, ids)) records.set(row.place_id, row);

  const places = rows.map((row) => {
    const place = toDetailedPlace(
      row,
      links.get(row.place_id) ?? [],
      comments.get(row.place_id) ?? [],
    );
    const record = records.get(row.place_id);
    return record === undefined ? { place } : { place, embeddingRecord: toRecordCandidate(record) };
  });
  return EmbeddingCandidatesValueSchema.parse({ places });
}

export async function selectEmbeddingRecord(
  db: Knex,
  placeId: number,
): Promise<ReadEmbeddingRecordValue> {
  const [row] = await selectEmbeddingRows(db, [placeId]);
  if (row === undefined) return ReadEmbeddingRecordValueSchema.parse({ found: false, placeId });
  return ReadEmbeddingRecordValueSchema.parse({ found: true, record: toRecordCandidate(row) });
}

export async function countEmbeddingStoreRows(db: Knex): Promise<EmbeddingStoreCounts> {
  const result: unknown = await db.raw(COUNTS_SQL);
  const [row] = CountsRawSchema.parse(result).rows;
  if (row === undefined) throw new Error('count query returned no row');
  return EmbeddingStoreCountsSchema.parse({
    summaryOnlyPlaces: row.summary_only_places,
    detailedPlaces: row.detailed_places,
    embeddingRecords: row.embedding_records,
  });
}

/** Catalogue reads of the Embedding storage; a missing table or column throws. */
export async function readEmbeddingStorageInfo(db: Knex): Promise<EmbeddingStorageInfo> {
  const typmodResult: unknown = await db.raw(TYPMOD_SQL, [EMBEDDING_TABLE, EMBEDDING_COLUMN]);
  const [typmod] = TypmodRawSchema.parse(typmodResult).rows;
  if (typmod === undefined) throw new Error('embedding storage is missing');

  const keyResult: unknown = await db.raw(KEY_COLUMNS_SQL, [EMBEDDING_TABLE]);
  const keyColumns = KeyColumnRawSchema.parse(keyResult).rows.map((row) => row.attname);
  const onePerPlace = keyColumns.length === 1 && keyColumns[0] === 'place_id';

  const indexResult: unknown = await db.raw(VECTOR_INDEX_SQL, [EMBEDDING_TABLE, EMBEDDING_COLUMN]);
  const vectorIndexes = VectorIndexRawSchema.parse(indexResult).rows.map((row) => ({
    name: row.name,
    method: row.method,
    operatorClass: row.operator_class,
    partial: row.partial,
  }));

  return EmbeddingStorageInfoSchema.parse({
    table: EMBEDDING_TABLE,
    column: EMBEDDING_COLUMN,
    dimensions: typmod.atttypmod,
    onePerPlace,
    vectorIndexes,
  });
}
