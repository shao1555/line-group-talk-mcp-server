import { OAuthAuthorizationServer, OAuthError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { applicationOrigin } from "./origins";

export const READ_SCOPE = "knowledge:read";
export type McpIdentity = { userId: string; connectionId: string };
export function oauthServer(env: Env): OAuthAuthorizationServer<Env> {
  const origin = applicationOrigin(env);
  return new OAuthAuthorizationServer<Env>({
    issuer: origin, resources: [`${origin}/mcp`], defaultResource: `${origin}/mcp`,
    authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [READ_SCOPE, "offline_access"], accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 3600,
    clientRegistrationTTL: 90 * 24 * 3600,
    clientIdMetadataDocumentEnabled: false,
    tokenExchangeCallback: async ({ props }) => {
      const identity = props as Partial<McpIdentity> | undefined;
      if (!identity?.userId || !identity.connectionId || !await connectionActive(identity as McpIdentity, env)) {
        throw new OAuthError("invalid_grant", { description: "This connection is no longer authorized" });
      }
    },
    onError: ({ code, status }) => { console.warn(JSON.stringify({ event: "mcp_oauth_error", code, status })); },
  });
}

export async function connectionActive(identity: McpIdentity, env: Env): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT id FROM oauth_connections
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(identity.connectionId, identity.userId, Date.now()).first());
}

export async function completeMcpAuthorization(request: AuthRequest, userId: string, env: Env): Promise<string> {
  const oauth = oauthServer(env).getOAuthApi(env);
  const client = await oauth.lookupClient(request.clientId);
  if (!client) throw new Error("Unknown client");
  const connectionId = crypto.randomUUID();
  const now = Date.now();
  const inserted = await env.DB.prepare(`INSERT INTO oauth_connections(id, user_id, client_id, client_name, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM oauth_connections WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 20`)
    .bind(connectionId, userId, request.clientId, (client.clientName ?? "MCP クライアント").slice(0, 200), now,
      now + 30 * 24 * 3600_000, userId, now).run();
  if (!inserted.meta.changes) throw new Error("Connection limit reached");
  const result = await oauth.completeAuthorization({ request, userId, metadata: { connectionId },
    scope: request.scope, props: { userId, connectionId } satisfies McpIdentity, revokeExistingGrants: false });
  return result.redirectTo;
}
