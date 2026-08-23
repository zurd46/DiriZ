-- DiriZ 0009 — GitHub-Anbindung: Repositories & Task-Pinning
--
-- Ein Repository wird einmal nach `<dataDir>/repos/<slug>` geklont. Jede Task,
-- die daran gepinnt ist, bekommt einen eigenen **Worktree** unter
-- `<workspaceDir>/<task-slug>` mit eigenem Branch — dadurch arbeiten die
-- vorhandenen Datei-Tools des Modells unverändert im echten Repo, und
-- `git diff` zeigt exakt die Änderung dieser einen Task.
--
-- Der Token liegt (AES-256-GCM-verschlüsselt) in `settings.github_token`,
-- niemals hier und niemals in einer API-Antwort.

CREATE TABLE IF NOT EXISTS repos (
	id TEXT PRIMARY KEY,
	-- Anzeige: "owner/name"
	owner TEXT NOT NULL,
	name TEXT NOT NULL,
	-- Vollständige Klon-URL (https), ohne Zugangsdaten.
	clone_url TEXT NOT NULL,
	default_branch TEXT NOT NULL DEFAULT 'main',
	-- Lokaler Klon; NULL, solange noch nicht geklont.
	local_path TEXT,
	-- Ergebnis der letzten Synchronisierung (für die Oberfläche).
	last_synced_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (owner, name)
);

-- Task-Pinning: an welches Repo und auf welcher Basis arbeitet die Task?
ALTER TABLE tasks ADD COLUMN repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
-- Arbeitsbranch der Task (wird beim Anlegen des Worktrees gesetzt).
ALTER TABLE tasks ADD COLUMN work_branch TEXT;
-- Zuletzt gepushter Stand + PR-Link, damit die Oberfläche den Zustand kennt.
ALTER TABLE tasks ADD COLUMN pushed_at TEXT;
ALTER TABLE tasks ADD COLUMN pr_url TEXT;
