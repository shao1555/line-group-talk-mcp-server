import { cancelAttachment, consumeAttachments, recordAttachment, repairAttachmentJobs } from "./attachments";
import type { MediaMessage, AttachmentJob } from "./attachments";

type Source = { type: "group" | "room" | "user"; groupId?: string; roomId?: string; userId?: string };
type LineEvent = {
  type: string;
  webhookEventId: string;
  timestamp: number;
  source: Source;
  replyToken?: string;
  mode?: string;
  message?: MediaMessage & { text?: string };
  unsend?: { messageId: string };
};

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("Webhook body too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function validSignature(body: Uint8Array, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", key, bytes, body);
  } catch { return false; }
}

async function processEvent(event: LineEvent, env: Env): Promise<void> {
  if (event.type === "unsend" && event.unsend) {
    await cancelAttachment(event.unsend.messageId, event.timestamp, env);
    return;
  }
  if (event.type !== "message" || !event.message) return;
  const { message, source } = event;
  const conversationId = source.type === "group" ? source.groupId : source.type === "room" ? source.roomId : source.userId;
  if (!conversationId) throw new Error("Missing conversation ID");

  await env.DB.prepare(`
    INSERT INTO messages
      (message_id, webhook_event_id, source_type, conversation_id, user_id, message_type, text, sent_at, received_at, unsent_at)
    SELECT ?, ?, ?, ?, ?, ?, CASE WHEN u.unsent_at IS NULL THEN ? ELSE NULL END, ?, ?, u.unsent_at
    FROM (SELECT 1) LEFT JOIN unsent_messages u ON u.message_id = ?
    ON CONFLICT DO NOTHING
  `).bind(message.id, event.webhookEventId, source.type, conversationId, source.userId ?? null,
    message.type, message.type === "text" ? message.text ?? null : null,
    event.timestamp, Date.now(), message.id).run();

  await recordAttachment(message, source.type, conversationId, env);

  const stored = await env.DB.prepare("SELECT text, unsent_at, replied_at FROM messages WHERE message_id = ?")
    .bind(message.id).first<{ text: string | null; unsent_at: number | null; replied_at: number | null }>();
  if (!stored || stored.text !== "ping" || stored.unsent_at !== null || stored.replied_at !== null
    || !event.replyToken || event.mode === "standby") return;

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: "text", text: "pong" }] }),
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`LINE reply failed: ${response.status}`);
  await env.DB.prepare("UPDATE messages SET replied_at = ? WHERE message_id = ?")
    .bind(Date.now(), message.id).run();
}

export default {
  async queue(batch: MessageBatch<AttachmentJob>, env: Env): Promise<void> {
    await consumeAttachments(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await repairAttachmentJobs(env);
  },
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (path !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) {
      return new Response("LINE credentials not configured", { status: 503 });
    }
    const signature = request.headers.get("x-line-signature");
    if (!signature) return new Response("Invalid signature", { status: 401 });
    let body: Uint8Array;
    try { body = await readBody(request); }
    catch { return new Response("Payload too large", { status: 413 }); }
    if (!await validSignature(body, signature, env.LINE_CHANNEL_SECRET)) {
      return new Response("Invalid signature", { status: 401 });
    }
    let payload: { events: LineEvent[] };
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
      if (!payload || !Array.isArray(payload.events)) throw new Error("Invalid events");
    } catch { return new Response("Invalid payload", { status: 400 }); }
    try {
      // Await persistence and the short reply so failures are visible to LINE redelivery.
      // Do not store/log raw events: they contain message text and reply tokens.
      for (const event of payload.events) await processEvent(event, env);
      return Response.json({ ok: true });
    } catch {
      console.error(JSON.stringify({ event: "webhook_processing_failed" }));
      return new Response("Webhook processing failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env, AttachmentJob>;
