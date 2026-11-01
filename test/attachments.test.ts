import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { bindings, message, post, unsend } from "./helpers";

const media = (type = "image") => ({ ...message(), message: { id: "message-1", type } });
const key = "line/group/group-1/message-1";
async function attachment() {
  return env.DB.prepare("SELECT * FROM attachments WHERE message_id = 'message-1'").first();
}
async function consume(attempts = 1) {
  const batch = createMessageBatch("line-group-talk-attachments", [{
    id: "job-1", timestamp: new Date(), attempts, body: { messageId: "message-1" },
  }]);
  await worker.queue(batch, bindings);
  return getQueueResult(batch, createExecutionContext());
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM attachments"), env.DB.prepare("DELETE FROM messages"), env.DB.prepare("DELETE FROM unsent_messages")]);
  const { objects } = await env.ATTACHMENTS.list();
  if (objects.length) await env.ATTACHMENTS.delete(objects.map((object) => object.key));
  vi.spyOn(bindings.ATTACHMENT_QUEUE, "send").mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 20 } } });
});
afterEach(() => vi.restoreAllMocks());

describe("attachment storage with D1, R2 and queue consumer", () => {
  it.each(["image", "video", "audio", "file"])("stores a %s and deduplicates queued work", async (type) => {
    expect((await post([{ ...media(type), message: { id: "message-1", type, fileName: "資料.pdf", fileSize: 4 } }])).status).toBe(200);
    expect(await attachment()).toMatchObject({ status: "pending", file_name: "資料.pdf", declared_size: 4 });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      // Validate options in the real Workers Request implementation even though
      // the upstream response is mocked (e.g. redirect: "error" is unsupported).
      new Request(input, init);
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "application/pdf" } });
    });
    expect((await consume()).explicitAcks).toContain("job-1");
    expect(fetch).toHaveBeenCalledWith("https://api-data.line.me/v2/bot/message/message-1/content", expect.objectContaining({
      headers: { Authorization: "Bearer test-token" }, redirect: "manual",
    }));
    expect(await attachment()).toMatchObject({ status: "stored", size_bytes: 4, content_type: "application/pdf", object_key: key });
    const object = await env.ATTACHMENTS.get(key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    await consume();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses multipart upload for content without a known length", async () => {
    await post([media()]);
    const length = 5 * 1024 * 1024 + 17;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(length).fill(7)));
    await consume();
    expect((await env.ATTACHMENTS.head(key))?.size).toBe(length);
    expect(await attachment()).toMatchObject({ status: "stored", size_bytes: length });
  });

  it("retries transient errors and later saves successfully", async () => {
    await post([media("video")]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response("video"));
    expect((await consume()).retryMessages).toMatchObject([{ msgId: "job-1" }]);
    expect(await attachment()).toMatchObject({ status: "pending", last_error_code: "line_http_202" });
    await consume(2);
    expect(await attachment()).toMatchObject({ status: "stored", attempts: 2, last_error_code: null });
  });

  it("records expired LINE content as a permanent failure", async () => {
    await post([media()]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    expect((await consume()).explicitAcks).toContain("job-1");
    expect(await attachment()).toMatchObject({ status: "failed", last_error_code: "line_http_404" });
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
  });

  it("does not follow redirects or forward LINE credentials to another host", async () => {
    await post([media()]);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new Request(input, init).redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://example.com/elsewhere" } });
    });
    expect((await consume()).retryMessages).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await attachment()).toMatchObject({ status: "pending", last_error_code: "line_http_302" });
  });

  it("recovers an R2 save completed before D1 state was committed", async () => {
    await post([media()]);
    await env.ATTACHMENTS.put(key, "already saved", { httpMetadata: { contentType: "image/png" } });
    const fetch = vi.spyOn(globalThis, "fetch");
    await consume();
    expect(fetch).not.toHaveBeenCalled();
    expect(await attachment()).toMatchObject({ status: "stored", size_bytes: 13, content_type: "image/png" });
  });

  it("marks exhausted downloads failed and retries for dead-letter routing", async () => {
    await post([media()]);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failed"));
    expect((await consume(6)).retryMessages).toHaveLength(1);
    expect(await attachment()).toMatchObject({ status: "failed", last_error_code: "storage_or_network_error" });
  });

  it("rejects oversized content before downloading it", async () => {
    await post([media("file")]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("large", { headers: { "content-length": "104857601" } }));
    await consume();
    expect(await attachment()).toMatchObject({ status: "failed", last_error_code: "size_limit" });
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
  });

  it("enforces the byte limit on a stream without Content-Length", async () => {
    await post([media()]);
    let remaining = 101;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    await consume();
    expect(await attachment()).toMatchObject({ status: "failed", last_error_code: "size_limit" });
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
  });

  it("does not expose a partial object after a stream fails", async () => {
    await post([media()]);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        else controller.error(new Error("download interrupted"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    expect((await consume()).retryMessages).toHaveLength(1);
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    expect(await attachment()).toMatchObject({ status: "pending", last_error_code: "storage_or_network_error" });
  });

  it("does not fetch external content URLs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await post([{ ...media(), message: { id: "message-1", type: "image", contentProvider: { type: "external", originalContentUrl: "https://example.com/private" } } }]);
    await consume();
    expect(await attachment()).toMatchObject({ status: "failed", last_error_code: "external_content_not_supported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["before-message", "before-download", "after-save"])("honors unsend %s", async (timing) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("image"));
    if (timing === "before-message") await post([unsend()]);
    await post([media()]);
    if (timing === "after-save") await consume();
    if (timing !== "before-message") await post([unsend()]);
    await consume();
    const calls = timing === "after-save" ? 1 : 0;
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    expect(await attachment()).toMatchObject({ status: "deleted", file_name: null, size_bytes: null });
    // Redelivery of an old media message must not restore the file.
    await post([media()]);
    await consume();
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("removes an object when unsend arrives during the R2 write", async () => {
    await post([media()]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("image"));
    const put = bindings.ATTACHMENTS.put.bind(bindings.ATTACHMENTS);
    vi.spyOn(bindings.ATTACHMENTS, "put").mockImplementation(async (...args) => {
      const result = await put(...args);
      await post([unsend()]);
      return result;
    });
    await consume();
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    expect(await attachment()).toMatchObject({ status: "deleted" });
  });

  it("reconciles queue publication failures from D1", async () => {
    const send = vi.mocked(bindings.ATTACHMENT_QUEUE.send);
    send.mockRejectedValueOnce(new Error("queue offline"));
    expect((await post([media()])).status).toBe(200);
    expect(await attachment()).toMatchObject({ status: "pending", queued_at: null });
    await worker.scheduled({} as ScheduledController, bindings);
    expect(send).toHaveBeenLastCalledWith({ messageId: "message-1" });
    expect((await attachment())?.queued_at).toEqual(expect.any(Number));
  });

  it("keeps failed deletions pending for retries and scheduled repair", async () => {
    await post([media()]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("image"));
    await consume();
    await post([unsend()]);
    vi.spyOn(bindings.ATTACHMENTS, "delete").mockRejectedValueOnce(new Error("R2 offline"));
    expect((await consume(6)).retryMessages).toHaveLength(1);
    expect(await attachment()).toMatchObject({ status: "delete_pending" });
    await consume();
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
  });

  it("assigns separate storage keys to messages from different groups", async () => {
    await post([media()]);
    await post([{ ...media(), webhookEventId: "event-2", source: { type: "group", groupId: "group-2" }, message: { id: "message-2", type: "image" } }]);
    expect(await env.DB.prepare("SELECT object_key FROM attachments ORDER BY message_id").all()).toMatchObject({ results: [
      { object_key: "line/group/group-1/message-1" }, { object_key: "line/group/group-2/message-2" },
    ] });
  });
});
