# Deploy GBrain Remote MCP Server

Access your brain from any device, any AI client. `gbrain serve` starts the
Streamable HTTP MCP server by default on `0.0.0.0:8787`. For local stdio clients,
use `gbrain serve --stdio`.

## Two Paths

### Local (zero setup)

```bash
gbrain serve --stdio
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No HTTP listener, no tunnel, no token needed.

### Remote (any device, any AI client)

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → gbrain serve (0.0.0.0:8787)
  → Supabase Postgres (via pooler connection string)
```

This requires:
1. A machine running `gbrain serve`
2. A public tunnel (ngrok, Tailscale, or cloud host)
3. Bearer token auth for security

## Remote Setup

### 1. Start the HTTP MCP server and tunnel

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup.
Quick version:

```bash
gbrain serve
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby tier for fixed domain
```

`gbrain serve` listens on `0.0.0.0:8787` by default. Override with
`--host`, `--port`, and `--path` if needed. HTTP MCP requires `Authorization:
Bearer <token>`. For PGLite, set `GBRAIN_MCP_TOKEN` or add `"mcp_token"` to
`~/.gbrain/config.json` because the Postgres `access_tokens` table is not available.

### 2. Create access tokens

```bash
# Create a token for each client
bun run src/commands/auth.ts create "claude-desktop"

# List all tokens
bun run src/commands/auth.ts list

# Revoke a token
bun run src/commands/auth.ts revoke "claude-desktop"
```

Tokens are per-client. Create one for each device/app. Revoke individually
if compromised. Tokens are stored SHA-256 hashed in your database.

### 3. Connect your AI client

- **Claude Code:** [setup guide](CLAUDE_CODE.md)
- **Claude Desktop:** [setup guide](CLAUDE_DESKTOP.md) (must use GUI, not JSON config)
- **Claude Cowork:** [setup guide](CLAUDE_COWORK.md)
- **Perplexity:** [setup guide](PERPLEXITY.md)

### 4. Verify

```bash
bun run src/commands/auth.ts test \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  --token YOUR_TOKEN
```

## Operations

All 30 GBrain operations are available remotely, including `sync_brain` and
`file_upload` (no timeout limits with self-hosted server).

**Security note on `file_upload`:** remote MCP callers are confined to the working
directory where `gbrain serve` was launched. Symlinks, `..` traversal, and absolute
paths outside cwd are rejected. Page slugs and filenames are allowlist-validated
(alphanumeric + hyphens; no control chars, RTL overrides, or backslashes). Local
CLI callers (`gbrain file upload ...`) keep unrestricted filesystem access since
the user owns the machine.

## Deployment Options

See [ALTERNATIVES.md](ALTERNATIVES.md) for a comparison of ngrok, Tailscale
Funnel, and cloud hosts (Fly.io, Railway).

## Troubleshooting

**"missing_auth" error**
Include the Authorization header: `Authorization: Bearer YOUR_TOKEN`

**"invalid_token" error**
Run `bun run src/commands/auth.ts list` to see active tokens.

**"service_unavailable" error**
Database connection failed. Check your Supabase dashboard for outages.

**Claude Desktop doesn't connect**
Remote servers must be added via Settings > Integrations, NOT
`claude_desktop_config.json`. See [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md).

## Expected Latencies

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| get_page | < 100ms | Single DB query |
| list_pages | < 200ms | DB query with filters |
| search (keyword) | 100-300ms | Full-text search |
| query (hybrid) | 1-3s | Embedding + vector + keyword + RRF |
| put_page | 100-500ms | Write + trigger search_vector update |
| get_stats | < 100ms | Aggregate query |

**Note:** `gbrain serve` uses MCP Streamable HTTP by default and listens on
`0.0.0.0:8787/mcp` for remote access. Keep it behind a trusted tunnel or network
boundary and require Bearer tokens. Use `gbrain serve --stdio` for local stdio MCP.
