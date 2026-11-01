import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSentBotMessage, repairSentBotMessages } from "../src/bot-messages";
import worker from "../src/index";
import { sha256, EMBEDDING_MODEL, VISION_MODEL, reserveAI } from "../src/ai";
import { searchKnowledge } from "../src/search";
import { mentionQuestion } from "../src/mentions";
import { collectAnswerEvidence, formatAnswerEvidence, evidenceDates } from "../src/answer-context";
import { parseHistoryPlan } from "../src/history-plan";
import { bindings, message, post, unsend } from "./helpers";

const token = "test-search-token-abcdefghijklmnopqrstuvwxyz123456";
const vector = Array.from({ length: 1024 }, () => 0.1);
describe('explicit calendar dates in evidence', () => {
  const now = Date.parse('2026-11-01T00:30:00+09:00');
  it('normalizes full-width era dates and compares calendar days in Japan', () => {
    expect(evidenceDates('令和７年１０月２６日（日）開催予定。2026/11/01と2026-11-02も参照。', 0, now).mentioned_dates).toEqual([
      { date: '2025-10-26', relative_to_current_time: 'past' },
      { date: '2026-11-01', relative_to_current_time: 'today' },
      { date: '2026-11-02', relative_to_current_time: 'future' },
    ]);
  });
  it('rejects invalid dates and does not guess a missing year or confuse the posting date', () => {
    expect(evidenceDates('2025年2月29日、2025/13/01、10月26日、令和元年5月1日、2024年2月29日', now, now)).toEqual({
      sent_at_jst: '2026-11-01 00:30:00 JST', mentioned_dates: [
        { date: '2019-05-01', relative_to_current_time: 'past' },
        { date: '2024-02-29', relative_to_current_time: 'past' },
      ],
    });
  });
});

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["attachments", "messages", "unsent_messages"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare("INSERT INTO search_clients(token_hash, label, conversation_ids) VALUES (?, 'test', ?)")
    .bind(await sha256(token), JSON.stringify(["group-1"])).run();
  vi.spyOn(bindings.AI, "run").mockImplementation(async (model) => {
    if (model === EMBEDDING_MODEL) return { data: [vector] };
    return { response: "集合場所は東京駅です。[1]", usage: { prompt_tokens: 100, completion_tokens: 30 } };
  });
  vi.spyOn(bindings.KNOWLEDGE, "query").mockResolvedValue({ count: 0, matches: [] });
});
afterEach(() => vi.restoreAllMocks());

async function seed(id: string, group: string, text: string, cancelled = false, timestamp = 1700000000000) {
  await post([{ ...message(text), timestamp, webhookEventId: `event-${id}`, source: { type: "group", groupId: group }, message: { id, type: "text", text } }]);
  await env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready' WHERE message_id = ?").bind(id).run();
  await env.DB.prepare("INSERT INTO knowledge_chunks(id, message_id, ordinal, text) VALUES (?, ?, 0, ?)").bind(`chunk-${id}`, id, text).run();
  if (cancelled) await env.DB.prepare("UPDATE messages SET unsent_at = 1 WHERE message_id = ?").bind(id).run();
}
function result(...ids: string[]) {
  vi.mocked(bindings.KNOWLEDGE.query).mockResolvedValue({ count: ids.length, matches: ids.map((id) => ({ id: `chunk-${id}`, score: 0.9 })) });
}
async function search(conversationId = "group-1", bearer: string | null = token) {
  return worker.fetch(new Request("https://example.com/search", { method: "POST",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, body: JSON.stringify({ query: "集合場所", conversationId }) }), bindings);
}
function mentioned(question = "集合場所は？") {
  return { ...message(`@bot ${question}`), message: { id: "message-1", type: "text", text: `@bot ${question}`,
    mention: { mentionees: [{ type: "user", index: 0, length: 4, isSelf: true }] } } };
}

