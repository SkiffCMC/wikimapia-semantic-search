Bugs found in the first real crawl (belgrade-small, run 1):
1. wikimapia-client: place.getbyid omits `tags` entirely when a place has no tags (places 1391132, 8918979; recorded in data/recordings/getbyid-belgrade-1391132-no-tags.json and getbyid-belgrade-8918979-no-tags.json). Treat a missing `tags` as an empty list.
2. wikimapia-client + hydration: Wikimapia answers {"debug":{"code":1004,"message":"Key limit has been reached"}} (HTTP 200) when the key's quota is used up. The client must report it as a distinct failure kind (quota exhausted), and the crawl must stop the run cleanly with progress saved instead of counting it as an item failure and continuing. In run 1 this wasted 112 requests.
3. hydration: item failures are only printed. Store them in a crawl_item_failures table (run, place id, failure kind, message, time), and skip a place after 3 failures of the same kind until it is retried explicitly.
Failing contract tests first, from the recordings.
