# Wikimapia API fixtures (AL5)

Test fixtures for the `wikimapia-client` contracts
(`contracts/wikimapia-client.test.ts`, `contracts/wikimapia-client.schema.test.ts`), also read by
the `storage`, `hydration` and `crawl-run1-fixes` contracts.
Owned by AL5: lower layers read these files but never edit them (`.agrules` section 4).

## Attribution and licence

The place and comment data in this folder comes from **Wikimapia** (https://wikimapia.org)
and is licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 3.0**
(CC BY-NC-SA 3.0, https://creativecommons.org/licenses/by-nc-sa/3.0/). Comment authors are
credited by the `name` field of each comment. The data is used here for non-commercial testing
only and must not be used commercially or redistributed in bulk.

## Privacy and secrets

- No API key: none of the files contains the API key or a request URL.
- No commenter IPs: the `user_ip` field has been removed from every comment and reply in every
  file. Tests that need IPs (AC-11, AC-37, AC-45) re-add synthetic values in memory.

## Recorded fixtures (real API responses, trimmed)

Recorded on 2026-10-20 with a real key (raw responses are kept outside git in `data/recordings/`).

| File                      | Source recording                                                                                   | Trimming                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `box-belgrade-page1.json` | `probe-box-deprecated.json` (`function=box`, bbox `20.452,44.814,20.462,44.820`, page 1, count 10) | `folder` reduced from 10 to 3 places (1381893 University Park, 62587 Square of the Republic, 164369 National Theatre in Belgrade), order kept. `page`, `count` (10, the requested page size) and `found` (`"290"`) unchanged. |
| `getbyid-62587.json`      | `getbyid-belgrade-62587.json` (`place.getbyid`, Square of the Republic)                            | `user_ip` removed from both comments. Everything else unchanged, including the extra items (`urlhtml`, `gadm`, `zoom`, `x`, `y`, `pl`, ...) used by AC-16.                                                                    |
| `getbyid-1381893.json`    | `getbyid-belgrade-1381893.json` (University Park)                                                  | Unchanged (no comments, no Wikipedia link, no street).                                                                                                                                                                        |
| `getbyid-55.json`         | `getbyid-55.json` (Eiffel Tower)                                                                   | `comments` reduced from 24 to 3 (num 1 "Ramona", num 5 "Paul", num 141 "w8r"), `user_ip` removed. Everything else unchanged.                                                                                                  |

### Recorded during Run 1 of `belgrade-small` (2026-10-22)

Recorded by the first real Crawl (feature `crawl-run1-fixes`, AL6 AC-43) with a real key; the raw
responses are kept outside git in `data/recordings/`. They contain no API key, no request
address and no comments (so no `user_ip`).

| File                           | Source recording                                                                                          | Trimming                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getbyid-1391132-no-tags.json` | `getbyid-belgrade-1391132-no-tags.json` (`place.getbyid`, Kolarac - Peoples' University and Concert Hall) | Re-formatted (pretty-printed JSON); every item and value unchanged. **No `tags` item**, exactly as recorded; `wikipedia` is the empty text `""`, exactly as recorded. No comments. (AC-1, AC-3 .. AC-6)                                                  |
| `getbyid-8918979-no-tags.json` | `getbyid-belgrade-8918979-no-tags.json` (`place.getbyid`, Zoran Đinđić monument)                          | Re-formatted (pretty-printed JSON, with the recorded `\uXXXX` escapes written as the letters Đ, đ, ć); every item and value unchanged. **No `tags` item and no `wikipedia` item**, exactly as recorded. No comments. (crawl-run1-fixes AC-2, AC-3, AC-6) |

## Reconstructed fixtures (NOT real recordings)

No real response has been recorded for these situations. Each is reconstructed as allowed by
AL6 (stakeholder decision Q1, AC-40, AC-41, AC-50; `crawl-run1-fixes` AC-44) and **must be
replaced by a real recording when one is captured**.

| File                                | Reconstructed from                                                                                                                                                                                                                     | Change                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug-rate-limit.json`             | **Documentation only**: the body quoted in `CLAUDE.md` ("Verified behaviour")                                                                                                                                                          | `N` set to `7`. Tests vary the number of seconds (or make it unreadable) by replacing `7 seconds` in the message text (AC-22 to AC-28, AC-48, AC-49).                                                                                                                                                      |
| `debug-error.json`                  | The same `debug` message form as the rate-limit body                                                                                                                                                                                   | Message `Invalid API key.` (a non-rate-limit Wikimapia error; the real wording is unknown) (AC-32).                                                                                                                                                                                                        |
| `box-belgrade-empty-page.json`      | `box-belgrade-page1.json`                                                                                                                                                                                                              | `folder` emptied and `page` set to 30 (past the last page: 290 places / 10 per page = 29 pages) (AC-6).                                                                                                                                                                                                    |
| `getbyid-62587-nested-replies.json` | `getbyid-62587.json` and `getbyid-55.json`                                                                                                                                                                                             | The recorded "Serbia" comment (62587 num 2) moved into the `replies` of the recorded "Mateja" comment (62587 num 1), and the recorded "Paul" comment (55 num 5) placed in the `replies` of "Serbia". All recorded field values unchanged (Paul keeps `place_id` 55), no `user_ip` (AC-42 to AC-47, AC-50). |
| `debug-key-quota.json`              | **Documentation only**: the Key Quota Response body observed in Run 1 of `belgrade-small` (2026-10-22) and quoted in `CLAUDE.md` ("Key quota") and `docs/al7-intent/20261022-crawl-run1-fixes-al7.md`; no response was saved as a file | None: the body is exactly `{"debug":{"code":1004,"message":"Key limit has been reached"}}`. Replace with a real recording when one is captured (crawl-run1-fixes AC-44).                                                                                                                                   |

### Reconstructed variants derived in memory by the tests

These are built inside the tests from the files above by the smallest change, and are equally
reconstructed (to be replaced by real recordings when available):

| Variant                     | Base                                                   | Change                                                                                                   | Criteria                      |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Deleted place               | `getbyid-1381893.json`                                 | `is_deleted` set to `true`                                                                               | AC-19                         |
| Deleted / blocked comment   | `getbyid-62587.json`, nested fixture                   | one comment's `is_deleted` or `block` set to `true`                                                      | AC-20, AC-47                  |
| Non-zero parent             | `getbyid-1381893.json`                                 | `parent_id` set to `"7291521"`                                                                           | AC-15                         |
| Wrong shape                 | any recorded fixture                                   | one required item removed (e.g. `title`, `name`) or given the wrong kind (e.g. `id: "abc"`, `good: 1.5`) | AC-35, AC-37, AC-46           |
| Several replies             | nested fixture                                         | "Ramona" (55 num 1) appended after "Serbia" in Mateja's `replies`                                        | AC-44                         |
| Commenter IPs re-added      | 62587 and nested fixtures                              | synthetic positive and negative `user_ip` values added at every level                                    | AC-11, AC-37, AC-45           |
| Rate-limit wait varied      | `debug-rate-limit.json`                                | `7 seconds` replaced by another number, or by unreadable text                                            | AC-22 to AC-28, AC-48, AC-49  |
| Tags missing (from 1381893) | `getbyid-1381893.json`                                 | `tags` item removed                                                                                      | crawl-run1-fixes AC-7         |
| Tags as an empty list       | `getbyid-8918979-no-tags.json`                         | `tags: []` added                                                                                         | crawl-run1-fixes AC-3         |
| Tags as null                | `getbyid-8918979-no-tags.json`, `getbyid-1381893.json` | `tags: null` added (or set)                                                                              | crawl-run1-fixes AC-3, AC-7   |
| Tags of the wrong kind      | `getbyid-8918979-no-tags.json`                         | `tags` set to text, a number, a Tag without `title`, or a Tag with a non-whole `id`                      | crawl-run1-fixes AC-4         |
| Title removed (no tags)     | `getbyid-1391132-no-tags.json`                         | `title` removed                                                                                          | crawl-run1-fixes AC-5         |
| Key Quota message changed   | `debug-key-quota.json`                                 | `message` set to `""`, to the rate-limit wording, or to a text containing the (synthetic) API key        | crawl-run1-fixes AC-12, AC-14 |
| Key Quota code changed      | `debug-key-quota.json`                                 | `code` set to `1003`                                                                                     | crawl-run1-fixes AC-13        |
| Key Quota code removed      | `debug-key-quota.json`                                 | `code` removed, only the message remains                                                                 | crawl-run1-fixes AC-13        |
