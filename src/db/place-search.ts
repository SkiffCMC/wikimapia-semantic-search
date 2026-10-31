/**
 * The search statement (AL4 hybrid-search 1.4.3, 1.4.4, 1.4.8): one parameterized `SELECT` built
 * only from the constant fragments below. Every value is a `?` binding with an explicit cast,
 * pushed together with the fragment that holds its placeholder, so text and bindings cannot
 * drift. No value is ever written into the SQL text (`.agrules` 3, AC-40).
 */
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  SEARCHABLE_EMBEDDING_MODEL,
  SearchResultSchema,
  type LatLon,
  type SearchResult,
} from '../../contracts/hybrid-search.schema';
import { SearchRowSchema } from './rows';
import { FOLDED_TAG_TITLE_SQL, JS_TRIM_CHARACTERS } from './text-fold';
import type { PlaceSearchQuery, SqlBinding, SqlStatement } from './types';
import { toVectorLiteral } from './vector';

/** Margin of the coarse `ST_DWithin` test; the exact `ST_Distance <= radius` test decides. */
const RADIUS_MARGIN_METRES = 1;

const SEARCH_RESULT_SCHEMA = z.object({ rows: z.array(SearchRowSchema) });
const SEARCH_RESULTS_SCHEMA = z.array(SearchResultSchema);

const VECTOR = '?::vector';
/** `$C`: bound to `lon, lat` (x first). */
const CENTRE = 'ST_SetSRID(ST_MakePoint(?::float8, ?::float8), 4326)::geography';
const SEARCHABLE =
  'e.embedding_model = ?::text and p.details_fetched_at is not null and p.is_deleted = false';
const RADIUS_COARSE = `ST_DWithin(p.centre_point::geography, ${CENTRE}, ?::float8)`;
const DISTANCE = `ST_Distance(p.centre_point::geography, ${CENTRE})`;
const ENVELOPE = 'ST_MakeEnvelope(?::float8, ?::float8, ?::float8, ?::float8, 4326)';
const AREA =
  `((p.outline_shape is not null and ST_Intersects(p.outline_shape, ${ENVELOPE}))` +
  ` or (p.outline_shape is null and ST_Intersects(p.centre_point, ${ENVELOPE})))`;
const TAGS =
  'exists (select 1 from place_tags pt join tags t on t.tag_id = pt.tag_id' +
  " where pt.place_id = p.place_id and pt.presence = 'present' and " +
  FOLDED_TAG_TITLE_SQL +
  ' = any(?::text[]))';
const RESULT_TAGS =
  'coalesce((select array_agg(t.title order by pt.position, pt.tag_id)' +
  ' from place_tags pt join tags t on t.tag_id = pt.tag_id' +
  " where pt.place_id = p.place_id and pt.presence = 'present'), '{}'::text[])";

/** Appends constant SQL text and the bindings of its placeholders, in order. */
class StatementBuilder {
  private readonly parts: string[] = [];
  private readonly values: SqlBinding[] = [];

  add(sql: string, ...bindings: SqlBinding[]): this {
    this.parts.push(sql);
    this.values.push(...bindings);
    return this;
  }

  build(): SqlStatement {
    return { sql: this.parts.join(''), bindings: [...this.values] };
  }
}

function centreBindings(centre: LatLon): [number, number] {
  return [centre.lon, centre.lat];
}

/** `[F]`: SEARCHABLE and every present filter fragment, joined with `and`. */
function addFilters(builder: StatementBuilder, query: PlaceSearchQuery): void {
  builder.add(SEARCHABLE, SEARCHABLE_EMBEDDING_MODEL);
  if (query.radius !== undefined) {
    builder.add(
      ` and ${RADIUS_COARSE}`,
      ...centreBindings(query.radius.centre),
      query.radius.radiusMetres + RADIUS_MARGIN_METRES,
    );
  }
  if (query.area !== undefined) {
    const { west, south, east, north } = query.area;
    builder.add(` and ${AREA}`, west, south, east, north, west, south, east, north);
  }
  if (query.tagTitles !== undefined) {
    builder.add(` and ${TAGS}`, JS_TRIM_CHARACTERS, [...query.tagTitles]);
  }
}

