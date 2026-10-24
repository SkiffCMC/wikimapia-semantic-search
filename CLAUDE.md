# Wikimapia Semantic Search — Project Context

Role: act as Technical Co-Pilot and Lead Architect for this project.
Do not execute or implement code unless explicitly asked. Use this document as system context, product domain knowledge, and architectural boundaries for all discussions.

---

## Project Overview & Goal

The end goal is a public web-based spatial search engine with a minimal search bar (Google/Perplexity style).
Users input natural language queries (e.g. "quiet spot near the river with good water access and positive comments about sunsets"), and the system returns a list of matching Wikimapia places with direct links, category info, and snippet highlights from crowdsourced user comments.

---

## Core Architecture & Stack

Four decoupled components:

1. **Frontend (Web UI)**
   - Stack: Next.js, Tailwind CSS, Leaflet.js
   - Deployment: Vercel
   - Responsibility: search bar, results list with direct links (`https://wikimapia.org/{place_id}/ru/{title_slug}`), comment snippets, interactive map markers.

2. **Backend & Search Engine (API & RAG)**
   - Stack: Node.js (TypeScript) or Python (FastAPI)
   - Deployment: Hetzner / DigitalOcean VPS (Docker)
   - Responsibility: intent extraction via LLM (Claude Haiku 5.5), hybrid PostGIS + pgvector query execution, response reranking.

3. **Storage & Index Layer**
   - Stack: PostgreSQL 16 with `postgis` and `pgvector` extensions
   - Responsibility: spatial geometries (polygons/points), places metadata, user comments, and 1024-dim vector embeddings (Voyage AI `voyage-4`).

4. **Data Pipeline & MCP Protocol**
   - Pipeline: offline ETL crawler that ingests places and comments from the Wikimapia API (not dumps — see Decisions), and computes vector embeddings into Postgres.
   - MCP Adaptor: Model Context Protocol server wrapping the backend search endpoint for native LLM clients (Claude Desktop, Cursor).

---

## Implementation Roadmap (5 Stages)

- **Stage 1: Storage & Ingestion Layer**
  - Set up Postgres + PostGIS + pgvector schema (`places`, `comments`).
  - Crawl a region (e.g. Belgrade) through the Wikimapia API and import places and comments.
  - Generate batch embeddings for comments/descriptions into vector columns.
  - Substeps, each its own `/add` feature, in order:
    1. **Wikimapia API client:** typed client for `box` (enumerate places in a bbox) and `place.getbyid` (details and comments), Zod schemas for responses, handling of the `debug` rate-limit response. Proves we can make requests and parse real responses. No DB. **Done** (feature `wikimapia-client`, `src/wikimapia/`, contracts in `contracts/wikimapia-client.schema.ts`).
    2. **Storage:** Postgres + PostGIS + pgvector in docker-compose, Knex migrations, Objection models for places and comments. Schema informed by real responses from substep 1. **Done** (feature `storage`, `src/db/`, contracts in `contracts/storage.schema.ts`, entry point `createPlaceStore`).
    3. **Hydration jobs:** crawl jobs that walk a bbox through the client and upsert into the DB, idempotent and resumable, runnable on a schedule. **Done** (feature `hydration`, `src/crawl/`, crawl progress tables in `src/db/`, contracts in `contracts/hydration.schema.ts`, entry points `runCrawl` and `runCrawlCommand`). Fixes from the first real crawl (feature `crawl-run1-fixes`, contracts in `contracts/crawl-run1-fixes.schema.ts`): missing `tags`, the key quota stop, Failure Records and Parking. Run with `pnpm crawl --region <name> [--dry-run] [--relist] [--retry-parked] [--budget <n>] [--min-interval <seconds>] [--refresh-age <days>]`; regions `belgrade` (big Belgrade, 7,920 tiles) and `belgrade-small` (4 tiles, for test runs). Scheduling is done by OS cron / Task Scheduler; there is no in-process scheduler.
    4. **Embeddings:** batch-embed places with Voyage AI `voyage-4` into a `vector(1024)` column. Idempotent (skips unchanged text) and resumable. Kept separate from hydration so the crawled data can be inspected before paying for embeddings, and so embedding can be rerun on its own. **Done** (feature `embeddings`, `src/embed/`, Embedding Store in `src/db/embedding-*.ts`, contracts in `contracts/embeddings.schema.ts`, entry points `runEmbedding`, `runEmbedCommand`, `buildPlaceDocument` and `createEmbeddingStore`). One Place Document per Detailed Place (name, Present Tags, address, description without bare web addresses, Present Comments and Replies); Summary-Only Places are skipped. Run with `pnpm embed [--limit <n>]` (default 1,000 Places per run).

