/**
 * AL2 unit tests: `scripts/load-env.ts` (AL4 2.7 "`scripts/load-env.ts`"; U1; AC-60).
 *
 * Pure: no database, no network. Files are written to a fresh OS temp directory and
 * removed afterwards. Every value is synthetic; no real key or password is used.
 * Every `process.env` key touched here carries the `WM_LOADENV_TEST_` prefix and is
 * restored (or deleted) after each test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEnvDefaults, readEnvFile } from '../../scripts/load-env';

// ---------------------------------------------------------------------------
// Temp directory handling
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-load-env-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readEnvFile
// ---------------------------------------------------------------------------

describe('readEnvFile', () => {
  it('returns {} for a file that does not exist, without throwing', () => {
    const missing = path.join(makeTempDir(), 'does-not-exist.env');
    expect(fs.existsSync(missing)).toBe(false);

    let result: Record<string, string> | undefined;
    expect(() => {
      result = readEnvFile(missing);
    }).not.toThrow();
    expect(result).toStrictEqual({});
  });

  it('returns exactly the pairs of a small file, ignoring comments and blank lines', () => {
    const file = path.join(makeTempDir(), '.env.sample');
    fs.writeFileSync(
      file,
      [
        '# synthetic comment line',
        'WM_LOADENV_A=alpha',
        '',
        'WM_LOADENV_URL=postgres://user:pw@127.0.0.1:5433/x_test',
        'WM_LOADENV_EQ=a=b=c',
        '',
      ].join('\n'),
      'utf8',
    );

    expect(readEnvFile(file)).toStrictEqual({
      WM_LOADENV_A: 'alpha',
      WM_LOADENV_URL: 'postgres://user:pw@127.0.0.1:5433/x_test',
      WM_LOADENV_EQ: 'a=b=c',
    });
  });

  it('returns {} for a file that holds only comments and blank lines', () => {
    const file = path.join(makeTempDir(), '.env.empty');
    fs.writeFileSync(file, '# only a comment\n\n# another one\n', 'utf8');

    expect(readEnvFile(file)).toStrictEqual({});
  });

  it('does not touch process.env', () => {
    const file = path.join(makeTempDir(), '.env.isolated');
    fs.writeFileSync(file, 'WM_LOADENV_TEST_READ_ONLY=value\n', 'utf8');
    expect(process.env.WM_LOADENV_TEST_READ_ONLY).toBeUndefined();

    readEnvFile(file);

    expect(process.env.WM_LOADENV_TEST_READ_ONLY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyEnvDefaults
// ---------------------------------------------------------------------------

describe('applyEnvDefaults', () => {
  const KEYS = [
    'WM_LOADENV_TEST_SET',
    'WM_LOADENV_TEST_UNSET',
    'WM_LOADENV_TEST_EMPTY',
    'WM_LOADENV_TEST_UNSET_2',
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    saved.clear();
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('does not override a variable that is already set to a non-empty value', () => {
    process.env.WM_LOADENV_TEST_SET = 'from-shell';

    applyEnvDefaults({ WM_LOADENV_TEST_SET: 'from-file' });

    expect(process.env.WM_LOADENV_TEST_SET).toBe('from-shell');
  });

  it('fills a variable that is unset', () => {
    expect('WM_LOADENV_TEST_UNSET' in process.env).toBe(false);

    applyEnvDefaults({ WM_LOADENV_TEST_UNSET: 'filled' });

    expect('WM_LOADENV_TEST_UNSET' in process.env).toBe(true);
    expect(process.env.WM_LOADENV_TEST_UNSET).toBe('filled');
  });

  it('fills a variable that is set to the empty string', () => {
    process.env.WM_LOADENV_TEST_EMPTY = '';

    applyEnvDefaults({ WM_LOADENV_TEST_EMPTY: 'filled' });

    expect(process.env.WM_LOADENV_TEST_EMPTY).toBe('filled');
  });

  it('applies a mixed record key by key', () => {
    process.env.WM_LOADENV_TEST_SET = 'from-shell';
    process.env.WM_LOADENV_TEST_EMPTY = '';

    applyEnvDefaults({
      WM_LOADENV_TEST_SET: 'from-file-set',
      WM_LOADENV_TEST_UNSET: 'from-file-unset',
      WM_LOADENV_TEST_EMPTY: 'from-file-empty',
      WM_LOADENV_TEST_UNSET_2: 'from-file-unset-2',
    });

    expect(process.env.WM_LOADENV_TEST_SET).toBe('from-shell');
    expect(process.env.WM_LOADENV_TEST_UNSET).toBe('from-file-unset');
    expect(process.env.WM_LOADENV_TEST_EMPTY).toBe('from-file-empty');
    expect(process.env.WM_LOADENV_TEST_UNSET_2).toBe('from-file-unset-2');
  });

  it('does nothing for an empty record', () => {
    const before = { ...process.env };

    applyEnvDefaults({});

    expect({ ...process.env }).toStrictEqual(before);
  });

  it('combines with readEnvFile: file values never override non-empty shell values', () => {
    const file = path.join(makeTempDir(), '.env.combined');
    fs.writeFileSync(
      file,
      'WM_LOADENV_TEST_SET=from-file\nWM_LOADENV_TEST_UNSET=from-file\n',
      'utf8',
    );
    process.env.WM_LOADENV_TEST_SET = 'from-shell';

    applyEnvDefaults(readEnvFile(file));

    expect(process.env.WM_LOADENV_TEST_SET).toBe('from-shell');
    expect(process.env.WM_LOADENV_TEST_UNSET).toBe('from-file');
  });
});
