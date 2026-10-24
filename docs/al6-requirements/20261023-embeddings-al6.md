# AL6 Requirements: Embeddings

- **Feature:** `embeddings` (Stage 1, substep 4)
- **AL7 source:** `docs/al7-intent/20261023-embeddings-al7.md`
- **Builds on:** `docs/al6-requirements/20261021-storage-al6.md` (the **Storage AL6**, the Place Store), `docs/al6-requirements/20261022-hydration-al6.md` (the **Hydration AL6**, the Crawl) and `docs/al6-requirements/20261022-crawl-run1-fixes-al6.md`. Their glossaries are reused. Criteria of those documents are cited as "Storage AC-n" and "Hydration AC-n". Criteria in this document are numbered AC-1 onwards and always appear without a prefix.
- **Status:** Ready for AL5 Contracts (revision 3). On 2026-10-23 the stakeholder accepted the proposed defaults of all open questions Q1 to Q8, and also the Place Document Layout (rule 2) and the failure handling (rule 8), as written in revision 1 (section 6). The criteria keep their revision 1 numbers and meaning. Revision 3 (2026-10-24) only corrects the order of the Place Documents in AC-18 so that it matches the Embedding Order and AC-25 (section 6, D11).

## 0. Context and Scope

The Crawl fills the Place Store with Places, their Tags and their Comments. Search (Stage 2) needs to find Places by meaning. This feature adds the **Embedding Run**: an offline command that turns every Detailed Place into one Place Document, has the Embedding Service turn that text into an Embedding, and keeps the Embedding with the Place. It is kept separate from the Crawl so the crawled data can be inspected before paying for Embeddings, and so embedding can be rerun on its own (CLAUDE.md, substep 4).

The first real crawl shapes what goes into the Place Document (CLAUDE.md, "Crawled data profile", 80 Detailed Places of `belgrade-small`): descriptions are short (median 23 characters, 21 empty, many only a web address), there are only 4 Comments across 3 Places, and every Place has Tags (69 distinct). Names and Tags carry most of the meaning, so the Place Document combines name, Tag titles, address, cleaned description and Comment messages.

**In scope**

- The Place Document: what goes into it, in what order and in what layout, and how bare web addresses are removed from the description.
- A new Schema Setup step that lets each Place hold one Embedding, with the Embedding Model that produced it, the Document Fingerprint of the text it was made from and the moment it was made, plus an index for nearest-by-meaning lookups using cosine similarity.
- The Embedding Run: choosing which Places need an Embedding, skipping unchanged ones and Summary-Only Places, sending Place Documents to the Embedding Service in Batches within the service's limits, keeping each Batch's Embeddings before sending the next, a configurable Embedding Limit per Run, and a Run Summary (Places embedded, skipped, failed, tokens used).
- Handling failures of the Embedding Service and of the Place Store.
- Running it from the command line (`pnpm embed`).
- Adding the entries `VOYAGE_API_KEY` and `ANTHROPIC_API_KEY` to the project's example environment settings file (`.env.example`).
- Amending Storage AC-5 (as already narrowed by Hydration AC-55) and the Test Database's known starting state so that they allow for Embeddings (R1, section 5).

**Out of scope**

- Embedding search queries and searching by meaning (Stage 2). This feature only stores Embeddings and makes them ready to be searched.
- Embedding single Comments or descriptions on their own. There is exactly one Embedding per Place.
- Any use of the LLM (`ANTHROPIC_API_KEY` is only added to the example settings file, for Stage 2).
- Choosing or switching to another embedding model. Embedding Model `voyage-4` is fixed (CLAUDE.md, Decisions; `.agrules` section 2).
- Running embedding automatically after a Crawl. The Operator starts it.
- Deleting Embeddings. An Embedding is only ever replaced by a newer one for the same Place.
- A Dry Run that only reports what would be embedded (decision Q7).
- Keeping Run Records of Embedding Runs in the database (decision Q6).
- Refusing a second Embedding Run while one is in progress (decision Q8).

**Facts this document relies on**

- The Place Store reads a Place back with Place Name, Tags and Comments (Replies nested), each Tag and Comment carrying a Presence Mark (Present or Gone), Wikimapia's deleted and blocked marks, address items (street, house number, city, place, state, country, each when present) and description, kept exactly as Wikimapia sent them: HTML entities such as `&quot;` are not decoded, line breaks are kept (Storage AC-32, rule 6).
- A Summary-Only Place has no description, Tags or Comments (Storage glossary).
- A Place may have no Tags (crawl-run1-fixes, part A), an empty description (Storage AC-33) or a description that is only a web address.
- Voyage AI `voyage-4` produces Embeddings of 1024 numbers, accepts up to 1,000 texts per request, and is told whether texts are stored documents or search queries; stored Place Documents are sent as "document". The key is `VOYAGE_API_KEY` (CLAUDE.md, Decisions). Voyage reports the number of tokens each request used.
- Voyage also limits the total size (tokens) of one request. Its exact value for `voyage-4` is not in the project documents; AL5 takes it from Voyage's documentation (assumption 9).

