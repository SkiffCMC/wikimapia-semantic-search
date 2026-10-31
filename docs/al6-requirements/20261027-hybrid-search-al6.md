# AL6 Requirements: Hybrid Search

- **Feature:** `hybrid-search` (Stage 2, substep 2a)
- **AL7 source:** `docs/al7-intent/20261027-hybrid-search-al7.md`
- **Builds on:** `docs/al6-requirements/20261021-storage-al6.md` (the **Storage AL6**, the Place Store), `docs/al6-requirements/20261023-embeddings-al6.md` (the **Embeddings AL6**, Embedding Records), and through them the Client, Hydration and crawl-run1-fixes AL6 documents. Their glossaries are reused. Their criteria are cited as "Storage AC-n" and "Embeddings AC-n". Criteria in this document are numbered AC-1 onwards and always appear without a prefix.
- **Status:** Ready for AL5 Contracts (revision 4). On 2026-10-29 the stakeholder accepted the proposed defaults of Q1 to Q5 and Q7 to Q10, accepted the two rules set without a question (R-A, R-B), and answered Q6 with a new choice: a Search Mode parameter, Exact by default, with an Approximate mode (section 6). On 2026-10-30 the stakeholder decided the documented Search Command form is `pnpm run search "<Query Text>" [options]`, because `pnpm search ...` never reaches the project's command (decision Q11, section 6). On 2026-10-31 the stakeholder decided that AC-72 must not depend on a specific pnpm version (decision Q11 follow-up, section 6.2). No question remains open.
- **Numbering note:** criteria AC-1 to AC-62 keep their numbers and meaning from revision 1 (AC-10 is now stated for Exact mode). Criteria added in revision 2 are numbered AC-63 to AC-71 and placed in the section they belong to. Revision 3 changes only the command form written in AC-41 and AC-71 (their meaning is unchanged) and adds AC-72. Revision 4 changes only the precondition of AC-72 (it no longer names a pnpm version); its number and expected result are unchanged.

## 0. Context and Scope

The Place Store holds Places with their Tags, Centre Point and Outline Shape (Storage AL6), and the Embedding Run gives every Detailed Place one Embedding of its Place Document (Embeddings AL6). This feature adds **Place Search**: given a Search Request (what the user is looking for in words, optionally an area and Tags, how many results are wanted and whether the answer must be exact), it returns the Places that lie in the area and carry the Tags, ranked by how close their meaning is to the words. Places outside the requested area are never returned (`.agrules` section 1).

Place Search takes already structured parameters. Turning a raw natural-language question into those parameters (the LLM Intent Parser), reranking by the LLM, the HTTP API, result cards for the web page and the MCP server are later substeps and stages; they will call Place Search.

**In scope**

- The Search Request: Query Text (required), an optional Spatial Filter (either a Radius Filter or an Area Filter), an optional Tag Filter, a Result Limit (default 20, at most 50) and a Search Mode (Exact by default, or Approximate), and how invalid requests are refused.
- Turning the Query Text into a Query Embedding through the Embedding Service, as Document Kind "query".
- Choosing the Searchable Places that pass the Spatial Filter and the Tag Filter, ranking them by Similarity Score, and returning at most Result Limit of them.
- The content of each Search Result: Place ID, Place Name, Wikimapia Link, Tag titles, Centre Point, Distance (only with a Radius Filter) and Similarity Score.
- Failures of the Embedding Service and of the Place Store during a search.
- The Search Command for manual checks from the command line (`pnpm run search ...`, decision Q11).

**Out of scope**

- Parsing natural-language questions into a Search Request (the LLM Intent Parser, a later substep of Stage 2).
- Reranking with the LLM, comment snippets and highlights.
- The HTTP search endpoint, result cards for the web page (including the `/ru/{title_slug}` card link and per-card attribution) and the MCP server (Stages 3 and 5, decision Q1).
- Keyword (full-text) matching of names or descriptions. Ranking is by meaning only.
- A minimum Similarity Score below which Places are dropped. Every Place that passes the filters can be returned.
- Paging beyond the first Result Limit results.
- A guaranteed share of the true top results in Approximate mode (decision Q6 sets no such figure).
- Changing anything in the Place Store. Place Search only reads.
- Embedding stored Places. Place Search only embeds the Query Text (`.agrules` section 1).
- Calling Wikimapia. Place Search only reads the local Place Store (CLAUDE.md, Decisions).
- Making the short form `pnpm search ...` reach the Search Command (decision Q11: that form belongs to pnpm itself).

**Facts this document relies on**

- Every Stored Place has a Centre Point in WGS 84 (Storage AC-45). Places with an Outline of 3 or more points also have an Outline Shape; others have none (Storage AC-48).
- Each Place has Place-Tag Links to the Tag Catalogue, each marked Present or Gone (Storage AL6, D2). A Tag has an id and a title; Wikimapia titles seen so far are lower-case English ("museum", "town square", "listed heritage building").
- Only Detailed Places with a non-empty Place Document get an Embedding Record; Summary-Only Places never do (Embeddings AC-17, AC-24). Each Embedding Record holds 1024 numbers and its Embedding Model, which is always `voyage-4` when written by the Embedding Run, and there is an index for nearest-by-cosine lookups (Embeddings AC-54).
- An Embedding Record may be older than the Place's current Place Document (the Place is Embedding Due until the next Embedding Run).
- Places marked deleted by Wikimapia are embedded like any other; "search decides what to show" (Embeddings decision Q4). This document decides: they are not returned (decision Q5).
- The Embedding Service is Voyage AI `voyage-4`; search queries are sent as Document Kind "query" (CLAUDE.md, Decisions; `.agrules` section 2). The key is `VOYAGE_API_KEY`.
- `.agrules` section 2 requires every result card to carry `place_id`, title, a link of the form `https://wikimapia.org/{place_id}/ru/{title_slug}`, category info and Wikimapia attribution. The Place Store keeps a different Wikimapia Link (a Listing Link such as `http://wikimapia.org/1381893/University-Park`, or a Built Link `http://wikimapia.org/1381893`). Search Results carry the stored link; result cards are built in Stage 3 (decision Q1).
- In pnpm 10.33, `pnpm search ...` is handled by pnpm itself as a search of the npm package registry and never reaches the project's own `search` command; `pnpm run search ...` does (found at AL1, 2026-10-30; decision Q11). This is background explaining why `pnpm search` is not used; no criterion depends on that pnpm version (decision Q11 follow-up).

