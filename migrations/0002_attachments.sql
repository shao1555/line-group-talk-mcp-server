CREATE TABLE attachments (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT,
  declared_size INTEGER,
  content_type TEXT,
  size_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'failed', 'delete_pending', 'deleted')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  queued_at INTEGER,
  stored_at INTEGER,
  deleted_at INTEGER
);

CREATE INDEX attachments_pending ON attachments(status, queued_at);
