import { BudgetExceeded, EMBEDDING_MODEL, PROCESSOR_VERSION, ProcessingError, embed, sha256 } from "./ai";
import { extractAttachment, type AttachmentContent } from "./extract";

export type KnowledgeJob = { messageId: string };
type Job = {
  message_id: string; status: string; extracted_text: string | null; cache_key: string | null;
  extraction_attempts: number; indexing_attempts: number; next_attempt_at: number;
  sender_role: string; sender_name: string | null; text: string | null; message_type: string; conversation_id: string; source_type: string; sent_at: number; unsent_at: number | null;
};

export async function enqueueKnowledge(messageId: string, env: Env): Promise<void> {
  try {
    await env.KNOWLEDGE_QUEUE.send({ messageId });
    await env.DB.prepare("UPDATE knowledge_jobs SET queued_at = ? WHERE message_id = ?").bind(Date.now(), messageId).run();
  } catch { console.error(JSON.stringify({ event: "knowledge_enqueue_failed", messageId })); }
}

export async function markForIndex(messageId: string, env: Env): Promise<void> {
  await env.DB.prepare(`INSERT INTO knowledge_jobs(message_id)
    SELECT message_id FROM messages WHERE message_id = ? AND unsent_at IS NULL AND source_type != 'user'
    ON CONFLICT(message_id) DO NOTHING`).bind(messageId).run();
  const job = await env.DB.prepare("SELECT status, next_attempt_at FROM knowledge_jobs WHERE message_id = ?")
    .bind(messageId).first<{ status: string; next_attempt_at: number }>();
  if (job && ["pending", "retry", "waiting_attachment"].includes(job.status) && job.next_attempt_at <= Date.now()) await enqueueKnowledge(messageId, env);
}