## 1. Ubiquitous Language (Domain Glossary)

Terms of the earlier AL6 documents keep their meaning, in particular: **Place, Place ID, Place Name, Place Store, Stored Place, Summary-Only Place, Detailed Place, Tag, Tag Catalogue, Place-Tag Link, Presence Mark, Present, Gone, Centre Point, Outline Shape, Wikimapia Link, Listing Link, Built Link, Embedding, Embedding Record, Embedding Model, Embedding Service, Simulated Embedding Service, Document Kind, Embedding Failure (Connection Failure, Service Rate Limit, Service Refused, Invalid Embedding Answer), Store Unavailable, Test Database, Development Database, Schema Setup**. New terms:

| Term | Definition |
|---|---|
| **Place Search** | The capability specified here: answering one Search Request with a list of Search Results. Called "search" in this document. |
| **Search Caller** | Whoever asks Place Search for results: in later stages the search API and, through it, the MCP server; in this feature the Search Command and tests. |
| **Developer** | The person running the Search Command by hand to check search quality. |
| **Search Request** | What a Search Caller gives to Place Search: Query Text, at most one Spatial Filter, an optional Tag Filter, an optional Result Limit and an optional Search Mode. |
| **Query Text** | The words describing what is being looked for (for example "museum" or "quiet spot near the river"). Required, not empty after trimming spacing at both ends, at most 1,000 characters after trimming (decision Q8). |
| **Query Embedding** | The Embedding of the Query Text, produced by the Embedding Service with Embedding Model `voyage-4` and Document Kind "query". Exactly 1024 finite numbers. |
| **Spatial Filter** | An optional restriction to an area. Either a Radius Filter or an Area Filter, never both (decision R-B). |
| **Radius Filter** | A Search Centre plus a Radius. A Place passes when the Distance from the Search Centre to its Centre Point is at most the Radius. |
| **Search Centre** | A point given by latitude and longitude in WGS 84 (latitude from -90 to 90, longitude from -180 to 180). Latitude is given first (decision Q2). |
| **Radius** | A length in metres, greater than 0 and at most the Maximum Radius. |
| **Maximum Radius** | The largest Radius accepted: 50,000 metres (decision Q8). |
| **Distance** | The shortest distance in metres along the surface of the earth (WGS 84) between the Search Centre and a Place's Centre Point. |
| **Area Filter** | A box given by its south and north latitudes and its west and east longitudes, with south below north and west below east (a box crossing the 180th meridian is not supported). A Place passes when it Lies In the Area. |
| **Lies In the Area** | A Place with an Outline Shape lies in the area when its Outline Shape and the box touch or overlap; a Place without an Outline Shape lies in the area when its Centre Point is inside the box or on its edge (decision Q3). |
| **Tag Filter** | An optional list of one or more Tag titles. A Place passes when it has a Present Place-Tag Link to a Tag whose title matches any of them (decision Q4). |
| **Tag Title Match** | A Tag title in the Tag Filter matches a Tag in the Tag Catalogue when they are equal after trimming spacing at both ends and ignoring upper/lower case (decision Q4). |
| **Result Limit** | The largest number of Search Results wanted. A whole number from 1 to 50; 20 when not given. A value above 50 is refused (decision Q7). |
| **Search Mode** | How thoroughly a search looks for the best Matching Places. Exactly one of: **Exact** (the default; the answer is always the true best Matching Places, as many as the Result Limit allows) or **Approximate** (a faster search that may return fewer Places, or not exactly the best ones, when the filters are selective). In both modes every Search Result is a Matching Place and results are in Ranking Order (decision Q6). |
| **Searchable Place** | A Detailed Place that has an Embedding Record with Embedding Model `voyage-4` (decision R-A) and is not marked deleted by Wikimapia (decision Q5). Only Searchable Places are ever returned. |
| **Matching Place** | A Searchable Place that passes the Spatial Filter (if any) and the Tag Filter (if any). |
| **Similarity Score** | How close in meaning a Place is to the Query Text: the cosine similarity between the Query Embedding and the Place's Embedding. A number from -1 to 1; higher means closer. |
| **Ranking Order** | Descending Similarity Score; Places with an equal Similarity Score in ascending Place ID. |
| **Search Result** | One returned Place: Place ID, Place Name, Wikimapia Link, Result Tag Titles, Centre Point (latitude and longitude), Distance (only when the Search Request has a Radius Filter) and Similarity Score. |
| **Result Tag Titles** | The titles of the Place's Present Tags, in the order the Place Store reads them back (Storage AC-72). Gone Tags are not listed. |
| **Search Outcome** | What a search reports: either a list of Search Results (possibly empty) or one Search Failure. Never both, never a partial list. |
| **Search Failure** | A search that could not be answered. Exactly one of: **Invalid Search Request** (names the offending parameter and why), **Missing Key** (`VOYAGE_API_KEY` not set or empty), **Query Embedding Failure** (an Embedding Failure of one of its four kinds while embedding the Query Text), **Store Unavailable** (the Place Store could not be reached or could not complete the search). |
| **Search Command** | The project's command named `search`, which the Developer runs for manual checks. Its documented form is `pnpm run search "<Query Text>" [options]` (AC-41, decision Q11). The short form `pnpm search ...` is not the Search Command: pnpm treats it as a search of the npm package registry. |

