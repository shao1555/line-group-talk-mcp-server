import { enqueueKnowledge, markForIndex } from "./knowledge";

// The original question remains in bot_replies; the sent answer gets its own ID.
export async function recordSentBotMessage(questionId: string, env: Env): Promise<void> {
  const result = await env.DB.prepare(`INSERT INTO messages(message_id, source_type, conversation_id, message_type, text,
      sent_at, received_at, sender_name, sender_role, reply_to_message_id)
    SELECT COALESCE(b.line_message_id, 'bot-reply:' || b.message_id), m.source_type, m.conversation_id, 'text', b.text,
      COALESCE(m.replied_at, b.created_at), COALESCE(m.replied_at, b.created_at), 'bot', 'bot', b.message_id
    FROM bot_replies b JOIN messages m USING(message_id)
    WHERE b.message_id = ? AND b.status = 'sent' AND b.text IS NOT NULL AND m.unsent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM unsent_messages u WHERE u.message_id = COALESCE(b.line_message_id, 'bot-reply:' || b.message_id))
      AND NOT EXISTS (SELECT 1 FROM json_each(b.evidence_ids) e JOIN messages evidence ON evidence.message_id = e.value WHERE evidence.unsent_at IS NOT NULL)
    ON CONFLICT(message_id) DO NOTHING RETURNING message_id`).bind(questionId).first<{ message_id: string }>();
  if (result) await markForIndex(result.message_id, env);
}

export async function repairSentBotMessages(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT b.message_id FROM bot_replies b JOIN messages q USING(message_id)
    WHERE b.status = 'sent' AND b.text IS NOT NULL AND q.unsent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM unsent_messages u WHERE u.message_id = COALESCE(b.line_message_id, 'bot-reply:' || b.message_id))
      AND NOT EXISTS (SELECT 1 FROM json_each(b.evidence_ids) e JOIN messages evidence ON evidence.message_id = e.value WHERE evidence.unsent_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.reply_to_message_id = b.message_id AND m.sender_role = 'bot')
    LIMIT 100`).all<{ message_id: string }>();
  for (const row of results) await recordSentBotMessage(row.message_id, env);
  // Backfilled bot answers should not wait behind a large historical upload.
  const pending = await env.DB.prepare(`SELECT j.message_id FROM knowledge_jobs j JOIN messages m USING(message_id)
    WHERE m.sender_role = 'bot' AND m.unsent_at IS NULL AND j.status = 'pending' AND j.queued_at IS NULL LIMIT 100`)
    .all<{ message_id: string }>();
  for (const row of pending.results) await enqueueKnowledge(row.message_id, env);
}
