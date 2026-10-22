/**
 * The Run (AL4 1.1 row `run-crawl.ts`, 1.2 Run flow, 1.4.5 .. 1.4.9; U6): resolution, Dry Run,
 * API Key check, the start step, the Gateway with its Last Activity heartbeat, the Listing and
 * Details Phases, the Run end and the report. Never rejects. Opens exactly one crawl repository
 * per non-dry Run and closes it on every path. `deps.onWrite` is handed to the repository
 * unchanged: the single Run-wide write counter is the repository's (AL4 1.4.9). No SQL.
 */
import {
  ABANDONMENT_AGE_SECONDS,
  CRAWL_COMMAND_OPTIONS,
  DEFAULT_CRAWL_CONFIGURATION,
  OUTCOME_LABELS,
  ZERO_RUN_COUNTS,
  toMoment,
  type CrawlClock,
  type CrawlDependencies,
  type CrawlRequest,
  type RunCounts,
  type RunCrawlFn,
  type RunReport,
} from '../../contracts/hydration.schema';
import { openCrawlRepository } from '../db/crawl-repository';
import type { BeginRunValue, CrawlRepository, PassState } from '../db/types';
import { createWikimapiaClient } from '../wikimapia/client';
import { MISSING_API_KEY_MESSAGE, isMissingApiKey, resolveRun } from './config';
import { runDetailsPhase } from './details-phase';
import { createGateway } from './gateway';
import { runListingPhase, takenOverMessage } from './listing-phase';
import { buildReport, createTally, failedReport, plannedReport } from './report';
import { createSystemCrawlClock, defaultTransport } from './runtime';
import type {
  Gateway,
  HeartbeatOutcome,
  PassCursor,
  ResolvedRun,
  RunContext,
  StopReason,
} from './types';

const INTERNAL_ERROR_MESSAGE = 'Crawl failed: internal error';
const DAY_MS = 86_400_000;

