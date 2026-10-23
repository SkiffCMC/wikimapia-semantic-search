# AL6 Requirements: Crawl Run 1 Fixes

- **Feature:** `crawl-run1-fixes` (Stage 1, a change to substeps 1 and 3)
- **AL7 source:** `docs/al7-intent/20261022-crawl-run1-fixes-al7.md`
- **Changes the baseline of:** `docs/al6-requirements/20261020-wikimapia-client-al6.md` (the **Client AL6**) and `docs/al6-requirements/20261022-hydration-al6.md` (the **Hydration AL6**). Both are already implemented. Their documents are not edited: this document records each change and cites the affected criteria as "Client AC-n" and "Hydration AC-n" (section 5). Criteria in this document are numbered AC-1 onwards and always appear without a prefix.
- **Status:** Ready for AL5 Contracts. The stakeholder answered all open questions on 2026-10-22 (section 6). Decision Q10 overrode the earlier proposed default: a Tags item present with the value "null" is now treated like a missing Tags item (AC-3, AC-4).

## 0. Context and Scope

The first real Crawl, Run 1 of Region `belgrade-small` on 2026-10-22, found three problems:

- **A. Missing Tags.** For a Place with no Tags, Wikimapia leaves the Tags item out of the Place Details answer entirely, rather than sending an empty list. The Client reports this as an Unexpected Response, so such Places can never be saved. Recorded examples: Places 1391132 and 8918979.
- **B. Key Quota.** After about 90 requests in about 9 minutes (one request every 6 seconds), every Wikimapia answer was an apparently successful answer whose body is `{"debug":{"code":1004,"message":"Key limit has been reached"}}`. The block was still in force after the Run ended. The Client reports this as a Wikimapia Error. The Crawl therefore counted it as an Item Failure for each Place and carried on, which wasted 112 Wikimapia Requests.
- **C. Failures are not kept.** Item Failures are only shown in the Run's output. The project wants them kept, and wants a Place that keeps failing in the same way to be set aside until the Operator explicitly asks for it to be tried again.

**In scope**

- Client: treat a missing Tags item, or a Tags item with the value "null", as an empty list of Tags (part A).
- Client: recognise the Key Quota Response and report it as a separate Client Failure kind, Key Quota Exhausted, with no retry and no wait (part B).
- Crawl: stop the Run cleanly as soon as Key Quota Exhausted is reported. Progress is saved, and the Place or page is not counted as an Item Failure (part B).
- Crawl: keep a Failure Record for every Item Failure (part C).
- Crawl: Park a Place after 3 counted Item Failures of the same kind, and release it again only on an Explicit Retry (part C).
- The test fixtures needed for these changes: two new Recorded Responses and one new Reconstructed Fixture.

**Out of scope**

- The reset window of the Key Quota. It is unknown: it may be hourly, daily or something else. Nothing in this feature assumes a length, waits for the quota to reset, or schedules a later Run.
- Changing the pacing defaults (Minimum Request Interval 6 seconds, Request Budget 500) (decision Q11). Run 1 shows that the Key Quota was reached well below the "100 requests per 5 minutes" stakeholder statement in the Hydration AL6. Re-sizing Runs to fit the Key Quota is a separate decision, to be taken once the reset window is known.
- Stopping a Run after a number of consecutive Item Failures. This stays out of scope as in the Hydration AL6. Parking acts on single Places across Runs and never stops a Run.
- Any change to how Rate-Limit Responses ("wait N seconds") are handled.
- Releasing a single Parked Place by Place ID, and releasing Parked Places without running a Crawl (a separate release command) (decision Q5).
- A retention limit for Failure Records (decision Q9).
- Recognising a Key Quota Response by its message text alone (decision Q8).

**Evidence this document relies on**

- `data/recordings/getbyid-belgrade-1391132-no-tags.json`: the real `place.getbyid` answer for Place 1391132, recorded during Run 1. It has no Tags item. Its Wikipedia item is present but empty text. Other values: title "Kolarac - Peoples' University and Concert Hall"; marked as a building; not a region; not deleted; parent id "0"; Outline of 16 points; Location centre longitude 20.456339 and latitude 44.8191407; street "Studentski Trg"; no Comments.
- `data/recordings/getbyid-belgrade-8918979-no-tags.json`: the real answer for Place 8918979. It has no Tags item and no Wikipedia item at all. Other values: title "Zoran Đinđić"; description "Monument in Belgrade."; not a building; not a region; not deleted; parent id "0"; Outline of 4 points; Location centre longitude 20.4612287 and latitude 44.8164264; street "Trg Republike"; no Comments.
- Both Places have their Centre Point inside Region `belgrade-small` (west 20.452, south 44.814, east 20.462, north 44.820).
- CLAUDE.md, Wikimapia API Reference, notes "Key quota" and "`tags` is omitted". **No Key Quota Response has been recorded as a file.** The exact body quoted above (in the AL7 and in CLAUDE.md) is the only evidence.
- The existing fixtures in `contracts/fixtures/wikimapia/` and their `README.md`. In particular, `debug-error.json` (message "Invalid API key.", with no code) is the reconstructed non-rate-limit Wikimapia Error, and `debug-rate-limit.json` is the reconstructed Rate-Limit Response.

