-- DiriZ 0015 — Anmeldung mit Benutzername und Passwort
--
-- Bis hierher war DiriZ offen: Wer den Port erreichte, hatte volle Kontrolle
-- über Modelle, Repositories und API-Schlüssel. Auf einem Einzelplatz mag das
-- reichen — sobald der Core im Netz erreichbar ist (Tunnel, zweiter Rechner,
-- Desktop-App im WLAN), ist es ein offenes Scheunentor.
--
-- Passwörter liegen als scrypt-Hash mit eigenem Salt (nie im Klartext),
-- Sitzungen als Hash ihres Tokens: Wer die Datenbank liest, kann sich damit
-- weder anmelden noch eine laufende Sitzung übernehmen.

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
	-- SHA-256 des Tokens; das Token selbst steht nur im Cookie des Browsers.
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
