import { cancellationStatements, enqueueKnowledge, markForIndex } from "./knowledge";

export type AttachmentJob = { messageId: string };
export type MediaMessage = {
  id: string;
  type: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  contentProvider?: { type: string };
};

type Attachment = {
  message_id: string;
  object_key: string;
  status: string;
  unsent_at: number | null;
  declared_size: number | null;
};

const MEDIA_TYPES = new Set(["image", "video", "audio", "file"]);
const PART_SIZE = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 6; // initial delivery + max_retries: 5 in wrangler.jsonc

class ContentError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}

export async function enqueueAttachment(messageId: string, env: Env): Promise<void> {
  try {
    await env.ATTACHMENT_QUEUE.send({ messageId });
    await env.DB.prepare("UPDATE attachments SET queued_at = ? WHERE message_id = ?")
      .bind(Date.now(), messageId).run();
  } catch {
    // D1 is the durable outbox. The scheduled handler repairs failed publications.
    console.error(JSON.stringify({ event: "attachment_enqueue_failed", messageId }));
  }
}

export async function recordAttachment(message: MediaMessage, sourceType: string, conversationId: string, env: Env): Promise<void> {
  if (!MEDIA_TYPES.has(message.type)) return;
  const external = message.contentProvider && message.contentProvider.type !== "line";
  const key = ["line", sourceType, conversationId, message.id].map(encodeURIComponent).join("/");
  await env.DB.prepare(`
    INSERT INTO attachments (message_id, object_key, file_name, declared_size, duration_ms, status, last_error_code)
    SELECT message_id, ?, CASE WHEN unsent_at IS NULL THEN ? ELSE NULL END,
      CASE WHEN unsent_at IS NULL THEN ? ELSE NULL END,
      CASE WHEN unsent_at IS NULL THEN ? ELSE NULL END,
      CASE WHEN unsent_at IS NOT NULL THEN 'delete_pending' WHEN ? THEN 'failed' ELSE 'pending' END,
      CASE WHEN unsent_at IS NULL AND ? THEN 'external_content_not_supported' ELSE NULL END
    FROM messages WHERE message_id = ?
    ON CONFLICT(message_id) DO NOTHING
  `).bind(key, message.fileName ?? null, message.fileSize ?? null, message.duration ?? null, !!external, !!external, message.id).run();
  const row = await env.DB.prepare("SELECT status FROM attachments WHERE message_id = ?")
    .bind(message.id).first<{ status: string }>();
  if (row?.status === "pending" || row?.status === "delete_pending") await enqueueAttachment(message.id, env);
}

export async function cancelAttachment(messageId: string, timestamp: number, env: Env): Promise<void> {
  // Commit the tombstone, text removal and deletion job in one D1 transaction.
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO unsent_messages(message_id, unsent_at) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING")
      .bind(messageId, timestamp),
    env.DB.prepare("UPDATE messages SET text = NULL, unsent_at = ? WHERE message_id = ?").bind(timestamp, messageId),
    env.DB.prepare(`UPDATE attachments SET status = 'delete_pending',
      file_name = NULL, declared_size = NULL, content_type = NULL, size_bytes = NULL, duration_ms = NULL,
      last_error_code = NULL, queued_at = NULL WHERE message_id = ? AND status != 'deleted'`).bind(messageId),
    ...cancellationStatements(messageId, env),
  ]);
  if (results[2].meta.changes) await enqueueAttachment(messageId, env);
  await enqueueKnowledge(messageId, env);
}

async function load(messageId: string, env: Env): Promise<Attachment | null> {
  return env.DB.prepare(`SELECT a.message_id, a.object_key, a.status, a.declared_size, m.unsent_at
    FROM attachments a JOIN messages m USING(message_id) WHERE a.message_id = ?`)
    .bind(messageId).first<Attachment>();
}

async function remove(row: Attachment, env: Env): Promise<void> {
  await env.ATTACHMENTS.delete(row.object_key);
  await env.DB.prepare(`UPDATE attachments SET status = 'deleted', file_name = NULL, declared_size = NULL, duration_ms = NULL,
    content_type = NULL, size_bytes = NULL, last_error_code = NULL, deleted_at = ? WHERE message_id = ?`)
    .bind(Date.now(), row.message_id).run();
}

