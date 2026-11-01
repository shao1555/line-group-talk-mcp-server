import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { repairKnowledgeJobs } from "../src/knowledge";
import worker from "../src/index";
import { reserveAI, EMBEDDING_MODEL, VISION_MODEL, AUDIO_MODEL } from "../src/ai";
import { bindings, message, post, unsend } from "./helpers";

const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(["attachments", "messages", "unsent_messages"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(bindings.ATTACHMENT_QUEUE, "send").mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  vi.spyOn(bindings.KNOWLEDGE, "upsert").mockResolvedValue({ ids: [], count: 0 });
  vi.spyOn(bindings.KNOWLEDGE, "deleteByIds").mockResolvedValue({ ids: [], count: 0 });
  vi.spyOn(bindings.AI, "run").mockImplementation(async (model) => {
    if (model === EMBEDDING_MODEL) return { data: [vector] };
    if (model === AUDIO_MODEL) return { text: "来週の集合は十時です。" };
    if (model === VISION_MODEL) return { response: "【文字】会場は東京駅【画像の説明】集合場所の案内", usage: { prompt_tokens: 100, completion_tokens: 30 } };
    throw new Error("Unmocked AI model");
  });
});
afterEach(() => vi.restoreAllMocks());

async function consume(id = "message-1", attempts = 1) {
  const batch = createMessageBatch("line-group-talk-knowledge", [{ id: "knowledge-1", timestamp: new Date(), attempts, body: { messageId: id } }]);
  await worker.queue(batch, bindings);
  return getQueueResult(batch, createExecutionContext());
}
async function job(id = "message-1") {
  return env.DB.prepare("SELECT * FROM knowledge_jobs WHERE message_id = ?").bind(id).first();
}
async function attachment(type = "image", contentType = "image/jpeg", id = "message-1", group = "group-1", duration?: number) {
  await post([{ ...message(), webhookEventId: `event-${id}`, source: { type: "group", groupId: group },
    message: { id, type, duration, fileName: type === "file" ? "document.pdf" : undefined } }]);
  const key = `line/group/${group}/${id}`;
  await env.ATTACHMENTS.put(key, "fixture");
  await env.DB.prepare("UPDATE attachments SET status = 'stored', size_bytes = 7, content_type = ? WHERE message_id = ?")
    .bind(contentType, id).run();
  // Mimic the storage consumer scheduling extraction after R2 completion.
  await env.DB.prepare("INSERT INTO knowledge_jobs(message_id) VALUES (?) ON CONFLICT DO NOTHING").bind(id).run();
  return key;
}

