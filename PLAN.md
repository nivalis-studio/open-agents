# Plan: MCP Connections for Open Harness

## Summary

Add MCP (Model Context Protocol) connections to Open Harness. Users configure connections globally in **Settings → Connections** and selectively enable them per-session. Three pre-built integrations (Vercel, Notion, Granola) ship out of the box alongside custom MCP server support. MCP tools run server-side via `@ai-sdk/mcp` using HTTP/SSE transport, merged into the agent's tool set at workflow time.

Auth is a first-class concern: supports **None**, **Bearer Token**, **Custom Headers**, and **OAuth 2.1** (with PKCE + dynamic client registration per the MCP spec). Pre-built MCPs use their native auth mechanisms; custom MCPs can use any of the four methods.

## Context

### Current Architecture

- **Agent**: `ToolLoopAgent` in `packages/agent/open-harness-agent.ts` with a fixed tool set (read, write, edit, grep, glob, bash, task, ask_user_question, skill, web_fetch, todo_write)
- **Tool injection**: `prepareCall` in the agent assembles tools + system prompt per call. The chat API route (`apps/web/app/api/chat/route.ts`) passes `agentOptions` including sandbox context, model selection, skills, and custom instructions
- **Chat workflow**: `apps/web/app/workflows/chat.ts` — durable workflow runs `webAgent.stream()` with the assembled options
- **Runtime creation**: `apps/web/app/api/chat/_lib/runtime.ts` connects sandbox, resolves GitHub tokens, discovers skills
- **Settings Connections page**: `apps/web/app/settings/connections/page.tsx` + `accounts-section.tsx` — currently only GitHub. Has explicit placeholder: `{/* Future: MCP connections would go here */}`
- **Database**: Drizzle ORM with PostgreSQL (Neon). Relevant tables: `users`, `sessions`, `chats`, `userPreferences`, `linkedAccounts`
- **Skills system**: `globalSkillRefs` in `userPreferences` and `sessions` tables — precedent for per-user defaults overridden per-session
- **Existing auth patterns**: Vercel OAuth (PKCE + refresh tokens), GitHub OAuth (code exchange + refresh). Tokens encrypted via AES-256-CBC (`lib/crypto.ts`). OAuth state stored in httpOnly cookies with short TTL.
- **AI SDK MCP**: `@ai-sdk/mcp` package provides `createMCPClient()` with HTTP/SSE transports. Supports `authProvider` for OAuth. Returns `ToolSet` compatible tools. Client lifecycle requires explicit `.close()`.

### Pre-built MCP Discovery Results

| Provider | MCP Endpoint | Auth Discovery | Auth Method |
|----------|-------------|----------------|-------------|
| **Vercel** | `https://mcp.vercel.com` | `mcp.vercel.com/.well-known/oauth-authorization-server` → ✅ | OAuth 2.1 (PKCE, dynamic client reg, refresh tokens) via `vercel.com/oauth/authorize` |
| **Notion** | `https://mcp.notion.com/mcp` | `mcp.notion.com/.well-known/oauth-authorization-server` → ✅ | OAuth 2.1 (PKCE, dynamic client reg, refresh tokens) via `mcp.notion.com/authorize` |
| **Granola** | `https://mcp.granola.ai/mcp` | `mcp.granola.ai/.well-known/oauth-authorization-server` → ✅ | OAuth 2.1 (PKCE, dynamic client reg, refresh tokens) via `mcp-auth.granola.ai` |

### Key Design Decisions

1. **Both global + per-session scoping**: Users configure MCPs in Settings (global registry), then choose which to enable per-session. Mirrors the `globalSkillRefs` pattern.
2. **Server-side execution**: MCP clients created on the server in the chat API route, tools merged into agent's tool set. No sandbox involvement for MCP.
3. **Pre-defined + custom URLs**: Three curated MCPs + ability to add arbitrary HTTP/SSE MCP servers.
4. **Sandbox always provisions**: No changes to sandbox lifecycle. MCP tools are additive.
5. **Four auth methods**: None, Bearer Token, Custom Headers, OAuth 2.1 — all supported for both pre-built and custom MCPs.

## System Impact

### Source of Truth
- **Before**: Tools are statically defined in `packages/agent/open-harness-agent.ts`
- **After**: Tools = static agent tools + dynamic MCP tools resolved at runtime from `mcpConnections` (user table) + `enabledMcpConnectionIds` (session table)