## 2. User Stories

- **US-1 (Find by meaning):** As a Search Caller, I want to give words describing what I look for and get back the Places whose meaning is closest, best first, so that users find Places even when their words differ from Wikimapia's.
- **US-2 (Stay in the area):** As a Search Caller, I want to restrict a search to a circle around a point or to a box on the map and be sure no Place outside it is returned, so that "near X" questions are answered honestly.
- **US-3 (Filter by category):** As a Search Caller, I want to restrict a search to Places carrying given Tags, so that a question about museums returns museums.
- **US-4 (Useful results):** As a Search Caller, I want each result to carry the Place's ID, name, Wikimapia Link, Tags, location, how far it is from my point and how good a match it is, so that later stages can show result cards and map markers and credit Wikimapia.
- **US-5 (Bounded answers):** As a Search Caller, I want to choose how many results I get, up to 50, with 20 by default, so that answers stay short and fast.
- **US-6 (Clear refusals):** As a Search Caller, I want an invalid request or an unavailable service to be reported as a named failure rather than wrong or partial results, so that I can tell the user what went wrong.
- **US-7 (Check by hand):** As a Developer, I want to run a search from the command line against my local Place Store, using the command form the project documents, so that I can judge result quality before the API and web page exist.
- **US-8 (One model, query side):** As the project owner, I want queries embedded with the same model as stored Places, as "query", and compared only with Embeddings of that model, so that similarity scores are meaningful (`.agrules` section 2).
- **US-9 (Verifiable offline):** As a developer, I want the whole feature testable with a Simulated Embedding Service and synthetic Places and Embeddings in the Test Database, so that tests make no live calls and cost nothing.
- **US-10 (Licensing):** As the project owner, I want search to remain a read-only, non-commercial use of the Wikimapia data that always links back to Wikimapia, so that we honour CC BY-NC-SA 3.0.
- **US-11 (Exact or fast):** As a Search Caller, I want exact answers by default and the option to ask for a faster, approximate answer that still never leaves my filters, so that I can trade completeness for speed when I choose to.

## 3. Acceptance Criteria (BDD Style)

Unless a criterion says otherwise, the setup is as follows. The Place Store is the Test Database with every Schema Setup step applied, holding exactly the **Search Set** below. The Embedding Service is a Simulated Embedding Service that answers any Query Text with the fixed Query Embedding **Q** and records what it was asked. `VOYAGE_API_KEY` is a dummy value. The **Point S** is latitude 44.817000, longitude 20.457000. A criterion that names no Search Mode is a search without a Search Mode, which is Exact (AC-63).

**Search Set** (synthetic). Distances are from Point S, rounded to the metre; "similarity" is the cosine similarity of the Place's Embedding with Q (the synthetic Embeddings are built to have exactly these values). All Tags are Present unless marked Gone; all Embedding Records have Embedding Model `voyage-4` unless stated; no Place is marked deleted unless stated; Places have no Outline Shape unless stated.

| Place ID | Place Name | Centre Point (lat, lon) | Distance | Tags | Embedding Record | Notes |
|---|---|---|---|---|---|---|
| 101 | City Museum | 44.817000, 20.457000 | 0 m | museum | similarity 0.90 | |
| 102 | Art Gallery | 44.819700, 20.457000 | 300 m | museum, art gallery | similarity 0.95 | |
| 103 | Old Hotel | 44.824200, 20.457000 | 800 m | hotel | similarity 0.99 | |
| 104 | Corner Cafe | 44.821000, 20.457000 | 445 m | restaurant | similarity 0.50 | |
| 105 | Unembedded Museum | 44.817000, 20.457100 | 8 m | museum | none | Detailed Place |
| 106 | Listed Place | 44.817000, 20.457000 | 0 m | none | none | Summary-Only Place |
| 107 | Other Model Museum | 44.817200, 20.457000 | 22 m | museum | similarity 0.97, Embedding Model not `voyage-4` | |
| 108 | Former Museum | 44.817900, 20.457000 | 100 m | monument; museum (Gone) | similarity 0.70 | |
| 109 | Riverside Park | 44.818000, 20.459000 | 193 m | park | similarity 0.60 | Outline Shape: box from latitude 44.8175 to 44.8185, longitude 20.4575 to 20.4605 |
| 110 | Deleted Museum | 44.817400, 20.457000 | 44 m | museum | similarity 0.80 | marked deleted by Wikimapia |

Each Place's Wikimapia Link is its Built Link (`http://wikimapia.org/<Place ID>`).

**Area B** (an Area Filter): south 44.8160, north 44.8200, west 20.4560, east 20.4580. Centre Points of 101, 102, 105, 106, 107, 108 and 110 lie inside it; those of 103, 104 and 109 lie outside; the Outline Shape of 109 overlaps it.

### 3.1 Ranking by meaning (US-1, US-5, US-8)