## 1. Ubiquitous Language (Domain Glossary)

All terms of the Client AL6 and the Hydration AL6 keep their meaning unless this table changes them, in particular: **Place, Place ID, Place Details, Tag, Wikimapia Client (the Client), Client Failure (and its kinds), Rate-Limit Response, Retry, Retry Limit, Rate Limit Exhausted, Wikimapia Error, Connection Failure, Unexpected Response, Recorded Response, Reconstructed Fixture, Simulated Wikimapia, Simulated Clock, Crawl, Crawl Command, Operator, Run, Region, Region Place, Listing Phase, Details Phase, Place Due for Details, Details Order, Wikimapia Request, Wikimapia Quota, Request Budget, Item Failure, Run Outcome, Clean Stop, Run Summary, Run Record, Crawl Progress, Schema Setup, Test Database, Place Store, Details Save, Place-Tag Link, Present, Gone**.

| Term | Definition |
|---|---|
| **Tags (amended)** | In Place Details, the list of Tags of the Place. It may be empty. When Wikimapia leaves the Tags item out of its answer, or sends it with the value "null", the Client reports an empty list of Tags (part A, decision Q10). |
| **Key Quota** | A limit Wikimapia places on the total number of requests made with one API Key over a period whose length is unknown. It is separate from the "wait N seconds" Rate-Limit Response and from the Wikimapia Quota (requests per 5 minutes) of the Hydration AL6. Once reached, it stays in force for every request, even across Runs, until Wikimapia resets it. |
| **Key Quota Response** | An apparently successful answer from Wikimapia that carries no data. Instead it carries a `debug` part with the code 1004 (observed message: "Key limit has been reached"). It is recognised by that code alone (rule 3, decision Q8). |
| **Key Quota Exhausted** | A new kind of Client Failure: Wikimapia answered with a Key Quota Response. It carries Wikimapia's message text and the code 1004. The Client never retries it and never waits for it. |
| **Wikimapia Error (amended)** | A kind of Client Failure: Wikimapia answered with an error message that is neither a Rate-Limit Response nor a Key Quota Response. It carries Wikimapia's message text. |
| **Quota Exhausted (Run Outcome)** | A new Run Outcome: the Run stopped because the Client reported Key Quota Exhausted. It is a Clean Stop and is reported to the scheduler as success (decision Q7). |
| **Failure Record** | What Crawl Progress keeps about one Item Failure: the Run in which it happened, the failed item (a Place ID, or for a Listing Page the Tile Number and Page Number), the failure kind, the failure message as shown to the Operator, and the moment the failure was concluded. Failure Records are kept for good (decision Q9). |
| **Counted Failure** | A Failure Record that counts towards Parking. It must be about a Place (not a Listing Page), of a kind that counts (every Item Failure kind except Connection Failure, decision Q3), and later than the Place's Count Reset. |
| **Count Reset** | The latest of these moments for a Place: its most recent successful Details Save, and its most recent Explicit Retry (decision Q2). Only Failure Records after the Count Reset are Counted Failures. A Place that has neither has no Count Reset, and all its Failure Records can count. |
| **Parking Threshold** | The number of Counted Failures of one and the same kind that makes a Place a Parked Place: 3. They need not be consecutive (decision Q2). |
| **Parked Place** | A Place with at least the Parking Threshold of Counted Failures of one and the same kind. It is not a Place Due for Details, whatever its age or details, until it is released by an Explicit Retry. Parking belongs to the Place, not to a Region or a Run (decision Q1). |
| **Explicit Retry** | An Operator request, made as an option on the Crawl Command for a Region, that releases every Parked Place among the Region Places at the start of that Run. It sets the Count Reset of each released Place to the Run's start moment. It is the only way to release a Parked Place (decision Q5). |
| **Place Due for Details (amended)** | A Region Place that is not a Parked Place and is either a Summary-Only Place or a Detailed Place whose Details Fetched At is earlier than the Run's start moment minus the Refresh Age. |

## 2. User Stories

- **US-1 (Places without Tags):** As an Operator, I want Places that Wikimapia sends without any Tags to be fetched and saved like every other Place, so that real Places are not lost to a failure that is not a failure.
- **US-2 (Stop on the Key Quota):** As the project owner, I want the Crawl to recognise that the API Key's quota is used up and to stop the Run at once with its progress saved, so that no requests are wasted on answers that cannot succeed and the next Run starts where this one stopped.
- **US-3 (Tell quota from errors):** As an Operator, I want a used-up Key Quota reported as its own kind of failure and Run Outcome, separate from rate limiting and from Place errors, so that I can see in the Run Summary why a Run stopped and plan the next Runs.
- **US-4 (Keep failures):** As an Operator, I want every Item Failure kept with its Run, item, kind, message and moment, so that I can look into failures after the Run's output is gone and compare Runs.
- **US-5 (Stop hammering broken Places):** As the project owner, I want a Place that has failed 3 times in the same way to be set aside, so that scheduled Runs do not spend quota on it again and again.
- **US-6 (Try again on purpose):** As an Operator, I want to release the set-aside Places of a Region on purpose, so that they are tried again after the cause has been fixed (for example after a Client fix like part A).
- **US-7 (Verifiable from recordings):** As a developer, I want these fixes covered by failing tests built from the Run 1 recordings before any code changes, so that the bugs are proven and stay fixed (`.agrules` section 0, "Triggered Bugfixing").

