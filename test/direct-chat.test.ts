import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bindings, message, post } from "./helpers";
import { DIRECT_MODEL, EMBEDDING_MODEL, reserveAI } from "../src/ai";
import { DAY_MS, directUsage, isUsageQuestion, UserBudgetExceeded } from "../src/direct-usage";

const user = `U${"1".repeat(32)}`, other = `U${"2".repeat(32)}`;
const group = `C${"a".repeat(32)}`, secretGroup = `C${"b".repeat(32)}`;
let allowed: Set<string>;
let decisions: unknown[];
let sent: string[];
let sentPayloads: Record<string, unknown>[];
let sequence: number;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["attachments", "messages", "unsent_messages", "history_imports"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  allowed = new Set([`${group}:${user}`, `${secretGroup}:${other}`]); decisions = []; sent = []; sentPayloads = []; sequence = 0;
  await env.DB.batch([group, secretGroup].map((id) => env.DB.prepare("INSERT INTO conversations(conversation_id, source_type, bot_active, last_event_at) VALUES (?, 'group', 1, ?)").bind(id, Date.now())));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v2/bot/message/reply") {
      const outgoing = JSON.parse(init!.body as string).messages[0];
      sent.push(outgoing.text); sentPayloads.push(outgoing);
      return Response.json({ sentMessages: [{ id: `bot-${++sequence}` }] });
    }
    const member = path.match(/^\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/);
    if (member) return allowed.has(`${member[1]}:${member[2]}`) ? Response.json({ userId: member[2] }) : new Response("{}", { status: 404 });
    const summary = path.match(/^\/v2\/bot\/group\/([^/]+)\/summary$/);
    if (summary) return Response.json({ groupId: summary[1], groupName: summary[1] === group ? "家族" : "権限外のグループ名" });
    throw new Error("Unexpected endpoint");
  });
  vi.spyOn(bindings.KNOWLEDGE, "query").mockResolvedValue({ count: 0, matches: [] });
  vi.spyOn(bindings.AI, "run").mockImplementation(async (model) => {
    if (model === EMBEDDING_MODEL) return { data: [Array.from({ length: 1024 }, () => 0.1)] };
    if (model !== DIRECT_MODEL) throw new Error("Wrong direct model");
    return { choices: [{ message: { role: "assistant", content: JSON.stringify(decisions.shift() ?? { action: "answer", answer: "こんにちは。" }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
  });
});
afterEach(() => vi.restoreAllMocks());
async function dm(text: string, id = "dm-1", sender = user) {
  return post([{ ...message(text), timestamp: Date.now(), webhookEventId: `event-${id}`, source: { type: "user", userId: sender }, message: { id, type: "text", text, quoteToken: "direct-quote-token" } }]);
}
async function usage(cost: number, owner = user, created = Date.now()) {
  await env.DB.prepare(`INSERT INTO ai_usage(id,month,day,kind,model,units,reserved_microusd,charged_microusd,created_at,owner_user_id)
    VALUES (?, ?, ?, 'answer', ?, 1, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), new Date(created).toISOString().slice(0, 7), new Date(created).toISOString().slice(0, 10), DIRECT_MODEL, cost, cost, created, owner).run();
}
async function groupText() {
  await post([{ ...message("夕食はもつ鍋、買い物は豆腐です。"), webhookEventId: "group-event", timestamp: Date.now() - 1000,
    source: { type: "group", groupId: group, userId: user }, message: { id: "group-text", type: "text", text: "夕食はもつ鍋、買い物は豆腐です。" } }]);
}

describe("private LINE assistant", () => {
  it("answers without mentions using the medium model and scopes billing to the sender", async () => {
    expect((await dm("こんにちは")).status).toBe(200);
    expect(sent).toEqual(["こんにちは。"]);
    expect(sentPayloads[0]).not.toHaveProperty("quoteToken");
    expect(bindings.AI.run).toHaveBeenCalledWith(DIRECT_MODEL, expect.objectContaining({ max_tokens: 1024 }), expect.anything());
    expect(await directUsage(user, bindings)).toBe(39);
    expect(await directUsage(other, bindings)).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM knowledge_jobs j JOIN messages m USING(message_id) WHERE m.source_type = 'user'").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT sender_role, reply_to_message_id FROM messages WHERE message_id = 'bot-1'").first()).toMatchObject({ sender_role: "bot", reply_to_message_id: "dm-1" });
    await dm("こんにちは"); expect(sent).toHaveLength(1);
  });
  it("reads allowed group history and keeps the medium model aware of user/bot attribution", async () => {
    await groupText();
    decisions.push({ action: "tools", calls: [{ name: "get_recent_messages", arguments: { conversationId: group, limit: 10 } }] }, { action: "answer", answer: "家族の会話では豆腐を買う予定です。" });
    await dm("家族の買い物は？");
    expect(sent[0]).toContain("豆腐");
    const calls = vi.mocked(bindings.AI.run).mock.calls;
    expect(JSON.stringify(calls[1][1])).toContain("もつ鍋");
    expect(JSON.stringify(calls[1][1])).toContain('sender_role');
    expect(JSON.stringify(calls)).not.toContain("権限外のグループ名");
    expect(await env.DB.prepare("SELECT evidence_ids FROM bot_replies WHERE message_id = 'dm-1'").first("evidence_ids")).toBe('["group-text"]');
  });
  it("reads family plans for a new topic without being anchored to the previous test-group dialogue", async () => {
    allowed.add(`${secretGroup}:${user}`);
    await env.DB.prepare("INSERT INTO messages(message_id, source_type, conversation_id, user_id, sender_role, message_type, text, sent_at, received_at) VALUES ('new-year', 'group', ?, ?, 'user', 'text', '1/1 12:00からさくら食堂を予約しました。個室です。', ?, ?)")
      .bind(group, user, Date.now() - 1000, Date.now()).run();
    await env.DB.prepare("INSERT INTO messages(message_id, source_type, conversation_id, user_id, sender_role, message_type, text, sent_at, received_at) VALUES ('meal', 'group', ?, ?, 'user', 'text', '今日の夕食はお鍋です。', ?, ?)")
      .bind(secretGroup, user, Date.now() - 1000, Date.now()).run();
    decisions.push({ action: "tools", calls: [{ name: "get_recent_messages", arguments: { conversationId: secretGroup } }] }, { action: "answer", answer: "今日の夕食はお鍋です。" });
    await dm("別のトークで夕食の話をしてた？");
    decisions.push({ action: "answer", answer: "家族では来年1/1 12:00にさくら食堂の個室を予約しています。" });
    await dm("来年の正月の予定は？", "dm-2");
    const prompt = JSON.stringify(vi.mocked(bindings.AI.run).mock.calls.at(-1)![1]);
    expect(prompt).toContain("initial_recent_messages"); expect(prompt).toContain("sent_at_jst"); expect(prompt).toContain("1/1 12:00からさくら食堂");
    expect(sent.at(-1)).toContain("さくら食堂");
    const references = JSON.parse(await env.DB.prepare("SELECT evidence_ids FROM bot_replies WHERE message_id = 'dm-2'").first<string>("evidence_ids") ?? '[]');
    expect(references).toContain("new-year");
  });
  it("routes natural usage questions without an AI call or stale topic", async () => {
    await dm("利用率は？"); await dm("いまどのくらい使った？", "dm-2");
    expect(sent).toHaveLength(2); expect(sent.every((t) => t.includes("$0.0000"))).toBe(true);
    expect(bindings.AI.run).not.toHaveBeenCalled();
    expect(sentPayloads.every((p) => !("quoteToken" in p))).toBe(true);
  });
  it("rejects model-selected unauthorized group IDs before any search", async () => {
    decisions.push({ action: "tools", calls: [{ name: "search_knowledge", arguments: { conversationId: secretGroup, query: "秘密" } }] }, { action: "answer", answer: "そのトークは参照できません。" });
    await dm("別のグループを調べて");
    expect(bindings.KNOWLEDGE.query).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(bindings.AI.run).mock.calls[1][1])).toContain("アクセス権はありません");
  });
  it("charges query embeddings to the direct user, with time filters and bot search enabled", async () => {
    decisions.push({ action: "tools", calls: [{ name: "search_knowledge", arguments: { conversationId: group, query: "去年の旅行", from: 1, before: 1000 } }] }, { action: "answer", answer: "記録では見つかりませんでした。" });
    await dm("去年の旅行は？");
    expect(await env.DB.prepare("SELECT owner_user_id FROM ai_usage WHERE kind = 'embedding'").first("owner_user_id")).toBe(user);
    expect(bindings.KNOWLEDGE.query).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ namespace: group, filter: { sent_at: { $gte: 1, $lt: 1000 } } }));
  });
  it("does not reuse a previous direct bot answer after leaving its source group", async () => {
    await groupText();
    decisions.push({ action: "tools", calls: [{ name: "get_recent_messages", arguments: { conversationId: group } }] }, { action: "answer", answer: "機密の献立はもつ鍋です。" });
    await dm("献立は？");
    allowed.delete(`${group}:${user}`);
    decisions.push({ action: "answer", answer: "現在参加中のトークはありません。" });
    await dm("もう一度教えて", "dm-2");
    const last = vi.mocked(bindings.AI.run).mock.calls.at(-1)!;
    expect(JSON.stringify(last[1])).not.toContain("機密の献立");
    expect(JSON.stringify(last[1])).not.toContain("もつ鍋");
  });
  it("checks source membership again before delivering a cross-group answer", async () => {
    await groupText();
    decisions.push({ action: "tools", calls: [{ name: "get_recent_messages", arguments: { conversationId: group } }] });
    const normal = vi.mocked(bindings.AI.run).getMockImplementation()!;
    vi.mocked(bindings.AI.run).mockImplementationOnce(normal).mockImplementationOnce(async () => {
      allowed.clear(); return { choices: [{ message: { role: "assistant", content: JSON.stringify({ action: "answer", answer: "秘密の献立です。" }) } }] };
    });
    await dm("献立は？");
    expect(sent[0]).not.toContain("秘密の献立");
    expect(sent[0]).toContain("回答を控えます");
  });
  it("preserves ping/pong without charging the model", async () => {
    await dm("ping"); expect(sent).toEqual(["pong"]); expect(bindings.AI.run).not.toHaveBeenCalled();
  });
});

describe("rolling direct-chat budgets", () => {
  it("stops normal replies at $0.50 while answering usage queries without AI", async () => {
    await usage(500_000);
    await dm("こんにちは"); expect(sent).toHaveLength(0); expect(bindings.AI.run).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT status FROM bot_replies WHERE message_id = 'dm-1'").first("status")).toBe("blocked");
    await dm("利用状況は？", "dm-2");
    expect(sent[0]).toContain("$0.5000"); expect(sent[0]).toContain("回答を停止"); expect(bindings.AI.run).not.toHaveBeenCalled();
  });
  it("warns with the answer at 80%, but not below it", async () => {
    await dm("こんにちは"); expect(sent[0]).not.toContain("80%");
    await usage(400_000); await dm("次の質問", "dm-2");
    expect(sent[1]).toContain("こんにちは。"); expect(sent[1]).toContain("直近24時間の利用量の80%に達しました");
  });
  it("uses a rolling 24 hours rather than midnight and isolates each user", async () => {
    await usage(500_000, user, Date.now() - DAY_MS - 1000);
    await dm("こんにちは"); expect(sent).toHaveLength(1);
    await usage(500_000); await dm("こんにちは", "dm-2", other); expect(sent).toHaveLength(2);
    expect(await directUsage(other, bindings)).toBe(39);
  });
  it("reserves the per-user limit atomically under concurrent requests", async () => {
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => reserveAI("answer", DIRECT_MODEL, 1, 50_000, { ...bindings, AI_BILLING_USER_ID: user })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof UserBudgetExceeded)).toHaveLength(5);
    expect(await directUsage(user, bindings)).toBe(500_000);
  });
  it("retains the reserved cost on failed model calls", async () => {
    vi.mocked(bindings.AI.run).mockRejectedValue(new Error("Timeout"));
    await dm("こんにちは");
    expect(await directUsage(user, bindings)).toBe(2500);
    expect(sent[0]).toContain("一時的に生成できません");
  });
  it.each(["利用状況は", "利用状況は？", "今の利用状況を教えて", "残り予算", "利用率は？", "いまどのくらい使った？", "今どれくらい使ってる？", "usage"])("recognizes the no-cost command %s", (input) => {
    expect(isUsageQuestion(input)).toBe(true);
    expect(isUsageQuestion("グループで話した利用状況について調べて")).toBe(false);
  });
});
