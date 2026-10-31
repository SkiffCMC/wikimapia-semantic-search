/**
 * AL5 CONTRACT TESTS: Hybrid Search, the Search Command as the Developer runs it through pnpm.
 *
 * Layer:    AL5 (Contracts).
 * Derives:  docs/al6-requirements/20261027-hybrid-search-al6.md (revision 4: AC-72, rule 13,
 *           decision Q11 and its follow-up in section 6.2 item 14, section 5 "AC-72 ... must run
 *           the documented form through pnpm"). The pnpm in use is whatever the project has
 *           installed; no pnpm version is checked (revision 4).
 * Enforces: .agrules section 4 ("No Live External Calls in Tests": the npm registry is pointed
 *           at an unreachable local address and every global `fetch` in the spawned processes
 *           is blocked and reported; no API key or database URL is handed to the command),
 *           "Strict Types Only".
 *
 * Subject under test, never doubled: the project's `search` script (SEARCH_SCRIPT) run by the
 * real pnpm from the project root, i.e. `package.json` -> `tsx scripts/search.ts` ->
 * `runSearchCommand`. The usage failure comes before the Embedding Service, the key and the
 * Place Store (AC-44), so this file needs no database, no key and no network.
 *
 * Windows: `pnpm` is a `pnpm.cmd` shim there, which `spawn` can only start through a shell, so
 * the command is run as one string with `shell: true` (cmd.exe on Windows, /bin/sh elsewhere);
 * every argument is a fixed literal, nothing is interpolated from input.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DATABASE_URL_ENV,
  SEARCH_COMMAND_FORM,
  SEARCH_SCRIPT,
  VOYAGE_API_KEY_ENV,
  isSearchUsageLine,
} from './hybrid-search.schema';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Port 9 (discard) on loopback: any npm registry request fails locally, never leaves the host. */
const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9/';

/** Printed to stderr by the preload below whenever any process in the run calls `fetch`. */
const FETCH_BLOCKED_MARKER = 'AC72_FETCH_BLOCKED';

/** Preloaded into every Node process of the run (pnpm, tsx, the command): blocks `fetch`. */
const BLOCK_FETCH_PRELOAD =
  `globalThis.fetch = () => { process.stderr.write('${FETCH_BLOCKED_MARKER}\\n'); ` +
  `return Promise.reject(new Error('network is disabled in AC-72')); };`;

/**
 * What an npm registry search (the AL1 bug: `pnpm search ...` handed to npm) prints: its result
 * table or "No matches found", or, with the unreachable registry, an npm error naming the
 * registry or the connection failure.
 */
const NPM_REGISTRY_SEARCH_OUTPUT =
  /npm (error|ERR!|warn)|No matches found|registry|ECONNREFUSED|ENOTCACHED|ETIMEDOUT|NAME\s+\|\s+DESCRIPTION/i;

/** Environment variables never handed to the spawned run (keys, database URLs, npm/pnpm run state). */
function isWithheld(key: string): boolean {
  const k = key.toUpperCase();
  return (
    k === VOYAGE_API_KEY_ENV ||
    k === DATABASE_URL_ENV ||
    k.endsWith('_API_KEY') ||
    k.includes('DATABASE_URL') ||
    k.startsWith('NPM_') ||
    k === 'NODE_OPTIONS' ||
    k === 'INIT_CWD'
  );
}

function testSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isWithheld(key)) env[key] = value;
  }
  return {
    ...env,
    npm_config_registry: UNREACHABLE_REGISTRY,
    npm_config_update_notifier: 'false',
    COREPACK_ENABLE_NETWORK: '0',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(BLOCK_FETCH_PRELOAD).toString('base64')}`,
  };
}

interface PnpmRun {
  status: number | null;
  lines: string[];
  text: string;
}

/** Runs `pnpm <args>` from the project root; `args` is a fixed literal of this file. */
function runPnpm(args: string): PnpmRun {
  const run = spawnSync(`pnpm ${args}`, {
    cwd: PROJECT_ROOT,
    env: testSafeEnv(),
    shell: true,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  if (run.error !== undefined) throw run.error;
  // Strip ANSI colour codes in case a tool ignores NO_COLOR.
  // eslint-disable-next-line no-control-regex
  const text = `${run.stdout}\n${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  return { status: run.status, lines: text.split(/\r?\n/), text };
}

describe('AC-72 Documented form reaches the Search Command', () => {
  it.each([
    ['`pnpm run search --fast` (the AC-72 command)', `run ${SEARCH_SCRIPT.name} --fast`],
    [
      '`pnpm run search -- --fast` (a `--` passed through by pnpm)',
      `run ${SEARCH_SCRIPT.name} -- --fast`,
    ],
  ])(
    `%s: the Search Command's usage failure showing \`${SEARCH_COMMAND_FORM}\`, nothing from the npm registry`,
    (_, args) => {
      const { status, lines, text } = runPnpm(args);
      expect(status).not.toBeNull();
      expect(status).not.toBe(0);
      expect(lines.some(isSearchUsageLine)).toBe(true);
      expect(text).not.toMatch(NPM_REGISTRY_SEARCH_OUTPUT);
      expect(text).not.toContain(FETCH_BLOCKED_MARKER);
    },
    90_000,
  );
});
