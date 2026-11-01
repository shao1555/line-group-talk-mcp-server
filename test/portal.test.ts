import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index";
import { sha256 } from "../src/ai";
import { authenticateSearch } from "../src/search";
import { bindings, message, post } from "./helpers";

const origin = bindings.PORTAL_ORIGIN;
const portalEnv = { ...bindings, LINE_LOGIN_CHANNEL_SECRET: "test-login-secret" };
const user = `U${"1".repeat(32)}`, other = `U${"2".repeat(32)}`;
const group = `C${"a".repeat(32)}`, hiddenGroup = `C${"b".repeat(32)}`;
let loginUser = user;
let membership: Set<string>;
let lineFetch: MockInstance<typeof fetch>;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["attachments", "messages", "unsent_messages"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  loginUser = user;
  membership = new Set();
  lineFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/v2.1/token") return Response.json({ id_token: "verified-id-token", access_token: "must-not-be-stored" });
    if (url.pathname === "/oauth2/v2.1/verify") {
      const body = new URLSearchParams(init?.body as string);
      return Response.json({ sub: loginUser, aud: bindings.LINE_LOGIN_CHANNEL_ID, iss: "https://access.line.me",
        exp: Math.floor(Date.now() / 1000) + 3600, nonce: body.get("nonce"), name: "テスト利用者" });
    }
    const match = url.pathname.match(/^\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/);
    if (match) return membership.has(`${match[1]}:${match[2]}`) ? Response.json({ userId: match[2], displayName: "参加者" }) : new Response("{}", { status: 404 });
    const summary = url.pathname.match(/^\/v2\/bot\/group\/([^/]+)\/summary$/);
    if (summary) return Response.json({ groupId: summary[1], groupName: summary[1] === group ? "いつものグループ" : "見えてはいけない名前" });
    throw new Error("Unexpected LINE endpoint");
  });
});
afterEach(() => vi.restoreAllMocks());

