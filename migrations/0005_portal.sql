CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  bot_active INTEGER NOT NULL DEFAULT 1,
  last_event_at INTEGER NOT NULL
);
INSERT INTO conversations(conversation_id, source_type, last_event_at)
SELECT conversation_id, source_type, max(sent_at) FROM messages
WHERE source_type IN ('group', 'room') GROUP BY conversation_id, source_type;

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  last_event_at INTEGER NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY(conversation_id, user_id)
);
INSERT INTO conversation_members(conversation_id, user_id, status, last_event_at)
SELECT conversation_id, user_id, 'observed', max(sent_at) FROM messages
WHERE source_type IN ('group', 'room') AND user_id IS NOT NULL GROUP BY conversation_id, user_id;

CREATE TABLE portal_login_flows (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE portal_users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE portal_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES portal_users(user_id),
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX portal_sessions_expiry ON portal_sessions(expires_at);

ALTER TABLE search_clients ADD COLUMN owner_user_id TEXT REFERENCES portal_users(user_id);
ALTER TABLE search_clients ADD COLUMN expires_at INTEGER;
ALTER TABLE search_clients ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