export function cancellationStatements(messageId: string, env: Env): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE knowledge_cache SET text = '' WHERE cache_key = (SELECT cache_key FROM knowledge_jobs WHERE message_id = ?)
      AND NOT EXISTS (SELECT 1 FROM knowledge_jobs j JOIN messages m USING(message_id)
        WHERE j.cache_key = knowledge_cache.cache_key AND j.message_id != ? AND m.unsent_at IS NULL)`)
      .bind(messageId, messageId),
    env.DB.prepare("UPDATE knowledge_chunks SET text = NULL, embedding = NULL WHERE message_id = ?").bind(messageId),
    env.DB.prepare(`INSERT INTO knowledge_jobs(message_id, status)
      SELECT message_id, 'delete_pending' FROM messages WHERE message_id = ?
      ON CONFLICT(message_id) DO UPDATE SET status = 'delete_pending', extracted_text = NULL, next_attempt_at = 0, queued_at = NULL`)
      .bind(messageId),
    env.DB.prepare(`UPDATE bot_replies SET text = NULL, evidence_ids = NULL WHERE message_id = ?
      OR EXISTS (SELECT 1 FROM json_each(bot_replies.evidence_ids) WHERE value = ?)`).bind(messageId, messageId),
    // Remove copies and cached chunks atomically with the original reply redaction.
    env.DB.prepare(`UPDATE messages SET text = NULL, unsent_at = ? WHERE sender_role = 'bot' AND unsent_at IS NULL
      AND reply_to_message_id IN (SELECT message_id FROM bot_replies WHERE text IS NULL)`).bind(Date.now()),
    env.DB.prepare(`UPDATE knowledge_chunks SET text = NULL, embedding = NULL WHERE message_id IN
      (SELECT message_id FROM messages WHERE sender_role = 'bot' AND unsent_at IS NOT NULL)`),
    env.DB.prepare(`UPDATE knowledge_jobs SET status = 'delete_pending', extracted_text = NULL, next_attempt_at = 0, queued_at = NULL
      WHERE status != 'deleted' AND message_id IN (SELECT message_id FROM messages WHERE sender_role = 'bot' AND unsent_at IS NOT NULL)`),
  ];
}

async function load(messageId: string, env: Env): Promise<Job | null> {
  return env.DB.prepare(`SELECT j.*, m.text, m.sender_role, m.sender_name, m.message_type, m.conversation_id, m.source_type, m.sent_at, m.unsent_at
    FROM knowledge_jobs j JOIN messages m USING(message_id) WHERE message_id = ?`).bind(messageId).first<Job>();
}

async function removeIndex(messageId: string, env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM knowledge_chunks WHERE message_id = ?").bind(messageId).all<{ id: string }>();
  if (results.length) await env.KNOWLEDGE.deleteByIds(results.map((row) => row.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM knowledge_chunks WHERE message_id = ?").bind(messageId),
    env.DB.prepare("UPDATE knowledge_jobs SET status = 'deleted', extracted_text = NULL, last_error_code = NULL WHERE message_id = ?").bind(messageId),
    env.DB.prepare(`DELETE FROM knowledge_cache WHERE cache_key = (SELECT cache_key FROM knowledge_jobs WHERE message_id = ?)
      AND NOT EXISTS (SELECT 1 FROM knowledge_jobs j JOIN messages m USING(message_id)
        WHERE j.cache_key = knowledge_cache.cache_key AND m.unsent_at IS NULL)`).bind(messageId),
  ]);
}

export function splitText(text: string): string[] {
  const chars = Array.from(text.trim());
  const chunks: string[] = [];
  for (let offset = 0; offset < chars.length && chunks.length < 64; offset += 700) chunks.push(chars.slice(offset, offset + 800).join(""));
  return chunks;
}

async function processKnowledge(messageId: string, env: Env): Promise<void> {
  const job = await load(messageId, env);
  if (!job) return;
  if (job.unsent_at !== null || job.status === "delete_pending" || job.status === "deleted") { await removeIndex(messageId, env); return; }
  if (["ready", "failed", "skipped"].includes(job.status) || job.next_attempt_at > Date.now()) return;
  let text = job.extracted_text;
  if (text === null) {
    if (job.message_type === "text") text = job.sender_role === "bot" ? `bot 自身の発言（提案・回答。人間の決定とは限りません）\n${job.text ?? ""}` : job.sender_name ? `書き出し履歴・表示名: ${job.sender_name}\n${job.text ?? ""}` : job.text ?? "";
    else {
      const attachment = await env.DB.prepare(`SELECT a.*, m.message_type, m.conversation_id FROM attachments a JOIN messages m USING(message_id)
        WHERE a.message_id = ?`).bind(messageId).first<AttachmentContent & { status: string }>();
      if (!attachment || attachment.status === "pending") {
        await env.DB.prepare("UPDATE knowledge_jobs SET status = 'waiting_attachment', next_attempt_at = ? WHERE message_id = ?")
          .bind(Date.now() + 60_000, messageId).run(); return;
      }
      if (attachment.status !== "stored") throw new ProcessingError("attachment_unavailable", true);
      if (job.extraction_attempts >= 2) throw new ProcessingError("extraction_retry_limit", true);
      await env.DB.prepare("UPDATE knowledge_jobs SET extraction_attempts = extraction_attempts + 1 WHERE message_id = ?").bind(messageId).run();
      const extracted = await extractAttachment(attachment, env);
      const current = await load(messageId, env);
      if (current?.unsent_at !== null) { await removeIndex(messageId, env); return; }
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO knowledge_cache(cache_key, conversation_id, processor, text)
          SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM unsent_messages WHERE message_id = ?)
          ON CONFLICT(cache_key) DO UPDATE SET text = excluded.text`)
          .bind(extracted.cacheKey, job.conversation_id, extracted.processor, extracted.text, messageId),
        env.DB.prepare(`UPDATE knowledge_jobs SET extracted_text = ?, cache_key = ?, processor = ?
          WHERE message_id = ? AND status != 'delete_pending'`).bind(extracted.text, extracted.cacheKey, extracted.processor, messageId),
      ]);
      text = extracted.text;
    }
    await env.DB.prepare("UPDATE knowledge_jobs SET extracted_text = ? WHERE message_id = ? AND status != 'delete_pending'").bind(text, messageId).run();
  }
  if ((await load(messageId, env))?.unsent_at !== null) { await removeIndex(messageId, env); return; }
  const chunks = splitText(text);
  if (!chunks.length) {
    await env.DB.prepare("UPDATE knowledge_jobs SET status = 'skipped', last_error_code = 'no_text' WHERE message_id = ? AND status != 'delete_pending'").bind(messageId).run(); return;
  }
  const rows = await Promise.all(chunks.map(async (chunk, ordinal) => ({
    id: await sha256(`${PROCESSOR_VERSION}:${EMBEDDING_MODEL}:${messageId}:${ordinal}`), text: chunk, ordinal,
  })));
  await env.DB.batch(rows.map((row) => env.DB.prepare(`INSERT INTO knowledge_chunks(id, message_id, ordinal, text)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM unsent_messages WHERE message_id = ?)
    ON CONFLICT(id) DO NOTHING`).bind(row.id, messageId, row.ordinal, row.text, messageId)));
  const saved = await env.DB.prepare("SELECT id, text, embedding FROM knowledge_chunks WHERE message_id = ? ORDER BY ordinal")
    .bind(messageId).all<{ id: string; text: string | null; embedding: string | null }>();
  const missing = saved.results.filter((row) => !row.embedding && row.text !== null);
  if (missing.length) {
    if (job.indexing_attempts >= 2) throw new ProcessingError("embedding_retry_limit", true);
    await env.DB.prepare("UPDATE knowledge_jobs SET indexing_attempts = indexing_attempts + 1 WHERE message_id = ?").bind(messageId).run();
    for (let offset = 0; offset < missing.length; offset += 16) {
      const part = missing.slice(offset, offset + 16);
      const vectors = await embed(part.map((row) => row.text!), env);
      await env.DB.batch(part.map((row, i) => env.DB.prepare(`UPDATE knowledge_chunks SET embedding = ? WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM unsent_messages WHERE message_id = ?)`)
        .bind(JSON.stringify(vectors[i]), row.id, messageId)));
      if ((await load(messageId, env))?.unsent_at !== null) { await removeIndex(messageId, env); return; }
    }
  }
  if ((await load(messageId, env))?.unsent_at !== null) { await removeIndex(messageId, env); return; }
  const all = await env.DB.prepare("SELECT id, embedding FROM knowledge_chunks WHERE message_id = ? ORDER BY ordinal")
    .bind(messageId).all<{ id: string; embedding: string | null }>();
  if (all.results.some((row) => !row.embedding)) throw new ProcessingError("embedding_missing");
  await env.KNOWLEDGE.upsert(all.results.map((row) => ({
    id: row.id, values: JSON.parse(row.embedding!), namespace: job.conversation_id,
    metadata: { message_id: messageId, source_type: job.source_type, sent_at: job.sent_at },
  })));
  if ((await load(messageId, env))?.unsent_at !== null) { await removeIndex(messageId, env); return; }
  await env.DB.prepare("UPDATE knowledge_jobs SET status = 'ready', indexed_at = ?, last_error_code = NULL WHERE message_id = ? AND status != 'delete_pending'")
    .bind(Date.now(), messageId).run();
}