## 1. Ubiquitous Language (Domain Glossary)

Terms of the Storage AL6, the Hydration AL6 and the crawl-run1-fixes AL6 keep their meaning, in particular: **Place, Place ID, Place Name, Place Store, Stored Place, Summary-Only Place, Detailed Place, Tag, Place-Tag Link, Comment, Reply, Presence Mark, Present, Gone, Details Save, Details Fetched At, Schema Setup, Test Database, Development Database, Store Failure, Store Unavailable, Operator, Simulated Clock, Run Summary, Clean Stop**. New terms:

| Term | Definition |
|---|---|
| **Embedding** | A list of exactly 1024 numbers that represents the meaning of one Place Document, produced by the Embedding Service. Places with similar meaning have Embeddings that are close by cosine similarity. A Place holds at most one Embedding. |
| **Embedding Service** | Voyage AI, the outside service that turns texts into Embeddings. In tests it is always a Simulated Embedding Service. |
| **Simulated Embedding Service** | A stand-in for the Embedding Service used by every test. It returns deterministic fake Embeddings, reports a stated token count, and can be told to fail. It records what it was asked. |
| **Embedding Model** | The name of the model that produced an Embedding. In this project always `voyage-4`. Kept with every Embedding. |
| **Document Kind** | What the Embedding Service is told about the texts it receives: "document" (stored text) or "query" (a search query). Place Documents are always sent as "document". |
| **Place Document** | The single text made from one Detailed Place for embedding, laid out as in the Place Document Layout. |
| **Place Document Layout** | The fixed order and form of the Parts of a Place Document (rule 2). |
| **Part** | One line of a Place Document: the Name Part, the Tags Part, the Address Part, the Description Part, or one Comment Part. A Part with no content is left out entirely. |
| **Bare Web Address** | In a description, a run of characters without spaces that starts with `http://`, `https://` or `www.` (upper or lower case). Removed from the Description Part (rule 3). |
| **Document Fingerprint** | A short value worked out from the exact text of a Place Document. The same text always gives the same Document Fingerprint; different texts give different ones. Kept with every Embedding so an unchanged Place can be recognised without calling the Embedding Service. |
| **Embedding Record** | What the Place Store keeps about a Place's Embedding: the Embedding, the Embedding Model, the Document Fingerprint and Embedded At. |
| **Embedded At** | The moment (to the second, UTC) at which the Embedding was received from the Embedding Service. |
| **Embedding Run** | One execution of the Embed Command, from start to its Embedding Run Outcome. Called "Run" in this document. |
| **Embed Command** | The command the Operator runs to start an Embedding Run: `pnpm embed`, with optional settings. |
| **Embedding Due** | A Detailed Place whose Place Document is not empty and that has no Embedding Record, or whose Embedding Record has a different Document Fingerprint from its current Place Document, or a different Embedding Model from `voyage-4`. |
| **Unchanged Place** | A Detailed Place whose Embedding Record has the Document Fingerprint of its current Place Document and Embedding Model `voyage-4`. Skipped without calling the Embedding Service. |
| **Empty Document** | A Place Document with no Parts at all. Not sent to the Embedding Service. |
| **Embedding Order** | The order in which a Run handles Places that are Embedding Due: ascending Place ID. |
| **Batch** | The Place Documents sent to the Embedding Service in one request. At most 1,000 Place Documents and never more than the Batch Token Limit. |
| **Batch Token Limit** | The largest total size of one Batch that the Embedding Service accepts. Taken from the Embedding Service's documentation (assumption 9). |
| **Embedding Request** | One request sent to the Embedding Service, retries included. Every Embedding Request counts once. |
| **Embedding Limit** | The largest number of Places one Run may send for embedding. Unchanged Places, Summary-Only Places and Empty Documents do not count towards it. Default 1,000 (decision Q1). |
| **Tokens Used** | The total number of tokens the Embedding Service reported for the successful Embedding Requests of a Run. |
| **Embedding Failure** | A failure of the Embedding Service for one Batch. One of: **Connection Failure** (no answer, or the service reports it is temporarily unavailable), **Service Rate Limit** (the service says too many requests), **Service Refused** (the key is missing at the service, wrong, or the account may not make the request), **Invalid Embedding Answer** (the answer does not hold exactly one Embedding of 1024 finite numbers for each Place Document of the Batch, or cannot be read). |
| **Failed Place** | A Place of a Batch that ended in an Embedding Failure after its retries, or whose Embedding Record the Place Store refused as Invalid Data. It keeps whatever Embedding Record it had before and stays Embedding Due for the next Run. |
| **Embedding Run Outcome** | How a Run ended. Exactly one of: **Completed** (every Place that was Embedding Due at the start was handled); **Limit Reached** (stopped because the Embedding Limit was used up while Places were still Embedding Due); **Rate Limited** (stopped because the Embedding Service kept reporting Service Rate Limit); **Interrupted** (stopped by the Operator, e.g. Ctrl+C); **Failed** (could not run or continue: missing `VOYAGE_API_KEY`, invalid setting, Service Refused, or the Place Store was unavailable). |

