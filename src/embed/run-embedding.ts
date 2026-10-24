/**
 * The Embedding Run (AL4 embeddings 1.2, 1.4.2): before-start checks, one Embedding Store per
 * Run, the scan-and-send loop and the report. Never rejects: every way a Run can end is an
 * EmbeddingRunReport. No error's own message, key, URL, connection string or Place Document
 * ever reaches a message or a progress line.
 */
import {
  EMBEDDING_OUTCOME_LABELS,
  FAILED_PLACE_LABELS,
  MAX_PLACES_PER_STORE_CALL,
  documentFingerprint,
  isEmbeddingDue,
} from '../../contracts/embeddings.schema';
import type {
  EmbeddingClock,
  EmbeddingDependencies,
  EmbeddingRunReport,
  EmbeddingRunRequest,
  EmbeddingService,
  RunEmbeddingFn,
} from '../../contracts/embeddings.schema';
import { toMoment } from '../../contracts/hydration.schema';
import { createEmbeddingStore } from '../db/embedding-store';
import { createSystemCrawlClock } from '../crawl/runtime';
import { cutBatch } from './batches';
import { buildPlaceDocument } from './place-document';
import { buildReport, createTally, failedReport } from './report';
import { sendBatch } from './send-batch';
import { MISSING_KEY_MESSAGE, isMissingApiKey, resolveSettings } from './settings';
import { createVoyageEmbeddingService } from './voyage-service';
import type { DueItem, RunLoopContext, Stop } from './types';

const INTERNAL_ERROR_MESSAGE = 'Embedding run failed: internal error';
const CLIENT_NOT_LOADED_MESSAGE = 'Embedding Service client could not be loaded';

/** Read through a call so a check after an await is not narrowed away by TypeScript. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function noProgress(): void {
  // Progress lines are optional.
}

/** Keeps the first stop; prints `Stopping: <label>` only when the stop is first set. */
function firstStop(current: Stop | undefined, next: Stop, progress: (line: string) => void): Stop {
  if (current !== undefined) return current;
  progress(`Stopping: ${EMBEDDING_OUTCOME_LABELS[next.outcome]}`);
  return next;
}

/** The scan-and-send loop (AL4 1.4.2). Returns the stop, if any. */
async function scanAndSend(ctx: RunLoopContext): Promise<Stop | undefined> {
  const { service, store, clock, signal, settings, tally, progress } = ctx;
  const queue: DueItem[] = [];
  let room = settings.embeddingLimit;
  let after: number | undefined;
  let scanDone = false;
  let scanHalted = false;
  let stop: Stop | undefined;
  let batchNumber = 0;

  for (;;) {
    // The loop ends once the scan is done or halted, so every pass reads one page.
    const r = await store.listEmbeddingCandidates({
      limit: MAX_PLACES_PER_STORE_CALL,
      ...(after !== undefined ? { afterPlaceId: after } : {}),
    });
    if (!r.ok) {
      stop = firstStop(stop, { outcome: 'failed', message: r.failure.message }, progress);
      scanHalted = true;
    } else {
      const { places } = r.value;
      for (const candidate of places) {
        const document = buildPlaceDocument(candidate.place);
        if (document === '') {
          tally.considered('empty');
        } else if (!isEmbeddingDue(document, candidate.embeddingRecord)) {
          tally.considered('unchanged');
        } else {
          tally.considered('due');
          if (stop !== undefined) continue;
          if (room === 0) {
            tally.limitHeld += 1;
          } else {
            queue.push({
              placeId: candidate.place.placeId,
              document,
              fingerprint: documentFingerprint(document),
            });
          }
        }
      }
      const last = places.at(-1);
      if (last !== undefined) after = last.place.placeId;
      scanDone = places.length < MAX_PLACES_PER_STORE_CALL;
    }

    while (stop === undefined) {
      const n = cutBatch(queue, room, settings.batchTokenLimit, scanDone);
      if (n === 0) break;
      if (isAborted(signal)) {
        stop = firstStop(stop, { outcome: 'interrupted' }, progress);
        scanHalted = true;
        break;
      }
      const items = queue.splice(0, n);
      room -= n;
      batchNumber += 1;
      const label = `Batch ${String(batchNumber)}`;
      const result = await sendBatch(
        { service, store, clock, signal, tally, progress, batchNumber },
        items,
      );
      if (result.kind === 'kept') {
        progress(
          `${label}: kept ${String(items.length)} embeddings (${String(result.tokens)} tokens)`,
        );
      } else if (result.kind === 'failed') {
        tally.failed(items, result.failureKind, result.reason);
        progress(
          `${label}: ${String(items.length)} failed places (${FAILED_PLACE_LABELS[result.failureKind]})`,
        );
      } else {
        stop = firstStop(stop, result.stop, progress);
        if (stop.outcome === 'interrupted') scanHalted = true;
      }
      if (isAborted(signal) && stop === undefined) {
        stop = firstStop(stop, { outcome: 'interrupted' }, progress);
        scanHalted = true;
      }
    }

    if (room === 0 && stop === undefined) {
      tally.limitHeld += queue.length;
      queue.length = 0;
    }
    if (stop !== undefined) queue.length = 0;
    if (scanDone || scanHalted) break;
  }
  return stop;
}

