/**
 * AL2 unit tests: `src/db/writer.ts` (AL4 1.4.7; embeddings AL4 0.1 "Write-hook numbering").
 * The contract tests use the hook only to fail the nth write of one save; here: the count,
 * that a failing statement is not counted, and one run-wide numbering across writers.
 */
import { createRunWideHook, createWriter } from '../../src/db/writer';

const done = (): Promise<unknown> => Promise.resolve();

it('numbers successful statements per writer; a failing statement is not counted', async () => {
  const calls: number[] = [];
  const writer = createWriter((n) => {
    calls.push(n);
  });
  await writer.run(done());
  const error = new Error('duplicate key');
  await expect(writer.run(Promise.reject(error))).rejects.toBe(error);
  await writer.run(done());
  expect(calls).toStrictEqual([1, 2]);
  expect(writer.count).toBe(2);
  expect(createWriter(undefined).count).toBe(0);
});

describe('createRunWideHook', () => {
  it('without a hook gives none', () => {
    expect(createRunWideHook(undefined)).toBeUndefined();
  });

  it('numbers writes across every writer built on it', async () => {
    const calls: number[] = [];
    const hook = createRunWideHook((n) => {
      calls.push(n);
    });
    const a = createWriter(hook);
    const b = createWriter(hook);
    await a.run(done());
    await b.run(done());
    await a.run(done());
    expect(calls).toStrictEqual([1, 2, 3]);
    expect([a.count, b.count]).toStrictEqual([2, 1]);
  });
});
