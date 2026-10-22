# AL6 Requirements: Hydration Jobs (Crawl)

- **Feature:** `hydration` (Stage 1, substep 3)
- **AL7 source:** `docs/al7-intent/20261022-hydration-al7.md`
- **Builds on:** `docs/al6-requirements/20261020-wikimapia-client-al6.md` and `contracts/wikimapia-client.schema.ts` (the Client), `docs/al6-requirements/20261021-storage-al6.md` and `contracts/storage.schema.ts` (the Place Store). Their glossaries are reused.
- **Status:** Ready for AL5 Contracts (revision 2). The stakeholder answered open questions Q1 to Q10 (section 6), and the criteria now include those answers. Criteria AC-1 to AC-65 keep their revision 1 numbers. Criteria added in revision 2 are numbered AC-66 to AC-71 and appear in the sections they belong to.

## 0. Context and Scope

The Client (substep 1) can fetch one Listing Page or one Place's Place Details. The Place Store (substep 2) can save them. This feature adds the **Crawl**: a command the Operator runs, by hand or from the operating system's scheduler, that walks a configured Region through the Client and saves what it gets into the Place Store. It does this in two phases, Listing and then Details. The Crawl can be stopped and resumed at any point, it stays within configured request limits, and it reports how much of the Wikimapia quota it used.

**In scope**

- Two Regions defined in configuration: `belgrade` (Big Belgrade) and `belgrade-small` (a small area of central Belgrade for testing and safe runs).
- The Tile Plan: splitting a Region's Bounding Box into a grid of Tiles.
- Listing Phase: paging through each Tile until a Short Page arrives, and saving every page.
- Details Phase: fetching and saving Place Details for Places that have no details yet or whose details are older than the Refresh Age.
- Saving Crawl Progress in the database, added by a new Schema Setup step, so that a stopped Crawl resumes without repeating Finished Pages.
- Pacing (Minimum Request Interval, by default at most 50 requests per 5 minutes), a Request Budget per Run, and a clean stop when the Client reports Rate Limit Exhausted.
- Dry Run: plan the Tiles only.
- A Run Summary at the end of every Run.
- Running the Crawl from the command line (e.g. `pnpm crawl --region belgrade`).
- Narrowing storage AC-5 and extending the Test Database's known starting state so that they allow for Crawl Progress (requirement R2, section 5).

**Out of scope**

- An in-process scheduler. Repeated runs come from OS cron or Task Scheduler calling the command.
- Deleting or marking Places that no longer appear in listings. They are kept as they are.
- Embeddings (substep 4) and search (Stage 2).
- Changing how the Client handles Rate-Limit Responses. It already waits and retries; this feature only reacts to the Client's results.
- Re-measuring the Wikimapia quota. The stakeholder states the real limit is 100 requests per 5 minutes; the Run Summary lets the project check this in practice.
- Automatic re-listing of a finished Crawl. A new Listing Pass starts only when the Operator asks for one (AC-24).
- Stopping a Run after a number of consecutive Item Failures. Each Item Failure is counted and skipped (rule 6a).

**Facts and gaps in earlier substeps** (checked against the Done artifacts):

- **Client, rate limiting:** when Wikimapia keeps sending Rate-Limit Responses past the Retry Limit, the Client returns the failure kind *Rate Limit Exhausted* with the number of attempts and the last Wait Time. It never throws. Connection Failures, Wikimapia Errors and Unexpected Responses are reported at once, without retrying; the Client AL6 leaves backing off on them to the crawl (Client AL6 rule 2, AC-33). The Client sets no upper limit on a stated Wait Time (Client AL6 rule 4).
- **Client, gap G1 (counting requests and waits):** the Client does not tell its caller how many requests it sent for one call (retries included) or how many Rate-Limit waits it made and for how long. The Run Summary needs these numbers. The Client does accept an injected network stand-in and an injected clock, so the numbers can be observed without changing Client behaviour. This document only requires that the numbers are exact (AC-50 to AC-52). AL5 decides how they are obtained.
- **Place Store, gap G2 (finding Places due for details):** the Place Store can read one Place by its Place ID, but it has no way to list Places that have no details yet, or whose Details Fetched At is older than a given moment, or that lie in a given area. The Details Phase needs exactly that. This feature therefore adds the requirement **"list the Places Due for Details of a Region"** to the Place Store (AC-30 to AC-34).
- **Place Store, gap G3 (crawl progress):** the Place Store has no place for crawl progress. Storage AC-5 even requires that none exists ("no place for crawl progress"), and storage rule 10 says that a later Schema Setup step will add it. The stakeholder asked for the crawl-progress step, so this feature adds it and **requires, as part of this feature, that storage AC-5 is narrowed** to "no place for embeddings". Otherwise the storage tests fail once this feature's step is applied (AC-55). The Test Database's known starting state (storage AC-61) is also extended to "no Crawl Progress and no Run Records" (AC-57). The storage AL6 document itself is not edited; this document is the record of the change (R2, section 5).
- **Place Store, gap G4 (page saved together with its progress):** "never repeats finished pages" holds after a crash only if saving a Listing Page and recording that page as finished succeed or fail together (AC-14). The storage contract's Listing Save is all-or-nothing on its own. Whether the progress record joins that same all-or-nothing step is an AL5/AL4 decision; this document only states the observable result.
- **Recorded fixtures:** `box-belgrade-page1.json` holds 3 Places (1381893, 62587, 164369) with Wikimapia's page size 10 and Total Found 290. It was recorded for the bounding box that is now Region `belgrade-small`. `box-belgrade-empty-page.json` holds none. `getbyid-62587.json`, `getbyid-1381893.json` and `getbyid-55.json` hold details. `debug-rate-limit.json` and `debug-error.json` are Reconstructed Fixtures. No recorded Place Details exist for Place 164369.

## 1. Ubiquitous Language (Domain Glossary)

