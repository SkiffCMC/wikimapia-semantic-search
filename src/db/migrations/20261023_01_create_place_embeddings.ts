/**
 * Step 7 (AL4 embeddings 2.1, 2.2): adds the Embedding Records (`place_embeddings`), one per
 * Place, with a `vector(1024)` column and its HNSW cosine index. Every constraint and index
 * carries an explicit name; `knex.raw` is used only for constant DDL text. Table and column
 * names are frozen literals, never imported from the live contracts. Touches no earlier table
 * and creates no extension (step 1 enables `vector`).
 */
import type { Knex } from 'knex';

const EMBEDDINGS_TABLE = 'place_embeddings';
const MOMENT = { useTz: true, precision: 0 } as const;

const FINGERPRINT_RULE = `document_fingerprint ~ '^[0-9a-f]{64}$'`;
const SIMILARITY_INDEX = `CREATE INDEX place_embeddings_embedding_hnsw_idx ON place_embeddings USING hnsw (embedding vector_cosine_ops)`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(EMBEDDINGS_TABLE, (table) => {
    table.bigInteger('place_id').notNullable();
    table.specificType('embedding', 'vector(1024)').notNullable();
    table.text('embedding_model').notNullable();
    table.text('document_fingerprint').notNullable();
    table.timestamp('embedded_at', MOMENT).notNullable();

    table.primary(['place_id'], { constraintName: 'place_embeddings_pkey' });
    table
      .foreign('place_id', 'place_embeddings_place_id_fkey')
      .references('place_id')
      .inTable('places')
      .onDelete('CASCADE');
    table.check(`embedding_model <> ''`, {}, 'place_embeddings_embedding_model_not_empty');
    table.check(FINGERPRINT_RULE, {}, 'place_embeddings_document_fingerprint_valid');
  });
  await knex.raw(SIMILARITY_INDEX);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(EMBEDDINGS_TABLE);
}