## 3. Acceptance Criteria (BDD Style)

Unless a criterion says otherwise, the setup is the same as in the Client AL6 (for Client criteria) and in the Hydration AL6 (for Crawl criteria). Wikimapia is a Simulated Wikimapia answering from `contracts/fixtures/wikimapia/`. Time is a Simulated Clock. The Place Store is the Test Database, which holds no Places, no Crawl Progress and no Failure Records. The API Key is a dummy value. "Region T" is a synthetic test Region whose Tile Plan the criterion states. "The Key Quota fixture" is the Reconstructed Fixture of AC-44.

### 3.1 Part A: Places without Tags (Client) (US-1, US-7)

- **AC-1 (Recorded Place without Tags, empty Wikipedia link):** Given Simulated Wikimapia answers with the recorded details of Place 1391132 (`getbyid-belgrade-1391132-no-tags.json`, as a fixture per AC-43), When the Operator asks for the Place Details of Place ID 1391132, Then the Client reports no failure and returns:
  - Place ID 1391132, title "Kolarac - Peoples' University and Concert Hall", and the description text unchanged;
  - an empty list of Tags;
  - marked as a building, not a region and not deleted, with no Parent Place ID;
  - no Wikipedia link: Wikimapia sent empty text, and empty text is reported as absent (Client AC-13);
  - an Outline of 16 points, and a Location with centre longitude 20.456339, latitude 44.8191407 and street "Studentski Trg";
  - an empty list of Comments.
- **AC-2 (Recorded Place without Tags or Wikipedia item):** Given Simulated Wikimapia answers with the recorded details of Place 8918979 (`getbyid-belgrade-8918979-no-tags.json`, as a fixture per AC-43), When the Operator asks for its Place Details, Then the Client reports no failure and returns:
  - Place ID 8918979, title "Zoran Đinđić" exactly as sent (letters Đ, đ and ć unchanged), and description "Monument in Belgrade.";
  - an empty list of Tags;
  - not a building, not a region and not deleted, with no Parent Place ID;
  - no Wikipedia link;
  - an Outline of 4 points, and a Location with centre longitude 20.4612287, latitude 44.8164264 and street "Trg Republike";
  - an empty list of Comments.
- **AC-3 (Missing, null and empty Tags are the same):** Given the recorded details of Place 8918979 (Tags item missing), a variant of them that differs only by an added empty Tags list, and a variant that differs only by an added Tags item with the value "null", When the Client returns the Place Details for each, Then it reports no failure for any of them and the three results are identical, each with an empty list of Tags (decision Q10).
- **AC-4 (Tags still checked when present with a value):** Given Place Details in which the Tags item is present with a value of the wrong kind (for example text or a number instead of a list, or a list holding a Tag without a title or with an id that is not a whole number), When the Operator asks for the Place Details, Then the Client reports an Unexpected Response naming the Tags item, as in Client AC-35. The value "null" is not a wrong kind: it is handled as in AC-3.
- **AC-5 (Other required items unchanged):** Given the recorded details of Place 1391132 with its title removed, When the Operator asks for the Place Details, Then the Client still reports an Unexpected Response naming the title (Client AC-35). Only the Tags item has become optional.

### 3.2 Part A: Places without Tags (Crawl) (US-1, US-7)

- **AC-6 (Run 1 regression, details saved):** Given Places 1391132 and 8918979 are stored as Summary-Only Places inside Region T, and Simulated Wikimapia answers their details requests with the two recordings of AC-1 and AC-2, When the Details Phase runs, Then:
  - exactly two Place Details requests are sent, first for 1391132 and then for 8918979 (Details Order);
  - both become Detailed Places with no Place-Tag Links, and 1391132 reads back with no Wikipedia link;
  - the Run Summary shows 2 details saved and 0 Item Failures;
  - no Failure Record is kept.
- **AC-7 (Tags disappearing become Gone):** Given Place 1381893 was saved from `getbyid-1381893.json` with Tag 194 "park" Present, When Place Details for 1381893 are saved from a variant of that fixture with the Tags item removed, Then the Place's link to Tag 194 reads back as Gone (not erased), Tag 194 stays in the Tag Catalogue, and the Save Outcome is Updated. The same holds for a variant with the Tags item set to "null". This follows the Place Store's existing Gone rule, because a missing or "null" Tags item means "no Tags now".

### 3.3 Part B: Key Quota (Client) (US-2, US-3, US-7)

- **AC-8 (Key Quota recognised, Place Details):** Given Simulated Wikimapia answers a Place Details request with the Key Quota fixture (success status, body `{"debug":{"code":1004,"message":"Key limit has been reached"}}`), When the Operator asks for the Place Details of any valid Place ID, Then:
  - the Client reports Key Quota Exhausted, carrying Wikimapia's message text "Key limit has been reached" and the code 1004;
  - exactly 1 request was sent;
  - no time passed on the Simulated Clock.
