export async function recentMessages(conversationId: string, limit: number, env: Env) {
  return (await env.DB.prepare(`SELECT message_id, user_id, sender_name, sender_role, reply_to_message_id, import_id, message_type,
    CASE WHEN sender_role = 'bot' THEN text ELSE substr(text, 1, 2000) END AS text, sent_at
    FROM messages WHERE conversation_id = ? AND unsent_at IS NULL
    ORDER BY sent_at DESC, CASE sender_role WHEN 'bot' THEN 1 ELSE 0 END DESC, message_id DESC LIMIT ?`)
    .bind(conversationId, limit).all<{ message_id: string; user_id: string | null; sender_name: string | null; sender_role: string;
      reply_to_message_id: string | null; text: string | null; sent_at: number }>()).results.reverse();
}