## 2. User Stories

- **US-1 (Embed every place):** As an Operator, I want one command that embeds every Detailed Place in the Place Store, so that search can find Places by meaning.
- **US-2 (Use the signal we have):** As the project owner, I want each Place embedded as one text built from its name, Tags, address, cleaned description and Comments, so that the Embedding carries the little meaning the crawled data offers and is not diluted by bare web addresses.
- **US-3 (Pay only for changes):** As the project owner, I want Places whose text has not changed since their last Embedding to be skipped without calling the Embedding Service, so that reruns cost nothing for unchanged data.
- **US-4 (Resume, never redo):** As an Operator, I want a Run that crashed, failed or was stopped to keep every Embedding it already received, and a new Run to continue with what is left, so that no Embedding is paid for twice.
- **US-5 (Stay within limits):** As an Operator, I want Batches that stay within the Embedding Service's limits and an Embedding Limit per Run, so that requests are not rejected and I control how much one Run spends.
- **US-6 (Know what a Run did):** As the project owner, I want every Run to end with a summary of Places embedded, skipped and failed and the tokens used, so that I can follow progress and cost.
- **US-7 (One model, ready for search):** As the search developer (Stage 2), I want every stored Embedding to be 1024 numbers from `voyage-4` made from stored text as "document", recorded with its model name, and indexed for cosine similarity, so that query Embeddings can be compared with Place Embeddings reliably and fast.
- **US-8 (Secrets and licensing):** As the project owner, I want the Embedding Service key read from the environment and never shown, and the Embeddings kept as non-commercial Wikimapia-derived data that is never committed, so that we keep our keys safe and honour CC BY-NC-SA 3.0.
- **US-9 (Verifiable offline):** As a developer, I want the whole feature testable with a Simulated Embedding Service, a Simulated Clock and the Test Database, so that tests make no live calls and cost nothing.

## 3. Acceptance Criteria (BDD Style)

Unless a criterion says otherwise, the setup is as follows. The Embedding Service is a Simulated Embedding Service that answers each Place Document with a deterministic fake Embedding of 1024 numbers and reports a stated token count per request. Time is a Simulated Clock. The Place Store is the Test Database with every Schema Setup step applied, holding no Places and no Embedding Records. `VOYAGE_API_KEY` is a dummy value. Place Documents are written below with `⏎` for a line break.

**Synthetic Place K** (used by several criteria): Place ID 900, a Detailed Place with Place Name "Kalemegdan Park"; Tags "park" (Present), "fortress" (Present) and "garden" (Gone), in that order; address street "Bulevar vojvode Bojovića", city "Belgrade", place "Belgrade", country "Serbia", no house number and no state; description "Old fortress park.⏎See http://example.org/kalemegdan for more."; top-level Comment 1 "Great sunsets" (Present) with Reply 2 "Agreed!" (Present), top-level Comment 3 "Old text" (Gone), and top-level Comment 4 "Spam here" (Present, marked deleted by Wikimapia).

### 3.1 The Place Document (US-2)

- **AC-1 (Layout, full example):** Given Synthetic Place K, When its Place Document is made, Then it is exactly:
  `Kalemegdan Park⏎Tags: park, fortress⏎Address: Bulevar vojvode Bojovića, Belgrade, Serbia⏎Description: Old fortress park. See for more.⏎Comment: Great sunsets⏎Comment: Agreed!`
  with no line break before the first Part or after the last.
