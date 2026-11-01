import { sha256 } from "./ai";
import { readLimitedBody } from "./http";
import { accessibleConversations, verifyConversationAccess } from "./conversations";
import { handlePortalAuth, portalSession, validPortalMutation, randomToken, portalOrigin, loginConfigured } from "./portal-auth";
import { portalHtml, portalJs, portalCss } from "./portal-ui";
import { handleMcpConsent } from "./oauth-consent";
import { oauthServer } from "./oauth-server";

export async function handlePortal(request: Request, env: Env): Promise<Response> {
  let response: Response;
  try { response = await route(request, env); }
  catch {
    console.error(JSON.stringify({ event: "portal_request_failed" }));
    response = Response.json({ error: "参加情報を確認できませんでした。少し待ってから再試行してください。" }, { status: 503 });
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", new URL(request.url).pathname === "/authorize" ? "same-origin" : "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (!response.headers.has("Content-Security-Policy")) {
    response.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://qr-official.line.me; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  return response;
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/authorize") return handleMcpConsent(request, env);
  if (path.startsWith("/auth/")) return handlePortalAuth(request, env);
  if (request.method === "GET" && (path === "/" || path === "/portal")) {
    return new Response(portalHtml(loginConfigured(env)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method === "GET" && path === "/portal.js") return new Response(portalJs, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
  if (request.method === "GET" && path === "/portal.css") return new Response(portalCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });
  const session = await portalSession(request, env);
  if (!session) return Response.json({ error: "LINE でログインしてください。" }, { status: 401 });
  if (path === "/api/portal" && request.method === "GET") {
    const accessible = await accessibleConversations(session.userId, env);
    const connections = await env.DB.prepare(`SELECT id, client_name, created_at, expires_at
      FROM oauth_connections WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100`)
      .bind(session.userId, Date.now()).all();
    return Response.json({ user: { displayName: session.displayName }, csrfToken: session.csrfToken,
      ...accessible, connections: connections.results, mcpEndpoint: `${portalOrigin(env)}/mcp` });
  }
  if (!await validPortalMutation(request, session, env)) return Response.json({ error: "ページを再読み込みして試してください。" }, { status: 403 });
  const connection = path.match(/^\/api\/connections\/([a-f0-9-]{36})$/);
  if (connection && request.method === "DELETE") {
    const changed = await env.DB.prepare("UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), connection[1], session.userId).run();
    if (!changed.meta.changes) return Response.json({ error: "接続が見つかりません。" }, { status: 404 });
    const oauth = oauthServer(env).getOAuthApi(env);
    const grants = await oauth.listUserGrants(session.userId);
    for (const grant of grants.items) {
      if (grant.metadata?.connectionId === connection[1]) await oauth.revokeGrant(grant.id, session.userId);
    }
    return new Response(null, { status: 204 });
  }
  if (path === "/api/tokens" && request.method === "POST") {
    let input: { label?: unknown; conversationIds?: unknown };
    try { input = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, 4000))); }
    catch { return Response.json({ error: "入力を確認してください。" }, { status: 400 }); }
    if (!input || typeof input.label !== "string" || !input.label.trim() || input.label.length > 60
      || !Array.isArray(input.conversationIds) || input.conversationIds.length < 1 || input.conversationIds.length > 20
      || !input.conversationIds.every((id) => typeof id === "string" && /^[CR][a-f0-9]{32}$/.test(id))) {
      return Response.json({ error: "名前と参照するトークを選んでください。" }, { status: 400 });
    }
    const ids = [...new Set(input.conversationIds as string[])];
    const allowed = await Promise.all(ids.map((id) => verifyConversationAccess(session.userId, id, env)));
    if (allowed.some((item) => !item)) return Response.json({ error: "参照できないトークが含まれています。更新して選び直してください。" }, { status: 403 });
    const token = randomToken(), now = Date.now(), expiry = now + 30 * 24 * 3600_000;
    const created = await env.DB.prepare(`INSERT INTO search_clients(token_hash, label, conversation_ids, owner_user_id, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM search_clients WHERE owner_user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 20`)
      .bind(await sha256(token), input.label.trim(), JSON.stringify(ids), session.userId, expiry, now, session.userId, now).run();
    if (!created.meta.changes) return Response.json({ error: "有効なトークンは20個までです。不要なものを失効してください。" }, { status: 409 });
    return Response.json({ token, expiresAt: expiry, conversationIds: ids }, { status: 201 });
  }
  const revoke = path.match(/^\/api\/tokens\/([a-f0-9]{64})$/);
  if (revoke && request.method === "DELETE") {
    const changed = await env.DB.prepare("UPDATE search_clients SET revoked_at = ? WHERE token_hash = ? AND owner_user_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), revoke[1], session.userId).run();
    return changed.meta.changes ? new Response(null, { status: 204 }) : Response.json({ error: "トークンが見つかりません。" }, { status: 404 });
  }
  return new Response("Not found", { status: 404 });
}
