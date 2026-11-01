ALTER TABLE knowledge_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE knowledge_jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