- **AC-1 (No filters):** Given the Search Set, When a search is made with Query Text "museum" and no other parameter, Then the Search Outcome is the Search Results for Places 103, 102, 101, 108, 109, 104, in that order, with Similarity Scores 0.99, 0.95, 0.90, 0.70, 0.60, 0.50 (each within 0.000001).
- **AC-2 (Query embedded as a query):** Given any valid Search Request, in either Search Mode, When a search is made, Then the Simulated Embedding Service is asked exactly once, with the Query Text as the only text, Embedding Model `voyage-4` and Document Kind "query". No stored Place is sent to it.
- **AC-3 (Query Text as given):** Given Query Text "  quiet spot near the river  ", When a search is made, Then the text sent to the Embedding Service is "quiet spot near the river" (spacing at both ends removed, everything else unchanged, including letters with diacritics and Cyrillic letters).
- **AC-4 (Only Searchable Places):** Given the Search Set, When any search is made, in either Search Mode, Then Places 105 (no Embedding Record), 106 (Summary-Only Place), 107 (Embedding Model not `voyage-4`, decision R-A) and 110 (marked deleted by Wikimapia, decision Q5) are never among the Search Results, whatever their position or Similarity Score.
- **AC-5 (Result Limit):** Given the Search Set, When a search is made with Query Text "museum", no filters and Result Limit 3, Then the Search Results are Places 103, 102, 101, in that order.
- **AC-6 (Default Result Limit):** Given 25 Searchable Places with distinct similarities and no filters, When a search is made without a Result Limit, Then exactly the 20 with the highest Similarity Scores are returned, in Ranking Order.
- **AC-7 (Highest Result Limit):** Given 60 Searchable Places and no filters, When a search is made with Result Limit 50, Then exactly 50 Search Results are returned: the 50 with the highest Similarity Scores, in Ranking Order.
- **AC-8 (Fewer Matching Places than the limit):** Given the Search Set, When a search is made with Result Limit 50 and no filters, Then exactly the 6 Searchable Places are returned (as in AC-1); no Place is repeated and no placeholder is added.
- **AC-9 (Ties):** Given Places 201 and 202 that are Searchable Places with the same similarity to Q, When a search returns both, Then 201 comes before 202.
- **AC-10 (Complete answer in Exact mode):** Given M Matching Places and Result Limit N, When a search is made in Exact mode (given explicitly or by default), Then exactly the smaller of M and N Search Results are returned, and they are the Matching Places with the highest Similarity Scores, in Ranking Order (decision Q6). This holds however few Places pass the filters (for example 1 Matching Place among 10,000 Searchable Places is still found).
- **AC-11 (Older Embedding still searchable):** Given a Searchable Place whose Place Document has changed since its Embedding Record was made (it is Embedding Due), When a search is made, Then the Place is searched with its existing Embedding and is returned like any other.
- **AC-12 (No result is not a failure):** Given the Place Store holds no Searchable Place, When a search is made with Query Text "museum", Then the Search Outcome is an empty list of Search Results, not a Search Failure.

### 3.2 Radius Filter (US-2)

- **AC-13 (Happy path):** Given the Search Set, When a search is made with Query Text "museum", Search Centre Point S and Radius 500, Then the Search Results are Places 102, 101, 108, 109, 104, in that order, with Distances of about 300, 0, 100, 193 and 445 metres. Place 103 (800 m, the highest similarity) is not returned.
- **AC-14 (Distance value):** Given any search with a Radius Filter, in either Search Mode, When a Place is returned, Then its Distance is the Distance from the Search Centre to its Centre Point, within 1 metre of the true WGS 84 surface distance. For Place 101 (at the Search Centre) it is 0.
- **AC-15 (Never outside the circle):** Given any search with a Radius Filter, in either Search Mode, When Search Results are returned, Then every one has a Distance at most the Radius, even when Places outside the circle have higher Similarity Scores and the Result Limit is not reached.
- **AC-16 (Boundary included):** Given a Searchable Place whose Distance from the Search Centre equals the Radius exactly (as measured by Place Search itself), When a search is made, Then it is returned.
- **AC-17 (Small circle):** Given the Search Set, When a search is made with Search Centre Point S and Radius 50, Then the only Search Result is Place 101 (Place 110 at 44 m is marked deleted, decision Q5; Places 105, 106 and 107 are not Searchable Places).
- **AC-18 (Wider circle):** Given the Search Set, When a search is made with Search Centre Point S and Radius 1000, Then the Search Results are Places 103, 102, 101, 108, 109, 104, in that order.
- **AC-19 (Empty circle):** Given the Search Set, When a search is made with Search Centre latitude 45.000000, longitude 21.000000 and Radius 500, Then the Search Outcome is an empty list, not a Search Failure.
- **AC-20 (Circle uses the Centre Point only):** Given a Searchable Place whose Centre Point is 600 m from the Search Centre and whose Outline Shape reaches within 100 m of it, When a search is made with Radius 500, Then it is not returned.
- **AC-21 (Distance only with a Radius Filter):** Given a search with an Area Filter or with no Spatial Filter, When Search Results are returned, Then none of them carries a Distance.

### 3.3 Area Filter (US-2)

- **AC-22 (Happy path):** Given the Search Set, When a search is made with Query Text "museum" and Area B, Then the Search Results are Places 102, 101, 108, 109, in that order (109 because its Outline Shape overlaps Area B, decision Q3). Places 103 and 104 are not returned.
- **AC-23 (Never outside the box):** Given any search with an Area Filter, in either Search Mode, When Search Results are returned, Then every one Lies In the Area, even when Places outside it have higher Similarity Scores and the Result Limit is not reached.
- **AC-24 (Edge included):** Given a Searchable Place without an Outline Shape whose Centre Point lies exactly on the edge of the box, When a search is made with that Area Filter, Then it is returned.
- **AC-25 (Outline entirely outside):** Given a Searchable Place whose Outline Shape lies entirely outside the box and whose Centre Point lies outside it, When a search is made with that Area Filter, Then it is not returned.
- **AC-26 (Empty box):** Given the Search Set, When a search is made with an Area Filter far from Belgrade (south 10.0, north 10.1, west 10.0, east 10.1), Then the Search Outcome is an empty list, not a Search Failure.

### 3.4 Tag Filter (US-3)

