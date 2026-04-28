import { createHash, timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { Operation, OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';
import { buildToolDefs } from './tool-defs.ts';

export interface HttpMcpServerOptions {
  host?: string;
  port?: number;
  path?: string;
}

interface HttpMcpSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

/** Validate required params exist and have the expected type */
function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

function createMcpServer(engine: BrainEngine): Server {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Generate tool definitions from operations. Extracted to buildToolDefs so
  // the subagent tool registry (v0.15+) can call the same mapper against a
  // filtered OPERATIONS subset instead of duplicating this shape.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefs(operations),
  }));

  // Dispatch tool calls to operation handlers
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = operations.find(o => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    const ctx: OperationContext = {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
      dryRun: !!(params?.dry_run),
      // MCP callers are remote/untrusted; enforce strict file confinement.
      remote: true,
    };

    const safeParams = params || {};
    const validationError = validateParams(op, safeParams);
    if (validationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }], isError: true };
    }

    try {
      const result = await op.handler(ctx, safeParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

export async function startMcpServer(engine: BrainEngine) {
  const server = createMcpServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function normalizeMcpPath(path: string | undefined): string {
  const p = path?.trim() || '/mcp';
  return p.startsWith('/') ? p : `/${p}`;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }) + '\n', {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function authenticateHttpRequest(engine: BrainEngine, request: Request): Promise<Response | null> {
  const token = bearerToken(request);
  if (!token) return jsonRpcError(401, -32010, 'missing_auth: include Authorization: Bearer <token>');

  const envToken = process.env.GBRAIN_MCP_TOKEN;
  if (envToken) {
    return safeEqual(token, envToken) ? null : jsonRpcError(401, -32011, 'invalid_token');
  }

  if (engine.kind !== 'postgres') {
    return jsonRpcError(401, -32010, 'missing_auth: set GBRAIN_MCP_TOKEN for HTTP MCP with PGLite');
  }

  const tokenHash = hashToken(token);
  try {
    const rows = await engine.executeRaw<{ name: string }>(
      `SELECT name FROM access_tokens WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1`,
      [tokenHash],
    );
    const name = rows[0]?.name;
    if (!name) return jsonRpcError(401, -32011, 'invalid_token');
    await engine.executeRaw(
      `UPDATE access_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRpcError(503, -32012, `auth_unavailable: ${msg}`);
  }
}

export async function startHttpMcpServer(
  engine: BrainEngine,
  options: HttpMcpServerOptions = {},
): Promise<void> {
  const host = options.host || '0.0.0.0';
  const port = options.port || 8787;
  const path = normalizeMcpPath(options.path);
  const sessions = new Map<string, HttpMcpSession>();

  async function closeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);
  }

  async function closeAllSessions(): Promise<void> {
    await Promise.all(Array.from(sessions.keys()).map(closeSession));
  }

  const httpServer = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return Response.json({ status: 'ok', service: 'gbrain-mcp', transport: 'streamable-http' });
      }
      if (url.pathname !== path) {
        return new Response('Not Found\n', { status: 404 });
      }
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
        return jsonRpcError(405, -32000, 'Method not allowed.');
      }

      const authError = await authenticateHttpRequest(engine, request);
      if (authError) return authError;

      const sessionId = request.headers.get('mcp-session-id') || undefined;
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return jsonRpcError(404, -32001, 'Session not found.');
        try {
          const response = await session.transport.handleRequest(request);
          if (request.method === 'DELETE') await closeSession(sessionId);
          return response;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return jsonRpcError(500, -32603, msg);
        }
      }

      if (request.method !== 'POST') {
        return jsonRpcError(400, -32000, 'Missing MCP session ID. Send an initialize request first.');
      }

      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        return jsonRpcError(400, -32700, 'Invalid JSON request body.');
      }
      if (!isInitializeRequest(body)) {
        return jsonRpcError(400, -32000, 'No valid session ID provided. Send an initialize request first.');
      }

      const mcpServer = createMcpServer(engine);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server: mcpServer, transport });
        },
        onsessionclosed: async (closedSessionId) => {
          await closeSession(closedSessionId);
        },
      });

      try {
        await mcpServer.connect(transport);
        const response = await transport.handleRequest(request, { parsedBody: body });
        if (transport.sessionId && !sessions.has(transport.sessionId)) {
          sessions.set(transport.sessionId, { server: mcpServer, transport });
        }
        return response;
      } catch (e) {
        await Promise.allSettled([transport.close(), mcpServer.close()]);
        const msg = e instanceof Error ? e.message : String(e);
        return jsonRpcError(500, -32603, msg);
      }
    },
  });

  const url = `http://${host}:${httpServer.port}${path}`;
  console.error(`Starting GBrain MCP server (streamable HTTP) at ${url}`);
  console.error(`Health check: http://${host}:${httpServer.port}/health`);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('Shutting down GBrain MCP HTTP server...');
    httpServer.stop(true);
    await closeAllSessions();
  }

  process.once('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });

  await new Promise<void>(() => {});
}

// Backward compat: used by `gbrain call` command
export async function handleToolCall(
  engine: BrainEngine,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const op = operations.find(o => o.name === tool);
  if (!op) throw new Error(`Unknown tool: ${tool}`);

  const validationError = validateParams(op, params);
  if (validationError) throw new Error(validationError);

  const ctx: OperationContext = {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: !!(params?.dry_run),
    // Backing path for `gbrain call` CLI command — trusted local invocation.
    remote: false,
  };

  return op.handler(ctx, params);
}