- **AC-9 (Key Quota recognised, Listing Page):** Given the same answer to a Listing Page request, When the Operator asks for any valid Listing Page, Then the result is as in AC-8.
- **AC-10 (Not another kind):** Given a Key Quota Response, When the Client handles it, Then it is not treated as a Rate-Limit Response (no wait, no Retry, never Rate Limit Exhausted), and it is not reported as a Wikimapia Error or an Unexpected Response. It is never returned as a Listing Page or as Place Details.
- **AC-11 (Key Quota during Rate-Limit Retries):** Given Simulated Wikimapia answers a request first with a Rate-Limit Response of 7 seconds (`debug-rate-limit.json`) and then with the Key Quota fixture, When the Operator makes that request, Then:
  - the Client waits 7 seconds on the Simulated Clock and sends exactly 2 requests;
  - it reports Key Quota Exhausted, not Rate Limit Exhausted;
  - it makes no further Retry, although the Retry Limit is not used up.
- **AC-12 (Recognised by the code):** Given an answer with a `debug` part carrying code 1004 and a message other than "Key limit has been reached" (for example an empty message, or "You have reached the limit for this action. You need to wait for 7 seconds."), When the Client handles it, Then it reports Key Quota Exhausted with the message text as sent. The code takes precedence over the wording of the message (decision Q8).
- **AC-13 (Other `debug` answers unchanged):** Given any of these answers, When the Operator makes a request, Then the Client reports a Wikimapia Error carrying Wikimapia's message text and does not retry (Client AC-32 as amended):
  - `debug-error.json` (message "Invalid API key.", no code);
  - the Key Quota fixture with its code changed to 1003;
  - the Key Quota fixture with its code removed, so that only the message "Key limit has been reached" remains (decision Q8: the message alone is not enough).
  Given `debug-rate-limit.json` (no code), Then Client AC-22 to AC-28 still hold unchanged.
- **AC-14 (No secrets):** Given a Key Quota Exhausted failure, When it is reported, Then neither the API Key nor any request address containing it appears in its message or details (Client AC-36 applies to the new kind).

### 3.4 Part B: Key Quota (Crawl) (US-2, US-3, US-7)

- **AC-15 (Clean stop in the Details Phase):** Given Places 300, 900 and 1381893 are stored as Summary-Only Places inside Region T, Region T's Listing Pass is complete, and Simulated Wikimapia answers the details request for 300 normally and every later request with the Key Quota fixture, When a Run runs, Then:
  - exactly 2 Wikimapia Requests are sent (300, then 900), and no request for 1381893;
  - Place 300 is saved as a Detailed Place;
  - Place 900 is not saved, is not counted as an Item Failure, gets no Failure Record, and stays a Place Due for Details;
  - the Run ends with Run Outcome Quota Exhausted as a Clean Stop, and its Run Record is kept with that outcome.
- **AC-16 (Clean stop in the Listing Phase):** Given Region T with 2 Tiles and no Places stored, and Simulated Wikimapia answering Tile 1's page 1 with the Key Quota fixture, When a Run runs, Then:
  - exactly 1 Wikimapia Request is sent;
  - Tile 1's page 1 is not a Finished Page;
  - no request is sent for Tile 2, and no Details Phase runs;
  - there is no Item Failure and no Failure Record;
  - the Run ends Quota Exhausted.
  When a later Run starts and Wikimapia answers normally, its first Wikimapia Request is for Tile 1's page 1.
- **AC-17 (Run 1 regression, no wasted requests):** Given 112 Summary-Only Places are due in Region T, and Simulated Wikimapia answers every request with the Key Quota fixture, When a Run runs, Then exactly 1 Wikimapia Request is sent and the Run ends Quota Exhausted with 0 Item Failures. When a second Run starts while the quota is still exhausted, Then it too sends exactly 1 Wikimapia Request and ends Quota Exhausted. No Run waits for the Key Quota to reset (its reset window is unknown).
- **AC-18 (Counted like any request):** Given a Run that ended Quota Exhausted, When its Run Summary is made, Then the request that received the Key Quota Response is counted in Wikimapia Requests (and in Listing Page or Place Details requests), and it counts towards the Request Budget. The Summary states Run Outcome "Quota Exhausted" and shows Wikimapia's message text.
- **AC-19 (Reported as success to the scheduler):** Given a Run ended Quota Exhausted, When the OS scheduler checks how the command ended, Then the command reports success, as for Rate Limited and Budget Reached (Hydration AC-45 and AC-61 as amended; decision Q7).
- **AC-20 (Interaction with other stops):** Given the Client reports Key Quota Exhausted, When the Run receives it, Then the Run sends no further Wikimapia Request: no Connection Failure back-off tries, and no further Places or pages. The Run's Last Activity and Run Record are written as for any Clean Stop.

### 3.5 Part C: Failure Records (US-4)

- **AC-21 (One Failure Record per Item Failure):** Given a Run that is not a Dry Run, When an Item Failure is met on a Place or a Listing Page, Then exactly one Failure Record is kept, holding:
  - the Run (the Run Record it belongs to);
  - the failed item: a Place ID, or a Tile Number and Page Number (decision Q6);
  - the failure kind;
  - the failure message exactly as shown in the Run's output;
  - the moment the failure was concluded, from the Simulated Clock, to the second, UTC.
