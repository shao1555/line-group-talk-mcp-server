ALTER TABLE portal_login_flows ADD COLUMN oauth_flow INTEGER NOT NULL DEFAULT 0;
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES portal_users(user_id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX oauth_connections_user ON oauth_connections(user_id);
