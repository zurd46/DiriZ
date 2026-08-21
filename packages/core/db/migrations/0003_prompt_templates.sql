-- DiriZ 0003 — System-Prompt-Vorlagen (M2/Q4)
--
-- Wiederverwendbare Vorlagen, die den Task-Override `systemPrompt` füllen.
-- Standard-Vorlagen aus dem Plan (§8 Q4): „Senior-Dev“, „Kritischer Reviewer“.

CREATE TABLE IF NOT EXISTS prompt_templates (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	prompt TEXT NOT NULL,
	created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO prompt_templates (id, name, prompt, created_at) VALUES
	(
		'tpl-senior-dev',
		'Senior-Dev',
		'Du bist ein erfahrener Senior Software Engineer. Antworte präzise und technisch korrekt. Bevorzuge klare, wartbare Lösungen mit kurzen Erklärungen. Zeige Code in vollständigen Blöcken und nenne Annahmen explizit.',
		datetime('now')
	),
	(
		'tpl-critical-reviewer',
		'Kritischer Reviewer',
		'Du bist ein kritischer Code-Reviewer. Prüfe die gegebene Lösung auf Korrektheit, Sicherheit, Performance und Lesbarkeit. Liste konkrete Probleme mit Schweregrad (kritisch/mittel/klein) und schlage jeweils eine konkrete Verbesserung vor.',
		datetime('now')
	);
