-- DiriZ 0011 — Swarms als Arbeitsabläufe
--
-- Bisher war ein Swarm nur eine Gruppe, aus der pro Prompt einer gewählt wurde.
-- Professionelle Entwicklung läuft aber in Ketten: klären → entwerfen → bauen →
-- prüfen. `ordered = 1` macht aus der Gruppe genau das — alle Mitglieder
-- nacheinander, jeder auf der Vorarbeit des vorigen.

ALTER TABLE swarms ADD COLUMN ordered INTEGER NOT NULL DEFAULT 0;
