ALTER TABLE portal_login_flows ADD COLUMN return_to TEXT NOT NULL DEFAULT '/';
CREATE TABLE line_rich_menus (
  version TEXT PRIMARY KEY,
  rich_menu_id TEXT,
  previous_rich_menu_id TEXT,
  applied_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);