describe("authorized search", () => {
  it("rejects unauthenticated and cross-group requests before model calls", async () => {
    expect((await search("group-1", null)).status).toBe(401);
    expect((await search("group-2")).status).toBe(403);
    expect(bindings.AI.run).not.toHaveBeenCalled();
  });

  it("filters out other-group and cancelled results even if the index returns them", async () => {
    await seed("allowed", "group-1", "東京駅"); await seed("foreign", "group-2", "秘密の会議"); await seed("cancelled", "group-1", "取消済み", true);
    result("allowed", "foreign", "cancelled");
    const response = await search();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ messageId: "allowed", text: "東京駅" }] });
    expect(bindings.KNOWLEDGE.query).toHaveBeenCalledWith(vector, expect.objectContaining({ namespace: "group-1", returnMetadata: "none" }));
  });

  it("serves a stateless MCP tools/list only after authorization", async () => {
    const request = () => new Request("https://legacy.example.com/mcp", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, Host: "legacy.example.com", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const response = await worker.fetch(request(), bindings, createExecutionContext());
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.text();
    const json = JSON.parse(response.headers.get("Content-Type")?.includes("text/event-stream")
      ? body.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : body) as { result: { tools: { name: string }[] } };
    expect(json.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search_knowledge", "list_conversations"]));
  });

  it("honors token revocation", async () => {
    await env.DB.prepare("UPDATE search_clients SET revoked_at = 1").run();
    expect((await search()).status).toBe(401);
  });
});