export async function consumeKnowledge(batch: MessageBatch<KnowledgeJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE knowledge_jobs SET lease_token = ?, lease_until = ?
      WHERE message_id = ? AND lease_until <= ?`)
      .bind(lease, Date.now() + 10 * 60_000, message.body.messageId, Date.now()).run();
    if (!claimed.meta.changes) { message.ack(); continue; }
    try { await processKnowledge(message.body.messageId, env); message.ack(); }
    catch (error) {
      const budget = error instanceof BudgetExceeded;
      const permanent = error instanceof ProcessingError && error.permanent;
      const code = error instanceof ProcessingError ? error.code : "knowledge_processing_failed";
      if (budget) {
        await env.DB.prepare(`UPDATE knowledge_jobs SET
          extraction_attempts = CASE WHEN extracted_text IS NULL THEN MAX(0, extraction_attempts - 1) ELSE extraction_attempts END,
          indexing_attempts = CASE WHEN extracted_text IS NOT NULL THEN MAX(0, indexing_attempts - 1) ELSE indexing_attempts END
          WHERE message_id = ?`).bind(message.body.messageId).run();
      }
      const retry = budget ? 60 * 60_000 : 60_000;
      const status = budget ? "budget_wait" : permanent || message.attempts >= 3 ? "failed" : "retry";
      await env.DB.prepare(`UPDATE knowledge_jobs SET status = CASE WHEN status = 'delete_pending' THEN status ELSE ? END,
        last_error_code = ?, next_attempt_at = ? WHERE message_id = ?`)
        .bind(status, code, Date.now() + retry, message.body.messageId).run();
      console.error(JSON.stringify({ event: "knowledge_processing_failed", messageId: message.body.messageId, code }));
      if (budget || permanent) message.ack(); else message.retry({ delaySeconds: 60 });
    } finally {
      await env.DB.prepare("UPDATE knowledge_jobs SET lease_token = NULL, lease_until = 0 WHERE message_id = ? AND lease_token = ?")
        .bind(message.body.messageId, lease).run();
    }
  }
}

export async function repairKnowledgeJobs(env: Env): Promise<void> {
  // Catch both missed producer sends and attachments completed during deployment.
  await env.DB.prepare(`INSERT INTO knowledge_jobs(message_id)
    SELECT m.message_id FROM messages m LEFT JOIN attachments a USING(message_id)
    WHERE m.unsent_at IS NULL AND m.source_type != 'user' AND (m.message_type = 'text' OR a.status = 'stored')
    AND NOT EXISTS (SELECT 1 FROM knowledge_jobs j WHERE j.message_id = m.message_id) LIMIT 100`).run();
  const { results } = await env.DB.prepare(`SELECT message_id FROM knowledge_jobs
    WHERE status IN ('pending', 'retry', 'budget_wait', 'waiting_attachment', 'delete_pending')
    AND next_attempt_at <= ? AND (queued_at IS NULL OR queued_at < ?) AND lease_until <= ?
    ORDER BY CASE WHEN status = 'delete_pending' THEN 0 ELSE 1 END, next_attempt_at LIMIT 100`)
    .bind(Date.now(), Date.now() - 10 * 60_000, Date.now()).all<{ message_id: string }>();
  for (let offset = 0; offset < results.length; offset += 100) {
    const part = results.slice(offset, offset + 100);
    try {
      await env.KNOWLEDGE_QUEUE.sendBatch(part.map((row) => ({ body: { messageId: row.message_id }, contentType: "json" })));
      await env.DB.batch(part.map((row) => env.DB.prepare("UPDATE knowledge_jobs SET queued_at = ? WHERE message_id = ?")
        .bind(Date.now(), row.message_id)));
    } catch { console.error(JSON.stringify({ event: "knowledge_batch_enqueue_failed", count: part.length })); }
  }
}
