/**
 * Crawl Progress table names and the Region advisory-lock class (AL4 hydration 1.1, 2.2 .. 2.4).
 */
export const CRAWL_TABLES = {
  runs: 'crawl_runs',
  passes: 'crawl_passes',
  finishedPages: 'crawl_finished_pages',
} as const;

/** First key of the two-key Region advisory lock (fits int4). */
export const CRAWL_REGION_LOCK_CLASS = 20261022;
