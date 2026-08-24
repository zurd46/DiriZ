-- DiriZ 0010 — Tool-Operationen der Agentik (M8) persistieren
--
-- Bisher lebten die Tool-Aufrufe nur im SSE-Stream: Wer die Seite neu lud oder
-- in einem zweiten Tab zusah, sah nicht mehr, was das Modell tut — und im
-- Verlauf fehlte hinterher jede Spur davon, welche Dateien es angefasst hat.
-- Hier stehen sie dauerhaft, in Reihenfolge, mit Ergebnis.

CREATE TABLE IF NOT EXISTS tool_calls (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	execution_id TEXT NOT NULL,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	name TEXT NOT NULL,
	args_summary TEXT NOT NULL DEFAULT '',
	ok INTEGER NOT NULL DEFAULT 1,
	detail TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_execution ON tool_calls (execution_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls (task_id, seq);
