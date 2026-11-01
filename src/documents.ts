import { sha256, PROCESSOR_VERSION, EMBEDDING_MODEL } from "./ai";
import { readLimitedBody } from "./http";
import { accessibleConversations, verifyConversationAccess } from "./conversations";
import { markForIndex, enqueueKnowledge, cancellationStatements } from "./knowledge";
import { enqueueAttachment } from "./attachments";

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", log: "text/plain",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet", odt: "application/vnd.oasis.opendocument.text", html: "text/html", xml: "application/xml",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
type Document = { id: string; owner_user_id: string; title: string; file_name: string; canonical_message_id: string; created_at: number; revision: number; content_text: string | null; updated_at: number | null };

export async function listDocuments(userId: string, conversationIds: string[], env: Env) {
  const ids = conversationIds.length ? conversationIds : [""];
  const docs = await env.DB.prepare(`SELECT d.id, d.title, d.file_name, d.created_at, d.owner_user_id = ? AS is_owner,
      u.display_name AS owner_name, j.status, j.last_error_code
    FROM knowledge_documents d LEFT JOIN portal_users u ON u.user_id = d.owner_user_id
    LEFT JOIN knowledge_jobs j ON j.message_id = d.canonical_message_id
    WHERE d.deleted_at IS NULL AND (d.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM knowledge_document_chats c WHERE c.document_id = d.id AND c.conversation_id IN (SELECT value FROM json_each(?))))
    ORDER BY d.created_at DESC LIMIT 100`).bind(userId, userId, JSON.stringify(ids)).all();
  const chats = await env.DB.prepare(`SELECT c.document_id, c.conversation_id, c.enabled, j.status AS index_status FROM knowledge_document_chats c LEFT JOIN knowledge_jobs j ON j.message_id = c.message_id
    WHERE conversation_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<{ document_id: string; conversation_id: string; enabled: number; index_status: string | null }>();
  return docs.results.map((d) => ({ ...d, chats: chats.results.filter((c) => c.document_id === d.id) }));
}

export async function handleDocuments(request: Request, env: Env, userId: string): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/documents\/([a-f0-9-]{36})(?:\/(file|content|chats\/([CR][a-f0-9]{32})))?$/);
  if (!match && url.pathname === "/api/documents" && request.method === "POST") {
    const title = url.searchParams.get("title")?.trim() ?? "";
    const fileName = url.searchParams.get("fileName") ?? "";
    const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
    if (!title || title.length > 160 || !fileName || fileName.length > 200 || !TYPES[extension]) return Response.json({ error: "タイトルと対応形式のファイルを指定してください。" }, { status: 400 });
    let ids: string[];
    try {
      const input: unknown = JSON.parse(url.searchParams.get("conversationIds") ?? "[]");
      if (!Array.isArray(input) || input.length > 20 || !input.every((id) => typeof id === "string" && /^[CR][a-f0-9]{32}$/.test(id))) throw new Error();
      ids = [...new Set(input)];
    } catch { return Response.json({ error: "利用するチャットを選び直してください。" }, { status: 400 }); }
    for (const id of ids) if (!await verifyConversationAccess(userId, id, env, false)) return Response.json({ error: "参加していないチャットは指定できません。" }, { status: 403 });
    let body: Uint8Array;
    try { body = await readLimitedBody(request, TYPES[extension].startsWith("image/") ? 4 * 1024 * 1024 : MAX_BYTES); }
    catch { return Response.json({ error: "ファイルは10MB、画像は4MBまでです。" }, { status: 413 }); }
    if (!body.length) return Response.json({ error: "空のファイルは登録できません。" }, { status: 400 });
    const id = crypto.randomUUID(), now = Date.now(), messageId = `document:${id}`, objectKey = `knowledge-documents/${id}`;
    await env.ATTACHMENTS.put(objectKey, body, { httpMetadata: { contentType: TYPES[extension] } });
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO knowledge_documents(id, owner_user_id, title, file_name, canonical_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, userId, title, fileName, messageId, now),
        env.DB.prepare(`INSERT INTO messages(message_id, source_type, conversation_id, user_id, message_type, sent_at, received_at, knowledge_document_id, knowledge_registered)
          VALUES (?, 'document', ?, ?, 'file', ?, ?, ?, 1)`).bind(messageId, `document:${id}`, userId, now, now, id),
        env.DB.prepare(`INSERT INTO attachments(message_id, object_key, file_name, declared_size, size_bytes, content_type, status)
          VALUES (?, ?, ?, ?, ?, ?, 'stored')`).bind(messageId, objectKey, fileName, body.length, body.length, TYPES[extension]),
        env.DB.prepare("INSERT INTO knowledge_jobs(message_id) VALUES (?)").bind(messageId),
        ...ids.map((chat) => env.DB.prepare(`INSERT INTO knowledge_document_chats(document_id, conversation_id, message_id, enabled, updated_by, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)`).bind(id, chat, `knowledge:${id}:${chat}`, userId, now)),
      ]);
    } catch (error) { await env.ATTACHMENTS.delete(objectKey); throw error; }
    await markForIndex(messageId, env);
    return Response.json({ id }, { status: 201 });
  }
  if (!match) return new Response("Not found", { status: 404 });
  const doc = await env.DB.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL").bind(match[1]).first<Document>();
  if (!doc) return Response.json({ error: "ナレッジが見つかりません。" }, { status: 404 });
  if (match[2] === "content" && ["GET", "PUT"].includes(request.method)) {
    if (!await canReadDocument(doc, userId, url.searchParams.get("conversationId"), env)) return new Response("Not found", { status: 404 });
    if (request.method === "GET") {
      const processing = await env.DB.prepare("SELECT status, last_error_code FROM knowledge_jobs WHERE message_id = ?").bind(doc.canonical_message_id).first();
      return Response.json({ id: doc.id, title: doc.title, text: doc.content_text, revision: doc.revision,
        updatedAt: doc.updated_at ?? doc.created_at, fileName: doc.file_name, processing });
    }
    let input: { text: string; revision: number };
    try {
      input = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, 180_000)));
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 40_000 || !Number.isSafeInteger(input.revision)) throw new Error();
    } catch { return Response.json({ error: "本文は1〜40,000文字で指定してください。" }, { status: 400 }); }
    if (input.revision !== doc.revision) return Response.json({ error: "他の人が更新しています。再読み込みして内容を確認してください。" }, { status: 409 });
    const revision = doc.revision + 1, token = crypto.randomUUID(), now = Date.now();
    const canonical = `document:${doc.id}:r${revision}`;
    const guard = "EXISTS (SELECT 1 FROM knowledge_documents WHERE id = ? AND edit_token = ?)";
    const old = "SELECT message_id FROM messages WHERE knowledge_document_id = ? AND knowledge_document_revision < ?";
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE knowledge_documents SET content_text = ?, revision = ?, canonical_message_id = ?, updated_at = ?, updated_by = ?, edit_token = ?
        WHERE id = ? AND revision = ? AND deleted_at IS NULL`).bind(input.text, revision, canonical, now, userId, token, doc.id, doc.revision),
      env.DB.prepare(`INSERT INTO messages(message_id, source_type, conversation_id, user_id, message_type, sent_at, received_at, knowledge_document_id, knowledge_document_revision, knowledge_registered)
        SELECT ?, 'document', ?, ?, 'file', ?, ?, ?, ?, 1 WHERE ${guard}`)
        .bind(canonical, `document:${doc.id}`, doc.owner_user_id, now, now, doc.id, revision, doc.id, token),
      env.DB.prepare(`INSERT INTO knowledge_jobs(message_id, extracted_text) SELECT ?, ? WHERE ${guard}`)
        .bind(canonical, `【アップロード資料: ${doc.title}】\n${input.text}`, doc.id, token),
      env.DB.prepare(`UPDATE bot_replies SET text = NULL, evidence_ids = NULL WHERE ${guard} AND EXISTS (
        SELECT 1 FROM json_each(bot_replies.evidence_ids) e WHERE e.value IN (${old}))`).bind(doc.id, token, doc.id, revision),
      env.DB.prepare(`UPDATE messages SET text = NULL, unsent_at = ? WHERE ${guard} AND (
        (knowledge_document_id = ? AND knowledge_document_revision < ?) OR (sender_role = 'bot' AND reply_to_message_id IN (SELECT message_id FROM bot_replies WHERE text IS NULL)))`)
        .bind(now, doc.id, token, doc.id, revision),
      env.DB.prepare(`UPDATE knowledge_chunks SET text = NULL, embedding = NULL WHERE ${guard} AND message_id IN (
        SELECT message_id FROM messages WHERE unsent_at IS NOT NULL)`).bind(doc.id, token),
      env.DB.prepare(`UPDATE knowledge_jobs SET status = 'delete_pending', extracted_text = NULL, queued_at = NULL, next_attempt_at = 0
        WHERE ${guard} AND status != 'deleted' AND message_id IN (SELECT message_id FROM messages WHERE unsent_at IS NOT NULL)`).bind(doc.id, token),
      env.DB.prepare(`UPDATE knowledge_cache SET text = '' WHERE ${guard} AND cache_key IN (SELECT cache_key FROM knowledge_jobs WHERE message_id IN (${old}))`)
        .bind(doc.id, token, doc.id, revision),
      env.DB.prepare(`UPDATE knowledge_document_chats SET message_id = 'knowledge:' || document_id || ':' || conversation_id || ':r' || CAST(? AS INTEGER), updated_by = ?, updated_at = ?
        WHERE document_id = ? AND ${guard}`).bind(revision, userId, now, doc.id, doc.id, token),
    ]);
    if (!result[0].meta.changes) return Response.json({ error: "他の人が更新しています。再読み込みしてください。" }, { status: 409 });
    await markForIndex(canonical, env);
    return Response.json({ revision });
  }
  if (match[2]?.startsWith("chats/") && request.method === "PUT") {
    const chat = match[3];
    if (!await verifyConversationAccess(userId, chat, env, false)) return Response.json({ error: "このチャットに参加していません。" }, { status: 403 });
    const existing = await env.DB.prepare("SELECT message_id FROM knowledge_document_chats WHERE document_id = ? AND conversation_id = ?").bind(doc.id, chat).first<{ message_id: string }>();
    if (!existing && doc.owner_user_id !== userId) return Response.json({ error: "他の人のナレッジを新しいチャットへ共有することはできません。" }, { status: 403 });
    let enabled: boolean;
    try { const value = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, 100))); if (typeof value.enabled !== "boolean") throw new Error(); enabled = value.enabled; }
    catch { return Response.json({ error: "チェック状態を確認してください。" }, { status: 400 }); }
    const projection = existing?.message_id ?? `knowledge:${doc.id}:${chat}${doc.revision > 1 ? `:r${doc.revision}` : ""}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO knowledge_document_chats(document_id, conversation_id, message_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id, conversation_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(doc.id, chat, projection, enabled ? 1 : 0, userId, Date.now()),
      ...(!enabled ? cancellationStatements(projection, env) : []),
    ]);
    if (enabled) await syncDocumentProjections(env, doc.id);
    return new Response(null, { status: 204 });
  }
  if (!match[2] && request.method === "DELETE") {
    if (doc.owner_user_id !== userId) return Response.json({ error: "削除できるのはアップロードした本人だけです。" }, { status: 403 });
    const projections = await env.DB.prepare("SELECT message_id FROM knowledge_document_chats WHERE document_id = ?").bind(doc.id).all<{ message_id: string }>();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE knowledge_documents SET deleted_at = ? WHERE id = ?").bind(now, doc.id),
      env.DB.prepare("INSERT INTO unsent_messages(message_id, unsent_at) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING").bind(doc.canonical_message_id, now),
      env.DB.prepare("UPDATE messages SET text = NULL, unsent_at = ? WHERE message_id = ?").bind(now, doc.canonical_message_id),
      env.DB.prepare(`UPDATE attachments SET status = 'delete_pending', file_name = NULL, declared_size = NULL, content_type = NULL,
        size_bytes = NULL, duration_ms = NULL, queued_at = NULL WHERE message_id IN (SELECT message_id FROM messages WHERE knowledge_document_id = ?) AND status != 'deleted'`).bind(doc.id),
      ...cancellationStatements(doc.canonical_message_id, env),
      ...projections.results.flatMap((r) => cancellationStatements(r.message_id, env)),
    ]);
    await enqueueAttachment(doc.canonical_message_id, env);
    await enqueueKnowledge(doc.canonical_message_id, env);
    return new Response(null, { status: 204 });
  }
  if (match[2] === "file" && request.method === "GET") {
    if (doc.owner_user_id !== userId) {
      const access = await accessibleConversations(userId, env, false);
      const links = await env.DB.prepare("SELECT conversation_id FROM knowledge_document_chats WHERE document_id = ?").bind(doc.id).all<{ conversation_id: string }>();
      if (!links.results.some((c) => access.conversations.some((a) => a.id === c.conversation_id))) return new Response("Not found", { status: 404 });
    }
    const object = await env.ATTACHMENTS.get(`knowledge-documents/${doc.id}`);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name).replaceAll("'", "%27")}` } });
  }
  return new Response("Not found", { status: 404 });
}