- **AC-22 (Hydration Run Summary scenario):** Given the scenario of Hydration AC-51, where the details request for 164369 is answered with `debug-error.json` at Simulated Clock moment M, When the Run ends, Then exactly 1 Failure Record exists. It is for Place 164369, belongs to this Run, has kind Wikimapia Error, holds a message naming Place 164369 and containing "Invalid API key.", and has moment M. All Run Summary numbers of Hydration AC-51 are unchanged.
- **AC-23 (Connection Failure tries are one record):** Given the scenario of Hydration AC-17, where Tile 1's page 1 fails with a Connection Failure on all 1 + 2 tries, When the Run ends, Then exactly 1 Failure Record exists for Tile 1, page 1, with kind Connection Failure, and its moment is the moment of the last try.
- **AC-24 (What is not recorded):** Given a Run in which the Client reports Rate Limit Exhausted, Key Quota Exhausted or a Configuration Failure, or the Request Budget is reached during a request, or the Operator interrupts the Run, or the Place Store becomes unavailable, When the Run ends, Then none of these produces a Failure Record (they are not Item Failures). A Dry Run keeps no Failure Records (decision Q4).
- **AC-25 (Kept across Runs):** Given Failure Records from earlier Runs, When later Runs end with any Run Outcome, or Places are saved successfully, or an Explicit Retry is made, Then the earlier Failure Records are still kept, unchanged. The Crawl never removes Failure Records, however old (decision Q9).
- **AC-26 (Readable afterwards):** Given Failure Records from several Runs, When the Operator (or a test) reads the Failure Records of a Place or of a Run, Then they come back with all items of AC-21, oldest first.
- **AC-27 (No secrets or personal data):** Given any Failure Record, When it is inspected, Then it contains no API Key, no request address carrying the key, no database password and no Commenter IP. For an Invalid Data failure on Place Details with Commenter IPs re-added (as in Hydration AC-38), the record names the Place ID and the Place Store's reason, and holds no Commenter IP value. This extends Hydration AC-49 and AC-58.
- **AC-28 (Record and failure together):** Given an Item Failure, When its Failure Record cannot be kept because the Place Store is unavailable, Then the Run ends Failed as in Hydration AC-47. An Item Failure is never counted in the Run Summary without its Failure Record being kept, unless the Run ends Failed for this reason.

### 3.6 Part C: Parking and Explicit Retry (US-5, US-6)

