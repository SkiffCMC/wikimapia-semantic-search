/**
 * Resolving the Run (AL4 1.4.1; AC-1, AC-5, AC-6, AC-7, AC-60, AC-67). Validates the request and
 * the Crawl Configuration with the contract schemas, applies the request overrides, resolves the
 * Region and builds its Tile Plan. Failure messages name the setting key and use only Zod issue
 * paths and messages, never input values.
 */
import type { z } from 'zod';
import {
  API_KEY_ENV,
  CONFIGURATION_SETTING_KEYS,
  CRAWL_COMMAND_OPTIONS,
  CrawlConfigurationSchema,
  CrawlRequestSchema,
  type CrawlConfiguration,
  type CrawlRequest,
} from '../../contracts/hydration.schema';
import { formatIssuePath } from '../wikimapia/issues';
import { planTiles } from './tile-plan';
import type { Resolution } from './types';

/** The missing-key message of AC-7 (used by `runCrawl`); names the variable, never a value. */
export const MISSING_API_KEY_MESSAGE = `Wikimapia API key is missing: set ${API_KEY_ENV}.`;

const SETTING_KEYS: readonly PropertyKey[] = CONFIGURATION_SETTING_KEYS;

function toPathElement(element: PropertyKey): string | number {
  if (typeof element === 'symbol') return element.description ?? 'symbol';
  return element;
}

function regionPart(path: readonly PropertyKey[], merged: CrawlConfiguration | undefined): string {
  if (merged === undefined || path[0] !== 'regions') return '';
  const index = path[1];
  if (typeof index !== 'number') return '';
  const name = merged.regions[index]?.name;
  return name !== undefined ? ` of region "${name}"` : '';
}

function settingMessage(issue: z.core.$ZodIssue, merged: CrawlConfiguration | undefined): string {
  const key = issue.path.find((element) => SETTING_KEYS.includes(element));
  if (typeof key === 'string') {
    return `Invalid crawl configuration: setting "${key}"${regionPart(issue.path, merged)}: ${issue.message}`;
  }
  return `Invalid crawl configuration: ${formatIssuePath(issue.path.map(toPathElement))}: ${issue.message}`;
}

function firstIssueMessage(
  issues: readonly z.core.$ZodIssue[],
  merged: CrawlConfiguration | undefined,
): string {
  const first = issues[0];
  if (first === undefined) return 'Invalid crawl configuration: (whole answer): invalid value';
  return settingMessage(first, merged);
}

function mergeOverrides(configuration: CrawlConfiguration, request: CrawlRequest): CrawlConfiguration {
  return {
    ...configuration,
    ...(request.requestBudget !== undefined ? { requestBudget: request.requestBudget } : {}),
    ...(request.minRequestIntervalSeconds !== undefined
      ? { minRequestIntervalSeconds: request.minRequestIntervalSeconds }
      : {}),
    ...(request.refreshAgeDays !== undefined ? { refreshAgeDays: request.refreshAgeDays } : {}),
  };
}

export function knownRegionNames(configuration: CrawlConfiguration): string[] {
  return configuration.regions.map((region) => region.name);
}

export function usageMessage(names: readonly string[]): string {
  return `No region given. Usage: pnpm crawl ${CRAWL_COMMAND_OPTIONS.region} <name> [--dry-run] [--relist] [${CRAWL_COMMAND_OPTIONS.retryParked}] [--budget <n>] [--min-interval <seconds>] [--refresh-age <days>]. Known regions: ${names.join(', ')}.`;
}

export function isMissingApiKey(apiKey: string | undefined): boolean {
  return apiKey === undefined || apiKey.trim() === '';
}

export function resolveRun(request: CrawlRequest, configuration: CrawlConfiguration): Resolution {
  const r = CrawlRequestSchema.safeParse(request);
  if (!r.success) return { ok: false, message: firstIssueMessage(r.error.issues, undefined) };

  const merged = mergeOverrides(configuration, r.data);
  const c = CrawlConfigurationSchema.safeParse(merged);
  if (!c.success) return { ok: false, message: firstIssueMessage(c.error.issues, merged) };

  const names = knownRegionNames(c.data);
  const regionName = r.data.regionName?.trim() ?? '';
  if (regionName === '') return { ok: false, message: usageMessage(names) };

  const region = c.data.regions.find((candidate) => candidate.name === regionName);
  if (region === undefined) {
    return {
      ok: false,
      regionName,
      message: `Unknown region "${regionName}". Known regions: ${names.join(', ')}.`,
    };
  }

  return {
    ok: true,
    run: {
      regionName,
      region,
      configuration: c.data,
      plan: planTiles(region),
      dryRun: r.data.dryRun === true,
      relist: r.data.relist === true,
      retryParked: r.data.retryParked === true,
    },
  };
}
