-- DiriZ 0007 — Dokumente je LLM-Instanz (plan.md, changelog.md, init.md)
--
-- Bis M9 hingen die drei Deklarations-Dokumente nur am Spezialisten. Jede
-- LLM-Instanz (ein Modell auf einem Rechner) führt sie nun ebenfalls:
--   * `init.md`  → gespiegelt nach `instances.model_settings`
--                  (Provider ← Instanz ← Agent ← Task)
--   * `plan.md`  → verbindliche Arbeitsanweisung im System-Prompt
--   * `changelog.md` → Änderungsprotokoll, vom Core fortgeschrieben

CREATE TABLE IF NOT EXISTS instance_docs (
	instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	content TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (instance_id, kind)
);