- **AC-27 (One Tag):** Given the Search Set, When a search is made with Query Text "museum" and Tag Filter ["museum"], Then the Search Results are Places 102, 101, in that order. Place 108 (whose "museum" Tag is Gone) is not returned (decision Q4).
- **AC-28 (Any of several Tags):** Given the Search Set, When a search is made with Tag Filter ["museum", "hotel"], Then the Search Results are Places 103, 102, 101, in that order (decision Q4: a Place needs any one of the Tags, not all of them).
- **AC-29 (Tag and circle together):** Given the Search Set, When a search is made with Tag Filter ["museum", "hotel"], Search Centre Point S and Radius 500, Then the Search Results are Places 102, 101, in that order.
- **AC-30 (Tag and box together):** Given the Search Set, When a search is made with Tag Filter ["park"] and Area B, Then the only Search Result is Place 109.
- **AC-31 (Case and spacing ignored):** Given the Search Set, When a search is made with Tag Filter [" Museum "], Then the Search Results are the same as in AC-27 (decision Q4).
- **AC-32 (Whole titles only):** Given the Search Set, When a search is made with Tag Filter ["muse"] or ["gallery"], Then the Search Outcome is an empty list: a part of a title does not match ("gallery" does not match "art gallery").
- **AC-33 (Unknown Tag):** Given the Search Set, When a search is made with Tag Filter ["volcano"], which no Tag in the Tag Catalogue has, Then the Search Outcome is an empty list, not a Search Failure.
- **AC-34 (Repeated Tag titles):** Given the Search Set, When a search is made with Tag Filter ["museum", "museum"], Then the Search Results are the same as in AC-27, and no Place is returned twice.

### 3.5 Search Results (US-4, US-10)

- **AC-35 (Result content):** Given the search of AC-13, When the Search Result for Place 102 is examined, Then it carries exactly: Place ID 102; Place Name "Art Gallery"; Wikimapia Link `http://wikimapia.org/102` (the stored Wikimapia Link, decision Q1); Result Tag Titles "museum", "art gallery" in that order; Centre Point latitude 44.8197, longitude 20.457; Distance about 300 metres; Similarity Score 0.95.
- **AC-36 (Gone Tags not listed):** Given the search of AC-13, When the Search Result for Place 108 is examined, Then its Result Tag Titles are exactly "monument".
- **AC-37 (Place without Tags):** Given a Searchable Place with no Present Tags, When it is returned, Then its Result Tag Titles are an empty list.
- **AC-38 (Listing Link when stored):** Given a Searchable Place whose stored Wikimapia Link is a Listing Link `http://wikimapia.org/1381893/University-Park`, When it is returned, Then its Wikimapia Link is exactly that Listing Link (decision Q1).
- **AC-39 (Read only):** Given any search, in either Search Mode, successful or failed, When the Place Store is inspected afterwards, Then every Stored Place, Tag, Place-Tag Link, Comment and Embedding Record is exactly as before.
- **AC-40 (Text with special characters):** Given Query Text `museum'; drop "places" -- 100%`, When a search is made, Then the search completes normally: exactly this text is sent to the Embedding Service, the Search Outcome is a list of Search Results, and the Place Store is unchanged.

### 3.6 Search Command (US-7)

- **AC-41 (Command form):** Given the project is installed and the Development Database holds Searchable Places, When the Developer runs `pnpm run search "museum" --near 44.817,20.457 --radius 500`, Then a search is made in Exact mode with Query Text "museum", Search Centre latitude 44.817, longitude 20.457 (latitude first, decision Q2), Radius 500 metres and the default Result Limit. Further options: `--bbox <south>,<west>,<north>,<east>` for an Area Filter, `--tag <title>` (may be given several times) for the Tag Filter, `--limit <n>` for the Result Limit (decision Q9), and `--approximate` for Approximate mode (AC-71). The documented form of the Search Command is `pnpm run search "<Query Text>" [options]` (decision Q11).
- **AC-42 (Command output):** Given a search made by the Search Command returns Search Results, When it ends, Then it prints a line naming the Search Mode used (`Mode: exact` or `Mode: approximate`), then, in Ranking Order, one block per Search Result with rank, Place Name, Place ID, Wikimapia Link, Result Tag Titles, Centre Point, Distance (when a Radius Filter was given) and Similarity Score, followed by the number of results and the line "Data: Wikimapia (wikimapia.org), CC BY-NC-SA 3.0". An empty result prints the mode line, "No places found." and the same attribution line.
- **AC-43 (Command exit status):** Given the Search Command ends, When the Developer checks how it ended, Then it reports success when the Search Outcome is a list of Search Results (including an empty list), and failure for any Search Failure, with a message naming the failure kind (and, for Invalid Search Request, the offending option).
- **AC-44 (Command options checked):** Given the Search Command is run with no Query Text, an unknown option, `--radius` without `--near`, `--near` without `--radius`, both `--near` and `--bbox`, an option value that is not a number where a number is required, or a value given to `--approximate` (for example `--approximate=yes`), When it starts, Then it ends with failure and a usage message, and makes no call to the Embedding Service.
- **AC-45 (Settings read from the environment):** Given the Search Command, When it starts, Then it reads `VOYAGE_API_KEY` and the Development Database settings from the environment or the project's environment settings file (values already set in the environment win), like the Embed Command.
- **AC-71 (Approximate flag):** Given the Developer runs `pnpm run search "museum" --near 44.817,20.457 --radius 500 --approximate`, When the command runs, Then a search is made in Approximate mode with the same other parameters as in AC-41, and the output starts with `Mode: approximate`. Without `--approximate` the search is in Exact mode and the output starts with `Mode: exact`. Giving `--approximate` more than once has the same effect as giving it once.
- **AC-72 (Documented form reaches the Search Command):** Given the project is installed with the pnpm the project has installed (no particular pnpm version is assumed, decision Q11 follow-up), When the Developer runs `pnpm run search --fast` from the project folder (no Query Text and an unknown option), Then the Search Command itself answers: it ends with failure and its usage message as in AC-44, the usage message shows the command form `pnpm run search "<Query Text>" [options]`, nothing from the npm package registry search is printed and no network call to the npm package registry is made, and no call is made to the Embedding Service (decision Q11).