Terms from the Client AL6 and the storage AL6 keep their meaning: **Place, Place ID, Bounding Box, Listing Page, Place Summary, Place Details, Total Found, Rate-Limit Response, Wait Time, Retry Limit, Fallback Wait Time, Rate Limit Exhausted, Client Failure (and its kinds), Simulated Wikimapia, Simulated Clock, Recorded Response, Reconstructed Fixture, Place Store, Store Failure (and its kinds), Listing Save, Details Save, Save Outcome, Details Fetched At, Summary-Only Place, Detailed Place, Centre Point, Schema Setup, Test Database, Development Database**. New terms:

| Term | Definition |
|---|---|
| **Crawl** | The work of filling the Place Store for one Region: a Listing Phase and then a Details Phase. Resumable across Runs. |
| **Crawl Command** | The command the Operator (or the OS scheduler) runs to start a Run, naming a Region and optional settings, e.g. `pnpm crawl --region belgrade`. |
| **Operator** | The person who runs the Crawl Command, or the OS scheduler that runs it for them. |
| **Run** | One execution of the Crawl Command, from start to its Run Outcome. A Run does the work that is still outstanding for its Region and then stops. |
| **Region** | A named area defined in the Crawl Configuration: a Region Name, a Bounding Box and a Tile Size. The default Crawl Configuration has two Regions: **`belgrade`** ("Big Belgrade") and **`belgrade-small`** (a small area of central Belgrade for testing and safe runs). |
| **Region Name** | The short lower-case name used to pick a Region on the command line, made of letters, digits and hyphens (e.g. `belgrade`, `belgrade-small`). |
| **Crawl Configuration** | The settings a Run uses: the Regions (each with its own Tile Size), Listing Page Size, Refresh Age, Minimum Request Interval and Request Budget. Each setting has a default that the Operator can override. The API Key comes from the environment, as for the Client. |
| **Tile** | One rectangle of the Region's grid, itself a Bounding Box. Each Tile is listed on its own. |
| **Tile Size** | The width (in degrees of longitude) and height (in degrees of latitude) of a Tile. Set per Region. 0.005 by 0.005 degrees by default (about 400 by 550 m in Belgrade). |
| **Tile Plan** | The ordered list of Tiles that covers a Region's Bounding Box exactly, with no gaps and no overlaps beyond shared edges. Tiles in the last column or row are cut back to the Region's edge. The order is west to east within a row, rows from south to north. Each Tile has a Tile Number starting at 1. |
| **Listing Phase** | The first phase of a Run. For every Tile that is not a Finished Tile, ask for its Listing Pages in order, starting after its last Finished Page, and Listing-Save each page, until a Short Page arrives. |
| **Listing Page Size** | The number of Places asked for per Listing Page. 100 by default, the largest Wikimapia allows. |
| **Short Page** | A Listing Page that holds fewer Place Summaries than the Listing Page Size that was asked for, including an empty page. A Short Page is the last page of its Tile. |
| **Finished Page** | A Listing Page of a Tile that has been Listing-Saved and recorded in Crawl Progress. A Finished Page is never asked for again in the same Listing Pass. |
| **Finished Tile** | A Tile whose Short Page has become a Finished Page. |
| **Listing Pass** | One complete walk of a Region's Tile Plan, possibly spread over several Runs. It is complete when every Tile is a Finished Tile. A Region has at most one incomplete Listing Pass. A new Listing Pass starts only when the Operator explicitly asks for one (AC-24). |
| **Crawl Progress** | What the database keeps about Listing Passes: the Region, its Tile Plan, which pages of which Tiles are Finished Pages, and which Run finished each one. It also keeps a Run Record for every Run. Added by a new Schema Setup step. |
| **Run Record** | What Crawl Progress keeps about one Run: Region, start and end moments, Last Activity, Run Outcome and the Run Summary numbers. |
| **Last Activity** | The latest moment at which a Run that is in progress showed in Crawl Progress that it is still alive. Used to tell a live Run from an abandoned one (AC-62, AC-69, AC-70). |
| **Abandonment Age** | How long a Run that is in progress may go without renewing its Last Activity before it counts as abandoned. 1 hour. |
| **Details Phase** | The second phase of a Run. Fetch and Details-Save the Place Details of every Place Due for Details of the Region, in Details Order. |
| **Region Place** | A stored Place whose Centre Point lies inside the Region's Bounding Box, edges included. |
| **Refresh Age** | How old a Place's details may get before they are fetched again. 30 days by default. |
| **Place Due for Details** | A Region Place that is a Summary-Only Place, or a Detailed Place whose Details Fetched At is earlier than the Run's start moment minus the Refresh Age. |
| **Details Order** | Summary-Only Places first, by ascending Place ID. Then Detailed Places, oldest Details Fetched At first, ties by ascending Place ID. |
| **Wikimapia Request** | One request sent to Wikimapia, Client retries included. Every Wikimapia Request counts once. |
| **Wikimapia Quota** | The limit Wikimapia places on requests: 100 Wikimapia Requests per 5 minutes (stakeholder statement). The Crawl uses at most half of it by default. |
| **Minimum Request Interval** | The shortest time allowed between the starts of two consecutive Wikimapia Requests of a Run, Client retries included. 6 seconds by default, which keeps a Run to at most 50 Wikimapia Requests in any 5 minutes, half the Wikimapia Quota. |
| **Request Budget** | The largest number of Wikimapia Requests one Run may send. 500 by default. |
| **Rate-Limit Wait** | One wait the Client makes after a Rate-Limit Response. |
| **Item Failure** | A Client Failure other than Rate Limit Exhausted and Configuration Failure (that is, a Connection Failure, Wikimapia Error, Unexpected Response or Invalid Request), or an Invalid Data Store Failure, met while working on one Listing Page or one Place. The Run counts it, skips that item and goes on (AC-17, AC-36). |
| **Dry Run** | A Run that only works out and reports the Tile Plan. It sends no Wikimapia Request and changes nothing in the database. |
| **Run Outcome** | How a Run ended. Exactly one of: **Completed** (all outstanding work done); **Budget Reached** (stopped because the Request Budget was used up); **Rate Limited** (stopped because the Client reported Rate Limit Exhausted); **Interrupted** (stopped by the Operator, e.g. Ctrl+C); **Planned** (a Dry Run); **Failed** (could not run or continue: unknown Region, invalid Crawl Configuration, missing API Key, a Run already in progress, or the Place Store was unavailable); **Abandoned** (never reported by a Run itself; given to the Run Record of an earlier Run that was found abandoned, AC-69). |
| **Clean Stop** | Ending a Run with every Finished Page and every successful Details Save kept, nothing half-saved, a Run Summary shown and, unless the Place Store is unavailable, a Run Record kept. Budget Reached, Rate Limited and Interrupted are Clean Stops. |
| **Run Summary** | The report shown at the end of every Run (section 3.8). Its numbers are how the project measures the real Wikimapia Quota. |