### Data Flow
```
Settings: User configures MCP → mcpConnections table (with auth credentials)
OAuth MCPs: User clicks "Connect" → OAuth redirect flow → tokens stored encrypted in mcpConnections
Session: User creates/edits session → picks which MCPs to enable → session.enabledMcpConnectionIds

Chat request:
  → runtime.ts loads enabled MCP connections from DB
  → Decrypts tokens, resolves auth headers
  → For OAuth MCPs: checks token expiry, refreshes if needed
  → Creates MCP clients via @ai-sdk/mcp (HTTP/SSE transport + auth headers)
  → Fetches tool schemas from each MCP server
  → Namespaces tools to avoid collisions
  → Merges MCP tools into agent's ToolSet via agentOptions.mcpTools
  → Agent streams response, calling MCP tools as needed
  → MCP clients closed when response stream completes
```

### New State
- `mcpConnections` table: per-user registry of configured MCP servers (with encrypted auth)
- `mcpOAuthStates` table: transient OAuth state for CSRF protection during OAuth flows
- `sessions.enabledMcpConnectionIds`: JSONB array of connection IDs active for this session
- MCP client instances: transient, created per-workflow-run, closed on finish

---

## Approach

### Phase 1: Data Layer

#### New `mcpConnections` table

```typescript
export const mcpConnections = pgTable("mcp_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // For pre-defined: "vercel", "notion", "granola". For custom: "custom"
  provider: text("provider").notNull(),

  // Human-readable name
  name: text("name").notNull(),

  // MCP server URL
  url: text("url").notNull(),

  // Transport type
  transportType: text("transport_type", {
    enum: ["http", "sse"],
  }).notNull().default("sse"),

  // ─── Auth ───────────────────────────────────────────
  // Auth method for this connection
  authType: text("auth_type", {
    enum: ["none", "bearer", "headers", "oauth"],
  }).notNull().default("none"),

  // For "bearer" auth: the bearer token (encrypted via lib/crypto.ts)
  // For "oauth" auth: the current access token (encrypted)
  accessToken: text("access_token"),

  // For "oauth" auth: refresh token (encrypted)
  refreshToken: text("refresh_token"),

  // For "oauth" auth: when the access token expires
  tokenExpiresAt: timestamp("token_expires_at"),

  // For "oauth" auth: scopes granted
  oauthScopes: text("oauth_scopes"),

  // For "oauth" auth: OAuth client ID (from dynamic client registration or hardcoded)
  oauthClientId: text("oauth_client_id"),

  // For "oauth" auth: OAuth client secret (encrypted, if confidential client)
  oauthClientSecret: text("oauth_client_secret"),

  // For "headers" auth: custom headers as JSON (values encrypted)
  customHeaders: jsonb("custom_headers").$type<Record<string, string>>(),

  // ─── Metadata ───────────────────────────────────────
  // Whether this connection is enabled by default in new sessions
  enabledByDefault: boolean("enabled_by_default").notNull().default(true),

  // Connectivity status
  status: text("status", {
    enum: ["active", "needs_auth", "error", "unchecked"],
  }).notNull().default("unchecked"),
  lastError: text("last_error"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("mcp_connections_user_id_idx").on(table.userId),
]);
```

#### Session schema addition

Add `enabledMcpConnectionIds` JSONB column to `sessions` table:

```typescript
enabledMcpConnectionIds: jsonb("enabled_mcp_connection_ids")
  .$type<string[]>()
  .notNull()
  .default([]),
```

### Phase 2: Auth System

This is the most architecturally significant piece. Four auth strategies, unified behind a common interface.

#### Auth Strategy Interface

```typescript
// lib/mcp/auth.ts

export interface MCPAuthHeaders {
  headers: Record<string, string>;
}

/**
 * Resolve auth headers for an MCP connection.
 * For OAuth connections, this handles token refresh transparently.
 * Returns the headers to pass to createMCPClient transport config.
 */
export async function resolveAuthHeaders(
  connection: MCPConnection,
): Promise<MCPAuthHeaders> {
  switch (connection.authType) {
    case "none":
      return { headers: {} };

    case "bearer":
      return {
        headers: {
          Authorization: `Bearer ${decrypt(connection.accessToken!)}`,
        },
      };

    case "headers":
      // customHeaders values are stored encrypted
      const decrypted: Record<string, string> = {};
      for (const [key, value] of Object.entries(connection.customHeaders ?? {})) {
        decrypted[key] = decrypt(value);
      }
      return { headers: decrypted };

    case "oauth":
      return resolveOAuthHeaders(connection);
  }
}
```

