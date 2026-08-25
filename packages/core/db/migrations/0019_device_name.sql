-- Wo rechnet das Modell wirklich?
--
-- LM Studio reicht über „LM Link" Modelle von anderen Rechnern durch. Der
-- Endpunkt bleibt 127.0.0.1, die Arbeit passiert anderswo — DiriZ zeigte
-- deshalb „nvidia-nemotron … auf MacDani" für ein Modell, das nachweislich auf
-- `LokalAI_Server1` lief (`lms link status`, 2026-08-25).
--
-- Der Name steht hier, nicht im Provider: Auf **einem** Endpunkt liegen
-- gleichzeitig eigene und durchgereichte Modelle.
ALTER TABLE instances ADD COLUMN device_name TEXT;