- **AC-2 (Order of Parts):** Given any Detailed Place, When its Place Document is made, Then its Parts appear in this order: the Name Part (the Place Name, without a label); the Tags Part (`Tags: ` followed by the titles of the Present Tags in the order the Place Store reads them back, separated by `, `); the Address Part (`Address: ` followed by the present address items in the order street, house number, city, place, state, country, separated by `, `); the Description Part (`Description: ` followed by the cleaned description); then one Comment Part per included Comment or Reply (`Comment: ` followed by its message).
- **AC-3 (Empty Parts left out):** Given a Detailed Place with no Present Tags, no address items, an empty description and no included Comments, When its Place Document is made, Then it is exactly the Place Name, with no `Tags:`, `Address:`, `Description:` or `Comment:` line.
- **AC-4 (Place without Tags):** Given the Place Details of Place 8918979 (`getbyid-belgrade-8918979-no-tags.json`: title "Zoran Đinđić", description "Monument in Belgrade.", no Tags, no Comments) saved in the Place Store, When its Place Document is made, Then it starts with the line `Zoran Đinđić` (letters unchanged), has no Tags Part, has the Description Part `Description: Monument in Belgrade.` and has no Comment Part.
- **AC-5 (Repeated address values once):** Given a Place whose city and place are both "Belgrade", When its Address Part is made, Then "Belgrade" appears once, at the position of the first of them (as in AC-1). Values are compared exactly, character for character.
- **AC-6 (Bare Web Addresses removed):** Given descriptions "See http://example.org/a for more.", "Visit www.Example.org today", "HTTPS://example.org/x" and "Info: https://a.rs/b?c=1, http://d.rs", When their Description Parts are made, Then they read `Description: See for more.`, `Description: Visit today`, nothing (the Part is left out), and `Description: Info:` respectively. Text that only contains "http" or "www" inside a word (for example "awww.") is kept.
- **AC-7 (Description that is only a web address):** Given a Detailed Place whose description is only a Bare Web Address (with or without surrounding spaces and line breaks), When its Place Document is made, Then it has no Description Part.
- **AC-8 (Spacing tidied):** Given a description or Comment message containing line breaks (including carriage return plus line break), tabs or runs of spaces, When its Part is made, Then each run of such spacing becomes a single space, and the Part has no spacing at its start or end. A Part that is empty after this is left out. Place Name, Tag titles and address items are tidied the same way.
- **AC-9 (Text otherwise kept as stored):** Given a description containing HTML entities such as `&quot;` and `&amp;`, Cyrillic letters and Latin letters with diacritics, When its Description Part is made, Then these are kept exactly as stored: entities are not decoded and no letter is changed (decision Q5).
- **AC-10 (Long description kept whole):** Given a Detailed Place whose description is at least 7,000 characters long, When its Place Document is made, Then the Description Part holds the whole cleaned description, not cut.
- **AC-11 (Which Comments are included):** Given Synthetic Place K, When its Place Document is made, Then it includes the messages of Present Comments and Present Replies that Wikimapia has not marked deleted or blocked ("Great sunsets", "Agreed!"), and leaves out Gone Comments ("Old text") and Comments marked deleted or blocked ("Spam here"). A Present Reply of a Gone or deleted Comment is still included (decision Q2).
- **AC-12 (Comment order):** Given a Place with top-level Comments A and B, where A has Replies A1 and A2 and A1 has Reply A1x, When its Place Document is made, Then the Comment Parts appear in the order A, A1, A1x, A2, B: each Comment followed by its Replies at every depth, in the order the Place Store reads them back.
- **AC-13 (Gone Tags left out):** Given Synthetic Place K, When its Place Document is made, Then the Gone Tag "garden" is not in the Tags Part (decision Q2).
- **AC-14 (Bare Web Addresses only removed from descriptions):** Given a Comment message "great photos at http://example.org", When its Comment Part is made, Then it reads `Comment: great photos at http://example.org` (decision Q3).
- **AC-15 (Deleted Places are embedded):** Given a Detailed Place that Wikimapia marked deleted, When a Run handles it, Then its Place Document is made and embedded like any other Detailed Place (decision Q4).
- **AC-16 (Same Place, same text):** Given the same Stored Place, When its Place Document is made several times, Then the text is identical each time, and so is its Document Fingerprint.

### 3.2 Choosing what to embed (US-1, US-3, US-4)

- **AC-17 (Summary-Only Places skipped):** Given the Place Store holds Summary-Only Places 1381893, 62587 and 164369 (from `box-belgrade-page1.json`) and no Detailed Place, When a Run runs, Then no Embedding Request is sent, no Embedding Record is kept, the Run ends Completed, and the Run Summary shows 3 Summary-Only Places skipped and 0 Places embedded.
- **AC-18 (First Run embeds every Detailed Place):** Given Detailed Places 62587 and 1381893 (saved from `getbyid-62587.json` and `getbyid-1381893.json`) and Summary-Only Place 164369, When a Run runs, Then exactly one Embedding Request is sent, with model `voyage-4`, Document Kind "document" and the Place Documents of 62587 and 1381893 in that order (Embedding Order, ascending Place ID). Each of the two Places then has an Embedding Record with the Embedding returned for its own Place Document, Embedding Model `voyage-4`, the Document Fingerprint of that Place Document and Embedded At equal to the Simulated Clock moment the answer was received. Place 164369 has no Embedding Record.
- **AC-19 (Unchanged Places skipped):** Given the Run of AC-18 has ended Completed, When a second Run runs with no change to the Place Store, Then no Embedding Request is sent, both Embedding Records are unchanged (including Embedded At), the Run ends Completed, and the Run Summary shows 0 Places embedded and 2 Unchanged Places skipped.
- **AC-20 (Re-fetched details with no change in text):** Given Place 62587 has an Embedding Record, When its Place Details are saved again with only a later Details Fetched At (Storage AC-22) and a Run runs, Then Place 62587 is an Unchanged Place and is not sent.
- **AC-21 (Changes outside the Place Document do not count):** Given Synthetic Place K has an Embedding Record, When new Place Details are saved for it that differ only in things the Place Document leaves out (a Gone Comment's message, the web address inside the description, the Outline, Location centre or bounds, the Wikipedia link, or a Comment's vote counts), and a Run runs, Then Place 900 is an Unchanged Place and is not sent.
- **AC-22 (Changed text is embedded again):** Given Place 62587 has an Embedding Record, When new Place Details are saved for it that change its Place Document (for example a new Present Comment, a changed description, or a Tag that became Gone) and a Run runs, Then Place 62587 is sent again, and its Embedding Record is replaced by one with the new Embedding, the new Document Fingerprint and a new Embedded At. It still has exactly one Embedding Record.
- **AC-23 (Other Embedding Model is embedded again):** Given Place 62587 has an Embedding Record whose Embedding Model is not `voyage-4` but whose Document Fingerprint matches, When a Run runs, Then Place 62587 is Embedding Due and is sent, and its new Embedding Record carries `voyage-4`.
- **AC-24 (Empty Document not sent):** Given a Detailed Place whose Place Name, Tag titles, address items, description and included Comment messages are all empty after tidying, When a Run runs, Then it is not sent, keeps no Embedding Record, and the Run Summary counts it under "Empty Documents skipped".
- **AC-25 (Embedding Order):** Given Detailed Places 1381893, 300 and 62587 are all Embedding Due, When a Run runs, Then they are sent in the order 300, 62587, 1381893.
- **AC-26 (Embedding kept with the right Place):** Given a Batch of 3 Place Documents for Places 300, 62587 and 1381893, When the Simulated Embedding Service answers with Embeddings E1, E2, E3 (one per Place Document, in the order given), Then Place 300 keeps E1, Place 62587 keeps E2 and Place 1381893 keeps E3. If the answer marks which Place Document each Embedding belongs to, that marking decides, not the position in the answer.

