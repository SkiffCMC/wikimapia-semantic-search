/**
 * AL2 unit tests: `src/db/writer.ts` (AL4 1.3 `Writer` interface and `writer.ts` block, 1.4.7
 * Writer and fault hook; AC-15, AC-56 seam). AL3 routing 20261021-storage-06-listing, 2.1 A.
 *
 * Pure: no database, no Knex, no Objection. Statements are fake `PromiseLike` values (resolved,
 * rejected or deferred promises).
 * Extended by feature `embeddings` (AL4 embeddings 0.1 "Write-hook numbering", 1.3
 * `createRunWideHook`; AL3 routing 20261023-embeddings-02-store, 2.1 B): `createRunWideHook`.
 */
import { createRunWideHook, createWriter } from '../../src/db/writer';
import type { Writer } from '../../src/db/types';
import type { WriteHook } from '../../contracts/storage.schema';

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every pending microtask and timer callback run. */
async function settle(): Promise<void> {
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

function done(): Promise<unknown> {
  return Promise.resolve({ rowCount: 1 });
}

describe('createWriter without a hook', () => {
  it('runs statements and counts 0, 1, 2, 3', async () => {
    const writer: Writer = createWriter(undefined);
    expect(writer.count).toBe(0);
    for (const expected of [1, 2, 3]) {
      await expect(writer.run(done())).resolves.toBeUndefined();
      expect(writer.count).toBe(expected);
    }
  });

  it('accepts any PromiseLike statement (a thenable)', async () => {
    const writer = createWriter(undefined);
    const thenable: PromiseLike<unknown> = {
      then(onFulfilled, onRejected) {
        return Promise.resolve('ok').then(onFulfilled, onRejected);
      },
    };
    await writer.run(thenable);
    expect(writer.count).toBe(1);
  });
});

describe('createWriter with a hook', () => {
  it('calls the hook with 1, 2, 3 in order and count matches after each run', async () => {
    const calls: number[] = [];
    const writer = createWriter((n) => {
      calls.push(n);
    });
    await writer.run(done());
    expect(calls).toStrictEqual([1]);
    expect(writer.count).toBe(1);
    await writer.run(done());
    expect(calls).toStrictEqual([1, 2]);
    expect(writer.count).toBe(2);
    await writer.run(done());
    expect(calls).toStrictEqual([1, 2, 3]);
    expect(writer.count).toBe(3);
  });

  it('calls the hook only after the statement settles', async () => {
    const hook = vi.fn<WriteHook>();
    const writer = createWriter(hook);
    const statement = deferred();
    const running = writer.run(statement.promise);
    await settle();
    expect(hook).not.toHaveBeenCalled();
    expect(writer.count).toBe(0);
    statement.resolve('written');
    await running;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(1);
    expect(writer.count).toBe(1);
  });

  it('a hook that throws synchronously at write 2 makes the second run reject with that error', async () => {
    const outage = new Error('simulated outage');
    const writer = createWriter((n) => {
      if (n === 2) throw outage;
    });
    await expect(writer.run(done())).resolves.toBeUndefined();
    await expect(writer.run(done())).rejects.toBe(outage);
  });

  it('a hook that returns a rejected promise at write 2 makes the second run reject with that error', async () => {
    const outage = new Error('simulated async outage');
    const writer = createWriter((n) => (n === 2 ? Promise.reject(outage) : Promise.resolve()));
    await expect(writer.run(done())).resolves.toBeUndefined();
    await expect(writer.run(done())).rejects.toBe(outage);
  });

  it('awaits an async hook before run resolves', async () => {
    const gate = deferred();
    let hookFinished = false;
    const writer = createWriter(async () => {
      await gate.promise;
      hookFinished = true;
    });
    let runResolved = false;
    const running = writer.run(done()).then(() => {
      runResolved = true;
    });
    await settle();
    expect(runResolved).toBe(false);
    expect(hookFinished).toBe(false);
    gate.resolve(undefined);
    await running;
    expect(hookFinished).toBe(true);
    expect(runResolved).toBe(true);
  });
});

describe('createWriter with a failing statement', () => {
  it('rejects with the statement error, does not call the hook and does not count', async () => {
    const hook = vi.fn<WriteHook>();
    const writer = createWriter(hook);
    await writer.run(done());
    expect(writer.count).toBe(1);
    const dbError = new Error('duplicate key');
    await expect(writer.run(Promise.reject(dbError))).rejects.toBe(dbError);
    expect(writer.count).toBe(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenLastCalledWith(1);
  });

  it('rejects without a hook and does not count', async () => {
    const writer = createWriter(undefined);
    const dbError = new Error('connection lost');
    await expect(writer.run(Promise.reject(dbError))).rejects.toBe(dbError);
    expect(writer.count).toBe(0);
  });
});

describe('independent writers', () => {
  it('two writers from two createWriter calls number independently', async () => {
    const callsA: number[] = [];
    const callsB: number[] = [];
    const a = createWriter((n) => {
      callsA.push(n);
    });
    const b = createWriter((n) => {
      callsB.push(n);
    });
    await a.run(done());
    await a.run(done());
    await b.run(done());
    await a.run(done());
    await b.run(done());
    expect(callsA).toStrictEqual([1, 2, 3]);
    expect(callsB).toStrictEqual([1, 2]);
    expect(a.count).toBe(3);
    expect(b.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createRunWideHook (feature `embeddings`, AL3 routing 20261023-embeddings-02-store, 2.1 B)
// ---------------------------------------------------------------------------

describe('createRunWideHook', () => {
  it('undefined in gives undefined out', () => {
    expect(createRunWideHook(undefined)).toBeUndefined();
  });

  it('one run-wide hook shared by two writers sees 1, 2, 3 across both, in order', async () => {
    const calls: number[] = [];
    const hook = createRunWideHook((n) => {
      calls.push(n);
    });
    const a = createWriter(hook);
    const b = createWriter(hook);
    await a.run(done());
    expect(calls).toStrictEqual([1]);
    await b.run(done());
    expect(calls).toStrictEqual([1, 2]);
    await a.run(done());
    expect(calls).toStrictEqual([1, 2, 3]);
    expect(a.count).toBe(2);
    expect(b.count).toBe(1);
  });

  it('a throwing inner hook makes that run reject with its error', async () => {
    const outage = new Error('simulated run-wide outage');
    const hook = createRunWideHook((n) => {
      if (n === 2) throw outage;
    });
    const a = createWriter(hook);
    const b = createWriter(hook);
    await expect(a.run(done())).resolves.toBeUndefined();
    await expect(b.run(done())).rejects.toBe(outage);
  });

  it('a rejecting inner hook makes that run reject with its error', async () => {
    const outage = new Error('simulated async run-wide outage');
    const hook = createRunWideHook(() => Promise.reject(outage));
    await expect(createWriter(hook).run(done())).rejects.toBe(outage);
  });

  it('two separate createRunWideHook calls number independently', async () => {
    const callsA: number[] = [];
    const callsB: number[] = [];
    const hookA = createRunWideHook((n) => {
      callsA.push(n);
    });
    const hookB = createRunWideHook((n) => {
      callsB.push(n);
    });
    await createWriter(hookA).run(done());
    await createWriter(hookB).run(done());
    await createWriter(hookA).run(done());
    await createWriter(hookA).run(done());
    await createWriter(hookB).run(done());
    expect(callsA).toStrictEqual([1, 2, 3]);
    expect(callsB).toStrictEqual([1, 2]);
  });
});