describe("LINE mention answers", () => {
  it("uses an unindexed recent question and short reply despite image-only vector results", async () => {
    await seed("photo", "group-1", "お祭りの地図"); result("photo");
    // No knowledge chunks/ready state for these two freshly received utterances.
    for (const [id, text, timestamp] of [["dinner-q", "今日の夕食なに？", 1699999990000], ["dinner-a", "お鍋だよ", 1699999995000]] as const) {
      await post([{ ...message(text), timestamp, webhookEventId: `event-${id}`, message: { id, type: "text", text } }]);
    }
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] }).mockImplementationOnce(async (_model, input) => {
      const prompt = JSON.stringify(input);
      expect(prompt).toContain("今日の夕食なに？");
      expect(prompt).toContain("お鍋だよ");
      expect(prompt.indexOf("今日の夕食なに？")).toBeLessThan(prompt.indexOf("お鍋だよ"));
      expect(prompt).toContain("JST");
      return { response: "今晩はお鍋です。[2]" };
    });
    await post([mentioned()]);
    expect(send.mock.calls[0][1]?.body).toContain("今晩はお鍋です");
  });

  it("does not include other groups, cancelled utterances, future messages or earlier bot questions in context", async () => {
    await seed("foreign", "group-2", "別グループの秘密");
    await seed("removed", "group-1", "取り消した秘密", true);
    await seed("future", "group-1", "質問後の情報", false, 1700000100000);
    await seed("old-question", "group-1", "古いbotへの質問");
    await env.DB.prepare("INSERT INTO bot_replies(message_id, status, created_at) VALUES ('old-question', 'sent', 1)").run();
    await post([message("今回の質問")]);
    result("foreign", "removed", "future", "old-question");
    const context = await collectAnswerEvidence("夕食は？", "group-1", "message-1", bindings);
    expect(context.hits).toEqual([]);
  });

  it("adds nearby replies to older semantic matches outside the recent window", async () => {
    const old = 1700000000000 - 86400_000;
    await seed("old-q", "group-1", "昨日の夕食なに？", false, old);
    await seed("old-a", "group-1", "お鍋だったよ", false, old + 10_000);
    for (let i = 0; i < 25; i++) await seed(`noise-${i}`, "group-1", "最近の別の話題", false, 1699999900000 + i);
    await post([message("昨日の夕食は？")]); result("old-q");
    const context = await collectAnswerEvidence("昨日の夕食は？", "group-1", "message-1", bindings);
    expect(context.hits.some((hit) => hit.messageId === "old-a" && hit.text.includes("お鍋だったよ"))).toBe(true);
    expect(formatAnswerEvidence(context.hits).length).toBeLessThanOrEqual(5000);
  });

  it("bounds recent dialogue while retaining the newest messages", async () => {
    for (let i = 0; i < 20; i++) await seed(`long-${i}`, "group-1", `発言${i}:` + "あ".repeat(3000), false, 1699999900000 + i);
    await post([message()]);
    const context = await collectAnswerEvidence("直近の発言", "group-1", "message-1", bindings);
    expect(context.hits.some((hit) => hit.messageId === "long-19")).toBe(true);
    expect(formatAnswerEvidence(context.hits).length).toBeLessThanOrEqual(5000);
  });

  it("keeps recent conversation available if semantic search temporarily fails", async () => {
    await seed("recent", "group-1", "お鍋だよ"); await post([message()]);
    vi.mocked(bindings.KNOWLEDGE.query).mockRejectedValueOnce(new Error("index unavailable"));
    const context = await collectAnswerEvidence("夕食は？", "group-1", "message-1", bindings);
    expect(context.hits.map((hit) => hit.text)).toContain("お鍋だよ");
  });

  it("removes only the bot's mention using UTF-16 positions", () => {
    expect(mentionQuestion("😀 @bot 質問", [{ type: "user", isSelf: true, index: 3, length: 4 }])).toBe("😀  質問");
    expect(mentionQuestion("@someone 質問", [{ type: "user", isSelf: false, index: 0, length: 8 }])).toBeNull();
  });

  it("answers from same-group evidence and deduplicates redelivery", async () => {
    await seed("evidence", "group-1", "集合場所は東京駅です"); result("evidence");
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    expect((await post([mentioned()])).status).toBe(200);
    expect(send).toHaveBeenCalledWith("https://api.line.me/v2/bot/message/reply", expect.objectContaining({ body: JSON.stringify({ replyToken: "reply-1", messages: [{ type: "text", text: "集合場所は東京駅です。[1]" }] }) }));
    expect(bindings.AI.run).toHaveBeenCalledWith(VISION_MODEL, expect.objectContaining({ max_tokens: 512 }), expect.anything());
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)[0][1]).not.toHaveProperty("guided_json");
    await post([mentioned()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(1);
  });

  it("answers a general question even with no chat evidence", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: { action: "answer", answer: "一般的なもつ鍋なら、もつ・キャベツ・ニラ・豆腐がおすすめです。" } } as never);
    await post([mentioned("もつ鍋の材料は何がおすすめ？")]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(1);
    expect(send.mock.calls[0][1]?.body).toContain("キャベツ");
    expect(await env.DB.prepare("SELECT evidence_ids FROM bot_replies WHERE message_id = 'message-1'").first())
      .toMatchObject({ evidence_ids: "[]" });
  });

  it("can still search private history before reporting a missing personal fact with no initial evidence", async () => {
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: { action: "search", search: { query: "john 贈り物 日付", keyword: "john" } } } as never)
      .mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: "johnさんに贈り物をした日付は記録では確認できません。" });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned("johnさんに贈り物をしたのはいつ？")]);
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(2);
    expect(send.mock.calls[0][1]?.body).toContain("記録では確認できません");
  });

  it("does not respond to ordinary messages or mentions of someone else", async () => {
    const send = vi.spyOn(globalThis, "fetch");
    await post([{ ...message(), message: { id: "message-1", type: "text", text: "@someone 集合場所は？", mention: { mentionees: [{ type: "user", index: 0, length: 8, isSelf: false }] } } }]);
    expect(send).not.toHaveBeenCalled();
    expect(bindings.AI.run).not.toHaveBeenCalled();
  });

  it("does not answer a question cancelled during generation", async () => {
    await seed("evidence", "group-1", "東京駅"); result("evidence");
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] }).mockImplementationOnce(async () => {
      await post([unsend()]); return { response: "東京駅です" };
    });
    const send = vi.spyOn(globalThis, "fetch");
    await post([mentioned()]);
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT text FROM bot_replies WHERE message_id = 'message-1'").first("text")).toBeNull();
  });

  it("withholds generated content if evidence is cancelled during generation", async () => {
    await seed("evidence", "group-1", "東京駅"); result("evidence");
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] }).mockImplementationOnce(async () => {
      await post([{ ...unsend(), unsend: { messageId: "evidence" } }]); return { response: "東京駅です" };
    });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned()]);
    expect(send.mock.calls[0][1]?.body).toContain("参照した発言が取り消された");
    expect(await env.DB.prepare("SELECT text FROM bot_replies WHERE message_id = 'message-1'").first("text")).toBeNull();
  });

  it("replies with a fixed notice when the budget is exhausted", async () => {
    await reserveAI("answer", VISION_MODEL, 1, 5_000_000, bindings);
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned()]);
    expect(bindings.AI.run).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]?.body).toContain("利用上限");
  });
});

