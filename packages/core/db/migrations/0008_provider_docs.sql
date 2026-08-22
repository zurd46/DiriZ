-- DiriZ 0008 — Dokumente je Rechner (Provider): plan.md, changelog.md, init.md
--
-- Damit führen alle drei Ebenen der Auflösungskette dieselben Dokumente:
--   Rechner (provider) ← Modell (instance) ← Spezialist (agent)
-- `init.md` wird nach `providers.model_settings` gespiegelt, `plan.md` fließt
-- als verbindliche Arbeitsanweisung in den System-Prompt.

CREATE TABLE IF NOT EXISTS provider_docs (
	provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	content TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (provider_id, kind)
);