### 3.3 Batches and the Embedding Limit (US-5)

- **AC-27 (At most 1,000 per Batch):** Given 2,500 Detailed Places are Embedding Due and the Embedding Limit is 3,000, When a Run runs, Then exactly 3 Embedding Requests are sent, holding 1,000, 1,000 and 500 Place Documents, in Embedding Order, and all 2,500 Places get an Embedding Record.
- **AC-28 (Batch Token Limit kept):** Given a Batch Token Limit set (for the test) small enough that 5 Embedding Due Place Documents do not fit in one Batch, When a Run runs, Then the Place Documents are split over as many Batches as needed, none of which exceeds the Batch Token Limit or holds more than 1,000 Place Documents, each Place Document is sent in exactly one Batch, and Embedding Order is kept across Batches.
- **AC-29 (Embedding Limit reached):** Given 5 Detailed Places are Embedding Due and the Embedding Limit is 3, When a Run runs, Then only the first 3 in Embedding Order are sent, they get Embedding Records, the Run ends Limit Reached as a Clean Stop, and the Run Summary shows 3 Places embedded and 2 Places still Embedding Due. A next Run with the same limit sends the remaining 2 and ends Completed. With no override, the Embedding Limit is 1,000 (decision Q1).
- **AC-30 (Skipped Places do not use up the limit):** Given 4 Unchanged Places and 2 Embedding Due Places, and an Embedding Limit of 2, When a Run runs, Then both Embedding Due Places are sent and the Run ends Completed.
- **AC-31 (Limit exactly matches):** Given 3 Embedding Due Places and an Embedding Limit of 3, When a Run runs, Then all 3 are sent and the Run ends Completed, not Limit Reached.
- **AC-32 (Failed Places count towards the limit):** Given an Embedding Limit of 3 and a Batch of 3 Places that ends as Failed Places, When the Run continues, Then no further Places are sent and the Run ends Limit Reached.
- **AC-33 (Kept before the next request):** Given a Run with 3 Batches, When the second Embedding Request is sent, Then the Embedding Records of every Place of the first Batch are already kept in the Place Store.

### 3.4 Failures and stops (US-4, US-5)

