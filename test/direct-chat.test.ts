import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECT_MODELS, directReservation } from "../src/direct-model";
import { messageContext } from "../src/knowledge-tools";
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
  vi.spyOn(bindings.AI, "run").mockImplementation(async (model, input) => {
    if (model === EMBEDDING_MODEL) return { data: [Array.from({ length: 1024 }, () => 0.1)] };
    if (model !== DIRECT_MODEL) throw new Error("Wrong direct model");
    const decision = decisions.shift() ?? { action: "answer", answer: "こんにちは。" };
    let result = (decision as { action: string }).action === "answer" ? { basis: "general", ...decision as object } : decision;
    if ((result as {action:string}).action === 'answer') {
      const answer = result as {action:string;answer:string|string[];basis:string};
      const parts = Array.isArray(answer.answer) ? [...answer.answer] : [answer.answer];
      const final = (input as {response_format?:{type:string}}).response_format?.type === 'json_schema';
      if ((final || answer.basis !== 'general') && parts.length < 2) parts.push('参照：記録の範囲での回答です。');
      result = {...answer,answer:parts};
    }
    return { choices: [{ message: { role: "assistant", content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
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
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ai_usage_totals(period,bucket,units,charged_microusd) VALUES (?,'all',1,?)
      ON CONFLICT(period,bucket) DO UPDATE SET units=units+1, charged_microusd=charged_microusd+excluded.charged_microusd`).bind('month:'+new Date(created).toISOString().slice(0,7),cost),
    env.DB.prepare(`INSERT INTO ai_usage_totals(period,bucket,units,charged_microusd) VALUES (?,'answer',1,?)
      ON CONFLICT(period,bucket) DO UPDATE SET units=units+1, charged_microusd=charged_microusd+excluded.charged_microusd`).bind('day:'+new Date(created).toISOString().slice(0,10),cost),
  ]);
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
    expect(bindings.AI.run).toHaveBeenCalledWith(DIRECT_MODEL, expect.objectContaining({ max_completion_tokens: 4096, reasoning_effort: "low" }), expect.anything());
    expect(await directUsage(user, bindings)).toBe(65);
    expect(await directUsage(other, bindings)).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM knowledge_jobs j JOIN messages m USING(message_id) WHERE m.source_type = 'user'").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT sender_role, reply_to_message_id FROM messages WHERE message_id = 'bot-1'").first()).toMatchObject({ sender_role: "bot", reply_to_message_id: "dm-1" });
    await dm("こんにちは"); expect(sent).toHaveLength(1);
  });
  it("sends and stores every paragraph, including the last item after multiple newlines", async () => {
    const parts=['概要です。','・1つ目の情報です。','・2つ目の情報です。','末尾の補足もあります。'];
    decisions.push({action:'answer',basis:'general',answer:parts});
    await dm('段落付きで説明して');
    expect(sent[0]).toBe(parts.join('\n\n'));
    expect(await env.DB.prepare("SELECT text FROM bot_replies WHERE message_id='dm-1'").first('text')).toBe(sent[0]);
    expect(await env.DB.prepare("SELECT text FROM messages WHERE message_id='bot-1'").first('text')).toBe(sent[0]);
  });
  it("replaces a preface-only draft with a complete final answer", async () => {
    await groupText();
    vi.mocked(bindings.AI.run).mockImplementationOnce(async()=>({choices:[{message:{content:JSON.stringify({action:'answer',basis:'recent_records',answer:['記録からまとめます。']})}}],usage:{prompt_tokens:100,completion_tokens:100}}));
    decisions.push({action:'answer',basis:'recent_records',answer:['家族の買い物は豆腐です。','参照：家族トークの会話。']});
    await dm('買い物をまとめて');
    expect(sent[0]).toContain('豆腐'); expect(sent[0]).not.toContain('記録からまとめます。');
    const request=vi.mocked(bindings.AI.run).mock.calls.at(-1)![1] as {response_format:{type:string}};
    expect(request.response_format.type).toBe('json_schema');
  });
  it("provides today's clock separately from the announcement date and event date", async () => {
    const now = Date.parse('2026-11-01T18:00:00+09:00'); vi.spyOn(Date, 'now').mockReturnValue(now);
    await env.DB.prepare("INSERT INTO messages(message_id,source_type,conversation_id,message_type,text,sent_at,received_at) VALUES ('old-event','group',?,'text','歩け歩け大会：令和７年１０月２６日開催予定です。',?,?)")
      .bind(group,Date.parse('2025-10-22T10:00:00+09:00'),now).run();
    decisions.push({ action: 'answer', basis: 'recent_records', answer: '2025年10月26日に開催予定だった大会です。' });
    await dm('歩け歩け大会について');
    const request = vi.mocked(bindings.AI.run).mock.calls.find(([model]) => model === DIRECT_MODEL)![1] as { messages: { role: string; content: string }[] };
    const content = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
    expect(content.current_time).toBe('2026-11-01 18:00:00 JST'); expect(content.question_sent_at).toBe(content.current_time);
    expect(content.timezone).toBe('Asia/Tokyo');
    expect(JSON.stringify(content.initial_recent_messages)).toContain('2025-10-22 10:00:00 JST');
    expect(JSON.stringify(content.initial_recent_messages)).toContain('令和７年１０月２６日');
    expect(content.initial_recent_messages.flatMap((c: { messages: { mentioned_dates: unknown[] }[] }) => c.messages).flatMap((m: { mentioned_dates: unknown[] }) => m.mentioned_dates))
      .toContainEqual({ date: '2025-10-26', relative_to_current_time: 'past' });
    expect(request.messages[0].content).toContain('予定日が過ぎただけで実施済みと断定しません');
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
  it("searches before accepting a historical not-found answer and includes neighboring trip details", async () => {
    const base = Date.parse('2026-07-26T12:00:00+09:00');
    for (const [id, text, offset] of [['hot-spring', '2日目は十勝川温泉の近くのガーデンスパ。水着を忘れずに。', 0], ['zoo', '旭山動物園付近で5月にヒグマが出たらしい。', 86400000]] as const) {
      await env.DB.prepare("INSERT INTO messages(message_id,source_type,conversation_id,message_type,text,sent_at,received_at) VALUES (?,'group',?,'text',?,?,?)").bind(id,group,text,base+offset,base+offset).run();
    }
    await groupText();
    await env.DB.prepare("INSERT INTO knowledge_jobs(message_id,status) VALUES ('zoo','ready')").run();
    await env.DB.prepare("INSERT INTO knowledge_chunks(id,message_id,ordinal,text) VALUES ('zoo-vector','zoo',0,'旭山動物園付近で5月にヒグマが出たらしい。')").run();
    vi.mocked(bindings.KNOWLEDGE.query).mockResolvedValue({ count: 1, matches: [{ id: 'zoo-vector', score: 0.7 }] });
    decisions.push({ action: 'answer', basis: 'not_found', answer: '旅行の記録はありません。' }, { action: 'answer', basis: 'history_records', answer: '7月の会話に旭山動物園と十勝川温泉の話があります。実際の訪問は記録だけでは断定できません。' });
    await dm('今年の夏の北海道旅行をまとめて');
    expect(sent[0]).toContain('十勝川温泉'); expect(sent[0]).not.toContain('旅行の記録はありません');
    const finalPrompt = JSON.stringify(vi.mocked(bindings.AI.run).mock.calls.at(-1)![1]);
    expect(finalPrompt).toContain('ガーデンスパ'); expect(finalPrompt).toContain('neighbor');
    const refs = JSON.parse(await env.DB.prepare("SELECT evidence_ids FROM bot_replies WHERE message_id='dm-1'").first<string>('evidence_ids') ?? '[]');
    expect(refs).toContain('hot-spring'); expect(refs).toContain('zoo');
    expect(await env.DB.prepare("SELECT owner_user_id FROM ai_usage WHERE kind='embedding'").first('owner_user_id')).toBe(user);
  });
  it("broadens an invalid model-generated time interval instead of failing the user's question", async () => {
    decisions.push({ action: 'tools', calls: [{ name: 'search_knowledge', arguments: { conversationId: group, query: '旅行', from: 1000, before: 1000 } }] }, { action: 'answer', basis: 'not_found', answer: '今回は関連記録を確認できませんでした。' });
    await dm('旅行について教えて');
    expect(sent[0]).toContain('今回は関連記録を確認できませんでした。');
    for (const [, options] of vi.mocked(bindings.KNOWLEDGE.query).mock.calls) expect(options).not.toHaveProperty('filter');
  });
  it("retains the original question as well as a rewritten query on the first search in each chat", async () => {
    decisions.push({ action: 'tools', calls: [{ name: 'search_knowledge', arguments: { conversationId: group, query: '北海道旅行' } }] }, { action: 'answer', basis: 'not_found', answer: '今回確認した範囲では不明です。' });
    await dm('今年の夏にいった北海道旅行についてまとめて。');
    const embeds = vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === EMBEDDING_MODEL);
    expect(JSON.stringify(embeds)).toContain('今年の夏にいった北海道旅行についてまとめて。');
    expect(JSON.stringify(embeds)).toContain('北海道旅行');
    expect(embeds).toHaveLength(2);
    expect(bindings.KNOWLEDGE.query).toHaveBeenCalledTimes(2);
  });
  it("keeps context anchors inside their chat and omits cancelled messages, including timestamp ties", async () => {
    for (const [id, chat, unsent] of [['a', group, null], ['b', group, null], ['c', group, 1], ['secret', secretGroup, null]] as const) {
      await env.DB.prepare("INSERT INTO messages(message_id,source_type,conversation_id,message_type,text,sent_at,received_at,unsent_at) VALUES (?,'group',?,'text',?,1000,1000,?)").bind(id,chat,id,unsent).run();
    }
    expect((await messageContext(group,'b',1,bindings)).map((r) => r.message_id)).toEqual(['b']);
    expect((await messageContext(group,'b',4,bindings)).map((r) => r.message_id)).toEqual(['a','b']);
    expect(await messageContext(group,'secret',4,bindings)).toEqual([]);
    expect(await messageContext(group,'c',4,bindings)).toEqual([]);
    decisions.push({ action: 'tools', calls: [{ name: 'get_message_context', arguments: { conversationId: secretGroup, messageId: 'secret' } }] }, { action: 'answer', answer: '参照できません。' });
    await dm('その発言の前後を調べて');
    expect(JSON.stringify(vi.mocked(bindings.AI.run).mock.calls.at(-1)![1])).not.toContain('"messageId":"secret"');
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
    decisions.push({ action: "tools", calls: [{ name: "search_knowledge", arguments: { conversationId: group, query: "去年の旅行", from: 1, before: 1000, date_basis: "message_time" } }] }, { action: "answer", answer: "記録では見つかりませんでした。" });
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
      allowed.clear(); return { choices: [{ message: { role: "assistant", content: JSON.stringify({ action: "answer", answer: "秘密の献立です。", basis: "recent_records" }) } }] };
    });
    await dm("献立は？");
    expect(sent[0]).not.toContain("秘密の献立");
    expect(sent[0]).toContain("回答を控えます");
  });
  it("bounds repeated tool requests and uses an answer-only final inference", async () => {
    await groupText();
    const call = { name: 'get_recent_messages', arguments: { conversationId: group } };
    decisions.push({ action: 'tools', calls: [call,call,call] }, { action: 'tools', calls: [call,call,call] },
      { action: 'answer', basis: 'recent_records', answer: '家族の買い物は豆腐です。' });
    await dm('献立と買い物は？');
    expect(sent[0]).toContain('豆腐');
    const runs = vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === DIRECT_MODEL);
    expect(runs).toHaveLength(3);
    const request = runs[2][1] as { response_format: { type: string }; messages: { content: string }[] };
    expect(request.response_format.type).toBe('json_schema');
    expect(request.messages.at(-1)!.content).toContain('ツール呼び出しは禁止');
    expect(request.messages[0].content).not.toContain('get_recent_messages');
  });
  it("feeds malformed tool arguments back to the planner without failing or exposing raw JSON", async () => {
    await groupText();
    decisions.push({ action:'tools', calls:[{name:'get_recent_messages',arguments:{conversationId:group,limit:'all',extra:'bad'}}] },
      {action:'answer',basis:'recent_records',answer:'家族では豆腐を買う予定です。'});
    await dm('買い物は？');
    expect(sent[0]).toContain('豆腐'); expect(sent[0]).not.toContain('"action"');
    expect(JSON.stringify(vi.mocked(bindings.AI.run).mock.calls.at(-1)![1])).toContain('ツールの引数が不正');
  });
  it("ignores an event-date filter unless the planner explicitly declares a message-time search", async () => {
    decisions.push({ action: 'tools', calls: [{ name: 'search_knowledge', arguments: { conversationId: group, query: '旅行', from: 100, before: 200 } }] },
      { action: 'answer', basis: 'not_found', answer: '今回は確認できませんでした。' });
    await dm('去年の旅行は？');
    for (const [, options] of vi.mocked(bindings.KNOWLEDGE.query).mock.calls) expect(options).not.toHaveProperty('filter');
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
    expect(await directUsage(other, bindings)).toBe(65);
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
    const request = vi.mocked(bindings.AI.run).mock.calls[0][1] as { messages: { content: string }[] };
    expect(await directUsage(user, bindings)).toBe(directReservation(DIRECT_MODELS.glm, request.messages));
    expect(sent[0]).toContain("一時的に生成できません");
  });
  it.each(["利用状況は", "利用状況は？", "今の利用状況を教えて", "残り予算", "利用率は？", "いまどのくらい使った？", "今どれくらい使ってる？", "usage"])("recognizes the no-cost command %s", (input) => {
    expect(isUsageQuestion(input)).toBe(true);
    expect(isUsageQuestion("グループで話した利用状況について調べて")).toBe(false);
  });
});