- **AC-29 (Third failure of the same kind parks the Place):** Given Summary-Only Place 900 in Region T has 2 Failure Records of kind Wikimapia Error from 2 earlier Runs, and no Count Reset, When a third Run's Details Phase receives a Wikimapia Error for Place 900, Then a third Failure Record is kept and Place 900 becomes a Parked Place. When a fourth Run starts without an Explicit Retry, Then it sends no Place Details request for Place 900, although Place 900 is still Summary-Only.
- **AC-30 (Counting spans Runs):** Given a Place can be tried at most once per Run (a Connection Failure's bounded tries being one Item Failure), When the Parking Threshold is applied, Then Failure Records from all Runs of all Regions are counted, not only those of the current Run (decision Q1).
- **AC-31 (Same kind only, not necessarily consecutive):** Given Summary-Only Place 900 has 2 Failure Records of kind Wikimapia Error and 2 of kind Unexpected Response, in alternating order, and no Count Reset, When a Run starts, Then Place 900 is not a Parked Place and its Place Details are requested. Given its next failure is of either of those kinds, Then it becomes a Parked Place (decision Q2).
- **AC-32 (Connection Failures do not park):** Given Summary-Only Place 900 has 3 or more Failure Records of kind Connection Failure and no other Failure Records, When a Run starts, Then Place 900 is not a Parked Place and its Place Details are requested. Its Connection Failure Records are still kept. Failure Records of kind Wikimapia Error, Unexpected Response, Invalid Data and Invalid Request do count (decision Q3).
- **AC-33 (Success resets the count):** Given Place 900 has 2 Failure Records of kind Wikimapia Error, then a successful Details Save, and later, once its details are older than the Refresh Age, 1 more Wikimapia Error, When the next Run starts, Then Place 900 is not a Parked Place. Only the Failure Record after the successful Details Save is counted (decision Q2).
- **AC-34 (Listing Pages are never parked):** Given Tile 1's page 1 of Region T has 3 or more Failure Records of the same kind, When a Run's Listing Phase runs, Then Tile 1's page 1 is still asked for. Only Places are parked (decision Q6).
- **AC-35 (Parked Places are not due):** Given Region T where Place 900 is Parked and Place 300 is Summary-Only and not Parked, When a Run's Details Phase runs, Then only Place 300 is requested. The Run Summary counts Place 900 under "Places parked", not under "Places still due for details". Given a Region T whose only due Places are all Parked, Then the Run sends no Place Details request and ends Completed (this extends Hydration AC-23).
- **AC-36 (Parking belongs to the Place):** Given Place 62587, whose Centre Point lies in both Regions `belgrade` and `belgrade-small`, became Parked during Runs for `belgrade`, When a Run for `belgrade-small` runs without an Explicit Retry, Then no Place Details request is sent for 62587.
- **AC-37 (Explicit Retry releases the Region's Parked Places):** Given Region T where Places 900 and 901 are Parked (each with 3 Wikimapia Error Failure Records) and Place 902, outside Region T, is Parked, When the Operator runs the Crawl Command for Region T with the Explicit Retry option, Then:
  - at the start of that Run, Places 900 and 901 stop being Parked Places, and their Count Reset becomes the Run's start moment;
  - their Place Details are requested in this Run, in Details Order, among the other Places Due for Details;
  - Place 902 stays Parked;
  - the Run Summary shows 2 Places released;
  - the Explicit Retry is kept in Crawl Progress with its Run and moment.
- **AC-38 (After an Explicit Retry the count starts again):** Given Place 900 was released by an Explicit Retry, When its Place Details then fail with a Wikimapia Error in 1 or 2 later Runs, Then it is not Parked. When they fail with a Wikimapia Error in a third Run after the Explicit Retry, Then it is Parked again. The Failure Records from before the Explicit Retry are kept but are not counted.

### 3.7 Run Summary, command line and Crawl Progress (US-3, US-4, US-5, US-6)

- **AC-39 (Summary additions):** Given any Run, When its Run Summary is shown, Then, in addition to the contents of Hydration AC-50, it shows:
  - Places parked in this Run;
  - Region Places that are Parked (skipped) at the end of the Run;
  - Places released by Explicit Retry in this Run (0 without the option).
  Each is plain text with a label, one per line (Hydration AC-54). A Dry Run shows 0 for each. The Run Record keeps these numbers (Hydration AC-53).
- **AC-40 (Command option):** Given the project is installed, When the Operator runs the Crawl Command for a Region with the Explicit Retry option, Then the Run behaves as in AC-37. The option takes no Place ID: it always applies to every Parked Place of the named Region (decision Q5). The option can be combined with the existing options (Hydration AC-59). Combined with Dry Run, it reports the number of Region Places that are Parked and changes nothing in the database.
- **AC-41 (Schema Setup for Failure Records):** Given a database with the Hydration feature's Schema Setup applied, When this feature's Schema Setup step is applied, Then the database can hold Failure Records and Explicit Retries, and every stored Place, Comment, Tag, Place-Tag Link, Crawl Progress entry and Run Record is unchanged. Undoing the step removes only this storage, and applying it again succeeds (as Hydration AC-55 and AC-56).
- **AC-42 (Test starting state):** Given any test that uses the Test Database, When it starts, Then every Schema Setup step is applied, including this feature's, and the database holds no Failure Records and no Explicit Retries besides what the test itself creates (this extends Hydration AC-57).

### 3.8 Fixtures and tests (US-7, `.agrules` section 4)

- **AC-43 (New Recorded fixtures):** Given the two Run 1 recordings `data/recordings/getbyid-belgrade-1391132-no-tags.json` and `data/recordings/getbyid-belgrade-8918979-no-tags.json`, When AC-1 to AC-7 are tested, Then they use trimmed copies of them in `contracts/fixtures/wikimapia/`. The copies:
  - keep the missing Tags item missing, and keep 1391132's empty Wikipedia text and 8918979's missing Wikipedia item exactly as recorded;
  - contain no API Key, no request address and no Commenter IP;
  - are listed in the fixtures `README.md` as recorded responses (Run 1 of `belgrade-small`, 2026-10-22), with their source recording and trimming, under the existing Wikimapia CC BY-NC-SA 3.0 credit.
  The variants used by AC-3, AC-4, AC-5 and AC-7 (Tags added as an empty list, Tags set to "null", Tags of the wrong kind, title removed, Tags removed from `getbyid-1381893.json`) are built in memory by the tests and listed in the `README.md` table of in-memory variants.
- **AC-44 (Key Quota fixture):** Given no Key Quota Response has been recorded as a file, When AC-8 to AC-20 are tested, Then they use a Reconstructed Fixture whose body is exactly `{"debug":{"code":1004,"message":"Key limit has been reached"}}`, as quoted in CLAUDE.md and the AL7. It is stored in `contracts/fixtures/wikimapia/` and marked in the `README.md` as reconstructed from an observed body quoted in documentation, to be replaced by a real recording when one is captured (as Client AC-40 and AC-41). Its variants (message changed, code changed to 1003, code removed) are built in memory by the tests and listed in the `README.md` table of in-memory variants.
- **AC-45 (Tests first):** Given the current implementation, When the new contract tests for AC-1, AC-2, AC-3, AC-6, AC-8 to AC-12, AC-15 to AC-17 and AC-21 are first run, Then they fail. They pass once the change is implemented, and every existing Client and Hydration test that this document does not amend still passes.
- **AC-46 (No live calls):** Given any test of this feature, When it runs, Then all answers come from Simulated Wikimapia, all waiting uses a Simulated Clock, no real API Key is used, no OpenAI call is made, and only the Test Database is touched (Hydration AC-63 and AC-64).

## 4. Business Rules and Assumptions

1. **Missing or null Tags means no Tags.** A missing Tags item, and a Tags item with the value "null", are both read as an empty list (decision Q10). A Tags item with any other value must still be a valid list of Tags (AC-4). No other required item of Place Details becomes optional (AC-5).
2. **A Key Quota Response is never retried by the Client**, and the Client never waits for it, because its reset window is unknown and waiting cannot be bounded sensibly. This is consistent with Client rule 2 ("Retries only for Rate-Limit Responses").
3. **The Key Quota is recognised by code 1004 alone**, whatever the message says, and this takes precedence over the Rate-Limit Response wording. A `debug` answer without code 1004 follows the existing rules unchanged, even if its message reads "Key limit has been reached" (AC-12, AC-13, decision Q8).
4. **Key Quota Exhausted ends the Run at once** as a Clean Stop with Run Outcome Quota Exhausted, reported to the scheduler as success (decision Q7). The item in progress is neither saved, nor an Item Failure, nor recorded. This is the same treatment the Hydration AL6 gives Rate Limit Exhausted (Hydration AC-44).
5. **No quota memory between Runs.** Because the reset window is unknown, a Run does not remember an earlier Quota Exhausted and does not refuse to start. Each Run that meets an exhausted Key Quota spends exactly 1 Wikimapia Request to find out (AC-17).
6. **Item Failures: count, record, skip, go on.** Every Item Failure is still counted and skipped, and the Run continues (Hydration rule 6a). In addition, each one now gets a Failure Record. A Place with 3 Counted Failures of the same kind is Parked.
7. **Parking is per Place and spans Runs and Regions** (AC-30, AC-36). One Run produces at most one Item Failure per Place, so parking needs at least 3 Runs.
8. **Release only by Explicit Retry.** Parked Places are never released automatically, not by time, not by a new Listing Pass and not by a later Refresh Age (AC-37). An Explicit Retry always releases all Parked Places of the named Region, and only as part of a Run (decision Q5).
9. **Failure Records are history.** They are never edited or removed by the Crawl, and there is no retention limit (decision Q9). Counting uses the Count Reset rather than deleting records (AC-25, AC-38).
10. **Licensing and privacy unchanged.** Failure Records hold identifiers, kinds, messages and moments only: no Place descriptions, Comments or Commenter IPs (AC-27). Recorded fixtures stay trimmed and credited (AC-43).

## 5. Changes to the baseline documents

### 5.1 Client AL6 (`20261020-wikimapia-client-al6.md`)

| Item | Change | Replaced or extended by |
|---|---|---|
| Glossary "Place Details", "Tag" | **Amended**: Tags may be empty, and a missing or "null" Tags item is reported as an empty list. | Glossary "Tags (amended)", AC-1 to AC-3, rule 1 |
| Glossary "Client Failure" kinds | **Extended**: new kind Key Quota Exhausted. New term Key Quota Response. | AC-8 to AC-12 |
| Glossary "Wikimapia Error" | **Amended**: it excludes Key Quota Responses. | Glossary, AC-13 |
| Client AC-13 (optional details missing) | **Extended** with recorded evidence: an empty Wikipedia text (1391132) and a missing Wikipedia item (8918979) are both reported as absent. | AC-1, AC-2 |
| Client AC-24 (not mistaken for data) | **Extended**: a Key Quota Response is never data, never an Unexpected Response, and never a Rate-Limit Response. | AC-10 |
| Client AC-26 (Retry Limit reached) | **Amended**: a Key Quota Response during Retries ends the Retries at once with Key Quota Exhausted, before the Retry Limit is used up. | AC-11 |
| Client AC-32 (other Wikimapia messages) | **Amended**: it applies to `debug` messages that are neither Rate-Limit Responses nor Key Quota Responses, including the Key Quota message without code 1004. | AC-13 |
| Client AC-35 (wrong shape) | **Amended**: a missing Tags item, or one with the value "null", is no longer a wrong shape. A Tags item with a value of the wrong kind still is. | AC-3, AC-4, AC-5 |
| Client AC-36 (API Key never exposed) | Applies unchanged to the new kind. | AC-14 |
| Client AC-39 (recorded fixtures) | **Extended** with two Run 1 recordings. | AC-43 |
| Client AC-40, AC-41 (reconstructed fixtures) | **Extended** with the Key Quota fixture. | AC-44 |
| Client rule 5 (Rate-Limit recognition by message) | **Amended**: code 1004 is checked first and wins. | Rule 3 |

### 5.2 Hydration AL6 (`20261022-hydration-al6.md`)

| Item | Change | Replaced or extended by |
|---|---|---|
| Glossary "Run Outcome", "Clean Stop" | **Extended**: new outcome Quota Exhausted, which is a Clean Stop. | AC-15 to AC-20 |
| Glossary "Item Failure" | Kinds unchanged. **Clarified**: Key Quota Exhausted is not an Item Failure, just as Rate Limit Exhausted is not. | AC-15, AC-24 |
| Glossary "Place Due for Details" | **Amended**: Parked Places are excluded. | Glossary, AC-35 |
| Glossary "Crawl Progress" | **Extended** with Failure Records and Explicit Retries. | AC-21, AC-37, AC-41 |
| Hydration AC-17, AC-18, AC-36, AC-38 (Item Failures) | **Extended**: each Item Failure also gets one Failure Record. In Hydration AC-36, "stays a Place Due for Details for the next Run" is **amended** to "unless it has become a Parked Place". | AC-21 to AC-23, AC-29 |
| Hydration AC-23 (finished Crawl does only refresh work) | **Extended**: Parked Places do not count as outstanding work. | AC-35 |
| Hydration AC-33 (Details Order) | Unchanged for Places that are not Parked. Parked Places are left out. | AC-35 |
| Hydration AC-44 (Rate Limit Exhausted stops cleanly) | Unchanged. A parallel criterion is added for Key Quota Exhausted. | AC-15, AC-16 |
| Hydration AC-45, AC-61 (exit status) | **Amended**: Quota Exhausted reports success. | AC-19 |
| Hydration AC-47 (Place Store unavailable) | **Extended** to failures to keep a Failure Record. | AC-28 |
| Hydration AC-49, AC-58 (no secrets, no Wikimapia content in progress) | **Extended** to Failure Records. | AC-27 |
| Hydration AC-50, AC-53 (Summary contents, Run Record) | **Extended** with the parked, skipped and released counts, and with outcome Quota Exhausted plus Wikimapia's message. Hydration AC-51's numbers are unchanged. | AC-18, AC-22, AC-39 |
| Hydration AC-55 to AC-57 (Schema Setup, test starting state) | **Extended** with this feature's step. | AC-41, AC-42 |
| Hydration AC-59 (command form) | **Extended** with the Explicit Retry option. | AC-40 |
| Hydration rule 6a ("count, skip and go on") | **Amended**: count, record, skip, go on, plus Parking. "No stop after consecutive Item Failures" stays. | Rule 6 |
| Hydration "Facts": "`debug-error.json` ... Reconstructed" | Unchanged. It remains a Wikimapia Error. | AC-13 |
| Hydration "Wikimapia Quota" (100 requests per 5 minutes) | **Not changed here** (decision Q11), but contradicted by Run 1 evidence (the Key Quota was hit at about 10 requests per minute). Flagged for a later decision. | Section 0, out of scope |

### 5.3 Notes for AL5

- The stakeholder named the storage for Failure Records `crawl_item_failures`, with the items Run, Place ID, failure kind, message and time. AC-21 adds the Listing Page item (Tile Number and Page Number) under decision Q6. Whether Explicit Retries share that storage or get their own is an AL5/AL4 decision.
- The code 1004 reaches the Client inside the same `debug` part as the message. The existing Wikimapia Error envelope accepts it today, which is why Run 1 classified it as a Wikimapia Error.

## 6. Stakeholder Decisions (2026-10-22)

All questions that were open in the first version of this document have been answered. None remain open.

1. **Q1, scope of the "3 failures" counter:** **Decided: it spans all Runs and Regions** (AC-30, AC-36). Within one Run a Place is tried only once, so a per-Run counter could never reach 3. Proposed default accepted.
2. **Q2, what resets the counter:** **Decided: a successful Details Save or an Explicit Retry resets the count. Between resets, the 3 failures of the same kind need not be consecutive** (AC-31, AC-33, AC-38). Proposed default accepted.
3. **Q3, which kinds count towards Parking:** **Decided: Wikimapia Error, Unexpected Response, Invalid Data and Invalid Request count. Connection Failure is recorded but does not count** (AC-32). Proposed default accepted.
4. **Q4, are quota and rate-limit stops Item Failures:** **Decided: no.** Key Quota Exhausted, Rate Limit Exhausted, Configuration Failure, budget stops, interrupts and Store Unavailable produce no Failure Record and never count towards Parking. A Dry Run keeps no Failure Records (AC-15, AC-24). Proposed default accepted.
5. **Q5, how the Operator triggers an Explicit Retry:** **Decided: one option on the Crawl Command that releases every Parked Place of the named Region at the start of that Run** (AC-37, AC-40). There is no release of a single Place by Place ID, and no release without making requests (no separate release command). Proposed default accepted; both open points rejected.
6. **Q6, Listing Page failures:** **Decided: Listing Page Item Failures also get Failure Records (with Tile Number and Page Number), but Listing Pages are never parked** (AC-21, AC-34). Proposed default accepted.
7. **Q7, Run Outcome and exit status for the Key Quota:** **Decided: a new Run Outcome "Quota Exhausted", a Clean Stop, reported to the scheduler as success** (AC-15, AC-19). Proposed default accepted; reusing Rate Limited and reporting failure were rejected.
8. **Q8, how the Key Quota Response is recognised:** **Decided: by code 1004 alone, whatever the message** (AC-12, rule 3). A `debug` answer with the message "Key limit has been reached" but no code is a Wikimapia Error (AC-13). Proposed default accepted.
9. **Q9, keeping Failure Records:** **Decided: kept for good, never removed by the Crawl; no retention limit** (AC-25, rule 9). Proposed default accepted.
10. **Q10, Tags present as "null":** **Decided (proposed default overridden): a Tags item present with the value "null" is treated the same as a missing Tags item, that is, as an empty list of Tags, with no failure** (AC-3, AC-4, AC-7, rule 1). The earlier default (an Unexpected Response) is withdrawn.
11. **Q11, Key Quota and Run sizing:** **Decided: no change to the Request Budget or pacing in this feature** (section 0, out of scope). To be revisited in a later feature once the Key Quota's reset window is known.
