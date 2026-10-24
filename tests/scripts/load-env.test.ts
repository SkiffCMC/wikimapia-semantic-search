/**
 * AL2 unit tests: `scripts/load-env.ts` (AL4 2.7). Files go to a fresh OS temp directory;
 * every `process.env` key carries the `WM_LOADENV_TEST_` prefix and is removed afterwards.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEnvDefaults, readEnvFile } from '../../scripts/load-env';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-load-env-'));
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ['SET', 'EMPTY', 'UNSET'])
    Reflect.deleteProperty(process.env, `WM_LOADENV_TEST_${key}`);
});

it('readEnvFile gives the pairs of a file and {} for a missing one', () => {
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# comment\nWM_A=alpha\n\nWM_EQ=a=b=c\n', 'utf8');
  expect(readEnvFile(file)).toStrictEqual({ WM_A: 'alpha', WM_EQ: 'a=b=c' });
  expect(readEnvFile(path.join(dir, 'missing.env'))).toStrictEqual({});
});

it('applyEnvDefaults fills only unset or empty variables', () => {
  process.env.WM_LOADENV_TEST_SET = 'shell';
  process.env.WM_LOADENV_TEST_EMPTY = '';
  applyEnvDefaults({
    WM_LOADENV_TEST_SET: 'file',
    WM_LOADENV_TEST_EMPTY: 'file',
    WM_LOADENV_TEST_UNSET: 'file',
  });
  expect([
    process.env.WM_LOADENV_TEST_SET,
    process.env.WM_LOADENV_TEST_EMPTY,
    process.env.WM_LOADENV_TEST_UNSET,
  ]).toStrictEqual(['shell', 'file', 'file']);
});