describe("replies to bot messages", () => {
  it.each([false, true])("stays silent when a bot reply explicitly mentions another user (self mention: %s)", async (alsoSelf) => {
    await seed("parent", "group-1", "元の質問");
    await env.DB.prepare(`INSERT INTO bot_replies(message_id, status, text, created_at, line_message_id)
      VALUES ('parent', 'sent', 'botの回答', 0, 'quoted-bot')`).run();
    const send = vi.spyOn(globalThis, "fetch");
    await post([{ ...message("@john @bot どう思う？"), message: { id: "child", type: "text", text: "@john @bot どう思う？",
      quotedMessageId: "quoted-bot", mention: { mentionees: [
        { type: "user", index: 0, length: 5, isSelf: false },
        ...(alsoSelf ? [{ type: "user", index: 6, length: 4, isSelf: true }] : []),
      ] } } }]);
    expect(send).not.toHaveBeenCalled();
    expect(bindings.AI.run).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT message_id FROM bot_replies WHERE message_id = 'child'").first()).toBeNull();
  });

  it("answers a quoted bot reply without a mention and keeps the dialogue context", async () => {
    await seed("dinner", "group-1", "お鍋だよ");
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ sentMessages: [{ id: send.mock.calls.length === 1 ? "bot-answer-1" : "bot-answer-2" }] }));
    const first = mentioned("晩ごはんの買い物は？");
    await post([first]);
    expect(await env.DB.prepare("SELECT line_message_id FROM bot_replies WHERE message_id = 'message-1'").first())
      .toMatchObject({ line_message_id: "bot-answer-1" });
    const followup = { ...message("もつ鍋だけど何を買えばいいかな"), webhookEventId: "followup-event",
      timestamp: first.timestamp + 1000, message: { id: "followup", type: "text", text: "もつ鍋だけど何を買えばいいかな",
        quotedMessageId: "bot-answer-1", quoteToken: "followup-quote-token" } };
    await post([followup]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1][1]!.body as string).messages[0].quoteToken).toBe("followup-quote-token");
    const calls = vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL);
    expect(JSON.stringify(calls.at(-1)?.[1])).toContain("reply_context");
    expect(JSON.stringify(calls.at(-1)?.[1])).toContain("晩ごはんの買い物は？");
    expect(await env.DB.prepare("SELECT quoted_message_id FROM messages WHERE message_id = 'followup'").first())
      .toMatchObject({ quoted_message_id: "bot-answer-1" });
    await post([followup]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["unknown", "other-group", "cancelled"])("does not answer a quote of %s content", async (kind) => {
    await seed("parent", kind === "other-group" ? "group-2" : "group-1", "元の質問", kind === "cancelled");
    if (kind !== "unknown") await env.DB.prepare(`INSERT INTO bot_replies(message_id, status, text, created_at, line_message_id)
      VALUES ('parent', 'sent', 'botの回答', 0, 'quoted-bot')`).run();
    const send = vi.spyOn(globalThis, "fetch");
    await post([{ ...message("続きの質問"), message: { id: "child", type: "text", text: "続きの質問", quotedMessageId: "quoted-bot" } }]);
    expect(send).not.toHaveBeenCalled();
    expect(bindings.AI.run).not.toHaveBeenCalled();
  });
});