- **Stage 2: Hybrid Search & Intent Engine**
  - Implement LLM Intent Parser (transforms raw query into structured JSON parameters: semantic query, spatial bounds, categories).
  - Build hybrid SQL queries combining PostGIS radius/bbox filters (`ST_DWithin`) with vector cosine similarity (`<=>`).

- **Stage 3: API & RAG Middleware**
  - Build `POST /api/search` endpoint.
  - Generate formatted response cards and direct Wikimapia link structures.

- **Stage 4: Web Frontend**
  - Build minimalist Next.js UI with search input, result cards, and Leaflet preview map.

- **Stage 5: Deployment & MCP Integration**
  - Deploy Postgres and API backend via Docker Compose on VPS.
  - Deploy Next.js to Vercel.
  - Expose MCP Server interface over local/remote endpoint.

---

## Legal & Licensing Boundaries

- **Code:** MIT License.
- **Data:** Wikimapia content is governed by **CC BY-NC-SA 3.0** (Attribution-NonCommercial-ShareAlike). All derived datasets, embeddings, and API endpoints must remain strictly non-commercial and include proper Wikimapia attribution.

---

## Working Instructions

1. **Keep context:** always refer to this 4-tier architecture, tech stack, and 5-stage roadmap when proposing solutions, schemas, or code snippets.
2. **Step-by-step execution:** build sequentially, starting from Stage 1 (Database Migrations & ETL) through Stage 5.

---

## Decisions