## 2. User Stories

- **US-1 (Crawl a region):** As an Operator, I want to run one command naming a Region and have every Place in it listed and its details fetched and saved, so that the local index holds the Region without manual steps.
- **US-2 (Grid listing):** As an Operator, I want the Region split into Tiles that are each paged until their last page, so that no part of the Region is skipped and each request covers a manageable area.
- **US-3 (Fresh details):** As an Operator, I want details fetched only for Places that have none yet or whose details are older than the Refresh Age, so that requests go only where they add something.
- **US-4 (Resume, never repeat):** As an Operator, I want a Run that crashed or that I stopped to continue where it stopped, without asking again for pages it already saved, so that no quota is wasted and long crawls can be split over many Runs.
- **US-5 (Repeat on a schedule):** As an Operator, I want running the command again after a finished Crawl to do only refresh work, so that a scheduler can call it regularly and safely.
- **US-6 (Respect Wikimapia):** As the project owner, I want the Crawl to use at most half of the Wikimapia Quota, to stop cleanly when Wikimapia keeps refusing, and never to exceed a Request Budget, so that we stay within the quota and the terms of a free, non-commercial key.
- **US-7 (Safe trial):** As an Operator, I want a small test Region and a Dry Run that shows the Tile Plan without sending any request or changing any data, so that I can check a Region before spending quota on it.
- **US-8 (Measure the quota):** As the project owner, I want every Run to end with exact counts of requests, Rate-Limit Waits and their total seconds, Places listed, details saved and failures, so that we can measure the real Wikimapia Quota and size later crawls.
- **US-9 (Verifiable offline):** As a developer, I want the Crawl to be fully testable with Recorded Responses, Simulated Wikimapia, a Simulated Clock and the Test Database, so that tests make no live calls and need no real waiting.

## 3. Acceptance Criteria (BDD Style)

Unless a criterion says otherwise, the setup is as follows. Wikimapia is a Simulated Wikimapia that answers from `contracts/fixtures/wikimapia/` or from small synthetic pages. Time is a Simulated Clock. The Place Store is the Test Database with Schema Setup applied, holding no Places and no Crawl Progress. The API Key is a dummy value. "Region T" is a synthetic test Region whose Tile Plan the criterion states. Coordinates are given as west, south, east, north, and are compared to within 0.000001 degrees.

### 3.1 Regions and the Tile Plan (US-1, US-2, US-7)

- **AC-1 (Belgrade Regions defined):** Given the default Crawl Configuration, When the Operator asks for its Regions, Then it has exactly these two, each with Tile Size 0.005 by 0.005 degrees: `belgrade` ("Big Belgrade") with Bounding Box west 20.1500, south 44.6500, east 20.7500, north 44.9800; and `belgrade-small` with Bounding Box west 20.452, south 44.814, east 20.462, north 44.820, the central Belgrade area probed on 2026-10-20.
- **AC-2 (Grid covers the Region):** Given Region `belgrade-small` (Bounding Box west 20.452, south 44.814, east 20.462, north 44.820, Tile Size 0.005 by 0.005 degrees), When the Tile Plan is worked out, Then it has exactly 4 Tiles, in this order: (20.452, 44.814, 20.457, 44.819), (20.457, 44.814, 20.462, 44.819), (20.452, 44.819, 20.457, 44.820), (20.457, 44.819, 20.462, 44.820). The Tiles together cover the Region exactly, and the top row is cut back to north 44.820.
- **AC-66 (Big Belgrade Tile Plan):** Given Region `belgrade` with the default Tile Size 0.005 by 0.005 degrees, When the Tile Plan is worked out, Then it has exactly 120 columns and 66 rows, that is 7,920 Tiles, none of them cut back. Tile 1 is (20.150, 44.650, 20.155, 44.655); Tile 120 is (20.745, 44.650, 20.750, 44.655); Tile 121 is (20.150, 44.655, 20.155, 44.660); Tile 7920 is (20.745, 44.975, 20.750, 44.980). No extra thin Tile appears at the east or north edge because of rounding.
- **AC-3 (Region smaller than a Tile):** Given a Region whose Bounding Box is smaller than one Tile in both directions, When the Tile Plan is worked out, Then it has exactly 1 Tile, equal to the Region's Bounding Box.
- **AC-4 (Plan is stable):** Given the same Region and Tile Size, When the Tile Plan is worked out several times, Then it is identical each time: same Tiles, same order, same Tile Numbers.
- **AC-67 (Tile Size is per Region):** Given a Crawl Configuration where Region A has Tile Size 0.005 by 0.005 and Region B has Tile Size 0.01 by 0.01, When the Tile Plans of A and B are worked out, Then each uses its own Region's Tile Size.
- **AC-5 (Unknown Region):** Given the Crawl Configuration has no Region named `atlantis`, When the Operator runs the Crawl Command for `atlantis`, Then the Run ends Failed with a message naming the unknown Region and listing the known Region Names (`belgrade`, `belgrade-small`), no Wikimapia Request is sent, and the database is unchanged.
- **AC-6 (Invalid configuration):** Given a Crawl Configuration where a Region's Bounding Box is not a valid Bounding Box (as defined by the Client), or a Region's Tile Size is not above zero, or the Listing Page Size is outside 1 to 100, or the Refresh Age, Minimum Request Interval or Request Budget is negative or not a number, When a Run starts, Then it ends Failed naming the offending setting, no Wikimapia Request is sent, and the database is unchanged.
- **AC-7 (Missing API Key):** Given no API Key is configured, When a Run that is not a Dry Run starts, Then it ends Failed with a message saying the API Key is missing, no Wikimapia Request is sent, and the database is unchanged. The message never contains any key value.