#### OAuth 2.1 Flow (MCP Spec Compliant)

The MCP spec mandates OAuth 2.1 with PKCE for HTTP transports. Both Vercel and Notion expose standard `/.well-known/oauth-authorization-server` metadata and dynamic client registration endpoints.

**Flow overview:**

```
1. User clicks "Connect" on Vercel/Notion MCP card
2. Frontend → POST /api/mcp/oauth/initiate { connectionId, provider }
3. Server:
   a. Fetches /.well-known/oauth-authorization-server from MCP server base URL
   b. If dynamic client registration supported: POST /register to get client_id
      (or use hardcoded client_id for known providers)
   c. Generates PKCE code_verifier + code_challenge (S256)
   d. Generates random state for CSRF protection
   e. Stores { state, code_verifier, connectionId } in mcpOAuthStates table (TTL: 15 min)
   f. Returns authorization URL to frontend
4. Frontend redirects user to authorization URL (Vercel/Notion OAuth consent screen)
5. User authorizes → redirect to /api/mcp/oauth/callback?code=...&state=...
6. Server:
   a. Validates state against mcpOAuthStates table
   b. Exchanges code + code_verifier for access_token + refresh_token
   c. Encrypts tokens via lib/crypto.ts
   d. Updates mcpConnections row with tokens, expiry, scopes
   e. Sets status = "active"
   f. Redirects to /settings/connections with success toast
```

**Token refresh:**

```typescript
// lib/mcp/oauth.ts

async function resolveOAuthHeaders(
  connection: MCPConnection,
): Promise<MCPAuthHeaders> {
  // Check if token is expired (with 5-min buffer, matching existing Vercel token pattern)
  if (connection.tokenExpiresAt &&
      connection.tokenExpiresAt.getTime() < Date.now() + 5 * 60 * 1000) {
    // Refresh the token
    const refreshed = await refreshOAuthToken(connection);
    // Update DB with new tokens (fire-and-forget or awaited)
    await updateMCPConnectionTokens(connection.id, connection.userId, {
      accessToken: encrypt(refreshed.accessToken),
      refreshToken: refreshed.refreshToken ? encrypt(refreshed.refreshToken) : connection.refreshToken,
      tokenExpiresAt: refreshed.expiresAt,
    });
    return {
      headers: { Authorization: `Bearer ${refreshed.accessToken}` },
    };
  }

  return {
    headers: { Authorization: `Bearer ${decrypt(connection.accessToken!)}` },
  };
}

async function refreshOAuthToken(connection: MCPConnection) {
  // Discover token endpoint from MCP server metadata
  const metadata = await discoverOAuthMetadata(connection.url);
  const tokenEndpoint = metadata.token_endpoint;

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(connection.refreshToken!),
      client_id: connection.oauthClientId!,
      ...(connection.oauthClientSecret
        ? { client_secret: decrypt(connection.oauthClientSecret) }
        : {}),
    }),
  });

  if (!response.ok) {
    // Mark connection as needs_auth so UI can prompt re-authorization
    await updateMCPConnectionStatus(connection.id, connection.userId, "needs_auth");
    throw new Error(`OAuth token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000)
      : null,
  };
}
```

**OAuth metadata discovery:**

```typescript
// lib/mcp/oauth.ts

interface OAuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

async function discoverOAuthMetadata(mcpUrl: string): Promise<OAuthServerMetadata> {
  // Per MCP spec: strip path from MCP URL to get authorization base URL
  const baseUrl = new URL(mcpUrl);
  baseUrl.pathname = "";

  const metadataUrl = `${baseUrl.origin}/.well-known/oauth-authorization-server`;
  const response = await fetch(metadataUrl, {
    headers: { "MCP-Protocol-Version": "2025-03-26" },
  });

  if (!response.ok) {
    // Fall back to default endpoints per MCP spec
    return {
      authorization_endpoint: `${baseUrl.origin}/authorize`,
      token_endpoint: `${baseUrl.origin}/token`,
      registration_endpoint: `${baseUrl.origin}/register`,
    };
  }

  return response.json();
}
```

**Dynamic client registration:**

```typescript
// lib/mcp/oauth.ts

