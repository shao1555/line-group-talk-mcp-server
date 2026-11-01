import { ensureRichMenu } from "./rich-menu";
import { syncDocumentProjections } from "./documents";
import { recordSentBotMessage, repairSentBotMessages } from "./bot-messages";
import { cancelAttachment, consumeAttachments, recordAttachment, repairAttachmentJobs } from "./attachments";
import type { MediaMessage, AttachmentJob } from "./attachments";
import { consumeKnowledge, markForIndex, repairKnowledgeJobs } from "./knowledge";
import { handleSearch } from "./search";
import { handleMcp, mcpResource } from "./mcp";
import { oauthServer } from "./oauth-server";
import { envForRequest } from "./origins";
import { answerMention, mentionQuestion, type Mention } from "./mentions";
import { readLimitedBody } from "./http";
import { recordConversation } from "./conversations";
import { handlePortal } from "./portal";

type Source = { type: "group" | "room" | "user"; groupId?: string; roomId?: string; userId?: string };
type LineEvent = {
  type: string;
  webhookEventId: string;
  timestamp: number;
  source: Source;
  replyToken?: string;
  mode?: string;
  message?: MediaMessage & { text?: string; quotedMessageId?: string; quoteToken?: string; mention?: { mentionees?: Mention[] } };
  unsend?: { messageId: string };
  joined?: { members?: { userId?: string }[] };
  left?: { members?: { userId?: string }[] };
};

const MAX_BODY_BYTES = 1024 * 1024;

async function validSignature(body: Uint8Array, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify("HMAC", key, bytes, body);
  } catch { return false; }
}

async function processEvent(event: LineEvent, env: Env, ctx?: ExecutionContext): Promise<void> {
  await recordConversation(event, env);
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
      (message_id, webhook_event_id, source_type, conversation_id, user_id, message_type, text, sent_at, received_at, unsent_at, quoted_message_id)
    SELECT ?, ?, ?, ?, ?, ?, CASE WHEN u.unsent_at IS NULL THEN ? ELSE NULL END, ?, ?, u.unsent_at, ?
    FROM (SELECT 1) LEFT JOIN unsent_messages u ON u.message_id = ?
    ON CONFLICT DO NOTHING
  `).bind(message.id, event.webhookEventId, source.type, conversationId, source.userId ?? null,
    message.type, message.type === "text" ? message.text ?? null : null,
    event.timestamp, Date.now(), typeof message.quotedMessageId === "string" ? message.quotedMessageId : null, message.id).run();

  await recordAttachment(message, source.type, conversationId, env);
  if (message.type === "text") await markForIndex(message.id, env);

  const stored = await env.DB.prepare("SELECT text, unsent_at, replied_at FROM messages WHERE message_id = ?")
    .bind(message.id).first<{ text: string | null; unsent_at: number | null; replied_at: number | null }>();
  if (stored?.text && stored.unsent_at === null && stored.replied_at === null && event.replyToken && event.mode !== "standby") {
    const mentions = message.mention?.mentionees ?? [];
    const directUserId = source.type === "user" && source.userId && /^U[a-f0-9]{32}$/.test(source.userId) ? source.userId : undefined;
    let question = directUserId && stored.text !== "ping" ? stored.text.slice(0, 2000) : mentionQuestion(stored.text, mentions);
    if (typeof message.quotedMessageId === "string") {
      const parent = await env.DB.prepare(`SELECT b.message_id FROM bot_replies b JOIN messages m USING(message_id)
        WHERE b.line_message_id = ? AND b.status = 'sent' AND b.text IS NOT NULL
        AND m.conversation_id = ? AND m.unsent_at IS NULL`)
        .bind(message.quotedMessageId, conversationId).first();
      if (parent) {
        // An explicit human addressee takes precedence over continuing a bot reply.
        if (mentions.some((mention) => mention.type === "user" && mention.isSelf !== true)) question = null;
        else if (question === null) question = stored.text.slice(0, 2000);
      }
    }
    if (question !== null) {
      const response = answerMention(message.id, question, conversationId, event.replyToken, env, message.quoteToken, directUserId);
      if (ctx) ctx.waitUntil(response);
      else await response;
      return;
    }
  }
  if (!stored || stored.text !== "ping" || stored.unsent_at !== null || stored.replied_at !== null
    || !event.replyToken || event.mode === "standby") return;

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: "text", text: "pong" }] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`LINE reply failed: ${response.status}`); }
  const receipt = await response.json() as { sentMessages?: { id?: unknown }[] };
  const sentId = receipt.sentMessages?.[0]?.id;
  await env.DB.batch([
    env.DB.prepare("UPDATE messages SET replied_at = ? WHERE message_id = ?").bind(Date.now(), message.id),
    env.DB.prepare(`INSERT INTO bot_replies(message_id, status, text, evidence_ids, created_at, line_message_id)
      SELECT message_id, 'sent', 'pong', '[]', ?, ? FROM messages WHERE message_id = ? AND unsent_at IS NULL
      ON CONFLICT(message_id) DO NOTHING`).bind(Date.now(), typeof sentId === "string" ? sentId : null, message.id),
  ]);
  try { await recordSentBotMessage(message.id, env); }
  catch { console.error(JSON.stringify({ event: "bot_message_record_failed", messageId: message.id })); }
}

export default {
  async queue(batch: MessageBatch<AttachmentJob>, env: Env): Promise<void> {
    if (batch.queue === "line-group-talk-knowledge") await consumeKnowledge(batch, env);
    else await consumeAttachments(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await repairSentBotMessages(env);
    await repairAttachmentJobs(env);
    await syncDocumentProjections(env);
    await repairKnowledgeJobs(env);
    await ensureRichMenu(env);
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    env = envForRequest(request, env);
    const path = new URL(request.url).pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource") && ctx) return mcpResource(env).fetch(request, env, ctx);
    if ((path.startsWith("/.well-known/") || path.startsWith("/oauth/")) && ctx) return oauthServer(env).fetch(request, env, ctx);
    if (["/", "/portal", "/portal.js", "/portal.css", "/authorize"].includes(path) || path.startsWith("/knowledge/") || path.startsWith("/auth/") || path.startsWith("/api/")) {
      return handlePortal(request, env);
    }
    if (path === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (path === "/search") return handleSearch(request, env);
    if (path === "/mcp") {
      if (!ctx) return new Response("Execution context required", { status: 500 });
      return handleMcp(request, env, ctx);
    }
    if (path !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) {
      return new Response("LINE credentials not configured", { status: 503 });
    }
    const signature = request.headers.get("x-line-signature");
    if (!signature) return new Response("Invalid signature", { status: 401 });
    let body: Uint8Array;
    try { body = await readLimitedBody(request, MAX_BODY_BYTES); }
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
      for (const event of payload.events) await processEvent(event, env, ctx);
      return Response.json({ ok: true });
    } catch {
      console.error(JSON.stringify({ event: "webhook_processing_failed" }));
      return new Response("Webhook processing failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env, AttachmentJob>;
