/**
 * AL2 unit tests: `src/embed/batches.ts` (AL4 embeddings 1.4.3, U4; AC-27, AC-28, AC-29 .. AC-32
 * cutting side). AL3 routing 20261023-embeddings-04-run-core, section 2.1.
 *
 * Pure: no database, no network, no fixture files. Every Due Item is built here from synthetic
 * strings; every split the driver produces is checked with the contract's `findBatchIssues`.
 */
import { cutBatch } from '../../src/embed/batches';
import type { DueItem } from '../../src/embed/types';
import {
  DEFAULT_BATCH_TOKEN_LIMIT,
  VOYAGE_MAX_TEXTS_PER_REQUEST,
  documentFingerprint,
  estimateDocumentTokens,
  findBatchIssues,
} from '../../contracts/embeddings.schema';

function item(placeId: number, document: string): DueItem {
  return { placeId, document, fingerprint: documentFingerprint(document) };
}

/** `count` items of equal size: `Name: place 0001`, `Name: place 0002`, ... */
function equalItems(count: number, firstId = 1): DueItem[] {
  return Array.from({ length: count }, (_, i) =>
    item(firstId + i, `Name: place ${String(firstId + i).padStart(5, '0')}`),
  );
}

function first(items: readonly DueItem[]): DueItem {
  const head = items[0];
  if (head === undefined) throw new Error('empty item list');
  return head;
}

/**
 * Test-local driver: cut Batches from the front of the queue with `scanDone` true until
 * `cutBatch` returns 0, lowering `room` by every Batch taken.
 */
function drive(queue: readonly DueItem[], room: number, tokenLimit: number): DueItem[][] {
  const batches: DueItem[][] = [];
  let rest = [...queue];
  let left = room;
  for (;;) {
    const n = cutBatch(rest, left, tokenLimit, true);
    if (n === 0) break;
    batches.push(rest.slice(0, n));
    rest = rest.slice(n);
    left -= n;
  }
  return batches;
}

function expectValidSplit(batches: readonly DueItem[][], tokenLimit: number): void {
  const texts = batches.map((b) => b.map((i) => i.document));
  const documents = batches.flat().map((i) => i.document);
  expect(findBatchIssues(texts, documents, tokenLimit)).toStrictEqual([]);
}

describe('AC-27 at most 1,000 per Batch', () => {
  it('2,500 equal small items with room 3,000 give 1000, 1000, 500 in queue order', () => {
    const queue = equalItems(2500);
    const batches = drive(queue, 3000, DEFAULT_BATCH_TOKEN_LIMIT);
    expect(batches.map((b) => b.length)).toStrictEqual([1000, 1000, 500]);
    expect(batches.flat().map((i) => i.placeId)).toStrictEqual(queue.map((i) => i.placeId));
    expect(VOYAGE_MAX_TEXTS_PER_REQUEST).toBe(1000);
    expectValidSplit(batches, DEFAULT_BATCH_TOKEN_LIMIT);
    expect(
      findBatchIssues(
        batches.map((b) => b.map((i) => i.document)),
        queue.map((i) => i.document),
        DEFAULT_BATCH_TOKEN_LIMIT,
      ),
    ).toStrictEqual([]);
  });
});

describe('AC-28 Batch Token Limit', () => {
  it('a limit equal to the estimate of exactly 2 items splits 5 items into 2, 2, 1', () => {
    const queue = equalItems(5);
    const tokenLimit = 2 * estimateDocumentTokens(first(queue).document);
    const batches = drive(queue, 3000, tokenLimit);
    expect(batches.map((b) => b.length)).toStrictEqual([2, 2, 1]);
    expect(batches.flat().map((i) => i.placeId)).toStrictEqual(queue.map((i) => i.placeId));
    expectValidSplit(batches, tokenLimit);
  });

  it('a limit one token below 2 items puts every item alone', () => {
    const queue = equalItems(3);
    const tokenLimit = 2 * estimateDocumentTokens(first(queue).document) - 1;
    const batches = drive(queue, 3000, tokenLimit);
    expect(batches.map((b) => b.length)).toStrictEqual([1, 1, 1]);
    expectValidSplit(batches, tokenLimit);
  });
});

