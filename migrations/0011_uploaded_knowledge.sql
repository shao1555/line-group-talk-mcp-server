CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  canonical_message_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  content_text TEXT,
  updated_at INTEGER,
  updated_by TEXT,
  edit_token TEXT,
  deleted_at INTEGER
);
CREATE TABLE knowledge_document_chats (
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  message_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(document_id, conversation_id)
);
CREATE INDEX knowledge_document_chats_conversation ON knowledge_document_chats(conversation_id, enabled);
ALTER TABLE messages ADD COLUMN knowledge_document_id TEXT;
ALTER TABLE messages ADD COLUMN knowledge_document_revision INTEGER NOT NULL DEFAULT 1;
CREATE INDEX messages_knowledge_document ON messages(knowledge_document_id);

-- Always apply live sharing state when reading, even while old vectors still exist.
CREATE VIEW available_messages AS
SELECT m.* FROM messages m WHERE m.unsent_at IS NULL AND (
  m.knowledge_document_id IS NULL OR EXISTS (
    SELECT 1 FROM knowledge_document_chats c JOIN knowledge_documents d ON d.id = c.document_id
    JOIN knowledge_jobs j ON j.message_id = m.message_id
    WHERE c.document_id = m.knowledge_document_id AND c.conversation_id = m.conversation_id
      AND c.message_id = m.message_id AND m.knowledge_document_revision = d.revision AND c.enabled = 1 AND d.deleted_at IS NULL AND j.status = 'ready'
  )
);
