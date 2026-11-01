import { sha256 } from "./ai";
import { type AuthRequest, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { oauthServer, completeMcpAuthorization } from "./oauth-server";
import { applicationOrigin } from "./origins";

const SESSION_COOKIE = "__Host-line_session";
const FLOW_COOKIE = "__Host-line_oauth";
const SESSION_SECONDS = 7 * 24 * 3600;
export type PortalSession = { userId: string; displayName: string; csrfToken: string };

export function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export function portalOrigin(env: Env): string { return applicationOrigin(env); }
export function loginConfigured(env: Env): boolean { return Boolean(env.LINE_LOGIN_CHANNEL_ID && env.LINE_LOGIN_CHANNEL_SECRET); }
function cookie(request: Request, name: string): string {
  return (request.headers.get("Cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}
function setCookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
function redirect(location: string, cookies: string[] = [], inherited?: Headers): Response {
  const headers = new Headers(inherited);
  headers.set("Location", location); headers.set("Cache-Control", "no-store"); headers.set("Referrer-Policy", "no-referrer");
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}

export async function beginLineLogin(env: Env, oauthRequest?: AuthRequest, headers?: Headers, returnTo = "/"): Promise<Response> {
  if (!loginConfigured(env)) return new Response("LINE ログインの設定を準備しています。", { status: 503 });
  const upstream = oauthRequest ? await oauthServer(env).getOAuthApi(env).beginUpstream(oauthRequest, { headers }) : undefined;
  const state = upstream?.state ?? randomToken(), nonce = randomToken(), verifier = randomToken();
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM portal_login_flows WHERE expires_at <= ?").bind(Date.now()),
    env.DB.prepare("DELETE FROM portal_sessions WHERE expires_at <= ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO portal_login_flows(state_hash, nonce, code_verifier, expires_at, oauth_flow, return_to) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256(state), nonce, verifier, Date.now() + 600_000, oauthRequest ? 1 : 0, safeReturnTo(returnTo)),
  ]);
  const authorize = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authorize.search = new URLSearchParams({ response_type: "code", client_id: env.LINE_LOGIN_CHANNEL_ID,
    redirect_uri: `${portalOrigin(env)}/auth/line/callback`, state, nonce, scope: "openid profile",
    code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return redirect(authorize.toString(), [setCookie(FLOW_COOKIE, state, 600)], upstream?.headers ?? headers);
}

export async function portalSession(request: Request, env: Env): Promise<PortalSession | null> {
  const token = cookie(request, SESSION_COOKIE);
  if (!/^[\w-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT s.user_id, u.display_name, s.csrf_token FROM portal_sessions s
    JOIN portal_users u USING(user_id) WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256(token), Date.now()).first<{ user_id: string; display_name: string; csrf_token: string }>();
  return row ? { userId: row.user_id, displayName: row.display_name, csrfToken: row.csrf_token } : null;
}

export async function validPortalMutation(request: Request, session: PortalSession, env: Env): Promise<boolean> {
  // Compare via Web Crypto, without character-by-character secret comparison in JS.
  if (request.headers.get("Origin") !== portalOrigin(env)) return false;
  const supplied = request.headers.get("X-CSRF-Token");
  if (!supplied || !/^[\w-]{43}$/.test(supplied)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(session.csrfToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const data = new TextEncoder().encode("portal-csrf");
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const submittedKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(supplied),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", submittedKey, signature, data);
}

export async function handlePortalAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    const session = await portalSession(request, env);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!await validPortalMutation(request, session, env)) return new Response("Forbidden", { status: 403 });
    await env.DB.prepare("DELETE FROM portal_sessions WHERE token_hash = ?").bind(await sha256(cookie(request, SESSION_COOKIE))).run();
    return redirect(`${portalOrigin(env)}/`, [setCookie(SESSION_COOKIE, "", 0)]);
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (!loginConfigured(env)) return new Response("LINE ログインの設定を準備しています。", { status: 503 });
  const callback = `${portalOrigin(env)}/auth/line/callback`;
  if (url.pathname === "/auth/line") {
    return beginLineLogin(env, undefined, undefined, url.searchParams.get("returnTo") ?? "/");
  }
  if (url.pathname !== "/auth/line/callback") return new Response("Not found", { status: 404 });
  const state = url.searchParams.get("state") ?? "", bound = cookie(request, FLOW_COOKIE);
  if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(bound)) return new Response("ログインを最初からやり直してください。", { status: 400 });
  const flow = await env.DB.prepare(`DELETE FROM portal_login_flows WHERE state_hash = ? AND state_hash = ? AND expires_at > ?
    RETURNING nonce, code_verifier, oauth_flow, return_to`).bind(await sha256(state), await sha256(bound), Date.now())
    .first<{ nonce: string; code_verifier: string; oauth_flow: number; return_to: string }>();
  const code = url.searchParams.get("code");
  if (!flow) {
    return redirect(`${portalOrigin(env)}/?login=failed`, [setCookie(FLOW_COOKIE, "", 0)]);
  }
  let downstream: AuthRequest | undefined;
  let upstreamHeaders: Headers | undefined;
  try {
    if (flow.oauth_flow) {
      const resumed = await oauthServer(env).getOAuthApi(env).finishUpstream(request);
      downstream = resumed.request; upstreamHeaders = resumed.headers;
    }
    if (!code || code.length > 2048 || url.searchParams.has("error")) throw new Error("Login declined");
    const tokenResponse = await fetch("https://api.line.me/oauth2/v2.1/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callback,
        client_id: env.LINE_LOGIN_CHANNEL_ID!, client_secret: env.LINE_LOGIN_CHANNEL_SECRET!, code_verifier: flow.code_verifier }),
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenResponse.ok) { await tokenResponse.body?.cancel(); throw new Error("Login exchange failed"); }
    const tokens = await tokenResponse.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new Error("Missing identity");
    const verified = await fetch("https://api.line.me/oauth2/v2.1/verify", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: tokens.id_token, client_id: env.LINE_LOGIN_CHANNEL_ID!, nonce: flow.nonce }),
      signal: AbortSignal.timeout(8000),
    });
    if (!verified.ok) { await verified.body?.cancel(); throw new Error("Identity verification failed"); }
    const claims = await verified.json() as { sub?: unknown; aud?: unknown; iss?: unknown; exp?: unknown; nonce?: unknown; name?: unknown };
    if (typeof claims.sub !== "string" || !/^U[a-f0-9]{32}$/.test(claims.sub) || claims.aud !== env.LINE_LOGIN_CHANNEL_ID
      || claims.iss !== "https://access.line.me" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()
      || claims.nonce !== flow.nonce || typeof claims.name !== "string") throw new Error("Invalid identity");
    const session = randomToken();
    const oldToken = cookie(request, SESSION_COOKIE);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO portal_users(user_id, display_name, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`)
        .bind(claims.sub, claims.name.slice(0, 200), Date.now()),
      env.DB.prepare("DELETE FROM portal_sessions WHERE token_hash = ?").bind(await sha256(oldToken)),
      env.DB.prepare("INSERT INTO portal_sessions(token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256(session), claims.sub, randomToken(), Date.now() + SESSION_SECONDS * 1000),
    ]);
    // LINE access/refresh/ID tokens are never persisted or exposed to the browser.
    const target = downstream ? await completeMcpAuthorization(downstream, claims.sub, env) : `${portalOrigin(env)}${safeReturnTo(flow.return_to)}`;
    return redirect(target, [setCookie(SESSION_COOKIE, session, SESSION_SECONDS), setCookie(FLOW_COOKIE, "", 0)], upstreamHeaders);
  } catch {
    console.error(JSON.stringify({ event: "portal_login_failed" }));
    return redirect(downstream ? authorizationErrorRedirect(downstream, "access_denied") : `${portalOrigin(env)}/?login=failed`,
      [setCookie(FLOW_COOKIE, "", 0)], upstreamHeaders);
  }
}

export function safeReturnTo(value: string): string {
  return /^\/\?view=(?:knowledge|history|connections)$/.test(value) || /^\/knowledge\/[a-f0-9-]{36}(?:\?conversationId=[CR][a-f0-9]{32})?$/.test(value) ? value : "/";
}
