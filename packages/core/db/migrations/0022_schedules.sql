-- T1-4 Scheduling: geplante & wiederkehrende Tasks.
--
-- Zwei Zeitarten, ein Feld: `cron` (5 Felder, lokale Zeit) ODER `every_minutes`
-- (Intervall). `next_run_at` ist die bereits berechnete Fälligkeit — der
-- Timer prüft nur die Uhr, nicht die Arithmetik. Einmalige Pläne tragen die
-- Zeit in `next_run_at` und werden nach dem Lauf deaktiviert.
CREATE TABLE IF NOT EXISTS schedules (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	prompt TEXT NOT NULL,
	agent_id TEXT,
	privacy TEXT NOT NULL DEFAULT 'local-only',
	pinned_provider_id TEXT,
	pinned_model_id TEXT,
	cron TEXT,
	every_minutes INTEGER,
	once INTEGER NOT NULL DEFAULT 0,
	next_run_at TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	last_run_task_id TEXT,
	last_run_at TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_due
	ON schedules (enabled, next_run_at);