- **Backend language:** TypeScript (Node ESM) for the API, ETL and MCP server. One language end to end; Zod schemas are shared between LLM structured output, the API, MCP tool inputs and ADD contracts.
- **Data source:** the Wikimapia API, crawled offline into Postgres; dumps are too hard to obtain. Search never calls Wikimapia live; it queries the local index.
- **Database access:** Knex (migrations, query builder) + Objection (models). PostGIS and pgvector columns go through `knex.raw` and the `pgvector` npm package.
- **Embeddings:** Voyage AI `voyage-4`, 1024-dim (decided 2026-10-23, replacing OpenAI `text-embedding-3-small`). $0.06 per million tokens with 200M free tokens per account; up to 1,000 texts per request. `input_type: "document"` for stored places, `"query"` for search queries. Key in `.env` as `VOYAGE_API_KEY`. Changing the model later means re-embedding everything.
- **LLM:** Claude Haiku 5.5 (`claude-haiku-5-5`, $0.10 / $0.50 per million input/output tokens) via the Anthropic SDK for intent parsing and reranking (decided 2026-10-23, replacing `gpt-4o-mini`). Key in `.env` as `ANTHROPIC_API_KEY`.
- **Crawl progress storage:** three tables (`crawl_runs`, `crawl_passes`, `crawl_finished_pages`) written with the Knex query builder and read through Zod row schemas, without Objection models. One live run per region (advisory lock plus a partial unique index); a run silent for more than 1 hour counts as abandoned and can be taken over, and a live run renews its activity at least every 15 minutes. `--relist` always starts a new listing pass; an incomplete older pass is kept but never resumed.
- **Key quota stop:** Wikimapia's `debug` code 1004 (recognised by the code alone) is Client Failure `key_quota_exhausted`, never retried or waited out. The crawl stops at once with Run Outcome `quota_exhausted` (a clean stop, exit 0), progress saved, and the summary prints `Wikimapia message: <text>`. Nothing is remembered between runs, so each run spends exactly 1 request to find out the quota is still used up.
- **Failure Records and Parking:** Schema Setup step 6 (`20261022_02_create_item_failures`) adds `crawl_item_failures` (run, place id or tile/`page_no`, failure kind, message, `failed_at`), `crawl_explicit_retries` and `crawl_place_releases`, and widens the `crawl_runs` status check with `quota_exhausted`. They are append-only history the crawl never deletes. Every Item Failure is recorded before it is counted; stops (quota, rate limit exhausted, budget, interrupt, configuration, store unavailable) are not Item Failures. A Place is **Parked** after 3 failures of the same counted kind (Wikimapia Error, Unexpected Response, Invalid Data, Invalid Request; Connection Failure is recorded but never counts), across runs and regions, since its Count Reset (the later of its last successful details save and its last release). Listing pages are recorded but never parked. Parked Places are left out of every Places Due list, including `listPlacesDueForDetails`. `--retry-parked` releases every Parked Place of the region at run start (with `--dry-run` it only prints how many are parked). A Wikimapia Error's item message carries Wikimapia's redacted text: `<item>: Wikimapia reported an error: <text>`. Run Records written before step 6 read the three parking counts as 0.
- **Embedding storage:** Schema Setup step 7 (`20261023_01_create_place_embeddings`) adds `place_embeddings` (`place_id` PK and FK -> `places` `ON DELETE CASCADE`, `embedding vector(1024)`, `embedding_model`, `document_fingerprint` = lower-case hex SHA-256 of the Place Document, `embedded_at timestamptz(0)`) with HNSW index `place_embeddings_embedding_hnsw_idx` (`vector_cosine_ops`, pgvector defaults). No Objection model: Knex builder plus Zod row schemas, like the crawl tables. Vectors go through the `pgvector` npm package (`src/db/vector.ts`), written as `?::vector` bindings and read back as `embedding::text`. A Place is Embedding Due when it has no record, or its fingerprint or model differs; a Batch is saved all or nothing. The Embedding Store reads Detailed Places in ascending Place ID (the Embedding Order).
- **Embed run:** `pnpm embed` (`tsx scripts/embed.ts`) reads `.env` (shell wins) and is never chained to the crawl. Batches hold at most 1,000 texts and an estimated 320,000 tokens (UTF-8 bytes + 16 per text; an oversize document goes alone, Voyage truncates). Requests are sequential with no client-side pacing. Connection failures (no status, 408, 5xx) and rate limits (429) get 2 extra tries after 30 s and 60 s; a persistent rate limit ends the run as Rate Limited (exit 0), a persistent connection failure or an invalid answer (including one naming a model other than `voyage-4`) fails only that Batch. Any other 4xx is Service Refused: the run ends Failed (exit 1) and that Batch's places stay due. The summary (places embedded, unchanged and summary-only skipped, failed, still due, requests, tokens used) is printed only, not stored. No dry run; concurrent runs are not refused (at worst some places are embedded twice).
- **Voyage client:** `voyageai` pinned at exactly `0.4.0`, loaded lazily through the adapter `src/embed/voyage-service.ts` (`VoyageAIClient`, `baseUrl`, per request `maxRetries: 0` and `timeoutInSeconds: 120`). The SDK sends snake_case to the REST API and answers in camelCase (`usage.totalTokens`). HTTP errors are `VoyageAIError` with a numeric `statusCode`; timeouts (`VoyageAITimeoutError`) and network errors have none. The run's 30 s / 60 s retries are the only retries.
- **Module resolution:** `module: preserve` + `moduleResolution: bundler` (decided 2026-10-21), so relative imports are extensionless. Runnable scripts (ETL, crawl, embedding jobs) run through `tsx` or a build step, not plain `node`.

## Open Decisions

- **HTTP framework** for the backend API (e.g. Fastify) — decided by the first AL4 spec that needs it.
- **Frontend location** in the repo (same repo / separate package) — decided at Stage 4.
- **Wikimapia API rate limit** — not documented; a 2016 report says 100 requests per 5 minutes. The crawl uses half of that by default (minimum 6 s between requests, retries included; 500 requests per run). Each crawl run's summary (requests, rate-limit waits and seconds waited) is how the real quota gets measured. Run 1 of `belgrade-small` hit the key quota (code 1004) after about 90 requests, below that 100-per-5-minutes figure; revisit the request budget and pacing once the quota's reset window is known (see "Key quota" below).

---

## Wikimapia API Reference

