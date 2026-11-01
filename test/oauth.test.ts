import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { bindings, message, post } from "./helpers";
import { randomToken } from "../src/portal-auth";

const origin = bindings.PORTAL_ORIGIN, resource = `${origin}/mcp`, redirect = "http://127.0.0.1:9876/callback";
const oauthEnv = { ...bindings, LINE_LOGIN_CHANNEL_SECRET: "test-login-secret" };
const user = `U${"3".repeat(32)}`, group = `C${"c".repeat(32)}`, newGroup = `C${"d".repeat(32)}`, hidden = `C${"e".repeat(32)}`;
let groups: Set<string>;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["attachments", "messages", "unsent_messages"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  groups = new Set([group]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/v2.1/token") return Response.json({ id_token: "line-identity" });
    if (url.pathname === "/oauth2/v2.1/verify") return Response.json({ sub: user, name: "LINE 利用者", aud: bindings.LINE_LOGIN_CHANNEL_ID,
      iss: "https://access.line.me", exp: Date.now() / 1000 + 3600, nonce: new URLSearchParams(init?.body as string).get("nonce") });
    const member = url.pathname.match(/^\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/);
    if (member) return groups.has(member[1]) && member[2] === user ? Response.json({ userId: user }) : new Response("{}", { status: 404 });
    const summary = url.pathname.match(/^\/v2\/bot\/group\/([^/]+)\/summary$/);
    if (summary) return Response.json({ groupId: summary[1], groupName: "グループ " + summary[1].slice(0, 4) });
    throw new Error("Unexpected upstream URL");
  });
});
afterEach(() => vi.restoreAllMocks());

