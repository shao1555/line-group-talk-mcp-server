ALTER TABLE messages ADD COLUMN knowledge_registered INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET knowledge_registered = 1 WHERE EXISTS (SELECT 1 FROM knowledge_jobs j WHERE j.message_id = messages.message_id);
CREATE INDEX messages_unregistered_knowledge ON messages(sent_at, message_id)
WHERE knowledge_registered = 0 AND unsent_at IS NULL AND source_type != 'user' AND message_type IN ('text', 'image', 'audio', 'video', 'file');
CREATE INDEX knowledge_jobs_dispatch_due ON knowledge_jobs(max(next_attempt_at, COALESCE(queued_at + 600000, 0), lease_until), CASE WHEN status = 'delete_pending' THEN 0 ELSE 1 END)
WHERE status IN ('pending', 'retry', 'budget_wait', 'waiting_attachment', 'delete_pending');
CREATE INDEX messages_active_conversation_time ON messages(conversation_id, sent_at) WHERE unsent_at IS NULL AND knowledge_document_id IS NULL;