- **AC-34 (Connection Failure retried):** Given the Simulated Embedding Service answers a Batch's request with a Connection Failure and then normally, When the Run handles it, Then it waits 30 seconds on the Simulated Clock, sends the same Batch again, keeps its Embeddings and counts 2 Embedding Requests.
- **AC-35 (Connection Failure persists):** Given the Simulated Embedding Service answers every request for Batch 1 with a Connection Failure and Batch 2 normally, When the Run runs, Then Batch 1 is sent at most 1 + 2 times, with waits of 30 and then 60 seconds between tries. Its Places become Failed Places with no Embedding Record kept or changed. The Run goes on with Batch 2, whose Embeddings are kept, and ends Completed. A later Run sends Batch 1's Places again.
- **AC-36 (Service Rate Limit):** Given the Simulated Embedding Service answers a request with a Service Rate Limit, When the Run handles it, Then it waits and retries as in AC-34 and AC-35. If the last try is still a Service Rate Limit, the Run sends no further Embedding Request and ends Rate Limited as a Clean Stop. That Batch's Places are not counted as Failed Places, every earlier Batch's Embedding Records are kept, and the next Run starts with those Places.
- **AC-37 (Service Refused):** Given the Simulated Embedding Service answers with Service Refused (for example the key is not accepted), When the Run receives it, Then it sends no further Embedding Request and no retry, keeps every earlier Batch's Embedding Records, and ends Failed with a message saying the Embedding Service refused the request. The message never contains any key value.
- **AC-38 (Invalid Embedding Answer):** Given the Simulated Embedding Service answers a Batch of 3 Place Documents with any of: 2 Embeddings; an Embedding of 1023 or 1025 numbers; an Embedding containing a value that is not a finite number; or an answer that cannot be read, When the Run handles it, Then nothing of that Batch is kept, its 3 Places are Failed Places, the Batch is not retried in this Run, and the Run goes on with the next Batch.
- **AC-39 (Place Store refuses wrong Embeddings):** Given an attempt to keep an Embedding Record whose Embedding does not have exactly 1024 finite numbers, or whose Embedding Model is empty, or that has no Document Fingerprint, When it is kept, Then the Place Store reports Invalid Data and keeps nothing of it; the Place's earlier Embedding Record, if any, is unchanged.
- **AC-40 (Missing key):** Given `VOYAGE_API_KEY` is not set or empty, When a Run starts, Then it ends Failed with a message saying `VOYAGE_API_KEY` is missing, sends no Embedding Request, and changes nothing in the Place Store.
- **AC-41 (Invalid setting):** Given an Embedding Limit that is not a whole number of at least 1, When a Run starts, Then it ends Failed naming the setting, sends no Embedding Request and changes nothing.
- **AC-42 (Place Store unavailable):** Given the Place Store becomes unavailable during a Run, When reading Places or keeping Embedding Records fails with Store Unavailable, Then the Run sends no further Embedding Request and ends Failed. Embedding Records kept before are unchanged. The Run Summary is still shown, without any database password or connection secret.
- **AC-43 (Interrupt):** Given a Run in progress, When the Operator interrupts it, Then no new Embedding Request is started, the Batch in flight is either kept in full or not at all, the Run ends Interrupted with its Run Summary shown, and a next Run continues with the Places still Embedding Due.
- **AC-44 (Crash keeps finished Batches):** Given a Run that is killed after Batch 1's Embedding Records were kept and while Batch 2 was in flight, When a new Run starts, Then Batch 1's Places are Unchanged Places and are not sent, and Batch 2's Places are sent.
- **AC-45 (All or nothing per Place):** Given any Place of a Run, When the Run ends for any reason, Then the Place either has its earlier Embedding Record unchanged, or a complete new one (Embedding, Embedding Model, Document Fingerprint and Embedded At all from the same answer). There is never a mix.

### 3.5 Run Summary and command line (US-6, US-1)

- **AC-46 (Summary contents):** Given any Run, including one ended Failed after it started, When it ends, Then a Run Summary is shown, plain text, one labelled item per line, with: Embedding Run Outcome; start and end moments; Embedding Model; Detailed Places considered; Places embedded (Embedding Records kept in this Run); Unchanged Places skipped; Summary-Only Places skipped; Empty Documents skipped; Failed Places, in total and per Embedding Failure kind (Invalid Data from the Place Store counted as its own kind); Places still Embedding Due at the end; Batches sent; Embedding Requests sent (retries included); Tokens Used. The Run Summary is only shown, not kept in the database (decision Q6).
- **AC-47 (Counts are exact):** Given Detailed Places 300, 62587 and 1381893 Embedding Due, Detailed Place 900 an Unchanged Place, Summary-Only Place 164369, a Batch Token Limit that puts 300 and 62587 in Batch 1 and 1381893 in Batch 2, and the Simulated Embedding Service answering Batch 1 normally with 40 tokens reported and Batch 2 with an Invalid Embedding Answer, When the Run ends, Then the Run Summary shows: Outcome Completed; 4 Detailed Places considered; 2 Places embedded; 1 Unchanged Place skipped; 1 Summary-Only Place skipped; 0 Empty Documents skipped; 1 Failed Place (Invalid Embedding Answer); 1 Place still Embedding Due; 2 Batches sent; 2 Embedding Requests; 40 Tokens Used.
- **AC-48 (Tokens from the service):** Given the Simulated Embedding Service reports 120 tokens for Batch 1 and 75 for Batch 2, When the Run ends, Then Tokens Used is 195. Requests that ended in an Embedding Failure add nothing.
- **AC-49 (Command form):** Given the project is installed, When the Operator runs `pnpm embed`, Then a Run starts with the default settings over all Detailed Places in the Place Store. An option sets the Embedding Limit for that Run (for example `pnpm embed --limit 500`). There is no Dry Run option (decision Q7). An unknown option ends the Run Failed with a usage message and sends nothing.
- **AC-50 (Exit status):** Given a Run ends, When the Operator or the OS scheduler checks how the command ended, Then it reports success for Completed, Limit Reached and Rate Limited, and failure for Failed and Interrupted (as for the Crawl, Hydration AC-61). The command needs no input from a person.
- **AC-51 (No secrets in output):** Given any Run Summary, progress message or failure message, When it is shown, Then it contains no `VOYAGE_API_KEY` or other key value, no database password, and no Commenter IP.
- **AC-52 (Example settings file):** Given the project's example environment settings file (`.env.example`), When it is inspected, Then it has entries `VOYAGE_API_KEY` and `ANTHROPIC_API_KEY` with empty values, besides its existing entries (`WIKIMAPIA_API_KEY`, `DATABASE_URL`) unchanged. No real key value is in the file.