describe("questions quoting other users", () => {
  it("prioritizes an old quoted utterance even when semantic search misses it", async () => {
    await seed("old-plan", "group-1", "集合は来週土曜の15時に京都駅", false, 1600000000000);
    for (let i = 0; i < 25; i++) await seed(`new-${i}`, "group-1", "最近の別の話", false, 1699999900000 + i);
    const event = mentioned("これはどこの駅？");
    vi.mocked(bindings.AI.run).mockImplementation(async (model, input) => {
      if (model === EMBEDDING_MODEL) return { data: [vector] };
      expect(JSON.stringify(input)).toContain("今回の質問が引用した発言");
      expect(JSON.stringify(input)).toContain("集合は来週土曜の15時に京都駅");
      return { response: "京都駅です。[1]" };
    });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ sentMessages: [{ id: "answer" }] }));
    await post([{ ...event, message: { ...event.message, quotedMessageId: "old-plan" } }]);
    expect(send.mock.calls[0][1]?.body).toContain("京都駅です");
    const row = await env.DB.prepare("SELECT evidence_ids FROM bot_replies WHERE message_id = 'message-1'").first<{ evidence_ids: string }>();
    expect(JSON.parse(row!.evidence_ids)).toContain("old-plan");
  });

  it.each(["other-group", "cancelled"])("omits a quoted %s utterance from the answer context", async (kind) => {
    await seed("private-quote", kind === "other-group" ? "group-2" : "group-1", "秘密の内容", kind === "cancelled");
    await seed("question", "group-1", "これについて教えて");
    await env.DB.prepare("UPDATE messages SET quoted_message_id = 'private-quote' WHERE message_id = 'question'").run();
    const context = await collectAnswerEvidence("これについて教えて", "group-1", "question", bindings);
    expect(context.hits.map((hit) => hit.messageId)).not.toContain("private-quote");
  });

  it("includes extracted text when the quoted message is an attachment", async () => {
    await seed("photo", "group-1", "temporary");
    await env.DB.prepare("UPDATE messages SET text = NULL, message_type = 'image' WHERE message_id = 'photo'").run();
    await env.DB.prepare("UPDATE knowledge_jobs SET extracted_text = '画像の営業時間は9時から18時' WHERE message_id = 'photo'").run();
    await seed("question", "group-1", "これは何時まで？");
    await env.DB.prepare("UPDATE messages SET quoted_message_id = 'photo' WHERE message_id = 'question'").run();
    const context = await collectAnswerEvidence("これは何時まで？", "group-1", "question", bindings);
    expect(context.hits).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: "photo", kind: "quoted", text: "画像の営業時間は9時から18時" })]));
  });
});

