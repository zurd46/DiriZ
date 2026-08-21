-- DiriZ 0002 — Spezialisten (Agenten), Swarms & Model-Settings
--
-- Model-Settings: JSON (ModelSettings aus @diriz/shared), NULL = nicht gesetzt.
-- Auflösung: Provider-Default ← Modell-Override ← Task-Override.

ALTER TABLE providers ADD COLUMN model_settings TEXT;
ALTER TABLE instances ADD COLUMN model_settings TEXT;

-- Task-Zuordnung: auto (Prompt-Match) / agent / swarm.
ALTER TABLE tasks ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE tasks ADD COLUMN agent_id TEXT;
ALTER TABLE tasks ADD COLUMN swarm_id TEXT;
ALTER TABLE tasks ADD COLUMN overrides_json TEXT;

CREATE TABLE IF NOT EXISTS agents (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	system_prompt TEXT NOT NULL DEFAULT '',
	required_capabilities TEXT NOT NULL DEFAULT '[]',
	preferred_capabilities TEXT NOT NULL DEFAULT '[]',
	privacy TEXT NOT NULL DEFAULT 'any',
	pinned_provider_id TEXT,
	pinned_instance_id TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS swarms (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	agent_ids TEXT NOT NULL DEFAULT '[]',
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

-- Explainability der Agenten-Zuordnung (analog routing_decisions).
CREATE TABLE IF NOT EXISTS agent_selections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	mode TEXT NOT NULL,
	agent_id TEXT,
	agent_name TEXT,
	reason TEXT,
	candidates_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_selections_task ON agent_selections (task_id, id);
