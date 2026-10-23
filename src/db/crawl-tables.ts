/**
 * Crawl Progress table names and the Region advisory-lock class (AL4 hydration 1.1, 2.2 .. 2.4),
 * plus the Failure Record, Explicit Retry and Place Release tables (AL4 crawl-run1-fixes 1.1,
 * 2.2 .. 2.4).
 */
import { CRAWL_ITEM_FAILURES_TABLE } from '../../contracts/crawl-run1-fixes.schema';

export const CRAWL_TABLES = {
  runs: 'crawl_runs',
  passes: 'crawl_passes',
  finishedPages: 'crawl_finished_pages',
  itemFailures: CRAWL_ITEM_FAILURES_TABLE,
  explicitRetries: 'crawl_explicit_retries',
  placeReleases: 'crawl_place_releases',
} as const;

/** Page column of `crawl_item_failures` (AL4 crawl-run1-fixes 0.2; storage AC-14). */
export const ITEM_FAILURE_PAGE_COLUMN = 'page_no';

/** First key of the two-key Region advisory lock (fits int4). */
export const CRAWL_REGION_LOCK_CLASS = 20261022;