### 3.6 Schema Setup for Embeddings (US-7)

- **AC-53 (New step, earlier steps untouched):** Given a database with every earlier Schema Setup step applied, When this feature's step is applied, Then each Place can hold at most one Embedding Record, its Embedding always exactly 1024 numbers, and every stored Place, Comment, Tag, Place-Tag Link, Crawl Progress entry, Run Record and Failure Record is unchanged. Places start with no Embedding Record.
- **AC-54 (Similarity index):** Given this step has been applied, When the stored structure is inspected, Then there is an index for finding the Embeddings nearest to a given Embedding by cosine similarity, covering every Place's Embedding.
- **AC-55 (Step can be undone):** Given this step has been applied, When it is undone, Then the Embedding storage and its index no longer exist and all other stored data is unchanged. Applying it again succeeds.
- **AC-56 (Embedding Records outlive Details Saves):** Given Place 62587 has an Embedding Record, When any Listing Save or Details Save of Place 62587 happens, Then its Embedding Record is unchanged. Only an Embedding Run replaces it (AC-22).
- **AC-57 (Amended storage checks):** Given every Schema Setup step is applied, including this one, When the storage tests check the stored structure, Then the check of Storage AC-5 (as narrowed by Hydration AC-55, "no place for embeddings or vectors of any kind") is replaced by: "the only place for vectors is the Embedding Record of a Place, 1024 numbers each". The storage and hydration tests still pass with this step applied (R1).
- **AC-58 (Test starting state):** Given any test that uses the Test Database, of this feature or an earlier one, When it starts, Then every Schema Setup step is applied, including this one, and the database holds no Embedding Records besides those the test itself creates (extends Storage AC-61, Hydration AC-57 and crawl-run1-fixes AC-42).

### 3.7 Licensing and tests (US-8, US-9, `.agrules` section 4)

- **AC-59 (No Embeddings in the repository):** Given the repository, When it is inspected, Then it holds no Embeddings produced from Wikimapia data and no bulk Place Documents. Test Embeddings are small, synthetic and deterministic.
- **AC-60 (No live calls):** Given any test of this feature, When it runs, Then every Embedding comes from the Simulated Embedding Service, all waiting uses a Simulated Clock, no real key is used, and no call is made to Voyage AI, Anthropic or Wikimapia.
- **AC-61 (Test Database only):** Given tests that need the database, When they run, Then they use only the Test Database, and the Development Database is unchanged.
- **AC-62 (Fixtures):** Given tests that need real-looking Places, When they run, Then they use the trimmed fixtures already in `contracts/fixtures/wikimapia/` saved through the Place Store, or small synthetic Places such as Synthetic Place K. No fixture is edited by this feature.

## 4. Business Rules and Assumptions

1. **One Place, one Document, one Embedding.** Only Detailed Places are embedded. Each has at most one Embedding Record, replaced only by a newer Embedding of the same Place.
2. **Place Document Layout (accepted by the stakeholder, D9).** Parts in order: Name; `Tags: ` Present Tag titles, `, `-separated; `Address: ` present address items in the order street, house number, city, place, state, country, repeated values once, `, `-separated; `Description: ` cleaned description; one `Comment: ` line per included Comment or Reply, depth first in read-back order. Parts are joined by a single line break. A Part with no content is left out (AC-1 to AC-3, AC-12).
3. **Cleaning.** In the description, each Bare Web Address is removed. In every Part, runs of spacing become one space and the Part is trimmed. Nothing else is changed: no entity decoding (decision Q5), no change of letters, no cutting (AC-6 to AC-10). Comment messages keep their web addresses (decision Q3).
4. **What counts as current.** Only Present Tags and Present Comments and Replies not marked deleted or blocked by Wikimapia go into the Place Document (decision Q2). Places marked deleted by Wikimapia are embedded like others; later stages decide what to show (decision Q4, Storage rule 7).
5. **Skip by fingerprint.** A Place is sent only when its Document Fingerprint or Embedding Model differs from its Embedding Record, or it has none. Unchanged Places cost no request (AC-19 to AC-23).
6. **Resumable by design.** Each Batch's Embedding Records are kept before the next request (AC-33). Since unchanged Places are skipped, a new Run after any stop continues with what is left. No separate progress record is needed.
7. **One model per stored Embedding.** Every Embedding is 1024 numbers from `voyage-4`, produced with Document Kind "document", and records its model (`.agrules` section 2). The Place Store refuses any other length (AC-39). Changing the model means re-embedding everything (CLAUDE.md).
8. **Failures (accepted by the stakeholder, D10).** Connection Failures and Service Rate Limits get 2 extra tries after 30 and 60 seconds. A Service Rate Limit that persists ends the Run as a Clean Stop (Rate Limited). A Connection Failure that persists, or an Invalid Embedding Answer, makes that Batch's Places Failed Places and the Run goes on. Service Refused, a missing key, invalid settings and Store Unavailable end the Run Failed. Failed Places are simply Embedding Due again next Run; no failure history is kept and nothing is parked.
9. **Assumption (Batch Token Limit):** Voyage limits both the number of texts (1,000) and the total tokens per request. AL5 takes the token limit for `voyage-4` from Voyage's documentation and keeps every Batch within it, judging the size of Place Documents before sending. If a single Place Document is longer than the model accepts for one text, AL5 states how it is handled; the expected Place Document sizes (median under 100 characters, a few over 1,000, at most several thousand) are far below that.
10. **Embedding Limit.** Counts Places sent (including those that end as Failed Places), not Places skipped. Default 1,000 (decision Q1). With the crawled data profile (about 50 tokens per Place Document), 1,000 Places cost roughly 50,000 tokens, well inside Voyage's 200M free tokens.
11. **Secrets.** `VOYAGE_API_KEY` comes from the environment and never appears in output, the Place Store, tests or the repository (`.agrules` section 4).
12. **Licensing.** Embeddings and Place Documents are derived from Wikimapia data under CC BY-NC-SA 3.0. They stay non-commercial, are never committed or bulk-exported, and are linked to their Place, which carries its Wikimapia Link for attribution. Sending Place Documents to Voyage AI for embedding is a use the project has already decided on (CLAUDE.md, Decisions).
13. **Concurrent Runs (decision Q8).** Two Runs at the same time are not prevented. Because of AC-45 the Place Store never holds a mixed Embedding Record; the cost is that some Places may be embedded twice.

