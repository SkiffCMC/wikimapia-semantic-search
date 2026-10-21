# AL6 Requirements: Wikimapia API Client

- **Feature:** `wikimapia-client` (Stage 1, substep 1)
- **AL7 source:** `docs/al7-intent/20261020-wikimapia-client-al7.md`
- **Status:** Ready for AL5 Contracts (stakeholder answered Q1 to Q3 on 2026-10-20; see section 5)

## 0. Context and Scope

The project will crawl Wikimapia places and comments into a local search index. Before any storage or crawling is built, we need a **Wikimapia Client** that can ask Wikimapia for (a) the places inside an area and (b) the full details and comments of one place, and that turns Wikimapia's answers into checked, predictable information. It must also cope with Wikimapia's way of saying "slow down".

**In scope**

- Listing the places in a Bounding Box, one Listing Page at a time (Wikimapia's `box` function).
- Fetching the Place Details of one place, including its Comments and their Replies at any depth (Wikimapia's `place.getbyid` function).
- Recognising a Rate-Limit Response, waiting the requested time, and asking again.
- Recognising and reporting failures in a clear, distinguishable way.
- Removing Commenter IPs, at every level of Replies, before anything leaves the client.
- Exercising all of the above with no network access and no real waiting.

**Out of scope**

- Storing anything (substep 2).
- Walking a whole area across many pages, splitting areas into a grid, scheduling, resuming (substep 3, crawl orchestration).
- Embeddings (substep 4).
- Wikimapia functions `place.getbyarea` and `place.search` (verified on 2026-10-20 to return nothing for every query) and `place.getnearest` (works, but the crawl does not need it).
- Deciding the actual Wikimapia quota (still unknown; see CLAUDE.md "Open Decisions").

**Facts this document relies on** (from CLAUDE.md "Verified behaviour", probed 2026-10-20, and the raw responses in `data/recordings/`):

- `box` returns a page of places with id, name, Wikimapia page link, location (centre and bounds) and outline, plus the page number, the page size and the total number of places found in the area. Place ids and the total come back as text (for example `"7291521"`, `"290"`), not as numbers.
- `place.getbyid` returns the place's id (as a number), title, description, tags, parent id (as text, `"0"` when there is none), building/region/deleted flags, outline, location and comments. It also returns many extra items the project does not need (for example a ready-made HTML link, administrative-area lists, map zoom).
- Some places have no Wikipedia link, no street, a very short description, or no comments at all (`getbyid-belgrade-1381893.json`: University Park has no Wikipedia link, no street and no comments).
- Every recorded comment carries `user_ip`, sometimes as a negative number. Every recorded comment has an empty list of replies; no recording shows a non-empty one. By stakeholder decision (Q3), a reply is treated as having the same shape as a comment.
- A Rate-Limit Response arrives as an apparently successful answer whose body is `{"debug":{"message":"You have reached the limit for this action. You need to wait for N seconds."}}`. **No such response has been recorded**: the only evidence is the text quoted in CLAUDE.md.

## 1. Ubiquitous Language (Domain Glossary)

| Term | Definition |
|---|---|
| **Wikimapia** | The crowdsourced map whose places and comments the project indexes. Its data is licensed CC BY-NC-SA 3.0. |
| **Wikimapia Client** (the Client) | The component specified here. The only part of the project that talks to Wikimapia. Used by the future crawl jobs; never by live search. |
| **Operator** | The person or job that uses the Client (in practice, the crawl jobs of substep 3 and the developer running them). |
| **API Key** | The personal secret the Operator obtained from Wikimapia. Required on every request. Never shown in errors, logs or recorded fixtures. |
| **Place** | One object on Wikimapia (a building, park, square, district, ...). Called "object", "place" or "folder item" by Wikimapia; this project always says **Place**. |
| **Place ID** | The positive whole number that identifies a Place on Wikimapia. The Client always reports it as a whole number, whether Wikimapia sent it as text or as a number. |
| **Bounding Box** | A rectangular area given as west longitude, south latitude, east longitude, north latitude (in that order). Longitudes lie in -180..180, latitudes in -90..90; west is less than east and south is less than north. |
| **Listing Page** | One page of the answer to "which Places are in this Bounding Box?". Has a Page Number (starting at 1), a Page Size (1 to 100 Places) and the Total Found. |
| **Total Found** | The number of Places Wikimapia says exist in the whole Bounding Box, across all Listing Pages. Reported as a whole number. |
| **Place Summary** | What a Listing Page says about each Place: Place ID, name, Wikimapia page link, Location and Outline. No description and no comments. |
| **Place Details** | Everything the Client reports about one Place after asking for it by Place ID: Place ID, title, description, Tags, Parent Place ID (absent when Wikimapia reports none), whether it is a building, whether it is a region, whether it is deleted, Wikipedia link (when present), Outline, Location and Comments. |
| **Tag** | A Wikimapia category attached to a Place, with its own id and title (e.g. "park", "town square"). |
| **Outline** | The polygon of a Place, as an ordered list of points, each a longitude and a latitude. |
| **Location** | The centre point (longitude, latitude) and bounds (north, south, east, west) of a Place, plus whichever address details Wikimapia provides (street, house number, city, place, state, country). Address details may be missing. |
| **Comment** | A message a Wikimapia user left on a Place. Reported with: Place ID, comment number, language id, Comment Author, author's Wikimapia user id (0 for anonymous), author photo link (may be empty), message text, "good" and "bad" vote counts, whether it is blocked, whether it is deleted, the moment it was posted, moderator id and name (name may be absent), and its Replies (an ordered list, possibly empty). |
| **Reply** | A Comment that Wikimapia lists under another Comment's replies. A Reply is itself a Comment: it has the same fields, is checked and normalised the same way, has its Commenter IP removed, and may have Replies of its own, to any depth. |
| **Comment Author** | The display name of the person who wrote a Comment (or Reply). Kept, because the CC BY licence requires crediting authors. |
| **Commenter IP** | The `user_ip` value Wikimapia attaches to each Comment and Reply. Personal data the project must not keep: the Client removes it at every level, so no Comment or Reply it reports contains it (`.agrules` §4 "No Commenter IPs"). |
| **Rate-Limit Response** | An answer from Wikimapia that carries no data and instead says the limit was reached and the Operator must wait a number of seconds. It looks like a successful answer, so it must be recognised by its content. |
| **Wait Time** | The number of seconds a Rate-Limit Response asks the Operator to wait. |
| **Retry** | Sending the identical request again after waiting the Wait Time. |
| **Retry Limit** | The largest number of Retries the Client makes for one request before giving up. 5 unless the Operator configures otherwise. |
| **Fallback Wait Time** | The Wait Time the Client uses when a Rate-Limit Response does not state a readable number of seconds. 60 seconds unless the Operator configures otherwise. |
| **Client Failure** | Any outcome where the Client cannot return the requested information. Always one of the named kinds below, so the caller can tell them apart. |
| **Configuration Failure** | Kind of Client Failure: the Client was started without an API Key. |
| **Invalid Request** | Kind of Client Failure: the Operator asked for something impossible (a malformed Bounding Box, a Page Number below 1, a Page Size outside 1..100, a Place ID that is not a positive whole number). Detected before contacting Wikimapia. |
| **Rate Limit Exhausted** | Kind of Client Failure: Wikimapia kept sending Rate-Limit Responses after the Retry Limit was used up. |
| **Wikimapia Error** | Kind of Client Failure: Wikimapia answered with an error message that is not a Rate-Limit Response (for example an invalid key or unknown function). Carries Wikimapia's message text. |
| **Connection Failure** | Kind of Client Failure: Wikimapia could not be reached, or answered with a non-success status. |
| **Unexpected Response** | Kind of Client Failure: Wikimapia's answer could not be read, or did not have the shape this document describes (a required item missing or of the wrong kind). Says which item was wrong. |
| **Recorded Response** | A real answer captured from Wikimapia. Raw ones live in `data/recordings/` (not committed); trimmed ones become test fixtures in `contracts/fixtures/wikimapia/` with API Key and Commenter IPs removed and Wikimapia credited. |
| **Reconstructed Fixture** | A test fixture for a situation no Recorded Response shows, built either from the exact text quoted in CLAUDE.md or from a Recorded Response by the smallest change needed. Marked as reconstructed in the fixtures `README.md`, to be replaced by a real recording when one is captured. |
| **Simulated Clock** | A stand-in for real time used in tests, so that waiting N seconds can be checked without actually waiting. |
| **Simulated Wikimapia** | A stand-in for the network used in tests, which answers with Recorded Responses (or other prepared answers) and remembers what was asked. |

## 2. User Stories

- **US-1 (List places in an area):** As an Operator, I want to ask for one Listing Page of the Places inside a Bounding Box and get the Place Summaries together with the Total Found, so that the crawl can collect every Place ID in an area without guessing how many pages there are.
- **US-2 (Get place details):** As an Operator, I want to ask for the Place Details of one Place ID, including its Comments and all their Replies, so that the description, tags, outline and the whole discussion can later be stored and searched.
- **US-3 (Survive rate limiting):** As an Operator, I want the Client to recognise a Rate-Limit Response, wait the requested time and try again on its own, so that a long offline crawl is not interrupted by Wikimapia's quota, which we do not yet know.
- **US-4 (Clear failures):** As an Operator, I want every failure reported as a specific, named kind of Client Failure, so that the crawl can decide whether to stop, skip a Place or try again later.
- **US-5 (Privacy and licensing):** As the project owner, I want Commenter IPs removed at every level of Comments and Replies before data leaves the Client and the API Key never exposed, while Comment Authors are kept, so that we keep no personal data we do not need and can still credit authors as the licence requires.
- **US-6 (Trustworthy, predictable data):** As a developer of the storage and crawl steps, I want every answer checked against the shapes described here and reported in one consistent form (whole numbers for ids and totals, absent rather than placeholder values), so that later steps never handle raw, unchecked Wikimapia data.
- **US-7 (Offline verification):** As a developer, I want the Client to be fully testable with Recorded Responses, Reconstructed Fixtures, a Simulated Wikimapia and a Simulated Clock, so that tests need no network, no API Key and no real waiting.

## 3. Acceptance Criteria (BDD Style)

Criterion numbers are stable identifiers; criteria added in revision 2 (AC-42 to AC-50) are placed in the section they belong to rather than in numeric order.

### 3.1 Listing places in a Bounding Box (US-1, US-6)

- **AC-1 (Happy path, Listing Page):** Given Simulated Wikimapia answers with the recorded `box` page for the Bounding Box west 20.452, south 44.814, east 20.462, north 44.820 (`probe-box-deprecated.json`, trimmed), When the Operator asks for Listing Page 1 of that Bounding Box, Then the Client returns the Page Number 1, the Page Size reported by Wikimapia, Total Found 290 as a whole number, and one Place Summary per Place in the page, in the order Wikimapia sent them.
- **AC-2 (Place Summary content):** Given the same recorded page, When the Client returns its Place Summaries, Then the Place Summary for "University Park" has Place ID 1381893 as a whole number, name "University Park", Wikimapia page link `http://wikimapia.org/1381893/University-Park`, a Location with centre longitude 20.457876 and latitude 44.819524 and bounds north 44.820321, south 44.818727, east 20.459064, west 20.456688, and an Outline of 4 points whose first point is longitude 20.456688, latitude 44.8198.
- **AC-3 (What is asked of Wikimapia, listing):** Given any valid Bounding Box, Page Number and Page Size, When the Operator asks for a Listing Page, Then exactly one request is sent to Wikimapia's `box` function, asking for answers in JSON, carrying the API Key, the Bounding Box in the order west, south, east, north, the Page Number and the Page Size.
- **AC-4 (Default page size):** Given the Operator does not state a Page Size, When the Operator asks for a Listing Page, Then the Client asks Wikimapia for 100 Places per page (the largest Wikimapia allows).
- **AC-5 (Language, optional):** Given the Operator states a language as a two-letter code (e.g. "en"), When the Client sends any request, Then the request asks Wikimapia for that language; Given no language is stated, Then the request does not ask for any particular language.
- **AC-6 (Empty page):** Given Simulated Wikimapia answers a Listing Page request with a page that contains no Places (the reconstructed empty `box` page of AC-41, e.g. a Page Number past the last page), When the Operator asks for that page, Then the Client returns an empty list of Place Summaries together with the Total Found, and does not report a failure.
- **AC-7 (Invalid Bounding Box):** Given a Bounding Box where west is not less than east, or south is not less than north, or any longitude is outside -180..180, or any latitude is outside -90..90, When the Operator asks for a Listing Page, Then the Client reports an Invalid Request naming the problem, and sends nothing to Wikimapia.
- **AC-8 (Invalid paging):** Given a Page Number below 1 or not a whole number, or a Page Size below 1, above 100 or not a whole number, When the Operator asks for a Listing Page, Then the Client reports an Invalid Request and sends nothing to Wikimapia.

### 3.2 Fetching Place Details (US-2, US-5, US-6)

- **AC-9 (Happy path, place with comments):** Given Simulated Wikimapia answers with the recorded details of Place 62587 (`getbyid-belgrade-62587.json`, trimmed), When the Operator asks for the Place Details of Place ID 62587, Then the Client returns Place ID 62587, title "Square of the Republic", the full description text unchanged, Tags "historic town square" (id 44926) and "town square" (id 46360), no Parent Place ID, not a building, not a region, not deleted, Wikipedia link `http://en.wikipedia.org/wiki/Republic_Square_(Belgrade)`, an Outline of 19 points, a Location with centre longitude 20.4603516 and latitude 44.8161006, and exactly 2 Comments.
- **AC-10 (Comment content):** Given the same recorded details of Place 62587, When the Client returns its Comments, Then they appear in the order Wikimapia sent them, and the first Comment has Place ID 62587, comment number 1, Comment Author "Mateja", author user id 0, message "Everybodey is waiting for someone here", 5 good and 15 bad votes, not blocked, not deleted, posted at the moment 1169755601 seconds after 1970-01-01 00:00 UTC (2007-01-25), moderator id 0, no moderator name and an empty list of Replies; and the second Comment has Comment Author "Serbia", author user id 150331, message "Najbolji trg na svetu!!" and an empty list of Replies.
- **AC-11 (No Commenter IPs):** Given Wikimapia's answer contains a Commenter IP on every Comment (positive or negative), When the Client returns Place Details, Then no Comment the Client returns contains a Commenter IP in any form, and the Comment Author is still present.
- **AC-12 (Place without comments):** Given Simulated Wikimapia answers with the recorded details of Place 1381893 (`getbyid-belgrade-1381893.json`, trimmed), When the Operator asks for its Place Details, Then the Client returns title "University Park", description "Belgrade,Serbia.", Tag "park" (id 194), and an empty list of Comments, and does not report a failure.
- **AC-13 (Optional details missing):** Given the recorded details of Place 1381893, which have no Wikipedia link and no street or house number in their Location, When the Client returns its Place Details, Then the Wikipedia link, street and house number are reported as absent, not as empty text or placeholders, and no failure is reported.
- **AC-14 (Optional details present):** Given Simulated Wikimapia answers with the recorded details of Place 55 (`getbyid-55.json`, trimmed), When the Operator asks for its Place Details, Then the Client returns title "Eiffel Tower", marked as a building, with Location street "Champ de Mars" and house number "5".
- **AC-15 (Parent place):** Given Wikimapia reports a parent id of "0", When the Client returns Place Details, Then no Parent Place ID is reported; Given Wikimapia reports any other parent id, Then that id is reported as a whole-number Parent Place ID.
- **AC-16 (Extra items ignored):** Given Wikimapia's answer contains items this document does not list (for example a ready-made HTML link, administrative-area lists, map zoom, internal coordinates), When the Client returns Place Details, Then those items are not reported and their presence does not cause a failure.
- **AC-17 (What is asked of Wikimapia, details):** Given a valid Place ID, When the Operator asks for its Place Details, Then exactly one request is sent to Wikimapia's `place.getbyid` function, asking for answers in JSON, carrying the API Key and the Place ID, and asking for the main, geometry, location and comments information blocks.
- **AC-18 (Invalid Place ID):** Given a Place ID that is zero, negative or not a whole number, When the Operator asks for its Place Details, Then the Client reports an Invalid Request and sends nothing to Wikimapia.
- **AC-19 (Deleted place):** Given Wikimapia's answer marks the Place as deleted, When the Client returns Place Details, Then the Place Details are returned with the deleted mark set, and no failure is reported (deciding what to do with deleted Places belongs to later steps).
- **AC-20 (Deleted or blocked comment):** Given Wikimapia's answer contains a Comment or Reply marked deleted or blocked, When the Client returns Place Details, Then that Comment or Reply is returned with its deleted or blocked mark set, and no failure is reported.

### 3.3 Comment Replies (US-2, US-5, US-6)

- **AC-21 (Empty replies):** Given a Comment whose list of replies is empty, When the Client returns that Comment, Then it is reported with an empty list of Replies and no failure is reported.
- **AC-42 (One level of Replies):** Given Simulated Wikimapia answers with the reconstructed nested-replies fixture of Place 62587 (AC-50), in which the recorded "Serbia" Comment has been moved into the replies of the recorded "Mateja" Comment, When the Operator asks for the Place Details of Place ID 62587, Then the Client returns exactly 1 top-level Comment (Comment Author "Mateja", message "Everybodey is waiting for someone here"), whose Replies contain exactly 1 Reply with Comment Author "Serbia", author user id 150331 and message "Najbolji trg na svetu!!", reported with the same fields and the same normalisation as a top-level Comment (whole-number ids, vote counts, flags, posting moment, moderator id and name, its own Replies).
- **AC-43 (Replies at any depth):** Given the same reconstructed fixture (AC-50), which also places a recorded Comment from Place 55 inside the replies of the "Serbia" Reply (three levels: Comment, Reply, Reply to the Reply), When the Client returns the Place Details, Then the Reply to the Reply is reported as a Reply of "Serbia" with its recorded Comment Author and message unchanged, and with an empty list of Replies; there is no fixed limit on how deep Replies may be nested.
- **AC-44 (Order of Replies):** Given a Comment whose replies list contains more than one Reply, When the Client returns that Comment, Then its Replies appear in the order Wikimapia sent them.
- **AC-45 (No Commenter IPs at any depth):** Given Wikimapia's answer contains a Commenter IP (positive or negative) on a top-level Comment, on a Reply and on a Reply to a Reply, When the Client returns Place Details, Then no Comment or Reply at any level contains a Commenter IP in any form, and every Comment Author at every level is still present. (Tested by re-adding Commenter IPs at every level of the AC-50 fixture, since stored fixtures contain none.)
- **AC-46 (Wrong shape inside a Reply):** Given a Reply at any depth lacks a required item (for example a Comment Author) or has an item of the wrong kind (for example a vote count that is not a whole number), When the Operator asks for the Place Details, Then the Client reports an Unexpected Response naming the item that was wrong and indicating that it is inside a Reply, and returns no partial data.
- **AC-47 (Deleted or blocked parent with Replies):** Given a Comment marked deleted or blocked has a non-empty list of replies, When the Client returns that Comment, Then the Comment is returned with its mark set and its Replies are still reported in full (deciding what to do with them belongs to later steps).

### 3.4 Rate limiting (US-3, US-7)

- **AC-22 (Recognise and wait):** Given Simulated Wikimapia first answers a request with a Rate-Limit Response saying "You need to wait for 7 seconds." and then answers the same request normally, and time is measured by a Simulated Clock, When the Operator makes that request, Then the Client waits exactly 7 seconds on the Simulated Clock, sends the identical request a second time, and returns the normal result as if no limit had occurred.
- **AC-23 (Applies to both functions):** Given the situation of AC-22, When the request is a Listing Page request or a Place Details request, Then the behaviour of AC-22 holds for both.
- **AC-24 (Not mistaken for data):** Given Wikimapia answers with a Rate-Limit Response, When the Client handles it, Then it is never returned as a Listing Page or as Place Details and never reported as an Unexpected Response.
- **AC-25 (Several limits in a row):** Given Simulated Wikimapia answers a request with Rate-Limit Responses of 3 seconds and then 5 seconds, then normally, When the Operator makes that request, Then the Client waits 3 seconds, retries, waits 5 seconds, retries, and returns the normal result; total simulated waiting is 8 seconds and exactly 3 requests were sent.
- **AC-26 (Retry Limit reached):** Given the Retry Limit is R (5 unless the Operator configures otherwise), and Simulated Wikimapia answers every attempt of a request with a Rate-Limit Response, When the Operator makes that request, Then the Client sends exactly R + 1 requests, waits the stated Wait Time after each of the first R of them, does not wait after the last, and then reports Rate Limit Exhausted stating the number of attempts and the last Wait Time. With the default, that is 6 requests and 5 waits.
- **AC-27 (Unreadable Wait Time):** Given a Rate-Limit Response whose message says the limit was reached but does not state a readable whole number of seconds, When the Client handles it, Then it waits the Fallback Wait Time (60 seconds unless the Operator configures otherwise) and retries, counting this towards the Retry Limit.
- **AC-28 (Wait Time of zero):** Given a Rate-Limit Response stating 0 seconds, When the Client handles it, Then it retries without waiting, still counting this towards the Retry Limit.
- **AC-29 (No waiting without a limit):** Given Wikimapia answers normally on the first attempt, When the Operator makes any request, Then the Client does not wait at all and sends exactly one request.
- **AC-30 (No early retry):** Given a Rate-Limit Response is being waited out, When the Client is waiting, Then it sends nothing for that request until the Wait Time has fully elapsed on the clock it was given.
- **AC-48 (No cap on a stated Wait Time):** Given a Rate-Limit Response stating a very long Wait Time (for example 86400 seconds), When the Client handles it, Then it waits exactly that many seconds on the clock it was given and retries; it does not shorten the wait and does not report a failure because of the wait's length.
- **AC-49 (Configured limits honoured):** Given the Operator configures a Retry Limit of 2 and a Fallback Wait Time of 10 seconds, When Simulated Wikimapia answers every attempt with a Rate-Limit Response that states no readable number of seconds, Then the Client sends exactly 3 requests, waits 10 seconds after each of the first 2, and reports Rate Limit Exhausted.

### 3.5 Failures (US-4, US-5)

- **AC-31 (Missing API Key):** Given the Client is set up without an API Key (missing or empty), When it is created or asked for anything, Then it reports a Configuration Failure and sends nothing to Wikimapia.
- **AC-32 (Other Wikimapia messages):** Given Wikimapia answers with an error message that is not a Rate-Limit Response (the reconstructed non-rate-limit error fixture of AC-41, for example one about an invalid key), When the Operator makes a request, Then the Client reports a Wikimapia Error carrying Wikimapia's message text, and does not retry.
- **AC-33 (Cannot reach Wikimapia):** Given Simulated Wikimapia cannot be reached, or answers with a non-success status, When the Operator makes a request, Then the Client reports a Connection Failure and does not retry (backing off on such failures is the crawl's job, substep 3).
- **AC-34 (Unreadable answer):** Given Wikimapia answers with something that is not valid JSON, When the Operator makes a request, Then the Client reports an Unexpected Response.
- **AC-35 (Wrong shape):** Given Wikimapia's answer lacks a required item (for example a Place Details answer without a title, or a Comment without a Comment Author) or has an item of the wrong kind (for example a Place ID that is not a whole number), When the Operator makes a request, Then the Client reports an Unexpected Response naming the item that was wrong, and returns no partial data.
- **AC-36 (API Key never exposed):** Given any Client Failure of any kind, When it is reported, Then neither the API Key nor any request address containing it appears in the failure's message or details.
- **AC-37 (No Commenter IPs in failures):** Given an Unexpected Response or Wikimapia Error is reported for an answer that contained Comments or Replies at any depth, When it is reported, Then no Commenter IP value from any level appears in the failure's message or details.

### 3.6 Offline verification and fixtures (US-7, `.agrules` §4)

- **AC-38 (No network in tests):** Given the Client is exercised in tests, When any test runs, Then all answers come from a Simulated Wikimapia and all waiting from a Simulated Clock, no real network request is made, no real API Key is used, and no test takes real time to wait out a Rate-Limit Response.
- **AC-39 (Recorded fixtures):** Given the tests for AC-1, AC-2, AC-9 to AC-14, When they run, Then they use Recorded Responses trimmed into `contracts/fixtures/wikimapia/`: the `box` page trimmed to the few Places the tests need (University Park must remain; Total Found stays 290), and the `place.getbyid` answers for 62587, 1381893 and 55 trimmed to what the tests need (Place 55 keeps a few Comments, not all of them); with the API Key removed and every Commenter IP removed; and the folder carries a `README.md` crediting Wikimapia under CC BY-NC-SA 3.0. (AC-11 and AC-45 are then checked by feeding the Client a fixture to which Commenter IPs have been re-added, since stored fixtures contain none.)
- **AC-40 (Rate-Limit fixture):** Given no real Rate-Limit Response has been recorded, When AC-22 to AC-28, AC-48 and AC-49 are tested, Then they use a Reconstructed Fixture built from the exact body quoted in CLAUDE.md (with the number of seconds varied as each criterion needs), stored in `contracts/fixtures/wikimapia/` and marked in its `README.md` as reconstructed from documentation rather than recorded, to be replaced by a real recording when one is captured.
- **AC-41 (Other Reconstructed Fixtures):** Given the empty `box` page, the non-rate-limit Wikimapia error, the deleted place, the deleted/blocked comment, the non-zero parent and the wrong-shape cases have no Recorded Response, When they are tested, Then they use Reconstructed Fixtures: the non-rate-limit error is built in the same `debug` message form as the quoted Rate-Limit body, and the others are derived from a Recorded Response by the smallest change needed (e.g. the list of Places emptied, one flag flipped, one item removed); each is marked as reconstructed in the fixtures `README.md`, to be replaced by a real recording when one is captured.
- **AC-50 (Nested-replies fixture):** Given no Recorded Response has a non-empty list of replies, When AC-42 to AC-47 are tested, Then they use a Reconstructed Fixture derived from the trimmed details of Place 62587 by nesting the real recorded "Serbia" Comment inside the replies of the real recorded "Mateja" Comment, and a real recorded Comment from Place 55 inside the replies of "Serbia"; the fixture keeps the recorded field values unchanged apart from that nesting, contains no Commenter IPs, and is marked as reconstructed in the fixtures `README.md`, to be replaced when a real Place with replies is recorded.

## 4. Business Rules and Assumptions

1. **One request per call, no pagination walking.** The Client fetches one Listing Page per call. Walking all pages of an area (using Total Found and Page Size) is crawl orchestration (substep 3).
2. **Retries only for Rate-Limit Responses.** All other failures are reported immediately; deciding to back off and try again later belongs to the crawl (`.agrules` §1 "Offline Ingestion").
3. **The quota is not assumed.** The Client does not pace requests in advance or assume any quota; it reacts only to Rate-Limit Responses. Pacing may be added once the quota is measured (CLAUDE.md "Open Decisions").
4. **Retry bounds (stakeholder decision Q2).** Retry Limit 5 Retries per request, then Rate Limit Exhausted; Fallback Wait Time 60 seconds when the wait cannot be read; no cap on a stated Wait Time (any stated wait is waited out in full, since offline jobs can afford to wait). All three are configurable by the Operator.
5. **Rate-Limit Responses are recognised by their message**, i.e. a message stating the limit was reached and/or asking to wait N seconds, since Wikimapia sends them as apparently successful answers.
6. **Values are normalised, not re-interpreted.** Ids and totals that Wikimapia sends as text are reported as whole numbers; text (titles, descriptions, messages, names) is reported unchanged, including any HTML entities or line breaks Wikimapia sent.
7. **Kept comment fields:** everything in the Comment glossary entry, including Replies, which are kept recursively at any depth (stakeholder decision Q3). Only the Commenter IP is removed, at every level (`.agrules` §4). Comment Authors are kept for attribution at every level.
8. **Licensing.** All data the Client returns is Wikimapia data under CC BY-NC-SA 3.0; the Client keeps the Wikimapia page link of every Place Summary so later steps can attribute and link back.
9. **Reconstructed Fixtures are accepted (stakeholder decision Q1)** for situations no recording shows (Rate-Limit Response, empty `box` page, non-rate-limit error, nested Replies, and the derived edge cases), on condition that each is marked as reconstructed in the fixtures `README.md` and replaced by a real recording when one is captured.
10. **Assumption, not a requirement of this feature:** the orchestrator scaffolds the project toolchain (pnpm, strict TypeScript, Zod 4, Vitest, ESLint) before AL5 contracts are written for this feature.

## 5. Open Questions

None open. Resolved by the stakeholder on 2026-10-20:

1. **Q1, Rate-Limit and other unrecorded fixtures:** Accepted the default. The `debug` Rate-Limit Response, the empty `box` page and the non-rate-limit `debug` error are Reconstructed Fixtures (from the CLAUDE.md quoted body or the smallest change to a real recording), marked as reconstructed in the fixtures `README.md`, to be replaced by real recordings later (AC-40, AC-41).
2. **Q2, Retry bounds:** Accepted the defaults. 5 Retries per request, then Rate Limit Exhausted; 60 seconds when the wait cannot be read; no cap on a stated wait; all configurable (AC-26, AC-27, AC-48, AC-49, rule 4).
3. **Q3, Comment replies:** Default rejected. Replies are not discarded: each Reply is parsed as a Comment with the same fields and normalisation, recursively, with the Commenter IP removed at every level. Tested with a Reconstructed Fixture nesting real recorded Comments (AC-21, AC-42 to AC-47, AC-50, rule 7).
