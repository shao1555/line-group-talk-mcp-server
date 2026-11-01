CREATE INDEX history_imports_conversation_created ON history_imports(conversation_id, created_at DESC, id DESC);

-- Count logical jobs, not queue deliveries: retries/redeliveries must not double count.
CREATE TABLE history_import_counts (
  import_id TEXT NOT NULL REFERENCES history_imports(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed', 'skipped', 'budget_wait', 'cancelled')),
  count INTEGER NOT NULL CHECK(count >= 0),
  PRIMARY KEY(import_id, status)
);

INSERT INTO history_import_counts(import_id, status, count)
SELECT m.import_id, CASE WHEN m.unsent_at IS NOT NULL THEN 'cancelled' ELSE CASE WHEN j.status IN ('ready', 'failed', 'skipped', 'budget_wait') THEN j.status ELSE 'pending' END END, count(*)
FROM messages m LEFT JOIN knowledge_jobs j ON j.message_id = m.message_id
WHERE m.import_id IS NOT NULL GROUP BY 1, 2;

CREATE TRIGGER import_count_message_insert AFTER INSERT ON messages
WHEN NEW.import_id IS NOT NULL
BEGIN
  INSERT INTO history_import_counts(import_id, status, count) SELECT NEW.import_id, CASE WHEN NEW.unsent_at IS NOT NULL THEN 'cancelled' ELSE CASE WHEN (SELECT status FROM knowledge_jobs WHERE message_id = NEW.message_id) IN ('ready', 'failed', 'skipped', 'budget_wait') THEN (SELECT status FROM knowledge_jobs WHERE message_id = NEW.message_id) ELSE 'pending' END END, 1 WHERE 1
    ON CONFLICT(import_id, status) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER import_count_message_delete AFTER DELETE ON messages
WHEN OLD.import_id IS NOT NULL
BEGIN
  UPDATE history_import_counts SET count = count - 1 WHERE import_id = OLD.import_id AND status = CASE WHEN OLD.unsent_at IS NOT NULL THEN 'cancelled' ELSE CASE WHEN (SELECT status FROM knowledge_jobs WHERE message_id = OLD.message_id) IN ('ready', 'failed', 'skipped', 'budget_wait') THEN (SELECT status FROM knowledge_jobs WHERE message_id = OLD.message_id) ELSE 'pending' END END AND 1;
END;

CREATE TRIGGER import_count_message_change AFTER UPDATE OF import_id, unsent_at ON messages
WHEN OLD.import_id IS NOT NEW.import_id OR (OLD.unsent_at IS NULL) != (NEW.unsent_at IS NULL)
BEGIN
  UPDATE history_import_counts SET count = count - 1 WHERE import_id = OLD.import_id AND status = CASE WHEN OLD.unsent_at IS NOT NULL THEN 'cancelled' ELSE CASE WHEN (SELECT status FROM knowledge_jobs WHERE message_id = OLD.message_id) IN ('ready', 'failed', 'skipped', 'budget_wait') THEN (SELECT status FROM knowledge_jobs WHERE message_id = OLD.message_id) ELSE 'pending' END END AND OLD.import_id IS NOT NULL;
  INSERT INTO history_import_counts(import_id, status, count) SELECT NEW.import_id, CASE WHEN NEW.unsent_at IS NOT NULL THEN 'cancelled' ELSE CASE WHEN (SELECT status FROM knowledge_jobs WHERE message_id = NEW.message_id) IN ('ready', 'failed', 'skipped', 'budget_wait') THEN (SELECT status FROM knowledge_jobs WHERE message_id = NEW.message_id) ELSE 'pending' END END, 1 WHERE NEW.import_id IS NOT NULL
    ON CONFLICT(import_id, status) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER import_count_job_insert AFTER INSERT ON knowledge_jobs
WHEN (SELECT import_id FROM messages WHERE message_id = NEW.message_id AND unsent_at IS NULL) IS NOT NULL AND NEW.status IN ('ready', 'failed', 'skipped', 'budget_wait')
BEGIN
  UPDATE history_import_counts SET count = count - 1 WHERE import_id = (SELECT import_id FROM messages WHERE message_id = NEW.message_id AND unsent_at IS NULL) AND status = 'pending' AND 1;
  INSERT INTO history_import_counts(import_id, status, count) SELECT (SELECT import_id FROM messages WHERE message_id = NEW.message_id AND unsent_at IS NULL), NEW.status, 1 WHERE 1
    ON CONFLICT(import_id, status) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER import_count_job_change AFTER UPDATE OF status ON knowledge_jobs
WHEN (SELECT import_id FROM messages WHERE message_id = NEW.message_id AND unsent_at IS NULL) IS NOT NULL AND (CASE WHEN OLD.status IN ('ready', 'failed', 'skipped', 'budget_wait') THEN OLD.status ELSE 'pending' END) != (CASE WHEN NEW.status IN ('ready', 'failed', 'skipped', 'budget_wait') THEN NEW.status ELSE 'pending' END)
BEGIN
  UPDATE history_import_counts SET count = count - 1 WHERE import_id = (SELECT import_id FROM messages WHERE message_id = NEW.message_id AND unsent_at IS NULL) AND status = CASE WHEN OLD.status IN ('ready', 'failed', 'skipped', 'budget_wait') THEN OLD.status ELSE 'pending' END AND 1;
  INSERT INTO history_import_counts(import_id, status, count) SELECT (SELECT import_id FROM messages WHERE message_id = NEW.message_id AND unsent_at IS NULL), CASE WHEN NEW.status IN ('ready', 'failed', 'skipped', 'budget_wait') THEN NEW.status ELSE 'pending' END, 1 WHERE 1
    ON CONFLICT(import_id, status) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER import_count_job_delete AFTER DELETE ON knowledge_jobs
WHEN (SELECT import_id FROM messages WHERE message_id = OLD.message_id AND unsent_at IS NULL) IS NOT NULL AND OLD.status IN ('ready', 'failed', 'skipped', 'budget_wait')
BEGIN
  UPDATE history_import_counts SET count = count - 1 WHERE import_id = (SELECT import_id FROM messages WHERE message_id = OLD.message_id AND unsent_at IS NULL) AND status = OLD.status AND 1;
  INSERT INTO history_import_counts(import_id, status, count) SELECT (SELECT import_id FROM messages WHERE message_id = OLD.message_id AND unsent_at IS NULL), 'pending', 1 WHERE 1
    ON CONFLICT(import_id, status) DO UPDATE SET count = count + 1;
END;
