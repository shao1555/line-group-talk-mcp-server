import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bindings, message, post } from "./helpers";

declare global {
  namespace Cloudflare {
    interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] }
  }
}

async function row() {
  return env.DB.prepare("SELECT * FROM messages WHERE message_id = 'message-1'").first();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM attachments"), env.DB.prepare("DELETE FROM messages"), env.DB.prepare("DELETE FROM unsent_messages")]);
});
afterEach(() => vi.restoreAllMocks());

describe("LINE webhook with D1", () => {
  it("accepts LINE's empty verification request", async () => {
    expect((await post([])).status).toBe(200);
  });

  it("rejects an invalid signature before saving or replying", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await post([message("ping")], "invalid")).status).toBe(401);
    expect(await row()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves text and attribution without replying to normal messages", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await post([message("日本語の会話\n続き")])).status).toBe(200);
    expect(await row()).toMatchObject({ text: "日本語の会話\n続き", conversation_id: "group-1",
      user_id: "user-1", source_type: "group", sent_at: 1700000000000 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves ping, replies pong, and deduplicates redelivery", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    expect((await post([message("ping")])).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith("https://api.line.me/v2/bot/message/reply", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      body: JSON.stringify({ replyToken: "reply-1", messages: [{ type: "text", text: "pong" }] }),
    }));
    expect((await row())?.replied_at).toEqual(expect.any(Number));
    expect((await post([message("ping")])).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE sender_role = 'user'").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT text, sender_role, reply_to_message_id FROM messages WHERE sender_role = 'bot'").first()).toMatchObject({ text: "pong", sender_role: "bot", reply_to_message_id: "message-1" });
  });

  it("keeps text on reply failure and retries on redelivery", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}"));
    expect((await post([message("ping")])).status).toBe(500);
    expect(await row()).toMatchObject({ text: "ping", replied_at: null });
    expect((await post([message("ping")])).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reply to standby events or non-exact ping", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await post([{ ...message("ping"), mode: "standby" }])).status).toBe(200);
    expect((await post([{ ...message("PING"), webhookEventId: "event-2", message: { id: "message-2", type: "text", text: "PING" } }])).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles non-text messages and missing user IDs", async () => {
    vi.spyOn(bindings.ATTACHMENT_QUEUE, "send").mockRejectedValue(new Error("test queue offline"));
    expect((await post([{ ...message(), source: { type: "group", groupId: "group-1" },
      message: { id: "message-1", type: "image" } }])).status).toBe(200);
    expect(await row()).toMatchObject({ text: null, user_id: null, message_type: "image" });
  });

  it.each([false, true])("honors unsend even when delivered before the original (%s)", async (unsendFirst) => {
    const unsend = { type: "unsend", webhookEventId: "unsend-1", timestamp: 1700000001000,
      source: { type: "group", groupId: "group-1" }, unsend: { messageId: "message-1" } };
    const events = unsendFirst ? [unsend, message()] : [message(), unsend];
    expect((await post(events)).status).toBe(200);
    expect((await post([message()])).status).toBe(200);
    expect(await row()).toMatchObject({ text: null, unsent_at: 1700000001000 });
  });
});