### 3.7 Invalid Search Requests (US-6)

For every criterion in this section: the Search Outcome is an Invalid Search Request naming the offending parameter, no call is made to the Embedding Service, and the Place Store is not consulted. This holds in either Search Mode.

- **AC-46 (Query Text missing or empty):** Given a Search Request whose Query Text is missing, empty, or only spacing, When a search is made, Then it is refused as Invalid Search Request naming Query Text.
- **AC-47 (Query Text too long):** Given a Query Text longer than 1,000 characters after trimming, When a search is made, Then it is refused as Invalid Search Request naming Query Text (decision Q8). A Query Text of exactly 1,000 characters is accepted.
- **AC-48 (Both Spatial Filters):** Given a Search Request with both a Radius Filter and an Area Filter, When a search is made, Then it is refused as Invalid Search Request naming the Spatial Filter (decision R-B).
- **AC-49 (Incomplete Radius Filter):** Given a Search Request with a Search Centre but no Radius, or a Radius but no Search Centre, When a search is made, Then it is refused naming the missing part.
- **AC-50 (Bad Search Centre):** Given a Search Centre with latitude outside -90..90 (for example 91), longitude outside -180..180 (for example 181), or a value that is not a finite number, When a search is made, Then it is refused naming the Search Centre.
- **AC-51 (Bad Radius):** Given a Radius of 0, a negative Radius, a Radius above the Maximum Radius (for example 50,001), or a value that is not a finite number, When a search is made, Then it is refused naming the Radius. A Radius of exactly 50,000 metres is accepted (decision Q8).
- **AC-52 (Bad Area Filter):** Given an Area Filter with south not below north, west not below east, a latitude outside -90..90, a longitude outside -180..180, a missing edge, or a value that is not a finite number, When a search is made, Then it is refused naming the Area Filter.
- **AC-53 (Bad Tag Filter):** Given a Tag Filter that is an empty list, or contains a title that is empty or only spacing, When a search is made, Then it is refused naming the Tag Filter.
- **AC-54 (Bad Result Limit):** Given a Result Limit of 0, a negative number, a number that is not whole (for example 2.5), or a number above 50 (for example 51), When a search is made, Then it is refused naming the Result Limit (decision Q7: above 50 is refused, not lowered to 50).
- **AC-55 (Unknown parameter):** Given a Search Request carrying a parameter that is not part of a Search Request, When a search is made, Then it is refused naming that parameter.
- **AC-70 (Bad Search Mode):** Given a Search Request whose Search Mode is neither Exact nor Approximate (for example "fast", or an empty value), When a search is made, Then it is refused naming the Search Mode.

### 3.8 Failures (US-6)

- **AC-56 (Missing key):** Given `VOYAGE_API_KEY` is not set or empty, When a valid search is made, Then the Search Outcome is Missing Key naming `VOYAGE_API_KEY`, no call is made to the Embedding Service and the Place Store is not consulted.
- **AC-57 (Query Embedding Failure):** Given the Simulated Embedding Service answers with a Connection Failure, a Service Rate Limit, Service Refused, or an Invalid Embedding Answer (no Embedding, more than one Embedding, an Embedding of 1023 or 1025 numbers, a value that is not a finite number, or an answer that cannot be read), When a valid search is made, Then the Search Outcome is a Query Embedding Failure of that kind, no Search Results are returned, the Embedding Service is asked exactly once (no retry, decision Q10), and the Place Store is not consulted.
- **AC-58 (Wrong model in the answer):** Given the Simulated Embedding Service answers with an Embedding it says was made by a model other than `voyage-4`, When a search is made, Then the Search Outcome is a Query Embedding Failure of kind Invalid Embedding Answer.
- **AC-59 (Place Store unavailable):** Given the Place Store cannot be reached, When a valid search is made, Then the Search Outcome is Store Unavailable and no Search Results are returned.
- **AC-60 (No secrets in failures):** Given any Search Failure, When its message and details are examined, Then they contain no `VOYAGE_API_KEY` or other key value and no database password or connection secret.

### 3.9 Tests (US-9, `.agrules` section 4)

- **AC-61 (No live calls):** Given any test of this feature, When it runs, Then every Query Embedding comes from the Simulated Embedding Service, no real key is used, and no call is made to Voyage AI, Anthropic or Wikimapia.
- **AC-62 (Synthetic data, Test Database only):** Given tests that need stored Places, When they run, Then they use only the Test Database, starting from the known state of Embeddings AC-58, with small synthetic Places and deterministic synthetic Embeddings of 1024 numbers (such as the Search Set), or trimmed fixtures already in `contracts/fixtures/wikimapia/` saved through the Place Store. The Development Database is unchanged. No fixture is edited by this feature.

### 3.10 Search Mode (US-11, decision Q6)

