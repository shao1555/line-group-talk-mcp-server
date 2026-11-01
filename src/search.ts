import { embed, sha256 } from "./ai";
import { readLimitedBody } from "./http";

export type SearchHit = { messageId: string; text: string; sentAt: number; fileName: string | null; score: number };
export type SearchPrincipal = { conversationIds: string[] };
export type SearchRange = { from?: number; before?: number; fallbackToAllTime?: boolean; timeoutMs?: number };

export async function authenticateSearch(request: Request, env: Env): Promise<SearchPrincipal | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer ([\w-]{32,256})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare("SELECT conversation_ids FROM search_clients WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256(token)).first<{ conversation_ids: string }>();
  if (!row) return null;
  const ids: unknown = JSON.parse(row.conversation_ids);
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return null;
  return { conversationIds: ids };
}

export async function searchKnowledge(query: string, conversationId: string, env: Env, excludeId?: string, limit = 5, range: SearchRange = {}): Promise<SearchHit[]> {
  if (!query.trim() || query.length > 2000 || !conversationId || conversationId.length > 64) throw new Error("Invalid search");
  const [vector] = await embed([query], env, range.timeoutMs ?? 8000);
  const sentAt: Record<string, number> = {};
  if (range.from !== undefined) sentAt.$gte = range.from;
  if (range.before !== undefined) sentAt.$lt = range.before;
  // Vectorize V2 requires an enum here; the generated legacy types also permit boolean.
  const matches = await env.KNOWLEDGE.query(vector, {
    namespace: conversationId, topK: Math.min(limit * 3, 30), returnMetadata: "none",
    ...(Object.keys(sentAt).length ? { filter: { sent_at: sentAt } } : {}),
  });
  const scores = new Map(matches.matches.map((match) => [match.id, match.score]));
  if (!scores.size) return range.fallbackToAllTime && Object.keys(sentAt).length
    ? queryAllTime(vector, conversationId, env, excludeId, limit) : [];
  const ids = [...scores.keys()];
  const { results } = await env.DB.prepare(`SELECT c.id, c.text, m.message_id, m.sent_at, a.file_name
    FROM knowledge_chunks c JOIN messages m USING(message_id) JOIN knowledge_jobs j USING(message_id)
    LEFT JOIN attachments a USING(message_id)
    WHERE c.id IN (${ids.map(() => "?").join(",")}) AND m.conversation_id = ? AND m.unsent_at IS NULL
    AND c.text IS NOT NULL AND j.status = 'ready' AND m.message_id != ?
    AND m.sent_at >= ? AND m.sent_at < ?`)
    .bind(...ids, conversationId, excludeId ?? "", range.from ?? 0, range.before ?? Number.MAX_SAFE_INTEGER)
    .all<{ id: string; text: string; message_id: string; sent_at: number; file_name: string | null }>();
  if (!results.length && range.fallbackToAllTime && Object.keys(sentAt).length) return queryAllTime(vector, conversationId, env, excludeId, limit);
  return results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, limit)
    .map((row) => ({ messageId: row.message_id, text: row.text, sentAt: row.sent_at, fileName: row.file_name, score: scores.get(row.id) ?? 0 }));
}

async function queryAllTime(vector: number[], conversationId: string, env: Env, excludeId: string | undefined, limit: number): Promise<SearchHit[]> {
  // Reuse the query embedding when broadening an empty date-filtered search.
  const matches = await env.KNOWLEDGE.query(vector, { namespace: conversationId, topK: Math.min(limit * 3, 30), returnMetadata: "none" });
  if (!matches.matches.length) return [];
  const scores = new Map(matches.matches.map((match) => [match.id, match.score]));
  const ids = [...scores.keys()];
  const { results } = await env.DB.prepare(`SELECT c.id, c.text, m.message_id, m.sent_at, a.file_name
    FROM knowledge_chunks c JOIN messages m USING(message_id) JOIN knowledge_jobs j USING(message_id)
    LEFT JOIN attachments a USING(message_id) WHERE c.id IN (${ids.map(() => "?").join(",")})
    AND m.conversation_id = ? AND m.unsent_at IS NULL AND c.text IS NOT NULL AND j.status = 'ready' AND m.message_id != ?`)
    .bind(...ids, conversationId, excludeId ?? "").all<{ id: string; text: string; message_id: string; sent_at: number; file_name: string | null }>();
  return results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, limit)
    .map((row) => ({ messageId: row.message_id, text: row.text, sentAt: row.sent_at, fileName: row.file_name, score: scores.get(row.id) ?? 0 }));
}

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const principal = await authenticateSearch(request, env);
  if (!principal) return new Response("Unauthorized", { status: 401 });
  let raw: string;
  try { raw = new TextDecoder().decode(await readLimitedBody(request, 8000)); }
  catch { return new Response("Payload too large", { status: 413 }); }
  let input: { query?: unknown; conversationId?: unknown };
  try { input = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > 2000
    || typeof input.conversationId !== "string") return new Response("Invalid input", { status: 400 });
  if (!principal.conversationIds.includes(input.conversationId)) return new Response("Forbidden", { status: 403 });
  try { return Response.json({ results: await searchKnowledge(input.query, input.conversationId, env) }); }
  catch (error) {
    let detail = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
    detail = detail.replaceAll(input.query, "[query]");
    console.error(JSON.stringify({ event: "knowledge_search_failed", detail: detail.slice(0, 500) }));
    return new Response("Search temporarily unavailable", { status: 503 });
  }
}