/** The Region name asked for, if usable in a summary (non-blank). */
function requestedRegionName(request: CrawlRequest): string | undefined {
  try {
    const name = request.regionName?.trim();
    return name === undefined || name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

function toCursor(pass: PassState): PassCursor {
  return {
    passNumber: pass.passNumber,
    tileCount: pass.tileCount,
    finishedTiles: new Set(pass.finishedTiles),
    lastFinishedPage: new Map(pass.lastFinishedPage),
  };
}

function tilesUnfinishedOf(cursor: PassCursor | undefined): number {
  return cursor === undefined ? 0 : cursor.tileCount - cursor.finishedTiles.size;
}

function startedLine(runId: number, regionName: string, pass: PassState | undefined): string {
  const base = `Run ${String(runId)} started for region ${regionName}`;
  if (pass === undefined) return base;
  return `${base} (pass ${String(pass.passNumber)}, ${String(pass.finishedTiles.length)} of ${String(pass.tileCount)} tiles finished)`;
}

function runInProgressMessage(regionName: string, runId: number, lastActivity: string): string {
  return `A Run for region "${regionName}" is already in progress (run ${String(runId)}, last activity ${lastActivity}).`;
}

function regionChangedMessage(regionName: string, passNumber: number): string {
  return `The definition of region "${regionName}" changed since its incomplete listing pass ${String(passNumber)}. Rerun with ${CRAWL_COMMAND_OPTIONS.relist} to start a new listing pass.`;
}

/** Steps 6 .. 10 of the Run flow, after a successful start step. */
async function runStarted(input: {
  run: ResolvedRun;
  started: Extract<BeginRunValue, { kind: 'started' }>;
  repo: CrawlRepository;
  deps: CrawlDependencies;
  clock: CrawlClock;
  startMs: number;
  startedAt: string;
  progress: (line: string) => void;
}): Promise<RunReport> {
  const { run, started, repo, deps, clock, startMs, startedAt, progress } = input;
  const runId = started.runId;
  const regionName = run.regionName;
  const configuration = run.configuration;

  const cursor = started.pass === undefined ? undefined : toCursor(started.pass);
  const dueBefore = toMoment(new Date(startMs - configuration.refreshAgeDays * DAY_MS));
  const tally = createTally();

  // The heartbeat runs only once the Gateway exists (renewals start with the first request).
  const holder: { gateway?: Gateway } = {};
  const snapshot = (gateway: Gateway, placesStillDue: number): RunCounts =>
    tally.snapshot(gateway.counts(), {
      tilesUnfinished: tilesUnfinishedOf(cursor),
      placesStillDue,
    });

  const heartbeat = async (): Promise<HeartbeatOutcome> => {
    const gateway = holder.gateway;
    if (gateway === undefined) return { ok: true };
    const renewed = await repo.renewActivity({
      runId,
      at: toMoment(clock.now()),
      counts: snapshot(gateway, 0),
    });
    if (!renewed.ok) return { ok: false, message: renewed.failure.message };
    if (!renewed.value.alive) return { ok: false, message: takenOverMessage(regionName) };
    return { ok: true };
  };

  const gateway = createGateway({
    transport: deps.transport ?? defaultTransport(),
    clock,
    signal: deps.signal,
    minRequestIntervalSeconds: configuration.minRequestIntervalSeconds,
    requestBudget: configuration.requestBudget,
    heartbeat,
    lastRenewalMs: startMs,
  });
  holder.gateway = gateway;

  const client = createWikimapiaClient({
    apiKey: deps.apiKey ?? '',
    transport: gateway.transport,
    clock: gateway.clock,
  });
  if (deps.signal?.aborted === true) gateway.stop('interrupted');

  const ctx: RunContext = {
    run,
    runId,
    startMs,
    dueBefore,
    gateway,
    client,
    repo,
    tally,
    clock,
    signal: deps.signal,
    progress,
  };

  if (cursor !== undefined && gateway.stopped === undefined) {
    await runListingPhase(ctx, cursor);
  }
  let dueLoaded = 0;
  if (gateway.stopped === undefined) {
    dueLoaded = (await runDetailsPhase(ctx)).dueLoaded;
  }

  // Run end (AL4 1.4.8).
  const stopped = gateway.stopped;
  let outcome: StopReason | 'completed' = stopped?.reason ?? 'completed';
  let message = stopped?.message;
  if (stopped !== undefined) progress(`Stopping: ${OUTCOME_LABELS[stopped.reason]}`);

  const due = await repo.countPlacesDue({ bbox: run.region.bbox, dueBefore });
  const placesStillDue = due.ok
    ? due.value
    : Math.max(0, dueLoaded - snapshot(gateway, 0).detailsSaved);
  const counts = snapshot(gateway, placesStillDue);
  const endedAt = toMoment(clock.now());

  const finished = await repo.finishRun({ runId, status: outcome, endedAt, counts });
  if (!finished.ok) {
    outcome = 'failed';
    message = finished.failure.message;
    await repo.finishRun({ runId, status: 'failed', endedAt, counts });
  }

  return buildReport({
    outcome,
    ...(message === undefined ? {} : { message }),
    regionName,
    startedAt,
    endedAt,
    counts,
    failures: tally.failures,
    runId,
  });
}

async function runGuarded(
  request: CrawlRequest,
  deps: CrawlDependencies,
  clock: CrawlClock,
): Promise<RunReport> {
  const startMs = clock.now().getTime();
  const startedAt = toMoment(new Date(startMs));
  const progress = (line: string): void => {
    deps.onProgress?.(line);
  };

  // 1. Resolve (pure).
  const resolution = resolveRun(request, deps.configuration ?? DEFAULT_CRAWL_CONFIGURATION);
  if (!resolution.ok) return failedReport(resolution.message, resolution.regionName, startedAt);
  const run = resolution.run;

  // 2. Dry Run: no database, no key.
  if (run.dryRun) return plannedReport(run.plan, startedAt);

  // 3. API Key.
  if (isMissingApiKey(deps.apiKey)) {
    return failedReport(MISSING_API_KEY_MESSAGE, run.regionName, startedAt);
  }

  // 4. The Run's database handle; the hook is passed unchanged (AL4 1.4.9).
  const repo = openCrawlRepository({
    connectionString: deps.connectionString,
    ...(deps.onWrite === undefined ? {} : { onWrite: deps.onWrite }),
  });
  try {
    // 5. Start step.
    const begun = await repo.beginRun({
      regionName: run.regionName,
      bbox: run.region.bbox,
      tileSize: run.region.tileSize,
      tileCount: run.plan.tiles.length,
      relist: run.relist,
      startedAt,
      abandonBefore: toMoment(new Date(Date.parse(startedAt) - ABANDONMENT_AGE_SECONDS * 1000)),
      counts: ZERO_RUN_COUNTS,
    });
    if (!begun.ok) return failedReport(begun.failure.message, run.regionName, startedAt);

    const value = begun.value;
    switch (value.kind) {
      case 'run_in_progress':
        return failedReport(
          runInProgressMessage(run.regionName, value.runId, value.lastActivity),
          run.regionName,
          startedAt,
        );
      case 'region_changed':
        return failedReport(
          regionChangedMessage(run.regionName, value.passNumber),
          run.regionName,
          startedAt,
        );
      case 'started':
        for (const abandoned of value.abandonedRunIds) {
          progress(`Marked run ${String(abandoned)} as abandoned`);
        }
        progress(startedLine(value.runId, run.regionName, value.pass));
        return await runStarted({
          run,
          started: value,
          repo,
          deps,
          clock,
          startMs,
          startedAt,
          progress,
        });
      default: {
        const unreachable: never = value;
        return unreachable;
      }
    }
  } finally {
    await repo.close();
  }
}

export const runCrawl: RunCrawlFn = async (request, deps) => {
  const clock = deps.clock ?? createSystemCrawlClock(deps.signal);
  try {
    return await runGuarded(request, deps, clock);
  } catch {
    try {
      return failedReport(
        INTERNAL_ERROR_MESSAGE,
        requestedRegionName(request),
        toMoment(clock.now()),
      );
    } catch {
      return failedReport(INTERNAL_ERROR_MESSAGE, undefined, toMoment(new Date(0)));
    }
  }
};