function call(path: string, options: RequestInit = {}) { return worker.fetch(new Request(`${origin}${path}`, options), oauthEnv, createExecutionContext()); }
function mergeCookies(jar: Map<string, string>, response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(";")[0], split = first.indexOf("=");
    if (first.slice(split + 1)) jar.set(first.slice(0, split), first.slice(split + 1)); else jar.delete(first.slice(0, split));
  }
}
function cookie(jar: Map<string, string>) { return [...jar].map(([key, value]) => `${key}=${value}`).join("; "); }
async function setupAuthorization(redirectUri = redirect) {
  const register = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "手元のエージェント", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  expect(register.status).toBe(201);
  const client = await register.json() as { client_id: string };
  const verifier = randomToken();
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    state: "client-state", scope: "knowledge:read offline_access", resource, code_challenge: challenge, code_challenge_method: "S256" });
  const consent = await call(`/authorize?${query}`);
  expect(consent.status).toBe(200);
  expect(consent.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(consent.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
  expect(consent.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  const html = await consent.text();
  expect(html).toContain("すべてのトーク"); expect(html).toContain(new URL(redirectUri).hostname);
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const jar = new Map<string, string>(); mergeCookies(jar, consent);
  return { client, verifier, handle, jar, query };
}
async function navigationTarget(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  expect(response.headers.get("Location")).toBeNull();
  expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'none'");
  const html = await response.clone().text();
  expect(html).toContain("接続を続ける");
  const destination = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/)![1]
    .replace(/&#(\d+);/g, (_, number) => String.fromCharCode(Number(number)));
  return new URL(destination);
}
async function connect() {
  const flow = await setupAuthorization();
  const approved = await call("/authorize", { method: "POST", headers: { Cookie: cookie(flow.jar), Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle: flow.handle, decision: "approve" }) });
  mergeCookies(flow.jar, approved);
  const lineUrl = await navigationTarget(approved);
  expect(lineUrl.origin).toBe("https://access.line.me");
  const callback = await call(`/auth/line/callback?state=${lineUrl.searchParams.get("state")}&code=line-code`, { headers: { Cookie: cookie(flow.jar) } });
  mergeCookies(flow.jar, callback);
  const target = new URL(callback.headers.get("Location")!);
  expect(target.origin).toBe("http://127.0.0.1:9876");
  expect(target.searchParams.get("state")).toBe("client-state");
  const token = await call("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: flow.client.client_id, redirect_uri: redirect,
      code: target.searchParams.get("code")!, code_verifier: flow.verifier, resource }) });
  expect(token.status, await token.clone().text()).toBe(200);
  const tokens = await token.json() as { access_token: string; refresh_token: string };
  return { ...flow, tokens };
}
async function seen(id: string) {
  const event = message("そのトークの会話");
  await post([{ ...event, webhookEventId: id, source: { type: "group", groupId: id, userId: user }, message: { ...event.message, id: `message-${id}` } }]);
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await call("/mcp", { method: "POST", headers: { Host: new URL(origin).host, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.text();
  const json = JSON.parse(body.startsWith("event:") || body.startsWith("data:") ? body.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : body);
  return { response, result: json.result, wire: json };
}

describe("MCP OAuth with dynamic client registration", () => {
  it("serves each configured origin with its own issuer, resource and LINE callback", async () => {
    for (const active of [origin, bindings.LEGACY_PORTAL_ORIGIN]) {
      const metadata = await (await worker.fetch(new Request(`${active}/.well-known/oauth-authorization-server`), oauthEnv, createExecutionContext())).json() as { issuer: string; registration_endpoint: string };
      expect(metadata.issuer).toBe(active);
      expect(metadata.registration_endpoint).toBe(`${active}/oauth/register`);
      const resourceMetadata = await (await worker.fetch(new Request(`${active}/.well-known/oauth-protected-resource/mcp`), oauthEnv, createExecutionContext())).json() as { resource: string };
      expect(resourceMetadata.resource).toBe(`${active}/mcp`);
      const login = await worker.fetch(new Request(`${active}/auth/line`), oauthEnv, createExecutionContext());
      expect(new URL(login.headers.get("Location")!).searchParams.get("redirect_uri")).toBe(`${active}/auth/line/callback`);
    }
  });

  it("does not derive OAuth destinations from arbitrary incoming hostnames", async () => {
    const response = await worker.fetch(new Request("https://attacker.example/auth/line"), oauthEnv, createExecutionContext());
    const authorize = new URL(response.headers.get("Location")!);
    expect(authorize.origin).toBe("https://access.line.me");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/auth/line/callback`);
  });

  it("publishes discovery and challenges without requiring a pasted token", async () => {
    const metadata = await (await call("/.well-known/oauth-authorization-server")).json() as { registration_endpoint: string };
    expect(metadata.registration_endpoint).toBe(`${origin}/oauth/register`);
    const resourceMeta = await (await call("/.well-known/oauth-protected-resource/mcp")).json() as { resource: string };
    expect(resourceMeta.resource).toBe(resource);
    const denied = await call("/mcp");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("asks for consent before LINE sign-in and supports denial without logging in", async () => {
    const flow = await setupAuthorization();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const denied = await call("/authorize", { method: "POST", headers: { Cookie: cookie(flow.jar), Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: flow.handle, decision: "deny" }) });
    expect((await navigationTarget(denied)).searchParams.get("error")).toBe("access_denied");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["null", undefined])("accepts a browser-bound consent form with an opaque or absent Origin (%s)", async (originHeader) => {
    const flow = await setupAuthorization();
    const headers = new Headers({ Cookie: cookie(flow.jar), "Content-Type": "application/x-www-form-urlencoded" });
    if (originHeader) headers.set("Origin", originHeader);
    const approved = await call("/authorize", { method: "POST", headers,
      body: new URLSearchParams({ handle: flow.handle, decision: "approve" }) });
    expect((await navigationTarget(approved)).origin).toBe("https://access.line.me");
  });

  it("keeps rejecting foreign origins and unbound forms even when Origin is null", async () => {
    const flow = await setupAuthorization();
    const foreign = await call("/authorize", { method: "POST", headers: { Cookie: cookie(flow.jar), Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: flow.handle, decision: "approve" }) });
    expect(foreign.status).toBe(403);
    const unbound = await call("/authorize", { method: "POST", headers: { Origin: "null", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: flow.handle, decision: "approve" }) });
    expect(unbound.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("navigates an already-signed-in user to Muse once without a form redirect chain", async () => {
    const signedIn = await connect();
    const flow = await setupAuthorization("https://agent.meta.ai/api/hatch/oauth/callback");
    const jar = new Map([...signedIn.jar, ...flow.jar]);
    const request = () => call("/authorize", { method: "POST", headers: { Cookie: cookie(jar), Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: flow.handle, decision: "approve" }) });
    const response = await request();
    const target = await navigationTarget(response);
    expect(target.origin).toBe("https://agent.meta.ai");
    expect(target.pathname).toBe("/api/hatch/oauth/callback");
    expect(target.searchParams.get("state")).toBe("client-state");
    expect(target.searchParams.get("code")).toBeTruthy();
    expect((await request()).status).toBe(400);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM oauth_connections").first()).toMatchObject({ n: 2 });
  });

  it("connects via DCR, LINE and PKCE, including later-joined groups, and removes departed ones", async () => {
    await seen(group); await seen(hidden);
    const flow = await connect();
    const first = await tool(flow.tokens.access_token, "list_conversations");
    expect(first.response.status, JSON.stringify(first.wire)).toBe(200);
    expect(JSON.stringify(first.result)).toContain(group);
    expect(JSON.stringify(first.result)).not.toContain(hidden);
    await seen(newGroup); groups.add(newGroup);
    const added = await tool(flow.tokens.access_token, "list_conversations");
    expect(JSON.stringify(added.result)).toContain(newGroup);
    groups.delete(group);
    const left = await tool(flow.tokens.access_token, "list_conversations");
    expect(JSON.stringify(left.result)).not.toContain(group);
    const denied = await tool(flow.tokens.access_token, "get_recent_messages", { conversationId: hidden });
    expect(denied.result.isError).toBe(true);
    const recent = await tool(flow.tokens.access_token, "get_recent_messages", { conversationId: newGroup });
    expect(JSON.stringify(recent.result)).toContain("そのトークの会話");
  });

  it("refreshes tokens and invalidates access and refresh after the user revokes the connection", async () => {
    const flow = await connect();
    const refresh = await call("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: flow.client.client_id, refresh_token: flow.tokens.refresh_token, resource }) });
    expect(refresh.status).toBe(200);
    const updated = await refresh.json() as { access_token: string; refresh_token: string };
    const portal = await (await call("/api/portal", { headers: { Cookie: cookie(flow.jar) } })).json() as { connections: { id: string }[]; csrfToken: string };
    expect(portal.connections).toHaveLength(1);
    const revoked = await call(`/api/connections/${portal.connections[0].id}`, { method: "DELETE",
      headers: { Cookie: cookie(flow.jar), Origin: origin, "X-CSRF-Token": portal.csrfToken } });
    expect(revoked.status).toBe(204);
    expect((await call("/mcp", { headers: { Authorization: `Bearer ${updated.access_token}` } })).status).toBe(401);
    const after = await call("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: flow.client.client_id, refresh_token: updated.refresh_token, resource }) });
    expect(after.status).toBe(400);
  });

  it("rejects an arbitrary redirect and forged consent form", async () => {
    const flow = await setupAuthorization();
    const forged = await call("/authorize", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: flow.handle, decision: "approve" }) });
    expect(forged.status).toBe(400);
    flow.query.set("redirect_uri", "https://evil.example/callback");
    const mismatched = await call(`/authorize?${flow.query}`);
    expect(mismatched.status).toBe(400);
    expect(mismatched.headers.get("Location")).toBeNull();
  });
});
