import { documentUrl } from "./document-links";
import { embed, sha256 } from "./ai";
import { readLimitedBody } from "./http";
import { verifyConversationAccess, type AccessibleConversation } from "./conversations";

export type SearchHit = { messageId: string; text: string; sentAt: number; fileName: string | null; score: number; sender_role?: "user" | "bot"; sender_name?: string | null; user_id?: string | null; document_id?: string | null; document_title?: string | null; sourceUrl?: string; reply_to_message_id?: string | null };
export type SearchPrincipal = { conversationIds: string[]; conversations?: AccessibleConversation[] };
export type SearchRange = { from?: number; before?: number; fallbackToAllTime?: boolean; timeoutMs?: number; includeBot?: boolean };

export async function authenticateSearch(request: Request, env: Env): Promise<SearchPrincipal | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer ([\w-]{32,256})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT conversation_ids, owner_user_id FROM search_clients
    WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
    .bind(await sha256(token), Date.now()).first<{ conversation_ids: string; owner_user_id: string | null }>();
  if (!row) return null;
  const ids: unknown = JSON.parse(row.conversation_ids);
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return null;
  if (!row.owner_user_id) return { conversationIds: ids };
  const access = await Promise.all(ids.map((id) => verifyConversationAccess(row.owner_user_id!, id, env, false)));
  return { conversationIds: access.filter((item) => item !== null).map((item) => item.id) };
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
    ? queryAllTime(vector, conversationId, env, excludeId, limit, range.includeBot) : [];
  const ids = [...scores.keys()];
  const { results } = await env.DB.prepare(`SELECT c.id, c.text, m.message_id, m.sent_at, m.sender_role, m.sender_name, m.user_id, m.reply_to_message_id, COALESCE(a.file_name, d.file_name) AS file_name, m.knowledge_document_id AS document_id, d.title AS document_title
    FROM knowledge_chunks c JOIN available_messages m USING(message_id) JOIN knowledge_jobs j USING(message_id)
    LEFT JOIN attachments a USING(message_id) LEFT JOIN knowledge_documents d ON d.id = m.knowledge_document_id
    WHERE c.id IN (${ids.map(() => "?").join(",")}) AND m.conversation_id = ? AND m.unsent_at IS NULL AND (m.sender_role = 'user' OR ?)
    AND c.text IS NOT NULL AND j.status = 'ready' AND m.message_id != ?
    AND m.sent_at >= ? AND m.sent_at < ?`)
    .bind(...ids, conversationId, range.includeBot ? 1 : 0, excludeId ?? "", range.from ?? 0, range.before ?? Number.MAX_SAFE_INTEGER)
    .all<{ id: string; text: string; message_id: string; sent_at: number; file_name: string | null; sender_role: "user" | "bot"; sender_name: string | null; user_id: string | null; reply_to_message_id: string | null; document_id: string | null; document_title: string | null }>();
  if (!results.length && range.fallbackToAllTime && Object.keys(sentAt).length) return queryAllTime(vector, conversationId, env, excludeId, limit, range.includeBot);
  return results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, limit)
    .map((row) => ({ messageId: row.message_id, text: row.text, sentAt: row.sent_at, fileName: row.file_name, score: scores.get(row.id) ?? 0, sender_role: row.sender_role, sender_name: row.sender_name, user_id: row.user_id, reply_to_message_id: row.reply_to_message_id, document_id: row.document_id, document_title: row.document_title, ...(row.document_id ? { sourceUrl: documentUrl(row.document_id, conversationId, env) } : {}) }));
}

async function queryAllTime(vector: number[], conversationId: string, env: Env, excludeId: string | undefined, limit: number, includeBot = false): Promise<SearchHit[]> {
  // Reuse the query embedding when broadening an empty date-filtered search.
  const matches = await env.KNOWLEDGE.query(vector, { namespace: conversationId, topK: Math.min(limit * 3, 30), returnMetadata: "none" });
  if (!matches.matches.length) return [];
  const scores = new Map(matches.matches.map((match) => [match.id, match.score]));
  const ids = [...scores.keys()];
  const { results } = await env.DB.prepare(`SELECT c.id, c.text, m.message_id, m.sent_at, m.sender_role, m.sender_name, m.user_id, m.reply_to_message_id, COALESCE(a.file_name, d.file_name) AS file_name, m.knowledge_document_id AS document_id, d.title AS document_title
    FROM knowledge_chunks c JOIN available_messages m USING(message_id) JOIN knowledge_jobs j USING(message_id)
    LEFT JOIN attachments a USING(message_id) LEFT JOIN knowledge_documents d ON d.id = m.knowledge_document_id WHERE c.id IN (${ids.map(() => "?").join(",")})
    AND m.conversation_id = ? AND m.unsent_at IS NULL AND (m.sender_role = 'user' OR ?) AND c.text IS NOT NULL AND j.status = 'ready' AND m.message_id != ?`)
    .bind(...ids, conversationId, includeBot ? 1 : 0, excludeId ?? "").all<{ id: string; text: string; message_id: string; sent_at: number; file_name: string | null; sender_role: "user" | "bot"; sender_name: string | null; user_id: string | null; reply_to_message_id: string | null; document_id: string | null; document_title: string | null }>();
  return results.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, limit)
    .map((row) => ({ messageId: row.message_id, text: row.text, sentAt: row.sent_at, fileName: row.file_name, score: scores.get(row.id) ?? 0, sender_role: row.sender_role, sender_name: row.sender_name, user_id: row.user_id, reply_to_message_id: row.reply_to_message_id, document_id: row.document_id, document_title: row.document_title, ...(row.document_id ? { sourceUrl: documentUrl(row.document_id, conversationId, env) } : {}) }));
}

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let principal: SearchPrincipal | null;
  try { principal = await authenticateSearch(request, env); }
  catch { return new Response("Membership verification temporarily unavailable", { status: 503 }); }
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
