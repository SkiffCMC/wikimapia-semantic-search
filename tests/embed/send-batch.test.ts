/**
 * AL2 unit tests: `sendBatch` (`src/embed/send-batch.ts`, AL4 embeddings 1.4.4). Only what the
 * contract tests do not reach: an interrupt around the retry wait and the store refusing the
 * records as invalid data. Simulated service and clock, stub store; no database, no network.
 */
import { createTally } from '../../src/embed/report';
import { sendBatch } from '../../src/embed/send-batch';
import type { DueItem, SendContext } from '../../src/embed/types';
import { documentFingerprint } from '../../contracts/embeddings.schema';
import type { EmbeddingStore, SaveEmbeddingRecordsResult } from '../../contracts/embeddings.schema';
import {
  NORMAL,
  RUN_START,
  SimulatedEmbeddingClock,
  SimulatedEmbeddingService,
  byAttempt,
  connectionError,
  fail,
} from '../../contracts/embeddings.support';
import type { ServiceResponder } from '../../contracts/embeddings.support';

const ITEMS: DueItem[] = [
  { placeId: 301, document: 'Name: p', fingerprint: documentFingerprint('Name: p') },
];
const NOT_DETAILED = 'Invalid data: records[0].placeId: is not a stored Detailed Place';

function stubStore(saved: SaveEmbeddingRecordsResult): EmbeddingStore {
  const unused = (): Promise<never> => Promise.reject(new Error('not used by sendBatch'));
  return {
    listEmbeddingCandidates: unused,
    saveEmbeddingRecords: () => Promise.resolve(saved),
    readEmbeddingRecord: unused,
    countEmbeddingStore: unused,
    inspectEmbeddingStorage: unused,
    close: () => Promise.resolve(),
  };
}

function context(responder: ServiceResponder, signal?: AbortSignal, onSleep?: () => void) {
  const clock = new SimulatedEmbeddingClock(RUN_START, onSleep === undefined ? {} : { onSleep });
  const service = new SimulatedEmbeddingService(clock, responder);
  const store = stubStore({ ok: true, value: { saved: 1 } });
  const ctx: SendContext = {
    service,
    store,
    clock,
    signal,
    tally: createTally(),
    progress: () => undefined,
    batchNumber: 1,
  };
  return { ctx, clock, service };
}

it.each([
  ['aborted before the wait', true, 0],
  ['aborted during the wait', false, 1],
])(
  'a connection failure %s stops interrupted without a second request',
  async (_label, before, sleeps) => {
    const controller = new AbortController();
    if (before) controller.abort();
    const { ctx, clock, service } = context(
      byAttempt(fail(connectionError()), NORMAL),
      controller.signal,
      () => {
        controller.abort();
      },
    );

    expect(await sendBatch(ctx, ITEMS)).toStrictEqual({
      kind: 'stopped',
      stop: { outcome: 'interrupted' },
    });
    expect(service.calls).toHaveLength(1);
    expect(clock.sleeps).toHaveLength(sleeps);
  },
);

it('records the store refuses as invalid data fail the Batch with the store message', async () => {
  const { ctx } = context(() => NORMAL);
  ctx.store = stubStore({
    ok: false,
    failure: {
      kind: 'invalid_data',
      message: NOT_DETAILED,
      issues: [{ path: ['records', 0, 'placeId'], message: 'is not a stored Detailed Place' }],
    },
  });

  expect(await sendBatch(ctx, ITEMS)).toStrictEqual({
    kind: 'failed',
    failureKind: 'invalid_data',
    reason: `the Place Store rejected the Embedding Records: ${NOT_DETAILED}`,
  });
  expect(ctx.tally.snapshot().tokensUsed).toBe(0);
});