describe("model-selected history search", () => {
  it.each([
    '{"action":"answer","answer":"もつ・キャベツ',
    '```json\n{"action":"answer","answer":"もつ・キャベツ',
    JSON.stringify({ action: "unexpected", answer: "送ってはいけない" }),
  ])("retries malformed model output as plain text without exposing routing JSON: %s", async (broken) => {
    await seed("dinner", "group-1", "今晩はもつ鍋");
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: broken })
      .mockImplementationOnce(async (_model, input) => {
        expect(input).not.toHaveProperty("guided_json");
        return { response: "一般的には、もつ・キャベツ・ニラ・豆腐がおすすめです。" };
      });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned("具体的に何がおすすめ？")]);
    const body = send.mock.calls[0][1]?.body as string;
    expect(body).toContain("キャベツ");
    expect(body).not.toContain("action");
    expect(body).not.toContain("一時的に生成できません");
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(2);
  });

  it("bounds format retries when the provider and final response both fail", async () => {
    await seed("dinner", "group-1", "今晩はもつ鍋");
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockRejectedValueOnce(new SyntaxError("Unterminated string"))
      .mockResolvedValueOnce({ response: '{"action":"answer","answer":"途中' });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned("具体的に何がおすすめ？")]);
    expect(send.mock.calls[0][1]?.body).toContain("一時的に生成できません");
    expect(send.mock.calls[0][1]?.body).not.toContain("action");
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(2);
  });

  it("accepts an already-decoded JSON answer from Workers AI", async () => {
    await seed("dinner", "group-1", "お鍋だよ");
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: { action: "answer", answer: "今晩はお鍋です。[1]" } } as never);
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned("晩ご飯の買い物は何をすればいいかな")]);
    expect(send.mock.calls[0][1]?.body).toContain("今晩はお鍋です");
    expect(send.mock.calls[0][1]?.body).not.toContain("一時的に生成できません");
  });

  it("converts Japanese date boundaries safely and rejects group/SQL injection options", () => {
    expect(parseHistoryPlan({ query: "2025年 旅行", from_date: "2025-01-01", before_date: "2026-01-01" }))
      .toMatchObject({ from: Date.parse("2025-01-01T00:00:00+09:00"), before: Date.parse("2026-01-01T00:00:00+09:00") });
    expect(() => parseHistoryPlan({ query: "旅行", from_date: "2025-02-30" })).toThrow();
    expect(() => parseHistoryPlan({ query: "旅行", conversationId: "group-2" })).toThrow();
  });

  it("lets the model narrow history by date and then answer without further tool calls", async () => {
    const lastYear = Date.parse("2022-07-01T12:00:00+09:00");
    await seed("trip", "group-1", "2022年の旅行は京都でした", false, lastYear);
    result("trip");
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: "```json\n" + JSON.stringify({ action: "search", search: {
        query: "2022年 旅行 行き先", from_date: "2022-01-01", before_date: "2023-01-01",
      } }) + "\n```" })
      .mockResolvedValueOnce({ data: [vector] })
      .mockImplementationOnce(async (_model, input) => {
        expect(JSON.stringify(input)).toContain("京都");
        expect(input).not.toHaveProperty("tools");
        expect(input).not.toHaveProperty("guided_json");
        return { response: "去年の旅行先は京都です。[1]" };
      });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned("去年の旅行はどこ？")]);
    expect(bindings.KNOWLEDGE.query).toHaveBeenLastCalledWith(vector, expect.objectContaining({ namespace: "group-1", filter: {
      sent_at: { $gte: Date.parse("2022-01-01T00:00:00+09:00"), $lt: Date.parse("2023-01-01T00:00:00+09:00") },
    } }));
    expect(send.mock.calls[0][1]?.body).toContain("京都です");
  });

  it("can use a name keyword over all time when semantic search misses a gift", async () => {
    await seed("recent", "group-1", "今日はお鍋だよ");
    await seed("gift", "group-1", "johnさんにプレゼントを渡しました", false, 1600000000000);
    for (let i = 0; i < 25; i++) await seed(`later-${i}`, "group-1", "最近の話題", false, 1699999900000 + i);
    vi.mocked(bindings.AI.run).mockResolvedValueOnce({ data: [vector] })
      .mockResolvedValueOnce({ response: { action: "search", search: { query: "john 贈り物 プレゼント 渡した", keyword: "john" } } } as never)
      .mockResolvedValueOnce({ data: [vector] })
      .mockImplementationOnce(async (_model, input) => {
        expect(JSON.stringify(input)).toContain("johnさんにプレゼントを渡しました");
        return { response: "記録では2020年9月13日に渡しています。[1]" };
      });
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await post([mentioned("johnさんに贈り物をしたのはいつ？")]);
    expect(send.mock.calls[0][1]?.body).toContain("2020年9月13日");
  });

  it("broadens an empty date-filtered search without generating another embedding", async () => {
    await seed("memory", "group-1", "去年の旅行は京都だったね");
    vi.mocked(bindings.KNOWLEDGE.query).mockResolvedValueOnce({ count: 0, matches: [] })
      .mockResolvedValueOnce({ count: 1, matches: [{ id: "chunk-memory", score: 0.9 }] });
    const hits = await searchKnowledge("2022年 旅行", "group-1", bindings, undefined, 5,
      { from: Date.parse("2022-01-01"), before: Date.parse("2023-01-01"), fallbackToAllTime: true });
    expect(hits.map((hit) => hit.messageId)).toContain("memory");
    expect(bindings.AI.run).toHaveBeenCalledTimes(1);
    expect(bindings.KNOWLEDGE.query).toHaveBeenCalledTimes(2);
  });
});


