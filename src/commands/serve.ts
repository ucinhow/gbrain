import type { BrainEngine } from '../core/engine.ts';
import { startHttpMcpServer, startMcpServer } from '../mcp/server.ts';

export interface ServeArgs {
  http: boolean;
  host: string;
  port: number;
  path: string;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function parseServeArgs(args: string[]): ServeArgs {
  if (args.includes('--http') && args.includes('--stdio')) {
    throw new Error('Use either --http or --stdio, not both. HTTP is the default.');
  }

  const portRaw = valueAfter(args, '--port') || process.env.GBRAIN_MCP_PORT || '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port "${portRaw}". Expected an integer from 1 to 65535.`);
  }

  return {
    http: !args.includes('--stdio'),
    host: valueAfter(args, '--host') || process.env.GBRAIN_MCP_HOST || '0.0.0.0',
    port,
    path: valueAfter(args, '--path') || process.env.GBRAIN_MCP_PATH || '/mcp',
  };
}

export async function runServe(engine: BrainEngine, args: string[] = []) {
  let opts: ServeArgs;
  try {
    opts = parseServeArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (opts.http) {
    await startHttpMcpServer(engine, opts);
    return;
  }

  console.error('Starting GBrain MCP server (stdio)...');
  await startMcpServer(engine);
}