- **AC-63 (Exact is the default):** Given any Search Request without a Search Mode, When a search is made, Then it is made in Exact mode: AC-10 holds, and the Search Results are identical to those of the same Search Request with Search Mode Exact given explicitly.
- **AC-64 (Exact mode given explicitly):** Given the Search Set, When the searches of AC-1, AC-13, AC-22 and AC-29 are made with Search Mode Exact given explicitly, Then each returns exactly the Search Results, in the order, stated in that criterion.
- **AC-65 (Approximate stays inside the filters):** Given any search in Approximate mode, When Search Results are returned, Then every one is a Matching Place: a Searchable Place (AC-4) that passes the Spatial Filter (AC-15, AC-23) and the Tag Filter. For example, given the Search Set and a search in Approximate mode with Tag Filter ["museum", "hotel"], Search Centre Point S and Radius 500, every Search Result is Place 102 or Place 101.
- **AC-66 (Approximate keeps the Ranking Order):** Given any search in Approximate mode, When Search Results are returned, Then they are in Ranking Order among themselves, and each Similarity Score is the Place's true Similarity Score with the Query Embedding (within 0.000001), the same value an Exact search would report for that Place. For example, if the search of AC-65 returns both Places, Place 102 (0.95) comes before Place 101 (0.90).
- **AC-67 (Approximate may return fewer):** Given M Matching Places and Result Limit N, When a search is made in Approximate mode, Then at most N Search Results are returned, no Place appears twice, and it is accepted that fewer than the smaller of M and N are returned or that some of the N best Matching Places are missing. This is not a Search Failure, and no message is required about it.
- **AC-68 (Approximate result content):** Given a Place returned in Approximate mode, When its Search Result is examined, Then it carries the same Place ID, Place Name, Wikimapia Link, Result Tag Titles, Centre Point, Distance (with a Radius Filter, as in AC-14) and Similarity Score as the Search Result for the same Place in an Exact search with the same Search Request.
- **AC-69 (Approximate otherwise behaves like Exact):** Given a search in Approximate mode, When there is no Matching Place, Then the Search Outcome is an empty list, not a Search Failure (as in AC-12, AC-19, AC-26, AC-33); and the Query Text is embedded exactly once (AC-2), invalid requests are refused (section 3.7), failures are reported (section 3.8) and the Place Store is unchanged (AC-39), exactly as in Exact mode.

## 4. Business Rules and Assumptions

1. **Filters restrict, meaning ranks.** The Spatial Filter and the Tag Filter decide which Places may be returned; the Similarity Score decides their order. A Place outside the Spatial Filter or the Tag Filter is never returned, whatever its Similarity Score or Search Mode (`.agrules` section 1; AC-15, AC-23, AC-65).
2. **Exactly one Spatial Filter or none (decision R-B).** A Search Request carries a Radius Filter, an Area Filter, or neither. Both together is an Invalid Search Request (AC-48).
3. **Radius Filter on the Centre Point.** The circle is tested against each Place's Centre Point, with the boundary included; Outline Shapes are not used for the circle (AC-16, AC-20). Distance is the WGS 84 surface distance in metres. The Area Filter uses the Outline Shape when there is one, otherwise the Centre Point (decision Q3).
4. **Searchable Places only (decisions R-A, Q5).** Only Detailed Places with an Embedding Record of Embedding Model `voyage-4` that are not marked deleted by Wikimapia can be returned; Embeddings of another model are never compared with the Query Embedding (`.agrules` section 2; AC-4). An Embedding Record older than the current Place Document is still used (AC-11).
5. **One query, one Embedding Service call.** Each valid search embeds the Query Text exactly once, as Document Kind "query", with no retry (decision Q10); search never embeds stored Places (`.agrules` section 1; AC-2, AC-57).
6. **All or nothing.** A search returns either a list of Search Results or one Search Failure. Invalid requests are refused before any call to the Embedding Service or the Place Store (section 3.7).
7. **Read only.** Search never changes the Place Store (AC-39) and never calls Wikimapia.
8. **Deterministic order.** Ranking Order is descending Similarity Score, then ascending Place ID (AC-9). It applies in both Search Modes (AC-66).
9. **Search Mode (decision Q6).** Exact is the default and always returns the true best Matching Places, the smaller of M and N of them (AC-10, AC-63). Approximate is chosen only on request; it may return fewer Places, or miss some of the best ones, when the filters are selective, but never returns a Place outside the filters, never repeats a Place, keeps the Ranking Order and reports true Similarity Scores and Distances (AC-65 to AC-68).
10. **Licensing.** Search Results are Wikimapia-derived data under CC BY-NC-SA 3.0: each carries a Wikimapia Link back to the Place (decision Q1); the Search Command prints a Wikimapia attribution line (AC-42). Search adds no monetization and no bulk export; the Result Limit caps one answer at 50 Places.
11. **Secrets.** `VOYAGE_API_KEY` comes from the environment and never appears in output, failures, tests or the repository (AC-60).
12. **Assumption (later stages):** the LLM Intent Parser, reranking and the search API will call Place Search with a Search Request; a reranking failure there will fall back to the Ranking Order returned here (`.agrules` section 1). Nothing in this feature depends on them.
13. **Documented command form (decision Q11).** The Search Command keeps the name `search` and is documented and shown in its usage message as `pnpm run search "<Query Text>" [options]`. Every place that tells the Developer how to run it uses this form, never `pnpm search` (AC-41, AC-71, AC-72).

## 5. Notes for AL5 (stakeholder wording)

The stakeholder named the operation "a `searchPlaces` function", the spatial tests "`ST_DWithin` on the place centre point, or bbox intersection", the ranking "pgvector cosine distance (`<=>`) using the HNSW index", and asked that the whole search run as "one SQL query". The AL7 command example is `pnpm search "museum" --near 44.817,20.457 --radius 500`, run through `tsx`. **The AL7 wording `pnpm search` is superseded by decision Q11:** in pnpm 10.33 that form is a search of the npm package registry and never reaches the project's command, so the documented form is `pnpm run search "museum" --near 44.817,20.457 --radius 500` (the command keeps the name `search`). Tests "mock Voyage; database tests use the test DB with synthetic 1024-dim vectors". For decision Q6 the stakeholder described Approximate mode as "fast index search, which may return fewer or not-exactly-top results when the filters are selective", and Exact mode as "always the true top-N". These are recorded for AL5 and AL4; the criteria above state only the observable behaviour. AL4 must make sure Exact mode meets AC-10 even when the filters are very selective, which a plain index-ordered search does not guarantee. Approximate mode is where the index-ordered search may be used as is.