async function mcpTool(name: string, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request(`${bindings.PORTAL_ORIGIN}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, Host: new URL(bindings.PORTAL_ORIGIN).hostname, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: args } }),
  }), bindings, createExecutionContext());
  expect(response.status).toBe(200);
  const body = await response.text();
  const json = JSON.parse(response.headers.get("Content-Type")?.includes("text/event-stream") ? body.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : body);
  return json.result;
}
async function savedBotAnswer(questionId: string, replyId: string, text: string, status = "sent", evidence: string[] = []) {
  await env.DB.prepare("UPDATE messages SET replied_at = sent_at + 1000 WHERE message_id = ?").bind(questionId).run();
  await env.DB.prepare("INSERT INTO bot_replies(message_id, status, text, evidence_ids, created_at, line_message_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(questionId, status, text, JSON.stringify(evidence), 1700000001000, replyId).run();
  await recordSentBotMessage(questionId, bindings);
}

describe("MCP bot speech", () => {
  it("returns complete sent bot answers in chronological history with role and reply attribution", async () => {
    await seed("q", "group-1", "買い物は何が必要？");
    const answer = "買い物の提案: 豆腐、ねぎ。" + "補足".repeat(1100);
    await savedBotAnswer("q", "sent-bot", answer);
    await recordSentBotMessage("q", bindings); // duplicate receipt is harmless
    await seed("foreign-q", "group-2", "別トーク");
    await savedBotAnswer("foreign-q", "foreign-bot", "別トークの提案");
    const response = await mcpTool("get_recent_messages", { conversationId: "group-1", limit: 10 });
    const messages = JSON.parse(response.content[0].text);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ message_id: "q", sender_role: "user" });
    expect(messages[1]).toMatchObject({ message_id: "sent-bot", sender_role: "bot", sender_name: "bot", user_id: null, text: answer, reply_to_message_id: "q" });
    const denied = await mcpTool("get_recent_messages", { conversationId: "group-2" });
    expect(denied.isError).toBe(true);
  });
  it("searches bot answers through MCP while keeping them out of the bot's own factual evidence", async () => {
    await seed("q", "group-1", "買い物は？");
    await savedBotAnswer("q", "sent-bot", "豆腐、ねぎを提案します。");
    await env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready' WHERE message_id = 'sent-bot'").run();
    await env.DB.prepare("INSERT INTO knowledge_chunks(id, message_id, ordinal, text) VALUES ('chunk-sent-bot', 'sent-bot', 0, '豆腐、ねぎを提案します。')").run();
    result("sent-bot");
    const response = await mcpTool("search_knowledge", { query: "買い物の提案", conversationId: "group-1" });
    expect(JSON.parse(response.content[0].text)).toEqual([expect.objectContaining({ messageId: "sent-bot", sender_role: "bot", reply_to_message_id: "q" })]);
    expect(await searchKnowledge("買い物", "group-1", bindings)).toEqual([]);
    expect(await searchKnowledge("買い物", "group-1", bindings, undefined, 5, { includeBot: true, from: 1800000000000, fallbackToAllTime: true })).toEqual([expect.objectContaining({ sender_role: "bot" })]);
    await post([{ ...message("今の質問"), timestamp: 1700000005000 }]);
    const context = await collectAnswerEvidence("買い物", "group-1", "message-1", bindings);
    expect(context.hits.some((h) => h.messageId === "sent-bot")).toBe(false);
  });
  it.each(["question", "evidence", "bot"])("hides bot answers and clears cached chunks after %s cancellation", async (kind) => {
    await seed("evidence", "group-1", "元の事実");
    await seed("q", "group-1", "質問");
    await savedBotAnswer("q", "sent-bot", "botの提案", "sent", ["evidence"]);
    await env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready', extracted_text = 'botの提案' WHERE message_id = 'sent-bot'").run();
    await env.DB.prepare("INSERT INTO knowledge_chunks(id, message_id, ordinal, text) VALUES ('chunk-sent-bot', 'sent-bot', 0, 'botの提案')").run();
    const id = kind === "question" ? "q" : kind === "bot" ? "sent-bot" : "evidence";
    await post([{ ...unsend(), unsend: { messageId: id } }]);
    result("sent-bot");
    expect(await searchKnowledge("提案", "group-1", bindings, undefined, 5, { includeBot: true })).toEqual([]);
    const recent = await mcpTool("get_recent_messages", { conversationId: "group-1" });
    expect(JSON.parse(recent.content[0].text).some((m: { sender_role: string }) => m.sender_role === "bot")).toBe(false);
    expect(await env.DB.prepare("SELECT text FROM knowledge_chunks WHERE id = 'chunk-sent-bot'").first("text")).toBeNull();
    await recordSentBotMessage("q", bindings);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE sender_role = 'bot' AND unsent_at IS NULL").first("n")).toBe(0);
  });
  it("publishes only delivered answers and repairs missed persistence without sending LINE messages", async () => {
    await seed("q", "group-1", "質問");
    await savedBotAnswer("q", "sent-bot", "未送信", "ready");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE sender_role = 'bot'").first("n")).toBe(0);
    await env.DB.prepare("UPDATE bot_replies SET status = 'sent' WHERE message_id = 'q'").run();
    const network = vi.spyOn(globalThis, "fetch");
    await repairSentBotMessages(bindings);
    expect(network).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE sender_role = 'bot'").first("n")).toBe(1);
  });
});
