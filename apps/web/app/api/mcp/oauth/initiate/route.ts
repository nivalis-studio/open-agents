import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  createMCPConnection,
  getMCPConnectionById,
  createOAuthState,
  updateMCPConnection,
} from "@/lib/db/mcp-connections";
import {
  discoverOAuthMetadata,
  registerOAuthClient,
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
} from "@/lib/mcp/oauth";
import { getCatalogEntry } from "@/lib/mcp/catalog";
import { encrypt } from "@/lib/crypto";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const body = (await req.json()) as {
    connectionId?: string;
    provider?: string;
    url?: string;
    name?: string;
  };

  let connectionId = body.connectionId;
  let mcpUrl: string;
  let provider: string;
  let connectionName: string;

  if (connectionId) {
    // Re-authorize existing connection
    const conn = await getMCPConnectionById(connectionId, userId);
    if (!conn) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 },
      );
    }
    mcpUrl = conn.url;
    provider = conn.provider;
    connectionName = conn.name;
  } else if (body.provider) {
    // New pre-defined connection
    const catalogEntry = getCatalogEntry(body.provider);
    if (!catalogEntry) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }
    mcpUrl = catalogEntry.url;
    provider = catalogEntry.provider;
    connectionName = catalogEntry.name;

    // Create the connection record in needs_auth state
    const conn = await createMCPConnection({
      userId,
      provider,
      name: connectionName,
      url: mcpUrl,
      transportType: catalogEntry.transportType,
      authType: "oauth",
      status: "needs_auth",
    });
    connectionId = conn.id;
  } else if (body.url) {
    // New custom OAuth connection
    mcpUrl = body.url;
    provider = "custom";
    connectionName = body.name ?? "Custom MCP";

    const conn = await createMCPConnection({
      userId,
      provider,
      name: connectionName,
      url: mcpUrl,
      transportType: "http",
      authType: "oauth",
      status: "needs_auth",
    });
    connectionId = conn.id;
  } else {
    return NextResponse.json(
      { error: "Either connectionId, provider, or url is required" },
      { status: 400 },
    );
  }

  // Discover OAuth metadata from MCP server
  const metadata = await discoverOAuthMetadata(mcpUrl);

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/mcp/oauth/callback`;

  // Try dynamic client registration
  let clientId: string;
  let clientSecret: string | undefined;

  if (metadata.registration_endpoint) {
    try {
      const registration = await registerOAuthClient(
        metadata.registration_endpoint,
        redirectUri,
      );
      clientId = registration.clientId;
      clientSecret = registration.clientSecret;
    } catch (error) {
      console.error("Dynamic client registration failed:", error);
      return NextResponse.json(
        { error: "OAuth client registration failed with the MCP server" },
        { status: 502 },
      );
    }
  } else {
    return NextResponse.json(
      { error: "MCP server does not support dynamic client registration" },
      { status: 400 },
    );
  }

  // Store client credentials on the connection
  await updateMCPConnection(connectionId!, userId, {
    oauthClientId: clientId,
    oauthClientSecret: clientSecret ? encrypt(clientSecret) : null,
  });

  // Generate PKCE and state
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = generateState();

  // Store OAuth state for callback validation
  await createOAuthState({
    state,
    userId,
    connectionId: connectionId!,
    provider,
    codeVerifier,
    redirectTo: "/settings/connections",
    oauthClientId: clientId,
    oauthClientSecret: clientSecret ? encrypt(clientSecret) : null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
  });

  // Build authorization URL
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: metadata.authorization_endpoint,
    clientId,
    redirectUri,
    codeChallenge,
    state,
    scopes: metadata.scopes_supported,
  });

  return NextResponse.json({ authUrl, connectionId });
}