describe('oversize Place Document', () => {
  const tokenLimit = 100;
  const big = item(900, 'x'.repeat(200));
  const small = item(901, 'a');

  it('the fixture item is oversize and the small one is not', () => {
    expect(estimateDocumentTokens(big.document)).toBeGreaterThan(tokenLimit);
    expect(estimateDocumentTokens(small.document)).toBeLessThan(tokenLimit);
  });

  it('first in the queue, it is taken alone', () => {
    expect(cutBatch([big], 10, tokenLimit, true)).toBe(1);
    expect(cutBatch([big, small], 10, tokenLimit, true)).toBe(1);
    const batches = drive([big, small], 10, tokenLimit);
    expect(batches.map((b) => b.map((i) => i.placeId))).toStrictEqual([[900], [901]]);
    expectValidSplit(batches, tokenLimit);
  });

  it('after a small one, the small one is cut first, then the oversize one alone', () => {
    expect(cutBatch([small, big], 10, tokenLimit, true)).toBe(1);
    const batches = drive([small, big], 10, tokenLimit);
    expect(batches.map((b) => b.map((i) => i.placeId))).toStrictEqual([[901], [900]]);
    expectValidSplit(batches, tokenLimit);
  });
});

describe('room caps the Batch (AC-29 .. AC-32 cutting side)', () => {
  it('room 3 with 5 items returns 3', () => {
    expect(cutBatch(equalItems(5), 3, DEFAULT_BATCH_TOKEN_LIMIT, true)).toBe(3);
  });

  it('room 3 with 5 items: the driver sends one Batch of 3 and stops', () => {
    const batches = drive(equalItems(5), 3, DEFAULT_BATCH_TOKEN_LIMIT);
    expect(batches.map((b) => b.length)).toStrictEqual([3]);
    expectValidSplit(batches, DEFAULT_BATCH_TOKEN_LIMIT);
  });

  it('room 0 returns 0', () => {
    expect(cutBatch(equalItems(5), 0, DEFAULT_BATCH_TOKEN_LIMIT, true)).toBe(0);
    expect(cutBatch(equalItems(5), 0, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(0);
  });

  it('an empty queue returns 0', () => {
    expect(cutBatch([], 10, DEFAULT_BATCH_TOKEN_LIMIT, true)).toBe(0);
    expect(cutBatch([], 10, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(0);
  });

  it('room 1,500 with 2,500 items gives 1000 then 500', () => {
    const batches = drive(equalItems(2500), 1500, DEFAULT_BATCH_TOKEN_LIMIT);
    expect(batches.map((b) => b.length)).toStrictEqual([1000, 500]);
    expectValidSplit(batches, DEFAULT_BATCH_TOKEN_LIMIT);
  });
});

describe('open Batch while the scan is not done', () => {
  it('a queue that fits in one Batch returns 0 with scanDone false and all with scanDone true', () => {
    const queue = equalItems(5);
    expect(cutBatch(queue, 3000, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(0);
    expect(cutBatch(queue, 3000, DEFAULT_BATCH_TOKEN_LIMIT, true)).toBe(5);
  });

  it('a queue whose next item does not fit returns the closed count with scanDone false', () => {
    const queue = equalItems(5);
    const tokenLimit = 2 * estimateDocumentTokens(first(queue).document);
    expect(cutBatch(queue, 3000, tokenLimit, false)).toBe(2);
    const oversizeNext = [item(1, 'a'), item(2, 'x'.repeat(200))];
    expect(cutBatch(oversizeNext, 3000, 100, false)).toBe(1);
  });

  it('a queue of 1,000 or more items returns 1,000 with scanDone false', () => {
    expect(cutBatch(equalItems(1000), 3000, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(1000);
    expect(cutBatch(equalItems(1001), 3000, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(1000);
  });

  it('room smaller than the queue returns the room with scanDone false', () => {
    expect(cutBatch(equalItems(5), 3, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(3);
  });

  it('room equal to the queue length returns the room with scanDone false', () => {
    expect(cutBatch(equalItems(5), 5, DEFAULT_BATCH_TOKEN_LIMIT, false)).toBe(5);
  });
});

describe('purity', () => {
  it('cutBatch does not change the queue', () => {
    const queue = [item(1, 'a'), item(2, 'x'.repeat(200)), ...equalItems(5, 3)];
    const copy = structuredClone(queue);
    cutBatch(queue, 3, 100, true);
    cutBatch(queue, 3000, 100, false);
    cutBatch(queue, 0, 100, true);
    expect(queue).toStrictEqual(copy);
  });

  it('the same input gives the same count', () => {
    const queue = equalItems(7);
    const tokenLimit = 3 * estimateDocumentTokens(first(queue).document);
    expect(cutBatch(queue, 10, tokenLimit, true)).toBe(cutBatch(queue, 10, tokenLimit, true));
  });
});