// Buffer at most one 5 MiB part, including when LINE omits Content-Length.
// Multipart uploads are completed atomically; partial uploads are aborted on failure.
async function storeBody(response: Response, key: string, maxBytes: number, env: Env): Promise<number> {
  if (!response.body) throw new ContentError("empty_content", true);
  const reader = response.body.getReader();
  let multipart: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(PART_SIZE);
  let used = 0;
  let size = 0;
  const options = { httpMetadata: { contentType: response.headers.get("content-type") ?? "application/octet-stream" } };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ContentError("size_limit", true);
      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(PART_SIZE - used, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === PART_SIZE) {
          multipart ??= await env.ATTACHMENTS.createMultipartUpload(key, options);
          parts.push(await multipart.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(PART_SIZE);
          used = 0;
        }
      }
    }
    if (multipart) {
      if (used) parts.push(await multipart.uploadPart(parts.length + 1, buffer.subarray(0, used)));
      await multipart.complete(parts);
    } else {
      await env.ATTACHMENTS.put(key, buffer.subarray(0, used), options);
    }
    return size;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (multipart) await multipart.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function syncAttachment(messageId: string, env: Env): Promise<void> {
  const row = await load(messageId, env);
  if (!row) return;
  if (row.unsent_at !== null || row.status === "delete_pending" || row.status === "deleted") {
    await remove(row, env);
    return;
  }
  if (row.status === "stored" || row.status === "failed") return;
  // Recover a crash after R2 completion but before D1 was updated, without
  // re-downloading content which may since have expired on LINE.
  const existing = await env.ATTACHMENTS.head(row.object_key);
  if (existing) {
    await finishStorage(row, existing.size, existing.httpMetadata?.contentType ?? "application/octet-stream", env);
    return;
  }
  const maxBytes = Number(env.MAX_ATTACHMENT_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ContentError("invalid_size_config");
  if (row.declared_size !== null && row.declared_size > maxBytes) throw new ContentError("size_limit", true);
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new ContentError("missing_access_token");
  await env.DB.prepare("UPDATE attachments SET attempts = attempts + 1 WHERE message_id = ?").bind(messageId).run();
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    // Workers supports manual/follow, not the Fetch standard's error mode.
    // Inspect the status ourselves so credentials are never forwarded on redirects.
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ContentError(`line_http_${response.status}`, [400, 404, 410].includes(response.status));
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > maxBytes) {
    await response.body?.cancel();
    throw new ContentError("size_limit", true);
  }
  const size = await storeBody(response, row.object_key, maxBytes, env);
  await finishStorage(row, size, response.headers.get("content-type") ?? "application/octet-stream", env);
}

async function finishStorage(row: Attachment, size: number, contentType: string, env: Env): Promise<void> {
  const messageId = row.message_id;
  await env.DB.prepare(`UPDATE attachments SET status = 'stored', size_bytes = ?, content_type = ?,
    stored_at = ?, last_error_code = NULL WHERE message_id = ?
    AND NOT EXISTS (SELECT 1 FROM unsent_messages WHERE message_id = ?)`)
    .bind(size, contentType, Date.now(), messageId, messageId).run();
  // Unsend may arrive during either the download or the R2 write.
  const current = await load(messageId, env);
  if (current && current.unsent_at !== null) await remove(current, env);
  else await markForIndex(messageId, env);
}

export async function consumeAttachments(batch: MessageBatch<AttachmentJob>, env: Env): Promise<void> {
  // The queue's max_concurrency is 1. Do not parallelize these operations:
  // uploads and deletes for the same stable R2 key must be serialized.
  for (const message of batch.messages) {
    try {
      await syncAttachment(message.body.messageId, env);
      message.ack();
    } catch (error) {
      const code = error instanceof ContentError ? error.code : "storage_or_network_error";
      const terminal = error instanceof ContentError && error.permanent || message.attempts >= MAX_ATTEMPTS;
      await env.DB.prepare(`UPDATE attachments SET last_error_code = ?,
        status = CASE WHEN ? AND status = 'pending' THEN 'failed' ELSE status END WHERE message_id = ?`)
        .bind(code, terminal, message.body.messageId).run();
      let detail = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
      for (const secret of [env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_CHANNEL_SECRET]) {
        if (secret) detail = detail.replaceAll(secret, "[redacted]");
      }
      console.error(JSON.stringify({ event: "attachment_sync_failed", messageId: message.body.messageId, code, detail: detail.slice(0, 500) }));
      if (error instanceof ContentError && error.permanent) message.ack();
      else message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 900) });
    }
  }
}

export async function repairAttachmentJobs(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT message_id FROM attachments
    WHERE status IN ('pending', 'delete_pending') AND (queued_at IS NULL OR queued_at < ?)
    ORDER BY queued_at LIMIT 100`).bind(Date.now() - 5 * 60_000).all<{ message_id: string }>();
  for (const row of results) await enqueueAttachment(row.message_id, env);
}
