-- DiriZ 0001 — Initial-Schema (01-plan.md §11)
--
-- Konvention: Zeitstempel als ISO-8601-String, Booleans als INTEGER 0/1,
-- JSON-Strukturen als *_json-Text. `api_key_enc` enthält ausschließlich
-- Verschlüsseltes (AES-256-GCM, Seed aus ~/.diriz/secret, chmod 600) —
-- niemals der Key selbst.

CREATE TABLE IF NOT EXISTS providers (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	label TEXT NOT NULL,
	base_url TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	status TEXT NOT NULL DEFAULT 'offline',
	latency_p50 REAL,
	latency_p95 REAL,
	last_checked_at TEXT,
	config_json TEXT NOT NULL DEFAULT '{}',
	api_key_enc TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS instances (
	id TEXT PRIMARY KEY,
	provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
	model_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	context_window INTEGER NOT NULL DEFAULT 8192,
	capabilities_json TEXT NOT NULL DEFAULT '[]',
	languages_json TEXT NOT NULL DEFAULT '[]',
	quantization TEXT,
	price_in_per_mtok REAL,
	price_out_per_mtok REAL,
	source TEXT NOT NULL DEFAULT 'discovered',
	status TEXT NOT NULL DEFAULT 'offline',
	last_seen_at TEXT,
	UNIQUE (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	prompt TEXT NOT NULL,
	metadata_json TEXT NOT NULL,
	privacy TEXT NOT NULL DEFAULT 'local-only',
	mode TEXT NOT NULL DEFAULT 'auto',
	status TEXT NOT NULL DEFAULT 'draft',
	created_at TEXT NOT NULL,
	finished_at TEXT
);

CREATE TABLE IF NOT EXISTS executions (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	instance_id TEXT,
	provider_id TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	started_at TEXT,
	finished_at TEXT,
	tokens_in INTEGER,
	tokens_out INTEGER,
	tps_avg REAL,
	cost_usd REAL,
	error TEXT,
	failover_count INTEGER NOT NULL DEFAULT 0,
	rating INTEGER,
	rating_comment TEXT,
	output TEXT
);

-- Stream-Replay: jedes Delta landet hier (§7.2 Schritt 4).
CREATE TABLE IF NOT EXISTS execution_chunks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	delta TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_exec ON execution_chunks (execution_id, seq);

-- Explainability: volle Score-Aufschlüsselung + Ausschlüsse (§6.4).
CREATE TABLE IF NOT EXISTS routing_decisions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	execution_id TEXT NOT NULL,
	task_profile_json TEXT NOT NULL,
	scores_json TEXT NOT NULL,
	excluded_json TEXT NOT NULL,
	chosen_instance_id TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	execution_id TEXT NOT NULL,
	task_id TEXT NOT NULL,
	rel_path TEXT NOT NULL,
	size INTEGER NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_task ON files (task_id, rel_path);

-- Stündliche Aggregate für die Metriken-Charts (§8.2).
CREATE TABLE IF NOT EXISTS metrics_hourly (
	bucket TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	value REAL NOT NULL,
	PRIMARY KEY (bucket, provider_id, kind)
);

CREATE TABLE IF NOT EXISTS logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts TEXT NOT NULL,
	level TEXT NOT NULL,
	scope TEXT NOT NULL,
	message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL
);