describe("knowledge extraction and indexing", () => {
  it("indexes a text message in its conversation namespace, once", async () => {
    await post([message("集合場所は東京駅です")]);
    await consume();
    expect(await job()).toMatchObject({ status: "ready", extracted_text: "集合場所は東京駅です" });
    expect(bindings.KNOWLEDGE.upsert).toHaveBeenCalledWith([expect.objectContaining({ namespace: "group-1", values: vector })]);
    await consume();
    expect(bindings.AI.run).toHaveBeenCalledTimes(1);
  });

  it("indexes imported sender names without inventing LINE user IDs", async () => {
    await post([message("去年は京都に行きました")]);
    await env.DB.prepare("UPDATE messages SET sender_name = '書き出しの名前', user_id = NULL WHERE message_id = 'message-1'").run();
    await consume();
    expect(await job()).toMatchObject({ status: "ready", extracted_text: "書き出し履歴・表示名: 書き出しの名前\n去年は京都に行きました" });
    expect(bindings.KNOWLEDGE.upsert).toHaveBeenCalledWith([expect.objectContaining({ namespace: "group-1" })]);
  });

  it("labels the bot's own answer in indexed text", async () => {
    await post([message("botによる買い物の提案")]);
    await env.DB.prepare("UPDATE messages SET sender_role = 'bot', sender_name = 'bot', user_id = NULL WHERE message_id = 'message-1'").run();
    await consume();
    expect(await job()).toMatchObject({ status: "ready", extracted_text: "bot 自身の発言（提案・回答。人間の決定とは限りません）\nbotによる買い物の提案" });
  });

  it("extracts OCR and description, then indexes, without summarizing the conversation", async () => {
    await attachment();
    await consume();
    expect(await job()).toMatchObject({ status: "ready", extraction_attempts: 1, indexing_attempts: 1 });
    expect(bindings.AI.run).toHaveBeenNthCalledWith(1, VISION_MODEL, expect.objectContaining({ max_tokens: 1024 }), expect.anything());
    expect(bindings.AI.run).toHaveBeenNthCalledWith(2, EMBEDDING_MODEL, expect.anything(), expect.anything());
    const usage = await env.DB.prepare("SELECT kind, charged_microusd FROM ai_usage ORDER BY created_at").all();
    expect(usage.results).toHaveLength(2);
    expect(usage.results[0].charged_microusd).toBeLessThan(50_000);
  });

  it("reuses extraction for identical files within one group, but not across groups", async () => {
    await attachment(); await consume();
    await attachment("image", "image/jpeg", "message-2"); await consume("message-2");
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(1);
    await attachment("image", "image/jpeg", "message-3", "group-2"); await consume("message-3");
    expect(vi.mocked(bindings.AI.run).mock.calls.filter(([model]) => model === VISION_MODEL)).toHaveLength(2);
  });

  it.each(["audio", "video"])("transcribes %s with the bounded inexpensive model", async (type) => {
    await attachment(type, type === "audio" ? "audio/mp4" : "video/mp4", "message-1", "group-1", 30_000);
    await consume();
    expect(await job()).toMatchObject({ status: "ready", extracted_text: "来週の集合は十時です。" });
    expect(bindings.AI.run).toHaveBeenCalledWith(AUDIO_MODEL, expect.objectContaining({ task: "transcribe", language: "ja" }), expect.anything());
    expect(await env.DB.prepare("SELECT units FROM ai_usage WHERE kind = 'audio'").first("units")).toBe(30);
  });

  it("refuses unknown/oversized audio durations before a paid model call", async () => {
    await attachment("audio", "audio/mp4");
    await consume();
    expect(await job()).toMatchObject({ status: "failed", last_error_code: "audio_duration_limit_or_unknown" });
    expect(bindings.AI.run).not.toHaveBeenCalled();
  });

  it("extracts PDF text before considering image inference", async () => {
    const key = await attachment("file", "application/pdf");
    const pdf = await PDFDocument.create(); pdf.addPage();
    await env.ATTACHMENTS.put(key, await pdf.save());
    vi.spyOn(bindings.AI, "toMarkdown").mockResolvedValue({ id: "pdf", name: "document.pdf", mimeType: "application/pdf", format: "markdown", tokens: 10, data: "次回の議題は予算です" });
    await consume();
    expect(await job()).toMatchObject({ status: "ready", extracted_text: "次回の議題は予算です" });
    expect(bindings.AI.toMarkdown).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversionOptions: expect.objectContaining({ pdf: { metadata: false, images: { convert: false } } }) }));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM ai_usage WHERE kind = 'image'").first("n")).toBe(0);
  });

  it("defers at the budget cap, preserving source and retry allowance", async () => {
    await attachment();
    await reserveAI("answer", VISION_MODEL, 1, 5_000_000, bindings);
    await consume();
    expect(await job()).toMatchObject({ status: "budget_wait", extraction_attempts: 0 });
    expect(bindings.AI.run).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM attachments WHERE status = 'stored'").first("n")).toBe(1);
    await env.DB.prepare("DELETE FROM ai_usage").run();
    await env.DB.prepare("UPDATE knowledge_jobs SET next_attempt_at = 0").run();
    await consume();
    expect(await job()).toMatchObject({ status: "ready" });
  });

  it("enforces the budget atomically under concurrent reservations", async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveAI("answer", VISION_MODEL, 1, 300_000, bindings)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
    expect(await env.DB.prepare("SELECT SUM(charged_microusd) AS total FROM ai_usage").first("total")).toBe(4_800_000);
  });

  it("retries Vectorize failures using the saved embedding", async () => {
    await post([message()]);
    vi.mocked(bindings.KNOWLEDGE.upsert).mockRejectedValueOnce(new Error("Vectorize offline"));
    await consume();
    expect(await job()).toMatchObject({ status: "retry" });
    await env.DB.prepare("UPDATE knowledge_jobs SET next_attempt_at = 0").run();
    await consume("message-1", 2);
    expect(await job()).toMatchObject({ status: "ready" });
    expect(bindings.AI.run).toHaveBeenCalledTimes(1);
  });

  it("purges extracted text and vectors on unsend", async () => {
    await attachment(); await consume();
    await post([unsend()]);
    expect(await job()).toMatchObject({ status: "delete_pending", extracted_text: null });
    expect(await env.DB.prepare("SELECT text FROM knowledge_chunks").first("text")).toBeNull();
    await consume();
    expect(bindings.KNOWLEDGE.deleteByIds).toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "deleted" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM knowledge_cache").first("n")).toBe(0);
  });

  it("does not retain OCR results if unsend arrives during inference", async () => {
    await attachment();
    vi.mocked(bindings.AI.run).mockImplementationOnce(async () => {
      await post([unsend()]); return { response: "cancelled content" };
    });
    await consume();
    expect(await job()).toMatchObject({ status: "deleted", extracted_text: null });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM knowledge_cache").first("n")).toBe(0);
    expect(bindings.KNOWLEDGE.upsert).not.toHaveBeenCalled();
  });

  it("deletes a vector if unsend races with upsert", async () => {
    await post([message()]);
    vi.mocked(bindings.KNOWLEDGE.upsert).mockImplementationOnce(async () => {
      await post([unsend()]); return { ids: [], count: 0 };
    });
    await consume();
    expect(bindings.KNOWLEDGE.deleteByIds).toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "deleted", extracted_text: null });
  });
  it("does not call the model twice when a duplicate arrives during processing", async () => {
    await post([message("集合は10時です")]);
    vi.mocked(bindings.AI.run).mockImplementationOnce(async () => {
      await consume(); // another consumer/retry sees the same job while its lease is held
      return { data: [vector] };
    });
    await consume();
    expect(bindings.AI.run).toHaveBeenCalledTimes(1);
    expect(await job()).toMatchObject({ status: "ready", lease_token: null, lease_until: 0 });
  });
  it("recovers an expired processing lease", async () => {
    await post([message("集合は10時です")]);
    await env.DB.prepare("UPDATE knowledge_jobs SET lease_token = 'abandoned', lease_until = ? WHERE message_id = 'message-1'").bind(Date.now() - 1).run();
    await consume();
    expect(await job()).toMatchObject({ status: "ready", lease_token: null, lease_until: 0 });
  });
  it("dispatches 100 pending jobs in batches without republishing active or newly queued jobs", async () => {
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 105 }, (_, i) => env.DB.prepare(`INSERT INTO messages(message_id, source_type, conversation_id, message_type, text, sent_at, received_at)
      VALUES (?, 'group', 'group-1', 'text', '履歴', ?, ?)`).bind(`bulk-${i}`, now, now)));
    await env.DB.prepare("INSERT INTO knowledge_jobs(message_id) SELECT message_id FROM messages").run();
    await env.DB.prepare("UPDATE knowledge_jobs SET lease_until = ? WHERE message_id = 'bulk-0'").bind(now + 60_000).run();
    await env.DB.prepare("UPDATE knowledge_jobs SET queued_at = ? WHERE message_id = 'bulk-1'").bind(now).run();
    await repairKnowledgeJobs(bindings);
    expect(bindings.KNOWLEDGE_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    const requests = vi.mocked(bindings.KNOWLEDGE_QUEUE.sendBatch).mock.calls.flatMap(([items]) => Array.from(items));
    expect(requests).toHaveLength(100);
    expect(requests.map((r) => (r.body as { messageId: string }).messageId)).not.toContain('bulk-0');
    expect(requests.map((r) => (r.body as { messageId: string }).messageId)).not.toContain('bulk-1');
    await repairKnowledgeJobs(bindings);
    expect(vi.mocked(bindings.KNOWLEDGE_QUEUE.sendBatch).mock.calls).toHaveLength(2);
    expect(Array.from(vi.mocked(bindings.KNOWLEDGE_QUEUE.sendBatch).mock.calls[1][0])).toHaveLength(3);
  });
  it("keeps jobs eligible for the next minute when batch publication fails", async () => {
    await post([message("履歴")]);
    await env.DB.prepare("UPDATE knowledge_jobs SET queued_at = NULL").run();
    vi.mocked(bindings.KNOWLEDGE_QUEUE.sendBatch).mockRejectedValueOnce(new Error("Queue unavailable"));
    await repairKnowledgeJobs(bindings);
    expect((await job())?.queued_at).toBeNull();
    await repairKnowledgeJobs(bindings);
    expect((await job())?.queued_at).toEqual(expect.any(Number));
  });

});
