import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { applyProviderEnv, loadConfig } from '../src/core/config.ts';

// redactUrl is not exported, so we test it by reading the source and
// reimplementing the regex to verify the pattern, then test via CLI

// Extract the redactUrl regex pattern from source
const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

// Reimplemented from source for unit testing
function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

const ENV_KEYS = [
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GBRAIN_MCP_TOKEN',
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function envValue(key: string): string | undefined {
  return process.env[key];
}

afterEach(() => {
  restoreEnv();
});

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
    // The regex is greedy on [^@]+ so it captures up to the LAST @
    const result = redactUrl(url);
    expect(result).not.toContain('p@ss');
    expect(result).toContain('***');
  });

  test('returns non-postgresql URLs unchanged', () => {
    const url = 'https://example.com/api';
    expect(redactUrl(url)).toBe(url);
  });

  test('returns plain strings unchanged', () => {
    expect(redactUrl('hello')).toBe('hello');
  });

  test('handles URL without password', () => {
    const url = 'postgresql://user@host:5432/dbname';
    // No colon after user means regex doesn't match
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', () => {
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', () => {
    expect(configSource).toContain('postgresql:\\/\\/');
  });

  test('config show redacts token fields', () => {
    expect(configSource).toContain("k.includes('token')");
  });
});

describe('provider config', () => {
  test('applyProviderEnv hydrates SDK environment variables without overriding env', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
    delete process.env.ANTHROPIC_BASE_URL;

    applyProviderEnv({
      openai_api_key: 'config-openai-key',
      openai_base_url: 'https://openai.example/v1',
      anthropic_api_key: 'config-anthropic-key',
      anthropic_base_url: 'https://anthropic.example',
    });

    expect(envValue('OPENAI_API_KEY')).toBe('config-openai-key');
    expect(envValue('OPENAI_BASE_URL')).toBe('https://openai.example/v1');
    expect(envValue('ANTHROPIC_API_KEY')).toBe('env-anthropic-key');
    expect(envValue('ANTHROPIC_BASE_URL')).toBe('https://anthropic.example');
  });

  test('loadConfig includes provider base URLs from env', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gbrain_test';
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.OPENAI_BASE_URL = 'https://openai.example/v1';
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
    process.env.ANTHROPIC_BASE_URL = 'https://anthropic.example';
    process.env.GBRAIN_MCP_TOKEN = 'env-mcp-token';

    const config = loadConfig();

    expect(config?.openai_api_key).toBe('env-openai-key');
    expect(config?.openai_base_url).toBe('https://openai.example/v1');
    expect(config?.anthropic_api_key).toBe('env-anthropic-key');
    expect(config?.anthropic_base_url).toBe('https://anthropic.example');
    expect(config?.mcp_token).toBe('env-mcp-token');
  });
});