Docs: https://wikimapia.org/api/ (beta). Base URL `https://api.wikimapia.org/?function=<name>&key=<key>` (HTTPS verified 2026-10-21 for `box` and `place.getbyid`: same JSON as HTTP, valid Let's Encrypt certificate; HTTP does not redirect, so always request HTTPS so the key travels encrypted). Every call needs an API key (created at wikimapia.org/api with a Wikimapia account); keep it in `.env` as `WIKIMAPIA_API_KEY`.

- `format=json`, optional `pack=gzip`, `language=<ISO 639-1>`.
- Terms: free for non-commercial use; the data source must be credited (Wikimapia TOS).

**Verified behaviour (probed 2026-10-20 with a real key; raw responses in `data/recordings/`):**

- `place.getbyarea` and `place.search` **return `[]` for every query**, including bbox and separate-coordinate forms, small and wide areas. Treat them as broken; do not build on them.
- `box` (deprecated, but works) is the **enumeration** call: `function=box&bbox=lon_min,lat_min,lon_max,lat_max&page=N&count=<=100`. Response `{version, language, page, count, found, folder: [{id, name, url, location, polygon}]}`. `found` is the total for the bbox (290 for `20.452,44.814,20.462,44.820` in central Belgrade). No description or comments.
- `place.getbyid` is the **detail** call, one request per place: `data_blocks=main,geometry,location,comments`. Returns `id, title, description, tags, parent_id, is_building, is_region, is_deleted, polygon [{x,y}], location {lon, lat, north, south, east, west, street, country, ...}, comments [...]`. Comment fields: `place_id, num, lang_id, user_id, user_ip, user_photo, name, message, good, bad, block, date, moder_uid, moder_name, is_deleted, replies`.
- `place.getnearest` works (`lat`/`lon`, up to 100 places with `distance`, `location`, `polygon`), but its `found` is always 0 and titles are double-escaped HTML (`&amp;quot;`). Not needed for the crawl.
- **Rate limiting** is signalled with HTTP 200 and body `{"debug":{"message":"You have reached the limit for this action. You need to wait for N seconds."}}`. The client must detect this, wait N seconds and retry. The shared demo key (`key=example`) hits it after 1–2 calls; the real key made ~10 calls a few seconds apart without hitting it. The actual quota is still unknown.
- **Key quota** (found 2026-10-22, run 1 of `belgrade-small`): after roughly 90 requests in ~9 minutes at one request per 6 s, every call returned HTTP 200 with `{"debug":{"code":1004,"message":"Key limit has been reached"}}`. This is a quota on the key, distinct from the "wait N seconds" rate limit, and it was still active after the run ended. Reset window unknown (hourly? daily?) — it decides whether a full Belgrade crawl is feasible. The client reports it as `key_quota_exhausted` and the crawl stops cleanly (see Decisions).
- **`tags` is omitted** (not `[]`) by `place.getbyid` when a place has no tags (places 1391132, 8918979). `wikipedia` can be omitted too. The client reads a missing or `null` `tags` as an empty list.
- **Crawled data profile** (80 detailed places from `belgrade-small`, run 1): descriptions median 23 chars — 21 empty, 46 under 100 chars, 2 over 1,000, many only a URL; 4 comments in total across 3 places; every place has tags (69 distinct; top: apartment building, monument, listed heritage building, museum, university, hotel, restaurant). Tags and names carry most of the signal; comments barely exist.
- **Comments are sparse** in Belgrade: of 3 central places sampled (National Theatre, Square of the Republic, University Park) only one had comments (2). Descriptions vary from 16 to 7,000+ characters. Description text, not comments, will carry most of the semantic signal.
- Crawl shape therefore: `box` pages over a bbox grid to collect ids, then `getbyid` per id. Total calls ≈ places + places/100.

---

## Development Process: ADD

Features are built with Artifact-Driven Development: run `/add <request>`. The pipeline descends AL7 intent -> AL6 requirements -> AL5 contracts -> AL4 design -> AL3 routing -> AL2 tests and code, through the `add-*` subagents in `.claude/agents/`. Project rules binding on every layer are in `.agrules`. Artifacts live in `docs/al7-intent/`, `docs/al6-requirements/`, `contracts/`, `docs/al4-design/`, `docs/al3-routing/`. Per-step metrics go to `.add/reports/add-metrics.jsonl`.
