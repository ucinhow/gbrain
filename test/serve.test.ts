import { afterEach, describe, expect, test } from 'bun:test';
import { parseServeArgs } from '../src/commands/serve.ts';

const ORIGINAL_ENV = {
  GBRAIN_MCP_HOST: process.env.GBRAIN_MCP_HOST,
  GBRAIN_MCP_PORT: process.env.GBRAIN_MCP_PORT,
  GBRAIN_MCP_PATH: process.env.GBRAIN_MCP_PATH,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => restoreEnv());

describe('serve args', () => {
  test('defaults HTTP MCP to all interfaces port 8787 path /mcp', () => {
    delete process.env.GBRAIN_MCP_HOST;
    delete process.env.GBRAIN_MCP_PORT;
    delete process.env.GBRAIN_MCP_PATH;

    expect(parseServeArgs([])).toEqual({
      http: true,
      host: '0.0.0.0',
      port: 8787,
      path: '/mcp',
    });
  });

  test('CLI flags override HTTP MCP defaults', () => {
    expect(parseServeArgs(['--http', '--host', '0.0.0.0', '--port', '8788', '--path', '/brain'])).toEqual({
      http: true,
      host: '0.0.0.0',
      port: 8788,
      path: '/brain',
    });
  });

  test('environment variables configure HTTP MCP defaults', () => {
    process.env.GBRAIN_MCP_HOST = '0.0.0.0';
    process.env.GBRAIN_MCP_PORT = '9999';
    process.env.GBRAIN_MCP_PATH = '/custom-mcp';

    expect(parseServeArgs([])).toEqual({
      http: true,
      host: '0.0.0.0',
      port: 9999,
      path: '/custom-mcp',
    });
  });

  test('uses stdio only when requested', () => {
    expect(parseServeArgs(['--stdio'])).toMatchObject({ http: false });
  });

  test('rejects conflicting transport flags', () => {
    expect(() => parseServeArgs(['--http', '--stdio'])).toThrow('Use either --http or --stdio');
  });

  test('rejects invalid port', () => {
    expect(() => parseServeArgs(['--port', '70000'])).toThrow('Invalid --port');
  });
});
