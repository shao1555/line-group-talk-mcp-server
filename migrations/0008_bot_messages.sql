ALTER TABLE messages ADD COLUMN sender_role TEXT NOT NULL DEFAULT 'user' CHECK(sender_role IN ('user', 'bot'));
ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;
CREATE INDEX messages_reply_to ON messages(reply_to_message_id);

-- Only delivered answers with a still-visible source are exposed as bot messages.
INSERT INTO messages(message_id, source_type, conversation_id, message_type, text, sent_at, received_at, sender_name, sender_role, reply_to_message_id)
SELECT COALESCE(b.line_message_id, 'bot-reply:' || b.message_id), m.source_type, m.conversation_id, 'text', b.text,
  COALESCE(m.replied_at, b.created_at), COALESCE(m.replied_at, b.created_at), 'bot', 'bot', b.message_id
FROM bot_replies b JOIN messages m USING(message_id)
WHERE b.status = 'sent' AND b.text IS NOT NULL AND m.unsent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM unsent_messages u WHERE u.message_id = COALESCE(b.line_message_id, 'bot-reply:' || b.message_id))
  AND NOT EXISTS (SELECT 1 FROM json_each(b.evidence_ids) e JOIN messages evidence ON evidence.message_id = e.value WHERE evidence.unsent_at IS NOT NULL)
ON CONFLICT(message_id) DO NOTHING;

INSERT INTO knowledge_jobs(message_id)
SELECT message_id FROM messages WHERE sender_role = 'bot' AND unsent_at IS NULL
ON CONFLICT(message_id) DO NOTHING;
