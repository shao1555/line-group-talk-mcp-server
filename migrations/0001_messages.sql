CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  webhook_event_id TEXT UNIQUE,
  source_type TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT,
  message_type TEXT NOT NULL,
  text TEXT,
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  unsent_at INTEGER,
  replied_at INTEGER
);

CREATE INDEX messages_conversation_time ON messages(conversation_id, sent_at);

-- A tombstone prevents a delayed message webhook from restoring deleted text.
CREATE TABLE unsent_messages (
  message_id TEXT PRIMARY KEY,
  unsent_at INTEGER NOT NULL
);
