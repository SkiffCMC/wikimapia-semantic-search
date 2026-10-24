/**
 * AL2 unit tests: `src/db/connection.ts` (AL4 1.4.2). The contract tests cover unreachable
 * servers and closing; here: the per-connection int8 parser, on its own and through
 * `selectBigint` against the Test Database.
 */
import {
  POOL_MAX_SETUP,
  createDb,
  destroyQuietly,
  parseSafeInt8,
  selectBigint,
} from '../../src/db/connection';
import { requireTestDatabaseUrl } from '../../contracts/storage.support';

const db = createDb(requireTestDatabaseUrl(), POOL_MAX_SETUP);
afterAll(() => destroyQuietly(db));

it.each(['9007199254740991', '-42'])('int8 %s reads back as a JS number', async (text) => {
  expect(parseSafeInt8(text)).toBe(Number(text));
  expect(await selectBigint(db, text)).toBe(Number(text));
});

it('an unsafe int8 is rejected', async () => {
  const message = 'int8 value is not a safe integer';
  expect(() => parseSafeInt8('9007199254740993')).toThrow(message);
  await expect(selectBigint(db, '9007199254740993')).rejects.toThrow(message);
});