export async function syncDocumentProjections(env: Env, documentId?: string): Promise<void> {
  const obsolete = await env.DB.prepare(`SELECT m.message_id FROM messages m JOIN knowledge_documents d ON d.id = m.knowledge_document_id
    JOIN knowledge_jobs j ON j.message_id = m.message_id WHERE j.status NOT IN ('delete_pending', 'deleted') AND (
      d.deleted_at IS NOT NULL OR m.knowledge_document_revision != d.revision OR
      (m.source_type != 'document' AND NOT EXISTS (SELECT 1 FROM knowledge_document_chats c
        WHERE c.document_id = d.id AND c.message_id = m.message_id AND c.enabled = 1))) LIMIT 20`).all<{ message_id: string }>();
  if (obsolete.results.length) await env.DB.batch(obsolete.results.flatMap((r) => cancellationStatements(r.message_id, env)));
  const candidates = await env.DB.prepare(`SELECT c.*, d.title, d.owner_user_id, d.created_at, d.canonical_message_id, d.revision, v.source_type
    FROM knowledge_document_chats c JOIN knowledge_documents d ON d.id = c.document_id JOIN conversations v USING(conversation_id)
    JOIN knowledge_jobs canonical ON canonical.message_id = d.canonical_message_id
    LEFT JOIN knowledge_jobs projected ON projected.message_id = c.message_id
    WHERE c.enabled = 1 AND d.deleted_at IS NULL AND canonical.status = 'ready'
      AND (projected.message_id IS NULL OR projected.status = 'deleted') AND (projected.lease_until IS NULL OR projected.lease_until <= ?)
      AND (? IS NULL OR d.id = ?) LIMIT 20`).bind(Date.now(), documentId ?? null, documentId ?? null)
    .all<{ document_id: string; conversation_id: string; message_id: string; canonical_message_id: string; source_type: string; owner_user_id: string; created_at: number; revision: number }>();
  for (const row of candidates.results) {
    const chunks = await env.DB.prepare("SELECT ordinal, text, embedding FROM knowledge_chunks WHERE message_id = ? ORDER BY ordinal").bind(row.canonical_message_id)
      .all<{ ordinal: number; text: string; embedding: string }>();
    const copies = await Promise.all(chunks.results.map(async (c) => ({ ...c, id: await sha256(`${PROCESSOR_VERSION}:${EMBEDDING_MODEL}:${row.message_id}:${c.ordinal}`) })));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO messages(message_id, source_type, conversation_id, user_id, message_type, sent_at, received_at, knowledge_document_id, knowledge_document_revision, knowledge_registered)
        VALUES (?, ?, ?, ?, 'knowledge', ?, ?, ?, ?, 1) ON CONFLICT(message_id) DO NOTHING`)
        .bind(row.message_id, row.source_type, row.conversation_id, row.owner_user_id, row.created_at, row.created_at, row.document_id, row.revision),
      env.DB.prepare(`INSERT INTO knowledge_jobs(message_id, extracted_text) SELECT ?, extracted_text FROM knowledge_jobs WHERE message_id = ?
        ON CONFLICT(message_id) DO UPDATE SET status = 'pending', extracted_text = excluded.extracted_text, next_attempt_at = 0, queued_at = NULL`)
        .bind(row.message_id, row.canonical_message_id),
      ...copies.map((c) => env.DB.prepare(`INSERT INTO knowledge_chunks(id, message_id, ordinal, text, embedding) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`).bind(c.id, row.message_id, c.ordinal, c.text, c.embedding)),
    ]);
  }
}

async function canReadDocument(doc: Document, userId: string, chat: string | null, env: Env): Promise<boolean> {
  if (doc.owner_user_id === userId) return true;
  const links = await env.DB.prepare("SELECT conversation_id FROM knowledge_document_chats WHERE document_id = ?").bind(doc.id).all<{ conversation_id: string }>();
  for (const link of links.results) {
    if (chat && link.conversation_id !== chat) continue;
    if (await verifyConversationAccess(userId, link.conversation_id, env, false)) return true;
  }
  return false;
}
