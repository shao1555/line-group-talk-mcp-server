import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vitest";
import { bindings } from "./helpers";

beforeEach(async () => {
  await env.DB.batch(["knowledge_chunks", "bot_replies", "knowledge_jobs", "knowledge_cache", "ai_usage", "search_clients"]
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(bindings.KNOWLEDGE_QUEUE, "send").mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
});
