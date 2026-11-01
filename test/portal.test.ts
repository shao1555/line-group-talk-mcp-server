import { portalHtml } from "../src/portal-ui";
import { syncDocumentProjections } from "../src/documents";
import { searchKnowledge } from "../src/search";
import { directEvidenceAvailable } from "../src/direct-chat";
import { recentMessages } from "../src/knowledge-tools";
import { recordSentBotMessage } from "../src/bot-messages";
import { EMBEDDING_MODEL } from "../src/ai";
import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, createMessageBatch } from "cloudflare:test";
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
  await env.DB.batch(["attachments", "messages", "unsent_messages", "history_imports"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
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


describe("history uploads", () => {
  const exportText = '[LINE] いつものグループのトーク履歴\n保存日時：2026/11/01 13:15\n\n2019/08/05(月)\n12:15\t山田\tこんにちは\n12:16\t佐藤\t"複数行の発言\n続きです"\n12:17\t山田\t[写真]\n';
  function upload(session: { cookie: string; csrf: string }, text = exportText, id = group) {
    return call('/api/imports?' + new URLSearchParams({ conversationId: id, fileName: 'LINE.txt' }), { ...mutation(session), body: text });
  }
  it("previews, imports into one authorized talk, preserves provenance and deduplicates", async () => {
    await seen(group); membership.add(`${group}:${user}`);
    const session = await login();
    const preview = await upload(session);
    expect(preview.status).toBe(200);
    const data = await preview.json() as { id: string; total: number; skipped: number; from: number };
    expect(data).toMatchObject({ total: 2, skipped: 1, from: Date.parse('2019-08-05T12:15:00+09:00') });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM messages WHERE import_id IS NOT NULL').first('n')).toBe(0);
    const proceed = () => call(`/api/imports/${data.id}/continue`, mutation(session));
    expect(await (await proceed()).json()).toMatchObject({ total: 2, cursor: 2, inserted: 2, done: true });
    const row = await env.DB.prepare('SELECT * FROM messages WHERE import_id = ? ORDER BY sent_at').bind(data.id).first();
    expect(row).toMatchObject({ user_id: null, sender_name: '山田', conversation_id: group, source_line: 5, text: 'こんにちは', webhook_event_id: null });
    const jobs = await env.DB.prepare('SELECT count(*) AS n FROM knowledge_jobs j JOIN messages m USING(message_id) WHERE m.import_id = ?').bind(data.id).first('n');
    expect(jobs).toBe(2);
    expect((await upload(session)).status).toBe(200);
    expect(await (await proceed()).json()).toMatchObject({ inserted: 2, done: true });
    // A different export header gives another file identity but the same message identities.
    const second = await (await upload(session, exportText.replace('13:15', '13:16'))).json() as { id: string };
    expect(await (await call(`/api/imports/${second.id}/continue`, mutation(session))).json()).toMatchObject({ inserted: 0, done: true });
  });
  it("reports import and indexing progress only for current member chats, including other uploaders", async () => {
    await seen(group); await seen(hiddenGroup);
    membership.add(`${group}:${user}`); membership.add(`${hiddenGroup}:${user}`);
    const session = await login();
    const text = '[LINE] グループのトーク履歴\n2020/01/02(木)\n' + Array.from({ length: 8 }, (_, i) => `10:00\t名前\t発言${i}`).join('\n');
    const { id } = await (await upload(session, text)).json() as { id: string };
    const read = async (cookie = session.cookie) => (await call('/api/imports', { headers: { Cookie: cookie } })).json() as Promise<{ imports: { id: string }[] }>;
    expect((await read()).imports).toEqual([expect.objectContaining({ total: 8, cursor: 0, imported: 0, pending: 0, ready: 0 })]);
    await call(`/api/imports/${id}/continue`, mutation(session));
    const rows = await env.DB.prepare('SELECT message_id FROM messages WHERE import_id = ? ORDER BY source_line').bind(id).all<{ message_id: string }>();
    await env.DB.batch(['ready', 'ready', 'failed', 'skipped', 'budget_wait', 'pending', 'pending', 'ready'].map((status, i) =>
      env.DB.prepare('UPDATE knowledge_jobs SET status = ? WHERE message_id = ?').bind(status, rows.results[i].message_id)));
    await env.DB.prepare('DELETE FROM knowledge_jobs WHERE message_id = ?').bind(rows.results[6].message_id).run();
    await env.DB.prepare('UPDATE messages SET unsent_at = 1 WHERE message_id = ?').bind(rows.results[7].message_id).run();
    const duplicate = await (await upload(session, text + '\n')).json() as { id: string };
    await call(`/api/imports/${duplicate.id}/continue`, mutation(session));
    const secret = await (await upload(session, text, hiddenGroup)).json() as { id: string };
    membership.delete(`${hiddenGroup}:${user}`);
    const data = await read();
    expect(data.imports.find((r) => r.id === id)).toMatchObject({ cursor: 8, imported: 8, ready: 2, pending: 2, failed: 1, skipped: 1, budget_wait: 1, cancelled: 1, duplicates: 0 });
    // A repeated delivery/status write changes no counts; the counter rolls back with its job update.
    await env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready' WHERE message_id = ?").bind(rows.results[0].message_id).run();
    await expect(env.DB.batch([
      env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready' WHERE message_id = ?").bind(rows.results[5].message_id),
      env.DB.prepare("INSERT INTO history_import_counts(import_id, status, count) VALUES (?, 'ready', -1)").bind(id),
    ])).rejects.toThrow();
    expect((await read()).imports.find((r) => r.id === id)).toMatchObject({ ready: 2, pending: 2 });
    // Budget recovery and a missing/deleted job also keep the buckets consistent.
    await env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready' WHERE message_id = ?").bind(rows.results[4].message_id).run();
    await env.DB.prepare('DELETE FROM knowledge_jobs WHERE message_id = ?').bind(rows.results[0].message_id).run();
    expect((await read()).imports.find((r) => r.id === id)).toMatchObject({ ready: 2, budget_wait: 0, pending: 3 });
    expect(data.imports.find((r) => r.id === duplicate.id)).toMatchObject({ cursor: 8, imported: 0, duplicates: 8, ready: 0, pending: 0 });
    expect(JSON.stringify(data)).not.toContain(secret.id);
    loginUser = other; membership.add(`${group}:${other}`); const member = await login();
    expect((await read(member.cookie)).imports.map((r) => r.id)).toContain(id);
    membership.delete(`${group}:${other}`);
    expect((await read(member.cookie)).imports).toEqual([]);
    expect((await call('/api/imports')).status).toBe(401);
  });
  it("requires session, CSRF, live membership, and import ownership", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`);
    const session = await login();
    expect((await call('/api/imports', { method: 'POST' })).status).toBe(401);
    expect((await call('/api/imports', { method: 'POST', headers: { Cookie: session.cookie }, body: exportText })).status).toBe(403);
    expect((await upload(session, exportText, hiddenGroup)).status).toBe(403);
    const data = await (await upload(session)).json() as { id: string };
    loginUser = other; membership.add(`${group}:${other}`); const another = await login();
    expect((await call(`/api/imports/${data.id}/continue`, mutation(another))).status).toBe(404);
    membership.delete(`${group}:${user}`);
    expect((await call(`/api/imports/${data.id}/continue`, mutation(session))).status).toBe(403);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM messages WHERE import_id IS NOT NULL').first('n')).toBe(0);
  });
  it("resumes batches safely after duplicate concurrent requests", async () => {
    await seen(group); membership.add(`${group}:${user}`); const session = await login();
    const text = '[LINE] グループのトーク履歴\n2020/01/02(木)\n' + Array.from({ length: 205 }, (_, i) => `10:00\t名前\t発言${i}`).join('\n');
    const data = await (await upload(session, text)).json() as { id: string };
    const proceed = () => call(`/api/imports/${data.id}/continue`, mutation(session));
    expect(await (await proceed()).json()).toMatchObject({ cursor: 100, done: false });
    await Promise.all([proceed(), proceed()]);
    const end = await (await proceed()).json();
    expect(end).toMatchObject({ cursor: 205, inserted: 205, done: true });
  });
  it("rejects invalid formats and oversized uploads without creating imports", async () => {
    await seen(group); membership.add(`${group}:${user}`); const session = await login();
    expect((await upload(session, 'not a LINE export')).status).toBe(400);
    expect((await upload(session, 'x'.repeat(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM history_imports').first('n')).toBe(0);
  });
});


describe("uploaded knowledge", () => {
  const vector = Array.from({ length: 1024 }, () => 0.1);
  beforeEach(() => {
    vi.spyOn(bindings.ATTACHMENT_QUEUE, "send").mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    vi.spyOn(bindings.AI, "run").mockImplementation(async (model) => { if (model !== EMBEDDING_MODEL) throw new Error("Unexpected paid model"); return { data: [vector] }; });
    vi.spyOn(bindings.KNOWLEDGE, "upsert").mockResolvedValue({ ids: [], count: 0 });
    vi.spyOn(bindings.KNOWLEDGE, "deleteByIds").mockResolvedValue({ ids: [], count: 0 });
    vi.spyOn(bindings.KNOWLEDGE, "query").mockResolvedValue({ count: 0, matches: [] });
  });
  async function upload(session: { cookie: string; csrf: string }, chats = [group], text = "集合場所は南口です。", fileName = "note.txt") {
    return call('/api/documents?' + new URLSearchParams({ title: '旅行ノート', fileName, conversationIds: JSON.stringify(chats) }), { ...mutation(session), body: text });
  }
  async function consume(id: string) {
    await worker.queue(createMessageBatch('line-group-talk-knowledge', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { messageId: id } }]), bindings);
  }
  async function ready(id: string, chats = [group]) {
    await consume(`document:${id}`); await syncDocumentProjections(bindings, id);
    for (const chat of chats) await consume(`knowledge:${id}:${chat}`);
  }
  function toggle(session: { cookie: string; csrf: string }, id: string, enabled: boolean, chat = group) {
    return call(`/api/documents/${id}/chats/${chat}`, { ...mutation(session, { enabled }), method: 'PUT' });
  }
  it("uploads one original and reuses extracted text and embeddings across selected chats", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`); membership.add(`${hiddenGroup}:${user}`);
    const session = await login(); const response = await upload(session, [group, hiddenGroup]);
    expect(response.status).toBe(201); const { id } = await response.json() as { id: string };
    expect((await env.ATTACHMENTS.get(`knowledge-documents/${id}`))?.size).toBeGreaterThan(0);
    await ready(id, [group, hiddenGroup]);
    expect(bindings.AI.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bindings.KNOWLEDGE.upsert).mock.calls.map(([vectors]) => vectors[0].namespace)).toEqual([`document:${id}`, group, hiddenGroup]);
    const projection = `knowledge:${id}:${group}`;
    const chunk = await env.DB.prepare("SELECT id FROM knowledge_chunks WHERE message_id = ?").bind(projection).first<string>('id');
    vi.mocked(bindings.KNOWLEDGE.query).mockResolvedValue({ count: 1, matches: [{ id: chunk!, score: 0.9 }] });
    expect(await searchKnowledge('集合場所', group, bindings)).toEqual([expect.objectContaining({ document_id: id, document_title: '旅行ノート', fileName: 'note.txt' })]);
    expect((await recentMessages(group, 50, bindings)).some((r) => r.message_id === projection)).toBe(false);
    const file = await call(`/api/documents/${id}/file`, { headers: { Cookie: session.cookie } });
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe('集合場所は南口です。'); expect(file.headers.get('Content-Disposition')).toContain('attachment;');
  });
  it("allows a member to disable and re-enable someone else's knowledge but not delete or reshare it", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`);
    const owner = await login(); const { id } = await (await upload(owner)).json() as { id: string }; await ready(id);
    loginUser = other; membership.add(`${group}:${other}`); membership.add(`${hiddenGroup}:${other}`); const member = await login();
    const portal = await (await call('/api/portal', { headers: { Cookie: member.cookie } })).json() as { documents: { id: string; is_owner: number }[] };
    expect(portal.documents).toEqual([expect.objectContaining({ id, is_owner: 0 })]);
    expect((await call(`/api/documents/${id}`, { ...mutation(member), method: 'DELETE' })).status).toBe(403);
    expect((await toggle(member, id, true, hiddenGroup)).status).toBe(403);
    expect((await toggle(member, id, false)).status).toBe(204);
    expect((await call(`/api/documents/${id}/file`, { headers: { Cookie: member.cookie } })).status).toBe(200);
    await consume(`knowledge:${id}:${group}`);
    expect((await toggle(member, id, true)).status).toBe(204); await consume(`knowledge:${id}:${group}`);
    expect(await directEvidenceAvailable([`knowledge:${id}:${group}`], other, bindings)).toBe(true);
    expect(bindings.AI.run).toHaveBeenCalledTimes(1);
  });
  it("immediately filters disabled knowledge and invalidates derived bot answers before vector cleanup", async () => {
    await seen(group); membership.add(`${group}:${user}`); const session = await login();
    const { id } = await (await upload(session)).json() as { id: string }; await ready(id);
    const projection = `knowledge:${id}:${group}`;
    const chunk = await env.DB.prepare("SELECT id FROM knowledge_chunks WHERE message_id = ?").bind(projection).first<string>('id');
    vi.mocked(bindings.KNOWLEDGE.query).mockResolvedValue({ count: 1, matches: [{ id: chunk!, score: 0.9 }] });
    const question = `message-${group}`;
    await env.DB.prepare("INSERT INTO bot_replies(message_id,status,text,evidence_ids,created_at,line_message_id) VALUES (?, 'sent', '南口です', ?, ?, 'document-bot')")
      .bind(question, JSON.stringify([projection]), Date.now()).run(); await recordSentBotMessage(question, bindings);
    expect(await directEvidenceAvailable([projection], user, bindings)).toBe(true);
    expect((await toggle(session, id, false)).status).toBe(204);
    expect(await searchKnowledge('集合場所', group, bindings)).toEqual([]);
    expect(await directEvidenceAvailable([projection], user, bindings)).toBe(false);
    expect(await env.DB.prepare("SELECT text FROM bot_replies WHERE message_id = ?").bind(question).first('text')).toBeNull();
    expect((await recentMessages(group, 50, bindings)).some((r) => r.message_id === 'document-bot')).toBe(false);
    expect(bindings.KNOWLEDGE.deleteByIds).not.toHaveBeenCalled();
  });
  it("keeps the other chat enabled when one chat disables a shared document", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`); membership.add(`${hiddenGroup}:${user}`);
    const session = await login(); const { id } = await (await upload(session, [group, hiddenGroup])).json() as { id: string };
    await ready(id, [group, hiddenGroup]); await toggle(session, id, false);
    expect(await directEvidenceAvailable([`knowledge:${id}:${group}`], user, bindings)).toBe(false);
    expect(await directEvidenceAvailable([`knowledge:${id}:${hiddenGroup}`], user, bindings)).toBe(true);
    expect(await env.DB.prepare("SELECT status FROM knowledge_jobs WHERE message_id = ?").bind(`document:${id}`).first('status')).toBe('ready');
  });
  it("keeps disabled knowledge hidden when disabling races with vector publication", async () => {
    await seen(group); membership.add(`${group}:${user}`); const session = await login();
    const { id } = await (await upload(session)).json() as { id: string };
    await consume(`document:${id}`); await syncDocumentProjections(bindings, id);
    vi.mocked(bindings.KNOWLEDGE.upsert).mockImplementationOnce(async () => {
      await toggle(session, id, false); return { ids: [], count: 0 };
    });
    await consume(`knowledge:${id}:${group}`);
    expect(await directEvidenceAvailable([`knowledge:${id}:${group}`], user, bindings)).toBe(false);
    expect(await env.DB.prepare("SELECT status FROM knowledge_jobs WHERE message_id = ?").bind(`knowledge:${id}:${group}`).first('status')).toBe('delete_pending');
    await consume(`knowledge:${id}:${group}`);
    expect((await toggle(session, id, true)).status).toBe(204); await consume(`knowledge:${id}:${group}`);
    expect(await directEvidenceAvailable([`knowledge:${id}:${group}`], user, bindings)).toBe(true);
  });
  it("durably records original deletion even if publishing to the attachment queue fails", async () => {
    const session = await login(); const { id } = await (await upload(session, [])).json() as { id: string };
    vi.mocked(bindings.ATTACHMENT_QUEUE.send).mockRejectedValueOnce(new Error('Queue unavailable'));
    expect((await call(`/api/documents/${id}`, { ...mutation(session), method: 'DELETE' })).status).toBe(204);
    expect(await env.DB.prepare("SELECT status FROM attachments WHERE message_id = ?").bind(`document:${id}`).first('status')).toBe('delete_pending');
    expect(await env.DB.prepare("SELECT status FROM knowledge_jobs WHERE message_id = ?").bind(`document:${id}`).first('status')).toBe('delete_pending');
    expect((await call(`/api/documents/${id}/file`, { headers: { Cookie: session.cookie } })).status).toBe(404);
  });
  it("lets only the uploader delete the original and all chat uses", async () => {
    await seen(group); membership.add(`${group}:${user}`); const session = await login();
    const { id } = await (await upload(session)).json() as { id: string }; await ready(id);
    expect((await call(`/api/documents/${id}`, { ...mutation(session), method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/documents/${id}/file`, { headers: { Cookie: session.cookie } })).status).toBe(404);
    expect(await directEvidenceAvailable([`knowledge:${id}:${group}`], user, bindings)).toBe(false);
    await consume(`document:${id}`); await consume(`knowledge:${id}:${group}`);
    await worker.queue(createMessageBatch('line-group-talk-attachments', [{ id: 'delete', timestamp: new Date(), attempts: 1, body: { messageId: `document:${id}` } }]), bindings);
    expect(await env.ATTACHMENTS.get(`knowledge-documents/${id}`)).toBeNull();
    const portal = await (await call('/api/portal', { headers: { Cookie: session.cookie } })).json() as { documents: unknown[] };
    expect(portal.documents).toEqual([]);
  });
  it("protects metadata, files, and sharing mutations by membership and CSRF", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`); const session = await login();
    expect((await upload(session, [hiddenGroup])).status).toBe(403);
    expect((await call('/api/documents', { method: 'POST' })).status).toBe(401);
    expect((await call('/api/documents', { method: 'POST', headers: { Cookie: session.cookie } })).status).toBe(403);
    const { id } = await (await upload(session)).json() as { id: string };
    loginUser = other; const foreign = await login();
    const portal = await (await call('/api/portal', { headers: { Cookie: foreign.cookie } })).json() as { documents: unknown[] };
    expect(portal.documents).toEqual([]);
    expect((await call(`/api/documents/${id}/file`, { headers: { Cookie: foreign.cookie } })).status).toBe(404);
    expect((await toggle(foreign, id, false)).status).toBe(403);
  });
  it("returns a login-protected full-text link and lets current participants edit, including while disabled", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`); membership.add(`${hiddenGroup}:${user}`);
    const owner = await login(); const { id } = await (await upload(owner, [group, hiddenGroup])).json() as { id: string }; await ready(id, [group, hiddenGroup]);
    const page = `/knowledge/${id}?conversationId=${group}`;
    expect((await call(page)).status).toBe(200);
    expect((await call(`/api/documents/${id}/content`)).status).toBe(401);
    const chunk = await env.DB.prepare("SELECT id FROM knowledge_chunks WHERE message_id = ?").bind(`knowledge:${id}:${group}`).first<string>('id');
    vi.mocked(bindings.KNOWLEDGE.query).mockResolvedValue({ count: 1, matches: [{ id: chunk!, score: 0.9 }] });
    expect((await searchKnowledge('集合場所', group, bindings))[0].sourceUrl).toBe(`${origin}${page}`);
    loginUser = other; membership.add(`${group}:${other}`); const member = await login();
    expect((await toggle(member, id, false)).status).toBe(204);
    const content = await (await call(`/api/documents/${id}/content?conversationId=${group}`, { headers: { Cookie: member.cookie } })).json() as { text: string; revision: number };
    expect(content).toMatchObject({ text: '集合場所は南口です。', revision: 1 });
    const save = await call(`/api/documents/${id}/content?conversationId=${group}`, { ...mutation(member, { text: '集合場所は北口に変更しました。', revision: 1 }), method: 'PUT' });
    expect(save.status, await save.clone().text()).toBe(200);
    expect(await save.json()).toMatchObject({ revision: 2 });
    expect(await directEvidenceAvailable([`knowledge:${id}:${hiddenGroup}`], user, bindings)).toBe(false);
    expect(await searchKnowledge('集合場所', group, bindings)).toEqual([]);
    await consume(`document:${id}:r2`);
    expect(await env.DB.prepare("SELECT status, extracted_text, last_error_code FROM knowledge_jobs WHERE message_id = ?").bind(`document:${id}:r2`).first()).toMatchObject({ status: 'ready' });
    await syncDocumentProjections(bindings, id);
    expect(await env.DB.prepare("SELECT message_id, enabled FROM knowledge_document_chats WHERE document_id = ? AND conversation_id = ?").bind(id, hiddenGroup).first()).toMatchObject({ message_id: `knowledge:${id}:${hiddenGroup}:r2`, enabled: 1 });
    expect(await env.DB.prepare("SELECT status, extracted_text FROM knowledge_jobs WHERE message_id = ?").bind(`knowledge:${id}:${hiddenGroup}:r2`).first()).toMatchObject({ status: 'pending', extracted_text: expect.any(String) });
    await consume(`knowledge:${id}:${hiddenGroup}:r2`);
    const revised = await env.DB.prepare("SELECT extracted_text FROM knowledge_jobs WHERE message_id = ?").bind(`knowledge:${id}:${hiddenGroup}:r2`).first<string>('extracted_text');
    expect(revised).toContain('北口'); expect(revised).not.toContain('南口');
    const aiCalls = vi.mocked(bindings.AI.run).mock.calls.length;
    expect((await toggle(member, id, true)).status).toBe(204); await consume(`knowledge:${id}:${group}:r2`);
    expect(await directEvidenceAvailable([`knowledge:${id}:${group}:r2`], other, bindings)).toBe(true);
    expect(vi.mocked(bindings.AI.run).mock.calls).toHaveLength(aiCalls);
    const stale = await call(`/api/documents/${id}/content`, { ...mutation(owner, { text: '上書き不可', revision: 1 }), method: 'PUT' });
    expect(stale.status).toBe(409);
    expect((await call(`/api/documents/${id}`, { ...mutation(member), method: 'DELETE' })).status).toBe(403);
  });
  it("rejects full-text viewing and editing through an unrelated chat", async () => {
    await seen(group); await seen(hiddenGroup); membership.add(`${group}:${user}`); const owner = await login();
    const { id } = await (await upload(owner)).json() as { id: string }; await ready(id);
    loginUser = other; membership.add(`${hiddenGroup}:${other}`); const foreign = await login();
    expect((await call(`/api/documents/${id}/content?conversationId=${hiddenGroup}`, { headers: { Cookie: foreign.cookie } })).status).toBe(404);
    expect((await call(`/api/documents/${id}/content`, { ...mutation(foreign, { text: '改ざん', revision: 1 }), method: 'PUT' })).status).toBe(404);
    membership.add(`${group}:${other}`);
    expect((await call(`/api/documents/${id}/content?conversationId=${hiddenGroup}`, { headers: { Cookie: foreign.cookie } })).status).toBe(404);
    expect((await call(`/api/documents/${id}/content?conversationId=${group}`, { headers: { Cookie: foreign.cookie } })).status).toBe(200);
  });
  it("prevents concurrent editors from overwriting each other's version", async () => {
    const owner = await login(); const { id } = await (await upload(owner, [])).json() as { id: string };
    const save = (text: string) => call(`/api/documents/${id}/content`, { ...mutation(owner, { text, revision: 1 }), method: 'PUT' });
    const responses = await Promise.all([save('一人目の編集'), save('二人目の編集')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await env.DB.prepare("SELECT revision FROM knowledge_documents WHERE id = ?").bind(id).first('revision')).toBe(2);
  });
  it("preserves safe full-text and upload destinations across LINE login", async () => {
    for (const target of [`/knowledge/00000000-0000-4000-8000-000000000000?conversationId=${group}`, '/?view=knowledge', '/?view=history', '/?view=connections', 'https://evil.example/']) {
      const begin = await call('/auth/line?returnTo=' + encodeURIComponent(target));
      const location = new URL(begin.headers.get('Location')!); const state = location.searchParams.get('state');
      const response = await call('/auth/line/callback?code=code&state=' + state, { headers: { Cookie: `__Host-line_oauth=${state}` } });
      expect(response.headers.get('Location')).toBe(origin + (target.startsWith('https:') ? '/' : target));
    }
  });
  it("does not present truncated text as the full knowledge document", async () => {
    const owner = await login(); const { id } = await (await upload(owner, [], 'あ'.repeat(40_001))).json() as { id: string };
    await consume(`document:${id}`);
    expect(await env.DB.prepare("SELECT status, last_error_code FROM knowledge_jobs WHERE message_id = ?").bind(`document:${id}`).first()).toMatchObject({ status: 'failed', last_error_code: 'document_text_limit' });
    expect(await env.DB.prepare("SELECT content_text FROM knowledge_documents WHERE id = ?").bind(id).first('content_text')).toBeNull();
    expect(bindings.AI.run).not.toHaveBeenCalled();
  });
  it("supports private knowledge with no selected chats and rejects unsupported or empty files", async () => {
    const session = await login();
    const response = await upload(session, []); expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string }; await ready(id, []);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM knowledge_document_chats").first('n')).toBe(0);
    expect((await upload(session, [], 'binary', 'app.exe')).status).toBe(400);
    expect((await upload(session, [], '')).status).toBe(400);
  });
});

it('renders deployment links only when configured with official HTTPS origins', () => {
  const plain = portalHtml(true);
  expect(plain).not.toContain('bot を友だち追加</a>');
  const links = { friend: 'https://lin.ee/test?x=1&y=%22', qr: 'https://qr-official.line.me/gs/test.png' };
  const html = portalHtml(true, '/', links);
  expect(html).toContain('href="https://lin.ee/test?x=1&amp;y=%22"');
  expect(html).toContain('src="https://qr-official.line.me/gs/test.png"');
  for (const friend of ['javascript:alert(1)', 'https://lin.ee.evil.example/x', 'https://user@lin.ee/x']) {
    expect(portalHtml(true, '/', { ...links, friend })).not.toContain('bot を友だち追加</a>');
  }
});
