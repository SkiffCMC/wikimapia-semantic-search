/**
 * Keep one Batch's Embedding Records (AL4 embeddings 1.4.8, 1.5; AC-39, AC-45, AC-56): one READ
 * COMMITTED transaction, first the Detailed-Place check (not a write), then one upsert statement
 * per 100 records in input order through the Writer. Any throw (a statement, the hook, or
 * `InvalidDataError`) rolls the whole Batch back; errors are neither caught nor mapped here.
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import { EMBEDDING_TABLE } from '../../contracts/embeddings.schema';
import type {
  EmbeddingRecord,
  SaveEmbeddingRecordsInput,
  SaveEmbeddingRecordsValue,
} from '../../contracts/embeddings.schema';
import { STORE_TABLES } from '../../contracts/storage.schema';
import type { StoreIssue, WriteHook } from '../../contracts/storage.schema';
import { IdRowSchema } from './rows';
import type { EmbeddingRowColumns } from './types';
import { toVectorLiteral } from './vector';
import { createWriter } from './writer';

/** Records per upsert statement. */
const CHUNK_SIZE = 100;
const NOT_DETAILED_MESSAGE = 'is not a stored Detailed Place';
const MERGED_COLUMNS = ['embedding', 'embedding_model', 'document_fingerprint', 'embedded_at'];

const FoundRowsSchema = z.array(IdRowSchema);

/** Thrown inside the save transaction so it rolls back; the store maps it to `invalid_data`. */
export class InvalidDataError extends Error {
  readonly issues: readonly StoreIssue[];

  constructor(issues: readonly StoreIssue[]) {
    super('Embedding Records are invalid data');
    this.name = 'InvalidDataError';
    this.issues = issues;
  }
}

function upsertRow(trx: Knex.Transaction, record: EmbeddingRecord): EmbeddingRowColumns {
  return {
    place_id: record.placeId,
    embedding: trx.raw('?::vector', [toVectorLiteral(record.embedding)]),
    embedding_model: record.model,
    document_fingerprint: record.documentFingerprint,
    embedded_at: record.embeddedAt,
  };
}

async function requireDetailedPlaces(
  trx: Knex.Transaction,
  records: readonly EmbeddingRecord[],
): Promise<void> {
  const result: unknown = await trx
    .select({ id: 'place_id' })
    .from(STORE_TABLES.places)
    .whereIn(
      'place_id',
      records.map((r) => r.placeId),
    )
    .whereNotNull('details_fetched_at');
  const found = new Set(FoundRowsSchema.parse(result).map((row) => row.id));
  const issues: StoreIssue[] = [];
  records.forEach((record, i) => {
    if (!found.has(record.placeId)) {
      issues.push({
        path: ['records', i, 'placeId'],
        message: NOT_DETAILED_MESSAGE,
        placeId: record.placeId,
      });
    }
  });
  if (issues.length > 0) throw new InvalidDataError(issues);
}

export function saveEmbeddingRecordsStep(
  db: Knex,
  input: SaveEmbeddingRecordsInput,
  hook: WriteHook | undefined,
): Promise<SaveEmbeddingRecordsValue> {
  const { records } = input;
  return db.transaction(
    async (trx) => {
      await requireDetailedPlaces(trx, records);
      const writer = createWriter(hook);
      for (let start = 0; start < records.length; start += CHUNK_SIZE) {
        const chunk = records.slice(start, start + CHUNK_SIZE);
        await writer.run(
          trx(EMBEDDING_TABLE)
            .insert(chunk.map((record) => upsertRow(trx, record)))
            .onConflict('place_id')
            .merge(MERGED_COLUMNS),
        );
      }
      return { saved: records.length };
    },
    { isolationLevel: 'read committed' },
  );
}
