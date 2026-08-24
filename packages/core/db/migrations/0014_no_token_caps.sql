-- DiriZ 0014 — keine geerbten Token-Obergrenzen mehr
--
-- Der Team-Katalog gab jedem Spezialisten ein `maxTokens` mit (4096–8192), und
-- kurzzeitig tat es der Modell-Katalog auch. Beides ist falsch:
--
--   * Eine Obergrenze schneidet die Antwort mitten im Satz ab.
--   * Im Agentik-Modus steckt der komplette Dateiinhalt in den Argumenten eines
--     `write_file`-Aufrufs. Reisst die Grenze dort, kommt kaputtes JSON an, der
--     Pfad ist leer — und das Modell wiederholt denselben Aufruf endlos. Von
--     aussen sieht das aus, als sei die Generierung eingefroren.
--   * Gerade lokale Modelle brauchen keine Sparsamkeitsbremse: Sie kosten
--     nichts pro Token. Die Grenze ist die Laufzeit, nicht eine geratene Zahl.
--
-- Entfernt wird nur, was DiriZ selbst gesetzt hat: die Werte aus dem Katalog.
-- Eine selbst eingetragene Zahl bleibt stehen — sie war eine Entscheidung.
UPDATE agents
   SET model_settings = json_remove(model_settings, '$.maxTokens')
 WHERE model_settings IS NOT NULL
   AND json_extract(model_settings, '$.maxTokens') IN (2048, 3072, 4096, 6144, 8192);

UPDATE agents SET model_settings = NULL WHERE model_settings IN ('{}', 'null');

UPDATE agent_docs
   SET content = replace(
         replace(
           replace(
             replace(replace(content, '- Max-Tokens: 8192' || char(10), ''), '- Max-Tokens: 6144' || char(10), ''),
             '- Max-Tokens: 4096' || char(10), ''),
           '- Max-Tokens: 3072' || char(10), ''),
         '- Max-Tokens: 2048' || char(10), '')
 WHERE kind = 'init' AND content LIKE '%Max-Tokens%';

-- Dasselbe für Rechner und Modelle, falls dort Katalog-Werte gelandet sind.
UPDATE providers
   SET model_settings = json_remove(model_settings, '$.maxTokens')
 WHERE model_settings IS NOT NULL
   AND json_extract(model_settings, '$.maxTokens') IN (2048, 3072, 4096, 6144, 8192);

UPDATE instances
   SET model_settings = json_remove(model_settings, '$.maxTokens')
 WHERE model_settings IS NOT NULL
   AND json_extract(model_settings, '$.maxTokens') IN (512, 2048, 3072, 4096, 8192);

UPDATE providers SET model_settings = NULL WHERE model_settings IN ('{}', 'null');
UPDATE instances SET model_settings = NULL WHERE model_settings IN ('{}', 'null');
