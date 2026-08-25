-- Ein Modell, das nicht in den Speicher passt, passt auch in zehn Minuten
-- nicht hinein. Beobachtet: `deepseek/deepseek-v4-flash` verlangt 158 GB und
-- wurde nach jeder Sperre erneut gewählt — es hat ja den besten Score.
--
-- Deshalb zählt DiriZ die Ladefehler je Modell und verlängert die Sperre
-- schrittweise (10 min → 1 h → 6 h → 24 h). Ein einzelner Fehlschlag bleibt
-- damit folgenlos, ein dauerhaft zu grosses Modell verschwindet von selbst
-- aus der Auswahl. Der Zähler wird bei jedem erfolgreichen Lauf gelöscht.
ALTER TABLE instances ADD COLUMN load_failures INTEGER NOT NULL DEFAULT 0;