async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client per MCP spec
      client_name: "Open Harness",
    }),
  });

  if (!response.ok) {
    throw new Error(`Dynamic client registration failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
  };
}
```

#### OAuth State Table

Transient table for CSRF protection during OAuth flows (similar to existing cookie-based pattern but using DB for durability):

```typescript
export const mcpOAuthStates = pgTable("mcp_oauth_states", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connectionId: text("connection_id"),  // null for new connections being created
  provider: text("provider").notNull(),
  codeVerifier: text("code_verifier").notNull(), // PKCE
  redirectTo: text("redirect_to").notNull().default("/settings/connections"),
  // Dynamic registration results (stored here temporarily until callback completes)
  oauthClientId: text("oauth_client_id"),
  oauthClientSecret: text("oauth_client_secret"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

#### OAuth API Routes

- `POST /api/mcp/oauth/initiate` — Start OAuth flow: discover metadata, register client, generate PKCE, return auth URL
- `GET /api/mcp/oauth/callback` — Handle OAuth callback: validate state, exchange code, store tokens, redirect

### Phase 3: Pre-defined MCP Catalog

```typescript
// lib/mcp/catalog.ts

export type MCPAuthType = "none" | "bearer" | "headers" | "oauth";

export interface MCPCatalogEntry {
  provider: string;
  name: string;
  description: string;
  url: string;
  transportType: "http" | "sse";
  icon: string;
  authType: MCPAuthType;
  // For OAuth providers: optional hardcoded client ID
  // (fallback if dynamic registration fails or is unavailable)
  oauthClientId?: string;
}

export const MCP_CATALOG: MCPCatalogEntry[] = [
  {
    provider: "vercel",
    name: "Vercel",
    description: "Deploy, manage projects, and access deployment logs",
    url: "https://mcp.vercel.com",
    transportType: "http",
    icon: "vercel",
    authType: "oauth",
    // Vercel supports dynamic client registration, no hardcoded ID needed
  },
  {
    provider: "notion",
    name: "Notion",
    description: "Search pages, read content, create and update documents",
    url: "https://mcp.notion.com/mcp",
    transportType: "http",
    icon: "notion",
    authType: "oauth",
    // Notion supports dynamic client registration
  },
  {
    provider: "granola",
    name: "Granola",
    description: "Access meeting notes, transcripts, and action items",
    url: "https://mcp.granola.ai/mcp",
    transportType: "http",
    icon: "granola",
    authType: "oauth",
    // Granola supports dynamic client registration via mcp-auth.granola.ai
  },
];

export function getCatalogEntry(provider: string): MCPCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.provider === provider);
}
```

### Phase 4: MCP Client Management (Runtime)

```typescript
// lib/mcp/client.ts

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { MCPConnection } from "@/lib/db/schema";
import { resolveAuthHeaders } from "./auth";

export interface ResolvedMCPTools {
  tools: ToolSet;
  clients: MCPClient[];
  /** Human-readable metadata for system prompt */
  connectionDescriptions: Array<{ name: string; description: string; toolNames: string[] }>;
}

export async function resolveMCPTools(
  connections: MCPConnection[],
): Promise<ResolvedMCPTools> {
  const clients: MCPClient[] = [];
  const mergedTools: ToolSet = {};
  const connectionDescriptions: ResolvedMCPTools["connectionDescriptions"] = [];

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      // Skip connections that need re-authorization
      if (conn.status === "needs_auth") {
        console.warn(`Skipping MCP "${conn.name}": needs re-authorization`);
        return;
      }

      // Resolve auth headers (handles token refresh for OAuth)
      const { headers } = await resolveAuthHeaders(conn);

      const client = await createMCPClient({
        transport: {
          type: conn.transportType,
          url: conn.url,
          headers,
          redirect: "error", // SSRF prevention
        },
      });

      clients.push(client);
      const tools = await client.tools();

      const toolNames: string[] = [];
      for (const [toolName, tool] of Object.entries(tools)) {
        // Namespace: mcp_<provider>_<toolName> for pre-built, mcp_<id>_<toolName> for custom
        const prefix = conn.provider !== "custom" ? conn.provider : conn.id;
        const namespacedName = `mcp_${prefix}_${toolName}`;
        mergedTools[namespacedName] = tool;
        toolNames.push(namespacedName);
      }

      connectionDescriptions.push({
        name: conn.name,
        description: getCatalogEntry(conn.provider)?.description ?? "",
        toolNames,
      });
    }),
  );

  // Log failures but don't block the chat
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("MCP connection failed:", result.reason);
    }
  }

  return { tools: mergedTools, clients, connectionDescriptions };
}

