-- „Unbekannt" ist nicht „8192".
--
-- OpenAIs `/v1/models` nennt keine Kontextgrösse. DiriZ setzte deshalb den
-- Vorgabewert 8192 — und das harte Kontext-Gate (`contextWindow < 1.2 ×
-- estTokens`) warf danach **jedes** OpenAI-Modell aus der Auswahl, sobald ein
-- Prompt grösser als ~6 800 Token war. In der Datenbank standen 132 Modelle,
-- wählbar war keines.
--
-- Ab jetzt wird unterschieden: Ein gemeldeter Wert ist eine Tatsache, ein
-- Vorgabewert eine Verlegenheit. Nur die Tatsache darf ausschliessen.
ALTER TABLE instances ADD COLUMN context_known INTEGER NOT NULL DEFAULT 1;

-- Bestand: Wer genau auf dem Vorgabewert steht und von einem Anbieter stammt,
-- der die Grösse nicht meldet, gilt als unbekannt. Lokale Server (Ollama,
-- LM Studio) und OpenRouter melden sie.
UPDATE instances SET context_known = 0
WHERE context_window = 8192
  AND provider_id IN (SELECT id FROM providers WHERE type IN ('openai', 'openai-compat'));
