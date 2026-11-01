import { env } from "cloudflare:workers";
import worker from "../src/index";

export const secrets = { LINE_CHANNEL_SECRET: "test-secret", LINE_CHANNEL_ACCESS_TOKEN: "test-token" };
export const bindings = { ...env, ...secrets };
export const message = (text = "hello") => ({
  type: "message", webhookEventId: "event-1", timestamp: 1700000000000,
  source: { type: "group", groupId: "group-1", userId: "user-1" },
  replyToken: "reply-1", mode: "active",
  message: { id: "message-1", type: "text", text },
});

export const unsend = () => ({
  type: "unsend", webhookEventId: "unsend-1", timestamp: 1700000001000,
  source: { type: "group", groupId: "group-1" }, unsend: { messageId: "message-1" },
});

export async function post(events: unknown[], signature?: string) {
  const body = JSON.stringify({ destination: "bot-1", events });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secrets.LINE_CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const signed = btoa(String.fromCharCode(...hmac));
  return worker.fetch(new Request("https://example.com/webhook", {
    method: "POST", headers: { "x-line-signature": signature ?? signed }, body,
  }), bindings);
}
