export async function recentMessages(conversationId: string, limit: number, env: Env) {
  return (await env.DB.prepare(`SELECT message_id, user_id, sender_name, sender_role, reply_to_message_id, import_id, message_type,
    CASE WHEN sender_role = 'bot' THEN text ELSE substr(text, 1, 2000) END AS text, sent_at
    FROM available_messages WHERE conversation_id = ? AND unsent_at IS NULL AND knowledge_document_id IS NULL
    ORDER BY sent_at DESC, CASE sender_role WHEN 'bot' THEN 1 ELSE 0 END DESC, message_id DESC LIMIT ?`)
    .bind(conversationId, limit).all<{ message_id: string; user_id: string | null; sender_name: string | null; sender_role: string;
      reply_to_message_id: string | null; text: string | null; sent_at: number }>()).results.reverse();
}

// A semantic hit is often a short reply; fetch both sides using the conversation/time index.
export async function messageContext(conversationId: string, messageId: string, limit: number, env: Env) {
  const anchor = await env.DB.prepare(`SELECT sent_at FROM available_messages WHERE message_id = ?
    AND conversation_id = ? AND unsent_at IS NULL AND knowledge_document_id IS NULL`)
    .bind(messageId, conversationId).first<number>('sent_at');
  if (anchor === null) return [];
  const half = Math.floor(limit / 2);
  const select = `SELECT message_id, user_id, sender_name, sender_role, message_type, text, sent_at, reply_to_message_id
    FROM available_messages WHERE conversation_id = ? AND unsent_at IS NULL AND knowledge_document_id IS NULL`;
  const [before, after] = await env.DB.batch<{ message_id: string; user_id: string | null; sender_name: string | null; sender_role: string;
    message_type: string; text: string | null; sent_at: number; reply_to_message_id: string | null }>([
    env.DB.prepare(select + ' AND (sent_at, message_id) < (?, ?) ORDER BY sent_at DESC, message_id DESC LIMIT ?').bind(conversationId, anchor, messageId, half),
    env.DB.prepare(select + ' AND (sent_at, message_id) >= (?, ?) ORDER BY sent_at, message_id LIMIT ?').bind(conversationId, anchor, messageId, limit - half),
  ]);
  return [...before.results.reverse(), ...after.results];
}
