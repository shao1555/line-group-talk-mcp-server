ALTER TABLE attachments ADD COLUMN duration_ms INTEGER;

CREATE TABLE knowledge_jobs (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
  status TEXT NOT NULL DEFAULT 'pending',
  extracted_text TEXT,
  cache_key TEXT,
  processor TEXT,
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  indexing_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER,
  last_error_code TEXT,
  indexed_at INTEGER
);
CREATE INDEX knowledge_jobs_pending ON knowledge_jobs(status, next_attempt_at, queued_at);

CREATE TABLE knowledge_cache (
  cache_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  processor TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  ordinal INTEGER NOT NULL,
  text TEXT,
  embedding TEXT,
  UNIQUE(message_id, ordinal)
);
CREATE INDEX knowledge_chunks_message ON knowledge_chunks(message_id);

-- Reservations include uncertain/failed model calls, so retries cannot bypass budgets.
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  units INTEGER NOT NULL,
  reserved_microusd INTEGER NOT NULL,
  charged_microusd INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_usage_month ON ai_usage(month);
CREATE INDEX ai_usage_daily ON ai_usage(day, kind);

CREATE TABLE search_clients (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  conversation_ids TEXT NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE bot_replies (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
  status TEXT NOT NULL,
  text TEXT,
  evidence_ids TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO knowledge_jobs(message_id)
SELECT m.message_id FROM messages m LEFT JOIN attachments a USING(message_id)
WHERE m.unsent_at IS NULL AND (m.message_type = 'text' OR a.status = 'stored');
