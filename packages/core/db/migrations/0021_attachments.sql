-- 0021_attachments.sql
-- T1-2 Vision-Anhänge: Bilder, die zu einer Task gehören. Base64 in der
-- Datenbank — local-first, nichts verlässt den Rechner ausser im Modell-Call.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id, created_at);
