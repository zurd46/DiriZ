-- DiriZ 0012 — Modelle führen ein Datenblatt statt eines Auftrags
--
-- Bis hierher bekam jedes Modell dieselben drei Dokumente wie ein Spezialist,
-- inklusive `plan.md` („Wofür wird dieses Modell eingesetzt? / Schritt 1 …").
-- Das ist die Sprache eines Auftrags und an einem Modell sinnlos: Ein Modell
-- hat keine Aufgabe, es hat Eigenschaften. An seine Stelle tritt `llm.md` —
-- das technische Datenblatt, das die Orchestrierung ausliest (Fähigkeiten,
-- Kontext-Fenster, Qualitätsklasse, Stärken und Schwächen).
--
-- Die `llm.md` selbst legt der Core beim nächsten Lesen aus dem Modell-Katalog
-- an (`instanceDocs`), befüllt statt leer. Hier fallen nur die alten,
-- unausgefüllten Auftrags-Dokumente weg; ausgefüllte bleiben als Notiz erhalten.
DELETE FROM instance_docs
 WHERE kind = 'plan'
   AND (
     content LIKE '%Wofür wird dieses Modell eingesetzt?%'
     OR content LIKE '%Schritt 1%'
     OR TRIM(content) = ''
   );