/** Exact mode (AL4 1.4.4): brute-force ranking over a materialized CTE of every Matching Place. */
function exactStatement(query: PlaceSearchQuery): SqlStatement {
  const builder = new StatementBuilder();
  builder.add(
    `with candidates as materialized (\n  select e.place_id, 1 - (e.embedding <=> ${VECTOR}) as similarity`,
    toVectorLiteral(query.queryEmbedding),
  );
  if (query.radius !== undefined) {
    builder.add(`, ${DISTANCE} as distance_metres`, ...centreBindings(query.radius.centre));
  } else {
    builder.add(', null::float8 as distance_metres');
  }
  builder.add('\n  from place_embeddings e join places p on p.place_id = e.place_id\n  where ');
  addFilters(builder, query);
  builder.add(
    '\n),\ntop_n as (\n  select place_id, similarity, distance_metres from candidates' +
      "\n  where similarity <> 'NaN'::float8",
  );
  if (query.radius !== undefined) {
    builder.add(' and distance_metres <= ?::float8', query.radius.radiusMetres);
  }
  builder.add('\n  order by similarity desc, place_id asc\n  limit ?::int\n)', query.limit);
  builder.add(
    '\nselect n.place_id, p.name, p.wikimapia_url, p.location_lat, p.location_lon,' +
      `\n       n.similarity, n.distance_metres, ${RESULT_TAGS} as tags` +
      '\nfrom top_n n join places p on p.place_id = n.place_id' +
      '\norder by n.similarity desc, n.place_id asc',
  );
  return builder.build();
}

/**
 * Approximate mode (AL4 1.4.4): every filter in the inner `where`, then the bare
 * `e.embedding <=> ?::vector` as the only inner sort key (a second binding of the same literal),
 * so the HNSW index can serve it. Ranking Order is applied by the outer query.
 */
function approximateStatement(query: PlaceSearchQuery): SqlStatement {
  const literal = toVectorLiteral(query.queryEmbedding);
  const builder = new StatementBuilder();
  builder.add(
    'select a.place_id, a.name, a.wikimapia_url, a.location_lat, a.location_lon,' +
      '\n       a.similarity, a.distance_metres, a.tags' +
      '\nfrom (' +
      '\n  select p.place_id, p.name, p.wikimapia_url, p.location_lat, p.location_lon,' +
      `\n         1 - (e.embedding <=> ${VECTOR}) as similarity`,
    literal,
  );
  if (query.radius !== undefined) {
    builder.add(`, ${DISTANCE} as distance_metres`, ...centreBindings(query.radius.centre));
  } else {
    builder.add(', null::float8 as distance_metres');
  }
  builder.add(
    `, ${RESULT_TAGS} as tags` +
      '\n  from place_embeddings e join places p on p.place_id = e.place_id\n  where ',
  );
  addFilters(builder, query);
  if (query.radius !== undefined) {
    builder.add(
      ` and ${DISTANCE} <= ?::float8`,
      ...centreBindings(query.radius.centre),
      query.radius.radiusMetres,
    );
  }
  builder.add(`\n  order by e.embedding <=> ${VECTOR}`, literal);
  builder.add('\n  limit ?::int', query.limit);
  builder.add(
    "\n) a\nwhere a.similarity <> 'NaN'::float8\norder by a.similarity desc, a.place_id asc",
  );
  return builder.build();
}

export function buildPlaceSearchStatement(query: PlaceSearchQuery): SqlStatement {
  return query.mode === 'approximate' ? approximateStatement(query) : exactStatement(query);
}

export async function selectMatchingPlaces(
  db: Knex,
  query: PlaceSearchQuery,
): Promise<SearchResult[]> {
  const { sql, bindings } = buildPlaceSearchStatement(query);
  const raw: unknown = await db.raw(sql, bindings);
  const rows = SEARCH_RESULT_SCHEMA.parse(raw).rows;
  const results = rows.map((row) => ({
    placeId: row.place_id,
    name: row.name,
    wikimapiaUrl: row.wikimapia_url,
    tags: row.tags,
    centre: { lat: row.location_lat, lon: row.location_lon },
    similarity: row.similarity,
    // Non-null whenever a Radius is set; a null here fails the result gate below.
    ...(query.radius !== undefined ? { distanceMetres: row.distance_metres } : {}),
  }));
  return SEARCH_RESULTS_SCHEMA.parse(results);
}