export async function closeMCPClients(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}
```

### Phase 5: Agent Integration

#### Modify `createChatRuntime` to resolve MCP tools

In `apps/web/app/api/chat/_lib/runtime.ts`:

```typescript
export async function createChatRuntime(params: {
  userId: string;
  sessionId: string;
  sessionRecord: SessionRecord;
}): Promise<{
  sandbox: ConnectedSandbox;
  skills: DiscoveredSkills;
  mcpResult: ResolvedMCPTools;
}> {
  // ... existing sandbox + skills logic ...

  // Resolve MCP connections for this session
  const enabledIds = params.sessionRecord.enabledMcpConnectionIds ?? [];
  const mcpConnections = enabledIds.length > 0
    ? await getEnabledMCPConnections(params.userId, enabledIds)
    : [];
  const mcpResult = mcpConnections.length > 0
    ? await resolveMCPTools(mcpConnections)
    : { tools: {}, clients: [], connectionDescriptions: [] };

  return { sandbox, skills, mcpResult };
}
```

#### Add `mcpTools` to agent call options

In `packages/agent/open-harness-agent.ts`:

```typescript
const callOptionsSchema = z.object({
  sandbox: z.custom<AgentSandboxContext>(),
  model: z.custom<OpenHarnessAgentModelInput>().optional(),
  subagentModel: z.custom<OpenHarnessAgentModelInput>().optional(),
  customInstructions: z.string().optional(),
  skills: z.custom<SkillMetadata[]>().optional(),
  mcpTools: z.custom<ToolSet>().optional(), // NEW
});
```

In `prepareCall`, merge MCP tools:

```typescript
prepareCall: ({ options, ...settings }) => {
  // ... existing logic ...
  const mcpTools = options.mcpTools ?? {};

  return {
    ...settings,
    model: callModel,
    tools: addCacheControl({
      tools: { ...(settings.tools ?? tools), ...mcpTools },
      model: callModel,
    }),
    instructions,
    experimental_context: {
      sandbox,
      skills,
      model: callModel,
      subagentModel,
    },
  };
},
```

#### MCP client lifecycle

In `apps/web/app/api/chat/route.ts`, ensure MCP clients are closed after stream completes:

```typescript
const [{ sandbox, skills, mcpResult }, preferences] = await Promise.all([
  runtimePromise,
  preferencesPromise,
]);

// ...start workflow with mcpResult.tools in agentOptions...

const stream = createCancelableReadableStream(
  run.getReadable<WebAgentUIMessageChunk>(),
);

// Close MCP clients when stream completes
const streamWithCleanup = stream.pipeThrough(
  new TransformStream({
    flush() {
      void closeMCPClients(mcpResult.clients);
    },
  }),
);
```

### Phase 6: System Prompt

Add MCP connection context to `buildSystemPrompt`:

```typescript
// When MCP connections are active, append to system prompt:
if (mcpDescriptions.length > 0) {
  sections.push(`## MCP Connections

The following external service connections are available in this session:

${mcpDescriptions.map(c =>
  `- **${c.name}**: ${c.description}\n  Tools: ${c.toolNames.map(t => `\`${t}\``).join(", ")}`
).join("\n")}

Use these tools when the user's request relates to the connected service. Tools are prefixed with their service name (e.g., \`mcp_vercel_*\`, \`mcp_notion_*\`).`);
}
```

### Phase 7: Settings UI — MCP Connections Section

#### Component: `apps/web/app/settings/mcp-connections-section.tsx`

Replaces the `{/* <McpConnectionsSection /> */}` placeholder in `accounts-section.tsx`.

**Pre-defined MCPs section:**
- Grid of cards for Vercel, Notion, Granola
- Each card shows: icon, name, description, auth type badge
- **Connect button**:
  - OAuth providers (Vercel, Notion): Initiates OAuth flow → redirect → callback
  - Bearer token (Granola): Opens modal to enter API key
- **Connected state**: Shows green status, "Configure" / "Disconnect" buttons
- **Needs re-auth state**: Shows warning, "Re-authorize" button

**Custom MCPs section:**
- "Add custom MCP server" button → modal with:
  - Name (text input)
  - URL (text input, validated as HTTPS)
  - Transport type: HTTP / SSE dropdown
  - Auth type: None / Bearer Token / Custom Headers / OAuth dropdown
  - **If Bearer**: Token input (password field)
  - **If Custom Headers**: Dynamic key-value pair inputs (values as password fields)
  - **If OAuth**: Auto-discovers metadata from URL, shows supported scopes, initiates OAuth flow
  - **If None**: Just URL
- "Test Connection" button → calls `/api/mcp/connections/[id]/test`, shows discovered tools
- Connected MCPs list with status, edit, delete, test

**Default toggle**: Per-connection "Enable by default in new sessions" switch

#### API Routes

```
POST   /api/mcp/connections              — Create connection (non-OAuth types)
GET    /api/mcp/connections              — List user's connections
PATCH  /api/mcp/connections/[id]         — Update connection
DELETE /api/mcp/connections/[id]         — Delete connection
POST   /api/mcp/connections/[id]/test    — Test connectivity (create client → list tools → close)
GET    /api/mcp/connections/[id]/tools   — List available tools

