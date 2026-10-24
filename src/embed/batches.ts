/**
 * Greedy Batch cutting (AL4 embeddings 1.4.3; AC-27, AC-28, approved decision 4). Pure: returns
 * how many items to take from the front of the queue now and never changes the queue.
 */
import {
  VOYAGE_MAX_TEXTS_PER_REQUEST,
  estimateDocumentTokens,
} from '../../contracts/embeddings.schema';
import type { DueItem } from './types';

/** Items to take now; 0 = none yet (an open Batch waits for the next page unless `scanDone`). */
export function cutBatch(
  queue: readonly DueItem[],
  room: number,
  tokenLimit: number,
  scanDone: boolean,
): number {
  const cap = Math.min(VOYAGE_MAX_TEXTS_PER_REQUEST, room);
  if (cap <= 0 || queue.length === 0) return 0;
  let size = 0;
  let n = 0;
  for (const item of queue) {
    if (n === cap) return n;
    const est = estimateDocumentTokens(item.document);
    if (n > 0 && size + est > tokenLimit) return n;
    size += est;
    n += 1;
  }
  if (n === cap) return n;
  return scanDone ? n : 0;
}