### 3.2 Dry Run (US-7)

- **AC-8 (Dry Run plans only):** Given Region `belgrade-small` with the default Tile Size, When the Operator runs the Crawl Command for `belgrade-small` in Dry Run mode, Then the Run reports the Region Name, its Bounding Box, the number of Tiles (4) and every Tile with its Tile Number and Bounding Box in plan order. It ends with Run Outcome Planned. Wikimapia receives no request, and the database is unchanged: no Place, no Crawl Progress, no Run Record.
- **AC-68 (Dry Run of Big Belgrade):** Given Region `belgrade` with the default Tile Size, When the Operator runs a Dry Run for `belgrade`, Then the Run reports 7,920 Tiles and their Bounding Boxes as in AC-66, ends Planned, sends no Wikimapia Request and leaves the database unchanged.
- **AC-9 (Dry Run needs no key):** Given no API Key is configured, When the Operator runs a Dry Run, Then it succeeds as in AC-8.
- **AC-10 (Dry Run summary):** Given a Dry Run, When it ends, Then its Run Summary shows 0 Wikimapia Requests, 0 Rate-Limit Waits, 0 seconds waited, 0 Places listed, 0 details saved and 0 failures.

### 3.3 Listing Phase (US-1, US-2, US-4)

- **AC-11 (Single Short Page finishes a Tile):** Given Region T with one Tile, and Simulated Wikimapia answering that Tile's page 1 with the recorded `box-belgrade-page1.json` (3 Places), When a Run's Listing Phase runs, Then exactly one Listing Page request is sent for that Tile: page 1, Listing Page Size 100, the Tile's Bounding Box. Places 1381893, 62587 and 164369 are stored as Summary-Only Places. Page 1 is a Finished Page and the Tile is a Finished Tile.
- **AC-12 (Paging until a Short Page):** Given Region T with one Tile, a Listing Page Size of 3, and Simulated Wikimapia answering page 1 with 3 Places, page 2 with 3 other Places and page 3 with 1 Place, When the Listing Phase runs, Then pages 1, 2 and 3 are asked for in that order, each is Listing-Saved, no page 4 is asked for, all 7 Places are stored, and the Tile is a Finished Tile.
- **AC-13 (Empty page ends a Tile):** Given Region T with one Tile, a Listing Page Size of 3, and Simulated Wikimapia answering page 1 with 3 Places and page 2 with the recorded empty page (`box-belgrade-empty-page.json`), When the Listing Phase runs, Then page 2 is saved as a Finished Page with no Places, no page 3 is asked for, and the Tile is a Finished Tile.
- **AC-14 (Page and progress together):** Given any Listing Page of a Run, When it is handled, Then either its Listing Save succeeded and the page is recorded as a Finished Page, or neither happened. There is never a saved page that is not recorded as finished, nor a page recorded as finished whose Listing Save did not succeed.
- **AC-15 (All Tiles in plan order):** Given Region T with 4 Tiles, each answered with one Short Page, When the Listing Phase runs, Then the Tiles are listed in Tile Number order, one Listing Page request each, and all 4 become Finished Tiles.
- **AC-16 (Place in two Tiles):** Given Region T with 2 Tiles, both of whose Listing Pages contain Place 62587, When the Listing Phase runs, Then Place 62587 is stored once and is counted once in "Places listed" (AC-50). No failure is reported.
- **AC-17 (Failed Listing Page):** Given Region T with 2 Tiles, where Simulated Wikimapia answers Tile 1's page 1 with a Connection Failure every time and Tile 2's page 1 with a Short Page, When the Run runs, Then Tile 1's page 1 is tried at most 1 + 2 times, with waits of 30 and then 60 seconds on the Simulated Clock between the tries. It is then counted as one Item Failure and Tile 1 stays unfinished. The Run goes on to list Tile 2, which becomes a Finished Tile. A later Run asks for Tile 1's page 1 again.
- **AC-18 (Wikimapia Error or Unexpected Response on a page):** Given Simulated Wikimapia answers a Tile's page with a Wikimapia Error (the reconstructed `debug-error.json`) or an Unexpected Response, When the Listing Phase handles it, Then the page is not tried again in this Run. It is counted as one Item Failure, its Tile stays unfinished, and the Run goes on with the next Tile.
- **AC-19 (Details Phase follows listing failures):** Given the Listing Phase of a Run ended with some Tiles unfinished because of Item Failures, When the Listing Phase ends, Then the Details Phase still runs in the same Run.

### 3.4 Resuming and repeating (US-4, US-5)