async function run(
  request: EmbeddingRunRequest,
  deps: EmbeddingDependencies,
  clock: EmbeddingClock,
  startedAt: string,
): Promise<EmbeddingRunReport> {
  const progress = deps.onProgress ?? noProgress;

  const resolution = resolveSettings(request, deps.batchTokenLimit);
  if (!resolution.ok) return failedReport(resolution.message, startedAt, startedAt);
  const { settings } = resolution;

  const apiKey = deps.apiKey;
  if (apiKey === undefined || isMissingApiKey(apiKey)) {
    return failedReport(MISSING_KEY_MESSAGE, startedAt, startedAt);
  }

  if (isAborted(deps.signal)) {
    return buildReport({
      outcome: 'interrupted',
      startedAt,
      endedAt: startedAt,
      counts: createTally().snapshot(),
      failedPlaces: [],
    });
  }

  let service: EmbeddingService;
  if (deps.embeddingService !== undefined) {
    service = deps.embeddingService;
  } else {
    try {
      service = await createVoyageEmbeddingService({ apiKey: apiKey.trim() });
    } catch {
      return failedReport(CLIENT_NOT_LOADED_MESSAGE, startedAt, startedAt);
    }
  }

  const store = createEmbeddingStore({
    connectionString: deps.connectionString,
    ...(deps.onWrite !== undefined ? { onWrite: deps.onWrite } : {}),
  });
  try {
    const tally = createTally();
    const totals = await store.countEmbeddingStore();
    if (!totals.ok) {
      return failedReport(totals.failure.message, startedAt, toMoment(clock.now()));
    }
    tally.summaryOnlySkipped = totals.value.summaryOnlyPlaces;
    progress(
      `Embedding run started: ${String(tally.summaryOnlySkipped)} summary-only places skipped`,
    );

    const stop = await scanAndSend({
      service,
      store,
      clock,
      signal: deps.signal,
      settings,
      tally,
      progress,
    });
    const endedAt = toMoment(clock.now());
    const outcome = stop?.outcome ?? (tally.limitHeld > 0 ? 'limit_reached' : 'completed');
    return buildReport({
      outcome,
      ...(stop?.message !== undefined ? { message: stop.message } : {}),
      startedAt,
      endedAt,
      counts: tally.snapshot(),
      failedPlaces: tally.failures,
    });
  } finally {
    await store.close();
  }
}

/** Current moment for the internal-error report; never throws. */
function safeMoment(clock: EmbeddingClock | undefined): string {
  try {
    if (clock !== undefined) return toMoment(clock.now());
  } catch {
    // Fall back to real time below.
  }
  return toMoment(new Date());
}

export const runEmbedding: RunEmbeddingFn = async (request, deps) => {
  let clock: EmbeddingClock | undefined;
  let startedAt: string | undefined;
  try {
    clock = deps.clock ?? createSystemCrawlClock(deps.signal);
    startedAt = toMoment(clock.now());
    return await run(request, deps, clock, startedAt);
  } catch {
    const now = safeMoment(clock);
    return failedReport(INTERNAL_ERROR_MESSAGE, startedAt ?? now, now);
  }
};
