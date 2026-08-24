-- DiriZ 0016 — Gelerntes überlebt den Neustart, Tempo wird gemessen
--
-- 1. `instance_feedback`: Erfolge, Fehlschläge und die geglättete Bewertung je
--    Modell. Bisher lagen sie in einer Map im Speicher — nach jedem Neustart
--    begann die Qualitäts-Achse wieder bei der geratenen Katalog-Klasse.
--
-- 2. `tps_avg` steht längst in `executions`, wurde aber von niemandem gelesen.
--    Der Index macht die Abfrage „Wie schnell ist dieses Modell wirklich?"
--    billig genug, um sie bei jeder Routing-Entscheidung zu stellen. Gemessener
--    Durchsatz schlägt geratene Latenz: Ein 27-B-Modell über einen Tunnel
--    macht 13 Token/s, ein 8-B-Modell daneben das Fünffache — die Latenz-Achse
--    sieht davon nichts.

CREATE TABLE IF NOT EXISTS instance_feedback (
	instance_id TEXT PRIMARY KEY,
	success INTEGER NOT NULL DEFAULT 0,
	failure INTEGER NOT NULL DEFAULT 0,
	-- Exponentiell geglättete Bewertung (0–1); 0 = noch keine Bewertung.
	rating_ema REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_executions_instance_tps
	ON executions(instance_id, started_at)
	WHERE tps_avg IS NOT NULL;
