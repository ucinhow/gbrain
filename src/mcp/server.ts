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

let httpRequestSeq = 0;

function logHttp(message: string): void {
  process.stderr.write(`[mcp-http] ${new Date().toISOString()} ${message}\n`);
}

function logTool(message: string): void {
  process.stderr.write(`[mcp-tool] ${new Date().toISOString()} ${message}\n`);
}

function quoteLogValue(value: string): string {
  return JSON.stringify(value).replace(/\s+/g, ' ');
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded
    || request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || '-';
}

function shortSessionId(sessionId: string | null): string {
  if (!sessionId) return '-';
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}...`;
}

async function withHttpRequestLog(request: Request, handler: () => Promise<Response>): Promise<Response> {
  const id = (++httpRequestSeq).toString(36);
  const started = Date.now();
  const url = new URL(request.url);
  const session = shortSessionId(request.headers.get('mcp-session-id'));
  const auth = bearerToken(request) ? 'present' : 'missing';
  const ua = request.headers.get('user-agent') || '-';
  logHttp(`request start id=${id} method=${request.method} path=${url.pathname} ip=${clientIp(request)} auth=${auth} session=${session} ua=${quoteLogValue(ua)}`);
  try {
    const response = await handler();
    logHttp(`request end id=${id} status=${response.status} duration_ms=${Date.now() - started}`);
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logHttp(`request error id=${id} duration_ms=${Date.now() - started} error=${quoteLogValue(msg)}`);
    return jsonRpcError(500, -32603, msg);
  }
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
    const started = Date.now();
    logTool(`call start tool=${name || '<missing>'}`);
    const op = operations.find(o => o.name === name);
    if (!op) {
      logTool(`call end tool=${name || '<missing>'} status=unknown_tool duration_ms=${Date.now() - started}`);
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
      logTool(`call end tool=${name} status=invalid_params duration_ms=${Date.now() - started}`);
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }], isError: true };
    }

    try {
      const result = await op.handler(ctx, safeParams);
      logTool(`call end tool=${name} status=ok duration_ms=${Date.now() - started}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        logTool(`call end tool=${name} status=operation_error code=${e.code} duration_ms=${Date.now() - started}`);
        return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      logTool(`call end tool=${name} status=error duration_ms=${Date.now() - started} error=${quoteLogValue(msg)}`);
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

  const configToken = loadConfig()?.mcp_token;
  if (configToken) {
    return safeEqual(token, configToken) ? null : jsonRpcError(401, -32011, 'invalid_token');
  }

  if (engine.kind !== 'postgres') {
    return jsonRpcError(401, -32010, 'missing_auth: set GBRAIN_MCP_TOKEN or ~/.gbrain/config.json mcp_token for HTTP MCP with PGLite');
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
    logHttp(`session close session=${shortSessionId(sessionId)} active_sessions=${sessions.size}`);
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
      return withHttpRequestLog(request, async () => {
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
            logHttp(`session init session=${shortSessionId(newSessionId)} active_sessions=${sessions.size}`);
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
            logHttp(`session init session=${shortSessionId(transport.sessionId)} active_sessions=${sessions.size}`);
          }
          return response;
        } catch (e) {
          await Promise.allSettled([transport.close(), mcpServer.close()]);
          const msg = e instanceof Error ? e.message : String(e);
          return jsonRpcError(500, -32603, msg);
        }
      });
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
