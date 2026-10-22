/**
 * Writer and fault hook (AL4 1.4.7; AC-15, AC-56 seam). Executes one write statement, numbers
 * it (1-based, per writer) and then awaits the `onWrite` hook with that number. Any error, from
 * the statement or from the hook (synchronous throw or rejection), propagates unchanged.
 * Pure: no Knex, no SQL.
 */
import type { WriteHook } from '../../contracts/storage.schema';
import type { Writer } from './types';

export function createWriter(onWrite: WriteHook | undefined): Writer {
  let count = 0;
  return {
    async run(statement: PromiseLike<unknown>): Promise<void> {
      await statement;
      count += 1;
      if (onWrite !== undefined) await onWrite(count);
    },
    get count(): number {
      return count;
    },
  };
}
