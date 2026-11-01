CREATE TABLE history_imports (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  total INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
ALTER TABLE messages ADD COLUMN import_id TEXT REFERENCES history_imports(id);
ALTER TABLE messages ADD COLUMN source_line INTEGER;
ALTER TABLE messages ADD COLUMN sender_name TEXT;
CREATE INDEX messages_import ON messages(import_id);