POST   /api/mcp/oauth/initiate           — Start OAuth flow
GET    /api/mcp/oauth/callback           — OAuth callback handler
```

### Phase 8: Session UI — MCP Picker

When creating or editing a session:

- Add "MCP Connections" section below existing options
- Multi-select of configured MCP connections (name + icon + status badge)
- Pre-checked based on `enabledByDefault` from each connection
- Stored as `enabledMcpConnectionIds` on the session
- Connections with `needs_auth` status shown as disabled with "Re-authorize in Settings" hint

### Phase 9: Database Queries

```typescript
// lib/db/mcp-connections.ts

// CRUD
export async function getUserMCPConnections(userId: string): Promise<MCPConnection[]>;
export async function getMCPConnectionById(id: string, userId: string): Promise<MCPConnection | null>;
export async function createMCPConnection(data: NewMCPConnection): Promise<MCPConnection>;
export async function updateMCPConnection(id: string, userId: string, data: Partial<MCPConnection>): Promise<void>;
export async function deleteMCPConnection(id: string, userId: string): Promise<void>;

// Runtime
export async function getEnabledMCPConnections(userId: string, connectionIds: string[]): Promise<MCPConnection[]>;
export async function updateMCPConnectionTokens(id: string, userId: string, tokens: TokenUpdate): Promise<void>;
export async function updateMCPConnectionStatus(id: string, userId: string, status: string, error?: string): Promise<void>;