- **AC-20 (Resume after a stop, mid-Tile):** Given Region T with one Tile, a Listing Page Size of 3, and an earlier Run that stopped (for any reason, including a crash) after pages 1 and 2 became Finished Pages, When a new Run starts for Region T, Then the first Listing Page request is for page 3 of that Tile, and pages 1 and 2 are never asked for again in this Listing Pass.
- **AC-21 (Resume skips Finished Tiles):** Given Region T with 4 Tiles, of which Tiles 1 and 2 are Finished Tiles from an earlier Run, When a new Run starts, Then no request is sent for Tiles 1 or 2, and listing continues with Tile 3.
- **AC-22 (Crash between pages):** Given a Run that stops abruptly (the process is killed) after page 2 of a Tile was saved and recorded, while page 3 was being asked for but before it was saved, When a new Run starts, Then page 3 is asked for (it is not a Finished Page) and page 2 is not.
- **AC-23 (Finished Crawl does only refresh work):** Given Region T whose Listing Pass is complete, and whose stored Places are all Detailed Places fetched less than the Refresh Age ago, When a new Run starts without asking for a new Listing Pass, Then it sends no Listing Page request and no Place Details request, ends Completed, and its Run Summary shows 0 Wikimapia Requests.
- **AC-24 (When listing is done again):** Given Region T whose Listing Pass is complete, When a new Run starts, Then a new Listing Pass begins only if the Operator explicitly asks for one on the Crawl Command (a "relist" option). Otherwise there is no Listing Phase, however old the completed Listing Pass is. A new Listing Pass starts from Tile 1 page 1, and its own Finished Pages are tracked separately from the previous pass.
- **AC-25 (Region definition changed):** Given Region T has an incomplete Listing Pass whose Tile Plan was worked out from a Bounding Box or Tile Size that the Crawl Configuration no longer has, When a new Run starts for Region T without asking for a new Listing Pass, Then it ends Failed. The message says the Region definition changed since the pass started and tells the Operator to start a new Listing Pass explicitly. No Wikimapia Request is sent and the database is unchanged.
- **AC-26 (Regions are independent):** Given two Regions A and B (for example `belgrade` and `belgrade-small`, whose areas overlap), When Runs for A and for B are made, Then each Region's Crawl Progress is kept separately, and finishing a Tile of A never marks anything of B as finished. Places are shared: a Place stored by a Run for A is a Region Place of B if its Centre Point lies in B.
- **AC-27 (Re-running a Run is safe):** Given a Run ended Completed, When the same work is repeated with the same Simulated Wikimapia answers (for example with a new Listing Pass and Refresh Age 0), Then no Place, Comment or Tag is duplicated, and every Listing Save and Details Save reports Unchanged, apart from Details Fetched At advancing (storage AC-22).

### 3.5 Details Phase (US-1, US-3)