function call(path: string, options: RequestInit = {}) {
  return worker.fetch(new Request(`${origin}${path}`, options), portalEnv, createExecutionContext());
}
async function begin() {
  const response = await call("/auth/line");
  const location = new URL(response.headers.get("Location")!);
  const cookie = `__Host-line_oauth=${location.searchParams.get("state")}`;
  return { response, location, cookie };
}
async function login() {
  const flow = await begin();
  const response = await call(`/auth/line/callback?code=code&state=${flow.location.searchParams.get("state")}`, { headers: { Cookie: flow.cookie } });
  const token = response.headers.get("Set-Cookie")!.match(/__Host-line_session=([^;]+)/)![1];
  const cookie = `__Host-line_session=${token}`;
  const session = await env.DB.prepare("SELECT csrf_token FROM portal_sessions WHERE token_hash = ?").bind(await sha256(token)).first<{ csrf_token: string }>();
  return { cookie, token, csrf: session!.csrf_token };
}
async function seen(id: string, sender = other) {
  const event = message("記録された発言");
  await post([{ ...event, webhookEventId: `event-${id}`, source: { type: "group", groupId: id, userId: sender }, message: { ...event.message, id: `message-${id}` } }]);
}
function mutation(session: { cookie: string; csrf: string }, body?: unknown): RequestInit {
  return { method: "POST", headers: { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

describe("LINE portal login", () => {
  it("serves the public portal with security headers and protects the API", async () => {
    const response = await call("/");
    expect(await response.text()).toContain("LINE でログイン");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await call("/api/portal")).status).toBe(401);
    expect((await call("/api/tokens", { method: "POST" })).status).toBe(401);
  });

  it("uses PKCE, nonce, a browser-bound one-time state and a secure rotating session", async () => {
    const flow = await begin();
    expect(flow.location.searchParams.get("scope")).toBe("openid profile");
    expect(flow.location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.location.searchParams.get("redirect_uri")).toBe(`${origin}/auth/line/callback`);
    expect(flow.response.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    const state = flow.location.searchParams.get("state")!;
    const challenge = flow.location.searchParams.get("code_challenge");
    const stored = await env.DB.prepare("SELECT state_hash, code_verifier FROM portal_login_flows").first<{ state_hash: string; code_verifier: string }>();
    expect(stored!.state_hash).not.toBe(state);
    expect(challenge).not.toBe(stored!.code_verifier);
    const callback = `/auth/line/callback?state=${state}&code=one-time`;
    const response = await call(callback, { headers: { Cookie: flow.cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-line_session=");
    const count = lineFetch.mock.calls.length;
    await call(callback, { headers: { Cookie: flow.cookie } });
    expect(lineFetch.mock.calls).toHaveLength(count);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM portal_login_flows").first()).toMatchObject({ n: 0 });
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM portal_sessions").all())).not.toContain("must-not-be-stored");
  });

  it("rejects missing or mismatched browser state without exchanging a code", async () => {
    const a = await begin(), b = await begin();
    const path = `/auth/line/callback?state=${a.location.searchParams.get("state")}&code=stolen`;
    expect((await call(path)).status).toBe(400);
    expect((await call(path, { headers: { Cookie: b.cookie } })).headers.get("Location")).toContain("login=failed");
    expect(lineFetch).not.toHaveBeenCalled();
  });

  it.each(["audience", "nonce", "expiry"])("rejects an invalid verified identity (%s)", async (kind) => {
    const flow = await begin();
    lineFetch.mockResolvedValueOnce(Response.json({ id_token: "invalid" })).mockResolvedValueOnce(Response.json({ sub: user,
      aud: kind === "audience" ? "other-app" : bindings.LINE_LOGIN_CHANNEL_ID,
      nonce: kind === "nonce" ? "other-nonce" : flow.location.searchParams.get("nonce"), iss: "https://access.line.me",
      exp: kind === "expiry" ? 1 : Math.floor(Date.now() / 1000) + 3600, name: "test" }));
    const response = await call(`/auth/line/callback?state=${flow.location.searchParams.get("state")}&code=code`, { headers: { Cookie: flow.cookie } });
    expect(response.headers.get("Location")).toContain("login=failed");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM portal_sessions").first()).toMatchObject({ n: 0 });
  });

  it("expires sessions and makes logout invalidate the current session", async () => {
    const session = await login();
    expect((await call("/auth/logout", mutation(session))).status).toBe(303);
    expect((await call("/api/portal", { headers: { Cookie: session.cookie } })).status).toBe(401);
    const another = await login();
    await env.DB.prepare("UPDATE portal_sessions SET expires_at = 1").run();
    expect((await call("/api/portal", { headers: { Cookie: another.cookie } })).status).toBe(401);
  });
});

describe("conversation visibility and MCP scopes", () => {
  it("finds a silent member while hiding groups the logged-in user has not joined", async () => {
    await seen(group); await seen(hiddenGroup);
    membership.add(`${group}:${user}`);
    const session = await login();
    const response = await call("/api/portal", { headers: { Cookie: session.cookie } });
    const data = await response.json() as { conversations: { id: string }[] };
    expect(data.conversations.map((item) => item.id)).toEqual([group]);
    expect(JSON.stringify(data)).not.toContain(hiddenGroup);
    expect(JSON.stringify(data)).not.toContain("見えてはいけない名前");
  });

  it("does not treat old messages as proof of current membership", async () => {
    await seen(group, user);
    const session = await login();
    const data = await (await call("/api/portal", { headers: { Cookie: session.cookie } })).json() as { conversations: unknown[] };
    expect(data.conversations).toEqual([]);
  });

  it("requires same-origin CSRF and live membership before issuing a token", async () => {
    await seen(group); membership.add(`${group}:${user}`);
    const session = await login();
    const body = { label: "Codex", conversationIds: [group] };
    const missing = mutation(session, body); delete (missing.headers as Record<string, string>)["X-CSRF-Token"];
    expect((await call("/api/tokens", missing)).status).toBe(403);
    const foreign = mutation(session, body); (foreign.headers as Record<string, string>).Origin = "https://evil.example";
    expect((await call("/api/tokens", foreign)).status).toBe(403);
    expect((await call("/api/tokens", mutation(session, { ...body, conversationIds: [hiddenGroup] }))).status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM search_clients").first()).toMatchObject({ n: 0 });
  });

  it("issues a hashed, owned, scoped token and revokes it only for its owner", async () => {
    await seen(group); membership.add(`${group}:${user}`);
    const session = await login();
    const issued = await call("/api/tokens", mutation(session, { label: "Codex", conversationIds: [group] }));
    expect(issued.status).toBe(201);
    const data = await issued.json() as { token: string };
    const hash = await sha256(data.token);
    const saved = await env.DB.prepare("SELECT * FROM search_clients WHERE token_hash = ?").bind(hash).first();
    expect(saved).toMatchObject({ owner_user_id: user, conversation_ids: JSON.stringify([group]) });
    expect(JSON.stringify(saved)).not.toContain(data.token);
    const authenticated = new Request(`${origin}/mcp`, { headers: { Authorization: `Bearer ${data.token}` } });
    expect(await authenticateSearch(authenticated, portalEnv)).toEqual({ conversationIds: [group] });
    membership.delete(`${group}:${user}`);
    expect(await authenticateSearch(authenticated, portalEnv)).toEqual({ conversationIds: [] });
    membership.add(`${group}:${user}`);
    const list = await call("/api/portal", { headers: { Cookie: session.cookie } });
    expect(await list.text()).not.toContain(data.token);
    loginUser = other; const another = await login();
    expect((await call(`/api/tokens/${hash}`, { ...mutation(another), method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/tokens/${hash}`, { ...mutation(session), method: "DELETE" })).status).toBe(204);
    expect((await call("/search", { method: "POST", headers: { Authorization: `Bearer ${data.token}` }, body: JSON.stringify({ query: "test", conversationId: group }) })).status).toBe(401);
  });

  it.each(["user-left", "bot-left", "expired"])("removes issued-token access after %s", async (kind) => {
    await seen(group); membership.add(`${group}:${user}`);
    const session = await login();
    const response = await call("/api/tokens", mutation(session, { label: "Codex", conversationIds: [group] }));
    const issued = await response.json() as { token: string };
    if (kind === "expired") await env.DB.prepare("UPDATE search_clients SET expires_at = 1").run();
    else await post([{ type: kind === "bot-left" ? "leave" : "memberLeft", webhookEventId: "leave-event", timestamp: 1700000010000,
      source: { type: "group", groupId: group }, left: { members: [{ userId: user }] } }]);
    const search = await call("/search", { method: "POST", headers: { Authorization: `Bearer ${issued.token}` }, body: JSON.stringify({ query: "test", conversationId: group }) });
    expect(search.status).toBe(kind === "expired" ? 401 : 403);
  });

  it("fails closed on LINE errors and does not restore a left bot with a delayed message", async () => {
    await seen(group);
    await post([{ type: "leave", webhookEventId: "leave", timestamp: 1700000010000, source: { type: "group", groupId: group } }]);
    await seen(group);
    expect(await env.DB.prepare("SELECT bot_active FROM conversations WHERE conversation_id = ?").bind(group).first()).toMatchObject({ bot_active: 0 });
    await env.DB.prepare("UPDATE conversations SET bot_active = 1").run();
    const session = await login();
    lineFetch.mockResolvedValue(new Response("{}", { status: 500 }));
    const data = await (await call("/api/portal", { headers: { Cookie: session.cookie } })).json() as { conversations: unknown[]; incomplete: boolean };
    expect(data).toMatchObject({ conversations: [], incomplete: true });
    expect((await call("/api/tokens", mutation(session, { label: "Codex", conversationIds: [group] }))).status).toBe(503);
  });
});