## 5. Requirements on earlier substeps (for AL5)

- **R1, Schema Setup and storage tests:** a new Schema Setup step adds the Embedding Record of a Place (Embedding of 1024 numbers, Embedding Model, Document Fingerprint, Embedded At) and a cosine-similarity index over Embeddings. As part of this feature, the storage tests' check for Storage AC-5 (as narrowed by Hydration AC-55) is replaced as described in AC-57, and the Test Database's known starting state is extended with "no Embedding Records" (AC-58). The earlier AL6 documents are not edited; this document records the change.
- **R2, Place Store reading:** the Embedding Run needs to read every Detailed Place with what the Place Document uses (Place Name, Tags and Comments with Presence Marks and Wikimapia's deleted and blocked marks, address items, description) together with its Embedding Record, if any, in ascending Place ID, and to keep Embedding Records for a Batch. The existing single-Place read (Storage AC-49) gives the content but not the Embedding Record; AL5 decides how the gap is closed.
- **Notes for AL5 (stakeholder wording):** the stakeholder named the storage "a `vector(1024)` column added by a new migration, with an HNSW cosine index", the fingerprint "a hash of the document text", the client "the `voyageai` npm package", and the command "runnable via tsx (e.g. `pnpm embed`)".

## 6. Stakeholder Decisions (2026-10-23, 2026-10-24)

All open questions of revision 1 are resolved. The stakeholder accepted every proposed default as written. None remain open.

1. **Q1, default Embedding Limit:** **Decided: 1,000 Places per Run** (one full Batch; about 50,000 tokens at the current data profile). Affects AC-29 to AC-32, AC-49, rule 10.
2. **Q2, Gone and deleted content:** **Decided: the Place Document includes only Present Tags and Present Comments and Replies that Wikimapia has not marked deleted or blocked.** Gone Tags, Gone Comments and deleted or blocked Comments are left out. Affects AC-11, AC-13, AC-21, rule 4.
3. **Q3, web addresses in Comments:** **Decided: Bare Web Addresses are removed from the description only**; Comment messages keep them. Affects AC-14, rule 3.
4. **Q4, Places marked deleted by Wikimapia:** **Decided: they are embedded like any other Detailed Place**; search decides what to show. Affects AC-15, rule 4.
5. **Q5, HTML entities:** **Decided: not decoded**; text is kept as stored. Affects AC-9, rule 3.
6. **Q6, keeping Run Records:** **Decided: no**; the Run Summary is only shown, not kept in the database. Affects AC-46 and scope.
7. **Q7, Dry Run:** **Decided: not in this feature.** Affects scope and AC-49.
8. **Q8, one Run at a time:** **Decided: a second Embedding Run is not refused**; it can only cost some double embedding. Affects rule 13 and scope.
9. **D9, Place Document Layout:** the layout of rule 2 (proposed by the analyst in revision 1) is accepted as written. Affects AC-1 to AC-16.
10. **D10, failure handling:** the failure handling of rule 8 (proposed by the analyst in revision 1) is accepted as written. Affects AC-34 to AC-38.
11. **D11, order of Place Documents in AC-18 (2026-10-24, revision 3):** **Decided: AC-18 follows the Embedding Order.** Revision 2 said the Place Documents of 1381893 and 62587 are sent "in that order (Embedding Order)". That contradicted the glossary's Embedding Order (ascending Place ID) and AC-25. Because 62587 is less than 1381893, AC-18 now says the Place Documents of 62587 and 1381893 are sent in that order. No other criterion changed. Affects AC-18 only.
