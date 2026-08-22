-- DiriZ 0005 — Modell-Auswahl pro Instanz (Rechner)
-- `enabled = 0` schließt das Modell vom Routing aus; Discovery, Overrides und
-- manuelle Korrekturen bleiben erhalten. Default 1: bestehende Setups laufen
-- unverändert weiter, neu entdeckte Modelle sind sofort aktiv.
ALTER TABLE instances ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
