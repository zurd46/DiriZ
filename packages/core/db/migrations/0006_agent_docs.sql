-- DiriZ 0006 — Agenten-Dokumente (plan.md, changelog.md, init.md)
--
-- Jeder Spezialist führt drei Markdown-Dokumente. `init.md` ist wirksam:
-- Der Parser (@diriz/shared `parseInitDoc`) leitet daraus Model-Voreinstellungen
-- ab, die in `agents.model_settings` gespiegelt werden — die Engine liest nur
-- diese Spalte (Provider ← Modell ← Agent ← Task).

ALTER TABLE agents ADD COLUMN model_settings TEXT;

CREATE TABLE IF NOT EXISTS agent_docs (
	agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	content TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (agent_id, kind)
);
