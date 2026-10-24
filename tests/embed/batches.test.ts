/**
 * AL2 unit tests: `cutBatch` (`src/embed/batches.ts`, AL4 embeddings 1.4.3). Only the open-Batch
 * branch the contract tests do not reach: a Batch with room left waits until the scan is done.
 */
import { cutBatch } from '../../src/embed/batches';
import type { DueItem } from '../../src/embed/types';
import { documentFingerprint } from '../../contracts/embeddings.schema';

const QUEUE: DueItem[] = [1, 2].map((placeId) => {
  const document = `Name: place ${String(placeId)}`;
  return { placeId, document, fingerprint: documentFingerprint(document) };
});

it.each([
  ['room left, scan not done: waits', 10, false, 0],
  ['room left, scan done: takes all', 10, true, 2],
  ['room filled, scan not done: takes the room', 1, false, 1],
])('%s', (_label, room, scanDone, taken) => {
  expect(cutBatch(QUEUE, room, 320_000, scanDone)).toBe(taken);
});