// OAuth state
export async function createOAuthState(data: NewMCPOAuthState): Promise<void>;
export async function consumeOAuthState(state: string): Promise<MCPOAuthState | null>;
export async function cleanExpiredOAuthStates(): Promise<void>;
```

---

## Changes

### New Files

| File | Purpose |
|------|---------|
| `apps/web/lib/mcp/catalog.ts` | Pre-defined MCP catalog (Vercel, Notion, Granola) |
| `apps/web/lib/mcp/auth.ts` | Auth strategy resolver: None, Bearer, Headers, OAuth |
| `apps/web/lib/mcp/oauth.ts` | OAuth 2.1 implementation: metadata discovery, PKCE, dynamic client registration, token exchange, refresh |
| `apps/web/lib/mcp/client.ts` | MCP client factory: `resolveMCPTools()`, `closeMCPClients()` |
| `apps/web/lib/db/mcp-connections.ts` | Database queries for MCP connections + OAuth state |
| `apps/web/app/settings/mcp-connections-section.tsx` | Settings UI for MCP management |
| `apps/web/app/api/mcp/connections/route.ts` | CRUD API (POST, GET) |
| `apps/web/app/api/mcp/connections/[id]/route.ts` | Single connection API (PATCH, DELETE) |
| `apps/web/app/api/mcp/connections/[id]/test/route.ts` | Test connectivity |
| `apps/web/app/api/mcp/connections/[id]/tools/route.ts` | List tools |
| `apps/web/app/api/mcp/oauth/initiate/route.ts` | Start OAuth flow |
| `apps/web/app/api/mcp/oauth/callback/route.ts` | OAuth callback handler |
| Migration: `XXXX_add_mcp_connections.sql` | DB migration for new tables + session column |

### Modified Files

| File | Change |
|------|--------|
| `apps/web/lib/db/schema.ts` | Add `mcpConnections` + `mcpOAuthStates` tables, add `enabledMcpConnectionIds` to `sessions` |
| `apps/web/app/api/chat/_lib/runtime.ts` | Add MCP resolution to `createChatRuntime` |
| `apps/web/app/api/chat/route.ts` | Pass MCP tools to agent, handle client cleanup |
| `packages/agent/open-harness-agent.ts` | Add `mcpTools` to call options schema, merge in `prepareCall` |
| `packages/agent/system-prompt.ts` | Add MCP connections section to system prompt |
| `apps/web/app/settings/accounts-section.tsx` | Render `<McpConnectionsSection />` |
| `apps/web/app/settings/connections/page.tsx` | Import and render MCP section |
| Session creation UI | Add MCP picker |

### New Package Dependencies
- `@ai-sdk/mcp` — AI SDK MCP client package

---

## Security Considerations

### Token Storage
- All tokens (bearer tokens, OAuth access/refresh tokens, custom header values, client secrets) encrypted via existing `lib/crypto.ts` (AES-256-CBC) before DB storage
- Follows same pattern as existing Vercel + GitHub token storage
- Tokens decrypted only at runtime when resolving auth headers

### OAuth Security
- PKCE (S256) required for all OAuth flows per MCP spec
- CSRF protection via random `state` parameter stored in `mcpOAuthStates` table with 15-min TTL
- OAuth state consumed on use (single-use)
- Expired states cleaned up periodically
- Redirect URI validation: only our callback URL accepted

### SSRF Prevention
- Custom MCP URLs validated: must be HTTPS (no HTTP, no internal IPs)
- `redirect: "error"` passed to `createMCPClient` transport config
- URL allowlist for pre-defined MCPs

### Per-User Isolation
- MCP connections strictly scoped to user via `userId` foreign key
- Session enablement validated against user ownership
- All CRUD operations require authenticated user + ownership check

---

## Verification

### Auth Flow Testing
1. **OAuth (Vercel)**: Settings → Connect Vercel → OAuth redirect → consent → callback → tokens stored → status active
2. **OAuth (Notion)**: Same flow, verify dynamic client registration works
3. **OAuth token refresh**: Let Vercel token expire → next chat request triggers refresh → verify seamless
4. **OAuth re-auth**: Simulate invalid refresh token → status changes to "needs_auth" → UI shows re-authorize prompt
5. **OAuth (Granola)**: Settings → Connect Granola → OAuth via `mcp-auth.granola.ai` → callback → tokens stored → status active
6. **Custom + None**: Add custom MCP with no auth → verify connection works
7. **Custom + Headers**: Add custom MCP with auth headers → verify headers sent correctly
8. **Custom + OAuth**: Add custom MCP URL → auto-discover metadata → OAuth flow → verify tokens stored

### Integration Testing
1. Enable MCP on session → send chat message → verify MCP tools in agent's tool set
2. Agent calls MCP tool → verify execution and response rendering
3. Multiple MCPs enabled → verify no tool name collisions
4. MCP server unreachable → verify graceful degradation (chat continues with remaining tools)
5. Remove MCP mid-session → verify subsequent chats exclude it

### Commands
- Typecheck: project typecheck command
- Lint: project lint command
- Full test suite: ensure no regressions

---

## Open Questions / Follow-ups

1. **Tool count limits**: Some MCPs expose many tools. May need filtering UI or auto-truncation to avoid context window bloat.
3. **MCP tool UI rendering**: Should MCP tool calls render with a "via Vercel" badge in the chat? Follow-up design decision.
4. **Tool schema caching**: Cache MCP tool schemas to avoid re-fetching every chat request. Follow-up optimization.
5. **OAuth client ID persistence**: Dynamic client registration returns a `client_id`. Should we cache this per-provider globally (not per-user) to avoid re-registering? Some MCP servers may have rate limits on registration.
6. **MCP resources and prompts**: V1 focuses on tools only. Resources (context) and prompts (templates) could be follow-ups.
7. **Rate limiting / billing**: Should MCP tool calls count toward usage? Separate metering concern.
8. **Non-eng productivity**: For the Claude Cowork-style use case, consider a "productivity mode" template that pre-enables Notion + Granola MCPs and adjusts the system prompt for meeting follow-ups, note-taking, etc.