Black-box tests of Approximate mode can only check the guarantees of AC-65 to AC-69 (inside the filters, no repeats, at most N, Ranking Order, true scores). They must not require a particular number of results or that a particular Place appears.

AC-72 is about the command as the Developer actually runs it through pnpm, not only about the command's own option handling: a test that calls the command's code directly does not show it. It must run the documented form through pnpm (with the pnpm the project has installed, whatever its version) and check that the answer is the Search Command's usage failure. It needs no database, key or network, because the usage failure comes before any of them (AC-44).

## 6. Stakeholder Decisions

### 6.1 Revision 2 (2026-10-29)

All open questions of revision 1 are resolved. None remain open.

1. **Q1, link and attribution in a Search Result:** **Decided (default accepted): a Search Result carries the stored Wikimapia Link as is** (Listing Link, or Built Link when no Listing Link is stored). The `/ru/{title_slug}` card link and per-card attribution are built by the result cards of Stage 3. Affects AC-35, AC-38, rule 10, scope.
2. **Q2, latitude/longitude order:** **Decided (default accepted): latitude first** on the command line and in Search Results. Affects AC-35, AC-41, glossary "Search Centre".
3. **Q3, meaning of "bbox intersection":** **Decided (default accepted): a Place Lies In the Area when its Outline Shape touches or overlaps the box, or, without an Outline Shape, when its Centre Point is in the box (edge included).** Affects glossary "Lies In the Area", AC-22 to AC-25, AC-30, rule 3.
4. **Q4, Tag Filter matching:** **Decided (default accepted): any one of the listed Tags; only Present Place-Tag Links count; whole titles, ignoring case and spacing at both ends.** Affects AC-27 to AC-34.
5. **Q5, Places marked deleted by Wikimapia:** **Decided (default accepted): not Searchable Places, never returned.** Affects glossary "Searchable Place", AC-4, AC-17, rule 4.
6. **Q6, completeness with selective filters:** **Decided (new choice): a Search Mode parameter.** Exact (the default) always returns the true top results, the smaller of M and N of them, and satisfies every completeness criterion (AC-6 to AC-10). Approximate is a faster search that may return fewer Places or not exactly the top ones when the filters are selective; its results still never fall outside the Spatial Filter or the Tag Filter and are still in Ranking Order. The Search Command gets the flag `--approximate`. Affects glossary "Search Request" and "Search Mode", US-11, AC-2, AC-4, AC-10, AC-14, AC-15, AC-23, AC-39, AC-41, AC-42, AC-44, new AC-63 to AC-71, rules 1, 8 and 9, section 5.
7. **Q7, Result Limit above 50:** **Decided (default accepted): refused as Invalid Search Request**, not lowered. Affects AC-54, glossary "Result Limit".
8. **Q8, input size limits:** **Decided (default accepted): Query Text at most 1,000 characters after trimming; Maximum Radius 50,000 metres.** Affects AC-47, AC-51, glossary "Query Text" and "Maximum Radius".
9. **Q9, Search Command options and output:** **Decided (default accepted):** `--near <lat>,<lon>`, `--radius <metres>`, `--bbox <south>,<west>,<north>,<east>`, `--tag <title>` (repeatable), `--limit <n>`; plain text output with the attribution line, searching the Development Database. With decision Q6, `--approximate` and the `Mode:` line are added. Affects AC-41 to AC-44, AC-71.
10. **Q10, retries when embedding the query:** **Decided (default accepted): no retry**; any Embedding Failure is returned at once as a Query Embedding Failure. Affects AC-57, rule 5.
11. **R-A, only `voyage-4` Embeddings are searchable** (set by the analyst in revision 1 from `.agrules` section 2): **accepted.** Affects glossary "Searchable Place", AC-4, rule 4.
12. **R-B, a Radius Filter and an Area Filter together are invalid** (set by the analyst in revision 1, reading the AL7 "or" as exclusive): **accepted.** Affects glossary "Spatial Filter", AC-48, rule 2.

### 6.2 Revision 3 (2026-10-30) and revision 4 (2026-10-31)

13. **Q11, documented Search Command form:** **Decided: keep the command name `search` and document it as `pnpm run search "<Query Text>" [options]`.** Reason: a bug found at AL1 showed that in pnpm 10.33 `pnpm search ...` is handled by pnpm as a search of the npm package registry, so the form written in AC-41 and AC-71 of revision 2 (`pnpm search "museum" --near 44.817,20.457 --radius 500`) never reached the project's command, while `pnpm run search ...` does. Renaming the command was not chosen. The AL7 wording `pnpm search` is superseded (section 5). Affects scope, facts, glossary "Search Command", US-7, AC-41, AC-71 (command form only; their meaning is unchanged), new AC-72, rule 13, section 5.
14. **Q11 follow-up, AC-72 independent of the pnpm version (2026-10-31, revision 4):** **Decided: AC-72 must not depend on a specific pnpm version.** Its precondition is stated for the pnpm the project has installed, whatever its version; the words "with pnpm 10.33" are removed from it. The pnpm 10.33 finding stays only as background explaining why `pnpm search` does not reach the Search Command (facts, section 5, item 13). The expected result of AC-72 is unchanged. Affects status, numbering note, facts (last item), AC-72 (precondition only), section 5 (AC-72 note).