- **AC-28 (Details for Summary-Only Places):** Given Places 1381893 and 62587 are stored as Summary-Only Places inside Region T, and Simulated Wikimapia answers with `getbyid-1381893.json` and `getbyid-62587.json`, When the Details Phase runs at Simulated Clock moment 2026-10-22T09:00:00Z, Then exactly two Place Details requests are sent, first for 62587 and then for 1381893 (Details Order: ascending Place ID). Both Places become Detailed Places, and each has Details Fetched At equal to the moment its details were received, to the second, UTC.
- **AC-29 (Details Fetched At is the receive moment):** Given the Simulated Clock reads 2026-10-22T09:00:05Z when Place Details for Place 62587 are received, after Rate-Limit Waits during that request, When they are saved, Then the Details Save carries Details Fetched At 2026-10-22T09:00:05Z.
- **AC-30 (Fresh details skipped):** Given the default Refresh Age of 30 days, a Run starting at 2026-10-22T09:00:00Z, and Region Place 62587 with Details Fetched At 2026-10-01T09:00:00Z, When the Details Phase runs, Then no Place Details request is sent for 62587.
- **AC-31 (Stale details refreshed):** Given the default Refresh Age of 30 days, a Run starting at 2026-10-22T09:00:00Z, and Region Place 62587 with Details Fetched At 2026-09-22T08:59:59Z, When the Details Phase runs, Then its Place Details are requested and saved. Details Fetched At exactly 2026-09-22T09:00:00Z is not stale and is not requested.
- **AC-32 (Configured Refresh Age):** Given the Operator sets Refresh Age to 0, When the Details Phase runs, Then every Region Place whose Details Fetched At is earlier than the Run's start moment is a Place Due for Details.
- **AC-33 (Details Order):** Given due Region Places: Summary-Only 900 and 300, and Detailed 62587 (fetched 2026-08-01T00:00:00Z) and 1381893 (fetched 2026-07-01T00:00:00Z), When the Details Phase runs, Then Place Details are requested in the order 300, 900, 1381893, 62587.
- **AC-34 (Only Region Places):** Given stored Places A, whose Centre Point lies inside Region T's Bounding Box, and B, whose Centre Point lies outside it, both Summary-Only, When the Details Phase of a Run for Region T runs, Then details are requested for A and not for B. A Place whose Centre Point lies exactly on the Region's edge is a Region Place. Whether a Place was found by this Region's Listing Passes does not matter.
- **AC-35 (Details Phase without a complete Listing Pass):** Given a Run's Listing Phase left some Tiles unfinished because of Item Failures, When the Details Phase runs, Then it covers the Places Due for Details among the Places stored so far.
- **AC-36 (Failed Place Details):** Given Simulated Wikimapia answers the details request for Place 900 with a Wikimapia Error, and the request for Place 62587 normally, When the Details Phase runs, Then Place 900 counts as one Item Failure and stays a Place Due for Details for the next Run. Place 62587 is still fetched and saved. A Connection Failure is handled with the same bounded tries and waits as AC-17.
- **AC-37 (Deleted Place saved):** Given Place Details marked deleted by Wikimapia, When the Details Phase handles them, Then they are saved as they are (storage AC-28) and count as a detail saved, not as a failure.
- **AC-38 (Rejected by the Place Store):** Given Place Details that the Place Store reports as Invalid Data (for example `getbyid-62587-nested-replies.json`, where a Reply carries another Place's ID), When the Details Phase handles them, Then they count as one Item Failure, the Run goes on with the next Place, and the Place stays due. The failure shown names the Place ID and the Place Store's reason, without any Commenter IP.

### 3.6 Pacing, Request Budget and rate limiting (US-6)

- **AC-39 (Minimum Request Interval):** Given a Minimum Request Interval of 2 seconds and a Run that sends 5 Wikimapia Requests whose answers come back instantly, When the Run runs, Then on the Simulated Clock every request starts at least 2 seconds after the start of the one before. The interval applies across both phases and to the Client's own retries. The first request of a Run is not delayed.
- **AC-71 (Default pacing is half the Wikimapia Quota):** Given the default Crawl Configuration (Minimum Request Interval 6 seconds) and a Run that sends 60 Wikimapia Requests whose answers come back instantly, some of them Client retries after Rate-Limit Responses of 0 seconds, When the Run runs, Then on the Simulated Clock every request starts at least 6 seconds after the start of the one before, and no span of 300 seconds (5 minutes, the end moment excluded) contains the starts of more than 50 Wikimapia Requests.
- **AC-40 (Interval and slow answers):** Given a Minimum Request Interval of 2 seconds and an answer that takes 3 seconds of Simulated Clock time, When the next request is sent, Then it is not delayed further: the interval counts from the start of the previous request.
- **AC-41 (Request Budget reached):** Given a Request Budget of 3 and a Region whose outstanding work needs more than 3 Wikimapia Requests, When the Run runs, Then it sends exactly 3 Wikimapia Requests and no fourth. It ends with Run Outcome Budget Reached as a Clean Stop. Work done by the 3 requests is saved and recorded, and the next Run continues from there. With no override, the Request Budget is 500.
- **AC-42 (Budget counts Client retries):** Given a Request Budget of 3 and Simulated Wikimapia answering the first request with a Rate-Limit Response (1 second) and then normally, When the Run runs, Then the Client's retry counts as a Wikimapia Request, so only 3 requests are sent in total, the first two of them for the same page.
- **AC-43 (Budget stops inside a retried request):** Given the Request Budget runs out while the Client is retrying a request after a Rate-Limit Response, When the budget is used up, Then no further request is sent. The unfinished page or Place is not counted as saved and not counted as an Item Failure, and the Run ends Budget Reached.
- **AC-44 (Rate Limit Exhausted stops cleanly):** Given the Client reports Rate Limit Exhausted for a Listing Page or Place Details request (Simulated Wikimapia answering every attempt with `debug-rate-limit.json`), When the Run receives it, Then the Run sends no further Wikimapia Request and ends with Run Outcome Rate Limited as a Clean Stop. The page or Place in progress is neither saved nor counted as an Item Failure. Every earlier Finished Page and Details Save is kept, and the next Run resumes with that same page or Place.
- **AC-45 (Clean stops are not failures of the command):** Given a Run ended Rate Limited or Budget Reached, When the OS scheduler checks how the command ended, Then the command reports success (a stop with progress saved is expected), and the Run Summary states the Run Outcome.

### 3.7 Interruption and failures of the whole Run (US-4)

- **AC-46 (Operator interrupt):** Given a Run in progress, When the Operator interrupts it (Ctrl+C, or the scheduler asks it to stop), Then no new Wikimapia Request is started. The page or Place being handled is either fully saved and recorded or not at all. The Run ends Interrupted as a Clean Stop, with its Run Summary shown, and the next Run continues from where it stopped (AC-20).
- **AC-47 (Place Store unavailable):** Given the Place Store becomes unavailable during a Run, When a save or a progress record fails with Store Unavailable, Then the Run sends no further Wikimapia Request and ends Failed. The failed item is not recorded as finished. The Run Summary is still shown, without any database password or connection secret. The command reports failure to the scheduler.
- **AC-48 (Configuration Failure from the Client):** Given the Client reports a Configuration Failure, When the Run receives it, Then the Run ends Failed without further requests.
- **AC-49 (No secrets in output):** Given any Run Summary, progress message or failure message of any Run Outcome, When it is shown or kept, Then it contains no API Key, no request address carrying the key, no database password and no Commenter IP.

### 3.8 Run Summary (US-8)

- **AC-50 (Summary contents):** Given any Run (including Dry Runs and Runs ended Failed after they started), When it ends, Then a Run Summary is shown with: Region Name; Run Outcome; start and end moments; Wikimapia Requests sent (Client retries included); Listing Page requests and Place Details requests (each also counting retries); Rate-Limit Waits made; total seconds of Rate-Limit Waits; Listing Pages saved; Tiles finished in this Run and Tiles still unfinished; Places listed (distinct Place IDs in Listing Pages saved in this Run); Places newly stored by listing (Save Outcome Created); details saved; details that changed (Save Outcome Created or Updated); Places still due for details; Item Failures, both in total and per failure kind.
- **AC-51 (Counts are exact):** Given Region T with 1 Tile answered by `box-belgrade-page1.json` (3 Places, a Short Page), and an empty Place Store; and given that Simulated Wikimapia answers the details request for 1381893 normally on the first attempt, answers the one for 62587 first with a Rate-Limit Response of 7 seconds and then normally, and answers the one for 164369 with a Wikimapia Error; When the Run ends, Then its Run Summary shows: 5 Wikimapia Requests (1 listing, 4 details); 1 Rate-Limit Wait; 7 seconds waited; 1 Listing Page saved; 1 Tile finished; 0 Tiles unfinished; 3 Places listed; 3 Places newly stored; 2 details saved; 1 Item Failure (Wikimapia Error); 1 Place still due; Run Outcome Completed.
- **AC-52 (Waits from fallback):** Given the Client waited its Fallback Wait Time because a Rate-Limit Response gave no readable seconds, When the Run Summary is made, Then that wait is counted with the seconds actually waited.
- **AC-53 (Summary kept):** Given a Run that is not a Dry Run and did not end Failed before it started work, When it ends, Then its Run Record (Region, start and end moments, Run Outcome and all Run Summary numbers) is kept in Crawl Progress, so the Operator can later compare Runs to measure the quota.
- **AC-54 (Summary is readable):** Given any Run Summary, When it is shown, Then it is plain text, one item per line with a label, readable by a non-technical Operator.

### 3.9 Schema Setup for Crawl Progress (US-4)

- **AC-55 (New step, earlier steps untouched):** Given a database with the storage feature's Schema Setup applied, When this feature's Schema Setup step is applied, Then the database can hold Crawl Progress and Run Records, and every stored Place, Comment, Tag and Place-Tag Link is unchanged. As part of this feature, the check of storage AC-5 is narrowed to "no place for embeddings or vectors of any kind", so that the storage tests still pass with this step applied (gap G3, R2).
- **AC-56 (Step can be undone):** Given this step has been applied, When it is undone, Then the Crawl Progress storage no longer exists and the storage feature's data is unchanged. Applying it again succeeds.
- **AC-57 (Test starting state):** Given any test that uses the Test Database, of this feature or of the storage feature, When it starts, Then the Test Database has every Schema Setup step applied, including this feature's, and holds no Crawl Progress and no Run Records besides what the test itself creates. This extends the known starting state of storage AC-61 (gap G3, R2).
- **AC-58 (No Wikimapia content in progress):** Given Crawl Progress, When it is inspected, Then it keeps Region Names, Tile Plans, page numbers, moments and counts only: no Place descriptions, comments or Commenter IPs. Totals reported by Wikimapia (Total Found) may be kept per Tile for information.

### 3.10 Command line and scheduling (US-1, US-5)

- **AC-59 (Command form):** Given the project is installed, When the Operator runs `pnpm crawl --region belgrade` (or `--region belgrade-small`), Then a Run for that Region starts with the default Crawl Configuration. Options on the command line can set Dry Run, start a new Listing Pass (AC-24), and override the Request Budget, Minimum Request Interval and Refresh Age for that Run.
- **AC-60 (Missing Region option):** Given the Operator runs the Crawl Command without naming a Region, When it starts, Then it ends Failed with a usage message listing the known Region Names, and sends nothing.
- **AC-61 (Scheduler friendly):** Given the OS scheduler runs the Crawl Command, When the Run ends, Then the command exits on its own and needs no input from a person. It reports success for Completed, Budget Reached, Rate Limited and Planned, and failure for Failed and Interrupted.
- **AC-62 (One Run per Region at a time):** Given a Run for Region T is in progress and its Last Activity is no more than 1 hour (the Abandonment Age) ago, When a second Run for Region T is started (for example the scheduler fires while a long Run is still working), Then the second Run ends Failed at once with a message that a Run for that Region is already in progress, sends no Wikimapia Request, and changes no Crawl Progress. A Run for a different Region is not blocked.
- **AC-69 (Abandoned Run taken over):** Given a Run Record for Region T that is still in progress (its Run was killed and never ended) and whose Last Activity is more than 1 hour before the Simulated Clock's current moment, When a new Run starts for Region T, Then the new Run goes ahead. The old Run Record is kept with Run Outcome Abandoned and its numbers as last recorded. The new Run resumes from the Crawl Progress as AC-20 to AC-22 describe. A Last Activity exactly 1 hour ago is not abandoned (AC-62 applies).
- **AC-70 (A live Run is never mistaken for abandoned):** Given a Run in progress, When it is working, pacing, or waiting out a Rate-Limit Wait or a Connection Failure back-off of any length, Then it renews its Last Activity at least every 15 minutes on the Simulated Clock. A Run that started 3 hours ago and is still alive is therefore never taken over under AC-69.

### 3.11 Tests (US-9, `.agrules` section 4)

- **AC-63 (No live calls):** Given any test of this feature, When it runs, Then all Wikimapia answers come from Simulated Wikimapia using the trimmed fixtures in `contracts/fixtures/wikimapia/` or small synthetic pages, all waiting (Rate-Limit Waits, Minimum Request Interval, failure back-off) uses a Simulated Clock, no real API Key is used, and no OpenAI call is made.
- **AC-64 (Test Database only):** Given tests that need the database, When they run, Then they use only the Test Database, and the Development Database is unchanged.
- **AC-65 (No bulk data):** Given the tests and the repository, When they are inspected, Then no bulk crawl output is used or committed. Synthetic multi-page listings are built from a handful of synthetic Place Summaries. Tests of the `belgrade` Tile Plan (AC-66, AC-68) check the plan without sending requests for its 7,920 Tiles.

## 4. Business Rules and Assumptions

1. **Order of work within a Run.** The Listing Phase runs first, if a Listing Pass is incomplete or the Operator asked for a new one. The Details Phase runs next. A Run ends after the Details Phase, or earlier on a Clean Stop or a failure.
2. **Short Page rule.** A Tile's paging stops after the first page holding fewer Place Summaries than the Listing Page Size asked for. Total Found is shown for information but is not used to decide when to stop, because Wikimapia's totals are not proven reliable.
3. **Finished Pages are never asked for again** in the same Listing Pass, whether the Run that finished them ended Completed, stopped cleanly or crashed (AC-14, AC-20, AC-22).
4. **Places are never deleted** by the Crawl. A Place that no longer appears in any listing stays stored as it is (AL7 intent).
5. **The Client's rate-limit handling is kept unchanged.** The Crawl adds pacing before requests and a Clean Stop on Rate Limit Exhausted. It never retries, in the same Run, a request the Client gave up on.
6. **Back-off on Connection Failures is the Crawl's job** (Client AL6 rule 2, `.agrules` section 1 "backs off on errors"): 2 extra tries, waiting 30 then 60 seconds. Wikimapia Errors and Unexpected Responses are not retried within the Run.
   - 6a. **Count, skip and go on.** Every Item Failure is counted and skipped, and the Run continues. There is no stop after a number of consecutive Item Failures.
7. **The Request Budget is a hard limit.** It is never exceeded, Client retries included (AC-41 to AC-43). Default 500 per Run.
8. **Half the Wikimapia Quota.** The Wikimapia Quota is 100 requests per 5 minutes. By default the Crawl uses at most 50 per 5 minutes, through a Minimum Request Interval of 6 seconds that also applies to Client retries (AC-39, AC-71). Back-off waits and Rate-Limit Waits only add time between requests.
9. **Measurements are exact, not estimated.** Request and wait counts reflect what was actually sent and waited (gap G1, AC-50 to AC-52).
10. **Licensing.** Everything the Crawl saves is Wikimapia data under CC BY-NC-SA 3.0, kept non-commercial with attribution, through the Place Store. Bulk crawl output is never committed (`.agrules` section 4).
11. **Secrets.** The API Key comes from the environment (`WIKIMAPIA_API_KEY`) and never appears in output, Crawl Progress or tests.
12. **One Run per Region.** A second Run for the same Region is refused while the first is alive. A Run that has not renewed its Last Activity for more than the Abandonment Age (1 hour) counts as abandoned and may be taken over (AC-62, AC-69, AC-70).
13. **What the defaults mean in practice** (estimates for the Operator, not test criteria):
    - `belgrade-small`: 4 Tiles. About 290 Places, so roughly 300 Wikimapia Requests (a few listing pages plus one details request per Place). This fits in one Run within the default Request Budget of 500 and takes at least about 30 minutes at 6 seconds per request.
    - `belgrade`: 7,920 Tiles at the default Tile Size, so at least 7,920 listing requests (one per Tile, more where a Tile has over 100 Places) before any details request. At the default pacing that is at least about 13.2 hours of listing. With the default Request Budget of 500, which takes at least about 50 minutes per Run, the listing alone needs at least 16 Runs. The Details Phase adds one request per Place on top. The number of Places in Big Belgrade is unknown, and the central `belgrade-small` density (about 290 Places in 0.01 by 0.006 degrees) is not representative of the outskirts. The Run Summaries of the first Runs give the real figures. The Operator can give `belgrade` a larger Tile Size in the Crawl Configuration to reduce the number of near-empty Tiles in the outskirts (AC-67), at the cost of more pages for dense Tiles.
14. **Assumption:** Wikimapia's `box` paging returns every Place in a Tile if paged to the end. If some areas turn out to be capped, smaller Tile Sizes are the remedy. Detecting and splitting dense Tiles automatically is not part of this feature.
15. **Assumption:** Edge Places can appear in two neighbouring Tiles, and in two overlapping Regions. That is harmless because Listing Saves are idempotent (AC-16, AC-26).

## 5. Requirements on earlier substeps (for AL5)

- **R1 (gap G2), Place Store:** list the Places Due for Details of a Region (Region Places by Centre Point inside a Bounding Box, edges included, Summary-Only or with Details Fetched At before a given moment), in Details Order.
- **R2 (gap G3), Schema Setup, accepted by the stakeholder as part of this feature:** a new step for Crawl Progress and Run Records. As part of this feature, the storage tests' check for storage AC-5 is narrowed to "no place for embeddings or vectors of any kind", and the Test Database's known starting state (storage AC-61) is extended with "no Crawl Progress and no Run Records" (AC-55, AC-57). The storage AL6 document is left as it is; this requirement records the change.
- **R3 (gap G4):** a Listing Save and the recording of that Finished Page succeed or fail together (AC-14).
- **R4 (gap G1), Client observation:** the Run can count every Wikimapia Request and every Rate-Limit Wait with its seconds, and can apply the Minimum Request Interval and Request Budget to the Client's own retries. The Client's behaviour as specified in its AL6 does not change.

## 6. Stakeholder Decisions (revision 2)

All open questions of revision 1 are resolved.

1. **Q1, Regions:** two Regions. `belgrade` is Big Belgrade, west 20.1500, south 44.6500, east 20.7500, north 44.9800. The bbox probed earlier (west 20.452, south 44.814, east 20.462, north 44.820) is kept as a separate small Region for testing and safe runs, `belgrade-small` (AC-1, AC-2, AC-66, AC-68).
2. **Q2, Tile Size:** per Region, 0.005 by 0.005 degrees by default. This gives 4 Tiles for `belgrade-small` and 7,920 Tiles (120 by 66) for `belgrade` (AC-2, AC-66, AC-67, rule 13).
3. **Q3, Places covered by the Details Phase:** Places whose Centre Point lies inside the Region's Bounding Box, edges included (AC-34).
4. **Q4, Re-listing a finished Crawl:** only when the Operator explicitly asks for a new Listing Pass; never automatically (AC-23, AC-24).
5. **Q5, Refresh Age:** 30 days by default (AC-30, AC-31).
6. **Q6, Run Records:** every Run's summary numbers are kept in the database (AC-53).
7. **Q7, Pacing and budget:** Wikimapia's real limit is 100 requests per 5 minutes. The Crawl uses 50% of it, at most 50 requests per 5 minutes, through a default Minimum Request Interval of 6 seconds, Client retries included (AC-71, rule 8). The Request Budget per Run stays configurable, 500 by default (AC-41).
8. **Q8, Item Failures:** count, skip and go on for Wikimapia Errors, Unexpected Responses and Invalid Data. Connection Failures get 2 extra tries after 30 and 60 seconds. No stop after consecutive Item Failures (AC-17, AC-18, AC-36, rule 6).
9. **Q9, Interrupted:** reported to the scheduler as not successful (AC-61).
10. **Q10, Overlapping Runs:** a second Run for a Region with a live Run is refused. A Run counts as abandoned once it has recorded no activity for 1 hour, and a new Run may then take over (AC-62, AC-69, AC-70).
11. **Gaps G1 to G4** stand as recorded in section 0. The crawl-progress Schema Setup step, the narrowing of storage AC-5 and the extension of the Test Database's starting state are part of this feature (R2).
