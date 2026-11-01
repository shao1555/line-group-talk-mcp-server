ALTER TABLE ai_usage ADD COLUMN owner_user_id TEXT;
CREATE INDEX ai_usage_owner_time ON ai_usage(owner_user_id, created_at);

-- Direct chat context is read from D1, not embedded in a shared background job.
UPDATE knowledge_jobs SET status = 'skipped', last_error_code = 'direct_chat_context_only'
WHERE status IN ('pending', 'retry', 'budget_wait', 'waiting_attachment')
  AND message_id IN (SELECT message_id FROM messages WHERE source_type = 'user');
