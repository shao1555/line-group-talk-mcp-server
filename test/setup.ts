import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vitest";
import { bindings } from "./helpers";

beforeEach(async () => {
  await env.DB.batch(["knowledge_chunks", "bot_replies", "knowledge_jobs", "knowledge_cache", "ai_usage_totals", "ai_usage", "search_clients",
    "line_rich_menus", "knowledge_document_chats", "knowledge_documents", "oauth_connections", "portal_sessions", "portal_login_flows", "portal_users", "conversation_members", "conversations"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(bindings.KNOWLEDGE_QUEUE, "sendBatch").mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  vi.spyOn(bindings.KNOWLEDGE_QUEUE, "send").mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
});
