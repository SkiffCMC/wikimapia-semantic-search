/**
 * AL2 unit tests: `src/embed/settings.ts` (AL4 embeddings 1.4.5, U4; AC-40, AC-41). AL3 routing
 * 20261023-embeddings-04-run-core, section 2.1.
 *
 * Pure: no database, no network, no fixture files. Only synthetic key strings.
 */
import {
  MISSING_KEY_MESSAGE,
  isMissingApiKey,
  resolveSettings,
  usageMessage,
} from '../../src/embed/settings';
import type { Resolution } from '../../src/embed/types';
import {
  DEFAULT_BATCH_TOKEN_LIMIT,
  DEFAULT_EMBEDDING_LIMIT,
  EMBED_COMMAND_OPTIONS,
  VOYAGE_API_KEY_ENV,
} from '../../contracts/embeddings.schema';

const SYNTHETIC_KEY = 'TEST_VOYAGE_API_KEY';

function messageOf(resolution: Resolution): string {
  if (resolution.ok) throw new Error('expected an invalid setting');
  return resolution.message;
}

describe('resolveSettings: defaults and given values', () => {
  it('an empty request without a Batch Token Limit gives the defaults', () => {
    expect(DEFAULT_EMBEDDING_LIMIT).toBe(1000);
    expect(DEFAULT_BATCH_TOKEN_LIMIT).toBe(320_000);
    expect(resolveSettings({}, undefined)).toStrictEqual({
      ok: true,
      settings: {
        embeddingLimit: DEFAULT_EMBEDDING_LIMIT,
        batchTokenLimit: DEFAULT_BATCH_TOKEN_LIMIT,
      },
    });
  });

  it('given values are passed through', () => {
    expect(resolveSettings({ embeddingLimit: 3 }, 500)).toStrictEqual({
      ok: true,
      settings: { embeddingLimit: 3, batchTokenLimit: 500 },
    });
  });

  it('only the Embedding Limit given: the Batch Token Limit defaults', () => {
    expect(resolveSettings({ embeddingLimit: 7 }, undefined)).toStrictEqual({
      ok: true,
      settings: { embeddingLimit: 7, batchTokenLimit: DEFAULT_BATCH_TOKEN_LIMIT },
    });
  });

  it('only the Batch Token Limit given: the Embedding Limit defaults', () => {
    expect(resolveSettings({}, 42)).toStrictEqual({
      ok: true,
      settings: { embeddingLimit: DEFAULT_EMBEDDING_LIMIT, batchTokenLimit: 42 },
    });
  });
});

describe('resolveSettings: invalid embeddingLimit (AC-41)', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'embeddingLimit %s fails naming embeddingLimit only',
    (embeddingLimit) => {
      const resolution = resolveSettings({ embeddingLimit }, undefined);
      expect(resolution.ok).toBe(false);
      const message = messageOf(resolution);
      expect(message).toContain('embeddingLimit');
      expect(message).not.toContain('batchTokenLimit');
    },
  );

  it.each([0, -1, 1.5])('embeddingLimit %s: message has the setting-message form', (value) => {
    const message = messageOf(resolveSettings({ embeddingLimit: value }, undefined));
    expect(message.startsWith('Invalid embedding setting "embeddingLimit": ')).toBe(true);
    expect(message.length).toBeGreaterThan('Invalid embedding setting "embeddingLimit": '.length);
  });
});

describe('resolveSettings: invalid batchTokenLimit (AC-41)', () => {
  it.each([0, 2.5])('batchTokenLimit %s with a valid request fails naming it', (limit) => {
    const resolution = resolveSettings({ embeddingLimit: 3 }, limit);
    expect(resolution.ok).toBe(false);
    const message = messageOf(resolution);
    expect(message).toContain('batchTokenLimit');
    expect(message.startsWith('Invalid embedding setting "batchTokenLimit": ')).toBe(true);
  });

  it('batchTokenLimit 0 with an empty request fails naming it', () => {
    expect(messageOf(resolveSettings({}, 0))).toContain('batchTokenLimit');
  });
});

describe('resolveSettings: messages carry no input value', () => {
  it.each([-1, 1.5])('embeddingLimit %s does not appear in the message', (value) => {
    const message = messageOf(resolveSettings({ embeddingLimit: value }, undefined));
    expect(message).not.toContain(String(value));
  });

  it('batchTokenLimit 2.5 does not appear in the message', () => {
    const message = messageOf(resolveSettings({}, 2.5));
    expect(message).not.toContain(String(2.5));
  });
});

describe('resolveSettings: the request is checked first', () => {
  it('an invalid embeddingLimit and an invalid batchTokenLimit name embeddingLimit', () => {
    const message = messageOf(resolveSettings({ embeddingLimit: 0 }, 0));
    expect(message).toContain('embeddingLimit');
    expect(message).not.toContain('batchTokenLimit');
  });

  it('a request-level type failure (NaN) wins over an invalid batchTokenLimit', () => {
    const message = messageOf(resolveSettings({ embeddingLimit: Number.NaN }, 2.5));
    expect(message).toContain('embeddingLimit');
    expect(message).not.toContain('batchTokenLimit');
  });
});

describe('isMissingApiKey (AC-40)', () => {
  it.each([[undefined], [''], ['   '], [' \t ']])('%j is missing', (key) => {
    expect(isMissingApiKey(key)).toBe(true);
  });

  it.each([[SYNTHETIC_KEY], [`  ${SYNTHETIC_KEY}  `]])('%j is present', (key) => {
    expect(isMissingApiKey(key)).toBe(false);
  });
});

describe('messages', () => {
  it('MISSING_KEY_MESSAGE names VOYAGE_API_KEY', () => {
    expect(MISSING_KEY_MESSAGE).toContain(VOYAGE_API_KEY_ENV);
  });

  it('usageMessage names --limit and starts with the command', () => {
    const usage = usageMessage();
    expect(usage.startsWith('Usage: pnpm embed')).toBe(true);
    expect(usage).toContain(EMBED_COMMAND_OPTIONS.limit);
  });
});
